/* -------------------------------------------------------------------------
 * PlaybackController — the Shaka session, without a DOM
 *
 * All of `<liberty-video>`'s behaviour that is worth testing lives here, and
 * none of it touches the custom-element registry, the shadow DOM or WebGL. The
 * element in `liberty-video.ts` is the adapter that binds this to attributes
 * and lifecycle callbacks. Splitting them is not tidiness: a custom element
 * cannot be exercised in the `node` test environment this app uses, and the
 * failure modes that matter — an engine that never loads, a player that is not
 * destroyed on unmount, an error whose severity was dropped — are all here.
 *
 * DELIBERATELY NOT IN THIS FILE, so the boundary is explicit for the three
 * tasks that attach to it next:
 *   - PL-0502's session/candidate state machine. This object reports what
 *     happened; it does not decide what state the session is in, and it does
 *     not fail over. `docs/RESEARCH_PLAYBACK.md` is explicit that the machine
 *     must be a projection of the player rather than its source of truth.
 *   - PL-0503's telemetry pipeline. No batching, no transport, no CMCD mapping.
 *     Shaka's CMCD v2 support is configuration-only, so `configure()` is the
 *     entire integration point.
 *   - PL-0504's drift detection. `getEnginePlayer()` and the media element are
 *     exposed; nothing here measures anything.
 *   - DRM licence acquisition. Key systems and licence servers arrive through
 *     `configure({ drm: … })` and are never constructed here. Shaka's EME
 *     support is for honouring DRM, and this element contains nothing that
 *     works around it.
 * ---------------------------------------------------------------------- */

import type {
  EngineConfig,
  EngineLoader,
  RawEngineStats,
  ShakaEngine,
  ShakaPlayerHandle
} from "./engine";
import {
  checkPlaybackSource,
  describeSourceRejection,
  type PlaybackSource
} from "./playback-source";
import { describePlaybackError, type PlaybackError } from "./shaka-error";
import { toPlaybackStats, type PlaybackStatsSnapshot } from "./playback-stats";

/**
 * Why the engine is not usable. Each of these is a real, observed browser
 * situation rather than a defensive placeholder:
 *   - `engine_load_failed` — the dynamic import rejected. An ad-blocker
 *     matching the chunk, a proxy rewriting the response, a CSP without the
 *     right `script-src`, or simply an offline reload.
 *   - `browser_unsupported` — no Media Source Extensions, or no EME where the
 *     content needs it. This is a capability answer, not a fault.
 *   - `attach_failed` — Shaka refused the media element.
 */
export type EngineUnavailableReason =
  | "engine_load_failed"
  | "browser_unsupported"
  | "attach_failed";

export type EngineState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | {
      readonly status: "unavailable";
      readonly reason: EngineUnavailableReason;
      readonly error: PlaybackError;
    }
  | { readonly status: "destroyed" };

export type PlaybackControllerEvent =
  | { readonly type: "enginestatechange"; readonly state: EngineState }
  | { readonly type: "error"; readonly error: PlaybackError };

export interface PlaybackControllerOptions {
  readonly loadEngine: EngineLoader;
  readonly onEvent?: ((event: PlaybackControllerEvent) => void) | undefined;
}

/**
 * Configuration applied to every player before anything the caller asks for.
 *
 * `sequenceMode: false` is asserted for BOTH manifest types on purpose. It is
 * the default in shaka-player 5.2.6 for DASH and HLS alike — but note that
 * Shaka's own JSDoc for `manifest.hls.sequenceMode` still claims the HLS
 * default is `true`, so the documented behaviour and the shipped default
 * disagree. Writing it down means we do not inherit whichever one a future
 * release settles on. In segments mode Shaka uses the `tfdt`/`trun` timestamps
 * in fMP4 segments, which is what makes PL-0504's timing measurements mean
 * anything; sequence mode discards them.
 *
 * Nothing else is set here. In particular the three `retryParameters` blocks
 * (`drm`, `manifest`, `streaming`) are left at Shaka's defaults for PL-0502 to
 * tune as part of failover policy, rather than being half-tuned in two places.
 */
export const BASELINE_ENGINE_CONFIG: EngineConfig = {
  manifest: {
    dash: { sequenceMode: false },
    hls: { sequenceMode: false }
  }
};

const BROWSER_UNSUPPORTED_MESSAGE =
  "This browser does not support the media APIs playback requires.";

export class PlaybackController {
  readonly #loadEngine: EngineLoader;
  readonly #onEvent: ((event: PlaybackControllerEvent) => void) | undefined;

  #engineState: EngineState = { status: "idle" };
  #lastError: PlaybackError | null = null;

  #enginePromise: Promise<ShakaPlayerHandle | null> | null = null;
  #player: ShakaPlayerHandle | null = null;
  #mediaElement: HTMLMediaElement | null = null;
  #source: PlaybackSource | null = null;
  #destroyed = false;

  /**
   * Bumped by every `setSource` and by `destroy`. A `load()` whose token is
   * stale lost a race and its rejection is not a playback failure — Shaka
   * rejects the superseded call with LOAD_INTERRUPTED, and reporting that would
   * make every candidate switch look like a fault.
   */
  #loadToken = 0;

  /**
   * Replayed onto a freshly created player. The element can be detached and
   * reattached (a React remount, a DOM move), which destroys the player; the
   * caller configured the session once and should not have to notice.
   */
  readonly #configHistory: EngineConfig[] = [];

  constructor(options: PlaybackControllerOptions) {
    this.#loadEngine = options.loadEngine;
    this.#onEvent = options.onEvent;
  }

  getEngineState(): EngineState {
    return this.#engineState;
  }

  getLastError(): PlaybackError | null {
    return this.#lastError;
  }

  getSource(): PlaybackSource | null {
    return this.#source;
  }

  /**
   * The escape hatch, and the reason PL-0503 and PL-0504 do not need to edit
   * this file: `NetworkingEngine` request filters, the `retry` event that
   * retry-storm telemetry can only come from, `preload()`, `getVariantTracks()`
   * and the per-SourceBuffer buffered ranges all hang off the real player.
   * `null` until the engine is ready, and invalid after `destroy()`.
   */
  getEnginePlayer(): ShakaPlayerHandle | null {
    return this.#player;
  }

  /** Shaka's untouched stats object, for anything `toPlaybackStats` drops. */
  getRawEngineStats(): RawEngineStats | null {
    const player = this.#player;
    if (!player) return null;
    try {
      return player.getStats();
    } catch {
      /* Stats are diagnostics. Failing to read them must not break playback. */
      return null;
    }
  }

  /** Normalised, with units in the field names. See `playback-stats.ts`. */
  getPlaybackStats(): PlaybackStatsSnapshot | null {
    const raw = this.getRawEngineStats();
    return raw === null ? null : toPlaybackStats(raw);
  }

  /**
   * Merge a Shaka configuration fragment. Applied immediately when a player
   * exists and replayed onto every later player.
   *
   * This is the whole of PL-0503's integration: Shaka ships CMCD v2 including
   * Event Mode, vendored, so `{ cmcd: { enabled: true, … } }` here is the
   * telemetry feature. It is also how DRM licence servers arrive.
   */
  configure(config: EngineConfig): void {
    this.#configHistory.push(config);
    if (this.#player) this.#applyConfig(config);
  }

  /**
   * Bind the engine to a media element and start loading it.
   *
   * Never rejects. The engine failing to load is a state (`unavailable`), not
   * an exception: it happens on real users' machines for reasons that are not
   * bugs, and a rejected promise from a lifecycle callback is a promise nobody
   * is holding.
   */
  async attach(mediaElement: HTMLMediaElement): Promise<void> {
    if (this.#destroyed) return;
    this.#mediaElement = mediaElement;
    await this.#ensurePlayer();
  }

  /**
   * Route the source through the engine.
   *
   * Note what this is NOT: it never sets `src` on the underlying `<video>`.
   * Native `src=` playback works, and that is the trap — it silently bypasses
   * Shaka, taking `getStats()`, the switch history and CMCD with it, so the
   * reason trail simply stops existing on exactly the platforms where it is
   * hardest to debug.
   *
   * `player.load()` is a teardown-and-restart, not a source swap: stats reset,
   * the buffer is discarded and DRM is re-established. Shaka has no API to do
   * otherwise, so candidate-level failover is a fast restart and the API says
   * so rather than pretending.
   */
  async setSource(source: PlaybackSource | null): Promise<void> {
    if (this.#destroyed) return;
    this.#source = source;
    const token = ++this.#loadToken;

    const player = await this.#ensurePlayer();
    if (!player || this.#destroyed || token !== this.#loadToken) return;

    if (source === null) {
      try {
        await player.unload();
      } catch {
        /* Unloading nothing, or unloading during teardown, is not a failure. */
      }
      return;
    }

    const check = checkPlaybackSource(source);
    if (!check.ok) {
      this.#report(
        describePlaybackError(new Error(describeSourceRejection(check.reason)), "source-rejected")
      );
      return;
    }

    try {
      await player.load(source.uri, source.startTimeSeconds ?? undefined, source.mimeType);
    } catch (cause) {
      /*
       * ROUTE ONE OF TWO. Shaka reports failures through a rejected `load()`
       * promise AND through an `error` event afterwards, and they are not the
       * same set: a manifest that never parses only ever arrives here, while a
       * segment that fails mid-playback only ever arrives at the event handler
       * below. Wiring one and not the other loses half the failures silently,
       * which is why both are marked.
       */
      if (this.#destroyed || token !== this.#loadToken) return;
      this.#report(describePlaybackError(cause, "manifest-load"));
    }
  }

  /**
   * Destroy the player and release the media element.
   *
   * A Shaka player that outlives its element keeps its networking engine, its
   * buffers and its CDM session alive — a memory leak that also shows up as
   * requests for a video nobody is watching. `destroy()` therefore waits for an
   * engine load that is still in flight rather than abandoning it: the import
   * can resolve after unmount, and the player it would then construct would
   * have no owner at all.
   */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#loadToken += 1;

    const pending = this.#enginePromise;
    this.#enginePromise = null;
    if (pending) {
      try {
        await pending;
      } catch {
        /* Already surfaced through the engine state; teardown continues. */
      }
    }

    await this.#teardownPlayer();
    this.#mediaElement = null;
    this.#source = null;
    this.#setEngineState({ status: "destroyed" });
  }

  /* --------------------------------------------------------------------- */

  #ensurePlayer(): Promise<ShakaPlayerHandle | null> {
    const existing = this.#enginePromise;
    if (existing) return existing;

    /*
     * A failed attempt is deliberately not memoised, so the next `attach()` or
     * `setSource()` tries again: an ad-blocker, a captive portal or a dropped
     * connection is the common cause and a retry is cheap, while a permanently
     * dead element is only recoverable by a page reload. The identity check
     * means a stale attempt cannot clear a newer one.
     */
    const attempt: Promise<ShakaPlayerHandle | null> = this.#createPlayer().then((player) => {
      if (player === null && this.#enginePromise === attempt) this.#enginePromise = null;
      return player;
    });

    this.#enginePromise = attempt;
    return attempt;
  }

  async #createPlayer(): Promise<ShakaPlayerHandle | null> {
    this.#setEngineState({ status: "loading" });

    const engine = await this.#importEngine();
    if (!engine || this.#destroyed) return null;

    let supported = false;
    try {
      supported = engine.isBrowserSupported();
    } catch (cause) {
      this.#fail("browser_unsupported", cause);
      return null;
    }
    if (!supported) {
      this.#fail("browser_unsupported", new Error(BROWSER_UNSUPPORTED_MESSAGE));
      return null;
    }

    const player = this.#constructPlayer(engine);
    if (!player) return null;

    /*
     * ROUTE TWO OF TWO — see `setSource`. Subscribed before anything can be
     * loaded, because a `RECOVERABLE` error during startup is still worth
     * counting and Shaka does not replay events for a late subscriber.
     */
    player.addEventListener("error", this.#handleEngineErrorEvent);
    this.#player = player;

    // `destroy()` can have run while the import was still in flight. It is
    // waiting on this promise, so tearing the player down here is what makes
    // that wait sufficient.
    if (this.#destroyed) {
      await this.#teardownPlayer();
      return null;
    }

    this.#applyConfig(BASELINE_ENGINE_CONFIG);
    for (const config of this.#configHistory) this.#applyConfig(config);

    const mediaElement = this.#mediaElement;
    if (mediaElement) {
      try {
        await player.attach(mediaElement);
      } catch (cause) {
        await this.#teardownPlayer();
        this.#fail("attach_failed", cause);
        return null;
      }
      if (this.#destroyed) {
        await this.#teardownPlayer();
        return null;
      }
    }

    this.#setEngineState({ status: "ready" });
    return player;
  }

  async #importEngine(): Promise<ShakaEngine | null> {
    try {
      return await this.#loadEngine();
    } catch (cause) {
      this.#fail("engine_load_failed", cause);
      return null;
    }
  }

  #constructPlayer(engine: ShakaEngine): ShakaPlayerHandle | null {
    try {
      return engine.createPlayer();
    } catch (cause) {
      this.#fail("engine_load_failed", cause);
      return null;
    }
  }

  async #teardownPlayer(): Promise<void> {
    const player = this.#player;
    this.#player = null;
    if (!player) return;
    player.removeEventListener("error", this.#handleEngineErrorEvent);
    try {
      await player.destroy();
    } catch {
      /* Teardown that throws would strand the next player. Nothing to do. */
    }
  }

  #applyConfig(config: EngineConfig): void {
    const player = this.#player;
    if (!player) return;
    try {
      player.configure(config);
    } catch (cause) {
      this.#report(describePlaybackError(cause, "configure"));
    }
  }

  readonly #handleEngineErrorEvent = (event: unknown): void => {
    // Shaka wraps the `shaka.util.Error` in the event's `detail`. Falling back
    // to the event itself keeps a differently-shaped dispatch classifiable
    // rather than turning it into "undefined".
    const detail =
      typeof event === "object" && event !== null && "detail" in event
        ? (event as { detail: unknown }).detail
        : event;
    this.#report(describePlaybackError(detail, "player-event"));
  };

  #fail(reason: EngineUnavailableReason, cause: unknown): void {
    const error = describePlaybackError(cause, "engine-load");
    this.#report(error);
    this.#setEngineState({ status: "unavailable", reason, error });
  }

  #report(error: PlaybackError): void {
    this.#lastError = error;
    this.#emit({ type: "error", error });
  }

  #setEngineState(state: EngineState): void {
    this.#engineState = state;
    this.#emit({ type: "enginestatechange", state });
  }

  #emit(event: PlaybackControllerEvent): void {
    if (!this.#onEvent) return;
    try {
      this.#onEvent(event);
    } catch {
      /*
       * A listener that throws must not abort teardown or leave the engine
       * half-constructed. Errors in a subscriber are the subscriber's problem.
       */
    }
  }
}
