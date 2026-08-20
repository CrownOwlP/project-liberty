"use client";

/* -------------------------------------------------------------------------
 * <liberty-video> — a Shaka session behind a <video>-shaped API
 *
 * media-chrome's contract is that anything with a `<video>`-shaped API can be
 * `slot="media"` inside a `<media-controller>`. That is the hook that lets us
 * own the playback engine while media-chrome owns the controls, so this element
 * exists to satisfy that shape while routing every byte through Shaka.
 *
 * It is built on Mux's `custom-media-element` base class — the same primitive
 * `shaka-video-element` uses — rather than on `shaka-video-element` itself,
 * which hard-pins an old Shaka major and would silently install a second copy
 * of an 88 MB dependency alongside ours.
 *
 * THIS FILE IS THIN ON PURPOSE. It is the shared dependency of PL-0502 (player
 * state machine), PL-0503 (playback telemetry) and PL-0504 (A/V sync), and it
 * exists so those three can proceed in parallel on disjoint paths. It contains
 * no state machine, no telemetry transport, no drift detection and no UI. Those
 * boundaries are marked where they touch the code.
 *
 * Nothing here may be imported from a server component or an API route — see
 * `shaka-engine.ts`. The `"use client"` directive above marks the boundary for
 * Next; a mechanical import-boundary lint rule lives outside this task's paths
 * and is still owed.
 * ---------------------------------------------------------------------- */

import { CustomVideoElement } from "custom-media-element";
import type { EngineConfig, EngineLoader, RawEngineStats, ShakaPlayerHandle } from "./engine";
import {
  PlaybackController,
  type EngineState,
  type PlaybackControllerEvent
} from "./playback-controller";
import type { PlaybackStatsSnapshot } from "./playback-stats";
import type { PlaybackError } from "./shaka-error";
import { loadShakaEngine } from "./shaka-engine";

export const LIBERTY_VIDEO_TAG = "liberty-video";

/**
 * Namespaced rather than reusing `error`.
 *
 * `custom-media-element` re-dispatches the inner `<video>`'s media events from
 * the host, so a plain `error` event here would be indistinguishable from a
 * `MediaError` — and media-chrome, quite reasonably, treats that as the end of
 * playback. Most Shaka errors are RECOVERABLE and mean nothing of the kind.
 */
export const LIBERTY_VIDEO_ERROR_EVENT = "liberty-error";
export const LIBERTY_VIDEO_ENGINE_STATE_EVENT = "liberty-enginestatechange";

export class LibertyVideoElement extends CustomVideoElement {
  /**
   * The inner `<video>` is rendered without a `src`.
   *
   * If it had one the browser would start a second, native load of the same
   * URL alongside Shaka's — a duplicate download that, on a platform with
   * native HLS, can win and leave playback running through a path where
   * `getStats()` and CMCD report nothing.
   */
  static getTemplateHTML = (attrs: Record<string, string>): string => {
    const withoutSrc: Record<string, string> = {};
    for (const [name, value] of Object.entries(attrs)) {
      if (name !== "src") withoutSrc[name] = value;
    }
    return CustomVideoElement.getTemplateHTML(withoutSrc);
  };

  /**
   * How the engine is obtained. Replaceable so a test, a story or the hls.js
   * contingency can supply a different one; must be set before the element is
   * connected, because that is when the controller is built.
   */
  engineLoader: EngineLoader = loadShakaEngine;

  #controller: PlaybackController | null = null;

  /** Replayed onto the controller after a remount. See `configureEngine`. */
  readonly #configHistory: EngineConfig[] = [];

  /**
   * Set on disconnect and cleared if we are reconnected in the same task.
   * Moving a node in the DOM fires `disconnectedCallback` and then
   * `connectedCallback` synchronously; destroying the Shaka session on the
   * first of those would tear down playback every time a parent reparents the
   * player, which is a genuinely confusing bug to chase.
   */
  #teardownScheduled = false;

  get engineState(): EngineState {
    return this.#controller?.getEngineState() ?? { status: "idle" };
  }

  get lastError(): PlaybackError | null {
    return this.#controller?.getLastError() ?? null;
  }

  /**
   * `null` while the element is not connected. PL-0502 subscribes through the
   * DOM events above rather than reaching in here; this is for the cases that
   * need the object itself.
   *
   * Not called `controller`: every name on this element shares a namespace with
   * `HTMLMediaElement`, and a getter that collides with an inherited property
   * is a compile error rather than an override.
   */
  get playbackController(): PlaybackController | null {
    return this.#controller;
  }

  /** Live Shaka player, or `null`. The seam for PL-0503 and PL-0504. */
  getEnginePlayer(): ShakaPlayerHandle | null {
    return this.#controller?.getEnginePlayer() ?? null;
  }

  /** Normalised, with units in every field name. See `playback-stats.ts`. */
  getPlaybackStats(): PlaybackStatsSnapshot | null {
    return this.#controller?.getPlaybackStats() ?? null;
  }

  getRawEngineStats(): RawEngineStats | null {
    return this.#controller?.getRawEngineStats() ?? null;
  }

  /**
   * Merge a Shaka configuration fragment.
   *
   * This is the entire integration point for PL-0503: Shaka's CMCD v2 support,
   * including Event Mode, is configuration-only, so telemetry is switched on
   * from outside this file. It is also where DRM licence servers arrive —
   * accepting that configuration is the whole of this element's DRM
   * involvement.
   *
   * Kept so a remount reapplies it. Callers configure a session once; the
   * history is not a queue and is not trimmed.
   */
  configureEngine(config: EngineConfig): void {
    this.#configHistory.push(config);
    this.#controller?.configure(config);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.#teardownScheduled = false;

    const controller = this.#ensureController();
    // Reading `nativeEl` is what forces the base class's lazy shadow-DOM init,
    // so the element Shaka attaches to exists before it is handed over.
    void controller.attach(this.nativeEl);
    this.#applySource();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#teardownScheduled = true;

    queueMicrotask(() => {
      if (!this.#teardownScheduled || this.isConnected) return;
      this.#teardownScheduled = false;

      const controller = this.#controller;
      this.#controller = null;
      // A Shaka player that outlives its element keeps its networking engine,
      // its buffers and its CDM session: a leak that also keeps downloading.
      if (controller) void controller.destroy();
    });
  }

  attributeChangedCallback(
    attrName: string,
    oldValue?: string | null,
    newValue?: string | null
  ): void {
    if (attrName === "src") {
      // Deliberately not forwarded to the inner <video>: see `getTemplateHTML`.
      if (oldValue !== newValue) this.#applySource();
      return;
    }
    super.attributeChangedCallback(attrName, oldValue, newValue);
  }

  /**
   * The native meaning of `load()` is "discard what you have and start the
   * resource again", and that is what this does — through Shaka. Left as the
   * inherited passthrough it would instead reset the inner `<video>` out from
   * under the MediaSource Shaka attached to it.
   */
  load(): void {
    this.#applySource();
  }

  /* --------------------------------------------------------------------- */

  #ensureController(): PlaybackController {
    const existing = this.#controller;
    if (existing) return existing;

    const controller = new PlaybackController({
      loadEngine: this.engineLoader,
      onEvent: (event) => this.#dispatchControllerEvent(event)
    });
    for (const config of this.#configHistory) controller.configure(config);

    this.#controller = controller;
    return controller;
  }

  /**
   * `src` is an already-authorized playback URL, not a URL a page may choose.
   * The rights decision happens in the session that produced it (PL-0501);
   * this element only plays what it is handed, and `playback-source.ts`
   * carries the transport backstop and the rest of that reasoning.
   */
  #applySource(): void {
    const controller = this.#controller;
    if (!controller) return;

    const src = this.getAttribute("src");
    void controller.setSource(src === null || src === "" ? null : { uri: src });
  }

  #dispatchControllerEvent(event: PlaybackControllerEvent): void {
    if (event.type === "error") {
      this.dispatchEvent(
        new CustomEvent<PlaybackError>(LIBERTY_VIDEO_ERROR_EVENT, { detail: event.error })
      );
      return;
    }
    this.dispatchEvent(
      new CustomEvent<EngineState>(LIBERTY_VIDEO_ENGINE_STATE_EVENT, { detail: event.state })
    );
  }
}

/**
 * Register the element. Safe to call repeatedly and safe to call where there is
 * no registry at all — a prerender has no `customElements`, and throwing there
 * would turn a cosmetic ordering mistake into a broken page.
 */
export function defineLibertyVideo(tagName: string = LIBERTY_VIDEO_TAG): void {
  const registry = globalThis.customElements;
  if (!registry) return;
  if (registry.get(tagName)) return;
  registry.define(tagName, LibertyVideoElement);
}

/*
 * Spelled out rather than keyed off LIBERTY_VIDEO_TAG: an interface computed
 * key has to be a literal, and this map is what makes
 * `document.querySelector("liberty-video")` return the right type for the three
 * tasks that build on this element.
 */
declare global {
  interface HTMLElementTagNameMap {
    "liberty-video": LibertyVideoElement;
  }
}
