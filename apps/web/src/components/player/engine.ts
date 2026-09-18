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

/*
 * TYPE-ONLY, AND THE ONLY IMPORT IN THIS FILE. `shaka-error.ts` imports nothing
 * at all, so this edge adds no module to anyone's graph and cannot cycle, and
 * `import type` is erased entirely at emit. See `PlaybackEngineId` for why the
 * alias runs in this direction rather than the other.
 */
import type { PlaybackErrorEngine } from "./shaka-error";

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


/* -------------------------------------------------------------------------
 * The engine-NEUTRAL half (PL-0903)
 *
 * Everything above this line is the Shaka port: structural shapes pinned to
 * Shaka 5.2.x, for the one engine that runs in a page. Everything below it is
 * vocabulary that BOTH engines report through, and it lives here rather than in
 * `playback-controller.ts` because that module is, by its own header, the Shaka
 * session. A vocabulary a native adapter must speak cannot be defined inside the
 * web engine's own implementation module.
 *
 * `docs/DESKTOP_PLAYBACK.md` §6 records the gap this closes: the machine's
 * `ENGINE_STATE { status: "unavailable" }` branch is the same branch for
 * "libmpv-2.dll is not loadable" and for "this browser has no MSE", and until
 * now the only vocabulary on it described a browser.
 * ---------------------------------------------------------------------- */

/**
 * Which implementation produced a report.
 *
 * The same two values as `PlayerAdapterId` in `docs/DESKTOP_PLAYBACK.md` §3,
 * and deliberately the same spelling, so that when PL-0901's boundary is built
 * the two identities are one identity rather than two that must be mapped. It
 * is NOT declared here as `PlayerAdapterId`, because that name belongs to a
 * boundary this task does not own and must not pre-empt.
 *
 * An IDENTITY FOR THE REASON TRAIL, NEVER A SWITCH. Nothing may branch on this
 * to choose behaviour; §3's rule is that which engine is playing is a fact about
 * the build target, not a fact the application reasons over.
 *
 * AN ALIAS, NOT A SECOND LITERAL UNION, SINCE PL-0502. It was written out here
 * as its own two-member literal union only because PL-0903 and PL-0904 were
 * implemented on parallel branches that could not import each other, which left
 * two independently editable declarations of one engine identity — the kind of
 * pair where the one nothing reads is the one that drifts.
 *
 * THE DIRECTION IS THE ONE `shaka-error.ts` ALREADY IDENTIFIED and it is not a
 * coin toss: that module imports nothing, while this one is the Shaka-injection
 * port. Aliasing the other way would pull `ShakaPlayerHandle` and `EngineLoader`
 * into the error vocabulary's import graph, which is the dependency direction
 * `docs/DESKTOP_PLAYBACK.md` §3 exists to forbid. So `PlaybackErrorEngine` is
 * the declaration and this is the name the port layer knows it by. Adding an
 * engine means editing one union, in one file.
 */
export type PlaybackEngineId = PlaybackErrorEngine;

/**
 * Why an engine is not usable, in terms of WHAT FAILED rather than of WHO.
 *
 * THE MEMBER NAMES THE FAILURE; THE ENGINE IS CARRIED BESIDE IT. This is the
 * whole decision PL-0903 exists to take, and the alternative it rejects is worth
 * stating: a `libmpv_unavailable` member added next to `host_unsupported`
 * would leave one union naming one engine's failure modes and one library's, so
 * every later engine would add its own member and the consumers would grow a
 * switch over engines that §3 forbids one layer up. The engine's identity and
 * its own code go in `EngineUnavailableDetail`, which sits next to the reason on
 * the state and is never folded into it.
 *
 * The three members are three DIFFERENT LIFECYCLE FAILURES, and each one has a
 * real instance on both engines:
 *
 *   - `engine_load_failed` — THE ENGINE COULD NOT BE OBTAINED. Nothing about the
 *     host or the source was learned, because no engine ever ran.
 *       web: the dynamic `import()` rejected (an ad-blocker matching the chunk, a
 *       proxy rewriting the response, a CSP without the right `script-src`, an
 *       offline reload), or the constructor threw.
 *       native: `libmpv-2.dll` is not present or not loadable, or `mpv_create()`
 *       failed. THIS IS THE MEMBER A NATIVE ENGINE REPORTS WHEN THE LIBRARY IS
 *       MISSING, and it names no engine, no library and no browser.
 *
 *   - `host_unsupported` — THE ENGINE RAN AND THE HOST CANNOT SUPPORT IT.
 *     A capability answer, not a fault.
 *       web: `isBrowserSupported()` is false — no Media Source Extensions, or no
 *       EME where the content needs it.
 *       native: `mpv_initialize()` failed, or no usable video output exists on
 *       this machine.
 *     THE MEMBER IS SPELLED FOR THE HOST, NOT FOR ONE KIND OF HOST. PL-0903 had
 *     to leave it spelled for a browser — the fixture in
 *     `playback-machine.test.ts` that constructs the literal was outside that
 *     task's `allowedPaths`, so the spelling could not be changed without
 *     failing `tsc` in a file it could not repair. PL-0502 owns
 *     `apps/web/src/components/player/**` and completed the migration in one
 *     change: the type, the controller, the machine, the tests, the reason trail
 *     and the comments. NO ALIAS AND NO SECOND SPELLING WAS KEPT — one lifecycle
 *     fact gets one name, and two names for one class is the coupling above
 *     rather than a fix for it. The BEHAVIOUR IS UNCHANGED: this still means the
 *     engine loaded and ran far enough to determine that the current host cannot
 *     support it.
 *
 *   - `attach_failed` — THE ENGINE RAN ON THIS HOST AND COULD NOT BE BOUND TO
 *     ITS OUTPUT SURFACE.
 *       web: `player.attach(mediaElement)` rejected.
 *       native: embedding into the window handle (`--wid`) failed.
 *
 * WHAT IS DELIBERATELY NOT A MEMBER: "the engine loaded and refused this
 * source". `docs/DESKTOP_PLAYBACK.md` §3 already owns that answer as
 * `PlayerRefusalCode` on `canPlay`, and it is a different kind of fact —
 * unavailability is decided ONCE, before any source is loaded, and ends the
 * session at `#fatal`; a refusal is per-candidate and feeds failover. Putting a
 * per-source outcome in this union is the one way an unavailability reason could
 * plausibly reach the failover scheduler at all, so it is refused by
 * construction rather than guarded against afterwards.
 *
 * Declared as an array with the type derived from it, the same way
 * `PLAYBACK_FAILURE_KINDS` is derived from its schema in `@liberty/contracts`:
 * a hand-written second list is a second fact, and the one that drifts is always
 * the one nothing reads.
 */
export const ENGINE_UNAVAILABLE_REASONS = [
  "engine_load_failed",
  "host_unsupported",
  "attach_failed"
] as const;

export type EngineUnavailableReason = (typeof ENGINE_UNAVAILABLE_REASONS)[number];

/**
 * The engine's own account of an unavailability, carried BESIDE the reason.
 *
 * `code` IS A STRING AND THAT IS A SAFETY PROPERTY, not a style choice. The
 * numeric `code` and `category` on `PlaybackError` are pinned to Shaka 5.2.x and
 * are exactly the fields `classifyPlaybackFailure` reads to decide a
 * `PlaybackFailureKind` — of which `network_transient` is the only retryable
 * one. An engine-specific number placed anywhere a Shaka number is read would be
 * interpreted on Shaka's scale: libmpv's `MPV_ERROR_LOADING_FAILED` is -13, and
 * mpv's END_FILE error numbers collide with Shaka's category space outright. A
 * namespaced string is not assignable to `number | null`, so the compiler, not a
 * reviewer, is what stops that detail from ever landing in a classified field.
 *
 * Namespace every code with its engine id (`"web-shaka.attach_rejected"`,
 * `"native-mpv.loader_failed"`), so a code read out of context still says whose
 * number space it belongs to.
 *
 * `null` where the engine supplied nothing. Never a zero and never a code
 * borrowed from the other engine.
 */
export interface EngineUnavailableDetail {
  readonly engine: PlaybackEngineId;
  readonly code: string | null;
}
