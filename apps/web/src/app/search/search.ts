import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import {
  normalizeSearchQuery,
  searchResponseSchema,
  type SearchResponse,
  type SearchResult
} from "@liberty/contracts/domains/search";
import {
  compareByRelevance,
  foldSearchText,
  scoreCatalogItem,
  type SearchRelevance
} from "./relevance";
import { cache } from "react";
import { createCatalogMemo, isSurfaceable, type CatalogMemo } from "../../lib/catalog";
import { selectDeclaredItems } from "../../lib/catalog-source";
import { resolveCatalogMetadataSource } from "../../lib/catalog-source-registry";
import { NonDeploymentEnvironment } from "../api/deployment-environment";

/**
 * Explicit result union, the same shape PL-0101 uses for the catalog.
 *
 * Search has one more state than the home rails do: `idle` is "no query has
 * been asked yet", which is not the same page as "your query matched nothing".
 * Collapsing those two is the single most common way a search UI ships broken —
 * the user is told there are no results for a search they never ran. `error`
 * stays separate from both for the same reason it does on home.
 *
 * There is now a third absence behind `error`, and it is neither of the other
 * two: a process with no catalog metadata source has nothing to search at all.
 * It is reported as `catalog_source_not_configured` rather than as `empty`,
 * because "no titles match" is a statement about the catalog and this is a
 * statement about the deployment. See `getSearchResults`.
 */
export type SearchLoadResult =
  | { status: "idle" }
  | { status: "ok"; response: SearchResponse }
  | { status: "empty"; query: string; generatedAt: string }
  | { status: "error"; reason: string };

/**
 * Kinds a search result may surface.
 *
 * `episode` is deliberately absent. Nothing links to a standalone episode until
 * PL-0103 lands the title/episode routes, so surfacing one now produces a
 * result the user cannot open — episodes stay reachable through their series,
 * which is the rule the home rails already apply.
 */
const SEARCHABLE_KINDS: ReadonlyArray<CatalogItem["kind"]> = ["movie", "series"];

/* -------------------------------------------------------------------------
 * RANKING MOVED TO `./relevance.ts` (Wave 132, worker C).
 *
 * THE DEFECT CLASS REMOVED: ordinal matching passed off as ranking.
 *
 * This file used to carry a `classifyMatch` that produced one of four
 * `SearchMatchKind` buckets from `===`, `startsWith` and `includes`, and then
 * ordered the list by `SEARCH_MATCH_RANK`. The buckets were not wrong; they
 * were too coarse to be a ranking. Everything that was not an exact or
 * leading-edge hit collapsed into `title-contains`, so for `q=fall` a title
 * NAMED "The Fall of Aurora" and a title that merely contains those letters
 * ("Pitfalls") were declared equally relevant -- and the tie then fell to
 * release year, which means the better answer lost to a worse but newer one
 * with nothing on the page explaining why.
 *
 * `relevance.ts` adds the word-boundary tier that was missing between "starts
 * with" and "contains somewhere", and states field precedence as a weight
 * rather than as the order of two `if` statements. It is a separate module and
 * not an inlined rewrite for two reasons: it is pure and belongs under unit
 * test on its own (`relevance.test.ts`, 24 cases including ties, the empty
 * query, surrogate pairs and combining marks), and `components/search/
 * search-results.tsx` needs the SAME function to label a result, because the
 * finer tier cannot travel inside a `SearchResult` -- see below.
 *
 * WHAT DID NOT MOVE, deliberately: the rights gate, the kind allowlist, and
 * their order. `isSurfaceable` still runs here and still runs FIRST, ahead of
 * any scoring, so a record this catalog has declined to surface cannot reach a
 * ranking at all. Moving the gate into the scorer would have given it a second
 * home and a second place to be weakened.
 * ---------------------------------------------------------------------- */

/**
 * Pure and deterministic: same items and same query in, same results out. No
 * clock, no randomness, and no dependence on the order the catalog arrived in.
 *
 * THE RESPONSE CARRIES `matchedOn` AND NOT THE SCORE, and that is a contract
 * boundary rather than an omission. `searchResponseSchema` validates everything
 * this function produces and `searchResultSchema` is a two-field object, so a
 * `relevance` field added here would be STRIPPED by the parse in
 * `loadSearchResults` -- a field that silently vanishes at a validation
 * boundary is worse than no field. `packages/contracts` is read-only to this
 * change, so the surface recomputes the tier from the response's own normalised
 * `query` where it needs it; `scoreCatalogItem` is pure and memoises its folds,
 * so recomputing is cheaper than it reads and cannot disagree with this sort.
 */
export function searchCatalog(
  items: readonly CatalogItem[],
  query: string,
  generatedAt: string
): SearchResponse {
  const normalized = normalizeSearchQuery(query);

  // An empty query is not a match-everything query. Returning the whole catalog
  // here would make the idle state look like a result set.
  if (normalized === "") {
    return { query: normalized, results: [], generatedAt };
  }

  const folded = foldSearchText(normalized);
  const scored: { item: CatalogItem; relevance: SearchRelevance }[] = [];

  for (const item of items) {
    // Rights gate first, before anything else can decide to keep the item.
    if (!isSurfaceable(item)) continue;
    if (!SEARCHABLE_KINDS.includes(item.kind)) continue;

    const relevance = scoreCatalogItem(item, folded);
    if (relevance === null) continue;

    scored.push({ item, relevance });
  }

  /*
   * Total order, so the same catalog and query always produce the same list.
   *
   * Relevance, then newest, then title, then id -- `compareByRelevance` states
   * the whole rule and `relevance.test.ts` proves it is total (it never returns
   * 0 for two distinct items) and rotation-invariant. Titles are compared by
   * CODE POINT and never with `localeCompare`, which without an explicit locale
   * uses the host's collation, so two machines would order identical results
   * differently. (`buildHomeCatalog` still calls `localeCompare`; that file is
   * outside this task's write surface and the cleanup is reported against it
   * rather than silently changed from here.)
   */
  scored.sort(compareByRelevance);

  const results: SearchResult[] = scored.map(({ item, relevance }) => ({
    item,
    matchedOn: relevance.matchedOn
  }));

  return { query: normalized, results, generatedAt };
}

/**
 * `q` as it actually arrives from a URL.
 *
 * `?q=a&q=b` parses to an array. That is either a client bug or someone poking
 * at the surface, and joining the values would let a crafted link build a query
 * the user never typed; the first value wins, deterministically. Anything
 * unusable normalises to an empty query rather than throwing — a malformed `q`
 * is an empty search, not a 500.
 */
export function readSearchQueryParam(value: string | string[] | undefined): string {
  if (typeof value === "string") return normalizeSearchQuery(value);
  if (Array.isArray(value)) return normalizeSearchQuery(value[0] ?? "");
  return "";
}

/**
 * The reason a surface reports when this process has no catalog metadata source.
 *
 * The same string `loadHomeCatalog` returns in `lib/catalog.ts`, restated here
 * because that module publishes no constant for it — `CatalogLoadResult.reason`
 * is typed `string`, so there is nothing to import. A shared reason vocabulary
 * belongs beside the port in `src/lib/`; that directory is outside this change's
 * allowed paths, so this is the one spelling on the search surface and the
 * duplication is recorded rather than hidden.
 */
export const CATALOG_SOURCE_NOT_CONFIGURED_REASON = "catalog_source_not_configured";

/**
 * Server-side search source: the configured catalog, filtered in this process.
 *
 * READS THE CATALOG METADATA PORT RATHER THAN THE FIXTURE ARRAY. It used to
 * default `items` to `demoCatalog`, which meant a hosted deployment served six
 * invented titles as search results while the home rails — already routed
 * through the port — refused. `docs/CATALOG_SOURCE.md` names that pair as
 * incoherent, and this is the edit it names.
 *
 * `null` MEANS NO METADATA SOURCE IS CONFIGURED, and it is the one thing a
 * `SearchResponse` cannot say. Search already keeps "no query was asked" apart
 * from "your query matched nothing"; this is a third absence and it is neither
 * of them. A deployment with no metadata provider has an operator remedy, and
 * telling the reader that nothing matched would be false — nothing was searched.
 * It is the same `null` convention `CatalogSource` uses in `lib/catalog.ts`, and
 * `loadSearchResults` maps it to the same reason code.
 *
 * ASYNCHRONOUS, because the port is: `listRecords` may answer with a promise and
 * a real provider does I/O. The fixture source answers immediately; that is a
 * fact about the fixtures, not a shape the port guarantees.
 *
 * `selectDeclaredItems` runs before `searchCatalog`, so a record whose rights
 * basis the source did not declare is never searchable — the same order the home
 * rails apply, and ahead of the `isSurfaceable` allowlist inside `searchCatalog`.
 *
 * PROVIDER-SIDE SEARCH DOES NOT EXIST. The port has no search capability, so the
 * whole record list is fetched and filtered here. That is fine for six fixtures
 * and is not a shape a catalog of real size can use; `docs/CATALOG_SOURCE.md`
 * records it as an open design question rather than an oversight.
 *
 * `now` is a parameter so a test can state the time it means instead of the
 * clock's.
 *
 * `environment` IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME. It is the
 * third parameter so a test can reach the deployment refusal without mutating
 * `process.env` and racing every other suite in the same worker, and it is
 * forwarded to the registry unchanged. It used to be a `nodeEnv` string, which
 * meant a caller could name the environment it wished to be treated as; the mint
 * takes no argument now, so the only non-`null` value anything can pass is one
 * it received from a classification of the running process. A test that wants
 * the refusal passes `null`.
 *
 * It is NOT a request input — nothing on the search page passes one — and the
 * default classifies the process at CALL time, never at module scope.
 */
export async function getSearchResults(
  query: string,
  now: Date = new Date(),
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): Promise<SearchResponse | null> {
  const items = await readSearchableItems(environment);
  if (items === null) return null;
  return searchCatalog(items, query, now.toISOString());
}

/**
 * The port read, extracted from `getSearchResults` (Wave 132, worker C).
 *
 * SEPARATED BECAUSE THE READ AND THE SEARCH DE-DUPLICATE DIFFERENTLY. Two
 * queries in one request are two different searches and must each be computed;
 * they are the SAME catalog read, and `selectDeclaredItems` validates and
 * rebuilds every record on each one. Memoising `getSearchResults` whole would
 * have keyed a cache on the query and cached the wrong thing -- the expensive,
 * query-independent half is here.
 *
 * `null` still means "no metadata source is configured", carried through
 * unchanged; the reasoning for why that is not an empty result set is on
 * `getSearchResults` above and is not restated.
 */
async function readSearchableItems(
  environment: NonDeploymentEnvironment | null
): Promise<readonly CatalogItem[] | null> {
  const resolution = resolveCatalogMetadataSource(environment);
  if (resolution.status === "not-configured") return null;
  const records = await resolution.source.listRecords();
  return selectDeclaredItems(records).items;
}

/* -------------------------------------------------------------------------
 * ONE METADATA READ PER REQUEST (Wave 132, worker C).
 *
 * The same guarantee, the same two mechanisms and the same reasoning as
 * `app/browse/browse.ts` installs on the browse routes, and the reasoning is
 * written out there rather than repeated here. In short: React's `cache`
 * supplies the request SCOPE (and is a pass-through outside a render, so unit
 * tests hold a memo rather than expecting two calls to hit);
 * `createCatalogMemo` supplies single-flight over the PROMISE plus the counters
 * that let the de-duplication be measured; and there is deliberately no TTL,
 * because the port publishes nothing that could tell one when to expire.
 *
 * `app/title/[titleId]/page.tsx` is the precedent and states the failure this
 * prevents: two reads for one request whose answers "are not required to
 * agree". On this route the second read arrives the day `/search` grows a
 * `generateMetadata` -- which is the point of installing it before then.
 * ---------------------------------------------------------------------- */

const searchItemsMemo = cache(
  (): CatalogMemo<readonly CatalogItem[] | null> =>
    createCatalogMemo(() => readSearchableItems(NonDeploymentEnvironment.classify()))
);

/**
 * The request's shared catalog read, exported so it can be MEASURED and so a
 * second surface on this route reaches the same memo instead of opening a
 * second read path. `stats()` reports `sourceReads` and `reuses`.
 */
export function searchItemsForRequest(): CatalogMemo<readonly CatalogItem[] | null> {
  return searchItemsMemo();
}

/**
 * Where search results come from. Injectable so the loader's failure paths are
 * testable, and so the provider-backed index can replace the fixtures without
 * the page changing.
 *
 * `null` carries the "no source is configured" state through to the loader. A
 * source that cannot answer for any other reason — a network fault, a timeout,
 * an adapter throwing — throws, and the loader converts that separately, so a
 * missing configuration and a failing provider stay distinguishable.
 */
export type SearchSource = (
  query: string
) => SearchResponse | null | Promise<SearchResponse | null>;

/**
 * The source the search page uses when nothing is injected.
 *
 * ROUTED THROUGH THE REQUEST MEMO rather than straight at `getSearchResults`,
 * so the catalog is read once per request however many times this surface asks.
 * The clock is still read per call -- `generatedAt` describes when the RESPONSE
 * was computed, and sharing one timestamp across a request would make two
 * searches claim to have been computed at the same instant.
 */
export const defaultSearchSource: SearchSource = async (query) => {
  const items = await searchItemsForRequest().read();
  if (items === null) return null;
  return searchCatalog(items, query, new Date().toISOString());
};

/**
 * Loader used by the search route. Validates against the published contract, so
 * a malformed fixture or provider payload becomes a handled error state instead
 * of a crash mid-render, and a source that throws is converted rather than
 * propagated.
 */
export async function loadSearchResults(
  rawQuery: string,
  source: SearchSource = defaultSearchSource
): Promise<SearchLoadResult> {
  /*
   * Normalised here as well as in the source: this decides whether we run a
   * search at all, and "   " must reach that decision as an empty query.
   *
   * `idle` IS DECIDED BEFORE THE SOURCE IS CONSULTED, on a deployment as much as
   * anywhere else, and that is deliberate rather than an oversight. A search
   * that was never run cannot have been refused, and this branch makes no claim
   * about the catalog — it says only that no query was asked. So `/search` with
   * no `q` renders the idle panel on a deployment too; the refusal appears as
   * soon as there is a query to refuse.
   */
  const query = normalizeSearchQuery(rawQuery);
  if (query === "") {
    return { status: "idle" };
  }

  try {
    const payload = await source(query);

    /*
     * Checked FIRST, ahead of both the schema and the emptiness test.
     *
     * Ahead of the schema because there is nothing to validate: a source with no
     * provider to ask is a configuration state, and parsing `null` would report
     * it as a malformed payload to whoever is reading the panel this renders
     * into.
     *
     * Ahead of emptiness because a refused source and an empty result set are
     * DIFFERENT FACTS. `empty` renders "No titles match “…”" as a heading and
     * speaks it into the live region; on a deployment with no metadata source
     * that sentence is false, because no catalog was consulted. This is the same
     * distinction `idle` already draws at the top of this function, one step
     * further along.
     */
    if (payload === null) {
      return { status: "error", reason: CATALOG_SOURCE_NOT_CONFIGURED_REASON };
    }

    const parsed = searchResponseSchema.safeParse(payload);

    if (!parsed.success) {
      return { status: "error", reason: "search_response_failed_validation" };
    }

    /*
     * THE RESPONSE HAS TO SAY WHICH QUERY IT IS FOR, and be believed only after
     * it has been checked.
     *
     * `searchResponseSchema` proves the payload is shaped like a search
     * response. It cannot prove it is THIS search's response — `query` is a
     * well-formed string either way. The contract publishes that field for
     * exactly this comparison ("echoed back so a client can tell a response
     * apart from a stale one it no longer wants"), and until this line its only
     * consumer took it on trust and then RENDERED it as fact: the empty-state
     * heading and the live-region sentence both quote `parsed.data.query`, so a
     * response computed for the wrong query produced a page that stated, in the
     * one place a user looks and the one place a screen reader speaks, that
     * nothing matched a search nobody ran.
     *
     * Nothing else on this surface can catch it. The client reconciler in
     * `components/search/search-sync.ts` compares an arriving render against the
     * URL and against its own requests; the response BODY never reaches it. So
     * this is the only boundary where the two can be compared at all.
     *
     * Both sides are normalised — `query` by `normalizeSearchQuery` above,
     * `parsed.data.query` by `searchQuerySchema`, which applies the same
     * function — and that function is idempotent, so this compares meanings and
     * not spellings: an echo of "  the   fall " is the same search as "the
     * fall" and passes.
     *
     * UNREACHABLE TODAY, and written anyway. `getSearchResults` computes the
     * response in this process from the query it was handed, so it cannot
     * disagree with itself. The contract exists ahead of `GET /api/v1/search`
     * on purpose; a check that only lands when the transport does is a check
     * nobody remembers to add, and the failure it prevents — a cached, retried,
     * coalesced or misrouted response — is one that only becomes possible on the
     * day the transport arrives.
     *
     * It is an `error` and not a silent retry: this function has no idea whether
     * asking again would produce anything different, and a surface that quietly
     * re-requests on every mismatch is how a coalescing bug becomes a load
     * problem. The reason code is distinct from the schema failure so the two
     * are told apart in the panel that renders it.
     */
    if (parsed.data.query !== query) {
      return { status: "error", reason: "search_response_query_mismatch" };
    }

    if (parsed.data.results.length === 0) {
      return { status: "empty", query: parsed.data.query, generatedAt: parsed.data.generatedAt };
    }
    return { status: "ok", response: parsed.data };
  } catch {
    return { status: "error", reason: "search_source_unavailable" };
  }
}

/**
 * The one sentence a screen reader is told after every state change.
 *
 * Derived here rather than assembled in JSX so the announcement is unit-tested
 * and so every state — including `idle` and `error` — actually has one. A live
 * region that only speaks on success leaves the two states a user most needs
 * explained completely silent.
 */
export function describeSearchState(result: SearchLoadResult): string {
  if (result.status === "idle") {
    return "Type to search the catalog.";
  }
  if (result.status === "error") {
    return "Search is currently unavailable.";
  }
  if (result.status === "empty") {
    return `No titles match “${result.query}”.`;
  }

  const count = result.response.results.length;
  const subject = count === 1 ? "title matches" : "titles match";
  return `${count} ${subject} “${result.response.query}”.`;
}
