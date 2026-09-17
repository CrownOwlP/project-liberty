import type { NextConfig } from "next";
import {
  applyDesktopModuleResolution,
  buildTargetFrom,
  distDirFor,
  extensionsFor,
  type BundlerResolveConfiguration,
  type BuildTarget
} from "./src/app/api/v1/playback/build-target";

/**
 * The environment variable that names the build target. READ HERE AND NOWHERE
 * ELSE.
 *
 * This file runs on the BUILD MACHINE and is not part of any bundle, which is
 * what makes reading a variable here compatible with
 * `docs/DESKTOP_PLAYBACK.md` §8's "no environment variable, no config key and
 * no feature flag". §8's objection is to a switch that "can put resolution back
 * on-device in a shipped desktop build", because such a switch "lives on the
 * machine the user administers, next to the code it would re-enable". This one
 * lives on neither: it is consumed by the compiler, it decides which module is
 * COMPILED IN, and the shipped desktop artifact contains no reader of it and no
 * resolver for it to re-enable. Setting `LIBERTY_BUILD_TARGET=web` on a user's
 * desktop machine changes nothing, because nothing there looks.
 *
 * `build-target.test.ts` asserts the "nowhere else" half mechanically: no
 * module under `apps/web/src` may mention this name.
 */
export const BUILD_TARGET_ENV_VAR = "LIBERTY_BUILD_TARGET";

/**
 * The config for a target, as a pure function of it.
 *
 * Pure so the test suite can ask for the desktop configuration without setting
 * an environment variable and without importing a second copy of the rules --
 * "the desktop build resolves `.desktop` modules first" is then asserted
 * against the object this build actually uses, not against a restatement of it.
 */
export function nextConfigFor(target: BuildTarget): NextConfig {
  const resolveExtensions = extensionsFor(target);
  const distDir = distDirFor(target);

  return {
    /*
     * The dev server must serve its own JavaScript to a loopback IP.
     *
     * FOUND BY THE FIRST REAL RUN of the Playwright harness, in the dev server's
     * own log: "Blocked cross-origin request to Next.js dev resource
     * /_next/static/chunks/... from 127.0.0.1". Next's dev-origin guard treats a
     * request whose Host is a bare IP as cross-origin unless the app names it, so
     * the framework chunks, the player chunk and the HMR endpoint were all
     * refused. NOTHING HYDRATED -- on any page.
     *
     * That is why the harness reported a missing `<liberty-video>` under a
     * development build: `PlayerSurface` creates the element inside an effect, and
     * the effect never ran. It is also why the search test failed on all four
     * browser projects with the box holding the typed text and the address bar
     * unchanged -- Playwright wrote into the DOM and React was never there to see
     * it. One cause, presenting as several unrelated product defects, and
     * invisible to `tsc`, which is the only thing CI runs over that harness.
     *
     * `127.0.0.1` because `e2e/src/env.ts` builds its base URL from the loopback
     * ADDRESS rather than the name -- deliberately, so the suite does not depend
     * on how a machine resolves `localhost`. Pointing the harness at `localhost`
     * instead would have made the symptom disappear without the app ever stating
     * which dev origins it trusts, and would break again for any numeric base URL
     * an operator supplies.
     *
     * Development only: Next ignores this in a production build, so it grants
     * nothing to a deployment.
     */
    allowedDevOrigins: ["127.0.0.1"],
    reactStrictMode: true,
    transpilePackages: [
      "@liberty/contracts",
      "@liberty/media-engine",
      "@liberty/observability",
      "@liberty/provider-sdk"
    ],
    /*
     * THE BUILD-TARGET SPLIT (PL-0501, docs/DESKTOP_PLAYBACK.md §8).
     *
     * Under the desktop target, `X.desktop.ts` resolves ahead of `X.ts`, which
     * is how `app/api/v1/playback/session/playback-session-implementation.ts`
     * -- the on-device resolver and everything it reaches, including
     * `@liberty/provider-sdk` -- is replaced by the forwarder rather than
     * accompanied by it. See `src/app/api/v1/playback/build-target.ts` for why
     * the split is resolution rather than a flag, a branch or an injected
     * dependency, all three of which would leave the resolver in the bundle.
     *
     * The key is OMITTED ENTIRELY for the web target, so the hosted build's
     * module resolution is untouched framework default and this change cannot
     * regress it.
     */
    ...(resolveExtensions === null ? {} : { turbopack: { resolveExtensions: [...resolveExtensions] } }),

    /*
     * THE SAME SPLIT FOR WEBPACK AND RSPACK (PL-0501, round 45, correction 2).
     *
     * Next 16.3.1 can build this application with exactly three bundlers --
     * `next/dist/lib/bundler.js` enumerates `Turbopack`, `Webpack` and `Rspack`
     * and `parseBundlerArgs` selects between them. Turbopack reads the key
     * above. Webpack and Rspack both arrive through THIS hook, because Next's
     * Rspack integration reuses the webpack configuration path. Between the two
     * keys, every production build command this application supports resolves
     * the desktop override.
     *
     * WHY THIS BRANCH RATHER THAN REFUSING WEBPACK. The reviewer offered both:
     * make webpack explicitly unsupported and refuse it in build configuration
     * and CI, or implement equivalent fail-closed resolution for it. This is the
     * second.
     *
     *   - A refusal protects the build commands somebody remembered to refuse.
     *     It would have to name `--webpack`, and `NEXT_RSPACK` beside it, and
     *     the next selector Next adds after that -- and the failure mode of a
     *     missed name is a SUCCESSFUL build with the on-device resolver in it,
     *     which is the outcome the correction exists to prevent. Correct
     *     resolution has the opposite failure mode: `desktopResolveExtensionsFrom`
     *     throws when it is handed a configuration it cannot redirect, so an
     *     unrecognised bundler configuration fails the build instead of shipping.
     *   - A refusal splits enforcement across this file and `.github/workflows/ci.yml`,
     *     so the property holds only where CI runs. This holds wherever the build
     *     runs, including on a developer's machine and inside the e2e harness --
     *     which is what lets `e2e/` start a real desktop-target server and
     *     compare it against the web one.
     *   - It is testable at unit cost. `build-target.test.ts` walks the module
     *     graph a second time using the extension list THIS HOOK produces from a
     *     realistic webpack config, and asserts the same absences it asserts for
     *     Turbopack. A refusal can only be tested by asserting that a build
     *     failed.
     *
     * `.github/workflows/ci.yml` is therefore NOT edited by this task, and the
     * record says the entry comes back out of `allowedPaths` if unused. It is
     * unused.
     *
     * NO TURBOPACK WARNING IS PRODUCED BY DECLARING THIS, which was round 44's
     * stated objection and is checkable rather than a matter of opinion:
     * `next/dist/lib/turbopack-warning.js` errors only when
     * `process.env.TURBOPACK === 'auto' && hasWebpackConfig && !hasTurboConfig`.
     * This key is present only for the desktop target, which also sets
     * `turbopack`, so `hasTurboConfig` is true. The web target declares neither.
     *
     * THE KEY IS OMITTED ENTIRELY FOR THE WEB TARGET, for the reason the
     * Turbopack key is: the hosted build's resolution stays framework default
     * and this mechanism cannot regress it.
     */
    ...(target !== "desktop"
      ? {}
      : {
          webpack: (config: BundlerResolveConfiguration) => applyDesktopModuleResolution(config)
        }),

    /*
     * A SEPARATE OUTPUT DIRECTORY FOR THE DESKTOP TARGET. See `distDirFor` in
     * `src/app/api/v1/playback/build-target.ts` for why this is a boundary
     * property and not housekeeping. Omitted for the web target so `.next` is
     * untouched.
     */
    ...(distDir === null ? {} : { distDir })
  };
}

/**
 * THE PARAGRAPH THIS REPLACES SAID THE DESKTOP TARGET WAS TURBOPACK-ONLY, AND
 * THAT DISPOSITION WAS REFUSED ON REVIEW.
 *
 * It read: "`next build --webpack` is still a supported escape hatch [...] so a
 * desktop build produced that way would silently resolve
 * `playback-session-implementation.ts` and ship the on-device resolver [...]
 * the honest disposition is that THE DESKTOP TARGET IS TURBOPACK-ONLY". A
 * statement in a comment is not a disposition, it is a hope; `gpt-architect`'s
 * round-45 review said "do not leave a production command that builds
 * successfully with the wrong trust boundary", and the `webpack` hook in
 * `nextConfigFor` above is the answer. Both keys are now set for the desktop
 * target, they cover all three bundlers Next 16.3.1 can select, and
 * `build-target.test.ts` walks the module graph under each of them.
 */
const nextConfig: NextConfig = nextConfigFor(buildTargetFrom(process.env[BUILD_TARGET_ENV_VAR]));

export default nextConfig;
