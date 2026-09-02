import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { LibertyAuthConfig } from "./config";
import {
  ENABLED_AUTH_CAPABILITIES,
  type AuthSurfaceReport,
  findSurfaceViolations
} from "./enabled-surface";

/* -------------------------------------------------------------------------
 * The ONLY module in Liberty that imports `better-auth`
 *
 * This is the whole point of `packages/auth`. Everything else in the repository
 * imports `@liberty/auth` and sees `LibertySession`, `ProfileScope` and a
 * reasoned authorization decision -- none of which are vendor types. Replacing
 * the library is then a rewrite of this file rather than a search across
 * `apps/web`, and, more immediately, it means the profile model in
 * `session.ts` never acquires a dependency on the identity library's idea of
 * what a user is.
 *
 * `eslint`/review rule in spirit: an `import ... from "better-auth"` anywhere
 * outside this file is a boundary violation. The package's `exports` map does
 * not re-export the library, so a caller has to reach for the dependency
 * directly to break it, which is visible in their own `package.json`.
 *
 * NEXT.JS. Better Auth 1.7.1 declares `next` as an optional peer in the
 * `^14 || ^15 || ^16` range and ships a `better-auth/next-js` entry point, so
 * App Router support is current. That entry point is imported by the ROUTE
 * HANDLER in `apps/web`, not here: this package must stay buildable and
 * testable without Next installed, and pulling a framework integration into a
 * domain package is how a "framework-agnostic" seam stops being one.
 *
 * NOTHING IN THIS FILE IS UNIT-TESTED, and that is deliberate rather than an
 * omission. Every assertion available without a PostgreSQL instance would be an
 * assertion about a stub of Better Auth's own behaviour, which proves nothing.
 * The parts worth testing -- configuration validation, the enabled surface, and
 * profile authorization -- were moved OUT of this file precisely so they could
 * be tested for real. `describeConfiguredSurface` was left behind by that move
 * and has since followed it; the defect it was carrying is recorded at the
 * re-export below, and the general lesson is that a testable function in an
 * untestable file is a function nobody checks.
 * ---------------------------------------------------------------------- */

/**
 * The database handle, typed from the adapter rather than from `drizzle-orm`.
 *
 * Derived so that this package does not have to name a Drizzle type and
 * therefore does not have to agree with `@liberty/persistence` on a version of
 * one. The dependency direction is one-way on purpose: persistence depends on
 * auth for `ProfileScope`, and auth depends on nothing of persistence's.
 */
export type LibertyAuthDatabase = Parameters<typeof drizzleAdapter>[0];

/**
 * The Drizzle table objects Better Auth's core schema maps onto, supplied by
 * the caller.
 *
 * Injected rather than imported so the schema stays owned by
 * `@liberty/persistence`, which owns the migrations. One package owning both
 * the tables and the migration that creates them is the only way the auth
 * tables and the profile-scoped tables can land in a SINGLE first migration --
 * and PL-0402 requires profile scoping to be present in the first migration
 * rather than retrofitted.
 */
export type LibertyAuthSchema = NonNullable<Parameters<typeof drizzleAdapter>[1]["schema"]>;

export interface CreateLibertyAuthInput {
  readonly config: LibertyAuthConfig;
  readonly database: LibertyAuthDatabase;
  readonly schema: LibertyAuthSchema;
  /**
   * Delivery of verification and reset messages.
   *
   * Required, with no default. A default that silently dropped mail would make
   * `requireEmailVerification: true` unsatisfiable in a way that looks like a
   * user problem, and a default that logged the link to stdout would put a
   * one-click account-takeover token in the log aggregator.
   */
  readonly sendMail: (message: {
    readonly to: string;
    readonly subject: string;
    readonly url: string;
  }) => Promise<void>;
}

/**
 * The auth instance, typed from `createLibertyAuth`'s INFERRED return.
 *
 * NOT `ReturnType<typeof betterAuth>`. `betterAuth` is
 * `<Options extends BetterAuthOptions>(options: Options) => Auth<Options>`, so
 * naming it without a call instantiates `Options` at its own constraint and
 * yields `Auth<BetterAuthOptions>` -- the widest instance, not ours. `Auth` is
 * INVARIANT in that parameter (the options object is readable back off the
 * instance and is fed to the handlers), so `Auth<ourLiteralOptions>` and
 * `Auth<BetterAuthOptions>` are assignable in neither direction and declaring
 * the wide one as the return type below is TS2322.
 *
 * The alternative -- asserting the call's result into the wide type -- is
 * exactly the thing this file exists to prevent: it is the single point where
 * the vendor is constructed, so an unchecked cast here is unchecked for every
 * consumer of the seam at once.
 *
 * What callers gain and lose: they now see the PRECISE instance, which carries
 * strictly more information than `Auth<BetterAuthOptions>` did (`auth.options`
 * is the literal configuration; `auth.api` is narrowed to the endpoints this
 * configuration actually enables). Nothing that typechecked against the wide
 * type stops typechecking. What no longer typechecks is assigning some OTHER
 * `betterAuth(...)` result to `LibertyAuth` -- a hand-rolled test double has to
 * come from this factory now. That is the intended reading: there is one
 * Liberty auth configuration, and this is it.
 */
export type LibertyAuth = ReturnType<typeof createLibertyAuth>;

/**
 * Build the auth instance.
 *
 * The option object below is the enabled surface from `enabled-surface.ts`
 * expressed in the vendor's vocabulary, and nothing more. In particular there
 * is NO `plugins` array -- not an empty one, not a commented-out one. Better
 * Auth's recent security hardening has concentrated in the advanced plugin
 * surfaces, and the cheapest way to not be exposed to them is to not have the
 * key present for somebody to append to.
 *
 * The return type is deliberately UNANNOTATED -- see `LibertyAuth` above.
 * Naming it re-widens `Auth`'s invariant parameter and stops compiling; the
 * inferred type is the honest one and is what `LibertyAuth` reads back.
 */
export function createLibertyAuth(input: CreateLibertyAuthInput) {
  const { config, database, schema, sendMail } = input;

  return betterAuth({
    // `pg` because the ruling is PostgreSQL. The adapter's `provider` is what
    // decides dialect-specific SQL generation, so a mismatch here produces
    // queries that parse and then behave subtly differently.
    database: drizzleAdapter(database, { provider: "pg", schema }),

    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.requireEmailVerification,
      sendResetPassword: async ({ user, url }) => {
        await sendMail({ to: user.email, subject: "Reset your Liberty password", url });
      }
    },

    // UNCONDITIONAL, and `describeConfiguredSurface` now says so. The capability
    // -- being able to send a verification link and have it verify an address --
    // exists whatever `requireEmailVerification` is set to; that flag decides
    // only whether an UNVERIFIED address may sign in. Wiring this conditionally
    // instead would leave `requireEmailVerification: true` unsatisfiable, and
    // reporting it conditionally (which the surface report used to do)
    // understated the surface on exactly the configuration where verification is
    // optional.
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendMail({ to: user.email, subject: "Verify your Liberty address", url });
      }
    },

    session: {
      expiresIn: config.sessionExpiresInSeconds,
      updateAge: config.sessionUpdateAgeSeconds
      // No `cookieCache`. Caching the session in a signed cookie is the
      // performance win that quietly reintroduces the property database
      // sessions were chosen to avoid: a revoked session that keeps working
      // until the cache expires. If session reads are ever measured to be a
      // problem, that measurement -- not this comment -- is the argument.
    },

    user: {
      // Data minimisation: no `additionalFields`. Everything a VIEWER needs --
      // display name, avatar, preferences -- belongs to the profile, above
      // auth, and putting any of it here would both duplicate the profile and
      // hand the identity library product data it has no reason to hold.
    },

    advanced: {
      database: {
        // Application-generated ids rather than database defaults, so an id
        // exists before the insert and the same generator is used in every
        // table. `crypto.randomUUID` is available on Node 22, which
        // `package.json` already requires at the root.
        generateId: () => crypto.randomUUID()
      }
    }
  });
}

/**
 * The report of what the option object above turns on.
 *
 * RE-EXPORTED, NOT DEFINED HERE, and it used to be defined here. It is a
 * statement about our own data -- it loads no library and needs no database --
 * so it was the one function in this file that could be unit-tested, sitting in
 * the file this comment declares untestable. That is how it came to under-report
 * the surface: it made `email_verification` conditional on
 * `config.requireEmailVerification`, while the `emailVerification` option above
 * is wired unconditionally. Moved to `enabled-surface.ts`, where the policy it
 * is checked against already lives and where a test can reach it.
 *
 * The obligation the old placement was buying stays in force and is stated here
 * instead: AN EDIT TO `createLibertyAuth` THAT ENABLES SOMETHING IS AN EDIT TO
 * `describeConfiguredSurface`. The report is a hand-written second reading of
 * the option object; if it is not updated, it is simply wrong, and only a reader
 * of both can tell.
 */
export { describeConfiguredSurface } from "./enabled-surface";

/**
 * Fail start-up if the configured surface is wider than the reviewed one.
 *
 * Called by the composition root, not by this module, because a package that
 * throws on import is a package that cannot be tested.
 */
export function assertSurfaceIsMinimal(report: AuthSurfaceReport): void {
  const violations = findSurfaceViolations(report);
  if (violations.length === 0) return;
  throw new Error(
    [
      `Auth surface exceeds the reviewed policy (allowed: ${ENABLED_AUTH_CAPABILITIES.join(", ")}).`,
      ...violations.map((violation) => `  - [${violation.kind}] ${violation.detail}`)
    ].join("\n")
  );
}
