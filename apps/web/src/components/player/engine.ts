/* -------------------------------------------------------------------------
 * The engine port (PL-0501)
 *
 * Shaka Player is reached only through this interface. Two reasons, both of
 * which are load-bearing rather than stylistic:
 *
 *   - `shaka-player` unpacks to ~88 MB of browser-only code and its compiled
 *     bundle touches `window` at module scope. A test that imports it either
 *     needs a DOM or does not run. Every behaviour worth testing in the player
 *     — the engine-load failure branch, teardown, the error severity split —
 *     is about what we do AROUND the engine, so the engine is injected.
 *   - `docs/RESEARCH_PLAYBACK.md` leaves an hls.js contingency open for the
 *     iOS/Safari case where Shaka may fall back to native `src=` HLS. If that
 *     trigger ever fires, a second implementation of this interface is the
 *     change, not an edit to the element.
 *
 * The shapes are structural and deliberately NOT imported from `shaka-player`'s
 * bundled `.d.ts`. Importing those types would put the package on the module
 * graph of every file that touches playback, which is the thing being avoided.
 * They are pinned to Shaka 5.2.x; see `shaka-engine.ts` for the adapter.
 * ---------------------------------------------------------------------- */

/**
 * A Shaka player configuration fragment, passed through untouched.
 *
 * Opaque on purpose. Modelling Shaka's configuration tree here would mean
 * re-declaring several hundred keys and re-declaring them again on every minor
 * upgrade, and would make PL-0503 unable to switch CMCD on without first
 * editing this file — which is exactly the coupling this element exists to
 * avoid. Shaka validates unknown keys itself and logs them.
 */
export type EngineConfig = Readonly<Record<string, unknown>>;

/**
 * The untouched return of `player.getStats()`.
 *
 * Read defensively rather than through a declared shape: Shaka adds fields to
 * this object between minors, and a fixture in a test should not have to supply
 * all twenty-five of them to exercise one. `playback-stats.ts` is the only
 * place that interprets it.
 */
export type RawEngineStats = Readonly<Record<string, unknown>>;

/**
 * The subset of `shaka.Player` this element drives.
 *
 * `attach` is separate from construction because Shaka 5.0 removed the media
 * element from the Player constructor — passing one is not a deprecation
 * warning any more, it is a signature that no longer exists.
 */
export interface ShakaPlayerHandle {
  attach(mediaElement: HTMLMediaElement): Promise<void>;
  configure(config: EngineConfig): unknown;
  /**
   * `startTime` and the media duration are in SECONDS here, as everywhere in
   * Shaka's API. Nothing in this file is milliseconds.
   */
  load(uri: string, startTime?: number | null, mimeType?: string): Promise<void>;
  unload(): Promise<void>;
  destroy(): Promise<void>;
  /**
   * Resume a stalled stream without touching the manifest, the buffer or the
   * CDM session. The cheapest recovery Shaka offers, and the reason PL-0502
   * treats a RECOVERABLE error as a `recovering` state rather than as a
   * candidate failover.
   *
   * OPTIONAL, and that is the honest declaration rather than a convenience: it
   * is the one method on this port with no equivalent in the hls.js contingency
   * `docs/RESEARCH_PLAYBACK.md` leaves open, so a caller has to have an answer
   * for its absence. The state machine's answer is that the error is promoted to
   * a failover, which is a worse outcome than a stream retry and a much better
   * one than a crash.
   */
  retryStreaming?(retryDelaySeconds?: number): boolean;
  getStats(): RawEngineStats;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface ShakaEngine {
  /**
   * False when the platform lacks Media Source Extensions or EME. This is a
   * capability answer, not an error, and the caller must be able to render
   * something honest for it rather than catching an exception.
   */
  isBrowserSupported(): boolean;
  createPlayer(): ShakaPlayerHandle;
}

/**
 * Deferred engine load.
 *
 * Returns a promise because the real implementation is a dynamic `import()`,
 * which is how Shaka stays out of the React Server Component graph. It can
 * reject for reasons that have nothing to do with our code — an ad-blocker
 * matching the chunk name, a corporate proxy rewriting the response, a CSP
 * without the right `script-src`. Those are the failure branch the element
 * has to surface as a state.
 */
export type EngineLoader = () => Promise<ShakaEngine>;
