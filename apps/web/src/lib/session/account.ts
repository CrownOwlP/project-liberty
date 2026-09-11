import type { AccountIdentity } from "@liberty/auth";
/*
 * Both come through `app/api/deployment-environment.ts`, this app's door for the
 * CAPABILITY: it re-exports the registry check alongside the allowlist and the
 * name predicate, so this file reaches `@liberty/contracts/shared/runtime` by
 * one route rather than two. Nothing is restated -- a re-export creates no local
 * binding, so this is the same function `createFixtureProvider` calls.
 */
import {
  isClassifiedRuntime,
  NonDeploymentEnvironment
} from "../../app/api/deployment-environment";

/* -------------------------------------------------------------------------
 * Who is making this request (PL-0402)
 *
 * `AccountIdentity` is what authentication produces, and it is the input to
 * every profile decision: `resolveLibertySession` builds a `LibertySession`
 * around it, `authorizeProfileAccess` compares a profile's owner against it, and
 * `ProfileScope.grantedFor` carries it so a leaked scope can be caught crossing
 * a session boundary.
 *
 * THIS APP HAS NO SIGN-IN, AND THAT IS THE STATE OF THE WORLD RATHER THAN A
 * SHORTCUT TAKEN HERE. `@liberty/auth` ships the seam (`createLibertyAuth`,
 * behind the `/server` subpath), but nothing in `apps/web` constructs it: there
 * is no `app/api/auth/[...all]` route handler, no configured `baseUrl`, `secret`
 * or mail transport, and no PostgreSQL for the database sessions PL-0401 chose.
 * Constructing that instance is a separate task with a security-review gate on
 * it, and it is not this one.
 *
 * So this module answers the question in the only two ways that are true:
 *
 *   - IN A DEPLOYMENT, `authentication_not_configured`. Not "unauthenticated",
 *     which would tell an operator to go and sign in, and not a 401, which would
 *     tell a client to present a credential this deployment has no way to issue.
 *     The remedy is to wire the auth instance, and the reason code says so.
 *   - OUTSIDE A DEPLOYMENT, a DEVELOPMENT ACCOUNT: a stable, obviously-named
 *     identity that lets `next dev` and the unit tests exercise the profile,
 *     progress and watchlist routes end to end.
 *
 * WHY THE DEVELOPMENT ACCOUNT IS NOT AN AUTHENTICATION BYPASS. It grants nothing
 * that authentication would have withheld, because there is nothing to withhold:
 * there are no real accounts, no stored credentials and no sign-in to bypass. It
 * cannot be reached from a build that ships -- `NonDeploymentEnvironment` is the
 * same branded capability `fixtureProvider` and the in-memory repository
 * require, its brand key is a `unique symbol` private to
 * `@liberty/contracts/shared/runtime` so nothing outside that module can write
 * one, and `classify` answers `null` for every `NODE_ENV` outside the
 * `development`/`test` allowlist. The day sign-in exists, this module
 * grows a third branch that reads the verified session and the development branch
 * keeps the gate it already has.
 *
 * AND THE CAPABILITY IS CHECKED, NOT ONLY DECLARED. The brand is a compile-time
 * control, and two values get past one at runtime: an
 * `as unknown as NonDeploymentEnvironment`, and a spread copy of a genuine
 * classification, which carries the brand and needs no cast. Either would have
 * been handed a development identity by a function that merely accepted the
 * type, so `developmentAccount` asks the contracts registry -- by object
 * identity, as its first action, before a header is read -- whether that module
 * issued this exact value. It is the ordering `createFixtureProvider` documents,
 * and it is what lets the paragraph above be a statement about callers rather
 * than about types.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not read a profile id. A client that
 * could name its own active profile would make `authorizeProfileAccess` compare
 * a requested profile against a value the client chose, which is the exact defect
 * `resolveLibertySession` exists to prevent. The active profile comes from
 * `active_profile_selection`, written only by `selectActiveProfile`.
 * ---------------------------------------------------------------------- */

/**
 * Headers that name which development account and session to act as.
 *
 * They exist so a developer can exercise the cases that need TWO households --
 * a scope crossing an account boundary, one profile's watchlist not appearing in
 * another's -- without a sign-in flow. Absent, the defaults below apply, so the
 * ordinary case needs no ceremony at all.
 *
 * Prefixed `x-liberty-development-` rather than something shorter, because the
 * name is the warning: a header called `x-account` in a request log tells a
 * reader nothing about which environments honour it.
 */
export const DEVELOPMENT_ACCOUNT_HEADER = "x-liberty-development-account";
export const DEVELOPMENT_SESSION_HEADER = "x-liberty-development-session";

/** The account a development request acts as when it does not say otherwise. */
export const DEFAULT_DEVELOPMENT_ACCOUNT_ID = "development-account";

/**
 * What a development account or session id may look like.
 *
 * Constrained rather than free-form even though nothing here is a security
 * boundary, because these values are compared for equality against stored
 * `user_id` and `session_id` columns and are interpolated into reason details. A
 * bounded, lower-case, hyphen-separated token is the same shape
 * `normalizedContentIdSchema` settled on for the same reasons: one spelling per
 * identity, and nothing that changes meaning when it is logged.
 *
 * Bounded at 64 characters. `text` in PostgreSQL has no length limit, so an
 * unbounded header value would be an unbounded key.
 */
const DEVELOPMENT_IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DEVELOPMENT_IDENTIFIER_LENGTH = 64;

/**
 * Why this request has no account.
 *
 * `development_identifier_malformed` is separate from
 * `authentication_not_configured` because the remedies are different and only
 * one of them is the operator's: a bad header is the developer's own typo, and
 * reporting it as "authentication is not configured" would send them to wire up
 * an auth instance they do not need.
 */
export type RequestAccountRefusalReason =
  | "authentication_not_configured"
  | "development_identifier_malformed";

export type RequestAccountResolution =
  | {
      readonly ok: true;
      readonly account: AccountIdentity;
      /** Never empty. Names where the identity came from, for the reason trail. */
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: RequestAccountRefusalReason;
      readonly detail: string;
    };

/**
 * Reads one development header, or returns the supplied fallback.
 *
 * A present-but-malformed value is REFUSED rather than falling back to the
 * default. Falling back would mean a typo silently acts as the default account,
 * so a developer testing cross-household isolation would see two "different"
 * households share one identity and conclude the isolation works.
 */
function developmentIdentifier(
  headers: Headers,
  header: string,
  fallback: string
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly detail: string } {
  const raw = headers.get(header);
  if (raw === null) return { ok: true, value: fallback };

  const value = raw.trim();
  if (value.length > MAX_DEVELOPMENT_IDENTIFIER_LENGTH || !DEVELOPMENT_IDENTIFIER.test(value)) {
    return {
      ok: false,
      /*
       * The LENGTH and the header name, never the value. The rule
       * `profile-creation.ts` applies to an over-long field applies here for the
       * same reason: echoing an unbounded header into a refusal moves the
       * unbounded string into the log aggregator.
       */
      detail: `${header} is ${String(value.length)} characters and must be a lower-case, hyphen-separated token of at most ${String(MAX_DEVELOPMENT_IDENTIFIER_LENGTH)}`
    };
  }
  return { ok: true, value };
}

/**
 * The identity a development request acts as.
 *
 * Takes the witness, so a deployment cannot obtain an identity here: it cannot
 * be issued one, and a value it manufactured instead is refused rather than
 * accepted on the strength of its type. The witness's ISSUANCE is checked below,
 * by identity; the `NODE_ENV` it carries is then read
 * for the trail and is never re-tested against the allowlist, because which name
 * means "not a deployment" was decided by the mint and is not this file's
 * question.
 *
 * The session id defaults to a value DERIVED from the account id rather than to
 * a constant, so two development accounts do not share one row in
 * `active_profile_selection` -- which is keyed by session and would otherwise
 * make one household's profile choice reselect the other's.
 *
 * THE FORGERY REFUSAL REUSES `authentication_not_configured` RATHER THAN NAMING
 * A THIRD REASON, and the constraint is worth stating. This union is published:
 * `accountRefusalCode` in `db/request-context.ts` widens it into
 * `RequestContextReasonCode` by identity, and the three route groups'
 * `contract.ts` files enumerate every code they can answer, so a new member is
 * an API-contract change across files this lane does not own. It is also the
 * right one of the two that exist: `development_identifier_malformed` names a
 * header and is classified as the CALLER's fault by
 * `contextRefusalIsClientFault`, and nothing on the wire can reach this
 * parameter. What is left is the fact itself -- this process has not been shown
 * to be a non-deployment, so it has no way to identify anybody -- which is
 * exactly what `authentication_not_configured` says. The DETAIL names the
 * forgery, and does not repeat the deployment branch's remedy, because wiring an
 * auth instance is not the remedy for a manufactured capability.
 */
export function developmentAccount(
  environment: NonDeploymentEnvironment,
  headers: Headers
): RequestAccountResolution {
  /*
   * THE FIRST THING THIS FUNCTION DOES, before a header is read and before
   * `nodeEnv` is read off the witness -- the ordering `createFixtureProvider`
   * documents. It matters here in a way a reader can check: a forged capability
   * arriving with a malformed development header is told about the capability,
   * not about the header, so the refusal names the fault that actually blocks
   * the request.
   */
  if (!isClassifiedRuntime(environment)) {
    return {
      ok: false,
      reason: "authentication_not_configured",
      detail:
        "the runtime classification handed to developmentAccount was not issued by " +
        "@liberty/contracts/shared/runtime, so nothing has shown this process is not a " +
        "deployment and no development identity is granted; a cast or a spread copy carries " +
        "the capability's brand but not the decision behind it"
    };
  }

  const account = developmentIdentifier(
    headers,
    DEVELOPMENT_ACCOUNT_HEADER,
    DEFAULT_DEVELOPMENT_ACCOUNT_ID
  );
  if (!account.ok) {
    return { ok: false, reason: "development_identifier_malformed", detail: account.detail };
  }

  const session = developmentIdentifier(
    headers,
    DEVELOPMENT_SESSION_HEADER,
    `${account.value}-session`
  );
  if (!session.ok) {
    return { ok: false, reason: "development_identifier_malformed", detail: session.detail };
  }

  return {
    ok: true,
    account: { userId: account.value, sessionId: session.value },
    detail: `development account ${account.value} on session ${session.value}, admitted by NODE_ENV=${environment.nodeEnv}`
  };
}

/**
 * Who is making this request.
 *
 * The classification is read at CALL time rather than at module scope, matching
 * `resolveAuthorizedCandidates`: a module-scope read freezes the answer to
 * whatever the process looked like when the first route was loaded, which in a
 * serverless cold start is not necessarily the request's environment.
 *
 * `environment` IS THE CAPABILITY OR `null`, AND NEVER A RUNTIME NAME. It used
 * to be a `nodeEnv` string forwarded to `classify`, so a caller could state the
 * environment it wished to be treated as and receive a real capability for it --
 * a development identity in a process that was not a development one. The
 * parameter that remains cannot do that: the default reads the process, `null`
 * is how a test asks for the deployment branch, and the granting case can only
 * be a value the mint issued -- which `developmentAccount` establishes by asking
 * the registry rather than by trusting the parameter's type. It is still not a
 * request input either: nothing on the wire reaches it.
 *
 * THE `null` BRANCH CANNOT BE DROPPED. The parameter is
 * `NonDeploymentEnvironment | null` and `developmentAccount` takes the non-null
 * type, so removing it does not widen the gate -- it fails to compile.
 */
export function resolveRequestAccount(
  request: Request,
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): RequestAccountResolution {
  if (environment === null) {
    return {
      ok: false,
      reason: "authentication_not_configured",
      detail:
        "no authentication instance is constructed in this app: @liberty/auth/server is not wired to a route handler, so this deployment cannot identify an account"
    };
  }
  return developmentAccount(environment, request.headers);
}
