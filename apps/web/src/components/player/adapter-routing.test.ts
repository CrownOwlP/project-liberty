/* -------------------------------------------------------------------------
 * Capability routing (PW-0203). The DRM clauses are rights assertions, not
 * capability ones, and they are written that way.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { ContentProtection } from "@liberty/contracts/shared/drm";

import {
  DESKTOP_ADAPTER_PREFERENCE,
  NATIVE_MPV_CAPABILITIES,
  WEB_ADAPTER_PREFERENCE,
  WEB_SHAKA_CAPABILITIES,
  protectionDecisionFor,
  routeCandidate
} from "./adapter-routing";
import type { PlayerCandidate } from "./player-adapter";

const candidate = (protection: ContentProtection): PlayerCandidate => ({
  id: "c1",
  providerId: "fixture",
  uri: "https://fixtures.invalid/a.mpd",
  mimeType: null,
  compatibility: "unverified",
  protection
});

const CLEAR: ContentProtection = { state: "clear" };
const WIDEVINE: ContentProtection = {
  state: "protected",
  keySystem: "widevine",
  licenseUrl: "https://licence.invalid/acquire?token=SECRET"
};
const UNKNOWN: ContentProtection = { state: "unknown", why: "not_inspected" };

describe("a protected candidate never reaches an engine with no CDM", () => {
  it("is refused by the native adapter with drm_required_no_cdm", () => {
    const decision = protectionDecisionFor(NATIVE_MPV_CAPABILITIES, candidate(WIDEVINE));
    expect(decision.playable).toBe(false);
    if (!decision.playable) expect(decision.refusal).toBe("drm_required_no_cdm");
  });

  it("is refused for UNKNOWN protection too, because unknown is not a claim of clearness", () => {
    /* `requiresContentDecryptionModule` is written `state !== "clear"` exactly so
     * that a fourth state added later defaults to NEEDING a CDM. The opposite
     * reading -- unknown is probably fine, try mpv -- is the invariant-2 incident
     * docs/DESKTOP_PLAYBACK.md §4 names. */
    const decision = protectionDecisionFor(NATIVE_MPV_CAPABILITIES, candidate(UNKNOWN));
    expect(decision.playable).toBe(false);
    if (!decision.playable) expect(decision.refusal).toBe("drm_required_no_cdm");
  });

  it("is accepted by the web adapter, which is the DRM path on both targets", () => {
    expect(protectionDecisionFor(WEB_SHAKA_CAPABILITIES, candidate(WIDEVINE)).playable).toBe(true);
  });

  it("NEVER DEGRADES: the native refusal is not softened by anything on the candidate", () => {
    /*
     * The property that matters. A fallback from native to web on failure would
     * be a system that keeps trying until something plays -- the shape
     * CONTENT_RIGHTS.md forbids as "fallback logic whose purpose is to evade
     * provider enforcement". Asserted over arbitrary candidates so no field can
     * turn the refusal off.
     */
    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1 }),
          providerId: fc.string({ minLength: 1 }),
          uri: fc.webUrl(),
          mimeType: fc.option(fc.string(), { nil: null }),
          compatibility: fc.constantFrom("verified" as const, "unverified" as const)
        }),
        fc.constantFrom<ContentProtection>(WIDEVINE, UNKNOWN, {
          state: "protected",
          keySystem: "playready",
          licenseUrl: null
        }),
        (fields, protection) => {
          const decision = protectionDecisionFor(NATIVE_MPV_CAPABILITIES, {
            ...fields,
            protection
          });
          return decision.playable === false;
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe("a clear candidate is playable by either engine", () => {
  it("is accepted by both, each with its own reason", () => {
    for (const adapter of [NATIVE_MPV_CAPABILITIES, WEB_SHAKA_CAPABILITIES]) {
      const decision = protectionDecisionFor(adapter, candidate(CLEAR));
      expect(decision.playable).toBe(true);
      if (decision.playable) {
        expect(decision.adapterId).toBe(adapter.id);
        /* Invariant 4 applies to the accepting branch too. */
        expect(decision.reason).toContain("clear");
      }
    }
  });
});

describe("routing on a desktop build", () => {
  it("sends a clear candidate to the native engine", () => {
    const outcome = routeCandidate(candidate(CLEAR), DESKTOP_ADAPTER_PREFERENCE);
    expect(outcome.adapterId).toBe("native-mpv");
  });

  it("sends a protected candidate to Shaka BY THE NATIVE ENGINE REFUSING IT", () => {
    /*
     * Not by reordering the preference list for protected content. The refusal
     * has to be IN THE TRAIL, because "why is this desktop session running on
     * Shaka" is the question an operator will actually ask.
     */
    const outcome = routeCandidate(candidate(WIDEVINE), DESKTOP_ADAPTER_PREFERENCE);
    expect(outcome.adapterId).toBe("web-shaka");
    expect(outcome.decisions).toHaveLength(2);
    const [first] = outcome.decisions;
    expect(first?.playable).toBe(false);
    if (first && !first.playable) expect(first.refusal).toBe("drm_required_no_cdm");
  });

  it("records EVERY adapter's answer, not just the winner's", () => {
    const outcome = routeCandidate(candidate(CLEAR), DESKTOP_ADAPTER_PREFERENCE);
    expect(outcome.decisions.map((d) => d.adapterId)).toEqual(["native-mpv", "web-shaka"]);
  });

  it("does not re-sort the preference it was given", () => {
    /* A second opinion about preference could disagree with the ranking already
     * published, exactly as playback-machine.ts refuses to re-sort candidates. */
    const reversed = [...DESKTOP_ADAPTER_PREFERENCE].reverse();
    expect(routeCandidate(candidate(CLEAR), reversed).adapterId).toBe("web-shaka");
  });
});

describe("routing on a web build", () => {
  it("has exactly one adapter and it is the one with a CDM", () => {
    expect(WEB_ADAPTER_PREFERENCE).toHaveLength(1);
    expect(routeCandidate(candidate(WIDEVINE), WEB_ADAPTER_PREFERENCE).adapterId).toBe("web-shaka");
  });

  it("reports no adapter rather than guessing when every one refuses", () => {
    const outcome = routeCandidate(candidate(WIDEVINE), [NATIVE_MPV_CAPABILITIES]);
    expect(outcome.adapterId).toBeNull();
    expect(outcome.decisions).toHaveLength(1);
  });
});

describe("the decision is reconstructible, and leaks nothing", () => {
  it("is pure: the same candidate always routes the same way", () => {
    const c = candidate(WIDEVINE);
    const a = routeCandidate(c, DESKTOP_ADAPTER_PREFERENCE);
    const b = routeCandidate(c, DESKTOP_ADAPTER_PREFERENCE);
    expect(a).toEqual(b);
  });

  it("never puts a licence URL in a reason", () => {
    /*
     * A licence endpoint can carry a per-session token in its query string, and
     * a reason trail is logged. `describeContentProtection` is the shared token
     * for exactly this, and using it rather than formatting here is what makes
     * this assertion hold for every call site at once.
     */
    const outcome = routeCandidate(candidate(WIDEVINE), DESKTOP_ADAPTER_PREFERENCE);
    const trail = outcome.decisions.map((d) => d.reason).join("\n");
    expect(trail).not.toContain("SECRET");
    expect(trail).not.toContain("licence.invalid");
    expect(trail).toContain("protected:widevine");
  });

  it("reads no clock, no environment and no randomness", () => {
    const code = readFileSync(new URL("./adapter-routing.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const forbidden of ["Date.", "Math.random", "process.env", "fetch(", "globalThis"]) {
      expect(code, `routing must not reach ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain("routeCandidate");
  });

  it("derives protection from the contract rather than re-deriving it", () => {
    /* Two opinions about whether a candidate is encrypted would eventually
     * disagree, and the trail would then explain a decision nobody made. */
    const code = readFileSync(new URL("./adapter-routing.ts", import.meta.url), "utf8");
    expect(code).toContain("requiresContentDecryptionModule");
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped, "a local protection test is a second opinion").not.toMatch(
      /state\s*===\s*"protected"|state\s*!==\s*"clear"/
    );
  });
});
