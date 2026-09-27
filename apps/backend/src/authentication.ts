import {
  resolveRequestAccount,
  type RequestAccountRefusalReason,
  type RequestAccountResolution
} from "@liberty/web/session/account";
import type { AccountIdentity } from "@liberty/auth";

/* -------------------------------------------------------------------------
 * Who is asking (PW-0401)
 *
 * THE SAME AUTHENTICATION THE APPLICATION PERFORMS, NOT A SECOND ONE.
 * `resolveRequestAccount` is the function `apps/web`'s profile, progress and
 * watchlist routes already resolve an identity with, and it is imported here
 * rather than reimplemented so that this service and the application agree
 * about who a caller is because they are RUNNING THE SAME CODE against the same
 * database -- not because two pieces of code were written to the same
 * description and have not diverged yet.
 *
 * What that buys concretely: PW-0403's ruling that Liberty uses DATABASE
 * sessions rather than signed stateless tokens holds here unchanged, so a
 * session row deleted on the web side stops working against this service on the
 * very next request; the refusal from a deployment that has no auth instance is
 * the same `authentication_not_configured` with the same remedy; and the
 * development-header identity is available under exactly the same conditions --
 * a non-deployment runtime and nothing else -- which is what lets the e2e
 * harness drive this service the way it already drives the application.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: accept the desktop sidecar's loopback
 * launch token as a login. `docs/DESKTOP_PLAYBACK.md` section 7's token
 * authorises a LISTENER -- it establishes that a request reached the right
 * local process -- and PW-0402 built `authorizeRoute` never to receive a
 * `Request` precisely so the token could not become an identity. The forwarder
 * does not send it, and this module would not read it if it did: the only
 * inputs `resolveRequestAccount` has are the request's headers, and the only
 * headers that decide anything are the session cookie and the two development
 * headers.
 * ---------------------------------------------------------------------- */

/**
 * How the caller is identified. Injected so a test can drive every branch
 * without a database and without a constructed auth library, and DEFAULTED to
 * the real one so nothing is opt-in.
 */
export type CallerAuthenticator = (request: Request) => Promise<RequestAccountResolution>;

export interface AuthenticatedCaller {
  readonly account: AccountIdentity;
  /** Never empty. Where the identity came from, for the operator's log. */
  readonly detail: string;
}

export interface AuthenticationRefusal {
  readonly status: number;
  readonly reason: RequestAccountRefusalReason;
  readonly detail: string;
}

export type AuthenticationOutcome =
  | { readonly ok: true; readonly caller: AuthenticatedCaller }
  | { readonly ok: false; readonly refusal: AuthenticationRefusal };

/**
 * The status each refusal is answered with.
 *
 * TAKEN FROM `apps/web/src/lib/db/request-context.ts` RATHER THAN CHOSEN HERE,
 * because an operator and a viewer reading across the product must not find the
 * same fact reported two ways:
 *
 *   - `not_authenticated` is **401**. A signed-out request is not a server-side
 *     unavailability; "retry later" is false, and no amount of waiting signs
 *     anybody in.
 *   - `authentication_not_configured` is **503**. Nothing is wrong with the
 *     request; this deployment is missing a dependency, which is the status
 *     this product already answers for that across four route groups.
 *   - `development_identifier_malformed` is **400**. A developer's own typo in
 *     a development header, and unreachable on a deployment at all.
 *
 * THE REFUSAL SAYS NOTHING ABOUT CONTENT, and that is structural rather than
 * careful: this runs before the request body has been read, so there is no
 * content id in scope for it to differ on. `session-endpoint.ts` asserts the
 * bytes are identical for a request naming a real title and one naming an
 * invented one, which is the acceptance's "a refusal that does not leak whether
 * a content id exists" stated as a test rather than as an intention.
 */
const REFUSAL_STATUS: Readonly<Record<RequestAccountRefusalReason, number>> = {
  not_authenticated: 401,
  authentication_not_configured: 503,
  development_identifier_malformed: 400
};

export function authenticationRefusalStatus(reason: RequestAccountRefusalReason): number {
  return REFUSAL_STATUS[reason];
}

/**
 * Identify the caller, or say why not.
 *
 * NEVER THROWS. `resolveRequestAccount` already reports a store that could not
 * answer as `authentication_not_configured` rather than by throwing, and the
 * `catch` here is for the class of failure nothing has thought of: an endpoint
 * whose failure mode is a stack trace is an endpoint with no reason trail,
 * which is what invariant 4 exists to prevent. The thrown value is NOT echoed
 * -- the options object behind the auth instance holds this deployment's secret
 * and its connection string, and a library's message is whatever that library
 * felt like saying.
 */
export async function authenticateCaller(
  request: Request,
  authenticate: CallerAuthenticator = resolveRequestAccount
): Promise<AuthenticationOutcome> {
  let resolution: RequestAccountResolution;
  try {
    resolution = await authenticate(request);
  } catch {
    return {
      ok: false,
      refusal: {
        status: REFUSAL_STATUS.authentication_not_configured,
        reason: "authentication_not_configured",
        detail: "the identity store could not be consulted for this request"
      }
    };
  }

  if (resolution.ok) {
    return { ok: true, caller: { account: resolution.account, detail: resolution.detail } };
  }

  return {
    ok: false,
    refusal: {
      status: REFUSAL_STATUS[resolution.reason],
      reason: resolution.reason,
      detail: resolution.detail
    }
  };
}
