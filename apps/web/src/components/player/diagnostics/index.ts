/* -------------------------------------------------------------------------
 * A/V continuity diagnostics — the composed report (PL-0504)
 *
 * The public surface of `apps/web/src/components/player/diagnostics`. Read
 * `av-continuity.ts` first: it carries the argument for why this module reports
 * PROXIES and why none of them may be read as a millisecond A/V offset.
 *
 * `observeAvContinuity` is a pure function of an explicit input. It takes no
 * media element, holds no state, subscribes to nothing, seeks nothing and
 * reads no clock — `observedAtMs` is a required parameter for the same reason
 * `summariseHealthObservations` takes its reference instant as one. The caller
 * (a future telemetry tick, or a support diagnostics panel) does the reading
 * from the DOM and from `PlaybackController.getEnginePlayer()`; this decides
 * what the readings mean, and can therefore be reproduced exactly from a bug
 * report.
 *
 * FINDING ORDER IS FIXED AND THE LIST IS NEVER EMPTY. The lip-sync entry is
 * always first and always says it is unobservable, so no reader of a report or
 * of a collector has to infer from an absence that nothing measured sync.
 *
 * THIS IS NOT A PER-FRAME FUNCTION AND MUST NOT BE CALLED AS ONE. Every finding
 * allocates its own reason objects and formats its own strings, so one call is
 * roughly a dozen small allocations — negligible on a diagnostics tick, and
 * roughly seven hundred allocations a second if a caller wires it straight into
 * `requestVideoFrameCallback` at 60 Hz. The cheap signal that belongs in the
 * callback is `readVideoFrameMetadata`, which allocates one flat record; keep
 * the most recent two of those and compose a report on the telemetry cadence.
 * Nothing here holds history, so the two-reading window is the caller's, and it
 * is the only state this whole directory implies: no growing buffer, no ring, no
 * subscription that outlives a session.
 * ---------------------------------------------------------------------- */

import type { EngineConfig } from "../engine";
import {
  lipSyncOffsetUnobservable,
  type AvContinuityFinding,
  type AvContinuityPolicy,
  type AvContinuityPolicyVersion
} from "./av-continuity";
import { perTrackBufferedUnavailable, type TrackBufferedReading } from "./buffered-ranges";
import {
  frameEvidenceAbsent,
  observeFrameContinuity,
  type AvFrameEvidenceAbsence,
  type VideoFrameReading
} from "./frame-timing";
import { assertSegmentsMode } from "./sequence-mode";
import { detectVideoHole } from "./video-hole";

export {
  AV_CONTINUITY_POLICY_VERSION,
  AV_LIP_SYNC_METRIC,
  AV_PROXY_METRICS,
  DEFAULT_AV_CONTINUITY_POLICY,
  PROHIBITED_AV_INSTRUMENTATION,
  avReason,
  lipSyncOffsetUnobservable
} from "./av-continuity";
export type {
  AvContinuityFinding,
  AvContinuityPolicy,
  AvContinuityPolicyVersion,
  AvContinuityReason,
  AvContinuityReasonCode,
  AvEvidenceSource,
  AvExternalMeasurement,
  AvLipSyncMetricName,
  AvMeasurementRig,
  AvProxyMagnitude,
  AvProxyMetricName,
  AvProxyObservation,
  AvUnobservableSignal
} from "./av-continuity";

export {
  containsInstant,
  describeRanges,
  elementBufferedIsIntersection,
  gapsBetween,
  normaliseRanges,
  perTrackBufferedUnavailable,
  readElementBufferedRanges,
  readSourceBufferRanges,
  readTimeRanges,
  spansInterval
} from "./buffered-ranges";
export type {
  AvTrackKind,
  BufferedRange,
  ElementBufferedReading,
  TimeRangesLike,
  TrackBufferedReading
} from "./buffered-ranges";

export {
  frameCallbackUnavailable,
  frameEvidenceAbsent,
  observeFrameContinuity,
  readVideoFrameMetadata
} from "./frame-timing";
export type { AvFrameEvidenceAbsence, VideoFrameReading } from "./frame-timing";

export { assertSegmentsMode } from "./sequence-mode";
export type { SequenceModeObservation } from "./sequence-mode";

export { detectVideoHole } from "./video-hole";
export type { VideoHoleInput, VideoHoleNudge, VideoHoleObservation } from "./video-hole";

/**
 * The per-track buffered evidence, or an honest statement that there was none.
 *
 * `null` is a legitimate value and it is NOT a failure to answer: on a platform
 * where Shaka fell back to native `src=` HLS there are no SourceBuffers to read,
 * and inventing an empty reading there would make an unobservable session look
 * like a contiguous one.
 */
export interface AvBufferedEvidence {
  /** `video.currentTime`. A position on the media timeline, not a clock. */
  readonly playheadSeconds: number;
  readonly video: TrackBufferedReading<"video">;
  readonly audio: TrackBufferedReading<"audio">;
}

/** Two consecutive `requestVideoFrameCallback` readings, oldest first. */
export interface AvFrameEvidence {
  readonly previous: VideoFrameReading;
  readonly current: VideoFrameReading;
}

export interface AvContinuityInput {
  /**
   * The instant this observation is filed under, supplied by the caller.
   *
   * Required, and never defaulted to a clock read inside this module. A
   * detector that stamps its own findings produces a report that cannot be
   * replayed, which is how six order-dependence defects in this project became
   * hard to reproduce.
   */
  readonly observedAtMs: number;
  readonly policy: AvContinuityPolicy;
  /** `null` when per-track SourceBuffers were not reachable. */
  readonly buffered: AvBufferedEvidence | null;
  /**
   * A frame pair, or WHICH KIND OF ABSENCE this is.
   *
   * Not `null`. The two absences — a browser without
   * `requestVideoFrameCallback` and a session that has only had one callback so
   * far — produce different findings and only the caller can tell them apart;
   * see `AvFrameEvidenceAbsence`. A single `null` made the report claim the API
   * was missing whenever a panel was opened early.
   */
  readonly frames: AvFrameEvidence | AvFrameEvidenceAbsence;
  /** The EFFECTIVE Shaka configuration. See `sequence-mode.ts`. */
  readonly engineConfig: EngineConfig | null;
}

export interface AvContinuityReport {
  readonly policyVersion: AvContinuityPolicyVersion;
  readonly observedAtMs: number;
  /** Never empty. Fixed order: lip-sync, video hole, frame proxies, config. */
  readonly findings: readonly AvContinuityFinding[];
}

export function observeAvContinuity(input: AvContinuityInput): AvContinuityReport {
  const findings: AvContinuityFinding[] = [lipSyncOffsetUnobservable()];

  /*
   * `perTrackBufferedUnavailable`, not `elementBufferedIsIntersection`. The
   * latter is a specific accusation — it says a reading was taken from
   * `HTMLMediaElement.buffered` and is therefore incapable of showing a
   * video-only gap — and a caller who supplied nothing has not done that. The
   * first thing anybody reading that reason does is go looking for the
   * `video.buffered` call, and there is not one. A caller who genuinely holds
   * only the element's intersected view calls that constructor itself.
   */
  findings.push(
    input.buffered === null
      ? perTrackBufferedUnavailable(
          "No per-track SourceBuffer readings were supplied for this observation, so video and " +
            "audio continuity could not be compared. The video hole proxy needs " +
            "sourceBuffer.buffered per track; nothing was read here, from any source."
        )
      : detectVideoHole({
          playheadSeconds: input.buffered.playheadSeconds,
          videoBuffered: input.buffered.video,
          audioBuffered: input.buffered.audio,
          policy: input.policy
        })
  );

  findings.push(
    ...(typeof input.frames === "string"
      ? frameEvidenceAbsent(input.frames)
      : observeFrameContinuity(input.frames.previous, input.frames.current))
  );

  findings.push(assertSegmentsMode(input.engineConfig));

  return {
    policyVersion: input.policy.version,
    observedAtMs: input.observedAtMs,
    findings
  };
}

/**
 * `proxiesFired === 0` IS NOT "HEALTHY", AND NO SINGLE FIELD HERE IS.
 *
 * A session on a browser that implements none of the optional metrics produces
 * `{ proxiesFired: 0, proxiesQuiet: 0, unobservable: 5 }`, and a consumer that
 * alerts on `proxiesFired` alone would read that as the best report it had all
 * day. The three counts are kept separate rather than collapsed into a boolean
 * precisely so that "nothing fired" and "nothing was measurable" cannot be
 * confused; a caller that wants one number has to decide which of them it means.
 */
export interface AvContinuitySummary {
  /** Proxies that fired. NOT a count of sync problems. */
  readonly proxiesFired: number;
  /** Proxies that were EVALUATED and did not fire. Not "arms that were run". */
  readonly proxiesQuiet: number;
  /** Arms that could not be evaluated at all. Never folded into `proxiesQuiet`. */
  readonly unobservable: number;
  /**
   * External measurements present. Always 0 for a report produced in a
   * browser, because nothing in this directory constructs one.
   */
  readonly externalMeasurements: number;
}

/** Counts, for a telemetry tick that wants one line rather than the trail. */
export function summariseAvContinuity(report: AvContinuityReport): AvContinuitySummary {
  let proxiesFired = 0;
  let proxiesQuiet = 0;
  let unobservable = 0;
  let externalMeasurements = 0;

  for (const finding of report.findings) {
    switch (finding.evidenceBasis) {
      case "proxy":
        if (finding.proxyFired) proxiesFired += 1;
        else proxiesQuiet += 1;
        break;
      case "unobservable":
        unobservable += 1;
        break;
      case "external-measurement":
        externalMeasurements += 1;
        break;
    }
  }

  return { proxiesFired, proxiesQuiet, unobservable, externalMeasurements };
}
