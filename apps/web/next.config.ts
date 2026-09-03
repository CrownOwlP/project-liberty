import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  ]
};

export default nextConfig;
