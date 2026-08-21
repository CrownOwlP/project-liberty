import { handlePlaybackSessionRequest } from "./handler";

/**
 * POST /api/v1/playback/session
 *
 * Issues a playback session for an already-identified content id. The request
 * carries an id and a device capability profile; the SERVER resolves which
 * authorized provider candidates exist for it, so there is no field a client
 * can populate that becomes a URL anything fetches or plays.
 *
 * The response is a discriminated union on `outcome` -- `granted`, `denied` or
 * `unavailable` -- with `reasons` on every branch. See `contract.ts` for why
 * that is a type-level guarantee rather than a convention, and `handler.ts` for
 * why the work is not in this file.
 *
 * Nothing else may be exported from a route module, which is the whole reason
 * this one is four lines.
 */
export async function POST(request: Request): Promise<Response> {
  return handlePlaybackSessionRequest(request);
}
