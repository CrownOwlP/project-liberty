import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import {
  SEARCH_MATCH_RANK,
  normalizeSearchQuery,
  searchResponseSchema,
  type SearchMatchKind,
  type SearchResponse,
  type SearchResult
} from "@liberty/contracts/domains/search";
import { isSurfaceable } from "../../lib/catalog";
import { demoCatalog } from "../../lib/demo-catalog";

/**
 * Explicit result union, the same shape PL-0101 uses for the catalog.
 *
 * Search has one more state than the home rails do: `idle` is "no query has
 * been asked yet", which is not the same page as "your query matched nothing".
 * Collapsing those two is the single most common way a search UI ships broken —
 * the user is told there are no results for a search they never ran. `error`
 * stays separate from both for the same reason it does on home.
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

/**
 * Case folding for matching. `toLowerCase` and NOT `toLocaleLowerCase`: the
 * locale-aware variant maps "I" differently under a Turkish locale, so the same
 * query against the same catalog would match differently depending on the
 * environment the server happens to run in.
 */
function fold(value: string): string {
  return value.toLowerCase();
}

/**
 * Which field matched, or `null` for no match.
 *
 * The query is user input and it stays DATA on this path. Matching is
 * `startsWith`/`includes` against fields already in memory — never a `RegExp`
 * compiled from the query, because a user-authored pattern is a ReDoS surface
 * and a metacharacter would silently change what the search means. There is no
 * database, no provider call, and no URL built from the query here; the only
 * places it travels are the `q` search param (percent-encoded by
 * `buildSearchHref` with `encodeURIComponent`, after `normalizeSearchQuery` has
 * made it well-formed UTF-16 — see the note there on why the encoder was
 * changed from `URLSearchParams` and what that cost) and React text nodes
 * (escaped on render). Nothing on this path reaches `dangerouslySetInnerHTML`.
 */
function classifyMatch(item: CatalogItem, foldedQuery: string): SearchMatchKind | null {
  const title = fold(item.title);
  if (title === foldedQuery) return "title-exact";
  if (title.startsWith(foldedQuery)) return "title-prefix";
  if (title.includes(foldedQuery)) return "title-contains";
  if (fold(item.genre).includes(foldedQuery)) return "genre-contains";
  return null;
}

/**
 * Pure and deterministic: same items and same query in, same results out. No
 * clock, no randomness, and no dependence on the order the catalog arrived in.
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

  const folded = fold(normalized);
  const results: SearchResult[] = [];

  for (const item of items) {
    // Rights gate first, before anything else can decide to keep the item.
    if (!isSurfaceable(item)) continue;
    if (!SEARCHABLE_KINDS.includes(item.kind)) continue;

    const matchedOn = classifyMatch(item, folded);
    if (matchedOn === null) continue;

    results.push({ item, matchedOn });
  }

  /*
   * Total order, so the same catalog and query always produce the same list.
   *
   * Match rank, then newest, then title, then id. Titles are compared by CODE
   * POINT rather than with `localeCompare`, which without an explicit locale
   * uses the host's collation — so two machines can order identical results
   * differently. That is the same defect already removed from candidate ranking
   * in `@liberty/media-engine`. (`buildHomeCatalog` still calls `localeCompare`;
   * that file is outside this task's allowed paths and the cleanup is tracked
   * against it, not silently changed from here.)
   *
   * `id` is unique within a catalog, so the last comparison always decides and
   * the sort can never fall back on input order.
   */
  results.sort((a, b) => {
    const byMatch = SEARCH_MATCH_RANK[a.matchedOn] - SEARCH_MATCH_RANK[b.matchedOn];
    if (byMatch !== 0) return byMatch;
    if (a.item.releaseYear !== b.item.releaseYear) return b.item.releaseYear - a.item.releaseYear;
    if (a.item.title !== b.item.title) return a.item.title < b.item.title ? -1 : 1;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });

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
 * Server-side search source. Mirrors `getHomeCatalog`: the page reads through
 * this rather than making an HTTP call back into itself, so there is nothing to
 * drift when `GET /api/v1/search` is added and starts serving the same shape.
 */
export function getSearchResults(
  query: string,
  now: Date = new Date(),
  items: readonly CatalogItem[] = demoCatalog
): SearchResponse {
  return searchCatalog(items, query, now.toISOString());
}

/**
 * Where search results come from. Injectable so the loader's failure paths are
 * testable, and so the provider-backed index can replace the fixtures without
 * the page changing.
 */
export type SearchSource = (query: string) => SearchResponse | Promise<SearchResponse>;

/**
 * Loader used by the search route. Validates against the published contract, so
 * a malformed fixture or provider payload becomes a handled error state instead
 * of a crash mid-render, and a source that throws is converted rather than
 * propagated.
 */
export async function loadSearchResults(
  rawQuery: string,
  source: SearchSource = (query) => getSearchResults(query)
): Promise<SearchLoadResult> {
  // Normalised here as well as in the source: this decides whether we run a
  // search at all, and "   " must reach that decision as an empty query.
  const query = normalizeSearchQuery(rawQuery);
  if (query === "") {
    return { status: "idle" };
  }

  try {
    const parsed = searchResponseSchema.safeParse(await source(query));

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
