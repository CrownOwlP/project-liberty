import { describe, expect, it } from "vitest";
import { DEFAULT_AV_CONTINUITY_POLICY, type AvContinuityReasonCode } from "./av-continuity";
import {
  readElementBufferedRanges,
  readSourceBufferRanges,
  type AvTrackKind,
  type BufferedRange,
  type TrackBufferedReading
} from "./buffered-ranges";
import { detectVideoHole, type VideoHoleObservation } from "./video-hole";

function reading<TTrack extends AvTrackKind>(
  track: TTrack,
  ranges: readonly (readonly [number, number])[]
): TrackBufferedReading<TTrack> {
  return {
    source: "source-buffer",
    track,
    ranges: ranges.map(([startSeconds, endSeconds]): BufferedRange => ({ startSeconds, endSeconds }))
  };
}

function codes(observation: VideoHoleObservation): readonly AvContinuityReasonCode[] {
  return observation.reasons.map((reason) => reason.code);
}

/**
 * The canonical video hole: video is missing [10, 10.4] while a single audio
 * range covers the whole timeline. This is the hls.js `nudgeOnVideoHole` case —
 * playback continues past the gap without rendering and then stalls.
 */
const VIDEO_WITH_HOLE = reading("video", [
  [0, 10],
  [10.4, 30]
]);
const AUDIO_CONTIGUOUS = reading("audio", [[0, 30]]);

describe("firing on a genuine video hole", () => {
  it("fires when video is discontinuous and audio is contiguous across the gap", () => {
    const observation = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(true);
    expect(codes(observation)).toContain("video_hole_at_playhead");
    expect(codes(observation)).toContain("audio_contiguous_across_hole");
  });

  it("reports the gap span as media-timeline seconds and nothing else", () => {
    const observation = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    // The magnitude is a tagged union with no millisecond branch and no
    // untagged `value`, so a caller cannot read the number without first
    // narrowing on `unit` — as this assertion has to — and therefore without
    // seeing that it is a span of the media timeline rather than an A/V offset.
    const magnitude = observation.magnitude;
    if (magnitude === null || magnitude.unit !== "seconds-of-media-timeline") {
      throw new Error("expected a media-timeline magnitude");
    }
    expect(magnitude.seconds).toBeCloseTo(0.4, 10);
  });

  it("recommends a bounded nudge when the playhead is already inside the hole", () => {
    const observation = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.recommendedNudge?.resumeAtSeconds).toBeCloseTo(10.4, 10);
    expect(observation.recommendedNudge?.nudgeSeconds).toBeCloseTo(0.3, 10);
    expect(observation.recommendedNudge?.boundSeconds).toBe(
      DEFAULT_AV_CONTINUITY_POLICY.maxNudgeSeconds
    );
    expect(codes(observation)).toContain("nudge_within_bound");
  });

  it("fires but recommends nothing when the hole is still ahead of the playhead", () => {
    const observation = detectVideoHole({
      playheadSeconds: 9.8,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(true);
    expect(observation.recommendedNudge).toBeNull();
    expect(codes(observation)).toContain("hole_ahead_of_playhead");
  });

  it("refuses to recommend a jump larger than the policy bound", () => {
    const observation = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: reading("video", [
        [0, 10],
        [25, 40]
      ]),
      audioBuffered: reading("audio", [[0, 40]]),
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(true);
    expect(observation.recommendedNudge).toBeNull();
    expect(codes(observation)).toContain("hole_exceeds_nudge_bound");
  });
});

describe("not firing on a contiguous buffer", () => {
  it("does not fire when the video SourceBuffer has no interior gap", () => {
    const observation = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: reading("video", [[0, 30]]),
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(false);
    expect(observation.recommendedNudge).toBeNull();
    expect(codes(observation)).toContain("video_buffer_contiguous");
  });

  it("does not fire on a gap below the hole threshold", () => {
    // 50 ms is fMP4 timestamp rounding between segments, not missing media.
    // Treating rounding as a hole would fire on every healthy stream, which is
    // how a diagnostic gets muted.
    const observation = detectVideoHole({
      playheadSeconds: 10.01,
      videoBuffered: reading("video", [
        [0, 10],
        [10.05, 30]
      ]),
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(false);
    expect(codes(observation)).toContain("gap_below_hole_threshold");
  });

  it("does not fire when both tracks are short over the interval", () => {
    // A gap in both tracks is ordinary buffer starvation. PL-0502 models it and
    // Shaka jumps it; reporting it here would make this a second, worse
    // rebuffer counter rather than a specific signal.
    const observation = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: reading("audio", [
        [0, 10],
        [10.4, 30]
      ]),
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(false);
    expect(codes(observation)).toContain("audio_not_contiguous_across_hole");
  });

  it("does not fire on a gap beyond the lookahead window", () => {
    const observation = detectVideoHole({
      playheadSeconds: 5,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(observation.proxyFired).toBe(false);
    expect(codes(observation)).toContain("gap_beyond_lookahead");
  });

  it("reports an unusable playhead or an empty track as not observed", () => {
    const noPlayhead = detectVideoHole({
      playheadSeconds: Number.NaN,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
    expect(noPlayhead.proxyFired).toBe(false);
    expect(codes(noPlayhead)).toContain("buffered_ranges_unusable");

    const noAudio = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: reading("audio", []),
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
    expect(noAudio.proxyFired).toBe(false);
    expect(codes(noAudio)).toContain("buffered_ranges_unusable");
  });
});

describe("per-SourceBuffer reading, not the element intersection", () => {
  it("cannot fire when fed the intersected view of the same stream", () => {
    /*
     * THE WHOLE TASK IN ONE TEST. `HTMLMediaElement.buffered` is the
     * INTERSECTION of every SourceBuffer, so for the stream above it reports
     * [0,10] and [10.4,30] for BOTH tracks: the video hole survives, but the
     * fact that audio was continuous across it does not. Fed that, the detector
     * concludes both tracks are short and correctly declines to fire — which is
     * exactly why reading the element instead of the two SourceBuffers produces
     * a detector that is structurally incapable of ever reporting a video hole.
     */
    const intersected: readonly (readonly [number, number])[] = [
      [0, 10],
      [10.4, 30]
    ];

    const fromIntersection = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: reading("video", intersected),
      audioBuffered: reading("audio", intersected),
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
    const fromSourceBuffers = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(fromIntersection.proxyFired).toBe(false);
    expect(fromSourceBuffers.proxyFired).toBe(true);
  });

  it("rejects an element-buffered reading at compile time", () => {
    const elementReading = readElementBufferedRanges(null);
    expect(elementReading.source).toBe("media-element-intersection");

    detectVideoHole({
      playheadSeconds: 10.1,
      // @ts-expect-error `ElementBufferedReading` is not a per-track reading.
      videoBuffered: elementReading,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
  });

  it("rejects a swapped video/audio reading at compile time", () => {
    const audio = readSourceBufferRanges("audio", null);

    detectVideoHole({
      playheadSeconds: 10.1,
      // @ts-expect-error the video argument is typed `TrackBufferedReading<"video">`.
      videoBuffered: audio,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
  });
});

describe("determinism", () => {
  it("does not depend on the order the buffered ranges arrived in", () => {
    // Six order-dependence defects in this project have been of this shape, so
    // the canonical form is computed rather than assumed.
    const forwards = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
    const backwards = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: reading("video", [
        [10.4, 30],
        [0, 10]
      ]),
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(backwards).toEqual(forwards);
  });

  it("returns an identical finding, reason strings included, for identical inputs", () => {
    const first = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });
    const second = detectVideoHole({
      playheadSeconds: 10.1,
      videoBuffered: VIDEO_WITH_HOLE,
      audioBuffered: AUDIO_CONTIGUOUS,
      policy: DEFAULT_AV_CONTINUITY_POLICY
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
