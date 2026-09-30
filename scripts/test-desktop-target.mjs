/* -------------------------------------------------------------------------
 * The regression for PW-0104: a killed desktop invocation leaves no tracked
 * file dirty.
 *
 * WHY THIS TEST STARTS A REAL DEV SERVER instead of asserting something about
 * `.gitignore`. The acceptance is explicit: "a test that only exercises normal
 * exit reproduces nothing, because normal exit already works." The defect was
 * a rewrite that survived a signal kill, so the test has to produce a real
 * rewrite and a real signal kill. Checking the ignore rule alone would pass
 * against a repository where Next had stopped writing the file at all, which
 * is the sort of green that teaches nobody anything.
 *
 * THE NON-VACUITY CHECK IS THE POINT OF THE DESIGN. Each case first writes the
 * web spelling into `apps/web/next-env.d.ts`, then waits until the dev server
 * has REWRITTEN it to name the desktop distDir, and only then kills. If the
 * rewrite never happens the case FAILS rather than passing quietly -- so the
 * test proves that the thing which used to dirty the tree still happens, and
 * that it no longer matters.
 *
 * FOUR TERMINATIONS, because the acceptance names four: SIGTERM, SIGINT and
 * SIGKILL to the child, and the parent being killed. The first three go to the
 * whole process group; the fourth kills only the wrapper, leaving the dev
 * server orphaned, which is the case where no code of ours runs at all.
 *
 * IT COMPARES AGAINST A BASELINE rather than demanding a clean checkout. A
 * developer running `npm run test:scripts` mid-change has a dirty tree, and a
 * test that failed for that reason would be turned off within a week.
 *
 * Plain node + node:assert, matching scripts/test-validate-repo.mjs: `scripts/`
 * is not a workspace, so a vitest suite here would never be executed by any
 * gate. This file is wired into `npm run test:scripts`.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const REPO = process.cwd();
/* ABSOLUTE, because one case runs with cwd `apps/web` -- which is where npm
 * puts a workspace script, and therefore the only faithful place to start a
 * dev server from. A relative path would resolve against that directory and
 * silently fail to start anything, which the non-vacuity check below catches
 * but should not have to. */
const WRAPPER = path.join(REPO, "scripts", "desktop-target.mjs");
const WITH_ROOT_ENV = path.join(REPO, "scripts", "with-root-env.mjs");
const NEXT_ENV = path.join("apps", "web", "next-env.d.ts");

/** The spelling the repository used to commit, and the one we start each case from. */
const WEB_SPELLING = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";
import "./.next/types/root-params.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Tracked files with uncommitted changes, as a sorted set of paths. */
function dirtyTracked() {
  return git("status", "--porcelain", "--untracked-files=no")
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
    .sort();
}

function freePort() {
  /* `listen` is asynchronous, so `address()` is null until it has bound.
   * Asking too early is how this returns `undefined` and the dev server then
   * takes Next's default port -- which on a busy machine is already in use. */
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------- the static preconditions */

check("next-env.d.ts is NOT tracked", () => {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", NEXT_ENV], {
    cwd: REPO,
    stdio: "ignore"
  });
  assert.notEqual(
    result.status,
    0,
    `${NEXT_ENV} is tracked again. PW-0104's fix is that git does not track a file Next rewrites ` +
      `on every build; re-tracking it restores a defect no cleanup hook can close, because a ` +
      `SIGKILLed process runs no hook.`
  );
});

check("next-env.d.ts is ignored, so it cannot be staged by a routine `git add -A`", () => {
  const result = spawnSync("git", ["check-ignore", "-q", NEXT_ENV], { cwd: REPO, stdio: "ignore" });
  assert.equal(result.status, 0, `${NEXT_ENV} is not matched by any .gitignore rule`);
});

check("the wrapper sets LIBERTY_BUILD_TARGET in the child", () => {
  const result = spawnSync(
    process.execPath,
    [WRAPPER, process.execPath, "-e", "process.stdout.write(process.env.LIBERTY_BUILD_TARGET ?? '')"],
    { cwd: REPO, encoding: "utf8" }
  );
  assert.equal(result.stdout, "desktop");
});

check("the wrapper propagates a child's exit code", () => {
  const result = spawnSync(process.execPath, [WRAPPER, process.execPath, "-e", "process.exit(7)"], {
    cwd: REPO,
    stdio: "ignore"
  });
  assert.equal(result.status, 7);
});

check("the wrapper reports a usage error rather than doing nothing", () => {
  const result = spawnSync(process.execPath, [WRAPPER], { cwd: REPO, stdio: "ignore" });
  assert.equal(result.status, 2);
});

/* ------------------------------------------- the termination cases, for real */

/**
 * Start a desktop dev server through the wrapper and wait until Next has
 * rewritten `next-env.d.ts` to name the desktop distDir.
 */
async function startUntilRewrite(port) {
  fs.writeFileSync(NEXT_ENV, WEB_SPELLING);
  const child = spawn(
    process.execPath,
    [WRAPPER, process.execPath, WITH_ROOT_ENV, "next", "dev", "-p", String(port)],
    {
      cwd: path.join(REPO, "apps", "web"),
      /* Its own process group, so a signal can reach the dev server and every
       * worker it spawned -- which is what "killed without cleanup" means. */
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }
    }
  );
  const deadline = Date.now() + 120_000;
  let rewritten = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    let current = "";
    try {
      current = fs.readFileSync(NEXT_ENV, "utf8");
    } catch {
      /* Next unlinks and rewrites; an absent file is a moment, not a state. */
    }
    if (current.includes("dist/desktop")) {
      rewritten = true;
      break;
    }
    await sleep(100);
  }
  return { child, rewritten };
}

function killGroup(child, signal) {
  /* THE GUARD IS NOT PARANOIA. `process.kill(-0, sig)` signals the CALLER'S
   * process group -- so if `spawn` failed and `pid` were 0 or undefined, this
   * helper would kill the test runner, and everything above it, instead of the
   * dev server. Seen for real in this project from a `pkill -f "next dev"`
   * whose own command line matched the pattern. */
  if (!child.pid || child.pid <= 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* Already gone. */
  }
}

async function waitForExit(child, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleep(100);
  }
}

const baseline = dirtyTracked();

const CASES = [
  ["SIGTERM to the process group", (child) => killGroup(child, "SIGTERM")],
  ["SIGINT to the process group", (child) => killGroup(child, "SIGINT")],
  ["SIGKILL to the process group — no cleanup runs at all", (child) => killGroup(child, "SIGKILL")],
  [
    "SIGKILL to the PARENT only, orphaning the dev server",
    (child) => {
      if (!child.pid || child.pid <= 1) return;
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
  ]
];

for (const [name, kill] of CASES) {
  const port = await freePort();
  let started;
  try {
    started = await startUntilRewrite(port);
  } catch (error) {
    failures.push(`${name}: could not start a desktop dev server: ${error.message}`);
    continue;
  }
  const { child, rewritten } = started;

  if (!rewritten) {
    killGroup(child, "SIGKILL");
    await waitForExit(child);
    failures.push(
      `${name}: next-env.d.ts was never rewritten to name the desktop distDir, so this case ` +
        `proved nothing. Either the dev server failed to start, or Next stopped regenerating the ` +
        `file -- in which case this test needs rewriting rather than deleting.`
    );
    continue;
  }

  kill(child);
  await waitForExit(child);
  /* Whatever the case did to the parent, the group must not outlive the test. */
  killGroup(child, "SIGKILL");
  await sleep(300);

  check(`${name}: leaves no tracked file dirty`, () => {
    assert.deepEqual(
      dirtyTracked(),
      baseline,
      `the working tree changed under a killed desktop dev server. The rewrite of ` +
        `${NEXT_ENV} did happen (this case verified it), so if that file is in the list above, ` +
        `it has been re-tracked.`
    );
  });
}

if (failures.length) {
  console.error(`desktop-target tests FAILED (${passed} passed, ${failures.length} failed):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`desktop-target tests passed (${passed} assertions).`);
