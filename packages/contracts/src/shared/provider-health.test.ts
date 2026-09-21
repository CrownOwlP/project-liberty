import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_HEALTH_FLOOR, isBelowHealthFloor } from "./provider-health";

/**
 * The floor vocabulary, and the two structural properties that let it sit
 * between `@liberty/provider-sdk` and `@liberty/media-engine` safely.
 *
 * The behavioural assertions here are small on purpose -- it is a number and a
 * comparison. The ones that earn their place are the STRUCTURAL pair, because
 * they are what a future edit would quietly break: an empty import list, and no
 * entitlement vocabulary. PL-0303's entitlement separation was approved partly
 * on the fact that the health mechanism imports nothing and takes no rights,
 * candidate or source. Introducing a module that both packages read is exactly
 * how that could be undone by a helpful edit, so the property is now checked
 * rather than described.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, "provider-health.ts");
const SOURCE = readFileSync(MODULE_PATH, "utf8");

/** Doc comments in this package quote import statements as examples. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CODE = stripComments(SOURCE);

describe("the floor is a strict leaf", () => {
  it("imports nothing at all, not even zod", () => {
    const specifiers = [...CODE.matchAll(/\bfrom\s*"([^"]+)"/g)].map((m) => m[1]);
    const bareImports = [...CODE.matchAll(/\bimport\s*"([^"]+)"/g)].map((m) => m[1]);

    // Not "imports only leaves" -- imports NOTHING. A module with no edges
    // cannot acquire a path to a rights decision by a later one-line change to
    // something it depends on, because there is nothing it depends on.
    expect([...specifiers, ...bareImports]).toEqual([]);
  });

  it("carries no entitlement, rights or candidate vocabulary", () => {
    // Name-based, and deliberately generous: the point is to fail loudly on the
    // FIRST edit that reaches for one of these, while the reviewer is still
    // looking, rather than to be a complete guard. The complete guard is the
    // empty import list above -- these names cannot arrive here as types
    // without an import.
    const forbidden = [
      "rights",
      "rightsBasis",
      "entitle",
      "licen",
      "allowlist",
      "candidate",
      "StreamCandidate",
      "eligible",
      "playable",
      "drm"
    ];
    const lowered = CODE.toLowerCase();
    const found = forbidden.filter((name) => lowered.includes(name.toLowerCase()));
    expect(found).toEqual([]);
  });
});

describe("the floor value and its comparison", () => {
  it("is the shipped 0.5", () => {
    expect(PROVIDER_HEALTH_FLOOR).toBe(0.5);
  });

  it("excludes strictly below and admits exactly at the floor", () => {
    expect(isBelowHealthFloor(0.4999)).toBe(true);
    // The shipped prior sits exactly here and must survive. A `<=` here buries
    // every unobserved provider permanently.
    expect(isBelowHealthFloor(PROVIDER_HEALTH_FLOOR)).toBe(false);
    expect(isBelowHealthFloor(0.5001)).toBe(false);
  });

  it("uses the same operator against a policy-supplied floor", () => {
    expect(isBelowHealthFloor(0.7, 0.8)).toBe(true);
    expect(isBelowHealthFloor(0.8, 0.8)).toBe(false);
    expect(isBelowHealthFloor(0.9, 0.8)).toBe(false);
  });

  it("reports an unrepresentable score as not-below rather than excluding it", () => {
    // NaN < anything is false. Stated rather than left to be discovered: a
    // candidate whose score is not a number is a contract problem for
    // `streamCandidateSchema` to refuse, not something this predicate should
    // silently convert into an exclusion with a health reason attached.
    expect(isBelowHealthFloor(Number.NaN)).toBe(false);
  });
});
