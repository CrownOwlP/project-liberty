import { handlePlaybackResolveRequest } from "./handler";

/**
 * POST /api/v1/playback/resolve
 *
 * A ranking scaffold that accepts client-supplied candidates, and the only
 * route that does. It is NOT reachable in a hosted deployment: see
 * `handler.ts` for the guard, for why the guard is in code rather than in
 * docs/API_CONTRACTS.md, and for why the route is gated rather than removed.
 *
 * Nothing else may be exported from a route module, which is the whole reason
 * this one is three lines.
 */
export async function POST(request: Request): Promise<Response> {
  return handlePlaybackResolveRequest(request);
}
