/* -------------------------------------------------------------------------
 * The enabled authentication surface, written down as data (PL-0401)
 *
 * `docs/RESEARCH_IDENTITY.md` rules for a deliberately SMALL surface: ordinary
 * account authentication, verification and reset, database sessions -- and no
 * SSO/SCIM/organisation/device/MCP plugin stack. The stated reason matters more
 * than the list: Better Auth has recently done substantial security hardening in
 * precisely those advanced surfaces, which is an argument for not enabling what
 * we do not need rather than for waiting until it settles.
 *
 * The list lives here, as data, rather than being implied by which options
 * happen to be set in `better-auth.ts`. An option object read top to bottom does
 * not say what is DELIBERATELY off -- absence and oversight look identical --
 * and `assertSurfaceIsMinimal` below turns that difference into a test failure.
 *
 * This module imports nothing from `better-auth`. It is a policy statement about
 * the configuration, and it must stay checkable without loading the library.
 * ---------------------------------------------------------------------- */

/**
 * The capabilities Liberty turns on. Every entry is here because a product
 * requirement names it, and adding one is a change to this constant plus a
 * security review, not a line buried in an options object.
 */
export const ENABLED_AUTH_CAPABILITIES = [
  /** Email + password sign-up and sign-in. The whole of Liberty's identity requirement today. */
  "email_password",
  /** Address verification. Without it a typo becomes an unrecoverable account. */
  "email_verification",
  /** Self-service password reset. Its absence is a support burden, not a security posture. */
  "password_reset",
  /**
   * Server-side session records in PostgreSQL. The research names this
   * specifically: a database session can be REVOKED, and a stateless
   * encrypted-cookie session cannot be, which is the property that matters when
   * a household shares a screen.
   */
  "database_sessions"
] as const;

export type EnabledAuthCapability = (typeof ENABLED_AUTH_CAPABILITIES)[number];

/**
 * Plugin families that must stay off, and why each one is a liability rather
 * than merely unused.
 *
 * A denylist here is not the security boundary -- the security boundary is that
 * `better-auth.ts` passes no `plugins` array at all. This is the ARTEFACT that
 * makes a future addition visible in review, which a missing line never is.
 */
export const WITHHELD_AUTH_PLUGIN_FAMILIES = {
  /** Enterprise federation. Liberty has no tenant that owns an identity provider. */
  sso: "No enterprise identity provider federates into Liberty; enabling SSO adds an assertion-parsing attack surface with no consumer.",
  /** Directory provisioning. */
  scim: "There is no directory to provision from. Consumer accounts are self-service.",
  /**
   * Organisation/teams. The tempting one, because a household LOOKS like an
   * organisation -- and it is the wrong shape. A household is one account with
   * several viewer profiles, which is PL-0402's model and is strictly simpler
   * than membership, roles and invitations.
   */
  organization:
    "A household is one account with several profiles, not a tenant with members; modelling it as an organisation imports invitations, roles and cross-tenant access checks Liberty never needs.",
  /** Device authorization grant. */
  device:
    "No headless-device sign-in flow is shipped yet; the device grant is a polling endpoint that is only safe when its rate limiting and code entropy are actively reviewed.",
  /** Model Context Protocol / machine agent auth. */
  mcp: "Liberty exposes no agent-facing authenticated API; enabling it would create credentials with no consumer and no revocation story.",
  /** Second factor. Withheld, not rejected -- see below. */
  two_factor:
    "Not a rejection: 2FA is a plausible future requirement, but it is a product decision with recovery-code, lockout and support consequences that must be designed before it is switched on."
} as const;

export type WithheldAuthPluginFamily = keyof typeof WITHHELD_AUTH_PLUGIN_FAMILIES;

/** A description of what a built auth instance actually enabled. */
export interface AuthSurfaceReport {
  readonly capabilities: readonly string[];
  readonly pluginIds: readonly string[];
}

/**
 * What `createLibertyAuth` actually turns on, in the vocabulary
 * `findSurfaceViolations` checks.
 *
 * WRITTEN BY HAND, NOT DERIVED FROM `ENABLED_AUTH_CAPABILITIES`. That is the
 * whole value of it: a report computed from the allowlist agrees with the
 * allowlist by construction, so the check would pass forever and the suite would
 * be decoration. This list is a second, independent reading -- of
 * `createLibertyAuth`'s option object -- and the check is whether the two
 * readings agree. It is also not reflected off the built instance, because that
 * would report whatever the library believes, and the question being asked is
 * whether OUR configuration matches OUR policy.
 *
 * IT LIVES HERE RATHER THAN NEXT TO THE VENDOR CALL, and it used to live there.
 * `better-auth.ts` states that nothing in it is unit-tested, for a good reason:
 * every assertion available without PostgreSQL would be an assertion about a
 * stub of Better Auth's behaviour. This function was the one exception in that
 * file -- it is a statement about our own data and needs no library at all --
 * and being in the file nobody tests is how its defect survived: it reported
 * `email_verification` only when `config.requireEmailVerification` was true.
 *
 * WHY THAT WAS WRONG. `createLibertyAuth` wires
 * `emailVerification.sendVerificationEmail` UNCONDITIONALLY.
 * `requireEmailVerification` governs whether an unverified address may sign IN
 * -- enforcement -- not whether the verification capability exists. So with
 * verification not required, the surface report omitted a capability that was
 * switched on. That is an UNDERSTATEMENT, and understatements are the silent
 * direction here: `findSurfaceViolations` only ever complains about capabilities
 * that are present, so a capability missing from the report is never checked
 * against the allowlist at all. The day `email_verification` is deliberately
 * withdrawn from `ENABLED_AUTH_CAPABILITIES`, the code would still be sending
 * verification mail and the assertion would still pass.
 *
 * NO PARAMETER, WHICH IS THE HONEST SIGNATURE. It took a `LibertyAuthConfig`,
 * and after the fix no capability varies with configuration -- every option in
 * `createLibertyAuth` that turns something on is unconditional. A parameter read
 * on no path is the same defect one level up: a signature claiming the report
 * depends on the configuration when it does not. If an option is ever added that
 * genuinely gates a capability, the parameter comes back together with the
 * branch that reads it.
 *
 * A FRESH OBJECT rather than a shared constant, so a caller cannot mutate the
 * arrays out from under the next caller -- `.sort()` mutates in place, and a
 * shared array is one caller's sort away from changing what the next one sees.
 *
 * `.sort()` rather than writing the list in order: the order then does not
 * depend on where somebody adds the next entry, so the report is byte-stable
 * across edits that do not change WHAT is enabled.
 */
export function describeConfiguredSurface(): AuthSurfaceReport {
  return {
    capabilities: [
      "email_password",
      "email_verification",
      "password_reset",
      "database_sessions"
    ].sort(),
    // No `plugins` key is passed to `betterAuth` at all -- not an empty array.
    // This empty list is the assertion of that, in the form the check reads.
    pluginIds: []
  };
}

export type SurfaceViolation =
  | { readonly kind: "unlisted_capability"; readonly detail: string }
  | { readonly kind: "withheld_plugin_enabled"; readonly detail: string }
  | { readonly kind: "unreviewed_plugin_enabled"; readonly detail: string };

/**
 * Check a built configuration against the policy above.
 *
 * Returns violations rather than throwing, and returns ALL of them rather than
 * the first, because the caller is a start-up assertion and a review gate and
 * both want the complete picture in one pass.
 *
 * Determinism: violations come back in a fixed order derived from the policy
 * constants and then from the sorted report, never from object iteration order,
 * so the same configuration always produces a byte-identical result.
 */
export function findSurfaceViolations(report: AuthSurfaceReport): readonly SurfaceViolation[] {
  const violations: SurfaceViolation[] = [];
  const allowed = new Set<string>(ENABLED_AUTH_CAPABILITIES);

  for (const capability of [...report.capabilities].sort()) {
    if (!allowed.has(capability)) {
      violations.push({
        kind: "unlisted_capability",
        detail: `${capability} is enabled but is not in ENABLED_AUTH_CAPABILITIES`
      });
    }
  }

  const enabledPlugins = new Set(report.pluginIds);
  for (const family of Object.keys(WITHHELD_AUTH_PLUGIN_FAMILIES).sort()) {
    if (enabledPlugins.has(family)) {
      violations.push({
        kind: "withheld_plugin_enabled",
        detail: `${family} is withheld: ${WITHHELD_AUTH_PLUGIN_FAMILIES[family as WithheldAuthPluginFamily]}`
      });
    }
  }

  for (const pluginId of [...report.pluginIds].sort()) {
    if (pluginId in WITHHELD_AUTH_PLUGIN_FAMILIES) continue;
    // Anything at all. The ruling is "no plugin stack", so an unrecognised
    // plugin is a violation by default rather than by name -- a denylist would
    // pass every plugin published after this file was written.
    violations.push({
      kind: "unreviewed_plugin_enabled",
      detail: `${pluginId} was not reviewed; the enabled surface is an allowlist and it is currently empty`
    });
  }

  return violations;
}

/**
 * The version of Better Auth this surface was reviewed against.
 *
 * Better Auth's published security policy supports ONLY the latest version
 * (https://github.com/better-auth/better-auth/blob/main/SECURITY.md), which is
 * why `package.json` exact-pins rather than floating a caret range: a caret
 * would let a version arrive that nobody reviewed, and a pin that nobody bumps
 * would leave us on a version upstream no longer patches. Both failure modes are
 * real; the pin is the one that is VISIBLE. Bumping this constant and the pin
 * together is security-sensitive work and requires the security-review gate.
 *
 * "TOGETHER" IS NOW ASSERTED. Until this audit the sentence above was the only
 * thing holding the two in agreement, and a comment cannot fail: a `npm update`
 * or a hand-edited `package.json` would have moved the dependency while this
 * constant went on claiming a version had been reviewed that was no longer
 * installed -- the pin still LOOKING like the artefact that makes an upgrade a
 * reviewed event while having quietly stopped being one.
 * `enabled-surface.test.ts` reads `package.json` and asserts both
 * `better-auth` and `@better-auth/drizzle-adapter` equal this string, so the
 * bump is now mechanically all-or-nothing.
 */
export const REVIEWED_BETTER_AUTH_VERSION = "1.7.1";
