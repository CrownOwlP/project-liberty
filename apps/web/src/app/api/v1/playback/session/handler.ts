import {
  playbackSessionHttpStatus,
  playbackSessionResponseSchema,
  type PlaybackSessionResponse
} from "./contract";
import {
  decidePlaybackSession,
  type PlaybackSessionOptions
} from "./playback-session-implementation";

/* -------------------------------------------------------------------------
 * The HTTP half of POST /api/v1/playback/session
 *
 * Separated from `route.ts` because a Next route module may only export the
 * handlers and a fixed set of segment config values -- so a route file has
 * nowhere to accept an injected resolver, and testing one means testing it with
 * whatever the deployment happens to be configured with. This file takes the
 * options; `route.ts` is the three-line adapter that supplies none.
 *
 * IT IS ALSO THE WHOLE OF WHAT SITS IN FRONT OF THE BUILD-TARGET SEAM, and that
 * is the reason `docs/DESKTOP_PLAYBACK.md` §8's "the contract is preserved
 * exactly" is a structural claim here rather than a promise. The decision comes
 * from `./playback-session-implementation`, which is one module under the web
 * target and a different one under the desktop target (see `../build-target.ts`).
 * Everything below -- the schema re-validation, the status derivation, the
 * `no-store` header, the shape of the 500 -- runs unchanged in both builds,
 * because it is compiled from this one file either way. No client can tell the
 * two apart, and there is nothing here for one to branch on.
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
 * A decision, as the HTTP response the contract says it is.
 *
 * SPLIT OUT FROM THE HANDLER so that it is one function rather than one
 * function per target: `playback-session-implementation.desktop.test.ts` drives
 * the forwarding implementation through this exact envelope and asserts the
 * same statuses, the same bodies and the same header the web suite asserts, so
 * "the contract is identical across targets" is checked against the shipped
 * code rather than argued from the file layout.
 */
export function playbackSessionResponse(response: PlaybackSessionResponse): Response {
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

export async function handlePlaybackSessionRequest(
  request: Request,
  options: PlaybackSessionOptions = {}
): Promise<Response> {
  return playbackSessionResponse(await decidePlaybackSession(request, options));
}
