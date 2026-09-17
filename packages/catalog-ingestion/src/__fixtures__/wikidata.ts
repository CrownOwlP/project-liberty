import hydrationResponse from "./wikidata-hydration.json";
import pageResponse from "./wikidata-page.json";
import searchResponse from "./wikidata-search.json";

/* -------------------------------------------------------------------------
 * Real Wikidata responses, recorded and reduced
 *
 * THESE ARE NOT INVENTED. Every byte of the three JSON files beside this module
 * came off the live endpoints on 2026-09-17, fetched with the URLs this
 * package's own builders produce -- `buildPageRequestUrl("Q11424", ["en","fr"],
 * 83000, 4)`, `buildHydrationRequestUrl("Q11424", ["en","fr"], ["Q2715974",
 * "Q83495","Q13014087"])` and `buildSearchRequestUrl("the matrix","en",0,5)` --
 * so a fixture cannot describe a query shape the code does not send. That is the
 * whole reason to record rather than to write: a hand-written fixture agrees
 * with the adapter's assumptions by construction and therefore tests nothing
 * about the source.
 *
 * WHAT WAS REMOVED, stated so the reduction is auditable and so nobody mistakes
 * these for captures:
 *
 *   - `wikidata-page.json`: one of the four returned rows was dropped (`Q83103`,
 *     a pornographic film), leaving `Q83005`, `Q83495` and `Q83505`. Nothing
 *     inside the surviving rows was touched.
 *   - `wikidata-search.json`: the five returned hits were cut to the first
 *     three, and `search-continue` was changed from `5` to `3` so the
 *     continuation still matches the number of hits present. EVERY FIELD OF
 *     EACH SURVIVING HIT WAS KEPT, including `url` and `concepturi` -- which is
 *     deliberate. Those two are the media-address-shaped fields in a real
 *     `wbsearchentities` answer, and a fixture that had tidied them away could
 *     not prove the adapter ignores them.
 *   - `wikidata-hydration.json`: unchanged. One row, because two of the three
 *     ids searched for are not instances of `Q11424` and the class constraint in
 *     the hydration query filtered them out -- which is the behaviour worth
 *     pinning, not an editing artefact.
 *   - All three were re-serialised with two-space indentation. No value was
 *     edited.
 *
 * WHAT IS NOT HERE, AND WHY. No bulk extract, no dump, nothing at page scale.
 * The enumeration of `Q11424` returns 349,426 items and none of them is in this
 * repository; three rows is what it takes to exercise the packing, the
 * deduplication, the class filter and the ordering, and a larger fixture would
 * be a dataset with a test attached rather than a test.
 *
 * THE CONTROL CHARACTERS ARE REAL. `` and `` appear throughout the
 * packed columns; they are what `GROUP_CONCAT` was told to join with, and JSON
 * escapes them, so they are visible in the files rather than invisible.
 *
 * THESE FIXTURES CAN GO STALE, and nothing in the default suite would notice.
 * Wikidata is edited continuously: a genre added to `Q83495` tomorrow changes
 * what the live endpoint answers while these files stay as they are. That is
 * what `wikidata.live.test.ts` is for -- it runs the same queries against the
 * real service and is kept OUT of the default suite, so a gate never depends on
 * the network and a human can still check that reality has not moved.
 * ---------------------------------------------------------------------- */

/**
 * Three films, keyset-paged from `Q11424` after `Q83000`.
 *
 * `Q83495` (The Matrix) is the interesting one: eighteen genre labels across two
 * locales packed into one cell, two titles, two descriptions, one IMDb id, and
 * an EMPTY `copyrightStatuses` -- which is the normal case and the reason this
 * adapter cannot establish a rights basis from the source.
 */
export const WIKIDATA_PAGE_RESPONSE: unknown = pageResponse;

/**
 * The same query pinned to three searched ids, of which one is a film.
 *
 * `Q2715974` is an ALBUM called "The Matrix" and `Q13014087` is not an instance
 * of `Q11424` either. Neither has a row here, because the hydration query keeps
 * the `?item wdt:P31 ?kind` constraint.
 */
export const WIKIDATA_HYDRATION_RESPONSE: unknown = hydrationResponse;

/**
 * `wbsearchentities` for "the matrix", relevance-ordered as the source ranked it.
 *
 * THE ALBUM RANKS ABOVE THE FILM. That is the real answer, it is why search
 * cannot be trusted to have filtered anything, and it is why the adapter
 * hydrates through the class-constrained query instead of taking the hits.
 */
export const WIKIDATA_SEARCH_RESPONSE: unknown = searchResponse;

/**
 * What `www.wikidata.org` actually sends with an HTTP 429.
 *
 * Recorded because it is NOT JSON. A client that assumed a rate-limited API
 * answers a JSON error object would get a parse failure and report the source as
 * malformed; the transport refuses on the status before the body is parsed, so
 * the failure is reported as a status rather than as a corrupt document. The
 * request id from the original response has been replaced with a placeholder.
 */
export const WIKIDATA_RATE_LIMITED_BODY = [
  "You are making too many requests to the API.",
  "Please follow the best practices at <https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits>.",
  "If you are unsure how to get the access you need, contact <bot-traffic@wikimedia.org>.",
  "",
  "request-id: 00000000-0000-0000-0000-000000000000"
].join("\n");
