import {
  playbackSessionHttpStatus,
  playbackSessionResponseSchema,
  type PlaybackSessionResponse
} from "./contract";
import { issuePlaybackSession, type IssueSessionOptions } from "./issue-session";

/* -------------------------------------------------------------------------
 * The HTTP half of POST /api/v1/playback/session
 *
 * Separated from `route.ts` because a Next route module may only export the
 * handlers and a fixed set of segment config values -- so a route file has
 * nowhere to accept an injected resolver, and testing one means testing it with
 * whatever the deployment happens to be configured with. This file takes the
 * options; `route.ts` is the three-line adapter that supplies none.
 * ---------------------------------------------------------------------- */

/**
 * Never cached, at any layer.
 *
 * A playback session is per-viewer, per-device and time-bounded. A shared cache
 * holding one would serve one viewer's session -- and eventually one viewer's
 * credential -- to another, which is threat 1 and threat 2 in docs/SECURITY.md
 * in a single response.
 */
const NO_STORE = { "cache-control": "no-store" };

/**
 * A body that is not JSON is a MALFORMED REQUEST, not a server fault.
 *
 * `request.json()` throws on one, and letting that propagate would turn the
 * most trivial client bug into a 500 with no reason trail -- the exact shape of
 * failure invariant 4 exists to forbid. `null` is not a valid request body
 * either, so it reaches the same schema and produces the same well-formed
 * `denied` any other malformed body produces. Nothing here inspects
 * `content-type`: the schema is what decides, and a correct body sent with a
 * wrong header is still a correct body.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handlePlaybackSessionRequest(
  request: Request,
  options: IssueSessionOptions = {}
): Promise<Response> {
  const response = await issuePlaybackSession(await readJsonBody(request), options);

  /*
   * Validated against the published contract before it leaves the server, the
   * same way the catalog route is. The reason is not paranoia about our own
   * object literals: it is that `reasons` being non-empty on every branch is a
   * PRODUCT invariant, and an invariant nothing checks at runtime is one that a
   * later refactor can quietly drop. A regression surfaces here as a 500 with a
   * stable code rather than as a decision no one can explain.
   *
   * This is the one response that is not a member of the union, and that is
   * deliberate: it is not a playback decision at all, it is a statement that
   * this service produced something it is not allowed to say.
   */
  const parsed = playbackSessionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return Response.json(
      { error: "playback_session_failed_validation", issues: parsed.error.issues },
      { status: 500, headers: NO_STORE }
    );
  }

  const validated: PlaybackSessionResponse = parsed.data;

  return Response.json(validated, {
    status: playbackSessionHttpStatus(validated),
    headers: NO_STORE
  });
}
