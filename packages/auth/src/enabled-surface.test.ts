import { describe, expect, it } from "vitest";
import {
  ENABLED_AUTH_CAPABILITIES,
  REVIEWED_BETTER_AUTH_VERSION,
  WITHHELD_AUTH_PLUGIN_FAMILIES,
  findSurfaceViolations
} from "./enabled-surface";

/**
 * The enabled surface (PL-0401).
 *
 * This file tests a POLICY, not a library. That is the reason it can exist
 * without PostgreSQL: the claim being checked is "our configuration is no wider
 * than the one that was reviewed", which is a statement about our own data.
 *
 * The single most valuable assertion here is the allowlist one -- a plugin
 * nobody has heard of must fail. A denylist would have passed every plugin
 * published after this file was written, which is exactly the failure mode the
 * ruling ("no SSO/SCIM/organisation/device/MCP plugin stack") is guarding
 * against.
 */

describe("findSurfaceViolations", () => {
  it("accepts the reviewed surface", () => {
    expect(
      findSurfaceViolations({ capabilities: [...ENABLED_AUTH_CAPABILITIES], pluginIds: [] })
    ).toEqual([]);
  });

  it("accepts a NARROWER surface", () => {
    // Turning something off is not a policy violation. Only widening is.
    expect(
      findSurfaceViolations({ capabilities: ["email_password", "database_sessions"], pluginIds: [] })
    ).toEqual([]);
  });

  it.each(Object.keys(WITHHELD_AUTH_PLUGIN_FAMILIES))(
    "rejects the withheld %s plugin family and says why it is withheld",
    (family) => {
      const violations = findSurfaceViolations({ capabilities: [], pluginIds: [family] });
      const withheld = violations.filter((v) => v.kind === "withheld_plugin_enabled");

      expect(withheld).toHaveLength(1);
      // The reason travels with the violation. "Plugin not allowed" tells the
      // person who enabled it nothing about whether they hit a real constraint
      // or a decision that could be revisited.
      expect(withheld[0]?.detail).toContain(family);
      expect(withheld[0]?.detail.length).toBeGreaterThan(family.length + 20);
    }
  );

  it("rejects a plugin nobody has classified, because the list is an allowlist", () => {
    const violations = findSurfaceViolations({
      capabilities: [],
      pluginIds: ["some-plugin-published-next-year"]
    });

    expect(violations).toEqual([
      {
        kind: "unreviewed_plugin_enabled",
        detail:
          "some-plugin-published-next-year was not reviewed; the enabled surface is an allowlist and it is currently empty"
      }
    ]);
  });

  it("rejects a capability that is not on the list", () => {
    const violations = findSurfaceViolations({
      capabilities: ["email_password", "passkey_autofill"],
      pluginIds: []
    });

    expect(violations).toEqual([
      {
        kind: "unlisted_capability",
        detail: "passkey_autofill is enabled but is not in ENABLED_AUTH_CAPABILITIES"
      }
    ]);
  });

  it("reports every violation at once, in an order that does not depend on input order", () => {
    const forwards = findSurfaceViolations({
      capabilities: ["zzz_unknown", "aaa_unknown"],
      pluginIds: ["organization", "sso"]
    });
    const backwards = findSurfaceViolations({
      capabilities: ["aaa_unknown", "zzz_unknown"],
      pluginIds: ["sso", "organization"]
    });

    // Six order-dependence defects so far in this codebase. A violation list
    // that reshuffles makes a review diff unreadable and a snapshot test
    // useless, so the ordering is part of the contract.
    expect(forwards).toEqual(backwards);
    // Two unlisted capabilities plus two withheld plugin families. The withheld
    // pair is NOT also counted as unreviewed -- a classified refusal and an
    // unclassified one are different findings and double-reporting would hide
    // that.
    expect(forwards.length).toBe(4);
  });
});

describe("REVIEWED_BETTER_AUTH_VERSION", () => {
  it("is an exact version, not a range", () => {
    // Better Auth supports only its latest version, so the pin is the artefact
    // that makes an upgrade a reviewed event. A caret here would defeat the
    // entire arrangement silently.
    expect(REVIEWED_BETTER_AUTH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
