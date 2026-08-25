import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, MANAGES_SERVER, PORT, SERVER_MEDIA_ORIGIN, WEB_MODE } from "./src/env";

/* -------------------------------------------------------------------------
 * PL-0701 - the critical end-to-end harness
 *
 * WHY THIS LIVES OUTSIDE THE WORKSPACES. The root `package.json` declares
 * `apps/*` and `packages/*`, so `e2e/` is not a workspace member and its
 * dependencies install into `e2e/node_modules` on their own. Two reasons, both
 * load-bearing:
 *
 *   - `apps/web`'s vitest suite runs in the `node` environment and picks up
 *     `**\/*.test.ts` under that app. A Playwright spec swept into it would
 *     fail on the first `page` fixture, and moving E2E specs there is how a
 *     unit gate starts needing a browser;
 *   - Playwright pins a browser build to an exact package version. Keeping it
 *     out of the root lockfile means a browser-download step never becomes a
 *     prerequisite of `npm ci` for every lane that only wants to typecheck.
 *
 * The cost is one extra `npm install`, documented in docs/E2E.md.
 *
 * `@playwright/test` is pinned EXACTLY (1.62.1, Apache-2.0) rather than
 * carets. Playwright downloads a browser build keyed to the package version, so
 * a caret range means the browser a gate was recorded against can change under
 * a lockfile refresh -- and "e2e passed" would then be evidence about a browser
 * nobody chose.
 * ---------------------------------------------------------------------- */

const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * `process.env` with the holes removed.
 *
 * Playwright's `webServer.env` is `Record<string, string>` while Node's is
 * `Record<string, string | undefined>`, and an explicit `undefined` value is
 * not the same as an absent key -- it would be passed through as the literal
 * string "undefined" by some spawn paths. Dropped rather than coerced.
 */
const INHERITED_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

/**
 * How the managed server is started.
 *
 * `npm run build` at the root rather than only building `@liberty/web`: it is
 * the same turbo invocation CI runs, so a harness run and a CI run are building
 * the same graph, and turbo's cache makes the repeat cost near zero.
 */
const WEB_SERVER_COMMAND =
  WEB_MODE === "development"
    ? `npm run dev --workspace @liberty/web -- --port ${PORT}`
    : `npm run build && npm run start --workspace @liberty/web -- --port ${PORT}`;

export default defineConfig({
  testDir: "./tests",
  /* Every spec here is stateless against a fixture-backed server, so running
   * them together is not just safe -- it is the condition under which an
   * order dependence would actually show up. This repository has had six of
   * those and treats determinism as correctness. */
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  /*
   * NO RETRIES, ANYWHERE, INCLUDING CI.
   *
   * The usual `retries: 2` would defeat the reason this harness exists. A
   * flaky E2E suite teaches people to re-run until green, and the six
   * order-dependence defects this project has already found are precisely the
   * class of failure that a retry converts into a pass. If a test here is not
   * deterministic it is a defect in the test and it gets fixed, not retried.
   * docs/E2E.md states the one narrow case where a retry is legitimate.
   */
  retries: 0,

  /* Generous because a cold `next start` compiles the first request for a
   * route, and in `development` mode it compiles all of them. This is a
   * ceiling for a hang, never a substitute for a wait -- no spec here sleeps. */
  timeout: 60_000,
  expect: { timeout: 10_000 },

  /* `retain-on-failure`, not `on-first-retry`: with retries at 0 there is no
   * first retry, and a trace that is only captured on a run that never happens
   * is no trace at all. */
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },

  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  projects: [
    /*
     * The API project is where the invariants live, and it is listed first
     * because it needs no browser: `npx playwright test --project=api` is
     * runnable on a machine where `playwright install` never succeeded, which
     * matters for a container that has no GTK.
     */
    { name: "api", testMatch: /.*\.api\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },

    { name: "chromium", testIgnore: /.*\.api\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },

    /*
     * WebKit is not a nice-to-have here. docs/RESEARCH_PLAYBACK.md names
     * iOS/Safari as the concrete thing to measure, because Shaka may fall back
     * to native `src=` HLS there and lose the `getStats()` reason trail that
     * CMCD depends on -- so the surface most likely to lose the reason trail is
     * the one least likely to be run by a developer on Linux.
     */
    { name: "webkit", testIgnore: /.*\.api\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    { name: "mobile-safari", testIgnore: /.*\.api\.spec\.ts/, use: { ...devices["iPhone 13"] } },

    { name: "firefox", testIgnore: /.*\.api\.spec\.ts/, use: { ...devices["Desktop Firefox"] } }
  ],

  /*
   * Omitted entirely when `LIBERTY_E2E_BASE_URL` names an existing deployment.
   * Playwright would otherwise start a second server the tests never talk to.
   */
  webServer: MANAGES_SERVER
    ? {
        command: WEB_SERVER_COMMAND,
        cwd: REPO_ROOT,
        url: `${BASE_URL}/api/health`,
        /* Long enough for a cold turbo build on a CI runner with no cache. */
        timeout: 300_000,
        /* Locally, reuse whatever is already on the port. Never in CI, where an
         * adopted server is a server nobody can say what was built from. */
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
        /*
         * EVERY APPLICATION VARIABLE THIS HARNESS CARES ABOUT IS PINNED HERE,
         * INCLUDING THE ONES WHOSE PINNED VALUE IS THE DEFAULT.
         *
         * Omitting a variable is not a way to say "use the app's default". It
         * says "take whatever the environment has", and the environment
         * underneath a harness-started server is no longer empty: `apps/web`'s
         * `dev` and `start` scripts run through `scripts/with-root-env.mjs`,
         * which loads the repository root's dotenv files into `process.env` for
         * every name not already set. A hole in this block is therefore a hole a
         * developer's `.env.local` falls through, into the server whose answers
         * are about to be recorded as a gate result -- and the symptom is an
         * assertion failure that blames the application.
         *
         * The rule this block follows: if a spec asserts against it, or the app
         * reads it, it is written here with a value this file can name. See
         * `src/env.ts` for where those values come from.
         */
        env: {
          ...INHERITED_ENV,
          /*
           * `turbo.json` hashes this into the build cache key and
           * `validate-env.mjs --scope ci` fails when it is unset, so leaving it
           * to whatever the shell has would make a recorded gate result mean
           * different things on different machines.
           */
          CONTENT_RIGHTS_ENFORCEMENT: "strict",
          /*
           * The rig when one is configured, and the app's own RFC 2606 default
           * when not -- never the ambient value. `SERVER_MEDIA_ORIGIN` is the
           * same expression `EXPECTED_MEDIA_ORIGIN` is built from, so what the
           * server is given and what the specs demand cannot drift apart, and
           * `MEDIA_RIG_SKIP_REASON` stays a true statement about the server
           * rather than about this process's variables.
           */
          LIBERTY_FIXTURE_MEDIA_ORIGIN: SERVER_MEDIA_ORIGIN

          /*
           * NODE_ENV is the one application variable deliberately NOT pinned,
           * and it is the exception that proves the rule rather than a hole.
           * `WEB_MODE` already decides it, by choosing the subcommand: `next
           * dev` is a development build and `next build`/`next start` are
           * production ones, whatever the environment says. Writing it here
           * would let this block and `WEB_SERVER_COMMAND` disagree about which
           * deployment is under test -- and the two modes answer the session API
           * differently on purpose, so that disagreement would read as a product
           * failure. It is also not inheritable from a root dotenv file:
           * `with-root-env.mjs` refuses to apply NODE_ENV from any file, for a
           * closely related reason documented in its `NEVER_APPLIED`.
           */
        }
      }
    : undefined
});
