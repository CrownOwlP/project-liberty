/* -------------------------------------------------------------------------
 * The caller `diagnostics/` was written for (PL-0504)
 *
 * `diagnostics/index.ts` states the split this file implements: "The caller (a
 * future telemetry tick, or a support diagnostics panel) does the reading from
 * the DOM and from `PlaybackController.getEnginePlayer()`; this decides what the
 * readings mean". `observeAvContinuity` is a pure function of an explicit input,
 * and it stays that way. This file is the reading half, plus the two mappings a
 * caller needs afterwards -- one to a panel, one to the collector -- and every
 * decision in it is a pure function so it can be tested without a DOM.
 *
 * THE ONE THING THIS FILE MUST NOT DO, AND THE THREE WAYS IT DOES NOT
 *
 * `av-continuity.ts` separates `AV_PROXY_METRICS` from `AV_LIP_SYNC_METRIC` and
 * puts `audioAheadMs` on the `AvExternalMeasurement` branch alone, reachable
 * only from a rig described by `AvMeasurementRig`. A wiring that implied the
 * browser had produced a lip-sync number would defeat the whole module, and it
 * would not need to be malicious to do it -- publishing a proxy magnitude under
 * a name a reader associates with sync is enough. So:
 *
 *   1. NO MILLISECOND NUMBER IS PRODUCED HERE AT ALL. `describeProxyMagnitude`
 *      is exhaustive over `AvProxyMagnitude`, whose two branches are seconds of
 *      MEDIA TIMELINE and a count of frames, and it renders the unit in words
 *      beside the number. There is no branch that could produce "ms", because
 *      the union has none.
 *   2. THE COLLECTOR IS SENT STATES, NOT MAGNITUDES. A CMCD custom key is an
 *      untagged scalar -- `cmcd-collect.ts` gives custom keys no unit suffix,
 *      because it cannot know one -- so a magnitude emitted there would sit
 *      beside CMCD's millisecond keys with nothing saying it is not one. The
 *      magnitude stays in the panel, where its unit is spelled out; the
 *      collector gets `fired` / `quiet` / `unobservable`, which is what a
 *      collector query actually needs.
 *   3. THE LIP-SYNC ENTRY IS EMITTED, AND ITS VALUE IS THE WORD
 *      `unobservable`. `lipSyncOffsetUnobservable()` is always the first
 *      finding, so `com.liberty-avs-lip-sync-offset` appears in every report
 *      this file produces -- carrying a state, never a number. A reader of the
 *      collector never has to infer from an absence that sync was not measured,
 *      which is the reason that entry exists.
 *
 * WHY PROVENANCE TRAVELS BESIDE THE REPORT. `assertSegmentsMode(null)` fires
 * with `sequence_mode_unstated`, whose detail says the configuration does not
 * state a value. That is true when we READ the configuration and it was silent.
 * It is NOT the same fact as "we could not read the configuration at all", and
 * the finding cannot tell them apart because it never learns which happened.
 * `AvDiagnosticsSnapshot.engineConfigSource` is where that is recorded, and the
 * panel shows it, so a fired sequence-mode proxy is never read as a claim about
 * a configuration nobody looked at.
 *
 * NOTHING HERE READS A CLOCK. Every instant is an argument, for the reason
 * `diagnostics/index.ts` gives: a detector that stamps its own findings produces
 * a report that cannot be replayed from a bug report.
 * ---------------------------------------------------------------------- */

import type { EngineConfig } from "./engine";
import {
  DEFAULT_AV_CONTINUITY_POLICY,
  observeAvContinuity,
  readSourceBufferRanges,
  summariseAvContinuity,
  type AvBufferedEvidence,
  type AvContinuityFinding,
  type AvContinuityReport,
  type AvContinuitySummary,
  type AvFrameEvidence,
  type AvFrameEvidenceAbsence,
  type AvProxyMagnitude,
  type TimeRangesLike,
  type VideoFrameReading
} from "./diagnostics";
/* `readers.ts` is not re-exported by `diagnostics/index.ts`, which publishes the
 * DECISIONS rather than the defensive primitives. Imported directly rather than
 * restated here: a second `finiteOrNull` in this repository would be a second
 * opinion about whether an unavailable number is `null` or `0`. */
import { finiteOrNull, readRecord } from "./diagnostics/readers";
import type { PlaybackTelemetryIdentifiers } from "./telemetry-decision";

/**
 * How often a session composes a report.
 *
 * `diagnostics/index.ts` is explicit that `observeAvContinuity` is NOT a
 * per-frame function -- one call is roughly a dozen small allocations, which is
 * negligible on a tick and about seven hundred a second at 60 Hz. The cheap
 * signal that belongs in the frame callback is `readVideoFrameMetadata`, which
 * allocates one flat record; this cadence is what composes the expensive part
 * around the most recent two of those.
 *
 * Ten seconds rather than the CMCD interval's thirty: this feeds a support
 * panel as well as the collector, and a diagnostics panel that takes half a
 * minute to say anything is a panel nobody opens twice. Emission is deduplicated
 * separately -- see `avContinuityEmissionKey` -- so the shorter cadence costs
 * renders, not requests.
 */
export const AV_DIAGNOSTICS_INTERVAL_MS = 10_000;

/**
 * How many frame readings a session keeps.
 *
 * Two, because both frame proxies are differences between CONSECUTIVE
 * callbacks. `diagnostics/index.ts` names this as the only state the whole
 * directory implies: "no growing buffer, no ring, no subscription that outlives
 * a session".
 */
export const AV_FRAME_WINDOW = 2;

/* -------------------------------------------------------------------------
 * Reading the evidence
 * ---------------------------------------------------------------------- */

/**
 * `HTMLVideoElement.requestVideoFrameCallback`, wherever it actually lives.
 *
 * The host is a `custom-media-element` subclass, which forwards the inner
 * `<video>`'s properties onto itself at runtime -- but `player-surface.tsx`
 * already records that how COMPLETELY it does so has changed between minors, and
 * `requestVideoFrameCallback` is not an `HTMLMediaElement` member at all, it is
 * an `HTMLVideoElement` one. So both are probed and neither is assumed. A
 * platform where neither carries it is `"callback-unsupported"`, which is a true
 * statement about that platform.
 */
export interface VideoFrameCallbackTarget {
  requestVideoFrameCallback(callback: (nowMs: number, metadata: unknown) => void): void;
}

function probeFrameCallback(candidate: unknown): VideoFrameCallbackTarget | null {
  if (typeof candidate !== "object" || candidate === null) return null;

  const method: unknown = (candidate as Record<string, unknown>)["requestVideoFrameCallback"];
  if (typeof method !== "function") return null;

  const request = method as (
    this: unknown,
    callback: (nowMs: number, metadata: unknown) => void
  ) => unknown;

  return {
    requestVideoFrameCallback: (callback) => {
      // `.call(candidate)` rather than a detached call: this is a method on a
      // media element and it needs its receiver.
      request.call(candidate, callback);
    }
  };
}

/**
 * The host, else its inner element, else nothing.
 *
 * Returns `null` rather than throwing on any shape, because the caller is the
 * effect that starts playback.
 */
export function findVideoFrameCallbackTarget(host: unknown): VideoFrameCallbackTarget | null {
  const onHost = probeFrameCallback(host);
  if (onHost !== null) return onHost;

  if (typeof host !== "object" || host === null) return null;
  return probeFrameCallback((host as Record<string, unknown>)["nativeEl"]);
}

/**
 * Which frame evidence a window of readings amounts to.
 *
 * THE TWO ABSENCES ARE NOT THE SAME FACT and only the caller can tell them
 * apart, which is exactly why `frame-timing.ts` makes the caller say which:
 * "this browser does not implement `requestVideoFrameCallback`" is true for the
 * whole session, while "the callback has run once so far" stops being true in
 * about sixteen milliseconds. `callbackSupported` is the `typeof` test's answer,
 * passed in rather than inferred from an empty array.
 */
export function frameEvidenceFrom(
  readings: readonly VideoFrameReading[],
  callbackSupported: boolean
): AvFrameEvidence | AvFrameEvidenceAbsence {
  if (!callbackSupported) return "callback-unsupported";

  const previous = readings[readings.length - 2];
  const current = readings[readings.length - 1];
  if (previous === undefined || current === undefined) return "awaiting-second-callback";

  return { previous, current };
}

/**
 * A `shaka.extern.BufferedRange[]` as the `TimeRanges` shape the readers take.
 *
 * An adapter rather than a second range reader: `readSourceBufferRanges` is the
 * ONLY constructor a detector accepts, and it is what drops non-finite and
 * inverted entries. Going around it to build a `TrackBufferedReading` by hand
 * would produce a value the type system accepts and the defensive reading never
 * touched.
 *
 * `Number.NaN` for an unreadable member is deliberate and is not a value that
 * escapes: `readTimeRanges` runs every start and end through `finiteOrNull` and
 * drops the range, which is the same treatment a `TimeRanges` entry that threw
 * would get.
 */
function toTimeRanges(raw: unknown): TimeRangesLike | null {
  if (!Array.isArray(raw)) return null;
  const entries: readonly unknown[] = raw;

  return {
    length: entries.length,
    start: (index) => finiteOrNull(readRecord(entries[index])?.["start"]) ?? Number.NaN,
    end: (index) => finiteOrNull(readRecord(entries[index])?.["end"]) ?? Number.NaN
  };
}

/**
 * Per-track buffered evidence, read through the engine player.
 *
 * WHY `getBufferedInfo()` IS THE PER-TRACK SOURCE. shaka-player 5.2.6's
 * `Player.getBufferedInfo` (`lib/player.js`) delegates to
 * `MediaSourceEngine.getBufferedInfo` when content is loaded through MSE, and
 * that method builds `audio` and `video` from
 * `this.sourceBuffers_.get(contentType).buffered` -- one SourceBuffer per track
 * (`lib/media/media_source_engine.js`, `getBuffered_`). It is therefore exactly
 * the reading `buffered-ranges.ts` requires and NOT the element's intersected
 * view, which that file explains is structurally incapable of showing a
 * video-only gap. `total` is the intersected one, and nothing here reads it.
 *
 * `null` MEANS "NOTHING WAS READ, FROM ANY SOURCE", and it is returned for
 * three situations that share that meaning: no player, a call that failed, and
 * a result where BOTH tracks are empty. The last one is not a guess about which
 * -- an MSE session that has not buffered anything yet and a `src=` fallback
 * with no SourceBuffers at all both produce it, `getBufferedInfo` returns empty
 * arrays for the second, and neither is evidence. Returning a pair of empty
 * readings instead would make `detectVideoHole` say a track "reported no usable
 * ranges", which asserts a reading that did not happen.
 *
 * One track empty and the other populated IS passed through, because that is a
 * real reading and `detectVideoHole` already refuses to draw a conclusion from
 * it, with its own reason.
 */
export function readAvBufferedEvidence(
  player: unknown,
  playheadSeconds: number | null
): AvBufferedEvidence | null {
  if (playheadSeconds === null) return null;
  if (typeof player !== "object" || player === null) return null;

  const method: unknown = (player as Record<string, unknown>)["getBufferedInfo"];
  if (typeof method !== "function") return null;

  const read = method as (this: unknown) => unknown;
  let info: unknown;
  try {
    info = read.call(player);
  } catch {
    /* Diagnostics must never take playback down. `getRawEngineStats` in
     * `playback-controller.ts` makes the same trade for the same reason. */
    return null;
  }

  const record = readRecord(info);
  if (record === null) return null;

  const videoRanges = toTimeRanges(record["video"]);
  const audioRanges = toTimeRanges(record["audio"]);
  if (videoRanges === null || audioRanges === null) return null;

  const video = readSourceBufferRanges("video", videoRanges);
  const audio = readSourceBufferRanges("audio", audioRanges);
  if (video.ranges.length === 0 && audio.ranges.length === 0) return null;

  return { playheadSeconds, video, audio };
}

/**
 * The EFFECTIVE Shaka configuration, or `null`.
 *
 * `assertSegmentsMode` wants the merged result rather than a fragment, and
 * `Player.getConfiguration()` is documented as "a copy of the current
 * configuration". Reading our own `BASELINE_ENGINE_CONFIG` instead would be a
 * fragment, and a fragment that happens to state `sequenceMode` would make the
 * proxy pass while saying nothing about the player.
 */
export function readEngineConfiguration(player: unknown): EngineConfig | null {
  if (typeof player !== "object" || player === null) return null;

  const method: unknown = (player as Record<string, unknown>)["getConfiguration"];
  if (typeof method !== "function") return null;

  const read = method as (this: unknown) => unknown;
  try {
    return readRecord(read.call(player));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * The snapshot
 * ---------------------------------------------------------------------- */

/** Where the sequence-mode arm's configuration came from. See the file header. */
export type AvConfigProvenance = "player-configuration" | "not-readable";

/** Whether per-track SourceBuffer ranges were readable at all. */
export type AvBufferedProvenance = "per-track-source-buffer" | "not-readable";

export interface AvDiagnosticsSnapshot {
  readonly report: AvContinuityReport;
  readonly summary: AvContinuitySummary;
  readonly engineConfigSource: AvConfigProvenance;
  readonly bufferedSource: AvBufferedProvenance;
}

export interface AvDiagnosticsInput {
  /** Supplied by the caller. Nothing in this pipeline reads a clock. */
  readonly observedAtMs: number;
  readonly buffered: AvBufferedEvidence | null;
  readonly frames: AvFrameEvidence | AvFrameEvidenceAbsence;
  readonly engineConfig: EngineConfig | null;
}

/**
 * Compose one observation and record where its evidence came from.
 *
 * Pure. Same inputs, same snapshot, every time.
 */
export function observeAvDiagnostics(input: AvDiagnosticsInput): AvDiagnosticsSnapshot {
  const report = observeAvContinuity({
    observedAtMs: input.observedAtMs,
    policy: DEFAULT_AV_CONTINUITY_POLICY,
    buffered: input.buffered,
    frames: input.frames,
    engineConfig: input.engineConfig
  });

  return {
    report,
    summary: summariseAvContinuity(report),
    engineConfigSource: input.engineConfig === null ? "not-readable" : "player-configuration",
    bufferedSource: input.buffered === null ? "not-readable" : "per-track-source-buffer"
  };
}

/* -------------------------------------------------------------------------
 * Rendering a finding
 * ---------------------------------------------------------------------- */

/**
 * What a finding IS, as one word.
 *
 * Four states rather than a boolean, because `proxiesFired === 0` is not
 * "healthy" and `summariseAvContinuity` keeps quiet and unobservable apart for
 * exactly that reason. Collapsing them here would undo that one layer up.
 */
export type AvFindingState = "fired" | "quiet" | "unobservable" | "external-measurement";

export function avFindingState(finding: AvContinuityFinding): AvFindingState {
  switch (finding.evidenceBasis) {
    case "proxy":
      return finding.proxyFired ? "fired" : "quiet";
    case "unobservable":
      return "unobservable";
    case "external-measurement":
      return "external-measurement";
  }
}

/**
 * A magnitude, with its unit in WORDS.
 *
 * Exhaustive over `AvProxyMagnitude`, which is why a millisecond string cannot
 * be produced here: the union has a seconds-of-media-timeline branch and a
 * frame-count branch and no third one. A new branch is a compile error, which is
 * the point at which somebody would have to argue for it.
 *
 * Three decimals, matching `formatSeconds` in `diagnostics/readers.ts`, so the
 * same observation renders identically wherever it is shown.
 */
export function describeProxyMagnitude(magnitude: AvProxyMagnitude | null): string | null {
  if (magnitude === null) return null;
  switch (magnitude.unit) {
    case "seconds-of-media-timeline":
      return `${magnitude.seconds.toFixed(3)}s of media timeline`;
    case "frames-presented":
      return `${String(magnitude.frames)} frames presented`;
  }
}

export interface AvFindingView {
  readonly metric: string;
  readonly state: AvFindingState;
  readonly evidenceSource: string;
  /** `null` on every branch that has no magnitude, including lip-sync. */
  readonly magnitude: string | null;
  readonly reasonCodes: readonly string[];
}

/**
 * The panel's view of a report.
 *
 * THERE IS NO FIELD HERE FOR A MILLISECOND OFFSET, and that is the point rather
 * than an omission. `AvExternalMeasurement` carries `audioAheadMs`, and nothing
 * in the browser constructs one -- `av-continuity.test.ts` asserts it -- so this
 * mapper would have nothing to put in such a field. Adding one anyway would make
 * a player capable of DISPLAYING a lip-sync number, which is one refactor away
 * from a player that computes one. A rig measurement is filed against
 * `docs/AV_SYNC_MEASUREMENT.md`, not rendered by a video player.
 *
 * Reason CODES rather than details: the details are paragraphs, the codes are
 * the closed vocabulary, and a panel is a place to see which rule fired.
 */
export function avFindingViews(report: AvContinuityReport): readonly AvFindingView[] {
  return report.findings.map((finding) => ({
    metric: finding.metric,
    state: avFindingState(finding),
    evidenceSource: finding.evidenceSource,
    magnitude: finding.evidenceBasis === "proxy" ? describeProxyMagnitude(finding.magnitude) : null,
    reasonCodes: finding.reasons.map((entry) => entry.code)
  }));
}

/* -------------------------------------------------------------------------
 * Emitting to the collector
 * ---------------------------------------------------------------------- */

/**
 * Report-level keys, beside the per-metric ones.
 *
 * THESE ARE NOT NEW METRICS. The metric names are declared once, in
 * `AV_PROXY_METRICS` and `AV_LIP_SYNC_METRIC`, and this file invents none of
 * them -- every per-metric key below is `finding.metric` verbatim. What these
 * four carry is the report's own bookkeeping: `summariseAvContinuity`'s three
 * counts, kept separate for the reason that function gives, and the policy
 * version so a stored finding can be read against the rules that produced it.
 *
 * The two provenance keys are the collector's half of the honesty argument in
 * the file header: a fired sequence-mode proxy means something different when
 * the configuration was unreadable, and a collector query has only the fields
 * in front of it.
 *
 * Every name is `com.liberty-` prefixed, so `isLibertyCustomKey` accepts it, and
 * every one is well under CTA-5004-B's 64-character key bound.
 */
export const AV_REPORT_KEYS = {
  proxiesFired: "com.liberty-avs-proxies-fired",
  proxiesQuiet: "com.liberty-avs-proxies-quiet",
  unobservable: "com.liberty-avs-unobservable",
  policyVersion: "com.liberty-avs-policy-version",
  bufferedEvidence: "com.liberty-avs-buffered-evidence",
  configEvidence: "com.liberty-avs-config-evidence"
} as const;

export interface AvContinuityEventInput {
  readonly snapshot: AvDiagnosticsSnapshot;
  /** Already validated by `decidePlaybackTelemetry`. Never raw props. */
  readonly identifiers: PlaybackTelemetryIdentifiers;
  /** Epoch milliseconds, supplied by the caller. Becomes CMCD `ts`. */
  readonly nowMs: number;
}

/**
 * One CMCD v2 event carrying an A/V continuity report.
 *
 * WHY THIS IS A SEPARATE POST RATHER THAN A SHAKA CMCD KEY. These are
 * CTA-5004-B CUSTOM keys, and shaka-player 5.2.6 exposes no API for adding one
 * to its own reports -- its CMCD configuration is a key ALLOWLIST over the
 * registry, not an extension point. The collector, on the other hand, has
 * accepted namespaced custom keys since it was written, which is why
 * `av-continuity.ts` names these metrics `com.liberty-avs-*` in the first place:
 * "namespaced to make their provenance obvious in a collector". So the event is
 * built here and posted to the same endpoint, where it goes through the same
 * allowlist, the same redaction and the same unit rules.
 *
 * `e: "t"` is the CMCD interval event type, which is what this is: a periodic
 * report, not a state change and not an error. It classifies as
 * `playback.cmcd.interval` and is logged at info.
 *
 * DETERMINISTIC apart from `ts`. Keys are written in a fixed order, findings
 * arrive in a fixed order, and a metric that somehow appeared twice keeps its
 * FIRST value rather than being overwritten -- "the last one wins" is an order
 * dependence wearing a different hat, which is the same call `readNumberList`
 * makes about a repeated object-type slot.
 */
export function avContinuityCmcdEvent(
  input: AvContinuityEventInput
): Readonly<Record<string, unknown>> {
  const { snapshot } = input;
  const event: Record<string, unknown> = {
    e: "t",
    /* CTA-5004-B types `ts` as an INTEGER of epoch milliseconds, and
     * `cmcd-collect.ts` rejects a non-integer rather than recording it. */
    ts: Math.trunc(input.nowMs),
    cid: input.identifiers.contentId,
    sid: input.identifiers.sessionId,
    [AV_REPORT_KEYS.policyVersion]: snapshot.report.policyVersion,
    [AV_REPORT_KEYS.proxiesFired]: snapshot.summary.proxiesFired,
    [AV_REPORT_KEYS.proxiesQuiet]: snapshot.summary.proxiesQuiet,
    [AV_REPORT_KEYS.unobservable]: snapshot.summary.unobservable,
    [AV_REPORT_KEYS.bufferedEvidence]: snapshot.bufferedSource,
    [AV_REPORT_KEYS.configEvidence]: snapshot.engineConfigSource
  };

  for (const finding of snapshot.report.findings) {
    if (Object.prototype.hasOwnProperty.call(event, finding.metric)) continue;
    // A STATE, NEVER A NUMBER. See the file header, point 2.
    event[finding.metric] = avFindingState(finding);
  }

  return event;
}

/**
 * What makes two emissions the same report.
 *
 * `ts` is excluded, so an unchanged session does not post an identical report
 * every ten seconds -- the caller emits the first one and then only on change.
 * That bounds request volume without a second cadence to keep in step, and it
 * makes the emitted series a series of TRANSITIONS, which is what anybody
 * reading it wants.
 *
 * Keys are sorted, so the key is a function of the record's content rather than
 * of the order it was built in.
 */
export function avContinuityEmissionKey(event: Readonly<Record<string, unknown>>): string {
  const entries = Object.keys(event)
    .filter((key) => key !== "ts")
    .sort()
    .map((key): [string, unknown] => [key, event[key]]);
  return JSON.stringify(entries);
}
