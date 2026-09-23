/* -------------------------------------------------------------------------
 * The guard that makes PlayerAdapter a boundary rather than a wish (PW-0201).
 *
 * docs/DESKTOP_PLAYBACK.md §3 states four rules and then says why they are
 * tested rather than reviewed: "a rule about a module graph that is checked by
 * review is a rule that holds until the first hurried afternoon." This file is
 * that test. It walks the ACTUAL import graph from `player-adapter.ts` — not a
 * hand-maintained list of what that graph is believed to contain — and each
 * assertion is paired with a planted offender, because a scan that resolved
 * nothing would pass every one of them.
 * ---------------------------------------------------------------------- */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PLAYER_ADAPTER_EVENT_TYPES,
  PLAYER_ADAPTER_IDS,
  PLAYER_REFUSAL_CODES,
  accept,
  candidateForLoad,
  refuse,
  type CanPlayDecision,
  type PlayerCandidate,
  type PlayerLoadRequest
} from "./player-adapter";

const PLAYER_DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(PLAYER_DIR, "player-adapter.ts");

/**
 * Engine vocabularies that may not be reachable from the boundary.
 *
 * `@liberty/*` is deliberately NOT here: the rule forbids ENGINE types, and a
 * type-only import of a contract union is the opposite of an engine leak. The
 * zod rule below is what keeps that import honest.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  "shaka-player",
  "mpv",
  "libmpv",
  "@tauri-apps",
  "electron",
  "custom-media-element"
];

/**
 * Names whose presence would mean an engine handle crosses the line, whatever
 * the declared return type says. §3 names the first three; the last two are
 * this repository's own existing escape hatches on `PlaybackController`, and
 * they are exactly what a hurried afternoon would promote onto the boundary.
 */
const FORBIDDEN_MEMBERS: readonly string[] = [
  "getUnderlyingPlayer",
  "nativeHandle",
  "mpvContext",
  "getEnginePlayer",
  "getRawEngineStats",
  "EngineConfig"
];

/** Comments removed, string literals kept, so prose about a rule is not a breach of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

interface Specifier {
  readonly from: string;
  readonly text: string;
  readonly typeOnly: boolean;
}

/** Every `import ... from "x"` in a module, with whether it was type-only. */
function importsIn(file: string): Specifier[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const found: Specifier[] = [];
  for (const match of source.matchAll(/\bimport\s+(type\s+)?([\s\S]*?)from\s+"([^"]+)"/g)) {
    const clause = match[2] ?? "";
    found.push({
      from: file,
      text: match[3] ?? "",
      /* `import type {...}` and `import { type X }` are both erased; a clause
       * mixing the two is treated as a VALUE import, which is the safe reading. */
      typeOnly: match[1] !== undefined || /^\s*\{\s*(type\s+[^,}]+,?\s*)+\}\s*$/.test(clause)
    });
  }
  for (const match of source.matchAll(/\bimport\s+"([^"]+)"/g)) {
    found.push({ from: file, text: match[1] ?? "", typeOnly: false });
  }
  return found;
}

interface Graph {
  readonly files: string[];
  readonly bare: Specifier[];
}

/** The transitive graph of local modules, plus every bare specifier reached. */
function graphFrom(entry: string): Graph {
  const seen = new Set<string>();
  const bare: Specifier[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of importsIn(file)) {
      if (!specifier.text.startsWith(".")) {
        bare.push(specifier);
        continue;
      }
      const base = resolve(dirname(file), specifier.text);
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(candidate)) {
          queue.push(candidate);
          break;
        }
      }
    }
  }
  return { files: [...seen].sort(), bare };
}

const show = (file: string): string => relative(PLAYER_DIR, file).split(sep).join("/");

describe("the PlayerAdapter boundary reaches no engine", () => {
  it("names no engine package anywhere in its import graph", () => {
    const graph = graphFrom(ENTRY);
    const offenders = graph.bare
      .filter((s) => FORBIDDEN_SPECIFIERS.some((f) => s.text === f || s.text.startsWith(`${f}/`)))
      .map((s) => `${show(s.from)} -> ${s.text}`);
    expect(offenders, "an engine package is reachable from the boundary").toEqual([]);
  });

  it("is not passing because the walker resolved nothing", () => {
    /* The pairing. Without it the assertion above is satisfied by a typo in the
     * entry path, which is the failure mode every import-graph guard has. */
    const graph = graphFrom(ENTRY);
    expect(graph.files).toContain(ENTRY);
    expect(
      graph.bare.map((s) => s.text),
      "the boundary is expected to reach the contracts package, type-only"
    ).toContain("@liberty/contracts/shared/drm");
  });

  it("catches a planted engine import", () => {
    /*
     * Driven against a TEMP TREE rather than by writing into src/. The existing
     * build-target.test.ts plants its probe inside `apps/web/src/app` and its
     * own banner admits an interrupted run leaves the file behind; PL-0712 fixed
     * the same shape of defect by moving to a temp tree, and this guard is built
     * that way from the start.
     */
    const root = join(PLAYER_DIR, "..", "..", "..", "..", "..", "tmp-pw0201");
    const dir = join(root, "probe");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "leaf.ts"), 'import shaka from "shaka-player";\nexport const x = shaka;\n');
      writeFileSync(join(dir, "entry.ts"), 'import { x } from "./leaf";\nexport const y = x;\n');
      const graph = graphFrom(join(dir, "entry.ts"));
      const offenders = graph.bare.filter((s) =>
        FORBIDDEN_SPECIFIERS.some((f) => s.text === f || s.text.startsWith(`${f}/`))
      );
      expect(offenders, "the walker must find an offender one hop away").toHaveLength(1);
      expect(offenders[0]?.text).toBe("shaka-player");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the boundary's four §3 rules", () => {
  const source = stripComments(readFileSync(ENTRY, "utf8"));

  it("contains no `any`", () => {
    /* Word-bounded, over comment-stripped source, so the prose above may say the
     * word while the code may not contain it. */
    expect(source).not.toMatch(/\bany\b/);
  });

  it("passes no engine handle across the line, by any of the known names", () => {
    const present = FORBIDDEN_MEMBERS.filter((member) => source.includes(member));
    expect(present, "an engine handle or opaque config bag crossed the boundary").toEqual([]);
  });

  it("imports @liberty/contracts type-only, so zod stays out of the bundle", () => {
    const contractImports = importsIn(ENTRY).filter((s) => s.text.startsWith("@liberty/"));
    expect(contractImports.length).toBeGreaterThan(0);
    const valueImports = contractImports.filter((s) => !s.typeOnly).map((s) => s.text);
    expect(
      valueImports,
      "a value import of a zod-bearing package would ship a schema validator for two string unions"
    ).toEqual([]);
  });

  it("the type-only detection is not vacuous", () => {
    /* Proves the previous test can fail: the same parser, on a value import. */
    const root = join(PLAYER_DIR, "..", "..", "..", "..", "..", "tmp-pw0201-value");
    try {
      mkdirSync(root, { recursive: true });
      const file = join(root, "value.ts");
      writeFileSync(file, 'import { z } from "@liberty/contracts";\nexport const a = z;\n');
      const [only] = importsIn(file);
      expect(only?.typeOnly).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the vocabularies are total", () => {
  it("publishes every adapter id and refusal code as values", () => {
    expect(PLAYER_ADAPTER_IDS).toEqual(["web-shaka", "native-mpv"]);
    expect(PLAYER_REFUSAL_CODES).toHaveLength(8);
    expect(PLAYER_REFUSAL_CODES).toContain("drm_required_no_cdm");
  });

  it("publishes every event type, including the resync that is not an error", () => {
    expect(PLAYER_ADAPTER_EVENT_TYPES).toContain("resynchronised");
    expect(PLAYER_ADAPTER_EVENT_TYPES).toHaveLength(17);
  });
});

describe("the helpers the boundary owns", () => {
  const candidate = (id: string): PlayerCandidate => ({
    id,
    providerId: "fixture",
    uri: "https://fixtures.invalid/a.mpd",
    mimeType: null,
    compatibility: "unverified",
    /* The real union, not a cast. A cast here would hide exactly the kind of
     * shape error PL-0711 recorded: `as never` on a handler option once hid a
     * wrong option name and made a missing bound look like a pass. */
    protection: { state: "clear" }
  });

  const request = (candidateId: string): PlayerLoadRequest => ({
    session: {
      contentId: "demo",
      candidates: [candidate("a"), candidate("b")],
      startAtSeconds: null,
      reasons: ["fixture"]
    },
    candidateId,
    startAtSeconds: null,
    loadId: 1
  });

  it("resolves the candidate a load names", () => {
    expect(candidateForLoad(request("b"))?.id).toBe("b");
  });

  it("returns undefined for an id the session does not carry, rather than the first one", () => {
    /* Falling back to candidates[0] is how a reason trail comes to attribute a
     * failure to a stream that was never played. */
    expect(candidateForLoad(request("nope"))).toBeUndefined();
  });

  it("carries a reason on the accepting branch too", () => {
    const decision: CanPlayDecision = accept("web-shaka", "unverified", "nothing disqualified it");
    expect(decision.playable).toBe(true);
    expect(decision.reason).not.toBe("");
  });

  it("carries a code and a reason on the refusing branch", () => {
    const decision = refuse("native-mpv", "drm_required_no_cdm", "mpv has no CDM");
    expect(decision.playable).toBe(false);
    if (!decision.playable) {
      expect(decision.refusal).toBe("drm_required_no_cdm");
      expect(decision.reason).not.toBe("");
    }
  });
});
