import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import {
  BACKEND_STUB_ORIGIN,
  BACKEND_STUB_PORT,
  BASE_URL,
  DESKTOP_BASE_URL,
  DESKTOP_ENABLED,
  DESKTOP_PORT,
  MANAGES_SERVER,
  PORT,
  SERVER_DATABASE_URL,
  SERVER_MEDIA_ORIGIN,
  STUB_CERTIFICATE,
  WEB_MODE
} from "./src/env";

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

/**
 * The same application, built for the DESKTOP target (PL-0501, round 45).
 *
 * `dev:desktop`, `build:desktop` and `start:desktop` rather than the plain
 * scripts with a variable bolted on, because those ARE the intentional desktop
 * build path correction 3 asked `apps/web/package.json` to expose -- so the
 * harness exercises the path a human would use instead of a private arrangement
 * that only works here. They also restore `apps/web/next-env.d.ts`, which Next
 * rewrites to point at whichever `distDir` last built; see `distDirFor` in
 * `apps/web/src/app/api/v1/playback/build-target.ts`. `LIBERTY_BUILD_TARGET` is
 * ALSO set in the environment below, so the target is stated both by the script
 * and by the process, and the two cannot disagree because it is one value.
 *
 * A DIFFERENT `distDir`, SO THE TWO SERVERS CAN RUN AT ONCE. `next.config.ts`
 * sends the desktop target to `dist/desktop`; without that these two commands
 * would be two builds racing for `.next`, and whichever finished last would be
 * what both servers served.
 */
const DESKTOP_SERVER_COMMAND =
  WEB_MODE === "development"
    ? `npm run dev:desktop --workspace @liberty/web -- --port ${DESKTOP_PORT}`
    : `npm run build:desktop --workspace @liberty/web && npm run start:desktop --workspace @liberty/web -- --port ${DESKTOP_PORT}`;

/**
 * EVERY APPLICATION VARIABLE THIS HARNESS CARES ABOUT IS PINNED HERE,
 * INCLUDING THE ONES WHOSE PINNED VALUE IS THE DEFAULT.
 *
 * Omitting a variable is not a way to say "use the app's default". It says
 * "take whatever the environment has", and the environment underneath a
 * harness-started server is no longer empty: `apps/web`'s `dev` and `start`
 * scripts run through `scripts/with-root-env.mjs`, which loads the repository
 * root's dotenv files into `process.env` for every name not already set. A hole
 * in this block is therefore a hole a developer's `.env.local` falls through,
 * into the server whose answers are about to be recorded as a gate result --
 * and the symptom is an assertion failure that blames the application.
 *
 * The rule this block follows: if a spec asserts against it, or the app reads
 * it, it is written here with a value this file can name. See `src/env.ts` for
 * where those values come from.
 *
 * LIFTED OUT OF THE ONE `webServer` ENTRY IT USED TO SIT IN (PL-0501, round 45)
 * because there are now two application servers -- one per build target -- and
 * two copies of this block is exactly the drift the block exists to prevent.
 * The desktop entry below EXTENDS it and states what it adds; nothing is
 * omitted there.
 */
const APPLICATION_ENV: Record<string, string> = {
  ...INHERITED_ENV,
  /*
   * `turbo.json` hashes this into the build cache key and
   * `validate-env.mjs --scope ci` fails when it is unset, so leaving it to
   * whatever the shell has would make a recorded gate result mean different
   * things on different machines.
   */
  CONTENT_RIGHTS_ENFORCEMENT: "strict",
  /*
   * The rig when one is configured, and the app's own RFC 2606 default when
   * not -- never the ambient value. `SERVER_MEDIA_ORIGIN` is the same
   * expression `EXPECTED_MEDIA_ORIGIN` is built from, so what the server is
   * given and what the specs demand cannot drift apart, and
   * `MEDIA_RIG_SKIP_REASON` stays a true statement about the server rather than
   * about this process's variables.
   */
  LIBERTY_FIXTURE_MEDIA_ORIGIN: SERVER_MEDIA_ORIGIN,

  /*
   * WRITTEN EVEN WHEN IT IS EMPTY, which is the same rule the origin above
   * follows and matters here for a sharper reason. `lib/db/index.ts` picks
   * PostgreSQL whenever this is set and well-formed and the in-memory store
   * otherwise, and it CACHES that choice for the life of the process. An
   * inherited `DATABASE_URL` from a developer's root `.env.local` would
   * therefore point a harness-started server at a real database, and
   * `tests/progress.api.spec.ts` -- which asserts the adapter line every
   * response publishes -- would report the configuration accident as a product
   * failure. An empty string is not a hole, in either direction:
   * `with-root-env.mjs` skips a name with `Object.hasOwn`, on presence rather
   * than truthiness, so `""` is respected as a deliberate value and no dotenv
   * file overrides it -- and `selectRepository` trims and treats it as unset,
   * which is the "no database" branch the default asserts.
   */
  DATABASE_URL: SERVER_DATABASE_URL

  /*
   * NODE_ENV is the one application variable deliberately NOT pinned, and it is
   * the exception that proves the rule rather than a hole. `WEB_MODE` already
   * decides it, by choosing the subcommand: `next dev` is a development build
   * and `next build`/`next start` are production ones, whatever the environment
   * says. Writing it here would let this block and the server commands disagree
   * about which deployment is under test -- and the two modes answer the
   * session API differently on purpose, so that disagreement would read as a
   * product failure. It is also not inheritable from a root dotenv file:
   * `with-root-env.mjs` refuses to apply NODE_ENV from any file, for a closely
   * related reason documented in its `NEVER_APPLIED`.
   *
   * `LIBERTY_BUILD_TARGET` is deliberately NOT pinned here either, and for a
   * sharper reason: it is what distinguishes the two servers below. Setting it
   * in the shared block would make both of them the same target.
   */
};

/**
 * The three servers a full run needs, and the conditions each is present under.
 *
 * ORDER IS NOT DEPENDENCY ORDER -- Playwright starts these concurrently and
 * waits for each one's `url`. The stub backend does not need the web server to
 * be up when it starts: it only relays when a request arrives, and the desktop
 * server is not asked anything until the suite runs.
 */
const WEB_SERVERS = [
  MANAGES_SERVER
    ? {
        command: WEB_SERVER_COMMAND,
        cwd: REPO_ROOT,
        url: `${BASE_URL}/api/health`,
        /* Long enough for a cold turbo build on a CI runner with no cache. */
        timeout: 300_000,
        /* Locally, reuse whatever is already on the port. Never in CI, where an
         * adopted server is a server nobody can say what was built from. */
        reuseExistingServer: !process.env.CI,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
        env: APPLICATION_ENV
      }
    : null,

  /*
   * THE STUB BACKEND (PL-0501, round 45, correction 4). Present only when the
   * desktop axis is enabled, because nothing else talks to it. `https` with a
   * throwaway loopback certificate; see `src/tls.ts` for why the desktop
   * forwarder's https-only rule is respected rather than relaxed.
   */
  DESKTOP_ENABLED && STUB_CERTIFICATE !== null
    ? {
        command: `node src/backend-stub.mjs`,
        cwd: __dirname,
        url: `${BACKEND_STUB_ORIGIN}/__health`,
        /* Playwright's own readiness probe has to accept the self-signed
         * certificate; the SERVER under test still verifies it properly,
         * through `NODE_EXTRA_CA_CERTS` below, which is where it matters. */
        ignoreHTTPSErrors: true,
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
        env: {
          ...INHERITED_ENV,
          LIBERTY_E2E_BACKEND_STUB_PORT: String(BACKEND_STUB_PORT),
          LIBERTY_E2E_STUB_UPSTREAM: BASE_URL,
          LIBERTY_E2E_STUB_CERT: STUB_CERTIFICATE.certificatePath,
          LIBERTY_E2E_STUB_KEY: STUB_CERTIFICATE.privateKeyPath
        }
      }
    : null,

  /*
   * THE DESKTOP-TARGET APPLICATION SERVER. The same code, resolved against the
   * desktop rules, written to its own `distDir`, and pointed at the stub.
   */
  DESKTOP_ENABLED && STUB_CERTIFICATE !== null
    ? {
        command: DESKTOP_SERVER_COMMAND,
        cwd: REPO_ROOT,
        url: `${DESKTOP_BASE_URL}/api/health`,
        timeout: 300_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe" as const,
        stderr: "pipe" as const,
        env: {
          ...APPLICATION_ENV,
          /*
           * WHAT MAKES THIS SERVER THE DESKTOP ONE. Under `next dev` it is the
           * only thing that does; under `next build` the `build:desktop` script
           * sets it too, and setting it in both places cannot disagree because
           * it is the same value.
           */
          LIBERTY_BUILD_TARGET: "desktop",
          /*
           * The authenticated backend, as `docs/DESKTOP_PLAYBACK.md` section 8
           * requires the desktop build to have one. An absent value would make
           * every session `unavailable` / `provider_not_configured` -- an honest
           * answer, and not the one this axis exists to measure.
           */
          LIBERTY_PLAYBACK_BACKEND_ORIGIN: BACKEND_STUB_ORIGIN,
          /*
           * SO THE SERVER REALLY VERIFIES THE STUB'S CERTIFICATE. Node reads
           * this once at process start and adds the PEM to the trust store used
           * by `fetch`. The alternative -- disabling verification with
           * `NODE_TLS_REJECT_UNAUTHORIZED=0` -- would switch off the one
           * transport control the forwarder actually depends on, and the suite
           * would then pass against a backend nobody authenticated.
           */
          NODE_EXTRA_CA_CERTS: STUB_CERTIFICATE.certificatePath
        }
      }
    : null
].filter((entry): entry is NonNullable<typeof entry> => entry !== null);

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
   * Playwright would otherwise start servers the tests never talk to.
   *
   * AN ARRAY SINCE PL-0501's ROUND 45. `undefined` rather than `[]` for the
   * empty case, because Playwright treats the two the same and `undefined` is
   * what the previous version of this file said.
   */
  webServer: WEB_SERVERS.length === 0 ? undefined : WEB_SERVERS
});
