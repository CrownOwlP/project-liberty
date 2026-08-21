import { describe, expect, it } from "vitest";
import type { AvContinuityFinding, AvContinuityReasonCode } from "./av-continuity";
import {
  frameCallbackUnavailable,
  observeFrameContinuity,
  readVideoFrameMetadata,
  type VideoFrameReading
} from "./frame-timing";

function codes(finding: AvContinuityFinding | undefined): readonly AvContinuityReasonCode[] {
  return finding === undefined ? [] : finding.reasons.map((reason) => reason.code);
}

function frame(overrides: Partial<VideoFrameReading>): VideoFrameReading {
  return {
    presentationTimeMs: 1_000,
    expectedDisplayTimeMs: 1_016,
    mediaTimeSeconds: 12,
    presentedFrames: 300,
    processingDurationMs: 4,
    ...overrides
  };
}

describe("the seconds/milliseconds trap in VideoFrameCallbackMetadata", () => {
  it("keeps millisecond fields in milliseconds and second fields in seconds", () => {
    /*
     * The dictionary mixes two units with no suffix on any field name:
     * `presentationTime` and `expectedDisplayTime` are DOMHighResTimeStamps in
     * MILLISECONDS, while `mediaTime` and `processingDuration` are SECONDS.
     */
    const reading = readVideoFrameMetadata({
      presentationTime: 1_234.5,
      expectedDisplayTime: 1_250.5,
      mediaTime: 12.25,
      presentedFrames: 300,
      processingDuration: 0.004
    });

    expect(reading.presentationTimeMs).toBe(1_234.5);
    expect(reading.expectedDisplayTimeMs).toBe(1_250.5);
    expect(reading.mediaTimeSeconds).toBe(12.25);
    // The one conversion: SECONDS in, milliseconds out, and the name says so.
    expect(reading.processingDurationMs).toBe(4);
  });

  it("never derives a millisecond offset by mixing the two clocks", () => {
    // `expectedDisplayTime - mediaTime * 1000` looks like an A/V offset and is
    // not one: it mixes a compositor clock with a media-timeline position and
    // says nothing about where the audio is. No field exists to hold it.
    const reading = readVideoFrameMetadata({
      presentationTime: 1_234.5,
      expectedDisplayTime: 1_250.5,
      mediaTime: 12.25,
      presentedFrames: 300
    });
    expect(Object.keys(reading).sort()).toEqual([
      "expectedDisplayTimeMs",
      "mediaTimeSeconds",
      "presentationTimeMs",
      "presentedFrames",
      "processingDurationMs"
    ]);
  });

  it("degrades a missing or non-finite member to null, never to zero", () => {
    const reading = readVideoFrameMetadata({ mediaTime: Number.NaN });
    expect(reading.mediaTimeSeconds).toBeNull();
    expect(reading.presentedFrames).toBeNull();
    expect(readVideoFrameMetadata(null).presentationTimeMs).toBeNull();
  });
});

describe("mediaTime === 0 on live is skipped, not differenced", () => {
  it("reports the advance proxy as unobservable when either frame reads zero", () => {
    // requestVideoFrameCallback permits `mediaTime` to be 0 on live streams.
    // Differencing against that zero manufactures either a large bogus advance
    // or a stall that never happened, and both are indistinguishable from the
    // real thing downstream.
    const findings = observeFrameContinuity(
      frame({ mediaTimeSeconds: 0 }),
      frame({ mediaTimeSeconds: 0, presentedFrames: 301 })
    );

    const advance = findings[0];
    expect(advance?.evidenceBasis).toBe("unobservable");
    expect(codes(advance)).toContain("media_time_zero_on_live");
    expect(advance).not.toHaveProperty("magnitude");
  });

  it("skips even when only the later frame reads zero", () => {
    const findings = observeFrameContinuity(
      frame({ mediaTimeSeconds: 12 }),
      frame({ mediaTimeSeconds: 0, presentedFrames: 301 })
    );
    expect(codes(findings[0])).toContain("media_time_zero_on_live");
  });

  it("still reports the frame-gap proxy, which does not depend on mediaTime", () => {
    const findings = observeFrameContinuity(
      frame({ mediaTimeSeconds: 0 }),
      frame({ mediaTimeSeconds: 0, presentedFrames: 301 })
    );
    expect(findings[1]?.evidenceBasis).toBe("proxy");
  });
});

describe("media time advance", () => {
  it("stays quiet when presented media time advanced", () => {
    const findings = observeFrameContinuity(
      frame({ mediaTimeSeconds: 12 }),
      frame({ mediaTimeSeconds: 12.04, presentedFrames: 301 })
    );

    const advance = findings[0];
    if (advance?.evidenceBasis !== "proxy") throw new Error("expected a proxy observation");
    expect(advance.proxyFired).toBe(false);
    expect(codes(advance)).toContain("media_time_advanced");
  });

  it("fires when the same frame was presented again", () => {
    const findings = observeFrameContinuity(
      frame({ mediaTimeSeconds: 12 }),
      frame({ mediaTimeSeconds: 12, presentedFrames: 301 })
    );

    const advance = findings[0];
    if (advance?.evidenceBasis !== "proxy") throw new Error("expected a proxy observation");
    expect(advance.proxyFired).toBe(true);
    expect(advance.magnitude).toEqual({ unit: "seconds-of-media-timeline", seconds: 0 });
    expect(codes(advance)).toContain("media_time_did_not_advance");
  });

  it("reports an unusable mediaTime as not observed rather than as no advance", () => {
    const findings = observeFrameContinuity(
      frame({ mediaTimeSeconds: null }),
      frame({ presentedFrames: 301 })
    );
    expect(findings[0]?.evidenceBasis).toBe("unobservable");
    expect(codes(findings[0])).toContain("frame_metadata_unusable");
  });
});

describe("presented frame gap", () => {
  it("stays quiet on consecutive frames", () => {
    const findings = observeFrameContinuity(
      frame({ presentedFrames: 300 }),
      frame({ mediaTimeSeconds: 12.04, presentedFrames: 301 })
    );

    const gap = findings[1];
    if (gap?.evidenceBasis !== "proxy") throw new Error("expected a proxy observation");
    expect(gap.proxyFired).toBe(false);
    expect(gap.magnitude).toEqual({ unit: "frames-presented", frames: 1 });
    expect(codes(gap)).toContain("presented_frames_contiguous");
  });

  it("fires when frames were presented between callbacks", () => {
    const findings = observeFrameContinuity(
      frame({ presentedFrames: 300 }),
      frame({ mediaTimeSeconds: 12.12, presentedFrames: 303 })
    );

    const gap = findings[1];
    if (gap?.evidenceBasis !== "proxy") throw new Error("expected a proxy observation");
    expect(gap.proxyFired).toBe(true);
    expect(gap.magnitude).toEqual({ unit: "frames-presented", frames: 3 });
    expect(codes(gap)).toContain("presented_frames_skipped");
  });

  it("refuses to derive a gap when the monotonic counter did not increase", () => {
    // `presentedFrames` is monotonic per specification, so a non-increasing
    // delta means the two readings are not from one uninterrupted sequence.
    const findings = observeFrameContinuity(
      frame({ presentedFrames: 300 }),
      frame({ mediaTimeSeconds: 12.04, presentedFrames: 2 })
    );
    expect(findings[1]?.evidenceBasis).toBe("unobservable");
    expect(codes(findings[1])).toContain("frame_metadata_unusable");
  });
});

describe("platforms without requestVideoFrameCallback", () => {
  it("reports both proxies as unobservable rather than omitting them", () => {
    // A report missing an entry looks like a clean run.
    const findings = frameCallbackUnavailable();
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.evidenceBasis).toBe("unobservable");
      expect(codes(finding)).toContain("frame_callback_unavailable");
    }
  });
});

describe("determinism", () => {
  it("returns an identical result, reason strings included, for identical inputs", () => {
    const inputs: readonly [VideoFrameReading, VideoFrameReading] = [
      frame({ mediaTimeSeconds: 12 }),
      frame({ mediaTimeSeconds: 12, presentedFrames: 304 })
    ];
    expect(JSON.stringify(observeFrameContinuity(...inputs))).toBe(
      JSON.stringify(observeFrameContinuity(...inputs))
    );
  });
});
