/* -------------------------------------------------------------------------
 * The real Shaka adapter — browser only
 *
 * SHAKA MUST NEVER BE REACHABLE FROM A SERVER COMPONENT OR AN API ROUTE. Its
 * compiled bundle touches browser globals at module scope, so it is loaded
 * through a dynamic `import()` inside this function and nowhere else: importing
 * it at the top of any module would put it in the React Server Component graph
 * and break the server build. Nothing in this file executes until a caller in
 * the browser asks for an engine.
 *
 * `shaka-player/dist/shaka-player.compiled.js` is named explicitly rather than
 * the bare package, so we can never be handed `shaka-player.ui`. The UI build
 * constructs the Player itself, is driven by DOM attributes rather than by us,
 * and carries a Chromecast receiver application ID that only Google can
 * register — none of which we want, and all of which would arrive silently if
 * the package's `main` ever changed.
 * ---------------------------------------------------------------------- */

import type { EngineLoader, ShakaEngine, ShakaPlayerHandle } from "./engine";

interface ShakaNamespaceLike {
  readonly Player: { new (): unknown; isBrowserSupported(): boolean };
  readonly polyfill?: { installAll(): void };
}

function isShakaNamespace(value: unknown): value is ShakaNamespaceLike {
  if (typeof value !== "object" || value === null) return false;
  const player = (value as { Player?: unknown }).Player;
  return (
    typeof player === "function" &&
    typeof (player as { isBrowserSupported?: unknown }).isBrowserSupported === "function"
  );
}

/**
 * `dist/shaka-player.compiled.js` is a Closure-compiled UMD bundle, not ESM.
 * Depending on the bundler it arrives either as the namespace itself or under
 * `default`, and getting that wrong produces `undefined is not a constructor`
 * at the one moment there is no useful stack. Checking both is cheaper than
 * discovering which one a Turbopack upgrade decided on.
 */
function readShakaNamespace(loaded: unknown): ShakaNamespaceLike {
  if (isShakaNamespace(loaded)) return loaded;

  const fallback = (loaded as { default?: unknown } | null)?.default;
  if (isShakaNamespace(fallback)) return fallback;

  throw new Error("shaka-player loaded without a Player constructor.");
}

export const loadShakaEngine: EngineLoader = async (): Promise<ShakaEngine> => {
  const loaded: unknown = await import("shaka-player/dist/shaka-player.compiled.js");
  const shaka = readShakaNamespace(loaded);

  /*
   * Patches platform quirks Shaka's own code assumes are fixed — most visibly
   * Safari's legacy EME interface. Without it, DRM playback fails on Safari in
   * a way that reports as an unsupported key system rather than as a missing
   * polyfill. Idempotent, so a second engine load is harmless.
   */
  shaka.polyfill?.installAll();

  return {
    isBrowserSupported: (): boolean => shaka.Player.isBrowserSupported(),
    // The Player is constructed WITHOUT a media element: Shaka 5.0 removed that
    // constructor parameter outright, and `attach()` is the replacement.
    createPlayer: (): ShakaPlayerHandle => new shaka.Player() as ShakaPlayerHandle
  };
};
