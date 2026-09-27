import { handlePlaybackSessionRequest } from "@liberty/web/playback-session/handler";
import {
  playbackSessionHttpStatus,
  unauthenticatedSession
} from "@liberty/web/playback-session/contract";
import type { RequestAccountRefusalReason } from "@liberty/web/session/account";
import {
  authenticateCaller,
  authenticationRefusalStatus,
  type AuthenticatedCaller,
  type AuthenticationOutcome,
  type CallerAuthenticator
} from "./authentication";

/* -------------------------------------------------------------------------
 * POST /api/v1/playback/session, as this service answers it (PW-0401)
 *
 * TWO STEPS, IN THIS ORDER, AND THE ORDER IS THE SECURITY PROPERTY.
 *
 *   1. AUTHENTICATE THE CALLER, from headers alone. The request body has not
 *      been read at this point and is not read if this step refuses.
 *   2. HAND THE UNTOUCHED REQUEST TO `handlePlaybackSessionRequest`, which is
 *      the application's own route envelope -- the same body bound, the same
 *      parse, the same decision, the same response re-validation, the same
 *      status derivation, the same `no-store`.
 *
 * WHY STEP 2 IS AN IMPORT AND NOT AN IMPLEMENTATION. The acceptance requires
 * "the same route contract, byte for byte", and the cross-target e2e suite
 * compares whole bodies between targets. A service that reimplemented the
 * decision would make that comparison a check between two of our own guesses --
 * `e2e/src/backend-stub.mjs` makes exactly this argument about itself and
 * relays rather than reimplements. Importing the envelope makes the equivalence
 * STRUCTURAL: there is one `handlePlaybackSessionRequest` in this repository,
 * both targets reach it, and there is no second copy to drift.
 *
 * The import is a narrow subpath of `@liberty/web`, which is a layering
 * inversion and is recorded as one -- see `README.md` in this workspace for why
 * the alternative (extracting the decision into a package of its own) was NOT
 * taken here: it would move `@liberty/provider-sdk` and `@liberty/media-engine`
 * behind a boundary that `build-target.test.ts`'s import-graph walker does not
 * cross, turning the guard for `docs/DESKTOP_PLAYBACK.md` section 8 from a real
 * absence into an unobserved one.
 *
 * WHY THE REFUSAL CANNOT LEAK WHETHER A CONTENT ID EXISTS. Not because it was
 * written carefully: because at the moment it is produced, no content id has
 * been read. The body is still an unconsumed stream. `session-endpoint.test.ts`
 * asserts the refusal is byte-identical for a request naming a title that
 * exists, one naming an invented id, one carrying a malformed id and one
 * carrying no JSON at all.
 * ---------------------------------------------------------------------- */

/**
 * The decision, injected for tests. The default is the application's own.
 *
 * IT TAKES THE CALLER THIS SERVICE ALREADY ESTABLISHED (PW-0312). The
 * application's resolving implementation now authenticates too -- it has to,
 * because under the web target nothing else does -- and handing it the identity
 * this endpoint just verified is what keeps that from becoming a SECOND session
 * store read on every forwarded request. It is not a widening: the injection
 * point is the same options bag a test uses, nothing on the wire reaches it, and
 * the only value ever passed is one `authenticateCaller` produced from this
 * request's own headers a few lines above.
 */
export type SessionDecider = (request: Request, caller: AuthenticatedCaller) => Promise<Response>;

/**
 * The real decision: the application's route envelope, told who is asking.
 */
const decideWithApplication: SessionDecider = (request, caller) =>
  handlePlaybackSessionRequest(request, {
    authenticate: async () => ({ ok: true, account: caller.account, detail: caller.detail })
  });

export interface SessionEndpointDependencies {
  readonly authenticate?: CallerAuthenticator;
  readonly decide?: SessionDecider;
  /** Called with a one-line record of every answer. Defaults to doing nothing. */
  readonly observe?: (line: string) => void;
}

/**
 * What a refused caller is told, per reason.
 *
 * FIXED STRINGS DECLARED HERE, AND NOT THE UPSTREAM `detail`. Two reasons, and
 * the second is the load-bearing one.
 *
 * The small one: `resolveRequestAccount`'s detail for a malformed development
 * header names the header the developer got wrong, and reflecting a
 * caller-supplied header value back into a response body is a habit worth not
 * having in a service that faces a forwarder.
 *
 * THE REAL ONE: THESE BODIES ARE NOT PART OF THE PUBLISHED CONTRACT AND MUST
 * NOT LOOK LIKE IT. The desktop forwarder validates every backend body against
 * `playbackSessionResponseSchema` and turns anything else into an honest
 * `unavailable`, which is the right answer for both of the reasons still
 * answered this way: a backend with no identity store and a development header
 * that is not well formed are an operator's problem and a developer's, and
 * neither is a state a viewer can act on. So these bytes reach an operator with
 * `curl` and a log, never a client that parses them, and they are written for
 * that reader.
 *
 * `not_authenticated` IS NO LONGER AMONG THEM (PW-0312). It was, and the cost
 * was recorded here in the round that built this endpoint: a signed-out desktop
 * viewer saw "unavailable" rather than "sign in", because the contract had no
 * way to say the second and the forwarder correctly refused to invent one.
 * gpt-architect's round-90 ruling assigned that corrective to PW-0312, the
 * contract now carries an `unauthenticated` outcome, and `unauthenticatedRefusal`
 * below answers with it -- so the desktop target and the web target produce the
 * same outcome, the same reason code and the same detail for the same fact.
 */
const REFUSAL_DETAIL: Readonly<
  Record<Exclude<RequestAccountRefusalReason, "not_authenticated">, string>
> = {
  authentication_not_configured:
    "this backend has no identity store configured, so no caller can be authenticated",
  development_identifier_malformed:
    "a development identity header on this request is not a well-formed identifier"
};

/**
 * A signed-out caller, IN THE PUBLISHED CONTRACT (PW-0312).
 *
 * THE BODY AND THE STATUS BOTH COME FROM `contract.ts` -- `unauthenticatedSession`
 * builds it and `playbackSessionHttpStatus` derives the 401 -- rather than being
 * written out here. That is the same discipline `handler.ts` applies to every
 * other outcome, and it is what makes "the forwarder relays this unchanged" a
 * property of one definition rather than an agreement between two files that
 * can drift. `authenticationRefusalStatus("not_authenticated")` is 401 as well;
 * `session-endpoint.test.ts` asserts the two agree, so the day one of them
 * moves is the day a test says so.
 *
 * IT SAYS NOTHING ABOUT CONTENT, and structurally cannot: at the moment it is
 * produced the request body is still an unconsumed stream, so there is no
 * content id in scope for it to differ on.
 */
function unauthenticatedRefusal(): Response {
  const body = unauthenticatedSession();
  return new Response(JSON.stringify(body), {
    status: playbackSessionHttpStatus(body),
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function refusalResponse(outcome: Extract<AuthenticationOutcome, { ok: false }>): Response {
  const { reason } = outcome.refusal;
  if (reason === "not_authenticated") return unauthenticatedRefusal();

  const body = JSON.stringify({ error: reason, detail: REFUSAL_DETAIL[reason] });
  return new Response(body, {
    status: authenticationRefusalStatus(reason),
    headers: {
      "content-type": "application/json",
      /*
       * `no-store` on every branch, matching `handler.ts`: a playback session
       * is per-viewer and time-bounded, and a cached REFUSAL outlives both the
       * session that would have fixed it and the configuration that caused it.
       */
      "cache-control": "no-store"
    }
  });
}

/**
 * Answer one session request.
 *
 * NEVER THROWS, for the reason `issue-session.ts` never throws and the reason
 * the forwarder never throws: an endpoint whose failure mode is a stack trace
 * is an endpoint with no reason trail. A decision that throws is reported as an
 * unavailability with no detail borrowed from the exception, because an
 * exception's text is whatever a library felt like saying -- up to and
 * including an internal hostname or a connection string.
 */
export async function handleSessionRequest(
  request: Request,
  dependencies: SessionEndpointDependencies = {}
): Promise<Response> {
  const observe = dependencies.observe ?? (() => undefined);

  const outcome = await authenticateCaller(request, dependencies.authenticate);
  if (!outcome.ok) {
    observe(`playback session refused: ${outcome.refusal.reason}`);
    return refusalResponse(outcome);
  }

  observe(`playback session authenticated: ${outcome.caller.detail}`);

  const decide = dependencies.decide ?? decideWithApplication;
  try {
    return await decide(request, outcome.caller);
  } catch {
    /*
     * `handlePlaybackSessionRequest` is documented not to throw, and this is
     * the belt for that brace rather than a branch anything is expected to
     * reach. It is answered with the contract's own `unavailable` shape --
     * unlike the refusals above, which have no shape in the contract -- so a
     * forwarder that receives it produces the same outcome the resolving
     * implementation would have produced for an unreachable provider.
     */
    return new Response(
      JSON.stringify({
        outcome: "unavailable",
        reasons: [
          {
            code: "provider_unavailable",
            candidateId: null,
            detail: "the authenticated backend failed while deciding this session"
          }
        ]
      }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }
}
