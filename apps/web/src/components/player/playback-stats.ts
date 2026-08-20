/* -------------------------------------------------------------------------
 * Shaka `getStats()`, normalised into unambiguous units
 *
 * `docs/RESEARCH_PLAYBACK.md` names three traps in this object, and this file
 * exists so each one is handled exactly once:
 *
 *   - EVERY TIME FIELD SHAKA REPORTS IS IN SECONDS. CMCD is in milliseconds.
 *     The research calls this the most likely unit bug in this area, so the
 *     conversion happens in one function and every field that came out of it
 *     carries `Ms` in its name. A number in this snapshot without a unit suffix
 *     is not a duration.
 *   - AN UNAVAILABLE NUMBER IS `NaN`, NOT `null` AND NOT `0`. `NaN` survives
 *     arithmetic, comparison and `JSON.stringify` (as `null`) without ever
 *     failing, so a dropped-frame count of `NaN` becomes a dropped-frame count
 *     of zero somewhere downstream. Everything numeric goes through
 *     `finiteOrNull`.
 *   - `loadLatency` IS NOT STARTUP TIME. Shaka's own JSDoc says it measures
 *     time to `loadedmetadata` and "does NOT imply that playback can start".
 *     `timeToFirstFrame` is startup time and is the one that maps to CMCD
 *     `msd`. They are kept as two separate fields and neither is a fallback for
 *     the other.
 *
 * This is a seam for PL-0503, not a telemetry pipeline. There is no batching,
 * no transport and no CMCD mapping here; Shaka's own CMCD v2 support is
 * configuration-only and is switched on through `PlaybackController.configure`.
 *
 * Field set verified against shaka-player 5.2.6 `externs/shaka/player.js`
 * (`shaka.extern.Stats`, `shaka.extern.StateChange`, `shaka.extern.TrackChoice`).
 * ---------------------------------------------------------------------- */

import type { RawEngineStats } from "./engine";

export interface PlaybackStateChange {
  /** Milliseconds since the Unix epoch. Shaka reports epoch SECONDS here. */
  readonly timestampMs: number | null;
  /** `buffering` | `playing` | `paused` | `ended`, per Shaka. */
  readonly state: string | null;
  /** The final entry is still open, so its duration keeps growing. */
  readonly durationMs: number | null;
}

export interface PlaybackTrackChoice {
  /** Milliseconds since the Unix epoch. Shaka reports epoch SECONDS here. */
  readonly timestampMs: number | null;
  readonly trackId: number | null;
  /** `variant` or `text`. */
  readonly type: string | null;
  /**
   * True when AbrManager chose, false when the application called
   * `selectTrack`. This flag is what makes the switch history explanatory
   * rather than merely descriptive, so it is never defaulted — an entry that
   * did not state it reads `null`.
   */
  readonly fromAdaptation: boolean | null;
  readonly bandwidthBps: number | null;
}

export interface PlaybackStatsSnapshot {
  readonly widthPx: number | null;
  readonly heightPx: number | null;
  readonly streamBandwidthBps: number | null;
  readonly estimatedBandwidthBps: number | null;
  readonly currentCodecs: string | null;

  readonly decodedFrames: number | null;
  readonly droppedFrames: number | null;
  readonly corruptedFrames: number | null;

  readonly gapsJumped: number | null;
  readonly stallsDetected: number | null;

  readonly completionPercent: number | null;

  /** Time to `loadedmetadata`. NOT startup time — see the file header. */
  readonly loadLatencyMs: number | null;
  /** Startup time. This is the one that maps to CMCD `msd`. */
  readonly timeToFirstFrameMs: number | null;
  readonly manifestTimeMs: number | null;
  readonly drmTimeMs: number | null;
  readonly playTimeMs: number | null;
  readonly pauseTimeMs: number | null;
  readonly bufferingTimeMs: number | null;
  readonly licenseTimeMs: number | null;
  readonly liveLatencyMs: number | null;
  readonly maxSegmentDurationMs: number | null;

  readonly manifestSizeBytes: number | null;
  readonly bytesDownloaded: number | null;

  readonly nonFatalErrorCount: number | null;
  readonly manifestPeriodCount: number | null;
  readonly manifestGapCount: number | null;

  /** The reason trail product invariant 4 asks for. */
  readonly switchHistory: readonly PlaybackTrackChoice[];
  readonly stateHistory: readonly PlaybackStateChange[];
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * The single seconds-to-milliseconds crossing in the player.
 *
 * Not rounded. Rounding belongs at the CMCD boundary, where the spec says which
 * keys are integers; rounding here would quietly lose precision that A/V work
 * (PL-0504) needs and would still not be the rounding CMCD wants.
 */
function secondsToMs(value: unknown): number | null {
  const seconds = finiteOrNull(value);
  return seconds === null ? null : seconds * 1000;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function toStateChange(entry: unknown): PlaybackStateChange {
  const record = readRecord(entry);
  return {
    timestampMs: secondsToMs(record?.timestamp),
    state: stringOrNull(record?.state),
    durationMs: secondsToMs(record?.duration)
  };
}

function toTrackChoice(entry: unknown): PlaybackTrackChoice {
  const record = readRecord(entry);
  return {
    timestampMs: secondsToMs(record?.timestamp),
    trackId: finiteOrNull(record?.id),
    type: stringOrNull(record?.type),
    fromAdaptation: booleanOrNull(record?.fromAdaptation),
    bandwidthBps: finiteOrNull(record?.bandwidth)
  };
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/**
 * Every field is read defensively rather than destructured off a declared
 * shape, so a Shaka upgrade that renames one degrades to `null` instead of
 * throwing inside whatever was reading it — the caller here is usually a
 * telemetry tick, and a throwing telemetry tick takes playback down with it.
 */
export function toPlaybackStats(raw: RawEngineStats | null | undefined): PlaybackStatsSnapshot {
  const stats: Readonly<Record<string, unknown>> = readRecord(raw) ?? {};

  return {
    widthPx: finiteOrNull(stats.width),
    heightPx: finiteOrNull(stats.height),
    streamBandwidthBps: finiteOrNull(stats.streamBandwidth),
    estimatedBandwidthBps: finiteOrNull(stats.estimatedBandwidth),
    currentCodecs: stringOrNull(stats.currentCodecs),

    decodedFrames: finiteOrNull(stats.decodedFrames),
    droppedFrames: finiteOrNull(stats.droppedFrames),
    corruptedFrames: finiteOrNull(stats.corruptedFrames),

    gapsJumped: finiteOrNull(stats.gapsJumped),
    stallsDetected: finiteOrNull(stats.stallsDetected),

    completionPercent: finiteOrNull(stats.completionPercent),

    loadLatencyMs: secondsToMs(stats.loadLatency),
    timeToFirstFrameMs: secondsToMs(stats.timeToFirstFrame),
    manifestTimeMs: secondsToMs(stats.manifestTimeSeconds),
    drmTimeMs: secondsToMs(stats.drmTimeSeconds),
    playTimeMs: secondsToMs(stats.playTime),
    pauseTimeMs: secondsToMs(stats.pauseTime),
    bufferingTimeMs: secondsToMs(stats.bufferingTime),
    licenseTimeMs: secondsToMs(stats.licenseTime),
    liveLatencyMs: secondsToMs(stats.liveLatency),
    maxSegmentDurationMs: secondsToMs(stats.maxSegmentDuration),

    manifestSizeBytes: finiteOrNull(stats.manifestSizeBytes),
    bytesDownloaded: finiteOrNull(stats.bytesDownloaded),

    nonFatalErrorCount: finiteOrNull(stats.nonFatalErrorCount),
    manifestPeriodCount: finiteOrNull(stats.manifestPeriodCount),
    manifestGapCount: finiteOrNull(stats.manifestGapCount),

    switchHistory: toArray(stats.switchHistory).map(toTrackChoice),
    stateHistory: toArray(stats.stateHistory).map(toStateChange)
  };
}
