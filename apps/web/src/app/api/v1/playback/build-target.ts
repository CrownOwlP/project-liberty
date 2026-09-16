/* -------------------------------------------------------------------------
 * THE BUILD TARGET, AND HOW IT SELECTS A ROUTE IMPLEMENTATION (PL-0501)
 *
 * `docs/DESKTOP_PLAYBACK.md` §8 rules that provider resolution and any
 * credential-bearing provider call must not rely on the user-administered local
 * sidecar as the trust boundary, and that the desktop build proxies
 * `/api/v1/playback/*` to an authenticated backend behind the same
 * application-facing route contract. It then rules on HOW that split is made,
 * and the how is the part this module exists for:
 *
 *   "The split is by build target, not by runtime configuration. There is no
 *    environment variable, no config key and no feature flag that can put
 *    resolution back on-device in a shipped desktop build. [...] A build that
 *    contains the on-device resolver at all is a build from which the on-device
 *    resolver can be reached. The desktop target therefore does not compile it
 *    in, and that is the property to test for."
 *
 * SO THE MECHANISM IS MODULE RESOLUTION, NOT A CONDITIONAL. A conditional
 * compiles both sides in; a dependency-injection seam compiles both sides in; a
 * dynamic `import()` compiles both sides in and defers the choice to the moment
 * the machine the user administers executes it. Only resolution can make one of
 * two modules ABSENT from a build, and absence is the property §8 asks for.
 *
 * THE RULE, IN ONE LINE: under the desktop target, `X.desktop.ts` is preferred
 * over `X.ts` for the same extensionless import. Today exactly one module pair
 * uses it --
 * `app/api/v1/playback/session/playback-session-implementation{,.desktop}.ts` --
 * and `handler.ts` imports the pair without an extension, so the handler,
 * `route.ts`, `contract.ts` and the whole HTTP envelope are compiled from the
 * same source in both builds and neither knows which one it is in.
 *
 * WHY EXTENSION PRIORITY RATHER THAN AN ALIAS. An alias is a table of pairs
 * that has to be extended by hand for every module that gains a desktop half,
 * and a table can silently lose an entry -- which fails OPEN, by compiling the
 * resolver back into the desktop build. Extension priority is one rule with no
 * entries to lose: a `.desktop.ts` file that exists is selected, and the review
 * question becomes "which desktop overrides exist", answerable with `ls`. It is
 * the same mechanism React Native uses for `.ios`/`.android`, and it is
 * supported by both bundlers this app can be built with (Turbopack's
 * `resolveExtensions`, webpack's `resolve.extensions`).
 *
 * THIS MODULE READS NOTHING. It holds no `process.env`, no configuration, no
 * I/O and no state -- it is a vocabulary and a pure function over it, so that
 * NOTHING INSIDE THE BUNDLE CAN CONSULT THE BUILD TARGET AT RUNTIME. The one
 * place the target is read is `apps/web/next.config.ts`, which runs on the
 * build machine and is not part of any bundle, and `build-target.test.ts`
 * asserts that no shipped module under `apps/web/src` reads it. A build target
 * a running process can ask about is a build target something can eventually
 * branch on, and §8 forbids exactly that.
 *
 * WHY IT LIVES UNDER `app/api/v1/playback/`. Because that is PL-0501's write
 * surface, and because the only override that exists is a playback-session one.
 * It is app-wide in EFFECT -- resolve extensions apply to every import in the
 * build -- so if a second, unrelated lane ever needs a desktop override this
 * module should move up to `apps/web/src/` and be renamed for the app rather
 * than for the route. That is a relocation, not a redesign: nothing here
 * mentions playback.
 * ---------------------------------------------------------------------- */

/**
 * The targets this application can be built for.
 *
 * `web` is the hosted build and the default. `desktop` is the Tauri shell's
 * sidecar build described in `docs/DESKTOP_PLAYBACK.md` §2, which is the build
 * §8's ruling is about. There is deliberately no third value and no "auto":
 * every target must be named, because a target nobody named is a target nobody
 * reasoned about the trust boundary for.
 */
export const BUILD_TARGETS = ["web", "desktop"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

export const DEFAULT_BUILD_TARGET: BuildTarget = "web";

/**
 * The infix that marks a module as the desktop target's replacement for its
 * neighbour.
 *
 * `playback-session-implementation.desktop.ts` replaces
 * `playback-session-implementation.ts`. Note that it REPLACES rather than
 * extends: the module the desktop build did not select is not resolved, not
 * compiled and not present, which is the whole point.
 */
export const DESKTOP_MODULE_INFIX = ".desktop";

/**
 * The extensions a build resolves, in priority order.
 *
 * `WEB_RESOLVE_EXTENSIONS` is the list Next documents as its own default, so
 * the web target changes nothing about resolution and keeps whatever the
 * framework does; `extensionsFor` returns `null` for it precisely so the config
 * omits the key rather than restating the framework's defaults back at it,
 * where a future Next version could add one this file does not know about.
 *
 * The desktop list is the same default with the `.desktop`-infixed forms
 * PREPENDED. Order is the mechanism: resolution takes the first extension that
 * names an existing file, so a desktop override wins wherever one exists and
 * every other import in the application resolves exactly as it does on the web.
 */
export const WEB_RESOLVE_EXTENSIONS: readonly string[] = [
  ".mdx",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mjs",
  ".json"
];

export const DESKTOP_RESOLVE_EXTENSIONS: readonly string[] = [
  ...WEB_RESOLVE_EXTENSIONS.map((extension) => `${DESKTOP_MODULE_INFIX}${extension}`),
  ...WEB_RESOLVE_EXTENSIONS
];

/**
 * The resolve-extension list a target needs, or `null` when it needs none.
 *
 * `null` for `web` says "do not configure resolution at all", which is stronger
 * than configuring it to the defaults: it means the hosted build is byte-for-
 * byte the build this repository has always produced, and that the desktop
 * split added no risk to it.
 */
export function extensionsFor(target: BuildTarget): readonly string[] | null {
  return target === "desktop" ? DESKTOP_RESOLVE_EXTENSIONS : null;
}

/**
 * Turns whatever the build machine supplied into a target, or refuses.
 *
 * AN UNRECOGNISED VALUE THROWS, and an absent one is `web`. Those two are not
 * the same case and must not be collapsed: nothing supplied means an ordinary
 * hosted build, while `LIBERTY_BUILD_TARGET=Desktop` or `=tauri` is somebody
 * asking for the desktop build and getting the web one -- a build that would
 * ship the on-device resolver inside the shell, pass every functional check,
 * and be exactly the arrangement §8 refuses. Failing the build is the only
 * honest answer to a typo here.
 *
 * It takes the value as an ARGUMENT and never reads the environment itself, so
 * this module stays consultable by a test without one and unable to tell a
 * running process anything.
 */
export function buildTargetFrom(value: string | undefined): BuildTarget {
  if (value === undefined || value === "") return DEFAULT_BUILD_TARGET;
  const target = BUILD_TARGETS.find((candidate) => candidate === value);
  if (target === undefined) {
    throw new Error(
      `unknown build target ${JSON.stringify(value)}; expected one of ${BUILD_TARGETS.join(", ")}`
    );
  }
  return target;
}
