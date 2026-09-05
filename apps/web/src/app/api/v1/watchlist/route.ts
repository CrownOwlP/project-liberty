import { handleListWatchlist } from "./handler";

/**
 * GET /api/v1/watchlist?limit=
 *
 * This profile's list, most recently added first. `limit` is optional and
 * bounded; the applied page size is echoed on the response so a caller that sent
 * none does not have to hard-code the default. See `contract.ts` for why the
 * ceiling is a decision made at this call site rather than inside
 * `parseListLimit`.
 *
 * Nothing else may be exported from a route module, which is why the work is in
 * `handler.ts`.
 */
export async function GET(request: Request): Promise<Response> {
  return handleListWatchlist(request);
}
