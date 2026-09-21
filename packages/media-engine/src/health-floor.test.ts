import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_HEALTH_FLOOR as SHARED_FLOOR,
  isBelowHealthFloor
} from "@liberty/contracts/shared/provider-health";
import { describe, expect, it } from "vitest";
import { PROVIDER_HEALTH_FLOOR } from "./ranking";

/**
 * PL-0312: the engine's floor is an alias, not a second constant.
 *
 * `ranking.test.ts` already covers the BEHAVIOUR at the boundary -- a candidate
 * one hundredth below the floor is excluded, one exactly on it is not -- and
 * those tests are unchanged, because the behaviour is unchanged. What was
 * missing is a check that fails if the value is ever restated here, which is
 * the only way the old duplication could come back.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RANKING_SOURCE = readFileSync(join(HERE, "ranking.ts"), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const RANKING_CODE = stripComments(RANKING_SOURCE);

describe("the engine floor is the shared floor", () => {
  it("re-exports the same value under its historical name", () => {
    expect(PROVIDER_HEALTH_FLOOR).toBe(SHARED_FLOOR);
  });

  it("declares no floor of its own", () => {
    // `export const PROVIDER_HEALTH_FLOOR = 0.5` is what this forbids. The
    // equality above would pass with it present, which is why it is not enough.
    expect(RANKING_CODE).not.toMatch(/(?:const|let|var)\s+PROVIDER_HEALTH_FLOOR\s*=/);
    expect(RANKING_CODE).toContain('from "@liberty/contracts/shared/provider-health"');
  });

  it("writes no comparison against the floor by hand", () => {
    // The value and the OPERATOR are one decision: the shipped prior for an
    // unobserved provider sits exactly on the floor and survives only because
    // the comparison is strict. A `<=` reintroduced here would bury every
    // unmeasured provider and nothing else would notice.
    expect(RANKING_CODE).not.toMatch(/[<>]=?\s*PROVIDER_HEALTH_FLOOR/);
    expect(RANKING_CODE).not.toMatch(/PROVIDER_HEALTH_FLOOR\s*[<>]=?/);
    expect(RANKING_CODE).toContain("isBelowHealthFloor(candidate.healthScore)");
  });

  it("agrees with the shared predicate at the boundary", () => {
    expect(isBelowHealthFloor(PROVIDER_HEALTH_FLOOR - 0.0001)).toBe(true);
    expect(isBelowHealthFloor(PROVIDER_HEALTH_FLOOR)).toBe(false);
  });
});
