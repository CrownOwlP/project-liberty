import { cache } from "react";
import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { createCatalogMemo, isSurfaceable, type CatalogMemo } from "../../lib/catalog";
import { selectDeclaredItems } from "../../lib/catalog-source";
import { resolveCatalogMetadataSource } from "../../lib/catalog-source-registry";
import { NonDeploymentEnvironment } from "../api/deployment-environment";

/* -------------------------------------------------------------------------
 * The browse surface (PL-0756).
 *
 * WHAT THIS IS FOR, AND WHY HOME AND SEARCH DO NOT COVER IT. `docs/
 * PRODUCT_SPEC.md` names "Home/catalog/search" among the MVP capabilities.
 * Home renders two rails -- films and series, newest first, from
 * `RAIL_DEFINITIONS` in `lib/catalog.ts` -- which answers "what is new" and
 * nothing else. Search answers a question the viewer already has. Neither
 * answers "what IS there", and nor does any route in this application: a
 * viewer who wants everything, or everything in one genre, has nowhere to go.
 *
 * IT READS THE SAME PORT THROUGH THE SAME GATES AND IN THE SAME ORDER as both
 * of those surfaces -- the metadata port, then `selectDeclaredItems`, then
 * `isSurfaceable`, then the browsable-kind allowlist. No second catalog read
 * path, no fixture import, no provider of its own. `app/search/search.ts` is
 * the file this one is modelled on and its reasoning is not restated here
 * except where browse differs from it.
 *
 * THERE IS NO WIRE CONTRACT AND NO ROUTE HANDLER, deliberately.
 * `docs/API_CONTRACTS.md` requires schemas in `@liberty/contracts` before a
 * route exists and lists no browse route among the planned ones; search
 * validates against `searchResponseSchema` because that contract exists AHEAD
 * of `GET /api/v1/search`, which is planned. Nothing transports the value
 * below -- it is computed during the server render and consumed by the
 * component next to it -- so publishing a schema for it would be contract
 * machinery with no transport, and the items inside it have already been
 * validated by the port that produced them.
 * ---------------------------------------------------------------------- */

/**
 * Kinds this surface lists.
 *
 * `episode` is absent for the reason home and search both give: an episode is
 * reachable through its series and has no standalone destination, so listing
 * one produces a card the viewer cannot open.
 */
export const BROWSABLE_KINDS: ReadonlyArray<CatalogItem["kind"]> = ["movie", "series"];

/** The kind filter, as a viewer can set it. `all` is the unfiltered default. */
export type BrowseKindFilter = "all" | "movie" | "series";

const KIND_FILTERS: ReadonlyArray<BrowseKindFilter> = ["all", "movie", "series"];

/**
 * How long a genre parameter may be before it is discarded.
 *
 * Bounded for the reason `SEARCH_QUERY_MAX_LENGTH` is bounded: the value
 * arrives from a URL anyone can author, it is compared against every item in
 * the catalog, and it is echoed into the page. 64 is generous against the
 * genre strings the contract actually carries and small enough that a crafted
 * link cannot push a paragraph through this surface.
 */
export const BROWSE_GENRE_MAX_LENGTH = 64;

/*
 * THE THREE ROUTES THIS MODULE SERVES, AND WHICH KIND EACH FIXES (Wave 131B).
 *
 * `/browse` lets the viewer choose; `/movies` and `/tv` are the same surface
 * with the kind decided by the path. They exist because "Movies" and "TV Shows"
 * are what a viewer looks for in a navigation bar -- a kind dropdown on one
 * page is a filter, and a named destination is a place -- and because the
 * machinery was already here: one loader, one grid, one empty-state vocabulary.
 *
 * A MAP RATHER THAN THREE PAGES THAT KNOW THEIR OWN KIND, so the pairing is
 * stated once and `buildBrowseHref` can tell which query parameter a given
 * route must NOT emit.
 */
export const BROWSE_PATH = "/browse";
export const MOVIES_PATH = "/movies";
export const TV_PATH = "/tv";

export const KIND_LOCKED_PATHS: ReadonlyMap<string, Exclude<BrowseKindFilter, "all">> = new Map([
  [MOVIES_PATH, "movie"],
  [TV_PATH, "series"]
]);

/* -------------------------------------------------------------------------
 * SORT ORDER AS A VIEWER CONTROL (Wave 132, worker C).
 *
 * THE DEFECT CLASS REMOVED: one hard-coded order presented as the only order.
 *
 * `browseCatalog` has always ordered by `releaseYear desc, title, id`, which is
 * the right DEFAULT and the wrong only option. The reason is specific rather
 * than cosmetic: this surface exists to answer "what IS there" (see the header
 * above), and on a catalog of any size the question is usually asked
 * alphabetically -- a reader looking for a title they can half remember cannot
 * use a list ordered by a year they do not know. Narrowing to a genre makes it
 * worse, not better: the newest-first order is most useful on the unfiltered
 * page and least useful on the one the reader has just narrowed by hand.
 *
 * THE DEFAULT IS BYTE-FOR-BYTE THE PREVIOUS BEHAVIOUR. `newest` produces
 * exactly the comparator this module had before, so an existing link, an
 * existing bookmark and every existing assertion describe the same page. A new
 * control that changes the unparameterised page is a migration disguised as a
 * feature.
 *
 * EVERY ORDER IS TOTAL AND EVERY TIE-BREAK IS EXPLICIT. `SORT_COMPARATORS`
 * below states a primary key per option and then falls through the SAME tail --
 * title by code point, then `id` -- so no option can ever return 0 for two
 * distinct items and no option can fall back on the order the catalog arrived
 * in. The catalog port promises nothing about that order, so an order that
 * depends on it is not reproducible from the data.
 *
 * BY CODE POINT, NEVER `localeCompare`, which is forbidden for ordering in this
 * repository because without an explicit locale it uses the host's collation:
 * two machines would order an identical catalog differently, and an "A-Z" that
 * is a different A-Z per server is not a sort a reader can use. The defect was
 * removed from candidate ranking in `@liberty/media-engine` and from search's
 * result sort before it could be added here.
 * ---------------------------------------------------------------------- */

/** The orders a viewer may ask for. `newest` is the unchanged default. */
export type BrowseSortKey = "newest" | "oldest" | "title" | "title-desc";

const SORT_KEYS: ReadonlyArray<BrowseSortKey> = ["newest", "oldest", "title", "title-desc"];

export const DEFAULT_BROWSE_SORT: BrowseSortKey = "newest";

/**
 * Title, then id: the tail every option shares.
 *
 * SPLIT OUT SO IT IS STATED ONCE. Four comparators each ending in their own
 * copy of two comparisons is four places for the tie-break to drift, and a
 * drifted tie-break is invisible until two titles collide in production. `id` is
 * unique within a catalog, so this always decides and the order is total.
 */
function byTitleThenId(a: CatalogItem, b: CatalogItem): number {
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * One comparator per option, total by construction.
 *
 * `title-desc` REVERSES ONLY THE TITLE, not the tail. Negating the whole
 * comparator would also reverse `id`, which would make the Z-A page's tie-break
 * the mirror of the A-Z page's rather than the same rule -- defensible, and
 * harder to reason about than "titles descend, everything else is unchanged".
 * Two items with the IDENTICAL title still order by ascending `id` in both
 * directions, so the pair's relative order is a property of the data and not of
 * which button was pressed.
 */
const SORT_COMPARATORS: Readonly<Record<BrowseSortKey, (a: CatalogItem, b: CatalogItem) => number>> =
  {
    newest: (a, b) =>
      a.releaseYear !== b.releaseYear ? b.releaseYear - a.releaseYear : byTitleThenId(a, b),
    oldest: (a, b) =>
      a.releaseYear !== b.releaseYear ? a.releaseYear - b.releaseYear : byTitleThenId(a, b),
    title: (a, b) => byTitleThenId(a, b),
    "title-desc": (a, b) =>
      a.title !== b.title ? (a.title < b.title ? 1 : -1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  };

/** The label a control shows for each order. Beside the comparators, so one cannot exist without the other. */
export const BROWSE_SORT_LABEL: Readonly<Record<BrowseSortKey, string>> = {
  newest: "Newest first",
  oldest: "Oldest first",
  title: "Title A–Z",
  "title-desc": "Title Z–A"
};

/**
 * The same four orders as they read INSIDE A SENTENCE.
 *
 * A SECOND TABLE RATHER THAN `BROWSE_SORT_LABEL[sort].toLowerCase()`, which is
 * what this was and which produced "4 titles title a–z." -- a control label
 * lowercased is not a phrase, and an em-dashed range reads as a label and not as
 * a clause. Both tables are keyed by `BrowseSortKey` with no index signature, so
 * a new order is a type error in both places rather than a missing word in one.
 */
const BROWSE_SORT_SUMMARY: Readonly<Record<BrowseSortKey, string>> = {
  newest: "newest first",
  oldest: "oldest first",
  title: "A–Z by title",
  "title-desc": "Z–A by title"
};

export interface BrowseFilters {
  readonly kind: BrowseKindFilter;
  /** The exact genre to show, or `null` for every genre. */
  readonly genre: string | null;
  /**
   * The order the viewer asked for.
   *
   * REQUIRED RATHER THAN OPTIONAL, which cost a handful of edits to this
   * module's own tests and is worth it: an optional sort would let a caller
   * construct a filter set with no stated order and receive the default by
   * accident, so the one thing this field exists to make explicit would be
   * implicit again at every call site that forgot it. `UNFILTERED` is the
   * spelling for "no filters, default order".
   */
  readonly sort: BrowseSortKey;
}

export const UNFILTERED: BrowseFilters = {
  kind: "all",
  genre: null,
  sort: DEFAULT_BROWSE_SORT
};

/** One genre the viewer may filter by, and how many titles carry it. */
export interface BrowseGenreFacet {
  readonly genre: string;
  readonly count: number;
}

export interface BrowseResponse {
  readonly filters: BrowseFilters;
  /** Every genre the viewer could choose, derived from the surfaced items. */
  readonly genres: readonly BrowseGenreFacet[];
  readonly items: readonly CatalogItem[];
  readonly generatedAt: string;
}

/**
 * Why a browse page is empty, and the distinction is the point.
 *
 * `app/search/search.ts` explains at length why "no query was asked" and "your
 * query matched nothing" must not collapse, and `lib/catalog.ts` carries a
 * `cause` field for the same reason on home. Browse has the same pair one step
 * along: a catalog with nothing browsable in it and a filter combination that
 * matched nothing are different facts with different remedies, and both
 * legitimately produce an empty array. Telling a viewer to try other filters
 * when there is nothing behind any of them is the same lie as telling them
 * nothing matched a search they never ran.
 */
export type BrowseEmptyCause = "catalog_has_no_browsable_titles" | "filters_match_nothing";

export type BrowseLoadResult =
  | { status: "ok"; response: BrowseResponse }
  | {
      status: "empty";
      filters: BrowseFilters;
      genres: readonly BrowseGenreFacet[];
      cause: BrowseEmptyCause;
      generatedAt: string;
    }
  | { status: "error"; reason: string };

/**
 * The reason this surface reports when the process has no catalog metadata
 * source. The same string `loadHomeCatalog` and `loadSearchResults` return,
 * and restated here for the reason `search.ts` records against its own copy:
 * `CatalogLoadResult.reason` is typed `string`, so there is no constant to
 * import, and the shared vocabulary belongs beside the port rather than on a
 * surface. Three spellings of one reason is now the standing cost of that, and
 * it is recorded rather than hidden.
 */
export const CATALOG_SOURCE_NOT_CONFIGURED_REASON = "catalog_source_not_configured";

/**
 * Case folding for comparison. `toLowerCase` and NOT `toLocaleLowerCase`, the
 * same choice and the same reason as `search.ts`: the locale-aware variant maps
 * "I" differently under a Turkish locale, so the same filter against the same
 * catalog would select differently depending on the environment the server
 * happens to run in.
 */
function fold(value: string): string {
  return value.toLowerCase();
}

/**
 * Pure and deterministic: same items and same filters in, same response out.
 * No clock, no randomness, and no dependence on the order the catalog arrived
 * in.
 *
 * THE FACETS ARE DERIVED FROM THE SURFACED ITEMS, NOT FROM THE INPUT, and that
 * ordering is a rights boundary rather than a tidiness preference. A genre list
 * is published to the viewer. Computing it before the gate would let a record
 * this catalog has declined to surface contribute its genre name -- telling the
 * viewer the catalog holds something of that kind while refusing to show it,
 * which is a disclosure through a filter control instead of through a card. So
 * the gate runs first and the facets are counted from what came through it.
 *
 * The facets describe the KIND-FILTERED population, so the genre list answers
 * "what else could I pick from here" rather than "what exists somewhere else on
 * this surface" -- and a genre whose only titles are films disappears when the
 * viewer narrows to series, rather than offering a choice that leads nowhere.
 * The genre filter itself is not applied before counting, because a facet list
 * narrowed by the current genre would collapse to one entry and the viewer
 * could never choose another.
 */
export function browseCatalog(
  items: readonly CatalogItem[],
  filters: BrowseFilters,
  generatedAt: string
): BrowseResponse {
  const surfaced: CatalogItem[] = [];
  for (const item of items) {
    /* Rights gate first, before anything else can decide to keep the item. */
    if (!isSurfaceable(item)) continue;
    if (!BROWSABLE_KINDS.includes(item.kind)) continue;
    if (filters.kind !== "all" && item.kind !== filters.kind) continue;
    surfaced.push(item);
  }

  const counts = new Map<string, number>();
  for (const item of surfaced) counts.set(item.genre, (counts.get(item.genre) ?? 0) + 1);

  /*
   * Commonest first so the list opens with the choices that lead somewhere,
   * then by genre name in CODE POINT order. Never `localeCompare`: without an
   * explicit locale it uses the host's collation, so two machines order an
   * identical catalog differently. That is the defect already removed from
   * candidate ranking in `@liberty/media-engine` and from search's result sort.
   * The name decides last and genre names are distinct keys of a Map, so the
   * order is total and cannot fall back on insertion order.
   */
  const genres: BrowseGenreFacet[] = [...counts.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.genre < b.genre ? -1 : 1));

  const wanted = filters.genre === null ? null : fold(filters.genre);
  const selected = wanted === null ? surfaced : surfaced.filter((item) => fold(item.genre) === wanted);

  /*
   * THE ORDER THE VIEWER ASKED FOR, and newest-first when they asked for
   * nothing -- which is byte-for-byte the comparator this line used to inline.
   * Every option ends in the same `title`-then-`id` tail, by code point for the
   * reason above, so each is total and the last comparison always decides.
   *
   * THE SORT IS THE LAST THING THAT HAPPENS, after the rights gate, the kind
   * allowlist, the facet count and the genre filter. Ordering cannot admit an
   * item, so nothing about it can weaken a gate -- and a reader can reorder a
   * page as often as they like without any of the decisions above being retaken.
   */
  /*
   * The `??` is not dead code even though `BrowseSortKey` makes it unreachable
   * through the type system. `BrowseFilters` is a plain object: a caller that
   * built one from parsed JSON, from a stored preference, or from a future
   * route handler's body has a `sort` TypeScript never checked, and an unknown
   * key would otherwise index to `undefined` and make `sort` throw mid-render.
   * `readBrowseSortParam` is the guarded door for URL input; this is the floor
   * under every other door.
   */
  const ordered = [...selected].sort(SORT_COMPARATORS[filters.sort] ?? SORT_COMPARATORS.newest);

  return { filters, genres, items: ordered, generatedAt };
}

/**
 * `kind` as it actually arrives from a URL.
 *
 * The rules `readSearchQueryParam` states for `q`, applied to an enumeration:
 * `?kind=a&kind=b` parses to an array and the FIRST value wins rather than the
 * values being joined, because joining lets a crafted link build a filter the
 * viewer never chose. Anything unrecognised -- a typo, a probe, a stale link
 * from a future version -- falls back to `all` rather than throwing, because a
 * malformed filter is an unfiltered page and not a 500.
 */
export function readBrowseKindParam(value: string | string[] | undefined): BrowseKindFilter {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return "all";
  const candidate = first.trim() as BrowseKindFilter;
  return KIND_FILTERS.includes(candidate) ? candidate : "all";
}

/**
 * `genre` as it actually arrives from a URL.
 *
 * Same first-value rule. Trimmed, because a trailing space in a shared link is
 * not a different genre; discarded when empty or longer than
 * `BROWSE_GENRE_MAX_LENGTH`, so `?genre=` and a padded link both mean "every
 * genre" rather than "a genre nothing has".
 *
 * NOT VALIDATED AGAINST THE FACET LIST HERE, because this function is given a
 * parameter and not a catalog. A genre no item carries is a filter that matches
 * nothing, which `browseCatalog` reports as `filters_match_nothing` -- a page
 * that says so, rather than a silent fallback that shows the viewer a different
 * query than the one in their address bar.
 */
export function readBrowseGenreParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return null;
  const trimmed = first.trim();
  if (trimmed === "" || trimmed.length > BROWSE_GENRE_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * `sort` as it actually arrives from a URL.
 *
 * The same first-value rule as `kind`, and the same fallback discipline:
 * anything unrecognised -- a typo, a probe, a stale link from a future version
 * that offered an order this one does not -- becomes the DEFAULT order rather
 * than throwing. A malformed sort is a normally ordered page, not a 500.
 *
 * NOT VALIDATED AGAINST THE ITEMS, because an order is a statement about
 * presentation and cannot fail to apply. That is the one way this differs from
 * `readBrowseGenreParam`, which deliberately lets an unmatched genre through so
 * the page can say it matched nothing: an unmatched genre is a fact about the
 * catalog the reader needs told, whereas an unknown sort key is a fact about the
 * link and there is nothing truthful to say about it beyond ordering the page.
 */
export function readBrowseSortParam(value: string | string[] | undefined): BrowseSortKey {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return DEFAULT_BROWSE_SORT;
  const candidate = first.trim() as BrowseSortKey;
  return SORT_KEYS.includes(candidate) ? candidate : DEFAULT_BROWSE_SORT;
}

/** Every filter, read from one search-params object. */
export function readBrowseFilters(
  params: Record<string, string | string[] | undefined>,
  lockedKind: Exclude<BrowseKindFilter, "all"> | null = null
): BrowseFilters {
  /*
   * A LOCKED KIND WINS OVER THE QUERY, and it is not a courtesy. `/movies?kind=series`
   * is either a stale link or someone poking at the surface; honouring the query
   * would serve series under a path and a heading that both say films. The path
   * is the statement.
   */
  return {
    kind: lockedKind ?? readBrowseKindParam(params.kind),
    genre: readBrowseGenreParam(params.genre),
    /*
     * THE SORT IS NOT LOCKED BY ANY ROUTE. `/movies` and `/tv` fix the KIND
     * because the path and the heading both state it; neither says anything
     * about an order, so there is nothing for a locked value to be consistent
     * with and a reader on `/movies` may sort films however they like.
     */
    sort: readBrowseSortParam(params.sort)
  };
}

/**
 * The address of a filtered browse page.
 *
 * `encodeURIComponent` on the genre rather than `URLSearchParams`, which is the
 * encoder `buildSearchHref` settled on and for the same reason: the default
 * values are omitted entirely, so the unfiltered page is `/browse` and not
 * `/browse?kind=all&genre=`.
 */
export function buildBrowseHref(filters: BrowseFilters, basePath: string = BROWSE_PATH): string {
  const parts: string[] = [];
  /*
   * A ROUTE THAT FIXES THE KIND DOES NOT REPEAT IT IN THE QUERY. `/movies`
   * already says `kind=movie`; emitting it as well would produce two sources of
   * truth for one filter and a shareable link that contradicts its own path if
   * somebody edited one of them.
   */
  const lockedKind = KIND_LOCKED_PATHS.get(basePath) ?? null;
  if (filters.kind !== "all" && filters.kind !== lockedKind) {
    parts.push(`kind=${encodeURIComponent(filters.kind)}`);
  }
  if (filters.genre !== null) parts.push(`genre=${encodeURIComponent(filters.genre)}`);
  /*
   * THE DEFAULT ORDER IS NOT EMITTED, which is the rule this function already
   * applies to `kind=all` and an absent genre: the unfiltered, default-ordered
   * page is `/browse` and not `/browse?kind=all&genre=&sort=newest`. It also
   * keeps the default honest in one direction only -- a link that says nothing
   * about order means "whatever the default is", so changing the default would
   * move those links rather than stranding them on a frozen copy of it.
   */
  if (filters.sort !== DEFAULT_BROWSE_SORT) {
    parts.push(`sort=${encodeURIComponent(filters.sort)}`);
  }
  return parts.length === 0 ? basePath : `${basePath}?${parts.join("&")}`;
}

/**
 * Server-side browse source: the configured catalog, filtered in this process.
 *
 * `null` MEANS NO METADATA SOURCE IS CONFIGURED, carried through as the third
 * absence this surface can report -- distinct from both empty states above, for
 * the reason `getSearchResults` gives: a deployment with no provider has an
 * operator remedy, and telling the viewer the catalog is empty would be false
 * because no catalog was consulted.
 *
 * PROVIDER-SIDE FILTERING DOES NOT EXIST. The port has no filter or paging
 * capability, so the whole record list is fetched and narrowed here. That is
 * fine for six fixtures and is not a shape a catalog of real size can use;
 * `docs/CATALOG_SOURCE.md` records it as an open design question, and this
 * surface makes it one question louder rather than a new one.
 *
 * `environment` IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME, and it is a
 * parameter so a test can reach the deployment refusal without mutating
 * `process.env` and racing every other suite in the same worker. It is not a
 * request input -- nothing on the page passes one -- and the default classifies
 * the process at CALL time, never at module scope.
 */
export async function getBrowseItems(
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): Promise<readonly CatalogItem[] | null> {
  const resolution = resolveCatalogMetadataSource(environment);
  if (resolution.status === "not-configured") return null;
  const records = await resolution.source.listRecords();
  return selectDeclaredItems(records).items;
}

/**
 * Where browse items come from. Injectable so the loader's failure paths are
 * testable, and so a provider-backed index can replace the fixtures without the
 * page changing.
 */
export type BrowseSource = () =>
  | readonly CatalogItem[]
  | null
  | Promise<readonly CatalogItem[] | null>;

/* -------------------------------------------------------------------------
 * ONE METADATA READ PER REQUEST (Wave 132, worker C).
 *
 * THE DEFECT CLASS: the same port asked the same question twice in one render,
 * with no guarantee the two answers agree.
 *
 * `app/title/[titleId]/page.tsx` already carries this fix and states the
 * failure precisely: `generateMetadata` and the component body are two calls
 * for one request, "and the two answers are not required to agree -- a source
 * that failed between them would title the tab after a title the page below
 * says it could not load". That is a CORRECTNESS defect before it is a cost
 * one, and nothing stopped it recurring here. `/browse`, `/movies` and `/tv`
 * each render one surface today, so the duplicate read is not yet present on
 * this route -- which is exactly when to install the guarantee, because the
 * next person to add a `generateMetadata` to a browse route will not read this
 * file first.
 *
 * TWO MECHANISMS, EACH DOING ONE THING, and neither is a TTL cache:
 *
 *  - React's `cache` supplies the SCOPE. It is request-scoped inside a Next
 *    render, so every caller in one request receives the same memo. Outside a
 *    render -- in this module's unit tests -- it is a pass-through that returns
 *    a FRESH memo per call, which is why `browse.test.ts` holds one and reads
 *    it twice rather than calling this twice and expecting a hit.
 *  - `createCatalogMemo` supplies single-flight and the COUNTERS. It caches the
 *    promise rather than the value, so two surfaces rendering concurrently in
 *    one request -- both arriving before either answer exists -- share one read
 *    instead of missing twice.
 *
 * NO TTL AND NO KEY, deliberately. The port has no change feed, no etag and no
 * generation counter, so a TTL would be a guess about staleness written as a
 * number; on a local-first installation whose catalog changes when the operator
 * imports something, serving a stale list is a worse failure than reading
 * twice. A scope the caller owns has no staleness window at all -- the next
 * request reads again. `lib/catalog.ts` records the same reasoning where the
 * primitive is defined.
 *
 * THE CLASSIFICATION STILL HAPPENS AT CALL TIME, never at module scope.
 * `NonDeploymentEnvironment.classify()` is inside the factory, so it runs on
 * the first read of each request rather than when this module was first loaded
 * -- which in a cold start is not necessarily the request's environment.
 * ---------------------------------------------------------------------- */

const browseItemsMemo = cache(
  (): CatalogMemo<readonly CatalogItem[] | null> => createCatalogMemo(() => getBrowseItems())
);

/**
 * The request's shared catalog read.
 *
 * Exported so the de-duplication can be MEASURED rather than assumed -- this
 * wave's instruction on caching -- and so a future surface on this route reaches
 * the same memo instead of opening a second read path. `stats()` reports
 * `sourceReads` and `reuses`; `browse.test.ts` asserts on both.
 */
export function browseItemsForRequest(): CatalogMemo<readonly CatalogItem[] | null> {
  return browseItemsMemo();
}

/** The source the browse page uses when nothing is injected. */
export const defaultBrowseSource: BrowseSource = () => browseItemsForRequest().read();

/**
 * Loader used by the browse route. A source that throws -- a network fault, a
 * timeout, an adapter fault -- becomes a handled error state rather than a
 * crash mid-render, and a missing configuration stays distinguishable from it.
 */
export async function loadBrowseCatalog(
  filters: BrowseFilters,
  source: BrowseSource = defaultBrowseSource,
  now: Date = new Date()
): Promise<BrowseLoadResult> {
  let items: readonly CatalogItem[] | null;
  try {
    items = await source();
  } catch {
    return { status: "error", reason: "browse_source_unavailable" };
  }

  /*
   * Checked before anything is counted, because there is nothing to count. A
   * source with no provider to ask is a configuration state; reporting it as an
   * empty catalog would be a statement about the catalog made by a process with
   * no catalog to look at.
   */
  if (items === null) {
    return { status: "error", reason: CATALOG_SOURCE_NOT_CONFIGURED_REASON };
  }

  const generatedAt = now.toISOString();
  const response = browseCatalog(items, filters, generatedAt);
  if (response.items.length > 0) return { status: "ok", response };

  /*
   * THE CAUSE COMES FROM THE CATALOG, NOT FROM THE LENGTH OF THE FILTERED
   * ARRAY. `genres` is empty exactly when nothing survived the rights gate and
   * the kind filter, so there is nothing any genre could have matched; a
   * non-empty facet list with no items means the viewer's combination matched
   * nothing and a different one would work. Inferring this from
   * `items.length === 0` alone is impossible -- both states produce it.
   *
   * A kind filter that matched nothing lands on `filters_match_nothing` when
   * some other kind has titles, and on `catalog_has_no_browsable_titles` when
   * none does, which is the honest reading of each.
   */
  const cause: BrowseEmptyCause =
    response.genres.length === 0 && filters.kind === "all"
      ? "catalog_has_no_browsable_titles"
      : "filters_match_nothing";

  return { status: "empty", filters, genres: response.genres, cause, generatedAt };
}

/**
 * The one sentence that describes the state of this page.
 *
 * Derived here rather than assembled in JSX so every state has one and so it is
 * unit-tested. It is rendered as a VISIBLE summary and NOT into a live region,
 * which is the one place this surface deliberately differs from search: search
 * types continuously and needs a client reconciler to announce an in-flight
 * query, whereas a browse filter is a form submission and a full navigation --
 * the new page announces itself, and a live region on a server-rendered page
 * whose content is present at insertion is frequently not announced anyway.
 */
export function describeBrowseState(result: BrowseLoadResult): string {
  if (result.status === "error") {
    return "The catalog is currently unavailable.";
  }
  if (result.status === "empty") {
    return result.cause === "catalog_has_no_browsable_titles"
      ? "There are no titles in the catalog yet."
      : "No titles match these filters.";
  }
  const count = result.response.items.length;
  const { kind, genre, sort } = result.response.filters;
  /*
   * The noun follows the KIND FILTER, so a narrowed page says what it is
   * showing. "series" has no distinct plural, which is why this is a table
   * keyed by the filter rather than a suffix rule -- the rule would have
   * produced "2 seriess" and the fix for that is not a special case bolted
   * onto a concatenation.
   */
  const noun =
    kind === "all"
      ? count === 1
        ? "title"
        : "titles"
      : kind === "movie"
        ? count === 1
          ? "film"
          : "films"
        : "series";
  const genrePhrase = genre === null ? "" : ` in ${genre}`;
  /*
   * THE ORDER IS NAMED ONLY WHEN IT IS NOT THE DEFAULT, and that asymmetry is
   * the point rather than an inconsistency. The summary is what a screen-reader
   * user and a scanning reader get instead of looking at the sort control, so it
   * has to state anything they did not already assume -- and "newest first" is
   * what this surface has always been, named in the control and unchanged by any
   * link they followed. Printing it on every page would add a clause to every
   * sentence to tell the reader nothing, which is how a summary stops being
   * read. Any other order was chosen, and a chosen order that the page does not
   * confirm is a control the reader cannot verify worked.
   */
  const sortPhrase = sort === DEFAULT_BROWSE_SORT ? "" : `, ${BROWSE_SORT_SUMMARY[sort]}`;
  return `${count} ${noun}${genrePhrase}${sortPhrase}.`;
}
