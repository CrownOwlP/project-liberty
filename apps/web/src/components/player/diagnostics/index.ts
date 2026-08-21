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
 * ---------------------------------------------------------------------- */

import type { EngineConfig } from "../engine";
import {
  lipSyncOffsetUnobservable,
  type AvContinuityFinding,
  type AvContinuityPolicy,
  type AvContinuityPolicyVersion
} from "./av-continuity";
import { elementBufferedIsIntersection, type TrackBufferedReading } from "./buffered-ranges";
import {
  frameCallbackUnavailable,
  observeFrameContinuity,
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
  observeFrameContinuity,
  readVideoFrameMetadata
} from "./frame-timing";
export type { VideoFrameReading } from "./frame-timing";

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
  /** `null` when `requestVideoFrameCallback` is unavailable or has not run twice. */
  readonly frames: AvFrameEvidence | null;
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

  findings.push(
    input.buffered === null
      ? elementBufferedIsIntersection(
          "No per-track SourceBuffer readings were supplied for this observation."
        )
      : detectVideoHole({
          playheadSeconds: input.buffered.playheadSeconds,
          videoBuffered: input.buffered.video,
          audioBuffered: input.buffered.audio,
          policy: input.policy
        })
  );

  findings.push(
    ...(input.frames === null
      ? frameCallbackUnavailable()
      : observeFrameContinuity(input.frames.previous, input.frames.current))
  );

  findings.push(assertSegmentsMode(input.engineConfig));

  return {
    policyVersion: input.policy.version,
    observedAtMs: input.observedAtMs,
    findings
  };
}

export interface AvContinuitySummary {
  /** Proxies that fired. NOT a count of sync problems. */
  readonly proxiesFired: number;
  readonly proxiesQuiet: number;
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
