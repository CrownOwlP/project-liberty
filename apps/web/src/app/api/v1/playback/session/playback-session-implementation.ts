import {
  playbackReason,
  unauthenticatedSession,
  unavailableSession,
  type PlaybackSessionResponse
} from "./contract";
import {
  resolveRequestAccount,
  resolveSessionReader,
  type RequestAccountResolution
} from "../../../../../lib/session/account";
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
export interface PlaybackSessionOptions extends IssueSessionOptions {
  /**
   * Who is asking. Injected so every branch of the gate below can be driven
   * without PostgreSQL and without a constructed auth library, and DEFAULTED to
   * `resolveRequestAccount` -- the same function the profile, progress and
   * watchlist routes identify a caller with -- so nothing is opt-in.
   *
   * IT IS NOT A REQUEST INPUT. Nothing on the wire reaches it. A caller cannot
   * name an authenticator any more than it can name a resolver, and the
   * forwarding implementation under the other target does not have this option
   * at all, because the backend already holds the identity store.
   */
  readonly authenticate?: (request: Request) => Promise<RequestAccountResolution>;
  /**
   * Whether this process HAS an identity system, asked independently of any
   * one request. Injected for the same reason and defaulted to the real check.
   * See the gate below for why the two questions are separate.
   */
  readonly identityConfigured?: () => boolean;
}

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

/* -------------------------------------------------------------------------
 * THE AUTHENTICATION GATE (PW-0312)
 *
 * IT RUNS HERE, IN THE RESOLVING HALF, AND NOT IN `handler.ts`. That module is
 * the shared envelope in FRONT of the build-target seam, so code placed there
 * runs in BOTH builds -- including inside the desktop sidecar, which has no
 * identity store and forwards precisely so that it needs none. Authenticating
 * there would make every desktop request refuse locally and never reach the
 * backend at all. Under this target the resolving half is the deployment that
 * holds the store; under the desktop target the resolving half runs on the
 * backend, where `apps/backend/src/session-endpoint.ts` has already
 * authenticated the caller from headers alone and injects the established
 * identity inward. One gate, one place, both targets.
 *
 * IT RUNS BEFORE THE BODY IS PARSED, which is stronger than "before content
 * lookup". A signed-out caller's answer is therefore a pure function of its
 * headers: it cannot vary with the content id, because no content id has been
 * read when the answer is produced. That is the acceptance's "no
 * content-existence leak" as a structural property rather than as a promise --
 * the same argument `session-endpoint.ts` makes about its own ordering, and the
 * reason both are stated in terms of what has NOT been read yet.
 *
 * THE COST, NAMED: a signed-out caller that also sent a malformed body is told
 * to sign in rather than told its body was malformed. That is the right way
 * round. The alternative answers a shape question for somebody we have not
 * identified, and a validator is a cheaper oracle than a catalog.
 * ---------------------------------------------------------------------- */

/**
 * The gate's verdict: either nothing to say, or the whole answer.
 *
 * `null` means "carry on and decide", which is what BOTH an authenticated
 * caller and a process with no identity system get, for different reasons that
 * the branches below state separately.
 */
async function authenticationRefusal(
  request: Request,
  options: PlaybackSessionOptions
): Promise<PlaybackSessionResponse | null> {
  const authenticate = options.authenticate ?? resolveRequestAccount;
  const identityConfigured = options.identityConfigured ?? (() => resolveSessionReader().ok);

  let resolution: RequestAccountResolution;
  try {
    resolution = await authenticate(request);
  } catch {
    /*
     * NEVER THROWS, for the reason `issue-session.ts` never throws: an endpoint
     * whose failure mode is a stack trace is an endpoint with no reason trail,
     * which is what invariant 4 exists to prevent. The thrown value is not
     * echoed -- the options object behind the auth instance holds this
     * deployment's secret and its connection string, and a library's message is
     * whatever that library felt like saying.
     */
    return unavailableSession(
      playbackReason(
        "provider_unavailable",
        "the identity store could not be consulted for this request"
      )
    );
  }

  if (resolution.ok) return null;

  switch (resolution.reason) {
    case "not_authenticated":
      /*
       * THE ONE THIS TASK EXISTS FOR. Absent, expired, revoked and malformed
       * all arrive here as one answer with one detail -- see
       * `deploymentSessionAccount` -- and the outcome carries that single
       * sentence onward unchanged, so the response cannot become the oracle
       * the shared constant exists to prevent.
       */
      return unauthenticatedSession();
    case "development_identifier_malformed":
      /*
       * A DEVELOPER'S OWN TYPO, and unreachable on a deployment: only the
       * non-deployment branch of `resolveRequestAccount` reads those headers.
       * It fails CLOSED -- an identity we could not read is not an identity --
       * but it says which kind of mistake it was, because the person reading it
       * is the person who made it. A FIXED STRING and not the upstream detail:
       * that one names the header, and reflecting a caller-supplied header name
       * into a response body is a habit worth not having on a route a forwarder
       * talks to. `session-endpoint.ts` declines the same echo for the same
       * reason.
       */
      return unauthenticatedSession(
        playbackReason(
          "not_authenticated",
          "a development identity header on this request is not a well-formed identifier"
        )
      );
    case "authentication_not_configured":
      /*
       * TWO DIFFERENT EVENTS ARRIVE UNDER ONE REASON, and they need opposite
       * answers, so the process is asked a second, request-independent
       * question: does an identity system EXIST here?
       *
       *   - IT DOES NOT. Then there is no sign-in for anyone to perform, and
       *     "sign in to continue" would be the dead end this task removes,
       *     pointing the other way -- the same argument `/profiles` makes when
       *     it falls through to the picker rather than to the panel on an
       *     `unavailable` account. The route behaves exactly as it did before
       *     this gate existed. This is what keeps `next build`-mode e2e
       *     honest: `.github/workflows/ci.yml` declares no PostgreSQL service
       *     and `e2e/src/env.ts` defaults `LIBERTY_E2E_DATABASE_URL` to null,
       *     so every production-mode playback spec runs in a process that has
       *     no identity system at all.
       *   - IT DOES, AND IT COULD NOT ANSWER. Then this is an outage of a
       *     dependency, not a signed-out viewer, and `unavailable` is the
       *     outcome whose remedy -- wait and retry -- is the true one. It is
       *     deliberately NOT reported as `unauthenticated`: telling a signed-in
       *     viewer to sign in during a database blip is the collapse this
       *     task's ruling forbids, with the operands swapped.
       */
      return identityConfigured()
        ? unavailableSession(
            playbackReason(
              "provider_unavailable",
              "the identity store could not be consulted for this request"
            )
          )
        : null;
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
 * landed. It is also what lets the gate above read headers without the body
 * having been touched.
 */
export async function decidePlaybackSession(
  request: Request,
  options: PlaybackSessionOptions = {}
): Promise<PlaybackSessionResponse> {
  const refusal = await authenticationRefusal(request, options);
  if (refusal !== null) return refusal;

  return issuePlaybackSession(await readJsonBody(request), options);
}
