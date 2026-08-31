/* -------------------------------------------------------------------------
 * The video hole — PL-0504's primary arm
 *
 * A discontinuity in the VIDEO SourceBuffer at or just ahead of the playhead,
 * while AUDIO is contiguous across the same interval.
 *
 * This is the highest-value honest detector available to a browser, and it is
 * not a theoretical one: hls.js ships `nudgeOnVideoHole` for precisely this
 * shape, citing a Chrome bug where playback continues past a gap in the video
 * buffer without rendering anything and then stalls. The user-visible symptom
 * is a frozen picture with audio continuing — which is what people report as
 * "out of sync" — so this is both the closest observable analogue to the thing
 * PL-0504 was originally asked for AND a genuinely different fact about the
 * stream, which is why it is reported under its own name rather than converted
 * into a sync claim.
 *
 * WHY THE AUDIO CONDITION IS PART OF THE RULE. A gap in both tracks is
 * ordinary buffer starvation: PL-0502 already models it, Shaka already jumps
 * it, and `gapsJumped`/`stallsDetected` in `playback-stats.ts` already count
 * it. The interesting, under-diagnosed case is the asymmetric one — video is
 * missing over an interval that audio has. Requiring audio contiguity is what
 * makes this proxy specific rather than a second, worse rebuffer counter.
 *
 * WHAT IT IS NOT. The gap span is a span of the MEDIA TIMELINE. It is not an
 * offset between audio and video, it cannot be converted into one, and
 * `AvProxyMagnitude` has no branch that would let a caller read it as one.
 *
 * Every number in this file is seconds. Nothing here reads a clock.
 * ---------------------------------------------------------------------- */

import {
  avReason,
  AV_PROXY_METRICS,
  type AvContinuityPolicy,
  type AvContinuityReason,
  type AvProxyObservation,
  type AvUnobservableSignal
} from "./av-continuity";
import {
  containsInstant,
  describeRanges,
  gapsBetween,
  normaliseRanges,
  spansInterval,
  type BufferedRange,
  type TrackBufferedReading
} from "./buffered-ranges";
import { finiteOrNull, formatSeconds } from "./readers";

export interface VideoHoleInput {
  /**
   * `video.currentTime`. The HTML specification's OFFICIAL PLAYBACK POSITION,
   * used here as a position on the media timeline — which is all it is — and
   * never as a clock.
   */
  readonly playheadSeconds: number;
  /** Per-track. `TrackBufferedReading<"video">`, never `video.buffered`. */
  readonly videoBuffered: TrackBufferedReading<"video">;
  /** Per-track. `TrackBufferedReading<"audio">`, never `video.buffered`. */
  readonly audioBuffered: TrackBufferedReading<"audio">;
  readonly policy: AvContinuityPolicy;
}

/**
 * A bounded recovery recommendation. ADVICE, NOT AN ACTION.
 *
 * Nothing in this directory seeks, nudges or touches the media element. The
 * detector computes where playback would have to resume to clear the hole and
 * whether that jump is inside the policy bound; whether to take it is a
 * failover decision and belongs to PL-0502's machine, which is the only thing
 * that knows how many recoveries this candidate has already had.
 */
export interface VideoHoleNudge {
  /** Media-timeline position just past the hole. */
  readonly resumeAtSeconds: number;
  /** `resumeAtSeconds - playheadSeconds`. Always positive. */
  readonly nudgeSeconds: number;
  /** The policy bound this was checked against, restated for the record. */
  readonly boundSeconds: number;
}

export interface VideoHoleObservation extends AvProxyObservation {
  readonly metric: typeof AV_PROXY_METRICS.videoHole;
  readonly evidenceSource: "source-buffer-buffered";
  /**
   * Non-null only when the proxy fired, the playhead is already inside the
   * hole, and the jump is within `policy.maxNudgeSeconds`.
   */
  readonly recommendedNudge: VideoHoleNudge | null;
}

function observation(
  proxyFired: boolean,
  magnitudeSeconds: number | null,
  recommendedNudge: VideoHoleNudge | null,
  reasons: readonly AvContinuityReason[]
): VideoHoleObservation {
  return {
    evidenceBasis: "proxy",
    metric: AV_PROXY_METRICS.videoHole,
    evidenceSource: "source-buffer-buffered",
    proxyFired,
    magnitude:
      magnitudeSeconds === null
        ? null
        : { unit: "seconds-of-media-timeline", seconds: magnitudeSeconds },
    recommendedNudge,
    reasons
  };
}

/**
 * "The inputs cannot support a verdict", as a finding rather than as a quiet
 * proxy.
 *
 * THIS DISTINCTION WAS MISSING AND THE MODULE CONTRADICTED ITSELF ABOUT IT. A
 * caller with no per-track readings at all got an `AvUnobservableSignal` from
 * `perTrackBufferedUnavailable`; a caller whose per-track readings turned out to
 * be EMPTY — no SourceBuffer content yet, a track that has not been appended to,
 * a `TimeRanges` every entry of which failed to read — got
 * `proxyFired: false`, which `summariseAvContinuity` counts under
 * `proxiesQuiet`. Same epistemic state, two verdicts, and the second one is the
 * one this whole task exists to refuse: "the video hole proxy was evaluated and
 * found nothing" is a claim, and nothing here was evaluated.
 *
 * The distinction is not stylistic. `proxiesQuiet` is what a dashboard turns
 * into "healthy sessions", and a browser that never populated a SourceBuffer we
 * could reach would have counted as one.
 */
function unobservable(reasons: readonly AvContinuityReason[]): AvUnobservableSignal {
  return {
    evidenceBasis: "unobservable",
    metric: AV_PROXY_METRICS.videoHole,
    evidenceSource: "no-evidence-available",
    reasons
  };
}

/**
 * The evidence line that goes on every finding, fired or not.
 *
 * It names the SOURCE as well as the content: a reader six months from now
 * has to be able to tell from the report alone that these ranges came from two
 * SourceBuffers and not from the element's intersected view, because that is
 * the difference between a detector that works and one that cannot fire.
 */
function evidenceReason(
  video: readonly BufferedRange[],
  audio: readonly BufferedRange[]
): AvContinuityReason {
  return avReason(
    "proxy_not_measurement",
    "Evidence is per-track sourceBuffer.buffered, not the element's intersected buffered. " +
      `video: ${describeRanges(video)}; audio: ${describeRanges(audio)}. ` +
      "A gap span on the media timeline is not an audio/video offset."
  );
}

/**
 * Deterministic: same inputs, same finding, regardless of the order the ranges
 * arrived in. No clock, no ambient state, no `Date.now()`.
 *
 * RETURNS A UNION, and the caller has to look. An `AvUnobservableSignal` means
 * the inputs could not support any verdict; a `VideoHoleObservation` with
 * `proxyFired: false` means the comparison was actually made and no hole was
 * there. Collapsing those two into one boolean is how "we could not see" becomes
 * "we saw nothing wrong" — see `unobservable` above.
 */
export function detectVideoHole(
  input: VideoHoleInput
): VideoHoleObservation | AvUnobservableSignal {
  const { policy } = input;
  const videoRanges = normaliseRanges(input.videoBuffered.ranges, policy.rangeCoalesceSeconds);
  const audioRanges = normaliseRanges(input.audioBuffered.ranges, policy.rangeCoalesceSeconds);
  const evidence = evidenceReason(videoRanges, audioRanges);

  const playheadSeconds = finiteOrNull(input.playheadSeconds);
  if (playheadSeconds === null) {
    return unobservable([
      evidence,
      avReason(
        "buffered_ranges_unusable",
        "The supplied playhead position is not a finite number, so no interval could be " +
          "evaluated. Reported as not observed rather than as no hole."
      )
    ]);
  }

  if (videoRanges.length === 0 || audioRanges.length === 0) {
    return unobservable([
      evidence,
      avReason(
        "buffered_ranges_unusable",
        `A track reported no usable ranges (video: ${String(videoRanges.length)}, ` +
          `audio: ${String(audioRanges.length)}), so video and audio continuity could not be ` +
          "compared."
      )
    ]);
  }

  const gaps = gapsBetween(videoRanges);
  const lookaheadSeconds = Math.max(finiteOrNull(policy.holeLookaheadSeconds) ?? 0, 0);

  /*
   * The earliest gap that has not been passed. `gapsBetween` returns them in
   * timeline order, so `find` is deterministic without a tie-break.
   *
   * `endSeconds > playhead` covers BOTH cases that matter: the playhead sitting
   * inside the gap (the Chrome bug — playback advanced into unrendered media)
   * and the gap sitting just ahead of a playhead still inside a buffered range.
   */
  const gap = gaps.find((candidate) => candidate.endSeconds > playheadSeconds);

  if (gap === undefined) {
    return observation(false, null, null, [
      evidence,
      containsInstant(videoRanges, playheadSeconds)
        ? avReason(
            "video_buffer_contiguous",
            `The video SourceBuffer is contiguous from the playhead ` +
              `(${formatSeconds(playheadSeconds)}) to the end of its buffer.`
          )
        : avReason(
            "playhead_outside_video_buffer",
            `The playhead (${formatSeconds(playheadSeconds)}) is outside every video range and ` +
              "there is no interior gap ahead of it. That is a buffer edge, which is " +
              "starvation rather than a video hole."
          )
    ]);
  }

  if (gap.startSeconds > playheadSeconds + lookaheadSeconds) {
    return observation(false, null, null, [
      evidence,
      avReason(
        "gap_beyond_lookahead",
        `The next video gap starts at ${formatSeconds(gap.startSeconds)}, more than ` +
          `${formatSeconds(lookaheadSeconds)} ahead of the playhead ` +
          `(${formatSeconds(playheadSeconds)}). It may be filled before it is reached.`
      )
    ]);
  }

  const spanSeconds = gap.endSeconds - gap.startSeconds;
  const minHoleSeconds = Math.max(finiteOrNull(policy.minHoleSeconds) ?? 0, 0);

  if (spanSeconds < minHoleSeconds) {
    return observation(false, spanSeconds, null, [
      evidence,
      avReason(
        "gap_below_hole_threshold",
        `A video gap of ${formatSeconds(spanSeconds)} at ${formatSeconds(gap.startSeconds)} is ` +
          `below the ${formatSeconds(minHoleSeconds)} threshold and is treated as fMP4 ` +
          "timestamp rounding between segments rather than missing media."
      )
    ]);
  }

  const audioContiguous = spansInterval(
    audioRanges,
    gap.startSeconds,
    gap.endSeconds,
    policy.audioContiguityMarginSeconds
  );

  if (!audioContiguous) {
    return observation(false, spanSeconds, null, [
      evidence,
      avReason(
        "audio_not_contiguous_across_hole",
        `Video is missing over [${formatSeconds(gap.startSeconds)}, ` +
          `${formatSeconds(gap.endSeconds)}] but no single audio range covers that interval, so ` +
          "both tracks are short there. That is buffer starvation, which PL-0502 and Shaka's " +
          "own gap jumping already handle, and it is not a video hole."
      )
    ]);
  }

  const reasons: AvContinuityReason[] = [
    evidence,
    avReason(
      "video_hole_at_playhead",
      `The video SourceBuffer is missing [${formatSeconds(gap.startSeconds)}, ` +
        `${formatSeconds(gap.endSeconds)}] (${formatSeconds(spanSeconds)}) at a playhead of ` +
        `${formatSeconds(playheadSeconds)}.`
    ),
    avReason(
      "audio_contiguous_across_hole",
      "A single audio range covers that whole interval, so the discontinuity is video-only. " +
        "This is the asymmetric case hls.js added nudgeOnVideoHole for: playback can continue " +
        "past the gap without rendering and then stall."
    )
  ];

  const playheadInsideHole =
    playheadSeconds >= gap.startSeconds && playheadSeconds < gap.endSeconds;

  if (!playheadInsideHole) {
    reasons.push(
      avReason(
        "hole_ahead_of_playhead",
        `The playhead has not reached the hole yet (${formatSeconds(playheadSeconds)} < ` +
          `${formatSeconds(gap.startSeconds)}), so no recovery is recommended: jumping media ` +
          "that is still being fetched would discard content that is about to arrive."
      )
    );
    return observation(true, spanSeconds, null, reasons);
  }

  const nudgeSeconds = gap.endSeconds - playheadSeconds;
  const boundSeconds = Math.max(finiteOrNull(policy.maxNudgeSeconds) ?? 0, 0);

  if (nudgeSeconds > boundSeconds) {
    reasons.push(
      avReason(
        "hole_exceeds_nudge_bound",
        `Clearing the hole would require skipping ${formatSeconds(nudgeSeconds)}, beyond the ` +
          `${formatSeconds(boundSeconds)} bound. No recovery is recommended; discarding that ` +
          "much media is a failover decision, not a diagnostic's."
      )
    );
    return observation(true, spanSeconds, null, reasons);
  }

  reasons.push(
    avReason(
      "nudge_within_bound",
      `Resuming at ${formatSeconds(gap.endSeconds)} would clear the hole by skipping ` +
        `${formatSeconds(nudgeSeconds)}, within the ${formatSeconds(boundSeconds)} bound. This ` +
        "is a recommendation; nothing in the diagnostics layer seeks."
    )
  );

  return observation(
    true,
    spanSeconds,
    { resumeAtSeconds: gap.endSeconds, nudgeSeconds, boundSeconds },
    reasons
  );
}
