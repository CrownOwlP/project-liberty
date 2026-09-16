import type { NextConfig } from "next";
import {
  buildTargetFrom,
  extensionsFor,
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
    ...(resolveExtensions === null ? {} : { turbopack: { resolveExtensions: [...resolveExtensions] } })
  };
}

/**
 * Turbopack is this app's bundler (Next 16 default) and the config above is
 * what selects the implementation for it. `next build --webpack` is still a
 * supported escape hatch, and it reads a different resolver configuration
 * entirely -- so a desktop build produced that way would silently resolve
 * `playback-session-implementation.ts` and ship the on-device resolver.
 *
 * DECLARING A `webpack` FUNCTION HERE IS NOT A FREE FIX: Next warns when a
 * webpack config is present under Turbopack, and it would add a second, untested
 * bundler path to the one place in this application where getting resolution
 * wrong is a rights exposure. The honest disposition is that THE DESKTOP TARGET
 * IS TURBOPACK-ONLY and that `--webpack` must not be used to build it; the
 * assertion in `build-target.test.ts` checks the rules this file publishes, not
 * which bundler consumed them, and it cannot see that difference.
 */
const nextConfig: NextConfig = nextConfigFor(buildTargetFrom(process.env[BUILD_TARGET_ENV_VAR]));

export default nextConfig;
