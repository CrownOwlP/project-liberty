import { z } from "zod";
import { catalogItemSchema } from "./catalog";

/* -------------------------------------------------------------------------
 * Search (PL-0102)
 *
 * Shapes for the planned `GET /api/v1/search?q=` route. That route does not
 * exist yet, so the search surface reads through an in-process source that
 * returns exactly this shape. Publishing the contract before the transport is
 * the point: when the route lands, the UI keeps parsing the same payload and
 * the two sides cannot quietly disagree about what a search is.
 *
 * This is the one domain-to-domain edge in the package, and it is a real
 * dependency rather than a convenience: a search result IS a catalog item plus
 * the reason it matched. Lifting `CatalogItem` into `shared/` to avoid the edge
 * would move a whole domain contract into the leaf layer and make every
 * catalog change a shared-vocabulary change, which is the opposite of what the
 * split is for.
 * ---------------------------------------------------------------------- */

/**
 * Hard bound on `q`.
 *
 * The query is user input that becomes a URL, and an unbounded one is both an
 * unbounded amount of matching work per request and a URL long enough to be
 * truncated or rejected by something in the middle of the stack — which fails
 * as a mysteriously different result set rather than as an error. 128 is far
 * past any real title.
 */
export const SEARCH_QUERY_MAX_LENGTH = 128;

/**
 * The single definition of what a query string MEANS, used by the client that
 * writes `q` into the URL and by the server that reads it back.
 *
 * If the two sides normalise differently, a link a user shares resolves to a
 * different result set than the one they were looking at, which is the whole
 * value of an addressable query gone. Whitespace-only differences are not
 * query differences, so `?q=the+fall` and `?q=the++fall` collapse to the same
 * search. Case is preserved because the query is echoed back to the user;
 * matching folds case separately.
 *
 * Deliberately total: an over-long query is truncated rather than rejected. A
 * validation error on a search box is a worse answer than searching for the
 * first 128 characters, and the cap has to hold on a hand-written URL too.
 */
export function normalizeSearchQuery(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  // The cap can land on a word boundary and leave a dangling separator, so trim
  // again — otherwise a truncated query is not idempotent under normalisation
  // and re-parsing our own response would change it.
  return collapsed.slice(0, SEARCH_QUERY_MAX_LENGTH).trim();
}

export const searchQuerySchema = z.string().transform(normalizeSearchQuery);

/**
 * Why an item is in the result list.
 *
 * Declaration order is precedence order, and `SEARCH_MATCH_RANK` below makes
 * that machine-readable instead of leaving it implied by a sort function.
 */
export const searchMatchKindSchema = z.enum([
  "title-exact",
  "title-prefix",
  "title-contains",
  "genre-contains"
]);
export type SearchMatchKind = z.infer<typeof searchMatchKindSchema>;

/**
 * Match precedence, lowest value first.
 *
 * Lives in the contract rather than in the UI because the eventual
 * `/api/v1/search` route has to produce the same order the in-process source
 * produces today. A result list that reorders when the data source moves behind
 * HTTP is indistinguishable from a ranking bug, and nobody would think to look
 * at the transport.
 */
export const SEARCH_MATCH_RANK: Readonly<Record<SearchMatchKind, number>> = {
  "title-exact": 0,
  "title-prefix": 1,
  "title-contains": 2,
  "genre-contains": 3
};

/**
 * A search result is DISCOVERY metadata and nothing else.
 *
 * It carries a `CatalogItem`, which has no stream, URL, or provider field, and
 * never a playback candidate. Rights are established before a candidate is
 * produced at all (docs/CONTENT_RIGHTS.md), so a surface that cannot express a
 * stream cannot imply one is available — a result being visible says the title
 * exists, not that it is playable. `matchedOn` travels with the item for the
 * same reason a playback decision carries a reason: an unexplained ranking is
 * unfixable from a bug report.
 *
 * `catalogItemSchema` is referenced EAGERLY. It used to be wrapped in `z.lazy`
 * because this module was reached through `index.ts`, which re-exported it and
 * therefore had not yet initialised `catalogItemSchema` when this file's body
 * ran. Importing `./catalog` directly removes the cycle, so the deferral has
 * nothing left to defer: `z.lazy` here would only hide the day a genuine cycle
 * comes back.
 */
export const searchResultSchema = z.object({
  item: catalogItemSchema,
  matchedOn: searchMatchKindSchema
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * Response body of the planned `GET /api/v1/search?q=`.
 *
 * `query` is the normalised query the results were computed for, echoed back so
 * a client can tell a response apart from a stale one it no longer wants, and
 * so "no results for X" quotes what was actually searched rather than what is
 * currently in the input box.
 *
 * `results` may be `[]`. That is a valid response meaning "nothing matched",
 * which is a different outcome from a failure — a failure is never an empty
 * body. Callers that collapse the two produce the blank page that looks the
 * same whether the catalog has nothing or the backend is down.
 */
export const searchResponseSchema = z.object({
  query: searchQuerySchema,
  results: z.array(searchResultSchema),
  generatedAt: z.string().datetime()
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
