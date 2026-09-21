import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bareAddress as sharedBareAddress } from "@liberty/net-policy/host";
import { describe, expect, it } from "vitest";
import { bareAddress as packageBareAddress } from "./index";

/**
 * THIS PACKAGE CONSUMES THE SHARED CANONICALISER, AND NO LONGER REACHES INTO
 * @liberty/provider-sdk AT ALL.
 *
 * Two separate things are asserted here and they fail for different reasons.
 *
 * ONE: the merge happened. `withoutRootLabel` in `egress.ts` was a deliberate,
 * documented, character-for-character copy of the one in
 * `@liberty/provider-sdk/src/stremio/url-policy.ts`, and `normaliseHost` in
 * `pin.ts` was a third answer to the same question that did not fold the root
 * label at all. All three are now `@liberty/net-policy`'s. The load-bearing
 * assertion is REFERENCE IDENTITY on the one such function this package
 * re-exports publicly, because two faithful copies pass every behavioural test
 * anybody writes and are still two objects.
 *
 * TWO: PL-0709's deep cross-package import is gone and cannot come back.
 * `egress.root-label.test.ts` imported
 * `../../provider-sdk/src/stremio/url-policy` -- reaching past a package
 * boundary into another package's private module, because that package publishes
 * one bare entry point and the classifier was not on it. The reviewer accepted
 * that import for that one test at that one tree and ruled it was not an
 * acceptable permanent boundary. The scan below is what makes the removal
 * permanent rather than a state of affairs that happens to hold today: a
 * declared dependency in this direction would be half of a workspace cycle,
 * because PL-0710's second half has provider-sdk adopting THIS package's
 * `authoriseFetchTarget`.
 *
 * `packages/contracts/src/module-boundary.test.ts` is the house pattern this
 * file follows.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SRC_DIR);

type ExportTarget = string | { types?: string; default?: string };

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly exports?: Record<string, ExportTarget>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Manifest;

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
 * Comments are stripped first. This package's doc comments quote
 * `@liberty/provider-sdk` and the removed code constantly -- the whole
 * explanation of why the port existed is written in terms of the package that
 * must not be a real edge -- so a raw-text scan would report the history as the
 * defect.
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

describe("the host vocabulary this package publishes IS the shared one", () => {
  it("re-exports bareAddress by identity rather than restating it", () => {
    // `bareAddress` is the one piece of the shared host vocabulary this package
    // re-exports publicly, so it is the one the identity check can reach. A copy
    // would be behaviourally indistinguishable and a different object.
    expect(packageBareAddress).toBe(sharedBareAddress);
  });
});

describe("no second canonicaliser or classifier survives in this package", () => {
  it("has source files to scan", () => {
    expect(MODULE_FILES.length).toBeGreaterThan(0);
    expect(MODULE_FILES.map(srcRelative)).toContain("egress.ts");
    expect(MODULE_FILES.map(srcRelative)).toContain("pin.ts");
  });

  it("declares no root-label fold and no address classifier of its own", () => {
    /*
     * `testing/fixtures.ts` is EXEMPT from the classifier patterns and named
     * here rather than silently skipped. `testClassifyHost` is a deliberately
     * crude stand-in this package's composition suites inject, documented at
     * length in that file as not being a second implementation; replacing it
     * with the real classifier changes what a dozen suites are testing and is
     * not PL-0710's question. It is NOT exempt from the root-label rule below,
     * because a second canonicaliser in a fixture would still be a third answer
     * to the question this task exists to give one answer to.
     */
    const FIXTURES = join(SRC_DIR, "testing", "fixtures.ts");

    const canonicaliser: readonly [string, RegExp][] = [
      ["a root-label fold", /function\s+withoutRootLabel\b/],
      ["a bracket stripper", /function\s+bareAddress\b/],
      ["a host canonicaliser", /function\s+canonicalHost\b/]
    ];
    const classifier: readonly [string, RegExp][] = [
      ["an IPv4 range table", /function\s+classifyIPv4\b/],
      ["an IPv6 expander", /function\s+expandIPv6\b/],
      ["a translation-prefix reader", /function\s+embeddedIPv4\b/],
      ["a private-suffix list", /(?:const|let|var)\s+PRIVATE_HOST_SUFFIXES\b/]
    ];

    const offenders: string[] = [];
    for (const file of ALL_SOURCE_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const [what, pattern] of canonicaliser) {
        if (pattern.test(stripped)) offenders.push(`${srcRelative(file)} declares ${what}`);
      }
      if (file === FIXTURES) continue;
      for (const [what, pattern] of classifier) {
        if (pattern.test(stripped)) offenders.push(`${srcRelative(file)} declares ${what}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no root-label folding idiom of its own, whatever it is named", () => {
    /*
     * THE NAME-BASED SCAN ABOVE IS NOT ENOUGH, and that was found by mutation
     * rather than by reasoning: re-growing the fold in `egress.ts` under the
     * name `localWithoutRootLabel` passed every assertion in this file and every
     * behavioural test in the package, because a faithful copy is faithful.
     *
     * So this scans for the IDIOM instead of the identifier. `endsWith(".")` is
     * the fingerprint of root-label handling and there is no other reason for a
     * module in this package to ask it -- the one legitimate occurrence in the
     * repository is `withoutRootLabel` itself, in `@liberty/net-policy/host`.
     * A copy under any name has to contain it; a copy that somehow does not is
     * back in range of the name scan and of `hostOnAllowlist`'s own suite.
     *
     * Production modules only. A test that spells out a fold in an assertion is
     * describing the behaviour, not becoming a second implementation of it.
     */
    const offenders = MODULE_FILES.filter((file) =>
      stripComments(readFileSync(file, "utf8")).includes('endsWith(".")')
    ).map(srcRelative);

    expect(offenders).toEqual([]);
  });

  it("contains no address-range table of its own, whatever it is named", () => {
    /*
     * The same fingerprint argument for the classifier. These constants are what
     * a range check is MADE of -- the metadata address, the NAT64 and 6to4
     * prefixes, the ULA and link-local masks -- and a second classifier cannot
     * be written without at least one of them.
     *
     * `testing/fixtures.ts` is the one exemption and it is named rather than
     * pattern-matched. `testClassifyHost` is a deliberately crude stand-in the
     * composition suites inject, documented at length in that file as not being
     * a second implementation and asserted nowhere as a security control.
     */
    const fingerprints = ["169.254", "0xff9b", "0x2002", "0xfc00", "0xfe80", "100.64", "192.168"];
    const offenders: string[] = [];

    for (const file of MODULE_FILES) {
      if (file === join(SRC_DIR, "testing", "fixtures.ts")) continue;
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const fingerprint of fingerprints) {
        if (stripped.includes(fingerprint)) offenders.push(`${srcRelative(file)} contains ${fingerprint}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has pin.ts compare hostnames through the shared canonicaliser", () => {
    // The third canonicaliser. `normaliseHost` did not fold the DNS root label,
    // and was safe only because both sides of its one comparison came from the
    // same URL object -- a property of where its inputs happened to come from,
    // not of the function.
    const stripped = stripComments(readFileSync(join(SRC_DIR, "pin.ts"), "utf8"));
    expect(stripped).toMatch(/canonicalHost/);
  });
});

describe("nothing here reaches into @liberty/provider-sdk", () => {
  it("names it in no import, in production or in a test", () => {
    // PL-0709's `../../provider-sdk/src/stremio/url-policy`, and any successor
    // spelling of it: a bare package specifier, a subpath, or another deep
    // relative climb out of this package.
    const offenders: string[] = [];
    for (const file of ALL_SOURCE_FILES) {
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (specifier.includes("provider-sdk")) offenders.push(`${srcRelative(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never climbs out of its own src/ directory by a relative path", () => {
    // The general form of the same defect. `../../anything` from a file in
    // `src/` leaves this package, whatever it lands on.
    const offenders: string[] = [];
    for (const file of ALL_SOURCE_FILES) {
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (!specifier.startsWith(".")) continue;
        const resolved = join(dirname(file), specifier);
        if (!resolved.startsWith(SRC_DIR + sep)) offenders.push(`${srcRelative(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares @liberty/net-policy and not @liberty/provider-sdk", () => {
    expect(manifest.dependencies?.["@liberty/net-policy"]).toBe("0.1.0");
    expect(manifest.dependencies?.["@liberty/provider-sdk"]).toBeUndefined();
    expect(manifest.devDependencies?.["@liberty/provider-sdk"]).toBeUndefined();
  });

  it("reaches the shared package from PRODUCTION code, not only from a test", () => {
    const importers = MODULE_FILES.filter((file) =>
      stripComments(readFileSync(file, "utf8")).includes("@liberty/net-policy")
    );
    expect(importers.map(srcRelative)).toContain("egress.ts");
    expect(importers.map(srcRelative)).toContain("pin.ts");
  });
});

/* -------------------------------------------------------------------------
 * THE SUBPATH OMISSION, FIXED AND THEN PINNED.
 *
 * This package published `.` and `./node/*` and nothing else. The barrel
 * re-exports `./hls`, whose first line is `import { Parser } from "m3u8-parser"`
 * -- a package that ships no types -- so ANY program that reaches this package's
 * public API pulls `hls.ts` into its program and fails with TS7016 on a file it
 * never calls. `@liberty/catalog-ingestion` works around that with a
 * triple-slash reference to this package's ambient shim, reached from its own
 * `src/index.ts`, and its author recorded at the time that the right fix was a
 * `./http` subpath here rather than a reference there.
 *
 * IT IS THE SAME DEFECT SHAPE PL-0710 EXISTS FOR. `@liberty/provider-sdk`'s
 * `classifyHost` was unreachable from outside its package for exactly this
 * reason -- a bare `./src/index.ts` exports field with no subpaths -- which is
 * why PL-0709 had to reach in by relative path. A package that publishes one
 * entry point does not have a smaller API surface; it has the same surface and
 * a worse way in.
 *
 * So the three modules a consumer of the bounded fetch actually needs are
 * published, and the property that makes them worth publishing -- that none of
 * them can drag `m3u8-parser` into a consumer's program -- is asserted by
 * walking the real import graph rather than by inspection.
 *
 * REMOVING THE WORKAROUND ITSELF IS NOT THIS TASK'S WRITE SURFACE.
 * `packages/catalog-ingestion/**` is not in PL-0710's `allowedPaths`, so the
 * triple-slash reference and the `include` entry in that package's tsconfig
 * stay until a task that owns that package removes them. This half is done and
 * the other half is now a one-line import change rather than a manifest change
 * in a package somebody else owns.
 * ---------------------------------------------------------------------- */

describe("the subpaths a consumer of the bounded fetch needs are published", () => {
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

  it.each([".", "./http", "./egress", "./pin", "./node/pinned-fetch"])(
    "resolves %s to a file that exists, under both conditions",
    (subpath) => {
      for (const condition of ["types", "default"] as const) {
        const target = resolveSubpath(subpath, condition);
        expect(target, `${subpath} (${condition})`).not.toBeNull();
        expect(existsSync(join(PACKAGE_ROOT, target as string)), `${target}`).toBe(true);
      }
    }
  );

  /**
   * Walks the REAL relative-import graph from an entry module and reports every
   * bare specifier it can reach. Type-only imports count: TS7016 is a type
   * error, and pulling `hls.ts` into a consumer's program is exactly what a
   * `import type` of something declared beside it would do.
   */
  function reachableBareSpecifiers(entry: string): Set<string> {
    const bare = new Set<string>();
    const seen = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (!specifier.startsWith(".")) {
          bare.add(specifier);
          continue;
        }
        const resolved = `${join(dirname(file), specifier)}.ts`;
        if (existsSync(resolved)) queue.push(resolved);
      }
    }
    return bare;
  }

  it.each(["http", "egress", "pin"])(
    "keeps m3u8-parser out of every program that imports ./%s",
    (module) => {
      const reachable = reachableBareSpecifiers(join(SRC_DIR, `${module}.ts`));
      expect([...reachable]).not.toContain("m3u8-parser");
    }
  );

  it("still reaches m3u8-parser from the barrel, which is why the subpaths exist", () => {
    // The positive control, and the thing that makes the three assertions above
    // mean something. If the barrel had stopped pulling the parser in, they
    // would all pass for a reason that has nothing to do with the subpaths.
    expect([...reachableBareSpecifiers(join(SRC_DIR, "index.ts"))]).toContain("m3u8-parser");
  });
});

/*
 * WHERE THE AMBIENT DECLARATION LIVES, AND WHY IT IS NOT A CONSUMER'S PROBLEM.
 *
 * `hls.ts` imports `m3u8-parser`, which ships no types. The declaration that
 * supplies them, `m3u8-parser.d.ts`, sits in this package's source tree, and a
 * tsconfig `include` is per-project -- so for a long time every downstream
 * program that reached `hls.ts` failed `TS7016` on a file it never calls, and
 * `packages/catalog-ingestion/src/index.ts` carried a triple-slash reference to
 * our shim purely so that its own consumers would compile.
 *
 * That was a workaround in the wrong package. A triple-slash reference travels
 * with the source it is written in, so the honest home for it is the file that
 * performs the untyped import -- one reference beside one import, rather than
 * one per downstream barrel that happens to re-export through it, each added by
 * whoever discovered the breakage next.
 *
 * These two assertions are the guard. The first is the property: the reference
 * is on `hls.ts`. The second is the consequence the property exists for: no
 * source file anywhere in the repository points at our shim from outside this
 * package. Delete the first and `apps/web` fails `TS7016` again; satisfy the
 * first by re-adding a downstream reference and the second fails instead.
 */
describe("the m3u8-parser shim is referenced from the file that imports it", () => {
  it("names the declaration in hls.ts, where the untyped import is", () => {
    const hls = readFileSync(join(SRC_DIR, "hls.ts"), "utf8");
    const first = hls.split("\n")[0]?.trim() ?? "";
    expect(first).toBe('/// <reference path="./m3u8-parser.d.ts" />');
  });

  it("is not restated by any file outside this package", () => {
    const repoRoot = dirname(dirname(PACKAGE_ROOT));
    const offenders: string[] = [];
    for (const workspace of ["packages", "apps"]) {
      const root = join(repoRoot, workspace);
      if (!existsSync(root)) continue;
      for (const file of listSourceFiles(root)) {
        if (file.startsWith(PACKAGE_ROOT + sep)) continue;
        if (/<reference\s+path=["'][^"']*m3u8-parser\.d\.ts["']/.test(readFileSync(file, "utf8")))
          offenders.push(relative(repoRoot, file).split(sep).join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
