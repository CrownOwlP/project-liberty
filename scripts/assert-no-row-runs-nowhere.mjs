#!/usr/bin/env node
/* -------------------------------------------------------------------------
 * Rows that run in no configuration at all (PL-0728)
 *
 * ==========================================================================
 * THIS REPOSITORY HAS FOUND THE SAME DEFECT FOUR TIMES, EACH TIME BY ACCIDENT
 * ==========================================================================
 *
 * A thing exists, it passes, and no gate asks it:
 *
 *   - `scripts/test-validate-repo.mjs`, until PL-AI-0002;
 *   - `scripts/test-desktop-target.mjs` and the thirty-case Windows lifecycle
 *     suite, until PL-0714;
 *   - `apps/web/src/components/player/tracks.ts`, until PW-0306;
 *   - three e2e titles asserting the FAIL-CLOSED behaviour of a deployment
 *     with no identity system, until PL-0717.
 *
 * The fourth was found by running two suites to completion and intersecting
 * their skip lists BY HAND. That worked, and it worked because somebody
 * thought of doing it. This script is that intersection, computed every time
 * the e2e job runs, so the fifth one does not depend on anybody thinking of
 * it again.
 *
 * ==========================================================================
 * WHAT IT ASSERTS, PRECISELY
 * ==========================================================================
 *
 * Given the Playwright JSON reports from two or more configurations, a row
 * that is SKIPPED IN EVERY REPORT IT APPEARS IN has no configuration in which
 * it executes. It is green in all of them, it is counted in none of them, and
 * nothing in the pipeline distinguishes it from a row that passed.
 *
 * Such a row is either a DECISION or a DEFECT, and the difference is whether
 * somebody wrote it down. `ALLOWED_TO_RUN_NOWHERE` below is where it is
 * written down. A row that drifts into running nowhere is a defect and this
 * exits non-zero; a row that must run nowhere is listed, with its reason, and
 * this says so out loud.
 *
 * IT FAILS THE BUILD RATHER THAN WARNING. A warning inside a passing pipeline
 * is precisely how all four originals survived every gate this repository
 * runs -- `scripts/validate-workspace-deps.mjs` says exactly that about
 * itself, and is right.
 *
 * ==========================================================================
 * WHAT IT DOES NOT DECIDE
 * ==========================================================================
 *
 * Whether a row it names SHOULD be covered. That is the owning task's
 * judgement. This reports and refuses; it proposes no remedy, and in
 * particular it never suggests deleting the row, which is the same row
 * running nowhere with the evidence removed.
 *
 * USAGE
 *   node scripts/assert-no-row-runs-nowhere.mjs <report.json> <report.json> [...]
 *
 * Each argument is a Playwright JSON report (`PLAYWRIGHT_JSON_OUTPUT_NAME`)
 * for ONE configuration, covering the WHOLE suite. Reports for a subset of
 * projects are not usable: a row absent from every report is invisible here,
 * and the allowlist check below would then go stale against a partial view.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";

/**
 * Rows that legitimately execute in no configuration this repository runs.
 *
 * EVERY ENTRY IS A CLAIM THAT NO RUNNER CAN EVER SATISFY IT, not that it is
 * inconvenient. Both of today's need a media rig: a real origin serving real
 * streams, which no GitHub runner has and which the commander's matrix
 * (`docs/WINDOWS_CERTIFICATION.md`) owns instead.
 *
 * AN ENTRY THAT MATCHES NOTHING IS AN ERROR, and that is deliberate rather
 * than strict. Round 111 found PL-0714's `mirror-check` to be one-directional
 * -- it noticed a suite with no step and never a step with no suite -- so the
 * mechanism built to end a hand-kept list only watched half of it. An
 * allowlist that outlives the row it excuses is the same shape of mistake:
 * the next row to land on that title inherits an exemption nobody granted it.
 */
const ALLOWED_TO_RUN_NOWHERE = [
  {
    file: "media-rig.spec.ts",
    title: "playback against a configured media rig > the rig is the origin the harness was told about",
    project: "chromium",
    why: "Needs a configured media rig -- a real origin serving a real stream. No CI runner has one; this is the commander's, as matrix row B1."
  },
  {
    file: "media-rig.spec.ts",
    title:
      "playback against a configured media rig > the player reaches a playing state and the trail says which candidate",
    project: "chromium",
    why: "Same rig. Reaching a playing state requires something to play, and a production deployment publishes nothing until an operator rights register exists (PL-0302, LAST_MILE 3 and 4)."
  }
];

function fail(message) {
  console.error(`runs-nowhere: ${message}`);
  process.exit(1);
}

/** `file :: full title path :: project`, which is what identifies one row. */
function keyOf(row) {
  return `${row.file} :: ${row.title} :: ${row.project}`;
}

/**
 * Every (file, title, project) in one report, with the status Playwright gave
 * it.
 *
 * READ FROM `test.status`, NOT from `results[].status`. A skipped row has one
 * result whose status is also "skipped", so the two agree today -- but
 * `results` is the per-attempt record and `status` is the verdict over all
 * attempts, and conflating them is how a retried row would be read wrongly if
 * `retries` ever stopped being 0.
 */
function rowsOf(report, label) {
  const rows = new Map();
  const walk = (suite, titles) => {
    const path = [...titles, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        /* `path.slice(1)` drops the file-level suite title, which is the file
         * name and is already carried separately. */
        const title = [...path.slice(1), spec.title].join(" > ");
        rows.set(keyOf({ file: spec.file, title, project: test.projectName }), test.status);
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  if (rows.size === 0) {
    fail(
      `${label} contains no tests at all. A configuration that executed nothing cannot ` +
        `contribute to an intersection, and tolerating it here would let a broken ` +
        `configuration silently widen what counts as "runs somewhere".`
    );
  }
  return rows;
}

function load(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`${path} could not be read: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

const paths = process.argv.slice(2);
if (paths.length < 2) {
  fail(
    `two or more reports are required; got ${paths.length}. An "intersection" over one ` +
      `configuration is just that configuration's skip list, which is a normal and ` +
      `expected thing for a report to contain -- refusing here rather than computing it ` +
      `is what keeps a passing exit code meaningful.\n` +
      `  usage: node scripts/assert-no-row-runs-nowhere.mjs <report.json> <report.json> [...]`
  );
}

const reports = paths.map((path) => ({ path, rows: rowsOf(load(path), path) }));

const everyRow = new Set(reports.flatMap((report) => [...report.rows.keys()]));
const ranNowhere = [...everyRow].filter((key) =>
  /* Skipped everywhere it appears. A row absent from a report says nothing
   * about that configuration -- only a report that contains it can. */
  reports.every((report) => !report.rows.has(key) || report.rows.get(key) === "skipped")
);

const allowed = new Map(ALLOWED_TO_RUN_NOWHERE.map((entry) => [keyOf(entry), entry]));
const unlisted = ranNowhere.filter((key) => !allowed.has(key));
const excused = ranNowhere.filter((key) => allowed.has(key));
const stale = [...allowed.keys()].filter((key) => !ranNowhere.includes(key));

console.log(
  `runs-nowhere: ${everyRow.size} row(s) across ${reports.length} configuration(s): ` +
    reports.map((r) => `${r.path} (${r.rows.size})`).join(", ")
);
for (const key of excused) {
  console.log(`runs-nowhere: allowed to run nowhere -- ${key}`);
  console.log(`              ${allowed.get(key).why}`);
}

if (stale.length > 0) {
  console.error("");
  console.error("runs-nowhere: these allowlist entries matched no row that runs nowhere:");
  for (const key of stale) console.error(`  ${key}`);
  console.error("");
  console.error("Either the row now runs somewhere -- in which case delete the entry, because an");
  console.error("exemption that outlives its reason is inherited by whatever lands on that title");
  console.error("next -- or it was renamed, moved, or deleted, in which case the entry is a");
  console.error("description of a row that no longer exists. Both are edits to this script, not");
  console.error("to the suite.");
  process.exit(1);
}

if (unlisted.length > 0) {
  console.error("");
  console.error("runs-nowhere: these rows are SKIPPED IN EVERY CONFIGURATION, so nothing executes them:");
  for (const key of unlisted) console.error(`  ${key}`);
  console.error("");
  console.error("Each one is green in every report and counted in none of them. Decide which it is:");
  console.error("  - it should run somewhere  -> make a configuration run it; that is the usual answer");
  console.error("  - it can never run here    -> add it to ALLOWED_TO_RUN_NOWHERE with the reason");
  console.error("Do not delete the row to make this pass. That is the same row running nowhere with");
  console.error("the evidence removed, which is how the four originals survived every gate.");
  process.exit(1);
}

console.log(
  `runs-nowhere: every row executes in at least one configuration, except the ` +
    `${excused.length} listed above.`
);
