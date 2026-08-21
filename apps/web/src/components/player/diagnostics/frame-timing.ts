/* -------------------------------------------------------------------------
 * `requestVideoFrameCallback` proxies — and the unit trap
 *
 * `HTMLVideoElement.requestVideoFrameCallback` is widely supported and is the
 * only view a browser gives of frames actually handed to the compositor. It is
 * still a WICG draft with NO STRICT TIMING GUARANTEES, which is the reason the
 * two signals below are deliberately coarse: they answer "did the presented
 * media time advance" and "were frames presented between callbacks", both of
 * which survive a loose timing contract, rather than anything that would need
 * the timestamps to be accurate to be meaningful.
 *
 * THE UNIT TRAP, WHICH IS IN THE SPECIFICATION ITSELF:
 *
 *   VideoFrameCallbackMetadata field   unit
 *   --------------------------------   ---------------------------------------
 *   presentationTime                   MILLISECONDS (DOMHighResTimeStamp)
 *   expectedDisplayTime                MILLISECONDS (DOMHighResTimeStamp)
 *   mediaTime                          SECONDS (media timeline position)
 *   processingDuration                 SECONDS (duration)
 *   presentedFrames                    a count
 *
 * Two units in one dictionary, with no suffix on any field name. So every
 * field is renamed on the way in — `presentationTimeMs`, `mediaTimeSeconds`,
 * `processingDurationMs` — following the rule `playback-stats.ts` established:
 * a number without a unit suffix in this player is not a duration.
 *
 * THE ARITHMETIC THIS FILE REFUSES TO DO. `expectedDisplayTime - mediaTime *
 * 1000` looks like an audio/video offset and is not one. It mixes a compositor
 * clock with a media timeline position, it says nothing whatever about where
 * the audio is, and it is the exact expression that would produce the
 * millisecond sync claim PL-0504's approved acceptance forbids. It is not
 * computed here, and there is no field for it to be stored in.
 *
 * `mediaTime` MAY BE 0 ON LIVE. When it is, the proxies are SKIPPED rather
 * than computed against zero — a media-time delta measured from a zero that
 * never advanced is a fabricated stall. The cost is one frame pair's worth of
 * signal at the start of a VOD asset, where `mediaTime` is legitimately 0.
 *
 * Nothing here reads a clock. Both frame readings are inputs.
 * ---------------------------------------------------------------------- */

import {
  avReason,
  AV_PROXY_METRICS,
  type AvContinuityFinding,
  type AvProxyObservation,
  type AvUnobservableSignal
} from "./av-continuity";
import { finiteOrNull, formatSeconds, readRecord, secondsToMs } from "./readers";

/**
 * The metadata dictionary, normalised, with units in the names.
 *
 * Every field is `number | null`: `requestVideoFrameCallback` is a draft whose
 * dictionary has gained and lost members, and a missing member must degrade to
 * "not observed" rather than to zero.
 */
export interface VideoFrameReading {
  /** Compositor clock, milliseconds. NOT comparable with `mediaTimeSeconds`. */
  readonly presentationTimeMs: number | null;
  /** Compositor clock, milliseconds. NOT comparable with `mediaTimeSeconds`. */
  readonly expectedDisplayTimeMs: number | null;
  /** MEDIA TIMELINE position, seconds. May legitimately be 0 on live. */
  readonly mediaTimeSeconds: number | null;
  /** A count of frames submitted for composition since the element loaded. */
  readonly presentedFrames: number | null;
  /** Converted from the specification's SECONDS. See the file header. */
  readonly processingDurationMs: number | null;
}

/** Read defensively; see `playback-stats.ts` for why nothing is destructured. */
export function readVideoFrameMetadata(raw: unknown): VideoFrameReading {
  const metadata: Readonly<Record<string, unknown>> = readRecord(raw) ?? {};
  return {
    presentationTimeMs: finiteOrNull(metadata.presentationTime),
    expectedDisplayTimeMs: finiteOrNull(metadata.expectedDisplayTime),
    mediaTimeSeconds: finiteOrNull(metadata.mediaTime),
    presentedFrames: finiteOrNull(metadata.presentedFrames),
    processingDurationMs: secondsToMs(metadata.processingDuration)
  };
}

function unobservable(
  metric: AvUnobservableSignal["metric"],
  reasons: AvUnobservableSignal["reasons"]
): AvUnobservableSignal {
  return {
    evidenceBasis: "unobservable",
    metric,
    evidenceSource: "no-evidence-available",
    reasons
  };
}

/**
 * What to report on a platform without `requestVideoFrameCallback`.
 *
 * A finding rather than an omission, for the same reason as everywhere else
 * here: a report missing an entry looks like a clean run.
 */
export function frameCallbackUnavailable(): readonly AvContinuityFinding[] {
  const reasons = [
    avReason(
      "frame_callback_unavailable",
      "HTMLVideoElement.requestVideoFrameCallback is not present, so no frame presentation " +
        "evidence exists on this platform."
    )
  ];
  return [
    unobservable(AV_PROXY_METRICS.mediaTimeAdvance, reasons),
    unobservable(AV_PROXY_METRICS.presentedFrameGap, reasons)
  ];
}

function mediaTimeAdvance(
  proxyFired: boolean,
  seconds: number,
  reasons: AvProxyObservation["reasons"]
): AvProxyObservation {
  return {
    evidenceBasis: "proxy",
    metric: AV_PROXY_METRICS.mediaTimeAdvance,
    evidenceSource: "request-video-frame-callback",
    proxyFired,
    magnitude: { unit: "seconds-of-media-timeline", seconds },
    reasons
  };
}

function presentedFrameGap(
  proxyFired: boolean,
  frames: number,
  reasons: AvProxyObservation["reasons"]
): AvProxyObservation {
  return {
    evidenceBasis: "proxy",
    metric: AV_PROXY_METRICS.presentedFrameGap,
    evidenceSource: "request-video-frame-callback",
    proxyFired,
    magnitude: { unit: "frames-presented", frames },
    reasons
  };
}

/**
 * Two proxies from two consecutive frame callbacks.
 *
 * `com.liberty-avs-media-time-advance` fires when the presented media time did
 * NOT advance between callbacks — the picture repeated while the compositor
 * kept being handed frames, which is the frozen-picture symptom people report
 * as "out of sync". `com.liberty-avs-presented-frame-gap` fires when more than
 * one frame was presented between callbacks, which the draft permits and which
 * is worth knowing before reading the first proxy.
 *
 * Neither is an offset. Both magnitudes are tagged units that have no
 * millisecond branch.
 */
export function observeFrameContinuity(
  previous: VideoFrameReading,
  current: VideoFrameReading
): readonly AvContinuityFinding[] {
  return [advanceFinding(previous, current), frameGapFinding(previous, current)];
}

function advanceFinding(
  previous: VideoFrameReading,
  current: VideoFrameReading
): AvContinuityFinding {
  const before = previous.mediaTimeSeconds;
  const after = current.mediaTimeSeconds;

  if (before === null || after === null) {
    return unobservable(AV_PROXY_METRICS.mediaTimeAdvance, [
      avReason(
        "frame_metadata_unusable",
        "A frame callback reported no usable mediaTime, so no media-timeline advance could be " +
          "derived. Reported as not observed rather than as zero advance."
      )
    ]);
  }

  /*
   * THE LIVE SKIP. The specification allows `mediaTime` to be 0 on a live
   * stream. Differencing against that zero would manufacture either a large
   * bogus advance or a stall that never happened, and both would be
   * indistinguishable from the real thing downstream.
   */
  if (before === 0 || after === 0) {
    return unobservable(AV_PROXY_METRICS.mediaTimeAdvance, [
      avReason(
        "media_time_zero_on_live",
        "A frame callback reported mediaTime === 0, which requestVideoFrameCallback permits on " +
          "live streams. The advance proxy is skipped rather than differenced against a zero " +
          "that may never advance."
      )
    ]);
  }

  const advanceSeconds = after - before;

  if (advanceSeconds > 0) {
    return mediaTimeAdvance(false, advanceSeconds, [
      avReason(
        "media_time_advanced",
        `Presented media time advanced by ${formatSeconds(advanceSeconds)} between callbacks ` +
          `(${formatSeconds(before)} to ${formatSeconds(after)}).`
      ),
      avReason(
        "proxy_not_measurement",
        "An advance on the media timeline is not an audio/video offset. It says the picture " +
          "moved, not where the audio was."
      )
    ]);
  }

  return mediaTimeAdvance(true, advanceSeconds, [
    avReason(
      "media_time_did_not_advance",
      `Presented media time did not advance between callbacks (${formatSeconds(before)} to ` +
        `${formatSeconds(after)}, delta ${formatSeconds(advanceSeconds)}): the same frame was ` +
        "presented again, or the timeline moved backwards."
    ),
    avReason(
      "proxy_not_measurement",
      "A repeated frame is a video continuity risk. It is not a measurement of audio/video " +
        "alignment and must not be reported as one."
    )
  ]);
}

function frameGapFinding(
  previous: VideoFrameReading,
  current: VideoFrameReading
): AvContinuityFinding {
  const before = previous.presentedFrames;
  const after = current.presentedFrames;

  if (before === null || after === null) {
    return unobservable(AV_PROXY_METRICS.presentedFrameGap, [
      avReason(
        "frame_metadata_unusable",
        "A frame callback reported no usable presentedFrames count, so no frame delta could be " +
          "derived."
      )
    ]);
  }

  const delta = after - before;

  if (delta < 1) {
    /*
     * `presentedFrames` is monotonic by specification, so a non-increasing
     * delta means the two readings did not come from one uninterrupted
     * sequence — a reload, a track change, or a stale reading held across a
     * `load()`. Guessing which would be inventing evidence.
     */
    return unobservable(AV_PROXY_METRICS.presentedFrameGap, [
      avReason(
        "frame_metadata_unusable",
        `presentedFrames did not increase (${String(before)} then ${String(after)}). The counter ` +
          "is monotonic per specification, so the two readings are not from one uninterrupted " +
          "sequence and no frame gap can be derived from them."
      )
    ]);
  }

  if (delta === 1) {
    return presentedFrameGap(false, delta, [
      avReason(
        "presented_frames_contiguous",
        "Exactly one frame was presented between callbacks, so the advance proxy beside this " +
          "one is reading consecutive frames."
      )
    ]);
  }

  return presentedFrameGap(true, delta, [
    avReason(
      "presented_frames_skipped",
      `${String(delta)} frames were presented between callbacks, so ${String(delta - 1)} were ` +
        "not observed. requestVideoFrameCallback is a WICG draft with no strict timing " +
        "guarantees and may coalesce callbacks, so this is a caveat on the advance proxy as " +
        "much as a signal of its own."
    )
  ]);
}
