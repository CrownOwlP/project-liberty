/* -------------------------------------------------------------------------
 * PlayerAdapter — the only playback surface the application and domain layers
 * may depend on (PW-0201; docs/DESKTOP_PLAYBACK.md §3).
 *
 * NOTHING IN THIS FILE OR ITS IMPORT GRAPH MAY REACH `shaka-player`, `libmpv`,
 * `@tauri-apps/*` OR `electron`. There is no `any` below, no engine handle is
 * returned by any method, and no opaque engine-configuration bag crosses this
 * line. `player-adapter.test.ts` asserts all four by walking the import graph,
 * because a rule about a module graph that is checked by review is a rule that
 * holds until the first hurried afternoon.
 *
 * WHAT THIS IS NOT. `ShakaPlayerHandle` in `engine.ts` is a seam INSIDE the web
 * implementation, one layer below this one, and it is not replaced: its
 * `attach(HTMLMediaElement)` is a browser type in a signature and a libmpv
 * adapter could not satisfy it. This file is the layer the application depends
 * on; that one is the layer `WebPlayerAdapter` depends on.
 *
 * ---------------------------------------------------------------------------
 * ONE DELIBERATE DEVIATION FROM THE §3 LISTING, STATED RATHER THAN SMUGGLED.
 * ---------------------------------------------------------------------------
 * §3 writes `canPlay(candidate: PlaybackCandidate)`, importing that type from
 * `./playback-session`. That import was specified on 2026-09-15; PL-0902 landed
 * afterwards. The client-side `PlaybackCandidate` in `playback-session.ts` is
 * `{ id, providerId, source }` and carries NEITHER `protection` NOR
 * `compatibility` — so an adapter handed one is structurally incapable of
 * returning `drm_required_no_cdm`, which is the single most important refusal
 * on the list and the one D4 rests on. Following the listing literally would
 * have produced a routing function that cannot make the rights-bearing decision
 * it exists to make.
 *
 * So the boundary declares its own `PlayerCandidate`, built from the fields the
 * WIRE contract already publishes — `playbackSessionCandidateSchema` in
 * `apps/web/src/app/api/v1/playback/session/contract.ts` has exactly `id`,
 * `providerId`, `uri`, `mimeType`, `compatibility` and `protection`. This is a
 * projection of the authorized session, not a second opinion about it.
 *
 * The cost is real and is not hidden: `playback-session.ts` and this file now
 * describe the same thing with different types, and reconciling them is
 * PW-0209. Until that lands, `WebPlayerAdapter` (PW-0202) is the one place that
 * maps between them.
 *
 * TYPE-ONLY IMPORTS FROM @liberty/contracts, and the guard enforces it. zod is
 * a runtime dependency of that package; a value import would put a schema
 * validator in the client bundle for two string unions, which is the same
 * bundle-weight defect `@liberty/media-engine/scheduling` was split to avoid.
 * ---------------------------------------------------------------------- */

import type { CompatibilityConfidence } from "@liberty/contracts/domains/playback";
import type { ContentProtection } from "@liberty/contracts/shared/drm";

/** Which implementation. An identity for the reason trail, never a switch. */
export type PlayerAdapterId = "web-shaka" | "native-mpv";

/**
 * Every adapter id, as a value, so a consumer can enumerate them without
 * restating the union. Derived from a totality record rather than written
 * twice, on the pattern `PLAYBACK_PHASES` already uses in `playback-machine.ts`:
 * adding a third engine fails to compile here instead of silently missing.
 */
const ADAPTER_IDS: Readonly<Record<PlayerAdapterId, true>> = {
  "web-shaka": true,
  "native-mpv": true
};
export const PLAYER_ADAPTER_IDS: readonly PlayerAdapterId[] = Object.keys(
  ADAPTER_IDS
) as PlayerAdapterId[];

/* --- the candidate, as this boundary needs it ---------------------------- */

/**
 * One authorized stream, projected for a routing decision.
 *
 * `uri` is present because the adapter has to load something, and absent from
 * every OTHER method deliberately: there is no `load(url)` on this interface and
 * there never may be. The address arrives only as part of a session the server
 * already authorized, which is the §7 property that stops the shell becoming an
 * open proxy.
 */
export interface PlayerCandidate {
  readonly id: string;
  readonly providerId: string;
  readonly uri: string;
  /** `null` where the source did not state one. Never a guess. */
  readonly mimeType: string | null;
  readonly compatibility: CompatibilityConfidence;
  readonly protection: ContentProtection;
}

/** An authorized session, projected the same way. */
export interface PlayerSession {
  readonly contentId: string;
  /** In PREFERENCE ORDER, and never re-sorted here. */
  readonly candidates: readonly PlayerCandidate[];
  /** SECONDS. `null` = engine default, which is 0 for VOD and the live edge for live. */
  readonly startAtSeconds: number | null;
  readonly reasons: readonly string[];
}

/* --- capability routing -------------------------------------------------- */

/**
 * Why an adapter refuses a candidate. A CLOSED vocabulary, because a refusal
 * that reports free prose cannot be counted, grouped or alerted on, and product
 * invariant 4 asks for a reason trail sufficient to debug candidate selection.
 */
export type PlayerRefusalCode =
  | "drm_required_no_cdm"
  | "protocol_unsupported"
  | "container_unsupported"
  | "video_codec_unsupported"
  | "audio_codec_unsupported"
  | "adaptive_bitrate_required"
  | "transport_not_permitted"
  | "adapter_unavailable";

const REFUSAL_CODES: Readonly<Record<PlayerRefusalCode, true>> = {
  drm_required_no_cdm: true,
  protocol_unsupported: true,
  container_unsupported: true,
  video_codec_unsupported: true,
  audio_codec_unsupported: true,
  adaptive_bitrate_required: true,
  transport_not_permitted: true,
  adapter_unavailable: true
};
export const PLAYER_REFUSAL_CODES: readonly PlayerRefusalCode[] = Object.keys(
  REFUSAL_CODES
) as PlayerRefusalCode[];

/**
 * The answer to "can this adapter play this candidate", WITH A REASON ON BOTH
 * BRANCHES.
 *
 * An accepted candidate carries a reason for the same purpose a refused one
 * does: when playback then fails, the trail has to be able to say what the
 * router believed and on what evidence, and "it was not refused" is not that.
 * `confidence` mirrors `CompatibilityConfidence` and means the same thing —
 * `unverified` says nothing disqualified the candidate, not that anything
 * qualified it, so a decode failure on an `unverified` acceptance is a normal
 * outcome rather than a defect.
 */
export type CanPlayDecision =
  | {
      readonly playable: true;
      readonly adapterId: PlayerAdapterId;
      readonly confidence: CompatibilityConfidence;
      readonly reason: string;
    }
  | {
      readonly playable: false;
      readonly adapterId: PlayerAdapterId;
      readonly refusal: PlayerRefusalCode;
      readonly reason: string;
    };

/* --- what a load is ------------------------------------------------------ */

/**
 * A load request names the AUTHORIZED SESSION and which of its candidates to
 * start, never a URL. The adapter reads the address off the candidate the
 * session published; it has no other way to obtain one and no method that
 * accepts one. See docs/DESKTOP_PLAYBACK.md §7.
 */
export interface PlayerLoadRequest {
  readonly session: PlayerSession;
  readonly candidateId: string;
  /** SECONDS, matching everything else in this directory. `null` = engine default. */
  readonly startAtSeconds: number | null;
  /**
   * Correlates every event this load produces. Monotonic per adapter instance.
   *
   * REQUIRED rather than generated internally, because the caller must be able
   * to discard events from a load it has already superseded — the same problem
   * `#loadToken` solves in `playback-controller.ts` and the same one mpv's
   * START_FILE / FILE_LOADED / PLAYBACK_RESTART correlation solves in §5.
   */
  readonly loadId: number;
}

/* --- what the adapter reports ------------------------------------------- */

export interface PlayerTimeline {
  readonly positionSeconds: number;
  /** `null` = not yet known, or a live stream with no duration. NEVER 0 for unknown. */
  readonly durationSeconds: number | null;
}

export type PlayerTrackKind = "audio" | "subtitle";

export interface PlayerTrack {
  readonly id: string;
  readonly kind: PlayerTrackKind;
  readonly label: string | null;
  /** BCP-47 where the source states one. `null` = unstated, never "und" invented by us. */
  readonly language: string | null;
  readonly codec: string | null;
  readonly channels: number | null;
  readonly isDefault: boolean;
  readonly isForced: boolean;
}

export type PlayerErrorSeverity = "recoverable" | "fatal";

export interface PlayerError {
  readonly severity: PlayerErrorSeverity;
  /**
   * TRUE when WE ended the operation — a superseded load, a stop we issued.
   * The state machine already has this concept and ignores such errors; an
   * adapter that reports its own control flow as a candidate failure makes every
   * failover look like a fault caused by the candidate it failed over TO.
   */
  readonly selfInflicted: boolean;
  /** Already redacted. No signed query strings, no raw engine payload. */
  readonly message: string;
  /** The adapter's own code, namespaced by adapter. Never cross-engine. */
  readonly code: string | null;
}

/**
 * A/V sync telemetry is OPTIONAL BY CAPABILITY, and an absent reading is not a
 * zero.
 *
 * `docs/AV_SYNC_MEASUREMENT.md` already draws this distinction for the browser
 * proxies and it is drawn the same way here: a quiet reading means the
 * comparison was made and found nothing; an unavailable reading means it could
 * not be made, and it carries NO magnitude, because a number in that position
 * would be an invention. A dashboard that averaged absent readings as 0 would
 * report perfect synchronisation for a player that cannot measure it.
 *
 * NOTHING HERE IS A LIP-SYNC MEASUREMENT. mpv's `avsync` is the player's own
 * last A/V scheduling difference, not presented alignment; the external
 * flash-and-blip rig remains the only source of
 * `com.liberty-avs-lip-sync-offset` and this union must never be mapped onto
 * that metric.
 */
export type AvSyncUnavailableReason =
  | "adapter_cannot_observe"
  | "audio_or_video_disabled"
  | "requires_display_sync"
  | "not_yet_sampled";

export type AvSyncTelemetry =
  | { readonly available: false; readonly why: AvSyncUnavailableReason }
  | {
      readonly available: true;
      /** The engine's internal A/V difference, SECONDS. A proxy, not a measurement. */
      readonly internalAvSyncSeconds: number;
      /** `null` where the engine does not report it. Never 0 for absent. */
      readonly totalCorrectionSeconds: number | null;
      readonly framesDroppedByOutput: number | null;
      readonly framesDroppedByDecoder: number | null;
    };

export type PlayerAdapterStatus =
  | { readonly status: "idle" }
  | { readonly status: "initialising" }
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "disposed" };

/**
 * Everything the adapter reports, as one union delivered to one listener.
 *
 * One stream rather than an event-emitter surface per concern, because the
 * consumer is a state machine that must see these IN ORDER: a `buffering` that
 * overtook the `loaded` for the same load is precisely the desync the mirror
 * rule in `playback-machine.ts` exists to prevent.
 */
export type PlayerAdapterEvent =
  | { readonly type: "status"; readonly status: PlayerAdapterStatus }
  | { readonly type: "loadstarted"; readonly loadId: number }
  | {
      readonly type: "loaded";
      readonly loadId: number;
      readonly timeline: PlayerTimeline;
      readonly tracks: readonly PlayerTrack[];
    }
  | { readonly type: "playing"; readonly loadId: number }
  | { readonly type: "paused"; readonly loadId: number }
  | { readonly type: "position"; readonly positionSeconds: number }
  | { readonly type: "duration"; readonly durationSeconds: number | null }
  | {
      readonly type: "buffering";
      readonly stalled: boolean;
      /** 0–100 where the engine reports it; `null` where it does not. */
      readonly fillPercent: number | null;
    }
  | { readonly type: "seekstarted"; readonly positionSeconds: number }
  | { readonly type: "seekcompleted"; readonly positionSeconds: number }
  | { readonly type: "tracks"; readonly tracks: readonly PlayerTrack[] }
  | {
      readonly type: "trackselected";
      readonly kind: PlayerTrackKind;
      readonly trackId: string | null;
    }
  | { readonly type: "volume"; readonly level: number; readonly muted: boolean }
  | {
      readonly type: "error";
      readonly loadId: number | null;
      readonly error: PlayerError;
    }
  | { readonly type: "ended"; readonly loadId: number }
  | { readonly type: "telemetry"; readonly avSync: AvSyncTelemetry }
  /**
   * The adapter lost events and has re-read its state from the engine. NOT an
   * error: mpv drops events on `MPV_EVENT_QUEUE_OVERFLOW` and the obligation is
   * to resync (§5). Surfaced because a session that resyncs repeatedly is a
   * session whose telemetry has holes, and a silent hole reads as a clean run.
   */
  | { readonly type: "resynchronised"; readonly droppedEvents: number | null };

/** Every event type, as a value, derived rather than restated. */
const EVENT_TYPES: Readonly<Record<PlayerAdapterEvent["type"], true>> = {
  status: true,
  loadstarted: true,
  loaded: true,
  playing: true,
  paused: true,
  position: true,
  duration: true,
  buffering: true,
  seekstarted: true,
  seekcompleted: true,
  tracks: true,
  trackselected: true,
  volume: true,
  error: true,
  ended: true,
  telemetry: true,
  resynchronised: true
};
export const PLAYER_ADAPTER_EVENT_TYPES: readonly PlayerAdapterEvent["type"][] =
  Object.keys(EVENT_TYPES) as PlayerAdapterEvent["type"][];

/* --- the boundary ------------------------------------------------------- */

export interface PlayerAdapter {
  readonly id: PlayerAdapterId;

  /**
   * A REASONED DECISION TAKEN BEFORE PLAYBACK, not a guess discovered at load
   * time. Pure and synchronous: it reads the candidate's capability descriptor
   * and this adapter's declared capabilities, and it performs no I/O.
   */
  canPlay(candidate: PlayerCandidate): CanPlayDecision;

  /** Load an authorized session's candidate. Rejects if `canPlay` refuses. */
  load(request: PlayerLoadRequest): Promise<void>;

  play(): Promise<void>;
  pause(): Promise<void>;
  /** SECONDS, absolute. */
  seek(positionSeconds: number): Promise<void>;
  stop(): Promise<void>;

  /** `null` deselects. An unknown id rejects rather than silently doing nothing. */
  selectAudioTrack(trackId: string | null): Promise<void>;
  selectSubtitleTrack(trackId: string | null): Promise<void>;

  /** `level` is 0–1. Muting is a separate fact, not `level === 0`. */
  setVolume(level: number, options?: { readonly muted?: boolean }): Promise<void>;

  /** Pull-side reads, for a consumer that needs a value now rather than the next event. */
  getTimeline(): PlayerTimeline;
  getTracks(): readonly PlayerTrack[];
  readAvSyncTelemetry(): AvSyncTelemetry;

  subscribe(listener: (event: PlayerAdapterEvent) => void): () => void;

  /**
   * Release the engine and every OS resource behind it. Idempotent, and it must
   * remain safe to call on an adapter that never loaded anything — a shell that
   * exits during startup is an ordinary case, and an mpv handle that outlives
   * its window is an orphaned native resource.
   */
  dispose(): Promise<void>;
}

/* --- helpers the boundary owns ------------------------------------------ */

/**
 * The candidate a load request names, or `undefined`.
 *
 * Here rather than in each adapter because "which candidate does this load
 * mean" must have exactly one answer: two implementations resolving an id
 * differently is how a reason trail comes to attribute a failure to a stream
 * that was never played.
 */
export function candidateForLoad(
  request: PlayerLoadRequest
): PlayerCandidate | undefined {
  return request.session.candidates.find(
    (candidate) => candidate.id === request.candidateId
  );
}

/**
 * A refusal, constructed. Exists so the `reason` and the `refusal` are produced
 * in one place and cannot drift into describing different things.
 */
export function refuse(
  adapterId: PlayerAdapterId,
  refusal: PlayerRefusalCode,
  reason: string
): CanPlayDecision {
  return { playable: false, adapterId, refusal, reason };
}

/** An acceptance, with the reason the accepting branch is required to carry. */
export function accept(
  adapterId: PlayerAdapterId,
  confidence: CompatibilityConfidence,
  reason: string
): CanPlayDecision {
  return { playable: true, adapterId, confidence, reason };
}
