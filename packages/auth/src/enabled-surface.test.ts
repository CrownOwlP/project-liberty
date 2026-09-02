import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import {
  ENABLED_AUTH_CAPABILITIES,
  REVIEWED_BETTER_AUTH_VERSION,
  WITHHELD_AUTH_PLUGIN_FAMILIES,
  describeConfiguredSurface,
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

describe("describeConfiguredSurface", () => {
  /**
   * The report is a hand-written second reading of `createLibertyAuth`'s option
   * object, and these assertions are written against that object rather than
   * against the report's own source -- otherwise the test restates the function
   * and proves nothing. Each one names the option it is reading.
   */
  it("reports exactly the four capabilities the option object turns on", () => {
    // `emailAndPassword.enabled` -> email_password;
    // `emailAndPassword.sendResetPassword` -> password_reset;
    // `emailVerification.sendVerificationEmail` -> email_verification;
    // `drizzleAdapter(..., { provider: "pg" })` with no `cookieCache`
    //   -> database_sessions.
    expect(describeConfiguredSurface().capabilities).toEqual([
      "database_sessions",
      "email_password",
      "email_verification",
      "password_reset"
    ]);
  });

  it("reports email_verification even though requireEmailVerification is a setting", () => {
    // The defect this replaced. `emailVerification.sendVerificationEmail` is
    // wired with no condition; `requireEmailVerification` decides only whether
    // an UNVERIFIED address may sign in. Reporting the capability only when
    // enforcement was on understated the surface -- and understating is the
    // silent direction, because `findSurfaceViolations` only ever complains
    // about capabilities that are PRESENT in the report.
    expect(describeConfiguredSurface().capabilities).toContain("email_verification");
    // The signature is the other half of the fix: there is no argument through
    // which a configuration could make this capability disappear. A test cannot
    // assert the absence of a parameter, so it asserts the arity, which is the
    // observable form of it.
    expect(describeConfiguredSurface.length).toBe(0);
  });

  it("reports no plugins at all, which is the ruling", () => {
    expect(describeConfiguredSurface().pluginIds).toEqual([]);
  });

  it("is deterministic and hands out a fresh object each time", () => {
    const first = describeConfiguredSurface();
    const second = describeConfiguredSurface();

    expect(first).toEqual(second);
    // Not the same object: a shared constant is one caller's `.sort()` away from
    // changing what the next caller sees.
    expect(first.capabilities).not.toBe(second.capabilities);
  });

  it("passes the policy check it exists to be fed to", () => {
    // The end-to-end claim, and the one nothing asserted while this function
    // lived in `better-auth.ts`: what we configure is within what was reviewed.
    expect(findSurfaceViolations(describeConfiguredSurface())).toEqual([]);
  });

  it("names every capability the allowlist claims, not merely a subset of them", () => {
    // The SECOND direction, and the weaker one. `findSurfaceViolations` above
    // already proves the report does not exceed the policy, which is the
    // security property; a narrower surface is explicitly not a violation. This
    // asserts the other half -- that the allowlist has no entry nothing turns on
    // -- because `ENABLED_AUTH_CAPABILITIES` documents itself as what Liberty
    // enables rather than what it is permitted to.
    //
    // IT IS THE ASSERTION TO RELAX, NOT DELETE, if a reviewed capability is ever
    // deliberately switched off: the entry then wants a comment saying so, and
    // this test wants to know about the exception.
    const reported = [...describeConfiguredSurface().capabilities].sort();
    expect(reported).toEqual([...ENABLED_AUTH_CAPABILITIES].sort());
  });
});

describe("REVIEWED_BETTER_AUTH_VERSION", () => {
  it("is an exact version, not a range", () => {
    // Better Auth supports only its latest version, so the pin is the artefact
    // that makes an upgrade a reviewed event. A caret here would defeat the
    // entire arrangement silently.
    expect(REVIEWED_BETTER_AUTH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * The constant and the dependency, checked against each other.
   *
   * The constant's comment says the two are bumped together as security-review
   * work. Nothing enforced that, so the agreement was a coincidence that held --
   * and the failure it permits is the quiet one: the dependency moves, the
   * constant goes on naming a version that was reviewed and is no longer
   * installed, and the pin keeps LOOKING like the artefact that makes an upgrade
   * a reviewed event.
   *
   * `package.json` is imported rather than read with `node:fs`. A previous audit
   * declined this test on the grounds that `packages/auth` has no `@types/node`;
   * `resolveJsonModule` is on in `tsconfig.base.json`, so the import needs no
   * Node types at all, and the JSON's own literal types make the two keys below
   * checked at compile time as well as at run time.
   */
  it("is the version packages/auth actually depends on", () => {
    expect(packageJson.dependencies["better-auth"]).toBe(REVIEWED_BETTER_AUTH_VERSION);
  });

  it("is also the adapter's version, because the adapter tracks the core release", () => {
    // `@better-auth/drizzle-adapter` is published in lockstep with `better-auth`
    // and is part of the same reviewed surface. Two pins moving independently is
    // how a reviewed core ends up paired with an unreviewed adapter.
    expect(packageJson.dependencies["@better-auth/drizzle-adapter"]).toBe(
      REVIEWED_BETTER_AUTH_VERSION
    );
  });

  it("is pinned exactly in package.json, with no range operator", () => {
    // Asserted on the dependency string itself and not only through the equality
    // above: `"^1.7.1"` would fail the comparison with a message about two
    // version strings, where this one says what is actually wrong.
    for (const specifier of [
      packageJson.dependencies["better-auth"],
      packageJson.dependencies["@better-auth/drizzle-adapter"]
    ]) {
      expect(specifier).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
