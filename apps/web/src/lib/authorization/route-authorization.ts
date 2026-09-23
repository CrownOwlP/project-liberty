/* -------------------------------------------------------------------------
 * The one place a route decides whether a caller may act (PW-0402).
 *
 * WHAT THIS IS FOR. docs/SECURITY.md residual risk R4 records that "no
 * authentication or authorization exists on any API route yet" and that
 * "nothing in the current code should be read as a decision that these routes
 * are safe to leave anonymous". Acceptable for a web demo; not for a shipped
 * desktop application with a loopback listener that every process on the user's
 * machine can reach.
 *
 * WHAT IT IS NOT, AND THE DISTINCTION IS THE WHOLE POINT. PW-0101 owns the
 * LISTENER boundary -- loopback bind, per-launch bearer token, Host validation,
 * CSP, the port handshake -- which answers "may this process talk to the sidecar
 * at all". This module answers "may this CALLER perform this OPERATION". They
 * are different questions with different failure modes, and gpt-architect ruled
 * them into separate tasks for a concrete reason: a single machine-wide secret
 * satisfying both would mean every process on the PC, and every page the webview
 * ever loads, holds full authority over every profile.
 *
 * SO: THE LAUNCH TOKEN IS NOT A LOGIN. This module never reads it, never names
 * the header it arrives in, and `route-authorization.test.ts` asserts that by
 * scanning the source -- not because a reviewer would miss it once, but because
 * the fifth person to touch this file will be under time pressure and the token
 * is right there, already validated, already proving the request came from the
 * shell.
 *
 * LOOPBACK IS NOT A LOGIN EITHER, for the same reason and one more: there is no
 * OS boundary between a game launcher, a browser tab's helper and this server.
 * "It came from this machine" is the exact assumption that turns a local
 * listener into a privilege-escalation surface.
 *
 * ADOPTED, NOT REINVENTED. `resolveRequestAccount` already establishes an
 * account identity and `authorizeProfileAccess` from `@liberty/auth` already
 * decides profile access against a real ownership record and a minted
 * `ProfileScope`. Both are reviewed, tested code. This module composes them into
 * ONE decision a route can call, so that "may this caller read this profile" has
 * exactly one answer -- a second opinion is how the first one stops being
 * enforced.
 * ---------------------------------------------------------------------- */

import type { ProfileAccessDecision } from "@liberty/auth";

import type { RequestAccountResolution } from "../session/account";

/**
 * What a route needs before it acts.
 *
 * `account` is the floor: the caller is somebody. `profile` is the floor plus an
 * authorized active profile, which every profile-scoped row in this product is
 * keyed by.
 *
 * There is deliberately no `anonymous` member. A route that needs nothing does
 * not call this function, and making "nothing" a value here would let a handler
 * declare it by accident.
 */
export type RouteAuthority = "account" | "profile";

/**
 * Why a route refused. TWO CODES, AND NOT ONE PER CAUSE.
 *
 * `unauthenticated` says the caller is nobody, which a client can act on by
 * signing in. `not_permitted` covers everything else -- not yours, not there,
 * no active profile, ownership unreadable -- because those must be
 * INDISTINGUISHABLE on the wire. A refusal that separated "this profile is not
 * yours" from "this profile does not exist" is an enumeration oracle: a caller
 * could walk the id space and learn which households exist.
 */
export type RouteRefusalCode = "unauthenticated" | "not_permitted";

export interface RouteAuthorizationInputs {
  /** From `resolveRequestAccount`. The account floor. */
  readonly account: RequestAccountResolution;
  /**
   * From `resolveActiveProfileScope`, for a `profile` route.
   *
   * `null` means the caller named no active profile. Required-and-nullable
   * rather than optional: an absent key would say only that somebody did not
   * think about it, and this is not a field to be vague in.
   */
  readonly profile: ProfileAccessDecision | null;
}

export type RouteAuthorizationDecision =
  | {
      readonly allowed: true;
      /** Never empty. The reason trail invariant applies to a grant too. */
      readonly reason: string;
    }
  | {
      readonly allowed: false;
      readonly code: RouteRefusalCode;
      /** For the SERVER's log. Never for the response body; see `wireDetail`. */
      readonly internalDetail: string;
      /** Safe to return. Identical for every `not_permitted` cause. */
      readonly wireDetail: string;
    };

const UNAUTHENTICATED_WIRE = "this request carries no authenticated account";
const NOT_PERMITTED_WIRE = "this account may not perform that operation";

function refuse(
  code: RouteRefusalCode,
  internalDetail: string
): RouteAuthorizationDecision {
  return {
    allowed: false,
    code,
    internalDetail,
    wireDetail: code === "unauthenticated" ? UNAUTHENTICATED_WIRE : NOT_PERMITTED_WIRE
  };
}

/**
 * The decision.
 *
 * PURE. It takes the two resolutions and returns an answer; it reads no
 * `Request`, no headers, no environment and no clock. That is not tidiness — it
 * is what makes "the launch token is not consulted" a property of the TYPE
 * SIGNATURE rather than a promise in a comment. This function could not read the
 * token if it wanted to, because it is never given the request.
 */
export function authorizeRoute(
  authority: RouteAuthority,
  inputs: RouteAuthorizationInputs
): RouteAuthorizationDecision {
  if (!inputs.account.ok) {
    /*
     * The account floor, checked FIRST and for every authority. A profile
     * decision computed for an unidentified caller would be meaningless, and
     * evaluating it first would let "no such profile" be observable to somebody
     * who is not logged in at all.
     */
    return refuse(
      "unauthenticated",
      `account could not be established: ${inputs.account.reason} — ${inputs.account.detail}`
    );
  }

  if (authority === "account") {
    return { allowed: true, reason: `account ${inputs.account.detail}` };
  }

  const profile = inputs.profile;
  if (profile === null) {
    return refuse("not_permitted", "no active profile was named for a profile-scoped route");
  }
  if (!profile.allowed) {
    /*
     * The denial reason goes to the LOG, not the wire. `ProfileAccessDecision`
     * distinguishes "not owned by this session" from "no ownership record" --
     * a distinction an operator needs and a caller must never be handed, because
     * together they enumerate which profiles exist.
     */
    return refuse("not_permitted", `profile access denied: ${profile.reason}`);
  }

  return { allowed: true, reason: `profile access granted: ${profile.reason}` };
}

/**
 * The HTTP status for a decision.
 *
 * 401 for `unauthenticated` and 403 for `not_permitted`, and NEVER 404 for a
 * profile the caller may not see. 404 is the tempting choice -- it hides
 * existence -- but it hides it from the operator too, and it makes an
 * authorization failure indistinguishable from a routing bug in every dashboard
 * this project has. The existence hiding is done by making all `not_permitted`
 * causes produce the same 403 body, which achieves the same thing without lying
 * about what happened.
 */
export function routeRefusalStatus(code: RouteRefusalCode): number {
  return code === "unauthenticated" ? 401 : 403;
}
