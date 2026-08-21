import { describe, expect, it } from "vitest";
import { BASELINE_ENGINE_CONFIG } from "../playback-controller";
import type { AvContinuityReasonCode } from "./av-continuity";
import { assertSegmentsMode, type SequenceModeObservation } from "./sequence-mode";

function codes(observation: SequenceModeObservation): readonly AvContinuityReasonCode[] {
  return observation.reasons.map((reason) => reason.code);
}

describe("asserting segments mode", () => {
  it("stays quiet when both manifest families state sequenceMode: false", () => {
    const observation = assertSegmentsMode({
      manifest: { dash: { sequenceMode: false }, hls: { sequenceMode: false } }
    });

    expect(observation.proxyFired).toBe(false);
    expect(codes(observation).filter((code) => code === "sequence_mode_asserted_false")).toHaveLength(
      2
    );
  });

  it("holds the player's own baseline configuration to that rule", () => {
    /*
     * `BASELINE_ENGINE_CONFIG` is imported rather than restated, so if a future
     * edit to `playback-controller.ts` drops `sequenceMode: false` from either
     * manifest family, this test fails here rather than the drift being
     * discovered in a stream. PL-0504 owns no file in that directory; this is
     * how it guards one anyway.
     */
    const observation = assertSegmentsMode(BASELINE_ENGINE_CONFIG);
    expect(observation.proxyFired).toBe(false);
  });

  it("fires when a manifest family enables sequence mode", () => {
    const observation = assertSegmentsMode({
      manifest: { dash: { sequenceMode: false }, hls: { sequenceMode: true } }
    });

    expect(observation.proxyFired).toBe(true);
    expect(codes(observation)).toContain("sequence_mode_enabled");
    expect(codes(observation)).toContain("sequence_mode_asserted_false");
  });

  it("fires when the value is left to the default", () => {
    /*
     * An unstated value is not a pass. `sequenceMode: false` is the shipped
     * default in shaka-player 5.2.6 for both families, but Shaka's own JSDoc
     * for `manifest.hls.sequenceMode` still claims the HLS default is `true` —
     * the documentation and the shipped default disagree — and relying on a
     * default that its own documentation contradicts is the risk this proxy
     * exists to surface.
     */
    expect(assertSegmentsMode({}).proxyFired).toBe(true);
    expect(codes(assertSegmentsMode({}))).toContain("sequence_mode_unstated");
    expect(assertSegmentsMode(null).proxyFired).toBe(true);
    expect(assertSegmentsMode({ manifest: { dash: { sequenceMode: false } } }).proxyFired).toBe(
      true
    );
  });

  it("treats a non-boolean value as unstated rather than as truthy", () => {
    // A configuration key set to a string is a configuration mistake, and
    // guessing which boolean it meant would be inventing evidence.
    const observation = assertSegmentsMode({
      manifest: { dash: { sequenceMode: "false" }, hls: { sequenceMode: 0 } }
    });
    expect(observation.proxyFired).toBe(true);
    expect(codes(observation).filter((code) => code === "sequence_mode_unstated")).toHaveLength(2);
  });

  it("carries no magnitude, because a configuration risk has no number", () => {
    expect(assertSegmentsMode(BASELINE_ENGINE_CONFIG).magnitude).toBeNull();
  });

  it("evaluates the manifest families in a fixed order", () => {
    const first = assertSegmentsMode({
      manifest: { hls: { sequenceMode: true }, dash: { sequenceMode: false } }
    });
    const second = assertSegmentsMode({
      manifest: { dash: { sequenceMode: false }, hls: { sequenceMode: true } }
    });

    // Reason order must not depend on the key order of the configuration
    // object, or the same session produces two different trails.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(codes(first)).toEqual([
      "sequence_mode_asserted_false",
      "sequence_mode_enabled",
      "proxy_not_measurement"
    ]);
  });
});
