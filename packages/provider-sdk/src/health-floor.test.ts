import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_HEALTH_FLOOR } from "@liberty/contracts/shared/provider-health";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_HEALTH_POLICY, evaluateProviderHealth, healthPriorScore } from "./health";

/**
 * PL-0312: the provider health floor is one value, read from one place.
 *
 * This file exists because the previous arrangement was not wrong in any
 * observable way -- `failBelow: 0.5` here and `PROVIDER_HEALTH_FLOOR = 0.5` in
 * media-engine agreed, and every test passed. The defect was that they agreed
 * by CONVENTION, restated in three comments, with no check that would fail on
 * the commit that tuned one of them. So the assertions below are deliberately
 * about the source graph and the shipped policy rather than about behaviour:
 * behaviour is identical before and after, which is the point.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HEALTH_SOURCE = readFileSync(join(HERE, "health.ts"), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const HEALTH_CODE = stripComments(HEALTH_SOURCE);

describe("the shipped policy reads the shared floor", () => {
  it("does not restate the value", () => {
    expect(DEFAULT_PROVIDER_HEALTH_POLICY.failBelow).toBe(PROVIDER_HEALTH_FLOOR);
  });

  it("writes no numeric literal into failBelow", () => {
    // The assertion above passes for `failBelow: 0.5` too, which is exactly the
    // state this task removed. This one does not.
    const literal = /failBelow\s*:\s*[0-9]/.exec(HEALTH_CODE);
    expect(literal).toBeNull();
  });

  it("keeps the prior sitting exactly on the floor, where it survives a strict comparison", () => {
    // The coupling the floor's value came from: an unobserved provider scores
    // the prior, the prior is the floor, and the floor is compared with `<`.
    // Any one of the three moving alone changes which providers are reachable.
    expect(healthPriorScore(DEFAULT_PROVIDER_HEALTH_POLICY)).toBe(PROVIDER_HEALTH_FLOOR);
  });
});

describe("the health mechanism's import surface", () => {
  it("imports the floor leaf and nothing else", () => {
    const specifiers = [...HEALTH_CODE.matchAll(/\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
    const bare = [...HEALTH_CODE.matchAll(/\bimport\s*"([^"]+)"/g)].map((m) => m[1]);

    // PL-0303's entitlement separation rested on this file importing nothing.
    // It now imports exactly one module, whose own test proves its import list
    // is empty. Widening this list is the edit that would undo the separation,
    // so it fails here rather than in review.
    expect([...specifiers, ...bare]).toEqual(["@liberty/contracts/shared/provider-health"]);
  });
});

describe("a policy that moves its threshold is reported honestly", () => {
  const observed = { successes: 0, failures: 8, excludedByWindow: 0 };

  it("claims the media-engine floor only when it is the media-engine floor", () => {
    const shipped = evaluateProviderHealth("p", observed, DEFAULT_PROVIDER_HEALTH_POLICY);
    const shippedDetail = shipped.reasons.map((r) => r.detail).join(" | ");
    expect(shippedDetail).toContain("the floor below which the media engine excludes a candidate");

    const moved = {
      ...DEFAULT_PROVIDER_HEALTH_POLICY,
      failBelow: 0.7
    };
    const movedReport = evaluateProviderHealth("p", observed, moved);
    const movedDetail = movedReport.reasons.map((r) => r.detail).join(" | ");
    // The old wording asserted the engine claim unconditionally, so a policy
    // like this one told the reader a candidate was about to be excluded when
    // media-engine would still have served it.
    expect(movedDetail).not.toContain("the floor below which the media engine excludes a candidate");
    expect(movedDetail).toContain("sets apart from the shared media-engine floor");
  });
});
