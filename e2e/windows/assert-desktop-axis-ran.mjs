#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * The Windows desktop-target run is not allowed to pass by skipping (PW-0602)
 *
 * ==========================================================================
 * THE FAILURE THIS EXISTS TO CATCH
 * ==========================================================================
 *
 * PW-0602's acceptance says the e2e suite must run against the DESKTOP target
 * on Windows, and names why it does not today: "the desktop axis is currently
 * built on Ubuntu only, and only incidentally, because the axis defaults on
 * and openssl happens to be installed."
 *
 * That sentence is also the hazard. `e2e/src/env.ts` turns the desktop axis
 * off -- with a reason, correctly -- when it cannot mint a loopback
 * certificate, and the specs then SKIP. A Playwright run in which every
 * desktop case skipped exits 0. So a Windows job that merely invoked the suite
 * would go green while proving nothing about the desktop target, which is the
 * precise shape of the defect this repository has already been bitten by
 * twice: a gate that never fired.
 *
 * This reads the run's own JSON report and fails when the desktop axis did not
 * actually execute. It is the difference between "the suite ran on Windows"
 * and "the desktop target was exercised on Windows", and only the second is
 * what the task is accountable for.
 *
 * ==========================================================================
 * WHY A SCRIPT AND NOT A GREP IN THE WORKFLOW
 * ==========================================================================
 *
 * Because it has to be testable. A PowerShell condition inside a YAML `run:`
 * block can only be exercised by pushing a commit to a Windows runner, which
 * is the slowest feedback loop this repository has. This is ordinary Node over
 * an ordinary file, so its judgement can be checked anywhere -- including on
 * the Linux container that wrote it, which cannot run the suite it judges.
 *
 * ==========================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ==========================================================================
 *
 * It does not decide whether the suite PASSED. Playwright's exit code already
 * says that and the workflow already reads it; a second opinion derived from
 * the same report would be a place for the two to disagree. This answers one
 * question the exit code cannot: did the desktop cases run at all.
 * ---------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The spec files that ARE the desktop axis.
 *
 * NAMED RATHER THAN PATTERN-MATCHED ON "desktop", and the second file is why.
 * `playback-session.cross-target.api.spec.ts` carries no "desktop" in its
 * name and is the comparison between the two build targets -- the case that
 * fails if the desktop target answers differently from the web one, which is
 * the whole reason the axis exists. A substring rule would have silently
 * dropped it.
 */
const DESKTOP_SPECS = [
  "playback-session.desktop.api.spec.ts",
  "playback-session.cross-target.api.spec.ts"
];

/** Walk Playwright's nested suite tree and yield every spec's results. */
function* walk(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) yield { file: suite.file ?? spec.file ?? "", spec };
    yield* walk(suite.suites);
  }
}

/**
 * What the report says happened to the desktop axis.
 *
 * Exported so the judgement can be unit-tested over a literal report rather
 * than only by running a browser suite on a Windows machine.
 */
export function summarise(report) {
  const counts = new Map(DESKTOP_SPECS.map((file) => [file, { ran: 0, skipped: 0 }]));
  for (const { file, spec } of walk(report.suites)) {
    const match = DESKTOP_SPECS.find((candidate) => file.endsWith(candidate));
    if (match === undefined) continue;
    const entry = counts.get(match);
    if (entry === undefined) continue;
    for (const test of spec.tests ?? []) {
      /* Playwright reports a skipped test with status "skipped" on its
       * results and, for a `test.skip()` taken at run time, an "expected"
       * outcome with a skipped result. Counting the RESULTS rather than the
       * outcome is what tells the two apart. */
      const skipped = (test.results ?? []).every((result) => result.status === "skipped");
      if (skipped) entry.skipped += 1;
      else entry.ran += 1;
    }
  }
  return counts;
}

/** The whole decision, as a message or `null` for "this is fine". */
export function problemWith(report) {
  const counts = summarise(report);
  const silent = [...counts.entries()].filter(([, entry]) => entry.ran === 0);
  if (silent.length === 0) return null;
  const detail = [...counts.entries()]
    .map(([file, entry]) => `  ${file}: ${String(entry.ran)} ran, ${String(entry.skipped)} skipped`)
    .join("\n");

  /*
   * TWO DIFFERENT FAULTS, AND THE MESSAGE MUST NOT GUESS THE WRONG ONE.
   *
   * A file whose cases all SKIPPED was selected and run, and the axis was
   * switched off underneath it -- almost always a missing openssl. A file
   * that contributed NO tests at all, not even skipped ones, was never
   * selected: a `--grep`, a narrowed path argument, or a rename. Sending
   * somebody to install openssl when they had actually narrowed the test
   * selection is the kind of wrong-but-confident diagnosis that wastes an
   * afternoon, and this script found itself giving exactly that advice while
   * being written.
   */
  const notSelected = silent.filter(([, entry]) => entry.skipped === 0).map(([file]) => file);
  const skippedAway = silent.filter(([, entry]) => entry.skipped > 0).map(([file]) => file);

  const causes = [];
  if (skippedAway.length > 0) {
    causes.push(
      `${skippedAway.join(", ")} RAN AND SKIPPED EVERY CASE. The usual cause is that ` +
        "`openssl` was not resolvable on PATH, so `e2e/src/tls.ts` could not mint the " +
        "loopback certificate the stub backend serves and `DESKTOP_SKIP_REASON` turned the " +
        "axis off. The desktop forwarder accepts an https origin only and deliberately does " +
        "not carve out loopback (docs/DESKTOP_PLAYBACK.md section 8), so there is no " +
        "plaintext fallback that would not be a weakened security property. Make openssl " +
        "available; do not relax the origin check."
    );
  }
  if (notSelected.length > 0) {
    causes.push(
      `${notSelected.join(", ")} CONTRIBUTED NO CASES AT ALL, not even skipped ones, so the ` +
        "run never selected the file. Check the project filter, any --grep or path argument " +
        "on the Playwright invocation, and whether the file was renamed -- this script names " +
        "the desktop specs explicitly rather than matching on a substring."
    );
  }

  return (
    "The desktop axis did not run on this Windows runner.\n" +
    detail +
    "\n\nA Playwright run in which every desktop case skipped exits 0, so this job would " +
    "otherwise be green while proving nothing about the desktop target -- which is exactly " +
    "what PW-0602 exists to stop.\n\n" +
    causes.join("\n\n")
  );
}

function main() {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("usage: assert-desktop-axis-ran.mjs <playwright-report.json>");
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    /* A missing or malformed report is a FAILURE, not a pass. It means the run
     * did not get far enough to produce one, and treating that as "nothing to
     * check" is how this script would quietly stop checking. */
    console.error(`could not read the Playwright JSON report at ${path}: ${String(error)}`);
    process.exit(2);
  }

  const problem = problemWith(report);
  if (problem === null) {
    const counts = summarise(report);
    for (const [file, entry] of counts) {
      console.log(`desktop axis: ${file} ran ${String(entry.ran)} case(s)`);
    }
    return;
  }
  console.error(problem);
  process.exit(1);
}

/*
 * Only when invoked directly, so the functions above can be imported by a test
 * without the process exiting underneath it.
 *
 * Compared as RESOLVED PATHS rather than by string suffix, because this script
 * is written to run on Windows: `process.argv[1]` arrives with backslashes and
 * `import.meta.url` is a file: URL with forward ones, and a suffix comparison
 * between the two is false on exactly the platform the script exists for.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main();
}
