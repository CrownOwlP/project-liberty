/* -------------------------------------------------------------------------
 * A/V continuity proxies — the vocabulary (PL-0504)
 *
 * THE TASK THIS FILE IMPLEMENTS IS NOT THE TASK ITS TITLE DESCRIBES.
 *
 * PL-0504 is recorded in `control/tasks.json` as "drift measurement contract,
 * thresholds, and bounded recovery experiment". That premise is wrong and
 * `docs/RESEARCH_PLAYBACK.md` finding 3 says why: a browser cannot detect that
 * lips are out of sync. There is no audio clock for a `<video>` element;
 * `video.currentTime` is the HTML specification's "official playback position",
 * which is a position and not a clock; final alignment happens in the
 * compositor and the OS audio stack, neither of which is reachable from script.
 * The approved acceptance is therefore:
 *
 *   Browser playback diagnostics detect and report deterministic A/V
 *   continuity PROXIES with their evidence source and reason trail, never
 *   label a proxy as measured A/V skew, never expose a millisecond
 *   sync-offset claim without an external measurement source, and document
 *   the external flash-and-blip procedure for true A/V offset measurement.
 *
 * `docs/AV_SYNC_MEASUREMENT.md` is that documented procedure.
 *
 * ROUTING PROTECTED PLAYBACK THROUGH WEB AUDIO IS PROHIBITED. It is the usual
 * next idea, and it is worse than the problem: it does not produce a lip-sync
 * measurement either, it changes the audio path of DRM-protected playback for
 * the sake of instrumentation, and W3C Bug 17347 is closed WONTFIX on precisely
 * this ground. `PROHIBITED_AV_INSTRUMENTATION` names the APIs and
 * `av-continuity.test.ts` asserts that no file in this directory reaches for
 * one, so the prohibition is enforced rather than merely written down.
 *
 * HOW A PROXY IS STOPPED FROM BEING READ AS A MEASUREMENT
 *
 * The same technique `@liberty/provider-sdk`'s health report uses for
 * `priorScore` versus `measuredScore`: the number is not reachable without
 * first discriminating on what kind of number it is.
 *
 *   - `AvContinuityFinding` is a union on `evidenceBasis`. The
 *     `"external-measurement"` branch is the only one with a millisecond
 *     offset field, that field is called `audioAheadMs`, and NOTHING IN THIS
 *     DIRECTORY CONSTRUCTS ONE — it can only arrive from a rig described by
 *     `AvMeasurementRig`.
 *   - A proxy's number lives behind `AvProxyMagnitude`, itself a union tagged
 *     by `unit`. There is no `magnitude.value`, so `finding.magnitude.seconds`
 *     does not type-check until the caller has narrowed to the seconds branch
 *     and has therefore seen that it is holding a media-timeline span rather
 *     than an offset. No branch of that union is milliseconds.
 *   - The boolean is `proxyFired`, not `detected` and not `outOfSync`. A proxy
 *     firing means an evidence-backed continuity risk was observed. It does
 *     not mean audio and video are misaligned, and no field in this module
 *     claims they are.
 *
 * DETERMINISM. No function in this directory reads a clock, a random source or
 * ambient state; `observedAtMs` is a required input everywhere it appears, for
 * the reason `summariseHealthObservations` gives — a `Date.now()` inside a
 * detector produces a verdict that cannot be reproduced from a bug report.
 * Buffered ranges are sorted and coalesced before use, so the answer does not
 * depend on the order the browser handed the ranges over.
 * ---------------------------------------------------------------------- */

/**
 * Bumped when a threshold, a reason code or a detection rule changes, so a
 * stored finding can be read against the rules that produced it. Same shape as
 * `DEFAULT_PROVIDER_HEALTH_POLICY.version`.
 */
export const AV_CONTINUITY_POLICY_VERSION = "av-continuity/2026-08-21.proxy-v1";
export type AvContinuityPolicyVersion = typeof AV_CONTINUITY_POLICY_VERSION;

/**
 * The proxy metric names.
 *
 * `com.liberty-avs-*` because NO STANDARD METRIC NAME FOR A/V DRIFT EXISTS —
 * not in CMCD v2 (CTA-5004-B), not in CTA-2066, not in ISO/IEC 23009-1.
 * PL-0503 adopts CMCD's vocabulary precisely so that we do not invent metric
 * names; here there is nothing to adopt, so the names are namespaced to make
 * their provenance obvious in a collector and are documented as proxies in
 * `docs/AV_SYNC_MEASUREMENT.md`.
 *
 * Every name says what was observed — a hole, an advance, a frame gap, a
 * configuration assertion — and none of them contains "sync", "skew", "drift"
 * or "offset", because a collector query is a place where a name is all the
 * context a reader gets.
 */
export const AV_PROXY_METRICS = {
  videoHole: "com.liberty-avs-video-hole",
  mediaTimeAdvance: "com.liberty-avs-media-time-advance",
  presentedFrameGap: "com.liberty-avs-presented-frame-gap",
  sequenceModeAssertion: "com.liberty-avs-sequence-mode-assertion"
} as const;

export type AvProxyMetricName = (typeof AV_PROXY_METRICS)[keyof typeof AV_PROXY_METRICS];

/**
 * The name of the thing a browser cannot produce.
 *
 * It exists so that the report can carry an explicit "this is not observable
 * here" entry rather than leaving a reader to infer the absence, and so that a
 * future external measurement has a name to be filed under that lines up with
 * the proxies beside it.
 */
export const AV_LIP_SYNC_METRIC = "com.liberty-avs-lip-sync-offset";
export type AvLipSyncMetricName = typeof AV_LIP_SYNC_METRIC;

/**
 * Browser APIs that must not be used to instrument protected playback.
 *
 * Enforced by a source scan in `av-continuity.test.ts`, not by convention.
 */
export const PROHIBITED_AV_INSTRUMENTATION: readonly string[] = [
  "AudioContext",
  "webkitAudioContext",
  "createMediaElementSource",
  "MediaElementAudioSourceNode",
  "captureStream"
];

/** Where a finding's evidence physically came from. */
export type AvEvidenceSource =
  /** `sourceBuffer.buffered`, read PER TRACK. See `buffered-ranges.ts`. */
  | "source-buffer-buffered"
  /** `HTMLVideoElement.requestVideoFrameCallback` metadata. */
  | "request-video-frame-callback"
  /** The effective Shaka configuration tree. */
  | "engine-configuration"
  /** A camera/microphone or dedicated A/V sync rig. Never produced in-browser. */
  | "external-av-sync-rig"
  /** Nothing usable was available, or the signal is not observable at all. */
  | "no-evidence-available";

export type AvContinuityReasonCode =
  /* Honesty — why a number is or is not entitled to be called a measurement. */
  | "no_audio_clock_in_browser"
  | "external_measurement_required"
  | "webaudio_reroute_prohibited"
  | "proxy_not_measurement"
  /* Buffered-range evidence. */
  | "element_buffered_is_intersection"
  | "buffered_ranges_unusable"
  | "playhead_outside_video_buffer"
  | "video_buffer_contiguous"
  | "gap_below_hole_threshold"
  | "gap_beyond_lookahead"
  | "video_hole_at_playhead"
  | "audio_contiguous_across_hole"
  | "audio_not_contiguous_across_hole"
  | "hole_ahead_of_playhead"
  | "nudge_within_bound"
  | "hole_exceeds_nudge_bound"
  /* Frame-callback evidence. */
  | "frame_callback_unavailable"
  | "frame_metadata_unusable"
  | "media_time_zero_on_live"
  | "media_time_did_not_advance"
  | "media_time_advanced"
  | "presented_frames_skipped"
  | "presented_frames_contiguous"
  /* Configuration evidence. */
  | "sequence_mode_asserted_false"
  | "sequence_mode_enabled"
  | "sequence_mode_unstated";

/**
 * One line of the trail. The `{ code, detail }` shape every other decision
 * surface in this project uses, so an A/V finding reads beside a provider
 * health verdict and a playback failure without translating between idioms.
 */
export interface AvContinuityReason {
  readonly code: AvContinuityReasonCode;
  readonly detail: string;
}

export function avReason(code: AvContinuityReasonCode, detail: string): AvContinuityReason {
  return { code, detail };
}

/**
 * A proxy's number, tagged by what kind of number it is.
 *
 * THERE IS NO MILLISECOND BRANCH AND THERE IS NO UNTAGGED `value` FIELD, and
 * both absences are the point. `seconds-of-media-timeline` is a span or a
 * delta ON THE MEDIA TIMELINE — the same timeline `currentTime` and
 * `sourceBuffer.buffered` live on — and it is not, and cannot be converted
 * into, an audio-versus-video offset. `frames-presented` is a count of frames
 * the compositor was given.
 */
export type AvProxyMagnitude =
  | { readonly unit: "seconds-of-media-timeline"; readonly seconds: number }
  | { readonly unit: "frames-presented"; readonly frames: number };

interface AvFindingCommon {
  /**
   * Why this finding, in a fixed order: evidence basis first, then the rule
   * that fired or did not.
   *
   * NEVER EMPTY, on every branch, including the quiet one. Product invariant 4
   * asks playback decisions to expose a trail sufficient to debug them, and "no
   * problem found" with no reasons is indistinguishable from "nothing was
   * checked" — which is the state most A/V monitoring is actually in.
   */
  readonly reasons: readonly AvContinuityReason[];
}

/**
 * An evidence-backed continuity proxy.
 *
 * `proxyFired: true` means: this specific, named, deterministic condition was
 * observed in this specific evidence source. It does not mean playback is out
 * of sync, and this interface has no field that could say so.
 */
export interface AvProxyObservation extends AvFindingCommon {
  readonly evidenceBasis: "proxy";
  readonly metric: AvProxyMetricName;
  readonly evidenceSource: Exclude<
    AvEvidenceSource,
    "external-av-sync-rig" | "no-evidence-available"
  >;
  readonly proxyFired: boolean;
  readonly magnitude: AvProxyMagnitude | null;
}

/**
 * A signal that could not be observed — either never (lip-sync offset) or not
 * on this platform, in this state, from this evidence.
 *
 * It carries no number at all. An unobservable signal reported as `0` is the
 * defect this whole task exists to avoid.
 */
export interface AvUnobservableSignal extends AvFindingCommon {
  readonly evidenceBasis: "unobservable";
  readonly metric: AvProxyMetricName | AvLipSyncMetricName;
  readonly evidenceSource: "no-evidence-available";
}

/**
 * The instrument that produced a real offset measurement.
 *
 * Required, and required to be specific, because a millisecond offset with no
 * named instrument and no stated uncertainty is a proxy wearing a measurement's
 * clothes. `docs/AV_SYNC_MEASUREMENT.md` is the procedure that fills this in.
 */
export interface AvMeasurementRig {
  readonly procedure: "flash-and-blip";
  /** e.g. "high-frame-rate camera + microphone", or a named sync analyser. */
  readonly instrument: string;
  /** The instrument's own error bar. A measurement without one is not usable. */
  readonly instrumentUncertaintyMs: number;
  /** Supplied by the operator; nothing here reads a clock. */
  readonly measuredAtMs: number;
  readonly operator: string;
}

/**
 * A TRUE A/V offset, from outside the browser.
 *
 * NOTHING IN THIS DIRECTORY RETURNS ONE, and `av-continuity.test.ts` asserts
 * it. The type exists so that (a) the shape a future measurement must have is
 * fixed now, while the distinction is fresh, and (b) `audioAheadMs` is the only
 * millisecond offset name in the module, on the only branch entitled to it.
 */
export interface AvExternalMeasurement extends AvFindingCommon {
  readonly evidenceBasis: "external-measurement";
  readonly metric: AvLipSyncMetricName;
  readonly evidenceSource: "external-av-sync-rig";
  /**
   * ITU-R BT.1359-1 SIGN CONVENTION: POSITIVE MEANS AUDIO IS AHEAD OF VIDEO.
   *
   * Stated because half of the published tolerances in this area are quoted
   * with the opposite sign and the two are not symmetric — audio ahead is
   * detectable at a much smaller magnitude than audio behind, so a flipped sign
   * turns a failing measurement into a passing one. Adopting BT.1359-1 here
   * means a number from a rig can be compared against the tolerances in
   * `docs/AV_SYNC_MEASUREMENT.md` without a convention argument.
   */
  readonly audioAheadMs: number;
  readonly rig: AvMeasurementRig;
}

export type AvContinuityFinding =
  | AvProxyObservation
  | AvUnobservableSignal
  | AvExternalMeasurement;

export interface AvContinuityPolicy {
  readonly version: AvContinuityPolicyVersion;
  /**
   * Gaps shorter than this are not holes.
   *
   * 100 ms, matching hls.js's `maxBufferHole` default. Below that a gap is
   * ordinarily fMP4 timestamp rounding between segments rather than missing
   * media, and treating rounding as a hole would fire the proxy on every
   * healthy stream — which is how a diagnostic gets muted.
   */
  readonly minHoleSeconds: number;
  /** How far ahead of the playhead a gap is still worth reporting. */
  readonly holeLookaheadSeconds: number;
  /** Ranges closer together than this are one range. Absorbs float noise. */
  readonly rangeCoalesceSeconds: number;
  /** Tolerance when asking whether audio covers a video gap. */
  readonly audioContiguityMarginSeconds: number;
  /**
   * The recovery bound. A recommended nudge longer than this is not
   * recommended at all — it is reported as exceeding the bound, and the
   * decision to skip that much media belongs to the failover policy in
   * PL-0502, not to a diagnostic.
   */
  readonly maxNudgeSeconds: number;
}

/**
 * The shipped policy.
 *
 * Thresholds are hls.js's, deliberately: `nudgeOnVideoHole` is the shipping
 * implementation of this detector, it exists because of a real Chrome bug where
 * playback continues past a video gap without rendering and then stalls, and
 * borrowing its numbers means our first firing threshold is one that a large
 * installed base has already had to live with.
 */
export const DEFAULT_AV_CONTINUITY_POLICY: AvContinuityPolicy = {
  version: AV_CONTINUITY_POLICY_VERSION,
  minHoleSeconds: 0.1,
  holeLookaheadSeconds: 0.5,
  rangeCoalesceSeconds: 0.01,
  audioContiguityMarginSeconds: 0.02,
  maxNudgeSeconds: 0.5
};

/**
 * The headline entry of every report: the number nobody has.
 *
 * Emitted unconditionally, on every observation, so that a reader of the
 * report or of a collector never has to infer from an absence that lip-sync
 * offset was not measured. Its reasons are the whole argument in four lines.
 */
export function lipSyncOffsetUnobservable(): AvUnobservableSignal {
  return {
    evidenceBasis: "unobservable",
    metric: AV_LIP_SYNC_METRIC,
    evidenceSource: "no-evidence-available",
    reasons: [
      avReason(
        "no_audio_clock_in_browser",
        "There is no audio clock exposed for a <video> element. currentTime is the HTML " +
          "specification's official playback position, not a rendering clock, and final " +
          "audio/video alignment happens in the compositor and the OS audio stack."
      ),
      avReason(
        "webaudio_reroute_prohibited",
        "Routing playback through Web Audio to obtain a clock is prohibited: it still does not " +
          "measure presented alignment, it makes the audio path of protected playback more " +
          "invasive, and W3C Bug 17347 is closed WONTFIX on that ground."
      ),
      avReason(
        "proxy_not_measurement",
        "The com.liberty-avs-* signals in this report are continuity proxies. None of them is " +
          "an audio-versus-video offset and none may be reported as one."
      ),
      avReason(
        "external_measurement_required",
        "A true offset requires the external flash-and-blip procedure in " +
          "docs/AV_SYNC_MEASUREMENT.md with a camera/microphone or a dedicated A/V sync rig."
      )
    ]
  };
}
