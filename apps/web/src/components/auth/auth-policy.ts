import { resolveAuthInstance } from "../../lib/session/auth-instance";

/* -------------------------------------------------------------------------
 * What THIS deployment's identity system can actually do (PW-0312)
 *
 * THE ACCEPTANCE ASKS FOR POLICY, NOT PREFERENCE: "the screen must reflect what
 * this deployment can do rather than what the library can". Better Auth can
 * verify addresses and reset passwords. Whether a running Liberty deployment
 * can do either depends on two facts it holds and the screens do not -- whether
 * an instance was constructible at all, and whether anything can deliver a
 * message -- so this module is where a screen asks, once, on the server.
 *
 * IT PUBLISHES NO CONFIGURATION. The answers below are three booleans and a
 * sentence written for a reader. No secret, no connection string, no base URL
 * and no variable name reaches a rendered page through this type: the refusal
 * detail `resolveAuthInstance` produces is deliberately NOT carried, because it
 * names environment variables and is written for an operator reading a log.
 * ---------------------------------------------------------------------- */

/**
 * Whether a message can be delivered to a viewer's address.
 *
 * `false`, AND IT IS A MIRROR OF A DECISION MADE ELSEWHERE rather than a policy
 * chosen here. `lib/session/auth-instance.ts` constructs the instance with
 * `sendMail: noMailTransport`, a function whose whole body throws -- see its
 * comment for why it REFUSES rather than logging the link, which is the only
 * safe behaviour for a value that is a one-click account-takeover token.
 *
 * There is no way to ask a constructed instance whether its transport works
 * without sending a message to somebody, so this cannot be derived and is
 * stated. `auth-policy.test.ts` asserts that `auth-instance.ts` still wires
 * `noMailTransport`, so the two cannot drift apart silently: the day a real
 * transport is configured, that test fails and this constant is the line to
 * change.
 */
export const MAIL_TRANSPORT_CONFIGURED = false;

export interface AuthPolicy {
  /** An instance exists. `false` means no viewer can sign in at all. */
  readonly available: boolean;
  /**
   * A new account must verify its address before it can sign in.
   *
   * Read from the instance's own resolved config rather than from the
   * environment variable behind it, so the screen states what the running
   * instance does rather than what a variable was set to.
   */
  readonly requiresEmailVerification: boolean;
  /** Whether a verification or reset message can actually be sent. */
  readonly canDeliverMail: boolean;
}

/**
 * Whether sign-up can COMPLETE on this deployment.
 *
 * The distinction the acceptance is about. A deployment that requires
 * verification and cannot send a message can create an account that nobody can
 * ever sign in to -- which is worse than refusing to create one, because the
 * address is then taken. A screen that offered the form anyway would be
 * offering something the deployment cannot honour.
 */
export function signUpCanComplete(policy: AuthPolicy): boolean {
  if (!policy.available) return false;
  return policy.canDeliverMail || !policy.requiresEmailVerification;
}

/**
 * Whether a password reset can START.
 *
 * Reset is not conditional on verification: it is conditional on delivery alone,
 * because the whole flow is "we send you a link". With no transport there is
 * nothing to begin.
 */
export function passwordResetCanStart(policy: AuthPolicy): boolean {
  return policy.available && policy.canDeliverMail;
}

/**
 * This deployment's policy.
 *
 * NEVER THROWS, and answers the most restrictive thing it can when it does not
 * know. An auth screen whose failure mode is a stack trace is a screen a
 * signed-out viewer cannot use to become signed in, which is the whole state
 * this task exists to remove.
 */
export function resolveAuthPolicy(): AuthPolicy {
  let resolution: ReturnType<typeof resolveAuthInstance>;
  try {
    resolution = resolveAuthInstance();
  } catch {
    return { available: false, requiresEmailVerification: true, canDeliverMail: false };
  }

  if (!resolution.ok) {
    /*
     * `requiresEmailVerification: true` on the refusal branch is deliberate and
     * is not a guess dressed as a fact. Nothing is offered on this branch -- no
     * form is rendered when `available` is false -- so the value is unread; it
     * is the strict value so that a future reader who reaches for it without
     * checking `available` gets the cautious answer rather than the permissive
     * one.
     */
    return { available: false, requiresEmailVerification: true, canDeliverMail: false };
  }

  return {
    available: true,
    requiresEmailVerification: resolution.config.requireEmailVerification,
    canDeliverMail: MAIL_TRANSPORT_CONFIGURED
  };
}
