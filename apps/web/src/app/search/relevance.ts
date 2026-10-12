import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { SearchMatchKind } from "@liberty/contracts/domains/search";

/* -------------------------------------------------------------------------
 * SEARCH RELEVANCE (Wave 132, worker C).
 *
 * THE DEFECT CLASS REMOVED: ordinal matching passed off as ranking.
 *
 * `search.ts` used to classify a result with `classifyMatch` -- four buckets
 * built from `===`, `startsWith` and `includes` -- and then order the list by
 * `SEARCH_MATCH_RANK`. The buckets are not wrong; they are too coarse to be a
 * ranking, and the coarseness is visible on the fixtures. Everything that is
 * not an exact or leading-edge hit collapses into one `title-contains` bucket,
 * so for `q=fall` a title *named* "The Fall of Aurora" and a title that merely
 * contains the letters ("Pitfalls") are declared equally relevant and the tie
 * is then broken by release year -- which means the better answer loses to a
 * worse but newer one, with nothing on the page or in the data explaining why.
 * That is the search equivalent of the ordering defect this repository has
 * already removed twice (locale-dependent candidate ranking in
 * `@liberty/media-engine`, then `localeCompare` in search's own sort): an order
 * that looks deliberate and is not derived from anything the reader can name.
 *
 * WHAT REPLACES IT: a word-boundary tier between "starts with" and "contains",
 * and a field weight that states, as a number rather than as a sort function,
 * that a title hit outranks every non-title hit. "The Fall of Aurora" matches
 * `fall` at the start of a word; "Pitfalls" matches mid-word; those are now
 * different scores and the first one wins before the clock is ever consulted.
 *
 * FOUR PROPERTIES THIS MODULE IS BUILT TO HAVE, each of which has cost this
 * project a defect somewhere else:
 *
 *  1. PURE AND DETERMINISTIC. Same item and same query in, same score out. No
 *     clock, no randomness, no dependence on catalog order, no I/O. It is a
 *     plain `.ts` module with no React and no Next import, which is also what
 *     makes it unit-testable under `environment: "node"` (see
 *     `apps/web/vitest.config.ts` -- there is no jsdom and no app-router
 *     context in this suite, so logic that needs testing may not live in a
 *     component).
 *
 *  2. LOCALE-INDEPENDENT. `toLowerCase` and never `toLocaleLowerCase`;
 *     comparison by CODE POINT and never `localeCompare`. The locale-aware
 *     spellings make the same catalog and the same query rank differently
 *     depending on which machine served the request, which is unfixable from a
 *     bug report because the bug is in the environment and not in the data.
 *
 *  3. THE QUERY STAYS DATA. Matching is `===` / `startsWith` / `indexOf`
 *     against strings already in memory. Nothing here compiles a `RegExp` from
 *     the query -- a user-authored pattern is a ReDoS surface, and a
 *     metacharacter would silently change what the search means. The one regex
 *     in this file is a fixed character class built at module load from a
 *     literal-free string, for the reason given at `WORD_CHARACTER`.
 *
 *  4. TOTAL AT MODULE EVALUATION. This file is loaded by a server module today,
 *     but the lead is concurrently repairing a Windows-only client TypeError,
 *     and the standing rule from that work is that a module may not throw while
 *     being evaluated. A regex LITERAL cannot be guarded: an unsupported
 *     construct is a SyntaxError against the whole module, so `try/catch`
 *     around the use site is worthless and the import fails rather than the
 *     feature. `WORD_CHARACTER` is therefore built with `new RegExp` inside a
 *     `try`, with a documented ASCII fallback, so the worst case is a coarser
 *     word-boundary test and never a page that will not load.
 *
 * WHAT THIS MODULE DOES NOT DO, stated rather than implied:
 *
 *  - NO FUZZY MATCHING, no edit distance, no stemming, no synonyms. A typo does
 *    not match. That is a deliberate stop: every one of those needs either a
 *    dependency (the cloud ceiling is 0.0 and no dependency may be added) or a
 *    language model, and a hand-rolled Levenshtein threshold that nobody can
 *    tune against real queries produces confident wrong answers -- which is
 *    worse than no answer on a surface whose whole job is to be believed.
 *
 *  - NO FIELD IT CANNOT READ. `CatalogItem` carries `title` and `genre` and no
 *    other text: no synopsis, no cast, no keywords, no alternate titles. So
 *    "title over other fields" means, concretely and only, "title over genre".
 *    Scoring a synopsis would mean adding a field to `packages/contracts` and
 *    populating it in `packages/catalog-ingestion`, neither of which is written
 *    from here; see this wave's report for the proposed contract change.
 * ---------------------------------------------------------------------- */

/**
 * The text-bearing fields of a `CatalogItem`, in precedence order.
 *
 * An enumeration rather than a string, so adding a field is a change to a
 * weight table that the exhaustiveness of `FIELD_WEIGHT` forces the author to
 * place deliberately -- rather than a new `includes` call appended to a
 * classifier, which is how `genre-contains` ended up ranked by its position in
 * an `if` chain.
 */
export type SearchField = "title" | "genre";

/**
 * How well the query sits inside a field, lowest value best.
 *
 * `word-prefix` IS THE TIER THAT DID NOT EXIST, and it is the point of this
 * module. "Starts with" and "contains somewhere" are the two ends of a range
 * with the most useful case in the middle: a query that begins a WORD of the
 * title is almost always the title the reader meant, and under the old
 * classifier it was indistinguishable from a mid-word letter collision.
 *
 * `exact` stays separate from `prefix` even though an exact match is a prefix
 * match, because a reader who typed the whole title has told us which title
 * they want and no partial hit should be able to outrank that on recency.
 */
export type SearchMatchTier = "exact" | "prefix" | "word-prefix" | "substring";

const TIER_RANK: Readonly<Record<SearchMatchTier, number>> = {
  exact: 0,
  prefix: 1,
  "word-prefix": 2,
  substring: 3
};

/**
 * The number of tiers, used as the radix of the score below.
 *
 * Derived from the table rather than written as `4`, so adding a tier cannot
 * silently make two fields' score ranges overlap -- which would turn "a title
 * hit always outranks a genre hit" from an invariant into a coincidence.
 */
const TIER_COUNT = Object.keys(TIER_RANK).length;

/**
 * Field precedence, lowest value best. Title beats everything.
 *
 * A TABLE AND NOT A COMPARATOR CHAIN. The old classifier expressed this as the
 * order of its own `if` statements, which means the rule was readable only by
 * executing the function in your head and could not be asserted on directly.
 */
const FIELD_WEIGHT: Readonly<Record<SearchField, number>> = {
  title: 0,
  genre: 1
};

/**
 * One match, scored.
 *
 * `score` IS A SINGLE TOTAL-ORDERED INTEGER and the field/tier pair is kept
 * beside it rather than discarded. The integer is what the sort uses; the pair
 * is what explains the integer to a reader, to a test, and to whoever reads the
 * bug report. Product invariant 4 requires playback decisions to carry a reason
 * trail, and a ranking is a decision of exactly that kind -- an unexplained
 * order is unfixable from the outside.
 */
export interface SearchRelevance {
  readonly field: SearchField;
  readonly tier: SearchMatchTier;
  /** `FIELD_WEIGHT[field] * TIER_COUNT + TIER_RANK[tier]`. Lower is better. */
  readonly score: number;
  /**
   * The same decision expressed in the vocabulary `@liberty/contracts` already
   * publishes, because `searchResponseSchema` validates every response this
   * surface produces and `SearchMatchKind` is a closed enum this file may not
   * extend -- `packages/contracts` is read-only to this wave's worker.
   *
   * THE MAPPING IS LOSSY IN ONE PLACE AND THAT IS RECORDED RATHER THAN HIDDEN:
   * `word-prefix` and `substring` both publish as `title-contains`, so the
   * label a reader sees is coarser than the order they are looking at. The
   * ORDER is the finer-grained thing and it is correct; the label is the
   * contract's current resolution. A `title-word-prefix` member is the contract
   * change this wants, proposed in the worker report rather than made here.
   */
  readonly matchedOn: SearchMatchKind;
}

function scoreOf(field: SearchField, tier: SearchMatchTier): number {
  return FIELD_WEIGHT[field] * TIER_COUNT + TIER_RANK[tier];
}

/**
 * The contract label for a field/tier pair.
 *
 * Total over both enumerations by construction -- there is no `default` branch
 * and no fallback string, so adding a field or a tier stops this compiling
 * instead of quietly publishing the wrong label.
 */
function contractLabel(field: SearchField, tier: SearchMatchTier): SearchMatchKind {
  if (field === "genre") return "genre-contains";
  switch (tier) {
    case "exact":
      return "title-exact";
    case "prefix":
      return "title-prefix";
    default:
      return "title-contains";
  }
}

/**
 * Case folding for comparison. `toLowerCase`, never `toLocaleLowerCase`.
 *
 * The same choice and the same reason `search.ts` and `browse.ts` both record
 * against their own copies: the locale-aware variant maps "I" to a dotless "ı"
 * under a Turkish locale, so an identical query against an identical catalog
 * would match differently depending on which machine answered.
 */
export function foldSearchText(value: string): string {
  return value.toLowerCase();
}

/**
 * Does a code point belong to a WORD, for the purpose of finding word starts?
 *
 * BUILT WITH `new RegExp` AND NOT WRITTEN AS A LITERAL, which is the whole
 * reason this constant exists instead of an inline `/[\p{L}\p{N}\p{M}]/u`.
 * Unicode property escapes are a PARSE-time feature: an environment that does
 * not implement them raises a SyntaxError for the entire module, so the failure
 * is not "word boundaries get coarser", it is "the search page does not load".
 * `search.ts` imports this file, and this project is concurrently repairing a
 * platform-specific client TypeError, so a module that can fail to evaluate is
 * exactly the defect class under repair. Constructed here, the unsupported case
 * is catchable and degrades to the ASCII class below.
 *
 * `\p{M}` (combining marks) is in the class deliberately. Without it, a decomposed
 * "e" + U+0301 would read as a word character followed by a NON-word character,
 * so "école" would appear to contain a word boundary in the middle of its first
 * letter and `q=cole` would be promoted to `word-prefix`. Marks are part of the
 * grapheme they attach to, so they are part of the word.
 *
 * `Intl.Segmenter` would be the textbook instrument here and is deliberately not
 * used: it is not universally present, its word segmentation is locale-sensitive
 * by design, and a locale-sensitive ranking is the defect property 2 above
 * exists to prevent.
 */
const WORD_CHARACTER: RegExp = (() => {
  try {
    return new RegExp("[\\p{L}\\p{N}\\p{M}]", "u");
  } catch {
    /*
     * ASCII-only fallback. Strictly worse -- a non-ASCII letter then reads as a
     * separator, so some mid-word matches are over-promoted to `word-prefix` --
     * and strictly better than refusing to load. Unreachable on every runtime
     * this workspace targets; written because "unreachable" is a claim about
     * today's runtimes and this file must not be the reason a new one fails.
     */
    return /[0-9A-Za-z]/;
  }
})();

/**
 * Is `index` the start of a word inside `text`?
 *
 * Index 0 is, trivially. Otherwise it is a word start exactly when the code
 * point immediately before it is not a word character -- a space, a hyphen, a
 * colon, an em dash, an ideographic full stop, anything.
 *
 * THE CODE POINT, NOT THE CODE UNIT. `text[index - 1]` reads one UTF-16 unit,
 * which is the LOW HALF of a surrogate pair when the preceding character is
 * astral; a lone low surrogate is not a word character under any class, so a
 * match immediately after an emoji or an astral letter would be reported as a
 * word start for a reason that has nothing to do with the text. Stepping back
 * over the pair reads the character that is actually there. `codePointAt` is
 * ES2015 and universally available; nothing here needs `Intl.Segmenter`.
 */
export function isWordStart(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previousUnit = text.charCodeAt(index - 1);
  const isLowSurrogate = previousUnit >= 0xdc00 && previousUnit <= 0xdfff;
  const start = isLowSurrogate && index >= 2 ? index - 2 : index - 1;
  const codePoint = text.codePointAt(start);
  if (codePoint === undefined) return true;
  return !WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

/**
 * The best tier at which `foldedQuery` sits inside `foldedField`, or `null`.
 *
 * SCANS EVERY OCCURRENCE RATHER THAN STOPPING AT THE FIRST, and that is not an
 * optimisation that was skipped -- it is the correctness of the tier. "Pitfall
 * of the Fall" contains `fall` mid-word at index 3 and at a word start at index
 * 15; stopping at the first occurrence would score it `substring` and rank a
 * genuine word-start title below a mid-word collision. The loop therefore keeps
 * the BEST tier seen, and exits early only when it reaches the best tier that
 * is still achievable (`word-prefix`, since `exact` and `prefix` are both
 * decided before the loop begins).
 *
 * An empty query returns `null` rather than matching everything. `indexOf("")`
 * is 0 for every string, so without this guard every item in the catalog would
 * score an `exact`-adjacent prefix hit and the idle state would render as a
 * full result set -- which is the defect `search.ts` keeps `idle` separate from
 * `empty` to avoid, arriving through the back door.
 */
export function classifyFieldMatch(
  foldedField: string,
  foldedQuery: string
): SearchMatchTier | null {
  if (foldedQuery === "") return null;
  if (foldedField === foldedQuery) return "exact";
  if (foldedField.startsWith(foldedQuery)) return "prefix";

  let best: SearchMatchTier | null = null;
  let at = foldedField.indexOf(foldedQuery);
  while (at !== -1) {
    if (isWordStart(foldedField, at)) return "word-prefix";
    best = "substring";
    at = foldedField.indexOf(foldedQuery, at + 1);
  }
  return best;
}

/**
 * The folded text of one item, computed at most once per item object.
 *
 * MEASURED DE-DUPLICATION, WHICH IS THIS WAVE'S FIFTH OBJECTIVE AND THE REASON
 * THIS IS NOT JUST A `toLowerCase()` CALL AT THE USE SITE. Scoring folds both
 * fields of every surfaced item on every query. The browse surface and the
 * search surface read the SAME item objects out of the same in-process
 * metadata source within a process, and the title route scores nothing but
 * reads the same objects again -- so the folding is repeated work over inputs
 * that are, by object identity, already known.
 *
 * A `WeakMap` KEYED ON THE ITEM, for three reasons and not for speed alone:
 *
 *  - It is keyed on IDENTITY, so it cannot serve stale text. A re-read that
 *    produces new objects (a provider adapter re-parsing a payload, which is
 *    what `selectDeclaredItems` does to every record it validates) misses and
 *    recomputes. There is no TTL to tune and no invalidation to forget, which
 *    is the failure mode of every keyed metadata cache this codebase could
 *    otherwise have grown.
 *  - It holds its keys WEAKLY, so a cache over a catalog of any size cannot
 *    become a leak: when the source drops an item object, the entry goes with
 *    it. A `Map` here would pin every item ever surfaced in the process for the
 *    lifetime of the process.
 *  - It is LOCAL AND IN-PROCESS. No network, no storage, no dependency; the
 *    cloud ceiling is 0.0 and local-first is an invariant, so a metadata cache
 *    that is anything other than process memory is not available to this
 *    surface at any price.
 *
 * `folds()` AND `hits()` EXIST SO THE CLAIM CAN BE MEASURED RATHER THAN
 * ASSERTED. This wave's instruction on caching is "measure, do not assume", and
 * a cache with no counter is a cache nobody can show is working:
 * `relevance.test.ts` scores the same items twice and asserts the number of
 * folds did not grow. They are also the only honest way to state the limit --
 * the counters show, and the test records, that the hit comes from repeat scans
 * of the same objects and NOT from two requests that each re-parsed the catalog.
 */
interface FoldedItemText {
  readonly title: string;
  readonly genre: string;
}

const FOLDED_TEXT = new WeakMap<CatalogItem, FoldedItemText>();

let foldCount = 0;
let foldHitCount = 0;

/** How many items have had their text folded from scratch in this process. */
export function foldedTextComputations(): number {
  return foldCount;
}

/** How many folds were served from the memo instead of recomputed. */
export function foldedTextReuses(): number {
  return foldHitCount;
}

/**
 * Reset the counters. For tests only, so one suite's measurement is not a
 * reading of another suite's traffic -- the memo itself is deliberately NOT
 * cleared, because clearing it would make the counters measure the reset rather
 * than the caching.
 */
export function resetFoldedTextCounters(): void {
  foldCount = 0;
  foldHitCount = 0;
}

export function foldedTextFor(item: CatalogItem): FoldedItemText {
  const cached = FOLDED_TEXT.get(item);
  if (cached !== undefined) {
    foldHitCount += 1;
    return cached;
  }
  const folded: FoldedItemText = {
    title: foldSearchText(item.title),
    genre: foldSearchText(item.genre)
  };
  FOLDED_TEXT.set(item, folded);
  foldCount += 1;
  return folded;
}

/**
 * The best relevance `foldedQuery` has against `item`, or `null` for no match.
 *
 * FIELDS ARE TRIED IN PRECEDENCE ORDER AND THE BEST SCORE WINS -- not the first
 * field that matches. The distinction is visible whenever a query hits both: a
 * genre `exact` hit and a title `substring` hit are both real, and the title
 * one must win, which a first-match-wins chain gets right only because of the
 * order the branches happen to be written in. Comparing scores states the rule
 * once and makes it hold no matter how the loop is reordered.
 *
 * NOTE WHAT IS NOT HERE: no rights check and no kind check. Both are the
 * CALLER's, and deliberately upstream of this function -- `searchCatalog` runs
 * `isSurfaceable` before it ever asks for a score, so a record this catalog has
 * declined to surface cannot reach a ranking at all. A scorer that also gated
 * rights would be a second place for the gate to live and a second place for it
 * to be weakened; see `browse.ts`, which records the same boundary for facets.
 */
export function scoreCatalogItem(item: CatalogItem, foldedQuery: string): SearchRelevance | null {
  if (foldedQuery === "") return null;
  const folded = foldedTextFor(item);

  let best: SearchRelevance | null = null;
  for (const field of ["title", "genre"] as const) {
    const tier = classifyFieldMatch(field === "title" ? folded.title : folded.genre, foldedQuery);
    if (tier === null) continue;
    const score = scoreOf(field, tier);
    if (best !== null && best.score <= score) continue;
    best = { field, tier, score, matchedOn: contractLabel(field, tier) };
  }
  return best;
}

/**
 * The total order on scored results.
 *
 * RELEVANCE, THEN NEWEST, THEN TITLE, THEN ID -- the same tail every ordered
 * surface in this application uses (`browseCatalog`, `searchCatalog`), so two
 * equally relevant results are arranged the way the reader has already been
 * taught to expect everywhere else.
 *
 * TOTAL, AND THE LAST COMPARISON ALWAYS DECIDES. `id` is unique within a
 * catalog, so this comparator can never return 0 for two distinct items and the
 * sort can never fall back on input order -- which is what makes the whole
 * surface reproducible from the data alone. `Array.prototype.sort` is stable in
 * every engine this targets, but relying on that stability would make the output
 * depend on the order the catalog arrived in, and the catalog port makes no
 * promise about that.
 *
 * BY CODE POINT, NEVER `localeCompare`. Without an explicit locale the latter
 * uses the host's collation, so two machines order an identical result set
 * differently -- the defect already removed from candidate ranking in
 * `@liberty/media-engine` and from this surface's previous sort.
 */
export function compareByRelevance(
  a: { readonly relevance: SearchRelevance; readonly item: CatalogItem },
  b: { readonly relevance: SearchRelevance; readonly item: CatalogItem }
): number {
  if (a.relevance.score !== b.relevance.score) return a.relevance.score - b.relevance.score;
  if (a.item.releaseYear !== b.item.releaseYear) return b.item.releaseYear - a.item.releaseYear;
  if (a.item.title !== b.item.title) return a.item.title < b.item.title ? -1 : 1;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

/**
 * Why this result is here and in this position, in words.
 *
 * Derived here rather than in the component for the reason every other
 * description on these surfaces is: `apps/web/vitest.config.ts` sets
 * `environment: "node"`, so a sentence assembled inside a client component is a
 * sentence no test in this suite can read. It is also the finer-grained truth
 * that `matchedOn` cannot carry -- the component can show the real tier even
 * though the contract label flattens two of them.
 */
export function describeRelevance(relevance: SearchRelevance): string {
  if (relevance.field === "genre") {
    return relevance.tier === "exact" ? "Genre is an exact match" : "Genre matches your search";
  }
  switch (relevance.tier) {
    case "exact":
      return "Exact title match";
    case "prefix":
      return "Title starts with your search";
    case "word-prefix":
      return "A word in the title starts with your search";
    default:
      return "Title contains your search";
  }
}
