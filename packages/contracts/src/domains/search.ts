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
 * Hard bound on `q`, counted in UTF-16 CODE UNITS.
 *
 * The query is user input that becomes a URL, and an unbounded one is both an
 * unbounded amount of matching work per request and a URL long enough to be
 * truncated or rejected by something in the middle of the stack — which fails
 * as a mysteriously different result set rather than as an error. 128 is far
 * past any real title.
 *
 * Code units rather than code points, deliberately. `<input maxlength>` is
 * defined over the value's code-unit length, and the search field mirrors this
 * constant into that attribute; a cap denominated any other way would let the
 * browser accept a query the contract then silently truncates, so the field's
 * bound would stop being a bound. Counting code points instead would also
 * quietly double the byte budget this constant exists to state, because 128
 * astral characters are 256 code units and up to 512 bytes of UTF-8.
 */
export const SEARCH_QUERY_MAX_LENGTH = 128;

/**
 * A surrogate PAIR, or a single surrogate code unit that is not part of one.
 *
 * The alternation is ordered and the order is the whole trick: a well-formed
 * pair matches the first branch and is consumed by it, so anything the second
 * branch matches is unpaired by construction. Written this way rather than with
 * the shorter lookbehind spelling (`(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]`)
 * because a lookbehind is a SyntaxError at PARSE time on Safari before 16.4 —
 * this module is imported by the browser bundle, so an unsupported regex here
 * would not degrade a search, it would fail to load the page. `toWellFormed()`
 * was rejected for the same class of reason: it is ES2024, the workspace
 * compiles against `lib: ES2022`, and a contract should not depend on a runtime
 * capability it does not declare.
 */
const SURROGATE_RUN = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * U+FFFD, and not deletion.
 *
 * A lone surrogate has no UTF-8 encoding, so every path that carries this query
 * through a URL already substitutes U+FFFD for it: the browser does it when it
 * submits the no-JavaScript form, and the URL parser does it when the server
 * reads `q` back. Deleting the code unit instead would make the client path
 * produce a DIFFERENT query from the no-JavaScript path for the same typed
 * text, which is exactly the client/server disagreement this function exists to
 * prevent.
 *
 * Constructed from its code point rather than pasted in as a glyph, so the
 * value does not depend on this file's encoding surviving every editor, patch
 * tool and terminal it passes through — a replacement character that has itself
 * been mojibaked is a particularly unhelpful thing to find in a URL.
 */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * Cut at `limit` code units, or at the code-point boundary just below it.
 *
 * `slice` alone cuts between the halves of a surrogate pair, and a string
 * ending in a lone high surrogate is not merely ugly: `encodeURIComponent`
 * THROWS a `URIError` on it. That made a 129-code-unit query whose 128th unit
 * was a high surrogate — reachable from a crafted or shared link, since the
 * field's `maxlength` constrains typing only — into a grenade under the one
 * function that builds this surface's URL.
 *
 * Backing up one unit drops the whole character rather than half of it.
 * Substituting U+FFFD for the orphaned half was rejected: truncation must not
 * invent a character nobody typed, and the result would stop being a prefix of
 * the input, so "the first 128 characters were searched" would no longer be a
 * true description of what happened.
 *
 * The input is already well-formed when this runs, so a high surrogate at
 * `limit - 1` is always followed by its low half and backing up always removes
 * exactly one character.
 */
function truncateAtCodePointBoundary(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const boundary = value.charCodeAt(limit - 1);
  const splitsAPair = boundary >= 0xd800 && boundary <= 0xdbff;
  return value.slice(0, splitsAPair ? limit - 1 : limit);
}

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
 * Deliberately total, and that claim is now load-bearing rather than
 * decorative. A total function may not return a value that makes its OWN
 * consumers throw, and `buildSearchHref` percent-encodes this result — so the
 * output is guaranteed well-formed UTF-16 in two separate ways: unpaired
 * surrogates anywhere in the input are replaced, and the length cap never cuts
 * a pair in half. An over-long query is truncated rather than rejected, because
 * a validation error on a search box is a worse answer than searching for the
 * first 128 characters, and the cap has to hold on a hand-written URL too.
 */
export function normalizeSearchQuery(raw: string): string {
  // Well-formedness FIRST, so the truncation below only ever has to reason
  // about complete surrogate pairs. U+FFFD is not whitespace, so this cannot
  // change what the collapse step sees.
  const wellFormed = raw.replace(SURROGATE_RUN, (run) =>
    run.length === 2 ? run : REPLACEMENT_CHARACTER
  );
  const collapsed = wellFormed.replace(/\s+/g, " ").trim();
  // The cap can land on a word boundary and leave a dangling separator, so trim
  // again — otherwise a truncated query is not idempotent under normalisation
  // and re-parsing our own response would change it.
  return truncateAtCodePointBoundary(collapsed, SEARCH_QUERY_MAX_LENGTH).trim();
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
