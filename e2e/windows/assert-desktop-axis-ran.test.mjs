/* -------------------------------------------------------------------------
 * The check that stops a Windows desktop run passing by skipping (PW-0602).
 *
 * WHY THESE EXIST AT ALL. The thing being tested is a guard that can only do
 * its job on a Windows runner, after a full Playwright run, on a machine this
 * session cannot reach. If its judgement were only exercised there, the first
 * time anybody learned it was wrong would be a red build nobody could
 * reproduce -- or, far worse, a green one. The judgement is ordinary code over
 * an ordinary object, so it is tested here, on any machine.
 *
 * `node --test e2e/windows/assert-desktop-axis-ran.test.mjs`
 * ---------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { test } from "node:test";

import { problemWith, summarise } from "./assert-desktop-axis-ran.mjs";

/** A Playwright JSON report holding one spec file with the given test results. */
function report(files) {
  return {
    suites: Object.entries(files).map(([file, statuses]) => ({
      file,
      specs: [
        {
          tests: statuses.map((status) => ({ results: [{ status }] }))
        }
      ],
      suites: []
    }))
  };
}

const BOTH = {
  "tests/playback-session.desktop.api.spec.ts": ["passed", "passed"],
  "tests/playback-session.cross-target.api.spec.ts": ["passed"]
};

test("a run where both desktop specs executed is fine", () => {
  assert.equal(problemWith(report(BOTH)), null);
});

test("A RUN WHERE EVERY DESKTOP CASE SKIPPED IS A FAILURE", () => {
  /*
   * The whole point. Playwright exits 0 for this run, so without this check a
   * Windows job would be green having proven nothing about the desktop
   * target.
   */
  const problem = problemWith(
    report({
      "tests/playback-session.desktop.api.spec.ts": ["skipped", "skipped"],
      "tests/playback-session.cross-target.api.spec.ts": ["skipped"]
    })
  );
  assert.ok(problem !== null, "an all-skipped desktop axis was accepted");
  assert.match(problem, /did not run on this Windows runner/);
});

test("names openssl, because that is the cause and the message is the remedy", () => {
  const problem = problemWith(
    report({ "tests/playback-session.desktop.api.spec.ts": ["skipped"] })
  );
  assert.ok(problem !== null);
  assert.match(problem, /openssl/);
  /* And it says what NOT to do, because the easy fix is the forbidden one. */
  assert.match(problem, /do not relax the origin check/);
});

test("ONE SPEC RUNNING DOES NOT EXCUSE THE OTHER", () => {
  /*
   * `cross-target` is the comparison between the two build targets -- the
   * case that fails if the desktop target answers differently from the web
   * one. A rule satisfied by "some desktop file ran" would let the axis that
   * matters most disappear quietly.
   */
  const problem = problemWith(
    report({
      "tests/playback-session.desktop.api.spec.ts": ["passed"],
      "tests/playback-session.cross-target.api.spec.ts": ["skipped"]
    })
  );
  assert.ok(problem !== null, "a skipped cross-target spec was accepted");
  assert.match(problem, /cross-target/);
});

test("a report that mentions neither spec is a failure, not a pass", () => {
  /* An empty report is the shape produced by a run that died before it
   * started, and "nothing to check" must never read as "nothing wrong". */
  assert.ok(problemWith({ suites: [] }) !== null);
  assert.ok(problemWith(report({ "tests/search.spec.ts": ["passed"] })) !== null);
});

test("finds the specs inside nested suites, which is how Playwright nests them", () => {
  const nested = {
    suites: [
      {
        file: "",
        specs: [],
        suites: [
          {
            file: "tests/playback-session.desktop.api.spec.ts",
            specs: [{ tests: [{ results: [{ status: "passed" }] }] }],
            suites: []
          },
          {
            file: "tests/playback-session.cross-target.api.spec.ts",
            specs: [{ tests: [{ results: [{ status: "passed" }] }] }],
            suites: []
          }
        ]
      }
    ]
  };
  assert.equal(problemWith(nested), null);
});

test("a failing desktop case still COUNTS AS HAVING RUN", () => {
  /*
   * This check answers one question -- did the axis execute -- and
   * deliberately not whether it passed. Playwright's exit code already says
   * that, and a second opinion derived from the same report is a place for
   * the two to disagree. A failed case is the axis working.
   */
  assert.equal(
    problemWith(
      report({
        "tests/playback-session.desktop.api.spec.ts": ["failed"],
        "tests/playback-session.cross-target.api.spec.ts": ["passed"]
      })
    ),
    null
  );
});

test("counts what it saw, so the message is diagnosable", () => {
  const counts = summarise(
    report({
      "tests/playback-session.desktop.api.spec.ts": ["passed", "skipped", "failed"],
      "tests/playback-session.cross-target.api.spec.ts": ["skipped"]
    })
  );
  assert.deepEqual(counts.get("playback-session.desktop.api.spec.ts"), { ran: 2, skipped: 1 });
  assert.deepEqual(counts.get("playback-session.cross-target.api.spec.ts"), {
    ran: 0,
    skipped: 1
  });
});

test("A SKIPPED AXIS AND AN UNSELECTED FILE GET DIFFERENT DIAGNOSES", () => {
  /*
   * This script gave the wrong advice while it was being written: run against
   * a report produced by a narrowed invocation, it blamed openssl for a file
   * the command had simply not selected. Sending somebody to install a
   * dependency they already have is a confident wrong answer, which is worse
   * than no answer.
   */
  const skippedAway = problemWith(
    report({
      "tests/playback-session.desktop.api.spec.ts": ["skipped"],
      "tests/playback-session.cross-target.api.spec.ts": ["skipped"]
    })
  );
  assert.match(skippedAway, /RAN AND SKIPPED EVERY CASE/);
  assert.match(skippedAway, /openssl/);
  assert.doesNotMatch(skippedAway, /never selected the file/);

  const notSelected = problemWith(
    report({ "tests/playback-session.desktop.api.spec.ts": ["passed"] })
  );
  assert.match(notSelected, /CONTRIBUTED NO CASES AT ALL/);
  assert.match(notSelected, /never selected the file/);
  assert.doesNotMatch(notSelected, /openssl/);
});

test("and says BOTH when both happened, rather than picking one", () => {
  const problem = problemWith(
    report({ "tests/playback-session.desktop.api.spec.ts": ["skipped"] })
  );
  assert.match(problem, /openssl/);
  assert.match(problem, /never selected the file/);
});
