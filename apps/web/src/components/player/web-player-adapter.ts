/* -------------------------------------------------------------------------
 * WebPlayerAdapter — the Shaka path, behind the boundary (PW-0202).
 *
 * ADOPT, WRAP, ADAPT. `PlaybackController`, `<liberty-video>`, the XState
 * machine and the failure classifier are working, reviewed, tested code with a
 * green e2e suite over them. This file WRAPS them; it reimplements nothing. The
 * measure of that is the e2e counts: if they move, this was a rewrite.
 *
 * WHY THIS ADAPTER MATTERS ON WINDOWS TOO. It is not the "web build's" adapter —
 * it is the DRM path on BOTH targets, because mpv has no CDM. A desktop session
 * playing protected content is running through this file.
 *
 * THE ONE LAYER BELOW. `ShakaPlayerHandle` in `engine.ts` stays exactly where it
 * is. This adapter satisfies `PlayerAdapter` by composing the controller, the
 * media element and — through the documented escape hatch `getEnginePlayer()` —
 * the handful of Shaka reads that have no other source. Those reads are all
 * DEFENSIVE, on the rule `playback-stats.ts` already follows: Shaka's surface is
 * untyped at that seam and a missing method is an ordinary outcome on a version
 * bump, not a crash.
 * ---------------------------------------------------------------------- */

import {
  WEB_SHAKA_CAPABILITIES,
  protectionDecisionFor
} from "./adapter-routing";
import type { AudioRole } from "@liberty/contracts/domains/audio";
import type { SubtitleFormat, SubtitleKind } from "@liberty/contracts/domains/subtitles";

import {
  readTimeRanges,
  type BufferedRange,
  type TimeRangesLike
} from "./diagnostics/buffered-ranges";
import type { PlaybackController } from "./playback-controller";
import {
  candidateForLoad,
  refuse,
  type AvSyncTelemetry,
  type CanPlayDecision,
  type PlayerAdapter,
  type PlayerAdapterEvent,
  type PlayerCandidate,
  type PlayerLoadRequest,
  type PlayerTimeline,
  type PlayerTrack
} from "./player-adapter";

/**
 * The media element operations this adapter drives.
 *
 * Structural, not `HTMLMediaElement`, for the reason the rest of this directory
 * states repeatedly: a test must be able to supply one without a DOM, and a
 * narrow structural type is also a list of everything this adapter is capable of
 * doing to the element.
 */
export interface MediaElementLike {
  currentTime: number;
  volume: number;
  muted: boolean;
  readonly duration: number;
  /**
   * OPTIONAL, and that is a statement about test doubles rather than about
   * browsers (PW-0306). Every real media element has `buffered`; a structural
   * double written before this field existed does not, and requiring it would
   * break every such double in order to express a fact that is already handled
   * — `readTimeRanges` answers an empty list for an absent reading, and an
   * empty list is exactly "nothing is held".
   */
  readonly buffered?: TimeRangesLike;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The Shaka reads with no other source. Every one optional; see the header. */
interface TrackReadingPlayer {
  getTextTracks?: () => readonly unknown[];
  getAudioLanguagesAndRoles?: () => readonly unknown[];
  getVariantTracks?: () => readonly unknown[];
  selectTextTrack?: (track: unknown) => void;
  setTextTrackVisibility?: (visible: boolean) => void;
  selectAudioLanguage?: (language: string) => void;
}

export interface WebPlayerAdapterOptions {
  readonly controller: PlaybackController;
  readonly media: MediaElementLike;
  /**
   * Hands over the source the controller should load.
   *
   * Injected rather than called directly so this adapter does not own the
   * transport backstop `checkPlaybackSource` applies — that check belongs to the
   * controller, and duplicating it here would be a second opinion about whether a
   * URI may be loaded.
   */
  readonly setSource: (
    uri: string,
    mimeType: string | null,
    startAtSeconds: number | null
  ) => Promise<void> | void;
}

const MEDIA_EVENTS = [
  "playing",
  "pause",
  "waiting",
  "seeking",
  "seeked",
  "timeupdate",
  "durationchange",
  "ended"
] as const;

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ===========================================================================
 * WHAT A TRACK IS FOR, READ OUT OF SHAKA RATHER THAN GUESSED (PW-0206)
 * ===========================================================================
 *
 * `PlayerTrack` gained `audioRole`, `subtitleKind` and `textFormat` because the
 * selection policy in `@liberty/media-engine` decides on them and this adapter
 * was dropping them on the floor: Shaka publishes `roles`, `audioRoles`, `kind`
 * and `mimeType` on the very objects `#readTracks` was already reading.
 *
 * EVERY FUNCTION BELOW RETURNS `null` RATHER THAN A DEFAULT. A track the engine
 * under-described is one the policy must decline to decide about. The one
 * tempting default -- role "main" -- is the one that would put a COMMENTARY
 * track into automatic selection, which is the harm `AUTO_SELECTABLE_ROLES`
 * exists to prevent.
 *
 * AND NONE OF THEM READS A LABEL. `subtitles.ts` says it in terms: "SDH" in a
 * label is a naming convention and this is a decision input.
 */

/** Role strings, lower-cased. `[]` when the engine stated none. */
function readRoles(source: Record<string, unknown>, key: string): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .map((entry) => entry.toLowerCase());
}

/**
 * DASH/HLS role vocabulary → the contract's `AudioRole`.
 *
 * `audioRoles` first and `roles` second: on a Shaka VARIANT, `roles` is the
 * union of the video and audio roles, so a video role would otherwise be read
 * as a statement about the soundtrack. Checked most-specific first, because a
 * track legitimately carries several and "commentary" said anywhere about the
 * audio is the one that must not be lost.
 *
 * `original` has no DASH role of its own -- it is an HLS CHARACTERISTIC and a
 * DASH accessibility descriptor in some profiles -- so it is honoured where the
 * engine literally says it and never derived. A missing `original` costs a
 * fallback quality; an invented one would override a viewer's real preference.
 */
function audioRoleOf(entry: Record<string, unknown>): AudioRole | null {
  const stated = readRoles(entry, "audioRoles");
  const roles = stated.length > 0 ? stated : readRoles(entry, "roles");
  if (roles.includes("commentary")) return "commentary";
  if (roles.includes("description") || roles.includes("descriptive")) return "descriptive";
  if (roles.includes("dub")) return "dub";
  if (roles.includes("original")) return "original";
  if (roles.includes("main")) return "main";
  return null;
}

/**
 * Shaka's text-track description → the contract's `SubtitleKind`.
 *
 * `forced` is decided by the engine's own boolean and is checked FIRST, which
 * is what keeps `subtitleKind === "forced"` and `isForced` from disagreeing --
 * the invariant `player-adapter.ts` states and this adapter's suite asserts.
 *
 * THE ONE JUDGEMENT CALL, STATED RATHER THAN BURIED: a track Shaka describes as
 * a CAPTION is reported as `sdh`. They are not definitionally identical -- SDH
 * is a home-video convention and captions are a broadcast one -- but both mean
 * "the dialogue plus the non-speech audio, for a viewer who cannot hear it",
 * which is the distinction the contract's enum draws and the only one the
 * policy acts on. Reporting captions as `null` instead would be the safer-
 * looking choice and the worse one: it would leave `sdh` unreachable from the
 * one engine this product ships today, and `subtitles.ts` records that SDH is
 * frequently the only subtitle track a title has in a language. If this mapping
 * is ever wrong for a real stream, it is wrong HERE, in one named function,
 * rather than spread through a policy.
 */
function subtitleKindOf(entry: Record<string, unknown>, isForced: boolean): SubtitleKind | null {
  if (isForced) return "forced";
  const roles = readRoles(entry, "roles");
  if (roles.includes("commentary")) return "commentary";
  const kind = (readString(entry, "kind") ?? "").toLowerCase();
  if (kind === "caption" || kind === "captions") return "sdh";
  if (roles.includes("caption") || roles.includes("captions")) return "sdh";
  if (kind === "subtitle" || kind === "subtitles" || roles.includes("subtitle")) return "subtitles";
  return null;
}

/**
 * MIME type → the contract's `SubtitleFormat`.
 *
 * By mime type and not by a file extension in a URI, because a URI is a
 * provider's naming habit and a mime type is a declaration. Parameters are
 * stripped (`text/vtt; charset=utf-8`); an unrecognised type is `null`, which
 * the policy then rejects as unrenderable -- the honest outcome for a format
 * nobody has established this client can draw.
 */
function textFormatOf(mimeType: string | null): SubtitleFormat | null {
  if (mimeType === null) return null;
  switch (mimeType.split(";", 1)[0]?.trim().toLowerCase()) {
    case "text/vtt":
    case "text/webvtt":
      return "webvtt";
    case "application/ttml+xml":
    case "application/mp4":
      /* `application/mp4` on a TEXT track is a TTML payload in an ISO-BMFF
       * wrapper, which is how DASH ships segmented timed text. Shaka reports
       * the container; the renderable format inside it is TTML. */
      return "ttml";
    case "application/x-subrip":
    case "text/srt":
      return "srt";
    case "text/x-ssa":
    case "application/x-ass":
    case "text/x-ass":
      return "ass";
    default:
      return null;
  }
}

export class WebPlayerAdapter implements PlayerAdapter {
  readonly id = "web-shaka" as const;

  readonly #controller: PlaybackController;
  readonly #media: MediaElementLike;
  readonly #setSource: WebPlayerAdapterOptions["setSource"];
  readonly #listeners = new Set<(event: PlayerAdapterEvent) => void>();
  readonly #mediaHandlers = new Map<string, () => void>();

  #tracks: readonly PlayerTrack[] = [];
  #loadId: number | null = null;
  #disposed = false;

  constructor(options: WebPlayerAdapterOptions) {
    this.#controller = options.controller;
    this.#media = options.media;
    this.#setSource = options.setSource;
    for (const type of MEDIA_EVENTS) {
      const handler = (): void => this.#onMediaEvent(type);
      this.#mediaHandlers.set(type, handler);
      this.#media.addEventListener(type, handler);
    }
  }

  /**
   * THE PROTECTION AXIS IS NOT DECIDED HERE.
   *
   * It is delegated to `protectionDecisionFor`, which is the one place that reads
   * `requiresContentDecryptionModule`. An adapter answering the DRM question for
   * itself would be the second opinion PW-0203 exists to prevent — and it would
   * be the adapter WITH a CDM answering it, which is the one whose mistake is
   * silent.
   */
  canPlay(candidate: PlayerCandidate): CanPlayDecision {
    if (this.#disposed) {
      return refuse(this.id, "adapter_unavailable", "this adapter has been disposed");
    }
    return protectionDecisionFor(WEB_SHAKA_CAPABILITIES, candidate);
  }

  async load(request: PlayerLoadRequest): Promise<void> {
    const candidate = candidateForLoad(request);
    if (candidate === undefined) {
      throw new Error(
        `load names candidate ${request.candidateId}, which this session does not carry`
      );
    }
    const decision = this.canPlay(candidate);
    if (!decision.playable) {
      /* The boundary says `load` rejects if `canPlay` refuses. Checking it HERE
       * as well as in the router is not a second opinion -- it is the same
       * function, called again, so a caller that skipped routing cannot bypass a
       * rights refusal by calling `load` directly. */
      throw new Error(`${decision.refusal}: ${decision.reason}`);
    }
    this.#loadId = request.loadId;
    this.#emit({ type: "loadstarted", loadId: request.loadId });
    await this.#setSource(candidate.uri, candidate.mimeType, request.startAtSeconds);
    this.#tracks = this.#readTracks();
    this.#emit({
      type: "loaded",
      loadId: request.loadId,
      timeline: this.getTimeline(),
      tracks: this.#tracks
    });
  }

  async play(): Promise<void> {
    await this.#media.play();
  }

  async pause(): Promise<void> {
    this.#media.pause();
  }

  async seek(positionSeconds: number): Promise<void> {
    this.#emit({ type: "seekstarted", positionSeconds });
    this.#media.currentTime = positionSeconds;
  }

  async stop(): Promise<void> {
    this.#media.pause();
    this.#loadId = null;
  }

  async selectAudioTrack(trackId: string | null): Promise<void> {
    /* `null` deselects, and for audio that is meaningless -- there is always an
     * audio track playing -- so it is refused rather than silently ignored. */
    if (trackId === null) throw new Error("audio cannot be deselected");
    const track = this.#requireTrack(trackId, "audio");
    const player = this.#trackPlayer();
    if (player?.selectAudioLanguage === undefined) {
      throw new Error("this engine cannot select an audio language");
    }
    player.selectAudioLanguage(track.language ?? track.id);
    this.#emit({ type: "trackselected", kind: "audio", trackId });
  }

  async selectSubtitleTrack(trackId: string | null): Promise<void> {
    const player = this.#trackPlayer();
    if (trackId === null) {
      player?.setTextTrackVisibility?.(false);
      this.#emit({ type: "trackselected", kind: "subtitle", trackId: null });
      return;
    }
    this.#requireTrack(trackId, "subtitle");
    if (player?.selectTextTrack === undefined) {
      throw new Error("this engine cannot select a text track");
    }
    const raw = (player.getTextTracks?.() ?? []).find(
      (entry) => isRecord(entry) && String(entry["id"]) === trackId
    );
    if (raw === undefined) throw new Error(`no text track ${trackId}`);
    player.selectTextTrack(raw);
    player.setTextTrackVisibility?.(true);
    this.#emit({ type: "trackselected", kind: "subtitle", trackId });
  }

  async setVolume(level: number, options: { readonly muted?: boolean } = {}): Promise<void> {
    if (!Number.isFinite(level) || level < 0 || level > 1) {
      throw new Error(`volume ${level} is outside 0-1`);
    }
    this.#media.volume = level;
    /* Muting is a separate fact, not `level === 0`. Unstated leaves it alone. */
    if (options.muted !== undefined) this.#media.muted = options.muted;
    this.#emit({ type: "volume", level, muted: this.#media.muted });
  }

  getTimeline(): PlayerTimeline {
    const duration = this.#media.duration;
    return {
      positionSeconds: this.#media.currentTime,
      /* `NaN` is what a media element reports for "not yet known", and this
       * boundary says NEVER 0 for unknown. */
      durationSeconds: Number.isFinite(duration) ? duration : null
    };
  }

  getTracks(): readonly PlayerTrack[] {
    return this.#tracks;
  }

  getBufferedRanges(): readonly BufferedRange[] {
    /* `readTimeRanges` already answers `[]` for null, undefined, a zero-length
     * reading and a malformed one, so there is nothing to guard here and no
     * second opinion about what an absent reading means. */
    return readTimeRanges(this.#media.buffered);
  }

  /**
   * Ask the engine what is true and publish it (PW-0306).
   *
   * WHAT IT RE-READS AND WHY EACH ONE. The track list, because that is the
   * state this adapter holds rather than derives, and it is the one a consumer
   * cannot recompute. The duration and the position, because they are cheap
   * and because a consumer that missed events most likely missed those too.
   * NOT the play state: `playing` and `paused` carry a `loadId` correlating
   * them to a load, and this adapter must not invent one for a load it did not
   * perform. A consumer that needs to know whether playback is running asks
   * the state machine, which is this product's declared source of that truth.
   *
   * THE ORDER IS DELIBERATE. The facts go out first and `resynchronised` last,
   * so a subscriber that treats the marker as "everything before this is the
   * new truth" is right rather than one event early.
   */
  resynchronise(droppedEvents: number | null = null): void {
    if (this.#disposed) return;
    this.#tracks = this.#readTracks();
    this.#emit({ type: "tracks", tracks: this.#tracks });
    this.#emit({ type: "duration", durationSeconds: this.getTimeline().durationSeconds });
    this.#emit({ type: "position", positionSeconds: this.#media.currentTime });
    this.#emit({ type: "resynchronised", droppedEvents });
  }

  readAvSyncTelemetry(): AvSyncTelemetry {
    /*
     * HONEST, AND NOT A ZERO. A browser has no audio clock for a media element,
     * which docs/RESEARCH_PLAYBACK.md settled: "A browser cannot detect that lips
     * are out of sync." The A/V diagnostics in `diagnostics/` publish PROXIES
     * with their evidence source, and this field is not the place to launder one
     * into a number.
     */
    return { available: false, why: "adapter_cannot_observe" };
  }

  subscribe(listener: (event: PlayerAdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    /* IDEMPOTENT, and safe on an adapter that never loaded. A shell exiting
     * during startup is ordinary, and a Shaka player outliving its element keeps
     * a CDM session alive -- a hazard three comments in this directory name. */
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [type, handler] of this.#mediaHandlers) {
      this.#media.removeEventListener(type, handler);
    }
    this.#mediaHandlers.clear();
    this.#emit({ type: "status", status: { status: "disposed" } });
    this.#listeners.clear();
    await this.#controller.destroy();
  }

  #trackPlayer(): TrackReadingPlayer | null {
    const player = this.#controller.getEnginePlayer();
    return player === null ? null : (player as unknown as TrackReadingPlayer);
  }

  #requireTrack(trackId: string, kind: PlayerTrack["kind"]): PlayerTrack {
    const track = this.#tracks.find((entry) => entry.id === trackId && entry.kind === kind);
    /* An unknown id REJECTS rather than silently doing nothing, which the
     * boundary requires: a menu that appears to change the language and does not
     * is worse than an error. */
    if (track === undefined) throw new Error(`no ${kind} track ${trackId}`);
    return track;
  }

  /**
   * The first code in this repository to read tracks at all.
   *
   * Defensive throughout: every field is read by key with a type check, and a
   * missing method yields an empty list rather than throwing. Shaka's track
   * shapes are untyped at this seam and `playback-stats.ts` already treats them
   * that way for the same reason.
   */
  #readTracks(): readonly PlayerTrack[] {
    const player = this.#trackPlayer();
    if (player === null) return [];
    const tracks: PlayerTrack[] = [];

    for (const entry of player.getTextTracks?.() ?? []) {
      if (!isRecord(entry)) continue;
      const id = readString(entry, "id") ?? String(entry["id"] ?? "");
      if (id === "") continue;
      const isForced = readBoolean(entry, "forced");
      tracks.push({
        id,
        kind: "subtitle",
        label: readString(entry, "label"),
        language: readString(entry, "language"),
        codec: readString(entry, "codec"),
        channels: null,
        isDefault: readBoolean(entry, "primary"),
        isForced,
        audioRole: null,
        subtitleKind: subtitleKindOf(entry, isForced),
        textFormat: textFormatOf(readString(entry, "mimeType"))
      });
    }

    for (const entry of player.getVariantTracks?.() ?? []) {
      if (!isRecord(entry)) continue;
      const language = readString(entry, "language");
      const id = `audio:${language ?? "unstated"}`;
      /* One entry per LANGUAGE, not per variant. Shaka publishes a variant per
       * video rendition, so a five-bitrate stream would otherwise produce five
       * identical "English" rows in a menu. */
      if (tracks.some((track) => track.id === id)) continue;
      tracks.push({
        id,
        kind: "audio",
        label: readString(entry, "label"),
        language,
        codec: readString(entry, "audioCodec"),
        channels: readNumber(entry, "channelsCount"),
        isDefault: readBoolean(entry, "primary"),
        isForced: false,
        audioRole: audioRoleOf(entry),
        subtitleKind: null,
        textFormat: null
      });
    }

    return tracks;
  }

  #onMediaEvent(type: (typeof MEDIA_EVENTS)[number]): void {
    const loadId = this.#loadId;
    switch (type) {
      case "playing":
        if (loadId !== null) this.#emit({ type: "playing", loadId });
        return;
      case "pause":
        if (loadId !== null) this.#emit({ type: "paused", loadId });
        return;
      case "waiting":
        this.#emit({ type: "buffering", stalled: true, fillPercent: null });
        return;
      case "seeking":
        this.#emit({ type: "seekstarted", positionSeconds: this.#media.currentTime });
        return;
      case "seeked":
        this.#emit({ type: "seekcompleted", positionSeconds: this.#media.currentTime });
        return;
      case "timeupdate":
        this.#emit({ type: "position", positionSeconds: this.#media.currentTime });
        return;
      case "durationchange":
        this.#emit({ type: "duration", durationSeconds: this.getTimeline().durationSeconds });
        return;
      case "ended":
        if (loadId !== null) this.#emit({ type: "ended", loadId });
        return;
    }
  }

  #emit(event: PlayerAdapterEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        /* A subscriber that throws must not abort teardown or stop the other
         * subscribers, exactly as PlaybackController already decided. */
      }
    }
  }
}
