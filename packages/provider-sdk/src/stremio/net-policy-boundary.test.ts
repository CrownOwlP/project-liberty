import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyHost as sharedClassifyHost } from "@liberty/net-policy/classify";
import { describe, expect, it } from "vitest";
import { classifyHost as sdkClassifyHost } from "../index";

/**
 * THIS PACKAGE CONSUMES THE SHARED CLASSIFIER. ASSERTED, NOT ASSUMED.
 *
 * PL-0710 moved `classifyHost` out of `./url-policy.ts` and into
 * `@liberty/net-policy`. The move is only a merge if this package actually
 * imports the result; an extraction that nothing imports is a third copy, and a
 * third copy is strictly worse than the two the extraction was meant to remove,
 * because now the stale one has a name that sounds authoritative.
 *
 * So the load-bearing assertion in this file is REFERENCE IDENTITY, not
 * behaviour. Two independent copies of the classifier would answer identically
 * on every input anybody thought to test -- that is exactly what made the F1/F7/
 * F8 class of defect invisible for so long -- and would be two different
 * function objects. `toBe` is the one comparison a copy cannot satisfy.
 *
 * The rest of the file closes the ways the identity assertion could be true and
 * the merge still incomplete: a second classifier living somewhere else in this
 * package, or a source graph that reaches net-policy only from a test.
 *
 * `packages/contracts/src/module-boundary.test.ts` is the house pattern for
 * asserting the shape of a source graph rather than the behaviour of a function,
 * and this file follows it.
 */

const STREMIO_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = dirname(STREMIO_DIR);
const PACKAGE_ROOT = dirname(SRC_DIR);

interface Manifest {
  readonly dependencies?: Record<string, string>;
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

/** Doc comments in this package quote the removed code at length. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const ALL_SOURCE_FILES = listSourceFiles(SRC_DIR);
const MODULE_FILES = ALL_SOURCE_FILES.filter((file) => !file.endsWith(".test.ts"));
const URL_POLICY = join(STREMIO_DIR, "url-policy.ts");

describe("the classifier this package publishes IS the shared one", () => {
  it("re-exports it by identity, not by restating it", () => {
    // The whole test. A faithful copy passes every behavioural assertion in
    // `url-policy.test.ts` and fails this line.
    expect(sdkClassifyHost).toBe(sharedClassifyHost);
  });

  it("still answers the three findings the register records against this file", () => {
    // Carried behaviour, checked through THIS package's export so that the
    // re-export is exercised rather than merely declared. F7, F1 and F8 in turn.
    expect(sdkClassifyHost("metadata.google.internal.")).toBe("private");
    expect(sdkClassifyHost("localhost.")).toBe("loopback");
    expect(sdkClassifyHost("fe80::1")).toBe("unparseable");
    expect(sdkClassifyHost("[64:ff9b::a00:1]")).toBe("private");
    expect(sdkClassifyHost("[2002:a9fe:a9fe::]")).toBe("private");
    expect(sdkClassifyHost("[::ffff:0:a00:1]")).toBe("private");
    // And the positive control, so none of the above is satisfied by a
    // classifier that refuses everything.
    expect(sdkClassifyHost("cdn.example.test")).toBe("public");
  });
});

describe("no second classifier survives in this package", () => {
  it("has source files to scan", () => {
    expect(MODULE_FILES.length).toBeGreaterThan(0);
    expect(MODULE_FILES.map(srcRelative)).toContain("stremio/url-policy.ts");
  });

  it("declares none of the classifier's internals anywhere under src/", () => {
    /*
     * Each pattern names a piece of the classifier that used to live in
     * `url-policy.ts`. A re-implementation would almost certainly bring at least
     * one of them along; a re-implementation that brought none of them would
     * still be caught by the identity assertion above, which is why these two
     * groups are both here.
     */
    const forbidden: readonly [string, RegExp][] = [
      ["a root-label fold", /function\s+withoutRootLabel\b/],
      ["an IPv4 range table", /function\s+classifyIPv4\b/],
      ["an IPv6 expander", /function\s+expandIPv6\b/],
      ["an IPv6 range table", /function\s+classifyIPv6\b/],
      ["a translation-prefix reader", /function\s+embeddedIPv4\b/],
      ["a private-suffix list", /(?:const|let|var)\s+PRIVATE_HOST_SUFFIXES\b/],
      ["a host classifier", /function\s+classifyHost\b/]
    ];

    const offenders: string[] = [];
    for (const file of ALL_SOURCE_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const [what, pattern] of forbidden) {
        if (pattern.test(stripped)) offenders.push(`${srcRelative(file)} declares ${what}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no root-label folding idiom of its own, whatever it is named", () => {
    /*
     * THE NAME-BASED SCAN ABOVE IS NOT ENOUGH, and mutation is what showed it:
     * a copy re-grown under a different identifier passes every behavioural
     * test, because a faithful copy is faithful. `endsWith(".")` is the
     * fingerprint of root-label handling and the only legitimate occurrence of
     * it in the repository is `withoutRootLabel` in `@liberty/net-policy/host`.
     *
     * Production modules only: a test that spells a fold out in an assertion is
     * describing the behaviour rather than becoming a second implementation.
     */
    const offenders = MODULE_FILES.filter((file) =>
      stripComments(readFileSync(file, "utf8")).includes('endsWith(".")')
    ).map(srcRelative);

    expect(offenders).toEqual([]);
  });

  it("contains no address-range table of its own, whatever it is named", () => {
    // What a range check is MADE of: the metadata address, the NAT64 and 6to4
    // prefixes, the ULA and link-local masks, RFC 1918. A second classifier
    // cannot be written without at least one of them.
    const fingerprints = ["169.254", "0xff9b", "0x2002", "0xfc00", "0xfe80", "100.64", "192.168"];
    const offenders: string[] = [];

    for (const file of MODULE_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const fingerprint of fingerprints) {
        if (stripped.includes(fingerprint)) offenders.push(`${srcRelative(file)} contains ${fingerprint}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the dependency is real, in the source graph and in the manifest", () => {
  it("has url-policy.ts import the classifier from the shared package", () => {
    const stripped = stripComments(readFileSync(URL_POLICY, "utf8"));
    expect(stripped).toMatch(/from\s*"@liberty\/net-policy\/classify"/);
  });

  it("reaches the shared package from PRODUCTION code, not only from a test", () => {
    // A package whose only edge onto the extraction is a test import has not
    // adopted it; it has tested somebody else's code.
    const importers = MODULE_FILES.filter((file) =>
      stripComments(readFileSync(file, "utf8")).includes("@liberty/net-policy")
    );
    expect(importers.map(srcRelative)).toContain("stremio/url-policy.ts");
  });

  it("declares @liberty/net-policy as a runtime dependency", () => {
    expect(manifest.dependencies?.["@liberty/net-policy"]).toBe("0.1.0");
  });

  /*
   * THIS ASSERTION WAS REVERSED BY PL-0710's SECOND HALF, DELIBERATELY, AND THE
   * OLD WORDING IS KEPT HERE SO THE CHANGE IS NOT INVISIBLE.
   *
   * It used to read "does not declare @liberty/media-inspection, which would be
   * the other half of a cycle", and it asserted the dependency was ABSENT. That
   * was written while only the extraction half existed, and the clause after the
   * comma was the part that was wrong: an edge from this package onto
   * `@liberty/media-inspection` is the other half of a cycle only if that package
   * also depends on this one, and PL-0710's first half is precisely what stopped
   * it doing so -- the `classifyHost` port that used to point this way became
   * `@liberty/net-policy`, a leaf both packages import and neither can be
   * imported back from.
   *
   * With that edge gone, `provider-sdk -> media-inspection` is an ordinary
   * acyclic dependency, and PL-0710's acceptance names it as the arrangement the
   * task exists to produce: "PL-0710 has provider-sdk adopting media-inspection's
   * authoriseFetchTarget, so the arrow already points the other way." The
   * alternative -- this package growing its own resolve-and-pin control -- is the
   * two-implementations defect the first half spent a package removing.
   *
   * So the property worth asserting is not the absence of an edge, it is the
   * ABSENCE OF A CYCLE, and that is what the two tests below check: one edge
   * present, the opposite edge absent, read out of both manifests rather than
   * assumed.
   */
  it("declares @liberty/media-inspection, the package whose resolve-and-pin it adopted", () => {
    expect(manifest.dependencies?.["@liberty/media-inspection"]).toBe("0.1.0");
  });

  it("is not in a cycle with it, because that package does not depend back on this one", () => {
    const theirs = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "..", "media-inspection", "package.json"), "utf8")
    ) as Manifest & { readonly devDependencies?: Record<string, string> };

    expect(theirs.dependencies?.["@liberty/provider-sdk"]).toBeUndefined();
    expect(theirs.devDependencies?.["@liberty/provider-sdk"]).toBeUndefined();
  });

  it("reaches that package from PRODUCTION code, and only through its narrow subpaths", () => {
    /*
     * The BARREL is what must not be imported. `@liberty/media-inspection`'s root
     * entry pulls in the HLS and DASH parsers and with them `m3u8-parser` and
     * `@xmldom/xmldom`; this package needs the egress gate and the pin types and
     * nothing else, which is exactly what the `./egress` and `./pin` subpaths
     * PL-0710's first half published are for. An import of the bare package name
     * would drag two XML/HLS parsers into every provider adapter's graph for no
     * reason, which is the omission that half of the task existed to fix.
     */
    const importers: string[] = [];
    const offenders: string[] = [];
    for (const file of MODULE_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      if (!stripped.includes("@liberty/media-inspection")) continue;
      importers.push(srcRelative(file));
      if (/from\s*"@liberty\/media-inspection"/.test(stripped)) {
        offenders.push(`${srcRelative(file)} imports the barrel`);
      }
    }

    expect(importers).toContain("stremio/http.ts");
    expect(offenders).toEqual([]);
  });
});
