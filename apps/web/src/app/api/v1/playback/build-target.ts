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

/* -------------------------------------------------------------------------
 * THE SECOND AND THIRD BUNDLERS (PL-0501, round 45)
 *
 * ROUND 44 LEFT A HOLE AND SAID SO IN A COMMENT; THE REVIEWER REFUSED THE
 * COMMENT. `next.config.ts` used to state that "the desktop target is
 * Turbopack-only" and that `next build --webpack` "must not be used to build
 * it", which is a rule with nothing enforcing it:
 *
 *   "Make the build-target split fail closed under all supported production
 *    build commands. Turbopack-only is not acceptable: `next build --webpack`
 *    can silently resolve the on-device implementation. [...] Do not leave a
 *    production command that builds successfully with the wrong trust
 *    boundary."
 *
 * THE BRANCH TAKEN IS THE SECOND ONE THE REVIEWER OFFERED: equivalent
 * fail-closed target resolution for webpack, rather than making webpack
 * unsupported and refusing it in build configuration and CI. The reasoning is
 * in `apps/web/next.config.ts` beside the hook that applies it.
 *
 * HOW MANY BUNDLERS THERE ARE, READ OFF NEXT'S OWN SELECTOR RATHER THAN
 * ASSUMED. `next/dist/lib/bundler.js` (16.3.1) enumerates exactly three --
 * `Bundler.Turbopack`, `Bundler.Webpack`, `Bundler.Rspack` -- and
 * `parseBundlerArgs` selects between them from `--turbopack`/`--turbo`,
 * `--webpack`, `NEXT_RSPACK`/`NEXT_TEST_USE_RSPACK` and the `TURBOPACK`
 * environment variable, defaulting to Turbopack when nothing is set. Turbopack
 * reads `turbopack.resolveExtensions`; webpack and Rspack both go through the
 * `webpack` config hook, because Next's Rspack integration reuses that path. So
 * the two mechanisms below cover the whole enumeration, and the enumeration is
 * the argument -- not a belief about which command people use.
 *
 * THE INCOMING LIST IS THE GROUND TRUTH, NOT `WEB_RESOLVE_EXTENSIONS`. The
 * desktop forms are derived from whatever extensions the bundler was already
 * configured with, so an extension a future Next version adds gets a desktop
 * override form automatically. Prepending a hand-written list instead would
 * leave any unknown extension resolving to its on-device module -- the failure
 * that is silent and open, which is the one shape this whole mechanism exists
 * to avoid.
 * ---------------------------------------------------------------------- */

/**
 * The part of a webpack/Rspack configuration this module touches.
 *
 * Structural and minimal, so nothing here depends on webpack's types -- which
 * `apps/web` does not install and must not, since `next.config.ts` is compiled
 * by whatever is present.
 */
export interface BundlerResolveConfiguration {
  resolve?: { extensions?: string[] | undefined } | undefined;
}

/**
 * The desktop list, derived from a bundler's own extension list.
 *
 * IT THROWS RATHER THAN RETURNING THE INPUT when the input is not a usable
 * extension list. That is the fail-closed half: a bundler whose configuration
 * this module no longer recognises is a bundler whose resolution it cannot
 * redirect, and silently returning an unmodified list there would produce a
 * desktop build containing the on-device resolver -- a successful build with
 * the wrong trust boundary, which is the exact outcome the reviewer refused.
 * A failed build is recoverable; a shipped one is not.
 */
export function desktopResolveExtensionsFrom(incoming: readonly string[] | undefined): string[] {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new Error(
      "the desktop build target cannot be applied: the bundler supplied no resolve.extensions list " +
        "to derive `.desktop` overrides from, so module resolution could not be redirected and the " +
        "build would have contained the on-device provider resolver"
    );
  }

  const malformed = incoming.filter(
    (extension) => typeof extension !== "string" || !extension.startsWith(".")
  );
  if (malformed.length > 0) {
    throw new Error(
      `the desktop build target cannot be applied: resolve.extensions contains ${JSON.stringify(
        malformed
      )}, which are not extensions this module can derive a \`.desktop\` form for`
    );
  }

  /* Already applied. Idempotent because Next can evaluate a config more than
   * once in a single command (server, edge and client compilers each get one),
   * and a second prepend would produce `.desktop.desktop.ts`. */
  const alreadyApplied = incoming.filter((extension) =>
    extension.startsWith(DESKTOP_MODULE_INFIX)
  );
  if (alreadyApplied.length > 0) return [...incoming];

  return [...incoming.map((extension) => `${DESKTOP_MODULE_INFIX}${extension}`), ...incoming];
}

/**
 * Applies the desktop target's resolution to a webpack or Rspack config.
 *
 * Returns the same object Next handed us, mutated in place, because that is the
 * contract of the `webpack` hook -- a caller is entitled to have its own
 * references to the config still be the config.
 */
export function applyDesktopModuleResolution<Configuration extends BundlerResolveConfiguration>(
  config: Configuration
): Configuration {
  if (config === null || typeof config !== "object") {
    throw new Error(
      "the desktop build target cannot be applied: the bundler supplied no configuration object"
    );
  }
  const resolve = config.resolve;
  if (resolve === undefined || resolve === null || typeof resolve !== "object") {
    throw new Error(
      "the desktop build target cannot be applied: the bundler configuration has no `resolve` " +
        "section, so module resolution could not be redirected"
    );
  }

  resolve.extensions = desktopResolveExtensionsFrom(resolve.extensions);
  return config;
}

/**
 * Where a build target writes its artifacts.
 *
 * `null` for `web` means "leave `distDir` unset", which keeps the hosted build
 * writing `.next` exactly as it always has.
 *
 * THE DESKTOP TARGET GETS ITS OWN DIRECTORY, and that is a trust-boundary
 * property rather than housekeeping. Two builds of the same application with
 * different resolution rules, writing to one directory, means the artifact on
 * disk is whichever ran last and nothing on it says which. `next start` would
 * then serve a web-resolved bundle out of a desktop shell, and every test that
 * looked at `.next` would be measuring a build it did not identify. Correction 3
 * of the round-45 review asks for exactly this in the cache dimension ("a web
 * build must never satisfy a cached desktop build"); a shared output directory
 * is the same confusion one layer down, and it is also what makes the two
 * targets servable side by side, which `e2e/` needs in order to compare them.
 *
 * `dist/desktop` rather than `.next-desktop` for one mechanical reason: the
 * repository's `.gitignore` ignores `.next/` and `dist/` by name, and
 * `.gitignore` is not on this task's write surface -- so a sibling of `.next`
 * would leave a build artifact showing up as untracked.
 */
export const DESKTOP_DIST_DIR = "dist/desktop";

export function distDirFor(target: BuildTarget): string | null {
  return target === "desktop" ? DESKTOP_DIST_DIR : null;
}

/* -------------------------------------------------------------------------
 * THE DESKTOP SCRIPTS IN `apps/web/package.json`, EXPLAINED HERE BECAUSE JSON
 * CANNOT CARRY A COMMENT
 *
 * `dev:desktop`, `build:desktop` and `start:desktop` all run the same five-line
 * `node -e` program, and it does exactly two things that the plain scripts do
 * not.
 *
 * 1. IT SETS `LIBERTY_BUILD_TARGET=desktop` IN THE CHILD'S ENVIRONMENT, rather
 *    than with a `VAR=value command` prefix. That prefix is shell syntax that
 *    Windows `cmd.exe` -- npm's default script shell there -- does not
 *    understand, and this repository takes Windows seriously enough to have
 *    `scripts/with-root-env.mjs` exist for a closely related reason. A
 *    `cross-env` dependency would have done it in one word and was not added
 *    for one script; if a second lane ever needs the same thing, adding it is
 *    the right move and this program is the thing to delete.
 *
 * 2. IT RESTORES `apps/web/next-env.d.ts`. Next REGENERATES that file on every
 *    `build` and `dev`, and the generated content names the active `distDir` --
 *    `import "./.next/types/routes.d.ts"` for the web target and
 *    `import "./dist/desktop/types/routes.d.ts"` for this one (see
 *    `next/dist/lib/typescript/writeAppTypeDeclarations.js`, which offers no way
 *    to turn it off). The file is TRACKED, so without this a desktop build would
 *    leave a modified file behind that no task declared as a write surface, and
 *    two developers on the two targets would flip it back and forth in every
 *    commit. Restoring it is safe rather than merely tidy: `apps/web`'s
 *    `tsconfig.json` sets `skipLibCheck`, so an import of a declaration file the
 *    current build did not emit is not an error, and the web target's spelling
 *    is the one the repository has always committed.
 *
 *    THE RESTORE COVERS A BUILD AND NOT A KILLED DEV SERVER, and that limit is
 *    measured rather than assumed: the wrapper restores after the child exits
 *    normally, and a `next dev` that Playwright's harness tears down with a
 *    signal leaves the file rewritten to `dist/desktop/dev/...`. That is a
 *    residue rather than a regression, because THE WEB DEV SERVER ALREADY DOES
 *    THE SAME THING and did before this change: a development-mode e2e run with
 *    the desktop axis switched off leaves `next-env.d.ts` pointing at
 *    `.next/dev/...`, which is not what the repository has committed either.
 *    `git checkout apps/web/next-env.d.ts` is the whole remedy for both, and
 *    the durable fix -- untracking a file Next regenerates on every build -- is
 *    a decision about `.gitignore` and `next-env.d.ts`, neither of which is on
 *    this task's write surface.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * ONE MORE CONSEQUENCE OF `dist/desktop`, RECORDED WHERE THE DIRECTORY IS
 * CHOSEN
 *
 * `apps/web/eslint.config.mjs` ignores `.next/**` and `node_modules/**` and
 * nothing else, so once a desktop build exists `npm run lint` starts linting
 * the EMITTED BUNDLE -- hundreds of `require()` and unused-`exports` errors
 * about generated JavaScript. CI does not hit it today (the `validate` job
 * lints before it builds, and never builds the desktop target at all), which is
 * exactly the kind of "green because of the order the steps happen to run in"
 * that this repository has been bitten by before.
 *
 * The fix is `--ignore-pattern "dist/**"` on `apps/web`'s `lint` script, which
 * is inside this task's write surface. THE BETTER HOME IS `globalIgnores` IN
 * `eslint.config.mjs`, beside the `.next/**` entry it belongs next to, and that
 * file is NOT on this task's surface -- so the script carries it and this
 * paragraph says where it should move. Moving it is a one-line change for
 * whoever next holds that file.
 * ---------------------------------------------------------------------- */
