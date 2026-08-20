import { describe, expect, it } from "vitest";
import { toPlaybackStats } from "./playback-stats";

describe("units", () => {
  it("converts every Shaka time field from seconds to milliseconds", () => {
    // Shaka reports seconds throughout; CMCD is milliseconds. This is named in
    // docs/RESEARCH_PLAYBACK.md as the most likely unit bug in this area, so
    // every field is checked rather than a representative one.
    const stats = toPlaybackStats({
      loadLatency: 0.25,
      timeToFirstFrame: 1.5,
      manifestTimeSeconds: 0.125,
      drmTimeSeconds: 0.5,
      playTime: 12,
      pauseTime: 3,
      bufferingTime: 0.75,
      licenseTime: 0.0625,
      liveLatency: 4,
      maxSegmentDuration: 6
    });

    expect(stats.loadLatencyMs).toBe(250);
    expect(stats.timeToFirstFrameMs).toBe(1500);
    expect(stats.manifestTimeMs).toBe(125);
    expect(stats.drmTimeMs).toBe(500);
    expect(stats.playTimeMs).toBe(12_000);
    expect(stats.pauseTimeMs).toBe(3_000);
    expect(stats.bufferingTimeMs).toBe(750);
    expect(stats.licenseTimeMs).toBe(62.5);
    expect(stats.liveLatencyMs).toBe(4_000);
    expect(stats.maxSegmentDurationMs).toBe(6_000);
  });

  it("keeps loadLatency and timeToFirstFrame as two different numbers", () => {
    /*
     * `loadLatency` measures time to `loadedmetadata` and Shaka's own JSDoc says
     * it "does NOT imply that playback can start". `timeToFirstFrame` is startup
     * time and is what maps to CMCD `msd`. Neither is a fallback for the other,
     * so an absent startup time stays absent instead of borrowing a number that
     * would silently under-report start delay.
     */
    const stats = toPlaybackStats({ loadLatency: 0.375, timeToFirstFrame: Number.NaN });
    expect(stats.loadLatencyMs).toBe(375);
    expect(stats.timeToFirstFrameMs).toBeNull();
  });

  it("does not round, because rounding belongs at the CMCD boundary", () => {
    expect(toPlaybackStats({ liveLatency: 0.0015 }).liveLatencyMs).toBeCloseTo(1.5, 10);
  });

  it("leaves counts and bandwidths in their own units", () => {
    const stats = toPlaybackStats({
      width: 1920,
      height: 1080,
      streamBandwidth: 4_500_000,
      estimatedBandwidth: 9_000_000,
      currentCodecs: "avc1.640028,mp4a.40.2",
      decodedFrames: 900,
      droppedFrames: 2,
      corruptedFrames: 0,
      gapsJumped: 1,
      stallsDetected: 0,
      completionPercent: 42,
      manifestSizeBytes: 4_096,
      bytesDownloaded: 1_234_567,
      nonFatalErrorCount: 3,
      manifestPeriodCount: 2,
      manifestGapCount: 1
    });

    expect(stats).toMatchObject({
      widthPx: 1920,
      heightPx: 1080,
      streamBandwidthBps: 4_500_000,
      estimatedBandwidthBps: 9_000_000,
      currentCodecs: "avc1.640028,mp4a.40.2",
      decodedFrames: 900,
      droppedFrames: 2,
      corruptedFrames: 0,
      gapsJumped: 1,
      stallsDetected: 0,
      completionPercent: 42,
      manifestSizeBytes: 4_096,
      bytesDownloaded: 1_234_567,
      nonFatalErrorCount: 3,
      manifestPeriodCount: 2,
      manifestGapCount: 1
    });
  });
});

describe("unavailable values", () => {
  it("turns NaN into null and never into zero", () => {
    /*
     * Shaka reports an unavailable number as NaN, not null and not 0. NaN
     * survives arithmetic, comparison and JSON.stringify (as null) without ever
     * failing, so an unguarded NaN dropped-frame count becomes a reported
     * dropped-frame count of zero somewhere downstream.
     */
    const stats = toPlaybackStats({
      droppedFrames: Number.NaN,
      decodedFrames: 0,
      liveLatency: Number.NaN,
      playTime: 0
    });

    expect(stats.droppedFrames).toBeNull();
    expect(stats.liveLatencyMs).toBeNull();
    expect(stats.decodedFrames).toBe(0);
    expect(stats.playTimeMs).toBe(0);
  });

  it("rejects infinities and non-numbers as firmly as NaN", () => {
    const stats = toPlaybackStats({
      estimatedBandwidth: Number.POSITIVE_INFINITY,
      width: "1920",
      height: null,
      currentCodecs: ""
    });

    expect(stats.estimatedBandwidthBps).toBeNull();
    expect(stats.widthPx).toBeNull();
    expect(stats.heightPx).toBeNull();
    expect(stats.currentCodecs).toBeNull();
  });

  it("returns an all-null snapshot rather than throwing on a missing stats object", () => {
    // The usual caller is a telemetry tick, and a throwing telemetry tick takes
    // playback down with it.
    const stats = toPlaybackStats(null);
    expect(stats.loadLatencyMs).toBeNull();
    expect(stats.stateHistory).toEqual([]);
    expect(stats.switchHistory).toEqual([]);
  });
});

describe("the reason trail", () => {
  it("converts state history timestamps from epoch seconds to epoch milliseconds", () => {
    const stats = toPlaybackStats({
      stateHistory: [
        { timestamp: 1_700_000_000, state: "buffering", duration: 1.25 },
        { timestamp: 1_700_000_001.25, state: "playing", duration: 30 }
      ]
    });

    expect(stats.stateHistory).toEqual([
      { timestampMs: 1_700_000_000_000, state: "buffering", durationMs: 1_250 },
      { timestampMs: 1_700_000_001_250, state: "playing", durationMs: 30_000 }
    ]);
  });

  it("preserves fromAdaptation, which is what makes the trail explanatory", () => {
    // It is the difference between "ABR chose this" and "the application called
    // selectTrack" — a switch history without it only describes what happened.
    const stats = toPlaybackStats({
      switchHistory: [
        { timestamp: 1_700_000_000, id: 3, type: "variant", fromAdaptation: true, bandwidth: 4e6 },
        { timestamp: 1_700_000_010, id: 1, type: "variant", fromAdaptation: false, bandwidth: null }
      ]
    });

    expect(stats.switchHistory).toEqual([
      {
        timestampMs: 1_700_000_000_000,
        trackId: 3,
        type: "variant",
        fromAdaptation: true,
        bandwidthBps: 4e6
      },
      {
        timestampMs: 1_700_000_010_000,
        trackId: 1,
        type: "variant",
        fromAdaptation: false,
        bandwidthBps: null
      }
    ]);
  });

  it("never defaults fromAdaptation when an entry did not state it", () => {
    const stats = toPlaybackStats({ switchHistory: [{ timestamp: 1, id: 0, type: "text" }] });
    expect(stats.switchHistory[0]?.fromAdaptation).toBeNull();
  });

  it("treats a history that is not an array as empty", () => {
    const stats = toPlaybackStats({ stateHistory: "unavailable", switchHistory: undefined });
    expect(stats.stateHistory).toEqual([]);
    expect(stats.switchHistory).toEqual([]);
  });
});
