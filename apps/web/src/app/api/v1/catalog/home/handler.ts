import type { CatalogHomeResponse } from "@liberty/contracts/domains/catalog";
import type { CatalogLoadResult } from "../../../../../lib/catalog";

/* -------------------------------------------------------------------------
 * The HTTP half of GET /api/v1/catalog/home
 *
 * SEPARATED FROM `route.ts` FOR THE REASON `playback/resolve/handler.ts` GIVES:
 * a Next route module may export only the handlers and a fixed set of segment
 * config values, so a route file has nowhere to accept an injected result and
 * testing one means testing whatever environment the suite happens to run in.
 * This file takes the already-decided `CatalogLoadResult` and does nothing but
 * turn it into a response, so every branch — including the refusal a deployment
 * produces — is reachable from a unit test without touching `process.env`.
 *
 * WHY THE ROUTE HAS A REFUSAL BRANCH AT ALL. It used to call the synchronous
 * `getHomeCatalog()`, which returns a `CatalogHomeResponse` and therefore has
 * nowhere to put "no metadata source is configured": on a deployment it answered
 * with no rails and the route served `{ rails: [] }` at 200, which
 * `docs/API_CONTRACTS.md` defines to mean "genuinely nothing to show". That is a
 * statement about the catalog being made by a process that has no catalog. The
 * route now awaits `loadHomeCatalog()`, which reports the configuration state as
 * a reason, and this module maps it onto a status.
 * ---------------------------------------------------------------------- */

/**
 * `docs/API_CONTRACTS.md`: "Served `cache-control: no-store`." Applied to every
 * branch and not only to the success one — a refusal that gets cached outlives
 * the configuration that caused it.
 */
const NO_STORE = { "cache-control": "no-store" };

/**
 * How each reason `loadHomeCatalog` can report is answered on the wire.
 *
 * Two different kinds of failure, so two different statuses:
 *
 *   - `catalog_response_failed_validation` is 500. The source answered and this
 *     server could not publish what it said, which is a fault on this side of
 *     the boundary. That is the status and code `docs/API_CONTRACTS.md` already
 *     documents for this route.
 *   - `catalog_source_not_configured` and `catalog_source_unavailable` are 503.
 *     Nothing is wrong with the request; there is no catalog behind this
 *     deployment, either because none is configured or because the one that is
 *     did not answer. 503 is what the profile, progress and watchlist routes
 *     already answer for `authentication_not_configured`, so an operator reading
 *     across this app sees one status for "this deployment is missing a
 *     dependency".
 *
 * NEITHER OF THE 503s IS AN EMPTY BODY. `docs/API_CONTRACTS.md` states that a
 * failure "is never an empty body", and `rails: []` at 200 is reserved for a
 * configured catalog that genuinely surfaces nothing.
 *
 * `CatalogLoadResult.reason` is typed `string` rather than a union, so this is a
 * lookup with a fallback rather than an exhaustive switch. A reason this route
 * does not recognise is answered 500: the loader produced something this module
 * was not updated for, which is a server-side inconsistency and not the caller's
 * problem. It is never silently downgraded to 200.
 */
const REASON_STATUS: Readonly<Record<string, number>> = {
  catalog_response_failed_validation: 500,
  catalog_source_not_configured: 503,
  catalog_source_unavailable: 503
};

/** The status for a load reason. 500 for anything this module does not know. */
export function catalogHomeStatusFor(reason: string): number {
  return REASON_STATUS[reason] ?? 500;
}

/**
 * Turns a decided load result into the published response.
 *
 * NOTHING IS RE-VALIDATED HERE. `loadHomeCatalog` parses through
 * `catalogHomeResponseSchema` and returns `parsed.data`, so the `ok` payload has
 * already been checked against the contract and a second `safeParse` would only
 * be able to disagree with itself. The route used to run that parse itself, and
 * the one thing lost in moving it is the `issues` array that accompanied the
 * 500: `CatalogLoadResult` carries a reason and not the Zod issues. The
 * documented code is unchanged, and the issues were never part of the contract.
 *
 * The `empty` branch reconstructs the response the loader took apart. Its
 * `generatedAt` came out of the validated payload, so `{ rails: [] }` with it is
 * a contract-valid body and the one the contract defines as "genuinely nothing
 * to show".
 */
export function handleCatalogHomeResult(result: CatalogLoadResult): Response {
  if (result.status === "ok") {
    return Response.json(result.response, { headers: NO_STORE });
  }

  if (result.status === "empty") {
    const body: CatalogHomeResponse = { rails: [], generatedAt: result.generatedAt };
    return Response.json(body, { headers: NO_STORE });
  }

  return Response.json(
    { error: result.reason },
    { status: catalogHomeStatusFor(result.reason), headers: NO_STORE }
  );
}
