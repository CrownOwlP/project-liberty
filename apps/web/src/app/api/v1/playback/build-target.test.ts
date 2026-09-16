import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILD_TARGET_ENV_VAR, nextConfigFor } from "../../../../../next.config";
import {
  buildTargetFrom,
  DEFAULT_BUILD_TARGET,
  DESKTOP_MODULE_INFIX,
  DESKTOP_RESOLVE_EXTENSIONS,
  extensionsFor,
  WEB_RESOLVE_EXTENSIONS,
  type BuildTarget
} from "./build-target";

/* -------------------------------------------------------------------------
 * THE PROPERTY §8 ASKS FOR: THE DESKTOP BUILD CONTAINS NO PROVIDER-RESOLUTION
 * IMPLEMENTATION AT ALL
 *
 * `docs/DESKTOP_PLAYBACK.md` §8, in its own words: "The desktop target
 * therefore does not compile it in, and that is the property to test for -- an
 * assertion that the desktop bundle contains no provider-resolution
 * implementation is worth more than any amount of configuration discipline."
 *
 * WHAT THIS SUITE ACTUALLY PROVES, STATED BEFORE IT IS CLAIMED. It walks the
 * STATIC IMPORT GRAPH from the route module, applying the same resolve-extension
 * rules the build applies -- taken from `next.config.ts` itself, not restated
 * here -- and asserts what is reachable under each target. That is a claim
 * about MODULE REACHABILITY UNDER THE PUBLISHED RESOLUTION RULES. It is not a
 * claim about a bundle file, because producing one takes a full `next build`
 * and a unit suite must not. The two gaps that leaves are named at the bottom
 * of this file rather than left to be discovered.
 *
 * IT IS PAIRED. Every absence asserted for the desktop graph is asserted as a
 * PRESENCE for the web graph, so a walker that silently resolved nothing --
 * the way this kind of test usually rots -- fails instead of passing
 * vacuously.
 * ---------------------------------------------------------------------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_WEB = resolve(HERE, "../../../../..");
const SRC = join(APP_WEB, "src");
const ROUTE = join(HERE, "session/route.ts");

/** The two packages a forwarder must not be able to reach. §7 names the hazard:
 * a desktop path that reached a provider adapter would put provider behaviour,
 * and eventually provider credentials, on the user's machine. */
const RESOLUTION_PACKAGES = ["@liberty/provider-sdk", "@liberty/media-engine"];

/** The modules that ARE the on-device resolver. */
const RESOLVER_MODULES = [
  "src/app/api/v1/playback/session/issue-session.ts",
  "src/app/api/v1/playback/session/authorized-candidates.ts",
  "src/app/api/v1/playback/session/playback-session-implementation.ts"
];

interface Graph {
  /** Every module reachable from the entry, as an `apps/web`-relative path. */
  readonly modules: readonly string[];
  /** Every non-relative specifier any of them imports for a VALUE. */
  readonly packages: readonly string[];
}

/**
 * Value imports only.
 *
 * `import type` and `import { type X }` are ERASED by the compiler and are not
 * in any bundle, so counting them would make this suite assert something
 * stricter than the property and fail on code that is already correct --
 * `contract.ts` type-imports `RejectionReason` and `UrlRejectionReason` from
 * exactly the two packages this file is about. `export * from` and
 * `export { x } from` re-export values and are followed.
 */
function valueSpecifiers(source: string): string[] {
  const found: string[] = [];

  /* `import ... from "x"`, `export ... from "x"`, and bare `import "x"`. The
   * clause is captured so a leading `type` can be rejected. */
  const statement = /\b(?:import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (/^\s+type\s/.test(clause)) continue;
    if (/^\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?\}\s*$/.test(clause)) continue;
    found.push(specifier);
  }

  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    found.push(match[1] ?? "");
  }
  /* Dynamic import and require, which a bundler follows too. */
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push(match[1] ?? "");
  }

  return found;
}

/** Whether a resolved file is one whose imports a bundler would follow. A
 * stylesheet or an image is a leaf: it is IN the graph and has nothing to add
 * to it, and parsing it as JavaScript would invent specifiers. */
function isScript(path: string): boolean {
  return /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/.test(path);
}

/** Resolution, with the target's own extension priority. The rule under test. */
function resolveModule(fromFile: string, specifier: string, extensions: readonly string[]): string {
  const base = resolve(dirname(fromFile), specifier);
  /* A specifier that already names its file -- `./globals.css`, `./data.json`.
   * Tried first, because appending an extension to it would never match. */
  if (existsFile(base)) return base;
  for (const extension of extensions) {
    const candidate = `${base}${extension}`;
    if (existsFile(candidate)) return candidate;
  }
  for (const extension of extensions) {
    const candidate = join(base, `index${extension}`);
    if (existsFile(candidate)) return candidate;
  }
  throw new Error(`could not resolve ${specifier} from ${fromFile}`);
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walk(entry: string, extensions: readonly string[]): Graph {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    const key = relative(APP_WEB, current).split("\\").join("/");
    if (modules.has(key)) continue;
    modules.add(key);
    if (!isScript(current)) continue;

    for (const specifier of valueSpecifiers(readFileSync(current, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(resolveModule(current, specifier, extensions));
      } else {
        packages.add(specifier);
      }
    }
  }

  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

function extensionsOf(target: BuildTarget): readonly string[] {
  /* Taken from the CONFIG THE BUILD USES rather than from `build-target.ts`
   * directly, so a config that stopped applying the rules would fail here
   * rather than leave this suite asserting a table nothing consumes. */
  const configured = nextConfigFor(target).turbopack?.resolveExtensions;
  return configured ?? WEB_RESOLVE_EXTENSIONS;
}

const DESKTOP = walk(ROUTE, extensionsOf("desktop"));
const WEB = walk(ROUTE, extensionsOf("web"));

describe("the desktop build contains no provider-resolution implementation", () => {
  it("reaches the forwarder and not the resolver", () => {
    expect(DESKTOP.modules).toContain(
      "src/app/api/v1/playback/session/playback-session-implementation.desktop.ts"
    );
    for (const moduleId of RESOLVER_MODULES) {
      expect(DESKTOP.modules, `desktop graph reaches ${moduleId}`).not.toContain(moduleId);
    }
  });

  it("reaches neither the provider SDK nor the media engine, at any depth", () => {
    /*
     * `startsWith` rather than equality, because a subpath import
     * (`@liberty/provider-sdk/fixture`) is the same package arriving under a
     * different spelling -- and a package entry point is exactly where
     * `createFixtureProvider` lives.
     */
    const reached = DESKTOP.packages.filter((specifier) =>
      RESOLUTION_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
    );
    expect(reached).toEqual([]);
  });

  it("is a real absence and not a walker that resolved nothing", () => {
    /*
     * THE PAIRING. Every assertion above is stated in the positive here for the
     * web target, so a walk that silently found no imports -- a regex that
     * stopped matching, a resolver that threw and was caught somewhere -- turns
     * this suite red instead of green.
     */
    for (const moduleId of RESOLVER_MODULES) {
      expect(WEB.modules, `web graph lost ${moduleId}`).toContain(moduleId);
    }
    for (const name of RESOLUTION_PACKAGES) {
      expect(WEB.packages).toContain(name);
    }
    expect(WEB.modules).not.toContain(
      "src/app/api/v1/playback/session/playback-session-implementation.desktop.ts"
    );
  });

  it("puts the same route, handler and contract in front of both", () => {
    /*
     * §8: "the desktop implementation differs behind the boundary and nowhere
     * in front of it". Stated as a set difference so that a future edit which
     * gave the desktop target its own route, its own envelope or its own
     * contract fails here -- those are the three files a client could observe.
     */
    const shared = [
      "src/app/api/v1/playback/session/route.ts",
      "src/app/api/v1/playback/session/handler.ts",
      "src/app/api/v1/playback/session/contract.ts"
    ];
    for (const moduleId of shared) {
      expect(DESKTOP.modules, `desktop lost ${moduleId}`).toContain(moduleId);
      expect(WEB.modules, `web lost ${moduleId}`).toContain(moduleId);
    }

    const onlyDesktop = DESKTOP.modules.filter((entry) => !WEB.modules.includes(entry));
    const onlyWeb = WEB.modules.filter((entry) => !DESKTOP.modules.includes(entry));
    expect(onlyDesktop).toEqual([
      "src/app/api/v1/playback/session/playback-session-implementation.desktop.ts"
    ]);
    /* Everything the web graph has and the desktop graph does not is the
     * resolver and its transitive tail. Asserted as a superset relation rather
     * than a literal list so an unrelated refactor below the seam does not
     * break it, but it must be non-empty: an empty difference would mean the
     * two targets compile the same thing. */
    expect(onlyWeb.length).toBeGreaterThan(0);
    for (const moduleId of RESOLVER_MODULES) expect(onlyWeb).toContain(moduleId);
  });
});

describe("what the desktop build still resolves on-device, enumerated", () => {
  /**
   * Every entry point Next compiles a server bundle for.
   */
  function entryPoints(directory: string, into: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entryPoints(path, into);
        continue;
      }
      if (/^(?:route|page|layout|default|template|error|loading|not-found)\.tsx?$/.test(entry.name)) {
        into.push(path);
      }
    }
    return into;
  }

  /**
   * THIS IS A LEDGER, NOT A PASS. §8's ruling is about
   * `/api/v1/playback/*`, and that surface is clean -- but the property it
   * states in the general form ("the desktop bundle contains no
   * provider-resolution implementation at all") is NOT yet true of the whole
   * application, and the honest way to record that is a test that names the
   * remaining entry points rather than a sentence in a document.
   *
   * WHAT IS ON THE LIST TODAY AND WHY. `app/watch/[contentId]/page.tsx`
   * server-renders through `app/watch/watch-session.ts`, which imports
   * `resolveAuthorizedCandidates` directly instead of calling the session API
   * -- it runs the rights gate, the ranker and `checkUrl` in the page. A real
   * `next build` with `LIBERTY_BUILD_TARGET=desktop` confirms it: the fixture
   * provider's strings appear in that page's server chunk and in no other, and
   * the session route's chunk carries the forwarder instead. That page is
   * outside PL-0501's write surface, so this task cannot give it a `.desktop`
   * half; it is reported as a follow-up.
   *
   * THE LIST MAY ONLY SHRINK. A new entry point that reaches the resolver fails
   * here on the day it is written, which is the day it is cheap to fix; and the
   * task that finally moves the watch page onto the session API deletes a line
   * here and gets a green suite as its evidence.
   */
  const KNOWN_ON_DEVICE_RESOLVERS: readonly string[] = ["src/app/watch/[contentId]/page.tsx"];

  it("is the watch page and nothing else", () => {
    const extensions = extensionsOf("desktop");
    const offenders = entryPoints(join(SRC, "app"))
      .filter((entry) => {
        const graph = walk(entry, extensions);
        return RESOLVER_MODULES.some((moduleId) => graph.modules.includes(moduleId));
      })
      .map((entry) => relative(APP_WEB, entry).split("\\").join("/"))
      .sort();

    expect(offenders).toEqual([...KNOWN_ON_DEVICE_RESOLVERS].sort());
  });

  it("does not include the route this task owns", () => {
    /* Stated separately so the line that matters cannot be lost in a list. */
    expect(KNOWN_ON_DEVICE_RESOLVERS).not.toContain("src/app/api/v1/playback/session/route.ts");
  });
});

describe("the target cannot be consulted at runtime", () => {
  /**
   * The file with its comments removed and its string literals kept.
   *
   * COMMENTS ARE REMOVED BECAUSE THE PROPERTY IS ABOUT CODE. Both modules below
   * explain at length why the build target is not readable at runtime, which
   * means both of them contain the words -- and a raw substring search would
   * make the rule unstateable in the place it most needs stating. STRINGS ARE
   * KEPT because `process.env["LIBERTY_BUILD_TARGET"]` is the exact read this
   * is looking for.
   *
   * A character scanner rather than a regex, because a regex that strips `//`
   * to end of line eats the rest of any line containing an `https://` literal,
   * and a read on that line would vanish with it. It does not model regex
   * literals; a regex containing an unbalanced quote would confuse it, and
   * neither file has one.
   */
  function withoutComments(source: string): string {
    let out = "";
    let index = 0;
    let quote: string | null = null;

    while (index < source.length) {
      const character = source[index] ?? "";
      const next = source[index + 1] ?? "";

      if (quote !== null) {
        out += character;
        if (character === "\\") {
          out += next;
          index += 2;
          continue;
        }
        if (character === quote) quote = null;
        index += 1;
        continue;
      }

      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        out += character;
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        while (index < source.length && source[index] !== "\n") index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
          index += 1;
        }
        index += 2;
        continue;
      }

      out += character;
      index += 1;
    }

    return out;
  }

  /**
   * Every shipped module -- everything under `apps/web/src` that is not a test.
   */
  function shippedSources(directory: string, into: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        shippedSources(path, into);
        continue;
      }
      if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
      if (/\.(?:test|spec)\.[^.]+$/.test(entry.name)) continue;
      into.push(path);
    }
    return into;
  }

  it("is named in no module that can be bundled", () => {
    /*
     * §8's objection to a runtime switch is that it "lives on the machine the
     * user administers, next to the code it would re-enable". The build target
     * is read once, in `next.config.ts`, which runs on the build machine. If a
     * shipped module ever mentions the variable, something inside the artifact
     * can ask what it was built as -- and the next edit branches on the answer.
     */
    const offenders = shippedSources(SRC)
      .filter((path) => withoutComments(readFileSync(path, "utf8")).includes(BUILD_TARGET_ENV_VAR))
      .map((path) => relative(APP_WEB, path));
    expect(offenders).toEqual([]);
  });

  it("is not reachable through the resolution rules module either", () => {
    /* `build-target.ts` IS shipped -- it sits under `src/` and nothing stops a
     * module importing it -- so it must stay a vocabulary with no reads in it.
     * A `process.env` here would be the switch arriving inside the rules. */
    const source = withoutComments(readFileSync(join(HERE, "build-target.ts"), "utf8"));
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("process.argv");
    /* And the stripper is not simply returning nothing: the module's own
     * exports survive it. A comment remover that ate the file would make the
     * two assertions above pass for the wrong reason. */
    expect(source).toContain("export function buildTargetFrom");
  });
});

describe("the resolution rules themselves", () => {
  it("prefers a desktop override and otherwise resolves as the web build does", () => {
    const desktop = extensionsOf("desktop");
    expect(desktop).toEqual(DESKTOP_RESOLVE_EXTENSIONS);
    /* Every desktop-infixed form comes before every plain one; nothing else
     * about resolution changes. */
    const firstPlain = desktop.findIndex((extension) => !extension.startsWith(DESKTOP_MODULE_INFIX));
    const lastInfixed = desktop.reduce(
      (last, extension, index) => (extension.startsWith(DESKTOP_MODULE_INFIX) ? index : last),
      -1
    );
    expect(lastInfixed).toBeLessThan(firstPlain);
    expect(desktop.slice(firstPlain)).toEqual(WEB_RESOLVE_EXTENSIONS);
  });

  it("leaves the hosted build's resolution entirely unconfigured", () => {
    /* Not "configured to the defaults" -- absent. A hosted build that never
     * grew a resolution key cannot have been regressed by one. */
    expect(extensionsFor("web")).toBeNull();
    expect(nextConfigFor("web").turbopack).toBeUndefined();
  });

  it("refuses a target it does not recognise instead of quietly building the web one", () => {
    expect(buildTargetFrom(undefined)).toBe(DEFAULT_BUILD_TARGET);
    expect(buildTargetFrom("")).toBe(DEFAULT_BUILD_TARGET);
    expect(buildTargetFrom("desktop")).toBe("desktop");
    /* The dangerous case: a near-miss silently producing a build that ships the
     * on-device resolver inside the desktop shell. */
    for (const typo of ["Desktop", "DESKTOP", "tauri", "electron", "desktop "]) {
      expect(() => buildTargetFrom(typo), typo).toThrow(/unknown build target/);
    }
  });
});

/* -------------------------------------------------------------------------
 * WHAT THIS SUITE DOES NOT PROVE, NAMED RATHER THAN IMPLIED
 *
 *   1. IT DOES NOT READ A BUNDLE. It asserts reachability under the resolution
 *      rules `next.config.ts` publishes. Producing and inspecting a real
 *      desktop bundle requires a full `next build`, which is not a unit test;
 *      that check belongs in CI beside the build itself, and PL-0501's report
 *      records the manual run and its result.
 *   2. IT CANNOT SEE WHICH BUNDLER RAN. `next build --webpack` reads a
 *      different resolver configuration, which this app does not set, so a
 *      desktop build produced with that flag would resolve the on-device
 *      resolver and this suite would still be green. `next.config.ts` states
 *      that the desktop target is Turbopack-only; nothing here enforces it.
 * ---------------------------------------------------------------------- */
