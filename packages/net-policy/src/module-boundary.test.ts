import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "./index";

/**
 * THE LEAF PROPERTY, ASSERTED RATHER THAN PROMISED.
 *
 * This package's whole reason to exist is that it can be imported from both
 * `@liberty/provider-sdk` and `@liberty/media-inspection` without any risk of a
 * cycle -- which is true only for as long as it imports NOTHING. A comment
 * saying so is a convention that holds while everyone remembers it;
 * `packages/contracts/src/module-boundary.test.ts` is the house precedent for
 * turning that kind of convention into a test, and this file follows it.
 *
 * The properties, in the order they matter:
 *
 *   1. No module here imports anything but a sibling module. Not
 *      `@liberty/provider-sdk`, not `@liberty/media-inspection`, not
 *      `@liberty/contracts`, not `zod`, not `node:*`. The first two would be
 *      cycles; the rest would be a leaf that can still drag a graph behind it.
 *   2. `package.json` declares no `dependencies` at all, so the workspace graph
 *      agrees with the source graph.
 *   3. Every published subpath resolves to a file that exists. The omission this
 *      package was partly created to fix is a package that publishes one bare
 *      entry point; repeating it here would have been absurd, and a typo in the
 *      exports map is otherwise only found by the consumer that trips over it.
 *   4. `index.ts` is re-export only, so the barrel never becomes a place where
 *      behaviour accumulates that the subpaths do not have.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SRC_DIR);
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");

type ExportTarget = string | { types?: string; default?: string };

interface Manifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly exports?: Record<string, ExportTarget>;
}

const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as Manifest;

function srcRelative(absolutePath: string): string {
  return relative(SRC_DIR, absolutePath).split(sep).join("/");
}

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

/**
 * Comments are stripped before any scan, because the doc comments in this
 * package quote package names and import paths at length -- the whole story of
 * why the extraction happened is told in terms of the two packages that must not
 * appear as real edges. Scanning raw text would read every one of those as an
 * import.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function moduleSpecifiers(strippedSource: string): string[] {
  const specifiers: string[] = [];
  for (const match of strippedSource.matchAll(/\bfrom\s*"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const match of strippedSource.matchAll(/\bimport\s*"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

const ALL_SOURCE_FILES = listSourceFiles(SRC_DIR);
const MODULE_FILES = ALL_SOURCE_FILES.filter((file) => !file.endsWith(".test.ts"));

/**
 * THIS FILE IS EXCLUDED FROM ITS OWN TEXT SCANS, and the exclusion is closed
 * rather than left as a hole.
 *
 * `moduleSpecifiers` looks for `from "..."`, and the regex literal that does so
 * contains the characters `from\s*"([^"]+)"`. Scanning this file therefore finds
 * its own pattern and reports `[^"` as an import -- which is a false positive
 * discovered by running the suite, not a hypothetical. Stripping regex literals
 * as well as comments would be a second parser to get wrong.
 *
 * So the scanner skips itself and the assertion below states this file's imports
 * in full instead. That is stricter than the scan it replaces: an exact list
 * fails when anything is ADDED, where the scan only fails on a specifier shape
 * it recognises.
 */
const SELF = join(SRC_DIR, "module-boundary.test.ts");
const SCANNED_FILES = ALL_SOURCE_FILES.filter((file) => file !== SELF);

describe("@liberty/net-policy is a dependency leaf", () => {
  it("has production modules to be a leaf of", () => {
    // The non-vacuity guard for every scan below: an empty file list passes all
    // of them.
    expect(MODULE_FILES.length).toBeGreaterThan(0);
    expect(MODULE_FILES.map(srcRelative)).toContain("classify.ts");
    expect(MODULE_FILES.map(srcRelative)).toContain("host.ts");
  });

  it("is the only file exempt from the scans, and imports only the harness", () => {
    // See the note on SELF. Stated as an exact list so that adding an import
    // here fails, rather than being quietly covered by an exemption.
    // Read from the IMPORT STATEMENTS at the top of the file rather than through
    // `moduleSpecifiers`, for the same reason the scan skips this file at all:
    // the scanner would find its own pattern in the regex literal below.
    const importLines = readFileSync(SELF, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "))
      .map((line) => /from "([^\n"]+)";$/.exec(line)?.[1])
      .filter((specifier): specifier is string => specifier !== undefined)
      .sort();

    expect(importLines).toEqual(["./index", "node:fs", "node:path", "node:url", "vitest"]);
  });

  it("imports nothing outside this package, in production or in a test", () => {
    const offenders: string[] = [];

    for (const file of SCANNED_FILES) {
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        // A relative specifier is a sibling module. `vitest` is the only bare
        // specifier permitted, and only in a test file.
        const relativeImport = specifier.startsWith("./") || specifier.startsWith("../");
        const testHarness = file.endsWith(".test.ts") && (specifier === "vitest" || specifier.startsWith("node:"));
        if (!relativeImport && !testHarness) offenders.push(`${srcRelative(file)} -> ${specifier}`);
      }
    }

    // An edge onto either consumer is half a cycle; an edge onto anything else
    // is a leaf that still drags a graph behind it.
    expect(offenders).toEqual([]);
  });

  it("never names either consumer, even in a test", () => {
    const offenders: string[] = [];
    for (const file of SCANNED_FILES) {
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (specifier.includes("provider-sdk") || specifier.includes("media-inspection")) {
          offenders.push(`${srcRelative(file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no runtime dependencies in its manifest", () => {
    expect(manifest.name).toBe("@liberty/net-policy");
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it("no production module reaches into a test-only module", () => {
    const offenders: string[] = [];
    for (const file of MODULE_FILES) {
      if (srcRelative(file).startsWith("testing/")) continue;
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (specifier.includes("testing/")) offenders.push(`${srcRelative(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every published subpath resolves", () => {
  const exportsMap = manifest.exports ?? {};

  function resolveSubpath(subpath: string, condition: "types" | "default"): string | null {
    const readTarget = (target: ExportTarget | undefined): string | null => {
      if (target === undefined) return null;
      if (typeof target === "string") return target;
      return target[condition] ?? target.default ?? null;
    };

    const exact = readTarget(exportsMap[subpath]);
    if (exact !== null) return exact;

    for (const [pattern, target] of Object.entries(exportsMap)) {
      const star = pattern.indexOf("*");
      if (star === -1) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!subpath.startsWith(prefix)) continue;
      if (suffix.length > 0 && !subpath.endsWith(suffix)) continue;
      if (subpath.length < prefix.length + suffix.length) continue;
      const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
      const resolved = readTarget(target);
      if (resolved === null) continue;
      return resolved.replace("*", wildcard);
    }

    return null;
  }

  it("publishes the two subpaths its consumers import, not just a bare root", () => {
    // The defect this package was partly created to stop repeating:
    // `@liberty/provider-sdk`'s `exports` is the bare string `./src/index.ts`
    // with no subpaths, which is why the classifier was unreachable from outside
    // that package and why PL-0709 had to write a deep relative import.
    expect(Object.keys(exportsMap)).toContain("./classify");
    expect(Object.keys(exportsMap)).toContain("./host");
    expect(Object.keys(exportsMap)).toContain("./testing/*");
  });

  it.each(["./classify", "./host", "./testing/host-spellings", "."])(
    "resolves %s to a file that exists, under both conditions",
    (subpath) => {
      for (const condition of ["types", "default"] as const) {
        const target = resolveSubpath(subpath, condition);
        expect(target, `${subpath} (${condition})`).not.toBeNull();
        expect(existsSync(join(PACKAGE_ROOT, target as string)), `${target}`).toBe(true);
      }
    }
  );

  it("does not resolve a subpath that has no module", () => {
    expect(resolveSubpath("./resolve", "default")).toBeNull();
    expect(resolveSubpath("./testing/not-a-table", "default")).not.toBeNull();
    expect(existsSync(join(PACKAGE_ROOT, "src/testing/not-a-table.ts"))).toBe(false);
  });
});

describe("index.ts is a barrel, not a second place behaviour lives", () => {
  const stripped = stripComments(readFileSync(join(SRC_DIR, "index.ts"), "utf8"));

  it("contains nothing but re-export statements", () => {
    const statements = stripped
      .replace(/\s+/g, " ")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    const reExport = /^export (?:\*|type \*|\{.*\}|type \{.*\}) from "[^"]+"$/;
    expect(statements.filter((statement) => !reExport.test(statement))).toEqual([]);
    expect(statements.length).toBeGreaterThan(0);
  });

  it("re-exports the same functions the subpaths publish, by identity", () => {
    // Not a shape check. If the barrel ever grew its own copy of one of these,
    // the two would be equal by behaviour and different by reference, and that
    // is the failure this catches.
    expect(barrel.classifyHost("169.254.169.254")).toBe("private");
    expect(barrel.withoutRootLabel("cdn.example.test.")).toBe("cdn.example.test");
    expect(barrel.canonicalHost("CDN.Example.Test.")).toBe("cdn.example.test");
    expect(barrel.classifyResolvedAddress("fe80::1")).toBe("private");
    expect(barrel.bareAddress("[::1]")).toBe("::1");
    expect(barrel.bracketedLiteral("::1")).toBe("[::1]");
    expect(barrel.PRIVATE_HOST_SUFFIXES).toContain(".internal");
  });
});
