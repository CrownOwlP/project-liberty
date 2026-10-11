import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { isSurfaceable } from "../../lib/catalog";
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

export interface BrowseFilters {
  readonly kind: BrowseKindFilter;
  /** The exact genre to show, or `null` for every genre. */
  readonly genre: string | null;
}

export const UNFILTERED: BrowseFilters = { kind: "all", genre: null };

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
   * Newest first, then title, then id -- the same shape as search's secondary
   * ordering, by code point for the reason above. `id` is unique within a
   * catalog, so the last comparison always decides.
   */
  const ordered = [...selected].sort((a, b) => {
    if (a.releaseYear !== b.releaseYear) return b.releaseYear - a.releaseYear;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

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

/** Both filters, read from one search-params object. */
export function readBrowseFilters(
  params: Record<string, string | string[] | undefined>
): BrowseFilters {
  return { kind: readBrowseKindParam(params.kind), genre: readBrowseGenreParam(params.genre) };
}

/**
 * The address of a filtered browse page.
 *
 * `encodeURIComponent` on the genre rather than `URLSearchParams`, which is the
 * encoder `buildSearchHref` settled on and for the same reason: the default
 * values are omitted entirely, so the unfiltered page is `/browse` and not
 * `/browse?kind=all&genre=`.
 */
export function buildBrowseHref(filters: BrowseFilters): string {
  const parts: string[] = [];
  if (filters.kind !== "all") parts.push(`kind=${encodeURIComponent(filters.kind)}`);
  if (filters.genre !== null) parts.push(`genre=${encodeURIComponent(filters.genre)}`);
  return parts.length === 0 ? "/browse" : `/browse?${parts.join("&")}`;
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

/** The source the browse page uses when nothing is injected. */
export const defaultBrowseSource: BrowseSource = () => getBrowseItems();

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
  const { kind, genre } = result.response.filters;
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
  return `${count} ${noun}${genrePhrase}.`;
}
