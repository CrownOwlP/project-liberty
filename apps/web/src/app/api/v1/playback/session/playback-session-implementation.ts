import type { PlaybackSessionResponse } from "./contract";
import { issuePlaybackSession, type IssueSessionOptions } from "./issue-session";

/* -------------------------------------------------------------------------
 * THE RESOLVING IMPLEMENTATION OF POST /api/v1/playback/session (PL-0501)
 *
 * One of two, and the DEFAULT one. The other is
 * `playback-session-implementation.desktop.ts`, and which of them a build
 * contains is decided by BUILD TARGET at module-resolution time -- see
 * `../build-target.ts` for the mechanism and `apps/web/next.config.ts` for
 * where it is applied. Nothing at runtime chooses; there is no environment
 * variable, config key or feature flag anywhere on this path, and the module
 * the build did not select is not in the bundle to be reached.
 *
 * WHY A SEAM HERE RATHER THAN A BRANCH INSIDE THE HANDLER.
 * `docs/DESKTOP_PLAYBACK.md` §8 rules that provider resolution and any
 * credential-bearing provider call must not rely on the user-administered
 * local sidecar as the trust boundary, and it rules out a runtime switch in
 * terms: "a runtime flag that can flip resolution back on-device is the same
 * exposure with an extra step", because the flag lives on the machine the user
 * administers, next to the code it would re-enable. The property it asks to be
 * tested for is that the desktop bundle contains NO provider-resolution
 * implementation at all -- which a branch, however carefully written, cannot
 * give, because both sides of a branch are compiled in.
 *
 * WHAT IS ON WHICH SIDE OF THE SEAM. Everything in FRONT of it is shared and
 * target-independent: the route module, the HTTP envelope in `handler.ts` (the
 * response schema re-validation, the status derivation, `no-store`), and the
 * wire contract in `contract.ts`. What is BEHIND it is the decision. So the
 * route path, the request shape, the response shape, the status codes, the
 * error bodies and the reason-trail semantics are produced by the same code in
 * both builds, and no `apps/web` client code can tell which build it is running
 * in -- §8's "the desktop implementation differs behind the boundary and
 * nowhere in front of it".
 *
 * THIS FILE IS THE ON-DEVICE RESOLVER. It reaches `issue-session.ts`, which
 * reaches `authorized-candidates.ts`, `@liberty/media-engine` and
 * `@liberty/provider-sdk`. That whole subgraph is what must be absent from a
 * desktop build, and `../build-target.test.ts` asserts its absence by walking
 * the import graph under the desktop target's own resolution rules.
 * ---------------------------------------------------------------------- */

/**
 * What a caller may inject. Under this target it is the decision's own options.
 *
 * `handler.ts` takes this type from whichever implementation the build
 * selected, so the two targets are free to accept different injections -- a
 * resolver and a clock here, a `fetch` and a backend origin there -- without
 * the envelope in front of them knowing that they differ. Neither is a runtime
 * switch: nothing in either bag can change WHERE resolution happens, only how
 * the selected implementation is exercised by a test.
 */
export type PlaybackSessionOptions = IssueSessionOptions;

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
 *
 * IT LIVES ON THIS SIDE OF THE SEAM rather than in `handler.ts`, where it used
 * to be, because parsing is part of RESOLVING. The forwarding implementation
 * must hand the backend the bytes it was given -- a desktop process that parsed
 * and re-serialised the body would be deciding what the request said, and the
 * malformed-body answer would then be produced twice in two places that could
 * disagree. Under the desktop target this exact function still runs, on the
 * backend, on the same bytes.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Decides a playback session by resolving authorized candidates in this
 * process.
 *
 * The signature is the seam: `(Request, options) => PlaybackSessionResponse`.
 * It takes the whole `Request` rather than a parsed body because the other
 * implementation needs the headers and the raw bytes, and a seam whose shape
 * suited only one side would have to be widened the first time the other one
 * landed.
 */
export async function decidePlaybackSession(
  request: Request,
  options: PlaybackSessionOptions = {}
): Promise<PlaybackSessionResponse> {
  return issuePlaybackSession(await readJsonBody(request), options);
}
