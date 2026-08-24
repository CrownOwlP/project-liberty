import { z } from "zod";

/* -------------------------------------------------------------------------
 * Auth configuration, validated before anything is constructed
 *
 * The seam's inputs. Everything the vendor library needs that the environment
 * supplies passes through this schema first, so a misconfiguration fails at
 * start-up with a named field rather than at the first sign-in attempt with a
 * stack trace from inside a dependency.
 *
 * `zod` owns contracts in this repository, so this is a zod schema rather than a
 * hand-rolled check, and the TYPE is inferred from the schema rather than
 * declared next to it. Two declarations of one shape is precisely the drift this
 * codebase has already been bitten by.
 * ---------------------------------------------------------------------- */

/**
 * Session lifetimes, in seconds.
 *
 * Bounded on both sides. An upper bound because a session that outlives the
 * device it was created on is the thing database sessions exist to be able to
 * revoke; a lower bound because a session shorter than a feature film would sign
 * a viewer out mid-playback, which is how "just make it shorter" quietly becomes
 * a playback bug.
 */
const SESSION_SECONDS_MIN = 60 * 60 * 4;
const SESSION_SECONDS_MAX = 60 * 60 * 24 * 30;

export const libertyAuthConfigSchema = z.object({
  /**
   * PostgreSQL connection string. Never logged, never included in a reason
   * trail -- it carries the password.
   */
  databaseUrl: z.string().url("databaseUrl must be a URL"),
  /**
   * The origin the browser sees. Better Auth uses it for cookie and callback
   * construction, so a wrong value produces cookies that silently do not stick.
   */
  baseUrl: z.string().url("baseUrl must be an absolute URL"),
  /**
   * Signing secret. Length is asserted rather than assumed: a short secret is a
   * configuration mistake that produces a WORKING system, which is the worst
   * kind, because nothing fails until somebody forges a cookie.
   */
  secret: z.string().min(32, "secret must be at least 32 characters"),
  sessionExpiresInSeconds: z
    .number()
    .int()
    .min(SESSION_SECONDS_MIN)
    .max(SESSION_SECONDS_MAX)
    .default(60 * 60 * 24 * 14),
  /**
   * How often an in-use session's expiry is pushed forward. Must be shorter than
   * the lifetime or a session can never be refreshed before it dies.
   */
  sessionUpdateAgeSeconds: z.number().int().min(60).default(60 * 60 * 24),
  /**
   * Whether an unverified address may sign in.
   *
   * Defaults to requiring verification. The opposite default is convenient in
   * development and is how an unverified-account hole reaches production.
   */
  requireEmailVerification: z.boolean().default(true),
  /**
   * Trusted origins for cross-origin requests. An allowlist, empty by default:
   * an empty allowlist fails closed, and `["*"]` cannot be expressed here at all.
   */
  trustedOrigins: z.array(z.string().url()).default([])
});

export type LibertyAuthConfigInput = z.input<typeof libertyAuthConfigSchema>;
export type LibertyAuthConfig = z.output<typeof libertyAuthConfigSchema>;

export type ConfigResolution =
  | { readonly ok: true; readonly config: LibertyAuthConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validate configuration, returning problems rather than throwing.
 *
 * A returned result rather than an exception because the caller is start-up
 * code that wants to report EVERY misconfiguration at once. Fixing one
 * environment variable per restart is a bad way to spend a deployment.
 *
 * Pure: the schema's cross-field rule below is checked here rather than as a
 * `superRefine`, so the failure text says which two fields disagree instead of
 * naming the object.
 */
export function resolveAuthConfig(input: unknown): ConfigResolution {
  const parsed = libertyAuthConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .sort()
    };
  }

  const config = parsed.data;
  if (config.sessionUpdateAgeSeconds >= config.sessionExpiresInSeconds) {
    return {
      ok: false,
      problems: [
        "sessionUpdateAgeSeconds: must be shorter than sessionExpiresInSeconds, or an active session can never be refreshed before it expires"
      ]
    };
  }

  return { ok: true, config };
}
