import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "./index";

/**
 * Structural regressions for the contracts module boundary.
 *
 * These assert the SHAPE of the source graph, not the behaviour of any schema.
 * The reason they exist as tests rather than as a convention is that the
 * previous layout also "currently happened to" work: `index.ts` defined the
 * shared vocabularies AND re-exported the modules that needed them, so two
 * independent agents each reached for `z.lazy` to survive the resulting
 * evaluation order. Nothing failed, so nothing objected, and the workaround was
 * on its way to being normalised. A convention that only holds while everyone
 * remembers it is not a boundary.
 *
 * The four properties, in the order the architect asked for them:
 *
 *   1. `index.ts` is re-export-only — it is a compatibility barrel, not the
 *      authoritative public surface. A schema defined there is a schema every
 *      task must append to, which is the package-wide mutex coming back.
 *   2. No package-internal module imports through the barrel. This is the exact
 *      condition that created the cycle, and it is the one that must never
 *      silently return.
 *   3. No `shared/**` module imports from `domains/**`. Shared vocabularies are
 *      leaves; an edge in that direction makes every domain change a shared
 *      change and re-couples everything the split decoupled.
 *   4. Every exported domain and shared subpath actually resolves to a file.
 *      The `exports` map is a wildcard, so a typo in a filename is otherwise
 *      only discovered by the consumer that imports it.
 *
 * Plus one guard the split earned: `z.lazy` may only defer a schema declared in
 * the SAME file. `z.lazy` is correct for a genuinely self-recursive schema and
 * stays available for one; using it to reach a symbol that lives elsewhere means
 * an initialisation cycle is being worked around instead of removed.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SRC_DIR);
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");

type ExportTarget = string | { types?: string; default?: string };
type ExportsMap = Record<string, ExportTarget>;

/** POSIX-style path relative to `src/`, so assertions read the same on Windows. */
function srcRelative(absolutePath: string): string {
  return relative(SRC_DIR, absolutePath).split(sep).join("/");
}

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * Comments are stripped before any of these checks run, because the doc
 * comments in this package legitimately quote import statements as examples --
 * `index.ts` shows a consumer what a subpath import looks like. Scanning raw
 * text would read those as real edges.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every module specifier the file imports from or re-exports from. */
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

/**
 * Test files are excluded from the import rules on purpose. A compatibility
 * barrel that nothing is allowed to import cannot be shown to still work, and
 * the assertion at the bottom of this file does exactly that -- through the
 * barrel, deliberately. The rules below are about the MODULE graph the package
 * publishes.
 */
const MODULE_FILES = ALL_SOURCE_FILES.filter((file) => !file.endsWith(".test.ts"));

const BARREL = join(SRC_DIR, "index.ts");

describe("index.ts is a compatibility barrel, not the public surface", () => {
  const stripped = stripComments(readFileSync(BARREL, "utf8"));

  it("contains nothing but re-export statements", () => {
    const statements = stripped
      .replace(/\s+/g, " ")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    const reExport = /^export (?:\*|type \*|\{.*\}|type \{.*\}) from "[^"]+"$/;
    const offenders = statements.filter((statement) => !reExport.test(statement));

    // A definition here is a definition every task has to append to.
    expect(offenders).toEqual([]);
    expect(statements.length).toBeGreaterThan(0);
  });

  it("does not import zod, because it declares no schema", () => {
    expect(moduleSpecifiers(stripped)).not.toContain("zod");
    expect(stripped).not.toMatch(/\bz\s*\./);
  });

  it("re-exports only paths that exist", () => {
    const missing = moduleSpecifiers(stripped).filter(
      (specifier) => !existsSync(join(SRC_DIR, `${specifier}.ts`))
    );
    expect(missing).toEqual([]);
  });
});

describe("no package-internal module imports through the barrel", () => {
  it("has no module reaching ./index", () => {
    const offenders: string[] = [];

    for (const file of MODULE_FILES) {
      if (file === BARREL) continue;
      const specifiers = moduleSpecifiers(stripComments(readFileSync(file, "utf8")));
      for (const specifier of specifiers) {
        if (/(?:^|\/)index(?:\.[cm]?[jt]s)?$/.test(specifier) || specifier === "@liberty/contracts") {
          offenders.push(`${srcRelative(file)} -> ${specifier}`);
        }
      }
    }

    // This is the edge that produced the cycle: `index.ts` re-exported a module
    // that read a binding back out of `index.ts`, so the read happened inside
    // the barrel's temporal dead zone.
    expect(offenders).toEqual([]);
  });
});

describe("shared vocabularies are leaves", () => {
  const sharedDir = join(SRC_DIR, "shared");

  it("has a shared directory", () => {
    expect(existsSync(sharedDir)).toBe(true);
    expect(listSourceFiles(sharedDir).length).toBeGreaterThan(0);
  });

  it("never imports from domains/", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(sharedDir)) {
      if (file.endsWith(".test.ts")) continue;
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (specifier.includes("domains/")) {
          offenders.push(`${srcRelative(file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("imports only zod and sibling shared modules", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(sharedDir)) {
      if (file.endsWith(".test.ts")) continue;
      for (const specifier of moduleSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        const allowed = specifier === "zod" || /^\.\/[A-Za-z0-9._-]+$/.test(specifier);
        if (!allowed) offenders.push(`${srcRelative(file)} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("z.lazy is only used for genuinely self-recursive schemas", () => {
  it("never defers a symbol that lives in another module", () => {
    const offenders: string[] = [];

    for (const file of MODULE_FILES) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      for (const match of stripped.matchAll(/z\.lazy\(\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)/g)) {
        const referenced = match[1];
        if (referenced === undefined) continue;
        // `$` is legal in an identifier and a metacharacter in a pattern.
        const escaped = referenced.replace(/\$/g, "\\$");
        const declaredHere = new RegExp(
          `(?:const|let|var|function|class|interface|type)\\s+${escaped}\\b`
        ).test(stripped);
        if (!declaredHere) offenders.push(`${srcRelative(file)} -> z.lazy(() => ${referenced})`);
      }
    }

    // Deferring a symbol declared elsewhere is not recursion, it is a cycle
    // being survived. Fix the module boundary instead.
    expect(offenders).toEqual([]);
  });
});

describe("the exports map resolves", () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { exports?: ExportsMap };
  const exportsMap = manifest.exports ?? {};

  /** Node/TypeScript subpath resolution, restricted to what this package uses. */
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

  it("declares a wildcard for domains and for shared, so a new contract needs no metadata change", () => {
    // The property that stops the barrel from becoming the new global mutex:
    // adding `domains/live.ts` must not require editing package.json.
    expect(Object.keys(exportsMap)).toContain("./domains/*");
    expect(Object.keys(exportsMap)).toContain("./shared/*");
  });

  it("resolves the root barrel under both conditions", () => {
    for (const condition of ["types", "default"] as const) {
      const target = resolveSubpath(".", condition);
      expect(target).toBe("./src/index.ts");
      expect(existsSync(join(PACKAGE_ROOT, "src/index.ts"))).toBe(true);
    }
  });

  it("resolves every domain module to the file it came from", () => {
    const domains = listSourceFiles(join(SRC_DIR, "domains")).filter(
      (file) => !file.endsWith(".test.ts")
    );
    expect(domains.length).toBeGreaterThan(0);

    for (const file of domains) {
      const name = srcRelative(file).replace(/^domains\//, "").replace(/\.ts$/, "");
      for (const condition of ["types", "default"] as const) {
        const target = resolveSubpath(`./domains/${name}`, condition);
        expect(target, `./domains/${name} (${condition})`).toBe(`./src/domains/${name}.ts`);
        expect(existsSync(join(PACKAGE_ROOT, `src/domains/${name}.ts`))).toBe(true);
      }
    }
  });

  it("resolves every shared vocabulary to the file it came from", () => {
    const shared = listSourceFiles(join(SRC_DIR, "shared")).filter(
      (file) => !file.endsWith(".test.ts")
    );
    expect(shared.length).toBeGreaterThan(0);

    for (const file of shared) {
      const name = srcRelative(file).replace(/^shared\//, "").replace(/\.ts$/, "");
      for (const condition of ["types", "default"] as const) {
        const target = resolveSubpath(`./shared/${name}`, condition);
        expect(target, `./shared/${name} (${condition})`).toBe(`./src/shared/${name}.ts`);
        expect(existsSync(join(PACKAGE_ROOT, `src/shared/${name}.ts`))).toBe(true);
      }
    }
  });

  it("does not resolve a subpath that has no module", () => {
    // A contract module exists only when an actual contract does. The wildcard
    // export is what makes adding one a source change and nothing else -- no
    // package metadata edit, no barrel edit, so the barrel cannot become the new
    // package-wide mutex.
    //
    // `live.ts` used to be asserted here alongside `auth.ts` and was removed
    // when PL-0601 gave live TV a real contract. That is this assertion working,
    // not failing: it existed to catch a module created speculatively, and it
    // fires exactly once -- on the commit that creates one. Retiring a member on
    // the commit that legitimately creates it is the correct move; adding the
    // new file to some allowed-list would have hollowed the rule out instead.
    // `auth.ts` stays because PL-0401 defines its boundary in packages/auth and
    // has published no contract module.
    expect(existsSync(join(PACKAGE_ROOT, "src/domains/auth.ts"))).toBe(false);
  });
});

describe("the barrel still re-exports the whole legacy surface", () => {
  /*
   * Imported as a namespace above, which also proves the graph initialises: if
   * a cycle ever comes back, this file fails at import time rather than on an
   * assertion -- the same way it would fail for the application.
   */
  it("exposes the shared vocabularies", () => {
    expect(barrel.contentRightsSchema.parse("owned")).toBe("owned");
    expect(barrel.PLAYABLE_CONTENT_RIGHTS).toContain("public-domain");
    expect(barrel.videoCodecSchema.parse("av1")).toBe("av1");
    expect(barrel.audioCodecSchema.parse("aac")).toBe("aac");
    expect(barrel.MEDIA_FACTS).toEqual(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
    expect(barrel.normalizedContentIdSchema.parse("aurora-fall")).toBe("aurora-fall");
  });

  it("exposes every domain contract", () => {
    expect(typeof barrel.catalogHomeResponseSchema.safeParse).toBe("function");
    expect(typeof barrel.playbackResolveRequestSchema.safeParse).toBe("function");
    expect(typeof barrel.streamCandidateSchema.safeParse).toBe("function");
    expect(typeof barrel.unknownMediaFacts).toBe("function");
    expect(typeof barrel.audioTrackSchema.safeParse).toBe("function");
    expect(typeof barrel.subtitlePolicySchema.safeParse).toBe("function");
    expect(typeof barrel.searchResponseSchema.safeParse).toBe("function");
    expect(typeof barrel.titleDetailResponseSchema.safeParse).toBe("function");
    expect(barrel.PLAYBACK_FAILURE_KINDS).toContain("rights_unverifiable");
    expect(barrel.SEARCH_QUERY_MAX_LENGTH).toBe(128);
  });
});
