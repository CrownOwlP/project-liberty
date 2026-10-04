/* -------------------------------------------------------------------------
 * The runs-nowhere check, driven as a command (PL-0728)
 *
 * ==========================================================================
 * IT IS SPAWNED, NOT IMPORTED, AND THAT IS THE POINT
 * ==========================================================================
 *
 * The contract this script has with CI is an EXIT CODE and a named list on
 * stderr. Importing its internals would test a function the workflow never
 * calls and would say nothing about whether a red row turns the build red.
 * Every case below runs the real file the workflow runs and asserts on what
 * the workflow can see.
 *
 * ==========================================================================
 * THE ALLOWLIST IS NOT INJECTABLE, AND THESE TESTS USE THE REAL ONE
 * ==========================================================================
 *
 * A check whose exemptions can be supplied by its caller is a check that can
 * be told to pass, so `ALLOWED_TO_RUN_NOWHERE` is baked into the script and
 * there is no flag to override it. The fixtures below therefore carry the
 * REAL media-rig identities wherever an exemption is in play. That is more
 * work to write and it means these tests fail if somebody edits the allowlist
 * without reading them -- which is the correct amount of friction for the one
 * list in this repository whose whole job is to be short.
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, "assert-no-row-runs-nowhere.mjs");

/** The two rows the real allowlist excuses, as the script identifies them. */
const RIG_FILE = "media-rig.spec.ts";
const RIG_ONE = "playback against a configured media rig > the rig is the origin the harness was told about";
const RIG_TWO =
  "playback against a configured media rig > the player reaches a playing state and the trail says which candidate";

/**
 * A Playwright JSON report carrying exactly the rows described.
 *
 * SHAPED FROM A REAL REPORT, not from the documentation: a `suites` entry per
 * file whose `title` is the file name, `specs` with `tests` carrying
 * `projectName` and `status`. Verified against the output of a real run
 * before this fixture was written, because a fixture that disagrees with the
 * producer is a test of the fixture.
 */
function report(rows) {
  const byFile = new Map();
  for (const row of rows) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }
  return {
    config: { rootDir: "/nowhere" },
    errors: [],
    stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [...byFile.entries()].map(([file, inFile]) => ({
      title: file,
      file,
      specs: inFile.map((row) => ({
        title: row.title,
        ok: true,
        file,
        tests: [{ projectName: row.project, status: row.status, results: [{ status: row.status }] }]
      }))
    }))
  };
}

/** Writes the given reports to a fresh directory and returns their paths. */
function write(...reports) {
  const dir = mkdtempSync(join(tmpdir(), "runs-nowhere-"));
  return reports.map((content, index) => {
    const path = join(dir, `report-${index}.json`);
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  });
}

function run(...paths) {
  const result = spawnSync(process.execPath, [SCRIPT, ...paths], { encoding: "utf8" });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

/** The two rig rows, skipped, so the real allowlist is never stale by accident. */
const rig = (status = "skipped") => [
  { file: RIG_FILE, title: RIG_ONE, project: "chromium", status },
  { file: RIG_FILE, title: RIG_TWO, project: "chromium", status }
];

test("passes when every row executes in at least one configuration", () => {
  const a = report([...rig(), { file: "a.spec.ts", title: "t", project: "api", status: "expected" }]);
  const b = report([...rig(), { file: "a.spec.ts", title: "t", project: "api", status: "skipped" }]);
  const { code, out } = run(...write(a, b));
  assert.equal(code, 0, out);
  assert.match(out, /every row executes in at least one configuration/);
});

test("FAILS, and names the row, when one is skipped in every configuration", () => {
  const rows = [...rig(), { file: "a.spec.ts", title: "nobody runs me", project: "api", status: "skipped" }];
  const { code, err } = run(...write(report(rows), report(rows)));
  assert.equal(code, 1);
  assert.match(err, /SKIPPED IN EVERY CONFIGURATION/);
  assert.match(err, /a\.spec\.ts :: nobody runs me :: api/);
});

test("the failure does not advise deleting the row", () => {
  /*
   * THE REMEDY A TIRED PERSON REACHES FOR. Deleting the test makes this check
   * pass and leaves the product in exactly the state the check exists to
   * detect -- with the evidence gone as well. The message has to say so.
   */
  const rows = [...rig(), { file: "a.spec.ts", title: "nobody runs me", project: "api", status: "skipped" }];
  const { err } = run(...write(report(rows), report(rows)));
  assert.match(err, /Do not delete the row to make this pass/);
});

test("NON-VACUITY: it fails against the reports as they were before PL-0717", () => {
  /*
   * THE CASE THE ACCEPTANCE ASKS FOR BY NAME. Before PL-0717 this repository
   * ran two e2e configurations and had three. The three titles below assert
   * the fail-closed behaviour of a deployment with no identity system; they
   * were skipped in BOTH configurations anyone executed, so no run ever
   * exercised them, and they were found by intersecting two skip lists by
   * hand. Shown failing here, against that two-configuration shape, so this
   * check is known to catch the defect it was written for -- and not merely
   * to agree with a tree that has already been fixed.
   *
   * The identities are the real ones, verified against real reports from both
   * configurations rather than invented to match.
   */
  const failClosed = [
    {
      file: "playback-session.api.spec.ts",
      title: "a deployment with no identity system > fails closed with 503 and names the operator's remedy",
      project: "api",
      status: "skipped"
    },
    {
      file: "playback-session.api.spec.ts",
      title: "a deployment with no identity system > publishes nothing only a resolver could know",
      project: "api",
      status: "skipped"
    },
    {
      file: "watchlist.spec.ts",
      title: "a deployment with no identity system refuses honestly rather than showing an empty list",
      project: "chromium",
      status: "skipped"
    }
  ];
  const ran = { file: "catalog.api.spec.ts", title: "health responds", project: "api", status: "expected" };

  const { code, err } = run(...write(report([...rig(), ...failClosed, ran]), report([...rig(), ...failClosed, ran])));
  assert.equal(code, 1);
  for (const row of failClosed) {
    assert.ok(err.includes(`${row.file} :: ${row.title} :: ${row.project}`), `not named: ${row.title}`);
  }
  /* And the two rig rows are NOT named, because they are excused. A check
   * that reported all five would have been right about three of them and
   * would have taught everybody to read past its output. */
  assert.ok(!err.includes(RIG_ONE), "an allowlisted row was reported as a failure");
});

test("a third configuration that runs those three makes the same reports pass", () => {
  /*
   * THE OTHER HALF OF THE SAME MEASUREMENT: the check is not simply hostile to
   * those three titles. Add the configuration PL-0717 added -- the one in
   * which they execute -- and the identical pair of reports becomes clean.
   */
  const failClosed = (status) => [
    {
      file: "playback-session.api.spec.ts",
      title: "a deployment with no identity system > fails closed with 503 and names the operator's remedy",
      project: "api",
      status
    },
    {
      file: "playback-session.api.spec.ts",
      title: "a deployment with no identity system > publishes nothing only a resolver could know",
      project: "api",
      status
    },
    {
      file: "watchlist.spec.ts",
      title: "a deployment with no identity system refuses honestly rather than showing an empty list",
      project: "chromium",
      status
    }
  ];
  const { code, out } = run(
    ...write(
      report([...rig(), ...failClosed("skipped")]),
      report([...rig(), ...failClosed("skipped")]),
      report([...rig(), ...failClosed("expected")])
    )
  );
  assert.equal(code, 0, out);
});

test("an allowlist entry that matches nothing is itself a failure", () => {
  /*
   * THE ONE-DIRECTIONAL LESSON, APPLIED. PL-0714's mirror-check fails when a
   * suite has no step and never when a step has no suite; round 111 measured
   * that and recorded it. An allowlist is the same shape: an exemption that
   * outlives the row it excused is silently inherited by whatever lands on
   * that title next. Here the rig rows run, so both entries are stale.
   */
  const rows = [...rig("expected"), { file: "a.spec.ts", title: "t", project: "api", status: "expected" }];
  const { code, err } = run(...write(report(rows), report(rows)));
  assert.equal(code, 1);
  assert.match(err, /allowlist entries matched no row that runs nowhere/);
  assert.ok(err.includes(RIG_ONE) && err.includes(RIG_TWO));
});

test("a row present in only one report, and skipped there, runs nowhere", () => {
  /*
   * ABSENCE IS NOT EXECUTION. The row appears in one configuration and is
   * skipped; the other configuration does not mention it. Nothing ran it, so
   * it is reported -- treating "absent" as "fine" would let a row be hidden
   * by removing it from a configuration rather than by running it.
   */
  const a = report([...rig(), { file: "a.spec.ts", title: "only here", project: "api", status: "skipped" }]);
  const b = report([...rig(), { file: "b.spec.ts", title: "elsewhere", project: "api", status: "expected" }]);
  const { code, err } = run(...write(a, b));
  assert.equal(code, 1);
  assert.match(err, /a\.spec\.ts :: only here :: api/);
});

test("the same title in two projects is two rows", () => {
  /*
   * `--project=api --project=chromium` runs the suite twice, and a row that
   * executes under one project and is skipped under the other is NOT covered
   * for the skipped one. Identity is (file, title, project) for that reason.
   */
  const rows = [
    ...rig(),
    { file: "a.spec.ts", title: "shared", project: "api", status: "expected" },
    { file: "a.spec.ts", title: "shared", project: "chromium", status: "skipped" }
  ];
  const { code, err } = run(...write(report(rows), report(rows)));
  assert.equal(code, 1);
  assert.match(err, /a\.spec\.ts :: shared :: chromium/);
  assert.ok(!/a\.spec\.ts :: shared :: api/.test(err), "the project that ran was reported");
});

test("refuses a single report rather than computing a meaningless intersection", () => {
  const [one] = write(report(rig()));
  const { code, err } = run(one);
  assert.equal(code, 1);
  assert.match(err, /two or more reports are required/);
});

test("refuses no reports at all", () => {
  const { code, err } = run();
  assert.equal(code, 1);
  assert.match(err, /two or more reports are required/);
});

test("refuses a report it cannot parse, rather than reading it as empty", () => {
  const paths = write(report(rig()), "{ this is not json");
  const { code, err } = run(...paths);
  assert.equal(code, 1);
  assert.match(err, /is not valid JSON/);
});

test("refuses a report with no tests in it", () => {
  /*
   * A CONFIGURATION THAT EXECUTED NOTHING. Tolerating it would let a broken
   * configuration widen what counts as "runs somewhere" -- every row would be
   * absent from it, and absence is not a skip, so the intersection would be
   * computed over the remaining reports while the output claimed three
   * configurations had agreed.
   */
  const { code, err } = run(...write(report(rig()), report([])));
  assert.equal(code, 1);
  assert.match(err, /contains no tests at all/);
});

test("refuses a path that does not exist", () => {
  const [one] = write(report(rig()));
  const { code, err } = run(one, join(dirname(one), "absent.json"));
  assert.equal(code, 1);
  assert.match(err, /could not be read: ENOENT/);
});

test("says which rows it excused, so an exemption is visible in the log", () => {
  /*
   * A SILENT EXEMPTION IS A HALF-KEPT RECORD. The allowlist lives in a file
   * nobody opens during a green build; printing each excused row and its
   * reason puts it where the build log is read.
   */
  const rows = [...rig(), { file: "a.spec.ts", title: "t", project: "api", status: "expected" }];
  const { code, out } = run(...write(report(rows), report(rows)));
  assert.equal(code, 0, out);
  assert.match(out, /allowed to run nowhere -- media-rig\.spec\.ts/);
  assert.match(out, /Needs a configured media rig/);
});
