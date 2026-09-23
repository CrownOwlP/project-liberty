import { resolveAuthConfig, type LibertyAuthConfig } from "@liberty/auth";
import {
  assertSurfaceIsMinimal,
  createLibertyAuth,
  describeConfiguredSurface,
  type LibertyAuth
} from "@liberty/auth/server";
import { betterAuthSchema } from "@liberty/persistence";

import { DATABASE_URL_VARIABLE, resolveRepository } from "../db";

/* -------------------------------------------------------------------------
 * The composition root for authentication (PW-0403)
 *
 * `@liberty/auth/server` has shipped a reviewed Better Auth seam since PL-0401
 * and NOTHING CONSTRUCTED IT. `apps/web/src/lib/session/account.ts` said so in
 * its own header -- "there is no `app/api/auth/[...all]` route handler, no
 * configured baseUrl, secret or mail transport" -- and answered every
 * deployment request `authentication_not_configured`. That is the residual
 * gpt-architect named when approving PW-0402, and this module is the half of it
 * that builds the instance.
 *
 * ADOPTED, NOT REPLACED. Everything opinionated already exists elsewhere and is
 * reviewed: `resolveAuthConfig` validates secret length, session bounds, the
 * base URL and the trusted-origin allowlist; `createLibertyAuth` is the one
 * place `better-auth` is imported; `assertSurfaceIsMinimal` refuses a surface
 * wider than `ENABLED_AUTH_CAPABILITIES`. This file reads the environment,
 * hands those functions their inputs in the right order, and caches the result.
 * It makes no security decision of its own, and it must not start.
 *
 * IT NEVER THROWS AND IT NEVER IMPORTS AT MODULE SCOPE ANYTHING THAT DOES. A
 * composition root that throws on import takes down every route in the
 * application including the ones that do not need authentication -- the home
 * page, the catalog, the health check -- and it does it with a stack trace
 * rather than a reason. Every failure below is a value with a reason code that
 * `resolveRequestAccount` can turn into a refusal a client can read.
 *
 * THE ENVIRONMENT IS READ AT CALL TIME, never at module scope. That is the rule
 * `resolveRepository` and `NonDeploymentEnvironment.classify` already follow,
 * and the reason is the same: a module-scope read freezes the answer to whatever
 * the process looked like when the first route was loaded, which in a desktop
 * sidecar is before the launcher has finished configuring it.
 * ---------------------------------------------------------------------- */

/** Environment variables this module reads. Named once, so a refusal can cite them. */
export const AUTH_SECRET_VARIABLE = "LIBERTY_AUTH_SECRET";
export const AUTH_BASE_URL_VARIABLE = "LIBERTY_AUTH_BASE_URL";
export const AUTH_TRUSTED_ORIGINS_VARIABLE = "LIBERTY_AUTH_TRUSTED_ORIGINS";
export const AUTH_SESSION_SECONDS_VARIABLE = "LIBERTY_AUTH_SESSION_SECONDS";
export const AUTH_REQUIRE_EMAIL_VERIFICATION_VARIABLE =
  "LIBERTY_AUTH_REQUIRE_EMAIL_VERIFICATION";

/**
 * Why no auth instance exists.
 *
 * ONE REASON, not four, and the split that matters is drawn elsewhere.
 * `RequestAccountRefusalReason` already distinguishes "this deployment cannot
 * identify anybody" from "this request is not authenticated", and every member
 * below is the first of those: a missing secret, an unusable store and a
 * misconfigured base URL all leave the process unable to authenticate ANY
 * request, and all have the same remedy shape -- an operator fixes
 * configuration. What differs is the DETAIL, which names the variable or the
 * store, and that is where an operator is actually sent.
 */
export type AuthInstanceRefusal = {
  readonly ok: false;
  /** Never empty, and never contains a secret or a connection string. */
  readonly detail: string;
};

export type AuthInstanceResolution =
  | { readonly ok: true; readonly auth: LibertyAuth; readonly config: LibertyAuthConfig }
  | AuthInstanceRefusal;

function refuse(detail: string): AuthInstanceRefusal {
  return { ok: false, detail };
}

/**
 * Read a positive integer from the environment, or `undefined` to take the
 * schema's default.
 *
 * `undefined` rather than a local default, so there is exactly one default per
 * field and it lives in `libertyAuthConfigSchema` beside the bounds that
 * constrain it. A second default here would be a second thing to keep in step,
 * and the one that drifted would be invisible.
 *
 * A value that is present and NOT a positive integer is returned as `NaN`
 * rather than silently ignored: the schema refuses it and names the field,
 * which is the whole point of validating configuration. Falling back to the
 * default on a typo is how `LIBERTY_AUTH_SESSION_SECONDS=1209600s` becomes a
 * fourteen-day session nobody asked for.
 */
function optionalInteger(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * Read a boolean, accepting only two spellings.
 *
 * Not `Boolean(raw)`, and not `raw !== "false"`. Both of those turn
 * `LIBERTY_AUTH_REQUIRE_EMAIL_VERIFICATION=no` into `true` and
 * `...=0` into either answer depending on which you picked, and the field
 * decides whether an unverified address may sign in. An unrecognised value
 * returns `undefined` here and the caller refuses, naming the variable.
 */
function strictBoolean(
  raw: string | undefined
): { readonly ok: true; readonly value: boolean | undefined } | { readonly ok: false } {
  if (raw === undefined) return { ok: true, value: undefined };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return { ok: true, value: undefined };
  if (trimmed === "true") return { ok: true, value: true };
  if (trimmed === "false") return { ok: true, value: false };
  return { ok: false };
}

/**
 * Trusted origins, comma-separated.
 *
 * Empty by default, which fails closed, and `*` cannot be expressed -- the
 * schema requires each entry to be a URL, so a wildcard is a validation error
 * rather than a permission. That property belongs to the schema; this function
 * only splits.
 */
function trustedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Mail delivery.
 *
 * `createLibertyAuth` requires this with no default, and its comment gives both
 * reasons: a default that dropped mail would make `requireEmailVerification`
 * unsatisfiable in a way that looks like a user problem, and a default that
 * logged the link would put a one-click account-takeover token in the log
 * aggregator. NEITHER IS WHAT THIS DOES. It rejects, so the operation fails
 * loudly at the point of sending with a message naming the missing capability,
 * and no link is created, logged or discarded.
 *
 * A REAL TRANSPORT IS NOT THIS TASK. PW-0403 owns session resolution; wiring
 * SMTP is an operator concern with its own credentials, and inventing one here
 * would be the "provider" mistake this project has already declined once. The
 * consequence is stated rather than hidden: until a transport is configured,
 * sign-up with `requireEmailVerification: true` cannot complete, and password
 * reset cannot start. That is a true statement about this deployment, and it is
 * in `docs/SECURITY.md`.
 */
async function noMailTransport(message: { readonly to: string }): Promise<void> {
  void message.to;
  throw new Error(
    "no mail transport is configured for @liberty/auth, so verification and password-reset " +
      "messages cannot be delivered; configure one before enabling flows that depend on them"
  );
}

let cached: { readonly key: string; readonly resolution: AuthInstanceResolution } | null = null;

/**
 * Build the instance from explicit inputs, with no caching and no environment read.
 *
 * Exported so every branch can be tested without mutating `process.env` and
 * racing every other suite in the same worker -- the same reason
 * `selectRepository` is exported beside `resolveRepository`.
 */
export function selectAuthInstance(input: {
  /**
   * The same `DATABASE_URL` value the repository was selected from.
   *
   * PASSED IN RATHER THAN READ OFF THE HANDLE, because `DatabaseHandle` carries
   * `db` and `pool` and no connection string -- and adding one would put the
   * password on a widely-passed object in a package this task does not own.
   * `resolveAuthInstance` reads the variable once and gives the same value to
   * both, in the same call, so the two cannot diverge within a request. What
   * WOULD break that is a caller that resolves the repository and then changes
   * the variable before calling this; the assertion below is what catches it.
   */
  readonly databaseUrl: string | undefined;
  readonly secret: string | undefined;
  readonly baseUrl: string | undefined;
  readonly trustedOrigins: readonly string[];
  readonly sessionExpiresInSeconds: number | undefined;
  readonly requireEmailVerification: boolean | undefined;
  readonly repository: ReturnType<typeof resolveRepository>;
}): AuthInstanceResolution {
  /*
   * THE STORE IS CHECKED FIRST, before configuration, because its failure is
   * the one that cannot be fixed by editing an environment variable that this
   * module names. A deployment with no DATABASE_URL gets the repository layer's
   * own detail, which already says what to set, rather than a complaint about
   * an auth secret it will need to set afterwards anyway.
   */
  if (!input.repository.ok)
    return refuse(
      `no authentication instance: the store is unavailable (${input.repository.detail})`
    );
  const configuredUrl = (input.databaseUrl ?? "").trim();
  const handle = input.repository.handle;
  if (handle !== null && configuredUrl === "")
    /*
     * A PostgreSQL repository exists and this call was given no connection
     * string, which means the two were resolved from different reads of the
     * environment. Refusing is the only safe answer: continuing would either
     * fail schema validation with a confusing message or, worse, succeed against
     * a different database than the one holding the profiles.
     */
    return refuse(
      `no authentication instance: the store is PostgreSQL but ${DATABASE_URL_VARIABLE} was not ` +
        `supplied to the auth instance, so the two were resolved from different reads of the ` +
        `environment and could point at different databases`
    );
  if (handle === null)
    return refuse(
      "no authentication instance: the selected store is the in-memory development adapter, " +
        "which executes no SQL and does not survive the process, so the database-backed " +
        "sessions this design requires cannot live in it"
    );

  const resolution = resolveAuthConfig({
    /*
     * The connection string is read from the repository's own resolution rather
     * than from the environment a second time, so the auth instance and the
     * repository cannot end up pointed at different databases -- which would
     * produce a session that verifies against one store and a profile that does
     * not exist in the other.
     */
    databaseUrl: input.databaseUrl,
    baseUrl: input.baseUrl,
    secret: input.secret,
    ...(input.sessionExpiresInSeconds === undefined
      ? {}
      : { sessionExpiresInSeconds: input.sessionExpiresInSeconds }),
    ...(input.requireEmailVerification === undefined
      ? {}
      : { requireEmailVerification: input.requireEmailVerification }),
    trustedOrigins: [...input.trustedOrigins]
  });

  if (!resolution.ok)
    /*
     * EVERY problem, not the first, because `resolveAuthConfig` collects them
     * for exactly this reason: fixing one variable per restart is a bad way to
     * spend a deployment. The problems name fields and never values -- the
     * schema's own comments require that of `databaseUrl` and `secret` -- so
     * this detail carries no credential.
     */
    return refuse(
      `no authentication instance: configuration is invalid (${resolution.problems.join("; ")})`
    );

  const config = resolution.config;

  let auth: LibertyAuth;
  try {
    auth = createLibertyAuth({
      config,
      database: handle.db,
      schema: betterAuthSchema,
      sendMail: noMailTransport
    });
  } catch (error) {
    /*
     * The vendor constructor is the one call here that can throw for reasons
     * this module did not anticipate. Its message is reported and nothing else:
     * the options object contains the secret and the connection string, so a
     * stack or a dump would publish both.
     */
    return refuse(
      `no authentication instance: the auth library refused the reviewed configuration ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }

  try {
    /*
     * THE SURFACE IS ASSERTED AFTER CONSTRUCTION AND BEFORE THE INSTANCE IS
     * HANDED OUT. `assertSurfaceIsMinimal` exists because a package that throws
     * on import cannot be tested, so somebody has to call it -- and the only
     * somebody is a composition root. Skipping it would leave the whole
     * enabled-surface policy as documentation.
     */
    assertSurfaceIsMinimal(describeConfiguredSurface());
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  return { ok: true, auth, config };
}

/**
 * The auth instance for this process.
 *
 * Cached for the reason `resolveRepository`'s cache exists: rebuilding it per
 * request would rebuild the adapter over the same pool on every call, and the
 * instance holds the configuration a session cookie was signed against.
 *
 * Keyed by the inputs that would change it, EXCLUDING the secret's value --
 * a length-bounded fingerprint is not worth the risk of holding the secret in
 * a second place, and a deployment that rotates its secret restarts. The key is
 * never logged.
 */
export function resolveAuthInstance(): AuthInstanceResolution {
  const secret = process.env[AUTH_SECRET_VARIABLE];
  const baseUrl = process.env[AUTH_BASE_URL_VARIABLE];
  const originsRaw = process.env[AUTH_TRUSTED_ORIGINS_VARIABLE];
  const sessionRaw = process.env[AUTH_SESSION_SECONDS_VARIABLE];
  const verifyRaw = process.env[AUTH_REQUIRE_EMAIL_VERIFICATION_VARIABLE];

  /*
   * READ ONCE, USED TWICE. `resolveRepository` reads the same variable
   * internally and caches on it, so taking the value here and passing it to
   * `selectAuthInstance` is what makes "the same database" a fact rather than a
   * hope. The value is a credential: it goes into the cache key below only as
   * the words "postgres" or "memory", never as itself.
   */
  const databaseUrl = process.env[DATABASE_URL_VARIABLE];
  const repository = resolveRepository();
  const key = [
    baseUrl ?? "",
    originsRaw ?? "",
    sessionRaw ?? "",
    verifyRaw ?? "",
    secret === undefined ? "unset" : "set",
    repository.ok ? (repository.handle === null ? "memory" : "postgres") : `refused:${repository.reason}`
  ].join("\u0000");

  const existing = cached;
  if (existing !== null && existing.key === key) return existing.resolution;

  const verification = strictBoolean(verifyRaw);
  const resolution = verification.ok
    ? selectAuthInstance({
        databaseUrl,
        secret,
        baseUrl,
        trustedOrigins: trustedOrigins(originsRaw),
        sessionExpiresInSeconds: optionalInteger(sessionRaw),
        requireEmailVerification: verification.value,
        repository
      })
    : refuse(
        `no authentication instance: ${AUTH_REQUIRE_EMAIL_VERIFICATION_VARIABLE} must be exactly ` +
          `"true" or "false"; an unrecognised value is refused rather than read as either, because ` +
          `this field decides whether an unverified address may sign in`
      );

  cached = { key, resolution };
  return resolution;
}
