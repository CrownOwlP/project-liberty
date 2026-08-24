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
 */
export const REVIEWED_BETTER_AUTH_VERSION = "1.7.1";
