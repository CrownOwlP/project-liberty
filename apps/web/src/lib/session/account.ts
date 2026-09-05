import type { AccountIdentity } from "@liberty/auth";
import { NonDeploymentEnvironment } from "../../app/api/deployment-environment";

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
 * same nominal witness `fixtureProvider` and the in-memory repository require,
 * its constructor is private, and `classify` answers `null` for every `NODE_ENV`
 * outside the `development`/`test` allowlist. The day sign-in exists, this module
 * grows a third branch that reads the verified session and the development branch
 * keeps the gate it already has.
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
 * Takes the witness, so it cannot be called from a deployment. `environment` is
 * read for the `NODE_ENV` it reports and is never re-tested.
 *
 * The session id defaults to a value DERIVED from the account id rather than to
 * a constant, so two development accounts do not share one row in
 * `active_profile_selection` -- which is keyed by session and would otherwise
 * make one household's profile choice reselect the other's.
 */
export function developmentAccount(
  environment: NonDeploymentEnvironment,
  headers: Headers
): RequestAccountResolution {
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
 * `nodeEnv` defaults to that read and exists for the reason
 * `NonDeploymentEnvironment.classify`'s own parameter does: a test states the
 * environment it means instead of mutating `process.env` and racing every other
 * suite in the same worker. It is not a configuration switch -- nothing but a
 * test passes it, and passing `"development"` in a hosted process would require
 * editing a caller rather than setting a variable.
 *
 * THE `null` BRANCH CANNOT BE DROPPED. `classify` returns
 * `NonDeploymentEnvironment | null` and `developmentAccount` takes the non-null
 * type, so removing it does not widen the gate -- it fails to compile.
 */
export function resolveRequestAccount(
  request: Request,
  nodeEnv: string | undefined = process.env.NODE_ENV
): RequestAccountResolution {
  const environment = NonDeploymentEnvironment.classify(nodeEnv);
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
