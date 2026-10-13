#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Does the PACKAGED application actually start? (PL-0768)
 *
 * WHAT WAS MISSING, AND IT IS THE REASON FOUR ROUNDS WENT THE WAY THEY DID.
 * `packaged-server-smoke.mjs` boots the packaged sidecar and fetches `/` over
 * HTTP. It proves the server serves the application's HTML. It cannot prove the
 * application STARTS, because nothing in it executes JavaScript: the Wave 132
 * failure is a TypeError thrown while a client module is being EVALUATED, which
 * a fetch cannot see at all. The installed build failed on every launch while
 * every check in CI was green.
 *
 * So this script runs the packaged artifact in a real browser and asks the one
 * question nothing else asked: did the application frame render, and did any
 * error boundary fire?
 *
 * WHAT IT DOES NOT PROVE, STATED FIRST BECAUSE THE COMMANDER'S BRIEF IS RIGHT
 * ABOUT IT. A browser-only test is NOT proof of WebView2 compatibility. This
 * runs Chromium. The installed application runs WebView2 inside the Tauri
 * shell, and the Wave 132 failure reproduces there and not here -- so a pass
 * from this script means "the packaged bundle starts under Chromium", never
 * "the MSI starts". Real WebView2 qualification needs the installed MSI on a
 * Windows machine, and the operator verification procedure is the only thing
 * that currently covers it. What this script does cover is every regression
 * that is NOT WebView2-specific, which is the majority of them, and it covers
 * them before an MSI is built rather than after one is installed.
 *
 * THREE INDEPENDENT CHANNELS, because the defect class this project keeps
 * finding is a check whose shape an absence satisfies:
 *
 *   1. THE DOM. The application frame's markers must be present AND no error
 *      boundary's headline may be. Asking only "are the markers there" would
 *      pass on a page that rendered the frame and then threw; asking only "is
 *      the headline absent" would pass on a blank page.
 *   2. pageerror. An uncaught exception reaching the window is a failure even
 *      if React caught a later one and the DOM looks fine. A module-evaluation
 *      throw surfaces here FIRST, before any boundary exists to catch it.
 *   3. THE DIAGNOSTICS ROUTE. A POST to /api/v1/diagnostics/client-failure
 *      means a boundary fired and reported. This is the same channel the
 *      operator's log carries, so a failure here is reported in the same
 *      vocabulary the operator will quote.
 *
 * A pass requires all three to be clean. Any one of them failing fails the
 * run, and the run prints the diagnostic report verbatim when it has one.
 *
 * --self-test INVERTS THE SCRIPT AND IS NOT OPTIONAL CEREMONY. It injects a
 * module-evaluation TypeError into the page and requires this script to FAIL.
 * A qualification test that cannot be shown to fail is a green light with no
 * lamp in it, and three of the last four rounds turned on exactly that.
 * ---------------------------------------------------------------------- */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const PACKAGED = join(REPO, "apps", "desktop", "sidecar");
const TOKEN_HEADER = "x-liberty-sidecar-token";
const HANDSHAKE = "liberty-sidecar-ready";
const DIAGNOSTICS_PATH = "/api/v1/diagnostics/client-failure";

/* The application frame's markers. Duplicated from the smoke test on purpose:
 * two scripts asserting the same three strings is how a change to the shell
 * fails twice instead of silently voiding one check. `app/error-boundaries.test.tsx`
 * holds the other side -- that global-error emits none of them. */
const FRAME_MARKERS = ["skip-link", 'class="shell"', 'id="main"'];
/* Every headline a boundary in this application can render. */
const BOUNDARY_HEADLINES = ["could not start this page", "Something went wrong"];

const SELF_TEST = process.argv.includes("--self-test");
/*
 * --harden-prototype REPRODUCES THE WAVE 132 OPERATOR FAILURE, and it is a
 * reproduction rather than a guess. The installed chunk's SHA-256 was confirmed
 * by the operator to be byte-identical to the local build
 * (3c90f403365d390ab6b7490fb57d5fd831fbc4450a8c4939d671a470ae2ecdd8), and with
 * `Object.freeze(Object.prototype)` evaluated before any page script this
 * packaged artifact produced a report CHARACTER-IDENTICAL to the one the
 * installed MSI wrote, all four frames included.
 *
 * It is kept because a reproduction nobody can re-run stops being evidence the
 * moment the code moves. Like --self-test it INVERTS the result: a clean pass
 * under a hardened prototype would mean this script had stopped detecting the
 * failure it was built for.
 *
 * It exercises DIFFERENT channels from --self-test, which is the useful part:
 * the measured run showed pageerror staying silent (React caught the throw)
 * while the DOM and the diagnostics route both fired. --self-test is the
 * mirror image. Between them, all three channels are demonstrated.
 */
const HARDEN_PROTOTYPE = process.argv.includes("--harden-prototype");
const INVERTED = SELF_TEST || HARDEN_PROTOTYPE;
const scratch = [];
let failures = 0;

function note(check, detail) {
  console.log(`ok    ${check}\n        ${detail}`);
}
function fail(check, detail) {
  failures += 1;
  console.log(`FAIL  ${check}\n        ${detail}`);
}

process.on("exit", () => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function requirePlaywright() {
  /*
   * RESOLVED FROM e2e/node_modules, NOT THE ROOT, and the reason is recorded in
   * e2e/playwright.config.ts: `e2e/` is deliberately outside the workspaces so
   * that a browser download never becomes a prerequisite of `npm ci` for a lane
   * that only wants to typecheck. This script is in the same position -- it
   * needs the browser, and nothing else in apps/desktop does.
   */
  const entry = join(REPO, "e2e", "node_modules", "playwright", "index.js");
  if (!existsSync(entry)) {
    console.log(
      "SKIP  the e2e browser harness is not installed\n" +
      `        ${entry} is absent. Run \`npm ci\` in e2e/ first.\n` +
      "        THIS IS A SKIP, NOT A PASS: nothing was qualified."
    );
    process.exit(2);
  }
  return createRequire(import.meta.url)(entry);
}

function relocate() {
  if (!existsSync(PACKAGED)) {
    fail("the packaged tree exists", `${PACKAGED} is absent; run package-sidecar.mjs first`);
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "liberty-startup-qualification-"));
  scratch.push(dir);
  const moved = join(dir, "sidecar");
  cpSync(PACKAGED, moved, { recursive: true });
  note("the packaged tree was relocated outside the repository", moved);
  return moved;
}

async function boot(movedSidecar) {
  const token = randomBytes(32).toString("hex");
  const writable = mkdtempSync(join(tmpdir(), "liberty-startup-qualification-data-"));
  scratch.push(writable);
  const server = join(movedSidecar, "server");
  const child = spawn(process.execPath, [join(server, "liberty-sidecar.js")], {
    cwd: server,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: "production",
      LIBERTY_SIDECAR_TOKEN: token,
      LIBERTY_SIDECAR_HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      PORT: "0",
      LIBERTY_SIDECAR_DATA_DIR: join(writable, "data"),
      LIBERTY_SIDECAR_CACHE_DIR: join(writable, "cache"),
      LIBERTY_SIDECAR_LOG_DIR: join(writable, "logs"),
      NEXT_CACHE_DIR: join(writable, "cache")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const out = [];
  const err = [];
  createInterface({ input: child.stdout }).on("line", (l) => out.push(l));
  createInterface({ input: child.stderr }).on("line", (l) => err.push(l));
  const port = await new Promise((done) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const line = out.find((l) => l.startsWith(HANDSHAKE));
      if (line) {
        clearInterval(tick);
        try { done(JSON.parse(line.slice(HANDSHAKE.length).trim()).port); }
        catch { done(null); }
      } else if (Date.now() - started > 60000) { clearInterval(tick); done(null); }
    }, 100);
    child.on("exit", () => { clearInterval(tick); done(null); });
  });
  return { child, port, token, out, err };
}

function chromiumPath() {
  /* An explicitly provided browser wins; otherwise Playwright's own resolution
   * is used. A mismatch between the harness's pinned version and an installed
   * browser build is an environment fact, and naming the override here is how
   * it stays out of the committed Playwright config. */
  return process.env.LIBERTY_QUALIFICATION_CHROMIUM ?? undefined;
}

const playwright = requirePlaywright();
const movedSidecar = relocate();
if (movedSidecar === null) {
  console.log(`\npackaged-startup-qualification: ${String(failures)} check(s) failed`);
  process.exit(1);
}

const { child, port, token, err } = await boot(movedSidecar);
if (port === null) {
  fail("the relocated sidecar starts and announces a port", `stderr tail: ${err.slice(-6).join(" | ") || "(empty)"}`);
  child.kill("SIGTERM");
  console.log(`\npackaged-startup-qualification: ${String(failures)} check(s) failed`);
  process.exit(1);
}
note("the relocated sidecar starts and announces a port", `bound ${String(port)}`);

let browser;
try {
  browser = await playwright.chromium.launch({
    executablePath: chromiumPath(),
    args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--no-default-browser-check"]
  });
} catch (error) {
  console.log(
    `SKIP  a browser could not be launched\n        ${String(error).slice(0, 300)}\n` +
    "        THIS IS A SKIP, NOT A PASS. Set LIBERTY_QUALIFICATION_CHROMIUM to a browser binary."
  );
  child.kill("SIGTERM");
  process.exit(2);
}

const context = await browser.newContext({ extraHTTPHeaders: { [TOKEN_HEADER]: token } });
const page = await context.newPage();
const pageErrors = [];
const reports = [];
page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${String(e.message).slice(0, 200)}`));
page.on("request", (r) => { if (r.url().includes(DIAGNOSTICS_PATH)) reports.push(r.postData() ?? "(no body)"); });

if (HARDEN_PROTOTYPE) {
  /* The operator's failure, exactly: a non-writable inherited `toString`, which
   * turns `obj.toString = fn` on a FRESH object literal into a TypeError in
   * strict mode. Zod's errorUtil does precisely that at module-evaluation time
   * in chunk 2ic50n3d1m9j1.js, column 8511. */
  await page.addInitScript(() => {
    Object.freeze(Object.prototype);
  });
}

if (SELF_TEST) {
  /* A module-evaluation TypeError, injected before any page script runs --
   * the same shape as the failure this script exists to catch. */
  await page.addInitScript(() => {
    const realDefine = Object.defineProperty;
    Object.defineProperty = function (target, key, descriptor) {
      if (key === "__liberty_self_test__") throw new TypeError("Cannot set properties of undefined (setting 'selfTest')");
      return realDefine(target, key, descriptor);
    };
    Object.defineProperty(undefined, "__liberty_self_test__", {});
  });
}

let status = null;
try {
  const response = await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: "load", timeout: 30000 });
  status = response?.status() ?? null;
} catch (error) {
  status = `navigation failed: ${String(error).slice(0, 160)}`;
}
/* Long enough for hydration and for a boundary's reporting effect to run. A
 * shorter wait would let a late failure pass as a clean start. */
await page.waitForTimeout(2500);
const body = await page.content();

if (status === 200) note("the packaged homepage answers 200", `${String(body.length)} bytes`);
else fail("the packaged homepage answers 200", `got ${String(status)}`);

const missing = FRAME_MARKERS.filter((marker) => !body.includes(marker));
if (missing.length === 0) note("the application frame rendered", `carries ${FRAME_MARKERS.join(", ")}`);
else fail("the application frame rendered", `missing ${missing.join(", ")}`);

const headline = BOUNDARY_HEADLINES.find((h) => body.includes(h));
if (headline === undefined) note("no error boundary is on screen", `none of: ${BOUNDARY_HEADLINES.join(" / ")}`);
else fail("no error boundary is on screen", `the page carries "${headline}"`);

const h1 = await page.locator("h1").count();
if (h1 === 1) note("the home page rendered exactly one h1", "which every hero branch produces");
else fail("the home page rendered exactly one h1", `found ${String(h1)}`);

if (pageErrors.length === 0) note("no uncaught exception reached the window", "pageerror never fired");
else fail("no uncaught exception reached the window", pageErrors.join(" | "));

if (reports.length === 0) note("no client failure was reported", `no POST to ${DIAGNOSTICS_PATH}`);
else fail("no client failure was reported", `${String(reports.length)} report(s): ${reports.join(" ; ")}`);

await context.close();
await browser.close();
child.kill("SIGTERM");

const clean = failures === 0;
console.log(
  `\npackaged-startup-qualification: ${clean ? "all checks passed" : `${String(failures)} check(s) failed`}`
);
console.log(
  "NOT PROVEN BY THIS RUN: WebView2 compatibility. This ran Chromium; the\n" +
  "installed application runs WebView2 in the Tauri shell, where the Wave 132\n" +
  "failure reproduces and this script's environment does not."
);

if (INVERTED) {
  /* Inverted: a pass here means this script cannot detect the failure it exists
   * for, which is worse than a red build. */
  const mode = HARDEN_PROTOTYPE ? "HARDENED-PROTOTYPE REPRODUCTION" : "SELF-TEST";
  if (clean) {
    console.log(`\n${mode} FAILED: the failure was injected and every check still passed.`);
    process.exit(1);
  }
  console.log(`\n${mode} PASSED: the injected failure was detected.`);
  process.exit(0);
}
process.exit(clean ? 0 : 1);
