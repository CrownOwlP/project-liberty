import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * Run a script and return stdout AND stderr combined.
 *
 * `run()` returns stdout only, so assertions about warnings -- which belong on
 * stderr -- would silently never match.
 */
function runCombined(cwd, script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const source = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-control-plane-"));
const CLI = "scripts/ai-control-plane.mjs";
let repoSeq = 0;

function run(cwd, script, args = [], env = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}
function runFail(cwd, args, matcher, env = {}) {
  let failed = false;
  let output = "";
  try {
    run(cwd, CLI, args, env);
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failed, `expected "${args.join(" ")}" to fail but it succeeded`);
  if (matcher)
    assert.match(
      output,
      matcher,
      `unexpected failure output for "${args.join(" ")}":\n${output}`,
    );
  return output;
}
/**
 * Types that cannot be published without an explicit review range.
 * Mirrors BASE_REQUIRED_TYPES in agent-bus.mjs.
 */
const BASE_REQUIRED = [
  "implementation_ready",
  "review_request",
  "review_approved",
  "changes_requested",
];

/**
 * A range base for scenarios that are not about the range contract.
 *
 * Distinct from every --sha value used in this suite, so it can never collapse
 * into an empty range. Scenarios that DO test the range contract (9m, 9n, 9o,
 * 9p) pass --base explicitly and are unaffected by this default.
 */
const DEFAULT_TEST_BASE = "0".repeat(39) + "1";

/** Publish a handoff message and return its id, parsed from CLI output. */
function publish(repo, args, env = {}) {
  const typeIndex = args.indexOf("--type");
  const type = typeIndex >= 0 ? args[typeIndex + 1] : null;
  const withBase =
    BASE_REQUIRED.includes(type) && !args.includes("--base")
      ? [...args, "--base", DEFAULT_TEST_BASE]
      : args;

  const out = run(repo, CLI, ["handoff", ...withBase], env);
  const match = out.match(/Published (MSG-\S+)/);
  assert.ok(match, `could not parse message id from:\n${out}`);
  return match[1];
}
function busFile(repo, ...parts) {
  return path.join(repo, "coordination", "agent-bus", ...parts);
}
/**
 * Reset the *copied* control/tasks.json to a clean runtime state.
 *
 * Task definitions and routing (id, lane, priority, dependencies, allowedPaths,
 * preferredAgent, reviewAgent, qualityGates, acceptance) are preserved exactly
 * as authored. Only runtime state is cleared, so scenarios never depend on how
 * far the real project has progressed.
 *
 * This only ever touches the temp copy; the live control/tasks.json is not read
 * for mutation and never written.
 */
function resetRuntimeState(repo) {
  const file = path.join(repo, "control", "tasks.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const task of doc.tasks) {
    task.owner = null;
    task.gateResults = {};
    delete task.implementationAgent;
    delete task.updatedAt;
    delete task.completedAt;
    delete task.review;
    delete task.reviewHistory;

    // Externally BLOCKED tasks are a definition, not runtime drift: a blocked
    // task carries an explicit blocker reason and must stay blocked.
    if (task.status === "BLOCKED" || task.status === "CANCELED") continue;

    task.status = (task.dependencies ?? []).length === 0 ? "READY" : "BACKLOG";
  }

  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

function freshRepo() {
  const repo = path.join(temp, `repo-${++repoSeq}`);
  fs.cpSync(source, repo, {
    recursive: true,
    // Both an `includes` and an `endsWith` check per directory: without the
    // `endsWith`, cpSync recurses into the directory itself and walks the whole
    // subtree before filtering each entry.
    filter: (src) =>
      !src.includes(`${path.sep}.git${path.sep}`) &&
      !src.endsWith(`${path.sep}.git`) &&
      !src.includes(`${path.sep}node_modules${path.sep}`) &&
      !src.endsWith(`${path.sep}node_modules`),
  });
  resetRuntimeState(repo);
  resetBusState(repo);
  resetEventLog(repo);
  return repo;
}

/**
 * Truncate the copied audit log.
 *
 * `control/events.jsonl` is append-only runtime history, so a copy inherits
 * every real event the project has ever recorded -- including genuine
 * `task.review_recorded` entries from completed work. Scenarios that assert on
 * event COUNTS would then be measuring project history rather than the
 * behaviour under test.
 */
function resetEventLog(repo) {
  fs.writeFileSync(path.join(repo, "control", "events.jsonl"), "");
}

/**
 * Clear inherited handoff traffic from the copy.
 *
 * Without this, every scenario would inherit whatever real messages happen to be
 * committed at the time -- which is guaranteed to happen once the bus is in
 * actual use -- and inbox/process assertions would start failing for reasons
 * that have nothing to do with the code under test.
 */
function resetBusState(repo) {
  for (const lane of [
    "gpt-to-claude",
    "claude-to-gpt",
    "acknowledgements",
    "rejections",
    "journal",
  ]) {
    const dir = path.join(repo, "coordination", "agent-bus", lane);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".json")) fs.rmSync(path.join(dir, name));
    }
  }
}

function journalOf(repo, messageId) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "journal",
    `${messageId}.json`,
  );
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function ackOf(repo, messageId) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "acknowledgements",
    `${messageId}.json`,
  );
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function rejectionOf(repo, messageId) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "rejections",
    `${messageId}.json`,
  );
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
/** Copy a repo to simulate a second checkout observing shared bus state. */
function cloneRepo(repo) {
  const clone = path.join(temp, `clone-${++repoSeq}`);
  fs.cpSync(repo, clone, { recursive: true });
  // The journal is local-only state; a real clone would not carry it.
  const journal = path.join(clone, "coordination", "agent-bus", "journal");
  if (fs.existsSync(journal)) {
    for (const name of fs.readdirSync(journal)) {
      if (name.endsWith(".json")) fs.rmSync(path.join(journal, name));
    }
  }
  return clone;
}
function eventsOf(repo) {
  return fs
    .readFileSync(path.join(repo, "control", "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
/** Simulate a crash by writing a journal state directly, as a killed run would leave it. */
function simulateCrash(repo, messageId, state, extra = {}) {
  const file = path.join(
    repo,
    "coordination",
    "agent-bus",
    "journal",
    `${messageId}.json`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { messageId, state, claimedBy: "claude-lead", ...extra },
      null,
      2,
    ) + "\n",
  );
}
function tasksOf(repo) {
  return JSON.parse(
    fs.readFileSync(path.join(repo, "control", "tasks.json"), "utf8"),
  ).tasks;
}
function taskOf(repo, id) {
  return tasksOf(repo).find((t) => t.id === id);
}
/** Drive PL-AI-0001 from READY through its implementation gates. */
function implementToInProgress(repo) {
  const implementer = "claude-lead";
  run(repo, CLI, ["claim", "PL-AI-0001", implementer]);
  run(repo, CLI, ["start", "PL-AI-0001", implementer]);
  run(repo, CLI, [
    "gate",
    "PL-AI-0001",
    "repo-validate",
    "pass",
    "automated smoke",
  ]);
  run(repo, CLI, [
    "gate",
    "PL-AI-0001",
    "architecture-review",
    "pass",
    "automated smoke",
  ]);
}
/** Drive PL-AI-0001 from READY up to (but not including) DONE. */
function implementToReview(repo) {
  implementToInProgress(repo);
  run(repo, CLI, ["review", "PL-AI-0001"]);
}

const liveTasksPath = path.join(source, "control", "tasks.json");
const liveTasksBefore = fs.readFileSync(liveTasksPath, "utf8");

/**
 * Hash every file the control plane can write, so a scenario that forgets
 * freshRepo() and runs against the real repository fails loudly instead of
 * silently corrupting the live event log, queues, or status views.
 */
function snapshotLiveState() {
  const snapshot = new Map();
  for (const dir of ["control", "coordination"]) {
    const abs = path.join(source, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [dir];
    while (stack.length) {
      const rel = stack.pop();
      for (const entry of fs.readdirSync(path.join(source, rel), {
        withFileTypes: true,
      })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) stack.push(childRel);
        else if (entry.isFile()) {
          snapshot.set(
            childRel,
            createHash("sha256")
              .update(fs.readFileSync(path.join(source, childRel)))
              .digest("hex"),
          );
        }
      }
    }
  }
  return snapshot;
}
const liveStateBefore = snapshotLiveState();

try {
  /* ---------------------------------------------------------------------
   * 0. Test isolation: scenarios must not depend on live runtime state,
   *    and must never mutate the real control/tasks.json.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const tasks = tasksOf(repo);
    const live = JSON.parse(liveTasksBefore).tasks;
    const liveById = new Map(live.map((t) => [t.id, t]));

    for (const task of tasks) {
      assert.equal(
        task.owner,
        null,
        `${task.id} should have no owner in a fresh scenario`,
      );
      assert.deepEqual(
        task.gateResults,
        {},
        `${task.id} should have no gate results`,
      );
      assert.equal(
        task.review,
        undefined,
        `${task.id} should have no review record`,
      );
      assert.equal(
        task.reviewHistory,
        undefined,
        `${task.id} should have no review history`,
      );
      assert.equal(
        task.implementationAgent,
        undefined,
        `${task.id} should have no implementation agent`,
      );
      assert.equal(
        task.updatedAt,
        undefined,
        `${task.id} should have no updatedAt timestamp`,
      );
      assert.equal(
        task.completedAt,
        undefined,
        `${task.id} should have no completedAt timestamp`,
      );

      // Definitions and routing survive the reset untouched.
      const source_ = liveById.get(task.id);
      assert.equal(
        task.preferredAgent,
        source_.preferredAgent,
        `${task.id} preferredAgent must be preserved`,
      );
      assert.equal(
        task.reviewAgent,
        source_.reviewAgent,
        `${task.id} reviewAgent must be preserved`,
      );
      assert.deepEqual(
        task.dependencies,
        source_.dependencies,
        `${task.id} dependencies must be preserved`,
      );
      assert.deepEqual(
        task.allowedPaths,
        source_.allowedPaths,
        `${task.id} allowedPaths must be preserved`,
      );

      if (source_.status === "BLOCKED") {
        assert.equal(task.status, "BLOCKED", `${task.id} must stay BLOCKED`);
        assert.equal(
          task.blocker,
          source_.blocker,
          `${task.id} blocker reason must be preserved`,
        );
      } else if (source_.status !== "CANCELED") {
        const expected =
          (task.dependencies ?? []).length === 0 ? "READY" : "BACKLOG";
        assert.equal(
          task.status,
          expected,
          `${task.id} should reset to ${expected}`,
        );
      }
    }

    // Isolation holds even though the live project has tasks IN_PROGRESS.
    assert.equal(taskOf(repo, "PL-AI-0001").status, "READY");
    assert.equal(taskOf(repo, "PL-0302").status, "BLOCKED");
    run(repo, CLI, ["validate"]);
  }

  /* ---------------------------------------------------------------------
   * 1. Happy path: independent approval by the designated reviewer.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    run(repo, CLI, ["validate"]);
    implementToReview(repo);

    // Gates alone must not be enough.
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);

    run(repo, CLI, [
      "approve",
      "PL-AI-0001",
      "gpt-architect",
      "architecture review recorded via shared repository",
    ]);
    run(repo, CLI, ["done", "PL-AI-0001"]);
    run(repo, CLI, ["validate"]);

    const done = taskOf(repo, "PL-AI-0001");
    assert.equal(done.status, "DONE");
    assert.equal(done.review.outcome, "APPROVED");
    assert.equal(done.review.reviewerAgent, "gpt-architect");
    assert.equal(done.review.implementationAgent, "claude-lead");
    assert.equal(done.review.reviewerProvider, "openai");
    for (const field of [
      "taskId",
      "reviewerClass",
      "reviewedCommitSha",
      "reviewedTreeHash",
      "reviewedAt",
      "evidence",
    ]) {
      assert.ok(done.review[field], `review record should carry ${field}`);
    }
    assert.equal(
      taskOf(repo, "PL-AI-0002").status,
      "READY",
      "dependent task should unlock after DONE",
    );

    const status = run(repo, CLI, ["status"]);
    assert.match(status, /M0 .*IN_PROGRESS, 1\/4 \(25%\)/);
  }

  /* ---------------------------------------------------------------------
   * 2. Self-approval must fail.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    runFail(
      repo,
      ["approve", "PL-AI-0001", "claude-lead", "looks good to me"],
      /self-approval is prohibited/,
    );
    assert.equal(
      taskOf(repo, "PL-AI-0001").review,
      undefined,
      "rejected self-approval must not be recorded",
    );
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "REVIEW");
  }

  /* ---------------------------------------------------------------------
   * 3. Automatic reviewer substitution must fail.
   *    A different Claude agent may not stand in for gpt-architect.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    runFail(
      repo,
      [
        "approve",
        "PL-AI-0001",
        "claude-security",
        "substituting for unavailable gpt lane",
      ],
      /requires independent review by gpt-architect/,
    );
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);
  }

  /* ---------------------------------------------------------------------
   * 4. Stale approval must fail: code changed after the review.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    run(repo, CLI, [
      "approve",
      "PL-AI-0001",
      "gpt-architect",
      "approved at review time",
    ]);

    const approvedHash = taskOf(repo, "PL-AI-0001").review.reviewedTreeHash;

    // Mutate a file inside the task's allowedPaths after approval.
    const touched = path.join(repo, "AGENTS.md");
    fs.appendFileSync(touched, "\n<!-- post-approval edit -->\n");

    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /stale review: implementation under allowedPaths changed after approval/,
    );
    assert.equal(
      taskOf(repo, "PL-AI-0001").status,
      "REVIEW",
      "stale review must not complete the task",
    );

    // A fresh approval against the new content restores completability.
    run(repo, CLI, [
      "approve",
      "PL-AI-0001",
      "gpt-architect",
      "re-reviewed after post-approval edit",
    ]);
    const rehash = taskOf(repo, "PL-AI-0001").review.reviewedTreeHash;
    assert.notEqual(
      rehash,
      approvedHash,
      "fingerprint must change when implementation changes",
    );
    run(repo, CLI, ["done", "PL-AI-0001"]);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "DONE");

    const history = taskOf(repo, "PL-AI-0001").reviewHistory;
    assert.equal(history.length, 2, "every review decision should be retained");
  }

  /* ---------------------------------------------------------------------
   * 5. CHANGES_REQUESTED must block DONE and return the task to IN_PROGRESS.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    run(repo, CLI, [
      "request-changes",
      "PL-AI-0001",
      "gpt-architect",
      "dispatcher still starves executable lanes",
    ]);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "IN_PROGRESS");
    assert.equal(
      taskOf(repo, "PL-AI-0001").review.outcome,
      "CHANGES_REQUESTED",
    );

    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /review outcome is CHANGES_REQUESTED/,
    );
  }

  /* ---------------------------------------------------------------------
   * 6. Gate evidence remains mandatory (no silent bypass).
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"]);
    runFail(
      repo,
      ["gate", "PL-AI-0001", "repo-validate", "pass"],
      /Gate evidence is required/,
    );
    run(repo, CLI, [
      "gate",
      "PL-AI-0001",
      "repo-validate",
      "pass",
      "npm run repo:validate exit 0",
    ]);
    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /gates not passed: architecture-review/,
    );
  }

  /* ---------------------------------------------------------------------
   * 7. Dispatch planning: an external lane must not shrink the local wave.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const out = run(repo, CLI, ["dispatch"]);

    // NOTE: {PL-0001, PL-0101, PL-0201, PL-AI-0001} and {PL-0001, PL-0201,
    // PL-0301, PL-AI-0001} are BOTH maximum 4-task waves with identical
    // priority sums. PL-0101 wins purely on betterWave()'s lexicographic
    // waveKey tie-break. If a task id or an allowedPaths entry changes, this
    // may flip to PL-0301 -- that is a tie-break change, not a dispatcher
    // regression. The invariants that actually matter are asserted below:
    // the wave is size 4, and PL-0002 is never assigned locally.
    const executableBlock = out.split("--- deferred")[0];
    const externalBlock = out.split("=== READY_BUT_EXTERNAL")[1] ?? "";

    for (const [taskId, agentId] of [
      ["PL-0001", "claude-infra"],
      ["PL-0101", "claude-frontend"],
      ["PL-0201", "claude-media"],
      ["PL-AI-0001", "claude-lead"],
    ]) {
      assert.match(
        executableBlock,
        new RegExp(`${taskId} -> ${agentId}`),
        `${taskId} should dispatch to ${agentId}`,
      );
    }

    const assignedCount = (executableBlock.match(/ -> /g) ?? []).length;
    assert.equal(
      assignedCount,
      4,
      `expected a 4-task executable wave, got ${assignedCount}:\n${out}`,
    );

    // PL-0002 stays reserved for gpt-architect and is never reassigned locally.
    assert.doesNotMatch(
      executableBlock,
      /PL-0002 ->/,
      "PL-0002 must not be dispatched to a local agent",
    );
    assert.match(externalBlock, /PL-0002 \[gpt-architect\]/);
    assert.match(externalBlock, /PL-0401 \[gpt-architect\]/);
    assert.match(externalBlock, /PL-0601 \[gpt-architect\]/);

    // Blocked lanes are reported separately, not silently dropped.
    assert.match(out, /=== BLOCKED ===/);
    assert.match(out, /PL-0302/);

    const ready = run(repo, CLI, ["ready"]);
    assert.match(ready, /READY_AND_EXECUTABLE\tPL-0001/);
    assert.match(ready, /READY_BUT_EXTERNAL\tPL-0002/);
  }

  /* ---------------------------------------------------------------------
   * 8. --apply claims exactly the planned executable wave.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    run(repo, CLI, ["dispatch", "--apply"]);
    const tasks = tasksOf(repo);
    const claimed = tasks
      .filter((t) => t.status === "CLAIMED")
      .map((t) => `${t.id}:${t.owner}`)
      .sort();
    assert.deepEqual(claimed, [
      "PL-0001:claude-infra",
      "PL-0101:claude-frontend",
      "PL-0201:claude-media",
      "PL-AI-0001:claude-lead",
    ]);
    assert.equal(
      taskOf(repo, "PL-0002").status,
      "READY",
      "external task must remain queued, not claimed",
    );
    assert.equal(taskOf(repo, "PL-0002").owner, null);
    run(repo, CLI, ["validate"]);
  }

  /* ---------------------------------------------------------------------
   * 9. Handoff bus: GPT <-> Claude with no human in the loop.
   * ------------------------------------------------------------------- */
  {
    const SHA = "a".repeat(40);
    const repo = freshRepo();
    implementToInProgress(repo);

    // --- Real Claude -> GPT review submission ---
    const requestId = publish(
      repo,
      [
        "--from",
        "claude-lead",
        "--to",
        "gpt-architect",
        "--type",
        "review_request",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "PL-AI-0001 ready for independent review",
        "--evidence",
        "required implementation gates green",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.equal(taskOf(repo, "PL-AI-0001").status, "IN_PROGRESS");

    run(repo, CLI, ["process", "gpt-architect"], { LIBERTY_COMMIT_SHA: SHA });
    const submitted = taskOf(repo, "PL-AI-0001");
    assert.equal(
      submitted.status,
      "REVIEW",
      "processing review_request must enter REVIEW",
    );
    assert.equal(ackOf(repo, requestId)?.acknowledgedBy, "gpt-architect");
    assert.equal(journalOf(repo, requestId)?.claimedBy, "gpt-architect");
    assert.equal(
      eventsOf(repo).filter((event) => event.type === "task.review_requested")
        .length,
      1,
      "the bus transition must be audited exactly once",
    );

    // --- GPT -> Claude delivery ---
    const approvalId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "control plane reviewed against pushed SHA",
        "--evidence",
        "https://github.com/CrownOwlP/project-liberty/commit/" + SHA,
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    assert.ok(
      fs.existsSync(busFile(repo, "gpt-to-claude", `${approvalId}.json`)),
      "message must land in the gpt-to-claude lane",
    );

    const inbox = run(repo, CLI, ["inbox", "claude-lead"]);
    assert.match(inbox, new RegExp(approvalId));
    assert.match(inbox, /review_approved/);
    assert.match(inbox, /status=open/);

    // --- processing applies the decision through the enforced path ---
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const reviewed = taskOf(repo, "PL-AI-0001");
    assert.equal(reviewed.review.outcome, "APPROVED");
    assert.equal(reviewed.review.reviewerAgent, "gpt-architect");
    assert.equal(reviewed.review.implementationAgent, "claude-lead");
    assert.equal(
      reviewed.review.reviewedCommitSha,
      SHA,
      "the recorded SHA must be the reviewed one, not HEAD-at-apply-time",
    );

    // --- acknowledgement is explicit and durable ---
    assert.ok(
      fs.existsSync(busFile(repo, "acknowledgements", `${approvalId}.json`)),
    );
    const ack = JSON.parse(
      fs.readFileSync(
        busFile(repo, "acknowledgements", `${approvalId}.json`),
        "utf8",
      ),
    );
    assert.equal(ack.acknowledgedBy, "claude-lead");
    assert.equal(ack.outcome, "processed");

    // --- duplicate processing prevention ---
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
    assert.match(
      run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA }),
      /No unacknowledged messages/,
    );
    runFail(repo, ["ack", approvalId], /already acknowledged/);
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      1,
      "re-processing must not duplicate the review",
    );

    // The bus-delivered approval satisfies the real completion rules.
    run(repo, CLI, ["done", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });
    assert.equal(taskOf(repo, "PL-AI-0001").status, "DONE");

    // --- Claude -> GPT review request ---
    const catalogRequestId = publish(
      repo,
      [
        "--from",
        "claude-lead",
        "--to",
        "gpt-architect",
        "--type",
        "review_request",
        "--task",
        "PL-0101",
        "--sha",
        SHA,
        "--summary",
        "PL-0101 catalog contract ready for review",
        "--evidence",
        "npm run check green",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.ok(
      fs.existsSync(busFile(repo, "claude-to-gpt", `${catalogRequestId}.json`)),
      "outbound message must land in the claude-to-gpt lane",
    );
    assert.match(run(repo, CLI, ["inbox", "gpt-architect"]), /review_request/);

    // --- wrong recipient rejection ---
    assert.doesNotMatch(
      run(repo, CLI, ["inbox", "claude-lead"]),
      new RegExp(catalogRequestId),
    );
    runFail(
      repo,
      ["ack", catalogRequestId, "--agent", "claude-lead"],
      /addressed to gpt-architect, not claude-lead/,
    );

    // --- missing SHA on a review request ---
    runFail(
      repo,
      [
        "handoff",
        "--from",
        "claude-lead",
        "--to",
        "gpt-architect",
        "--type",
        "review_request",
        "--task",
        "PL-0101",
        "--summary",
        "no sha",
      ],
      /review_request requires commitSha/,
    );

    // --- unknown message type ---
    runFail(
      repo,
      [
        "handoff",
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "gossip",
        "--summary",
        "hello",
      ],
      /Unknown message type/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9b. Stale decisions and reviewer substitution cannot cross the bus.
   * ------------------------------------------------------------------- */
  {
    const OLD = "b".repeat(40);
    const MOVED = "c".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const staleId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        OLD,
        "--summary",
        "approved at an older commit",
      ],
      { LIBERTY_COMMIT_SHA: OLD },
    );

    // HEAD has moved since GPT reviewed: applying now would stamp unreviewed
    // code as approved, so it must be refused.
    runFail(repo, ["process", "claude-lead"], /stale handoff/, {
      LIBERTY_COMMIT_SHA: MOVED,
    });
    assert.equal(
      taskOf(repo, "PL-AI-0001").review,
      undefined,
      "a stale decision must not be recorded",
    );
    assert.ok(
      !fs.existsSync(busFile(repo, "acknowledgements", `${staleId}.json`)),
      "a rejected message must stay unacknowledged so it can be retried",
    );
    assert.equal(taskOf(repo, "PL-AI-0001").status, "REVIEW");

    // Fail closed: with no resolvable HEAD the decision cannot be verified, so
    // it must be refused rather than accepted on trust.
    runFail(repo, ["process", "claude-lead"], /cannot resolve HEAD/);
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);

    // A ref name or abbreviated sha is rejected at publish time.
    runFail(
      repo,
      [
        "handoff",
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        "HEAD",
        "--summary",
        "approving whatever main points at",
      ],
      /commitSha must be a full 40-character hex sha/,
    );

    // Message ids are path-constrained: a peer cannot steer the acknowledgement
    // write outside the bus directory.
    runFail(
      repo,
      ["ack", "../../../scripts/agent-bus"],
      /unsafe or malformed message id/,
    );

    // Reviewer substitution is still refused even when it arrives over the bus.
    publish(
      repo,
      [
        "--from",
        "claude-security",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        MOVED,
        "--summary",
        "standing in for the gpt lane",
      ],
      { LIBERTY_COMMIT_SHA: MOVED },
    );
    runFail(
      repo,
      ["process", "claude-lead"],
      /requires independent review by gpt-architect/,
      { LIBERTY_COMMIT_SHA: MOVED },
    );
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);
  }

  /* ---------------------------------------------------------------------
   * 9c. changes_requested and out-of-state decisions.
   * ------------------------------------------------------------------- */
  {
    const SHA = "d".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "changes_requested",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "dispatcher still starves executable lanes",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const task = taskOf(repo, "PL-AI-0001");
    assert.equal(
      task.status,
      "IN_PROGRESS",
      "changes_requested must return the task to IN_PROGRESS",
    );
    assert.equal(task.review.outcome, "CHANGES_REQUESTED");

    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(
      repo,
      ["done", "PL-AI-0001"],
      /review outcome is CHANGES_REQUESTED/,
    );

    // A decision aimed at a task that is not in REVIEW is refused rather than
    // silently applied.
    publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-0101",
        "--sha",
        SHA,
        "--summary",
        "approving something that was never submitted",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    const earlyId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-0101",
        "--sha",
        SHA,
        "--summary",
        "approving something that was never submitted",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    runFail(
      repo,
      ["process", "claude-lead"],
      /only applies to a task in REVIEW/,
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // Arriving early is a property of repository state, not of the message, so
    // it must be retried rather than permanently quarantined.
    assert.equal(
      rejectionOf(repo, earlyId),
      null,
      "a transient failure must not be quarantined",
    );
    assert.equal(ackOf(repo, earlyId), null);
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      new RegExp(earlyId),
      "it must stay in the inbox for retry",
    );
  }

  /* ---------------------------------------------------------------------
   * 9d. Informational traffic is acknowledged without moving task state.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const before = JSON.stringify(tasksOf(repo));

    publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "prioritise the GitHub bridge over product work",
    ]);
    publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "architecture_decision",
      "--task",
      "PL-0401",
      "--summary",
      "better-auth pulls zod 4; contracts stay on zod 3 behind a nominal boundary",
    ]);

    run(repo, CLI, ["process", "claude-lead"]);
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      before,
      "informational messages must not move task state",
    );
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9e. Audit events are emitted only after the durable commit.
   * ------------------------------------------------------------------- */
  {
    const SHA = "e".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    // A message that will fail during validation must leave NO audit trace.
    const badId = publish(
      repo,
      [
        "--from",
        "claude-security",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "not the designated reviewer",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    runFail(repo, ["process", "claude-lead"], /requires independent review/, {
      LIBERTY_COMMIT_SHA: SHA,
    });

    const afterFailure = eventsOf(repo);
    assert.equal(
      afterFailure.filter((e) => e.type === "task.review_recorded").length,
      0,
      "a rejected review must not appear in the audit log",
    );
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);

    // It was quarantined on first detection, so it no longer blocks later runs.
    assert.ok(
      rejectionOf(repo, badId),
      "a permanently-invalid message must be quarantined",
    );
    assert.equal(
      ackOf(repo, badId),
      null,
      "quarantine must not create a success acknowledgement",
    );

    // A successful message emits exactly one review event, and only after the
    // task state and acknowledgement are durable.
    const okId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const events = eventsOf(repo);
    const reviewEvents = events.filter(
      (e) => e.type === "task.review_recorded",
    );
    assert.equal(reviewEvents.length, 1);
    assert.equal(reviewEvents[0]?.reviewedCommitSha, SHA);
    assert.equal(journalOf(repo, okId)?.state, "ACKNOWLEDGED");
    assert.ok(ackOf(repo, okId));

    // Ordering: the review event must come after the task state was written,
    // which is observable as the processed event following it in the log.
    const reviewIndex = events.findIndex(
      (e) => e.type === "task.review_recorded",
    );
    const processedIndex = events.findIndex(
      (e) => e.type === "bus.message_processed",
    );
    assert.ok(
      reviewIndex >= 0 && processedIndex > reviewIndex,
      "processed event must follow the review event",
    );
  }

  /* ---------------------------------------------------------------------
   * 9f. Crash AFTER claim, BEFORE task save -> redo, losing nothing.
   * ------------------------------------------------------------------- */
  {
    const SHA = "f".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const id = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved before the crash",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // The run died holding the claim, before task state was persisted.
    simulateCrash(repo, id, "APPLYING");
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined);

    // Recovery releases the claim; the same run then reprocesses it cleanly.
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const task = taskOf(repo, "PL-AI-0001");
    assert.equal(
      task.review.outcome,
      "APPROVED",
      "an interrupted claim must not lose the transition",
    );
    assert.equal(
      task.reviewHistory.length,
      1,
      "recovery must not duplicate the review",
    );
    assert.equal(journalOf(repo, id)?.state, "ACKNOWLEDGED");
    assert.equal(
      eventsOf(repo).filter((e) => e.type === "task.review_recorded").length,
      1,
      "recovery must not duplicate the audit event",
    );
  }

  /* ---------------------------------------------------------------------
   * 9g. Crash AFTER task save, BEFORE acknowledgement -> finish, never redo.
   * ------------------------------------------------------------------- */
  {
    const SHA = "1".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const id = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved, crash before ack",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const historyLength = taskOf(repo, "PL-AI-0001").reviewHistory.length;
    assert.equal(historyLength, 1);

    // Rewind to the exact crash window: task state persisted, journal APPLIED,
    // acknowledgement not yet written.
    fs.rmSync(
      path.join(
        repo,
        "coordination",
        "agent-bus",
        "acknowledgements",
        `${id}.json`,
      ),
    );
    simulateCrash(repo, id, "APPLIED", {
      applied: "APPROVED recorded on PL-AI-0001 by gpt-architect",
    });

    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    assert.ok(ackOf(repo, id), "recovery must finalize the acknowledgement");
    assert.equal(journalOf(repo, id)?.state, "ACKNOWLEDGED");
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      historyLength,
      "recovery of an APPLIED message must NOT re-apply the review",
    );

    // Repeated recovery is idempotent.
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      historyLength,
    );
    assert.match(
      run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA }),
      /No unacknowledged messages/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9h. Recovery is isolated by journal owner AND message recipient.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const ownedByClaude = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "Claude-owned interrupted work",
    ]);
    const addressedToClaude = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "architecture_decision",
      "--summary",
      "Recipient must recover this",
    ]);

    simulateCrash(repo, ownedByClaude, "APPLIED", {
      claimedBy: "claude-lead",
      applied: "Claude transaction applied",
      audit: [
        { type: "task.review_recorded", details: { taskId: "PL-AI-0001" } },
      ],
    });
    simulateCrash(repo, addressedToClaude, "ACKNOWLEDGED", {
      claimedBy: "gpt-architect",
      applied: "recipient-mismatched transaction",
      eventsEmitted: false,
      audit: [
        { type: "task.review_recorded", details: { taskId: "PL-AI-0001" } },
      ],
    });
    resetEventLog(repo);

    const ownerJournalBefore = fs.readFileSync(
      busFile(repo, "journal", `${ownedByClaude}.json`),
      "utf8",
    );
    const recipientJournalBefore = fs.readFileSync(
      busFile(repo, "journal", `${addressedToClaude}.json`),
      "utf8",
    );

    const processOut = run(repo, CLI, ["process", "gpt-architect"]);
    assert.match(processOut, /SKIP FOREIGN/);
    const recoverOut = run(repo, CLI, ["recover", "gpt-architect"]);
    assert.match(recoverOut, /skipped 2 foreign transaction/);

    assert.equal(
      ackOf(repo, ownedByClaude),
      null,
      "another agent's journal must not be acknowledged",
    );
    assert.equal(
      ackOf(repo, addressedToClaude),
      null,
      "recipient mismatch must not be acknowledged",
    );
    assert.equal(
      fs.readFileSync(
        busFile(repo, "journal", `${ownedByClaude}.json`),
        "utf8",
      ),
      ownerJournalBefore,
      "foreign ownership must leave the journal untouched",
    );
    assert.equal(
      fs.readFileSync(
        busFile(repo, "journal", `${addressedToClaude}.json`),
        "utf8",
      ),
      recipientJournalBefore,
      "foreign recipient must leave the journal untouched",
    );
    assert.deepEqual(
      eventsOf(repo),
      [],
      "foreign recovery must emit no audit or processed records",
    );
  }

  /* ---------------------------------------------------------------------
   * 9i. Malformed peer messages are isolated, not fatal.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const lane = path.join(repo, "coordination", "agent-bus", "gpt-to-claude");

    // Unparseable, structurally invalid, and filename/id mismatch respectively.
    fs.writeFileSync(
      path.join(lane, "MSG-20260815T000000000Z-blocker-deadbeef.json"),
      "{ not json",
    );
    fs.writeFileSync(
      path.join(lane, "MSG-20260815T000000001Z-blocker-deadbeee.json"),
      JSON.stringify({
        id: "MSG-20260815T000000001Z-blocker-deadbeee",
        fromAgent: "gpt-architect",
      }),
    );
    fs.writeFileSync(
      path.join(lane, "MSG-20260815T000000002Z-blocker-deadbeef.json"),
      JSON.stringify({
        id: "MSG-20260815T000000009Z-blocker-cafebabe",
        fromAgent: "gpt-architect",
        toAgent: "claude-lead",
        type: "blocker",
        summary: "id does not match filename",
        createdAt: "2026-08-15T00:00:00.002Z",
        status: "open",
      }),
    );

    // A good message still gets through despite the malformed neighbours.
    const goodId = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "still deliverable",
    ]);

    const inbox = run(repo, CLI, ["inbox", "claude-lead"]);
    assert.match(inbox, new RegExp(goodId));
    assert.doesNotMatch(
      inbox,
      /cafebabe/,
      "a filename/id mismatch must be ignored",
    );

    const rejectionDir = path.join(repo, "coordination", "agent-bus", "rejections");
    const stateBefore = JSON.stringify(tasksOf(repo));

    // FIRST RUN: three NEW permanent rejections are discovered, so the run must
    // report failure. Quarantining is not a silent success.
    const first = runFail(repo, ["process", "claude-lead"], /REJECT/);
    assert.match(
      first,
      /3 newly rejected/,
      `expected three new rejections, got:\n${first}`,
    );

    // The valid message queued behind them was still processed.
    assert.ok(
      ackOf(repo, goodId),
      "a valid message must not be blocked behind malformed ones",
    );

    // Every malformed file has a durable rejection record and no acknowledgement.
    const records = fs
      .readdirSync(rejectionDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) =>
        JSON.parse(fs.readFileSync(path.join(rejectionDir, n), "utf8")),
      );
    assert.equal(
      records.length,
      3,
      `expected 3 quarantine records, got ${records.length}`,
    );
    for (const record of records) {
      assert.ok(record.reason, "every rejection must carry a reason");
      assert.ok(record.rejectedAt, "every rejection must carry a timestamp");
      assert.equal(
        ackOf(repo, record.messageId),
        null,
        "quarantine must never create a success acknowledgement",
      );
    }

    // Malformed input never moves task state.
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      stateBefore,
      "malformed files must not mutate task state",
    );

    const eventsAfterFirst = eventsOf(repo);

    // SECOND RUN: the same immutable files must not fail the run again.
    const second = run(repo, CLI, ["process", "claude-lead"]);
    assert.doesNotMatch(
      second,
      /REJECT/,
      "already-quarantined files must not be re-reported",
    );
    assert.match(second, /No unacknowledged messages/);

    // Nothing duplicated: no extra rejection, event, ack or task transition.
    assert.equal(
      fs.readdirSync(rejectionDir).filter((n) => n.endsWith(".json")).length,
      3,
      "no duplicate rejection records",
    );
    assert.equal(
      eventsOf(repo).length,
      eventsAfterFirst.length,
      "a no-op run must not append events",
    );
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      stateBefore,
      "no task transition on the second run",
    );

    // The inbox is not wedged.
    assert.match(
      run(repo, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
  }

  /* ---------------------------------------------------------------------
   * 9i. Quarantine: a permanently-invalid message is rejected once, never
   *     acknowledged, never blocks valid traffic, and never wedges the queue.
   * ------------------------------------------------------------------- */
  {
    const SHA = "2".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);
    const stateBefore = JSON.stringify(tasksOf(repo));

    // Permanently invalid: wrong reviewer for this task. The message is
    // immutable, so this can never become valid.
    const badId = publish(
      repo,
      [
        "--from",
        "claude-security",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "not the designated reviewer",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // A valid message queued behind it must still get through.
    const goodId = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "genuine independent approval",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    // First detection reports failure...
    const firstRun = runFail(repo, ["process", "claude-lead"], /REJECT/, {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.match(firstRun, /newly rejected/);

    // ...but the valid message behind it was still applied.
    assert.equal(
      taskOf(repo, "PL-AI-0001").review?.reviewerAgent,
      "gpt-architect",
    );
    assert.ok(ackOf(repo, goodId));

    // The rejection is durable, shared, and carries a reason.
    const rejection = rejectionOf(repo, badId);
    assert.ok(rejection, "rejection record must be written");
    assert.equal(rejection.messageId, badId);
    assert.equal(rejection.rejectedBy, "claude-lead");
    assert.match(
      rejection.reason,
      /requires independent review by gpt-architect/,
    );
    assert.ok(rejection.rejectedAt);
    assert.equal(rejection.fromAgent, "claude-security");

    // A rejection is NOT an acknowledgement, and the two must stay disjoint:
    // acking a quarantined message would report it as successfully processed.
    assert.equal(
      ackOf(repo, badId),
      null,
      "rejection must not create a success acknowledgement",
    );
    runFail(
      repo,
      ["ack", badId, "--agent", "claude-lead"],
      /a rejection is not an acknowledgement/,
    );
    assert.equal(ackOf(repo, badId), null);

    // The rejected message never touched task state: the only change is the
    // review that the VALID message applied.
    const afterState = JSON.parse(JSON.stringify(tasksOf(repo)));
    const beforeState = JSON.parse(stateBefore);
    for (const task of afterState) {
      if (task.id === "PL-AI-0001") continue;
      assert.deepEqual(
        task,
        beforeState.find((t) => t.id === task.id),
        `${task.id} must be untouched`,
      );
    }
    assert.equal(
      taskOf(repo, "PL-AI-0001").reviewHistory.length,
      1,
      "only the valid review may be recorded",
    );

    // A second run does NOT fail again on the same immutable rejection.
    const secondRun = run(repo, CLI, ["process", "claude-lead"], {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.match(secondRun, /previously rejected|No unacknowledged messages/);

    // A rejected message is hidden from the working inbox but visible with --all.
    assert.doesNotMatch(
      run(repo, CLI, ["inbox", "claude-lead"]),
      new RegExp(badId),
    );
    const full = run(repo, CLI, ["inbox", "claude-lead", "--all"]);
    assert.match(full, new RegExp(badId));
    assert.match(full, /rejected: /);

    // Another checkout observes the SHARED rejection and does not re-trigger it.
    const other = cloneRepo(repo);
    assert.ok(
      rejectionOf(other, badId),
      "rejection must travel with the repository",
    );
    const otherRun = run(other, CLI, ["process", "claude-lead"], {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.doesNotMatch(
      otherRun,
      /REJECT/,
      "a second checkout must not re-reject a known-bad message",
    );
  }

  /* ---------------------------------------------------------------------
   * 9j. Audit exactly-once across the emit -> crash -> recover window.
   * ------------------------------------------------------------------- */
  {
    const SHA = "3".repeat(40);
    const repo = freshRepo();
    implementToReview(repo);

    const id = publish(
      repo,
      [
        "--from",
        "gpt-architect",
        "--to",
        "claude-lead",
        "--type",
        "review_approved",
        "--task",
        "PL-AI-0001",
        "--sha",
        SHA,
        "--summary",
        "approved",
      ],
      { LIBERTY_COMMIT_SHA: SHA },
    );

    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const baseline = eventsOf(repo);
    const reviewEvents = baseline.filter(
      (e) => e.type === "task.review_recorded",
    );
    const processedEvents = baseline.filter(
      (e) => e.type === "bus.message_processed",
    );
    assert.equal(reviewEvents.length, 1);
    assert.equal(processedEvents.length, 1);
    assert.ok(
      reviewEvents[0]?.eventId,
      "bus audit records must carry a deterministic id",
    );

    // Rewind to the precise gap GPT identified: the events were written, then
    // the run died before the journal recorded that they had been.
    simulateCrash(repo, id, "ACKNOWLEDGED", {
      applied:
        taskOf(repo, "PL-AI-0001").review.outcome +
        " recorded on PL-AI-0001 by gpt-architect",
      eventsEmitted: false,
      audit: [
        {
          type: "task.review_recorded",
          details: { taskId: "PL-AI-0001", reviewerAgent: "gpt-architect" },
        },
      ],
    });

    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });

    const after = eventsOf(repo);
    assert.equal(
      after.filter((e) => e.type === "task.review_recorded").length,
      1,
      "recovery must not write a second physical copy of an already-emitted audit record",
    );
    assert.equal(
      after.filter((e) => e.type === "bus.message_processed").length,
      1,
      "recovery must not duplicate the processed record either",
    );
    assert.equal(journalOf(repo, id)?.eventsEmitted, true);

    // Repeated recovery stays exactly-once.
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["recover", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    const finalEvents = eventsOf(repo);
    assert.equal(
      finalEvents.filter((e) => e.type === "task.review_recorded").length,
      1,
    );
    assert.equal(
      finalEvents.filter((e) => e.type === "bus.message_processed").length,
      1,
    );
    assert.equal(taskOf(repo, "PL-AI-0001").reviewHistory.length, 1);
  }

  /* ---------------------------------------------------------------------
   * 9k. Malformed peer files are quarantined, not silently dropped.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const lane = path.join(repo, "coordination", "agent-bus", "gpt-to-claude");

    const invalidJson = "MSG-20260815T000000000Z-blocker-aaaaaaaa.json";
    const structurallyInvalid = "MSG-20260815T000000001Z-blocker-bbbbbbbb.json";
    const idMismatch = "MSG-20260815T000000002Z-blocker-cccccccc.json";
    const unsafeName = "..%2F..%2Fescape.json";

    fs.writeFileSync(path.join(lane, invalidJson), "{ not json");
    fs.writeFileSync(
      path.join(lane, structurallyInvalid),
      JSON.stringify({
        id: "MSG-20260815T000000001Z-blocker-bbbbbbbb",
        fromAgent: "gpt-architect",
      }),
    );
    fs.writeFileSync(
      path.join(lane, idMismatch),
      JSON.stringify({
        id: "MSG-20260815T000000009Z-blocker-dddddddd",
        fromAgent: "gpt-architect",
        toAgent: "claude-lead",
        type: "blocker",
        summary: "id does not match filename",
        createdAt: "2026-08-15T00:00:00.002Z",
        status: "open",
      }),
    );
    fs.writeFileSync(
      path.join(lane, unsafeName),
      JSON.stringify({ id: "../../../escape" }),
    );

    // A valid message behind them must still get through.
    const goodId = publish(repo, [
      "--from",
      "gpt-architect",
      "--to",
      "claude-lead",
      "--type",
      "task_instruction",
      "--summary",
      "still deliverable",
    ]);

    const stateBefore = JSON.stringify(tasksOf(repo));
    const first = runFail(repo, ["process", "claude-lead"], /REJECT/);

    // Every malformed file became a durable rejection record.
    const rejectionDir = path.join(
      repo,
      "coordination",
      "agent-bus",
      "rejections",
    );
    const records = fs
      .readdirSync(rejectionDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) =>
        JSON.parse(fs.readFileSync(path.join(rejectionDir, n), "utf8")),
      );
    assert.equal(
      records.length,
      4,
      `expected 4 quarantine records, got ${records.length}`,
    );

    const byFile = new Map(records.map((r) => [r.originalFilename, r]));
    assert.match(byFile.get(invalidJson).reason, /not valid JSON/);
    assert.match(
      byFile.get(structurallyInvalid).reason,
      /structurally invalid/,
    );
    assert.match(byFile.get(idMismatch).reason, /does not match filename/);

    // An unsafe filename gets a deterministic derived key, never a path.
    const unsafeRecord = byFile.get(unsafeName);
    assert.ok(unsafeRecord, "an unsafe filename must still be quarantined");
    assert.match(unsafeRecord.messageId, /^MALFORMED-[0-9a-f]{16}$/);
    assert.equal(
      unsafeRecord.originalFilename,
      unsafeName,
      "the original filename is preserved as evidence",
    );
    assert.match(unsafeRecord.reason, /filename is not a safe message id/);

    // No task state touched, no success acknowledgement, valid message applied.
    assert.equal(
      JSON.stringify(tasksOf(repo)),
      stateBefore,
      "malformed files must not mutate task state",
    );
    assert.ok(
      ackOf(repo, goodId),
      "a valid message must not be blocked behind malformed ones",
    );
    for (const record of records) {
      assert.equal(
        ackOf(repo, record.messageId),
        null,
        "quarantine must never create an acknowledgement",
      );
    }
    assert.match(first, /newly rejected/);

    // Second run does not rediscover them as new failures.
    const second = run(repo, CLI, ["process", "claude-lead"]);
    assert.doesNotMatch(
      second,
      /REJECT/,
      "already-quarantined files must not be re-reported",
    );
    assert.equal(
      fs.readdirSync(rejectionDir).filter((n) => n.endsWith(".json")).length,
      4,
      "no duplicate rejection records",
    );
  }

  /* ---------------------------------------------------------------------
   * 9l. Fingerprints are canonical git content, not platform-dependent bytes.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        // Drop stderr: `git add -A` emits a CRLF advisory per file under a
        // global core.autocrlf, which buries the actual test output.
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    const sha = git("rev-parse", "HEAD").trim();

    const statusOf = (extraEnv = {}) =>
      JSON.parse(run(repo, CLI, ["review-status", "PL-AI-0001"], extraEnv));

    const lfHash = statusOf().currentTreeHash;

    // Simulate a Windows checkout: rewrite the working tree with CRLF endings.
    // The COMMITTED content is unchanged, so the canonical fingerprint must not
    // move -- this is the multi-worker trap the old byte-hashing had.
    const target = path.join(repo, "AGENTS.md");
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, original.replace(/\r?\n/g, "\r\n"));

    const crlfHash = statusOf().currentTreeHash;
    assert.equal(
      crlfHash,
      lfHash,
      "line-ending conversion in the working tree must not change the review fingerprint",
    );

    // But the dirty tree is still detected, so it cannot reach DONE unnoticed.
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--", "AGENTS.md"],
      { cwd: repo, encoding: "utf8" },
    );
    if (dirty.trim()) {
      implementToReview(repo);
      run(repo, CLI, [
        "approve",
        "PL-AI-0001",
        "gpt-architect",
        "approved at " + sha,
      ]);
      const problems = JSON.parse(
        run(repo, CLI, ["review-status", "PL-AI-0001"]),
      ).blockingProblems;
      assert.ok(
        problems.some((p) => /uncommitted changes/.test(p)),
        `a dirty implementation tree must block completion, got: ${JSON.stringify(problems)}`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9m. Review-base contract: fail closed, never fall back to the parent.
   * ------------------------------------------------------------------- */
  {
    const START = "7".repeat(40);
    const HEAD1 = "8".repeat(40);
    const repo = freshRepo();

    // `start` captures the commit implementation began from.
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], {
      LIBERTY_COMMIT_SHA: START,
    });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], {
      LIBERTY_COMMIT_SHA: START,
    });
    assert.equal(
      taskOf(repo, "PL-AI-0001").implementationBaseSha,
      START,
      "start must record the commit implementation began from",
    );

    // Starting again must not overwrite the base within the same round.
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], {
      LIBERTY_COMMIT_SHA: HEAD1,
    });
    assert.equal(taskOf(repo, "PL-AI-0001").implementationBaseSha, START);

    // A review_request with NO base is refused at publish time.
    runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--summary", "no base supplied",
      ],
      /requires an explicit baseSha/,
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    // An empty range is refused.
    runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--base", HEAD1,
        "--summary", "empty range",
      ],
      /empty range reviews nothing/,
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    // A malformed base is refused.
    runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--base", "HEAD~1",
        "--summary", "ref name instead of sha",
      ],
      /baseSha must be a full 40-character hex sha/,
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    // FIRST review: --base auto resolves to implementationBaseSha.
    const firstId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD1,
        "--base", "auto",
        "--summary", "first review",
      ],
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );
    const firstMsg = JSON.parse(
      fs.readFileSync(busFile(repo, "claude-to-gpt", `${firstId}.json`), "utf8"),
    );
    assert.equal(
      firstMsg.baseSha,
      START,
      "a first review must span implementationBaseSha..commitSha",
    );
    assert.equal(firstMsg.commitSha, HEAD1);

    // RE-review: --base auto resolves to the previously reviewed commit.
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], {
      LIBERTY_COMMIT_SHA: HEAD1,
    });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: HEAD1 });
    run(
      repo,
      CLI,
      ["approve", "PL-AI-0001", "gpt-architect", "reviewed the first range"],
      { LIBERTY_COMMIT_SHA: HEAD1 },
    );

    const HEAD2 = "9".repeat(40);
    const secondId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD2,
        "--base", "auto",
        "--summary", "re-review after corrections",
      ],
      { LIBERTY_COMMIT_SHA: HEAD2 },
    );
    const secondMsg = JSON.parse(
      fs.readFileSync(busFile(repo, "claude-to-gpt", `${secondId}.json`), "utf8"),
    );
    assert.equal(
      secondMsg.baseSha,
      HEAD1,
      "a re-review must span previousReviewedCommitSha..newCommitSha",
    );
    assert.equal(secondMsg.commitSha, HEAD2);
  }

  /* ---------------------------------------------------------------------
   * 9n. --base auto fails closed when no base can be established.
   * ------------------------------------------------------------------- */
  {
    const SHA = "a1".repeat(20);
    const repo = freshRepo();

    // PL-0003 was never started, so it has no implementationBaseSha and no
    // review history. There must be NO parent-commit fallback.
    const out = runFail(
      repo,
      [
        "handoff",
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-0003",
        "--sha", SHA,
        "--base", "auto",
        "--summary", "no base can be resolved",
      ],
      /could not resolve a review base/,
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.match(
      out,
      /no parent-commit fallback/,
      "the failure must state that no implicit fallback exists",
    );

    // Nothing was published.
    const lane = busFile(repo, "claude-to-gpt");
    const published = fs
      .readdirSync(lane)
      .filter((n) => n.endsWith(".json"));
    assert.equal(published.length, 0, "a failed base resolution must publish nothing");
  }

  /* ---------------------------------------------------------------------
   * 9o. Inbound review decisions are range-checked on RECEIPT.
   *     Creation-time checks only bind our own producer; a peer-authored file
   *     is untrusted and may be hand-written, stale, or replayed.
   * ------------------------------------------------------------------- */
  {
    const START = "b1".repeat(20);
    const HEAD = "b2".repeat(20);
    const WRONG = "b3".repeat(20);
    const repo = freshRepo();
    const lane = busFile(repo, "gpt-to-claude");

    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: HEAD });

    /** Hand-write a decision file the way an untrusted peer would. */
    const forge = (id, extra) => {
      const message = {
        id,
        fromAgent: "gpt-architect",
        toAgent: "claude-lead",
        taskId: "PL-AI-0001",
        type: "review_approved",
        commitSha: HEAD,
        summary: "hand-written decision",
        evidence: [],
        createdAt: "2026-08-15T00:00:00.000Z",
        status: "open",
        ...extra,
      };
      fs.writeFileSync(path.join(lane, `${id}.json`), JSON.stringify(message, null, 2) + "\n");
      return id;
    };

    // No baseSha at all.
    forge("MSG-20260815T000000000Z-review_approved-11111111", { baseSha: null });
    runFail(repo, ["process", "claude-lead"], /carries no baseSha/, { LIBERTY_COMMIT_SHA: HEAD });
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "a decision with no range must not be recorded");

    // A base that is valid in form but narrows the range, hiding earlier work.
    forge("MSG-20260815T000000001Z-review_approved-22222222", { baseSha: WRONG });
    runFail(repo, ["process", "claude-lead"], /expects a review starting at/, { LIBERTY_COMMIT_SHA: HEAD });
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "a wrong range must not be recorded");

    // Empty range.
    forge("MSG-20260815T000000002Z-review_approved-33333333", { baseSha: HEAD });
    runFail(repo, ["process", "claude-lead"], /empty range reviews nothing/, { LIBERTY_COMMIT_SHA: HEAD });

    // All three were quarantined, not merely skipped.
    const rejections = fs
      .readdirSync(busFile(repo, "rejections"))
      .filter((n) => n.endsWith(".json"));
    assert.equal(rejections.length, 3, `expected 3 quarantined decisions, got ${rejections.length}`);

    // The correct range is accepted, and the record persists BOTH endpoints.
    forge("MSG-20260815T000000003Z-review_approved-44444444", { baseSha: START });
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: HEAD });
    const review = taskOf(repo, "PL-AI-0001").review;
    assert.equal(review.outcome, "APPROVED");
    assert.equal(review.reviewedBaseSha, START, "the review record must persist the range base");
    assert.equal(review.reviewedCommitSha, HEAD, "the review record must persist the range head");
  }

  /* ---------------------------------------------------------------------
   * 9p. A legacy no-base request is handled once and never wedges the worker,
   *     and a valid request behind it still gets through.
   * ------------------------------------------------------------------- */
  {
    const START = "c1".repeat(20);
    const HEAD = "c2".repeat(20);
    const repo = freshRepo();
    const lane = busFile(repo, "claude-to-gpt");

    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });

    // A request published before the baseSha schema existed, as found on main.
    const legacyId = "MSG-20260815T052113388Z-review_request-31445801";
    fs.writeFileSync(
      path.join(lane, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          fromAgent: "claude-lead",
          toAgent: "gpt-architect",
          taskId: "PL-AI-0001",
          type: "review_request",
          commitSha: HEAD,
          summary: "legacy request with no baseSha",
          evidence: [],
          createdAt: "2026-08-15T05:21:13.388Z",
          status: "open",
        },
        null,
        2,
      ) + "\n",
    );

    // A well-formed request published afterwards.
    const validId = publish(
      repo,
      [
        "--from", "claude-lead",
        "--to", "gpt-architect",
        "--type", "review_request",
        "--task", "PL-AI-0001",
        "--sha", HEAD,
        "--base", "auto",
        "--summary", "valid request behind the legacy one",
      ],
      { LIBERTY_COMMIT_SHA: HEAD },
    );

    // The legacy file is structurally valid, so it is DELIVERABLE: the reviewer
    // itself must reject it. Both appear in the gpt-architect inbox.
    const inbox = run(repo, CLI, ["inbox", "gpt-architect"]);
    assert.match(inbox, new RegExp(legacyId), "a legacy request must still be visible, not silently dropped");
    assert.match(inbox, new RegExp(validId));

    // The valid one carries a resolved range; the legacy one does not. This is
    // the distinction the cloud reviewer fails closed on, before any model call.
    const legacyMsg = JSON.parse(fs.readFileSync(path.join(lane, `${legacyId}.json`), "utf8"));
    const validMsg = JSON.parse(fs.readFileSync(path.join(lane, `${validId}.json`), "utf8"));
    assert.equal(legacyMsg.baseSha, undefined, "the legacy fixture must have no baseSha");
    assert.equal(validMsg.baseSha, START, "the valid request must span implementationBaseSha..commitSha");
  }

  /* ---------------------------------------------------------------------
   * 9q. A DONE task proves its own history; it does not write-lock its paths.
   *
   *     PL-AI-0001 and PL-AI-0002 both own scripts/** and control/**. Once
   *     PL-AI-0001 completes, successor work on those paths must not make
   *     validation declare the finished task broken.
   * ------------------------------------------------------------------- */
  {
    const SHA = "d1".repeat(20);
    const repo = freshRepo();

    // --- Task A: implement, review, complete ---
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "reviewed"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["done", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });
    assert.equal(taskOf(repo, "PL-AI-0001").status, "DONE");

    // Validation is clean immediately after completion.
    run(repo, CLI, ["validate"], { LIBERTY_COMMIT_SHA: SHA });

    // --- Task B: successor work on an OVERLAPPING path ---
    // PL-AI-0002 owns scripts/** too. Editing there is legitimate.
    run(repo, CLI, ["claim", "PL-AI-0002", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-AI-0002", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    fs.appendFileSync(
      path.join(repo, "scripts", "validate-repo.mjs"),
      "\n// successor work by PL-AI-0002\n",
    );

    // THE REGRESSION: the completed task must still validate. Its paths changed,
    // but its historical review integrity is untouched.
    const out = run(repo, CLI, ["validate"], { LIBERTY_COMMIT_SHA: SHA });
    assert.match(out, /AI control plane valid/);
    assert.doesNotMatch(
      out,
      /PL-AI-0001 is DONE but/,
      "a completed task must not be invalidated by later work on its old paths",
    );

    // --- But Task B's own unreviewed state still blocks Task B ---
    run(repo, CLI, ["gate", "PL-AI-0002", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0002", "security-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["review", "PL-AI-0002"], { LIBERTY_COMMIT_SHA: SHA });
    runFail(
      repo,
      ["done", "PL-AI-0002"],
      /no independent review record/,
      { LIBERTY_COMMIT_SHA: SHA },
    );
    assert.equal(
      taskOf(repo, "PL-AI-0002").status,
      "REVIEW",
      "the successor task must still require its own independent review",
    );

    // A DONE task with a tampered review record IS still an error.
    const tasksFile = path.join(repo, "control", "tasks.json");
    const doc = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const completed = doc.tasks.find((t) => t.id === "PL-AI-0001");
    completed.review.reviewerAgent = completed.review.implementationAgent;
    fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2) + "\n");
    runFail(repo, ["validate"], /self-approval/, { LIBERTY_COMMIT_SHA: SHA });
  }

  /* ---------------------------------------------------------------------
   * 9r. Fingerprint provenance compatibility for historical DONE records.
   *
   *     Records written after canonical fingerprinting but before the
   *     reviewedFingerprintSource field carry canonical hashes. They must be
   *     fully verified, not silently demoted to structural-only checks.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    // Complete a task with a real canonical fingerprint.
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"]);
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"]);
    run(repo, CLI, ["review", "PL-AI-0001"]);
    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "reviewed"]);
    run(repo, CLI, ["done", "PL-AI-0001"]);

    const original = taskOf(repo, "PL-AI-0001").review;
    assert.equal(
      original.reviewedFingerprintSource,
      "git-object",
      "a new record must declare its fingerprint provenance",
    );

    const tasksFile = path.join(repo, "control", "tasks.json");
    const patchReview = (mutate) => {
      const doc = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
      const task = doc.tasks.find((t) => t.id === "PL-AI-0001");
      task.review = { ...original };
      mutate(task.review);
      fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2) + "\n");
    };

    // (a) Missing source + canonical hash -> verified fully, not demoted.
    patchReview((r) => {
      delete r.reviewedFingerprintSource;
    });
    assert.match(
      run(repo, CLI, ["validate"]),
      /AI control plane valid/,
      "a pre-field record whose hash IS canonical must validate",
    );

    // (b) Missing source + non-reproducible hash that is NOT a known legacy
    //     record -> hard failure. A mismatch alone must never be accepted as
    //     evidence of a pre-canonical record, or a tampered record would
    //     downgrade itself into structural-only validation.
    patchReview((r) => {
      delete r.reviewedFingerprintSource;
      r.reviewedTreeHash = "e".repeat(64);
    });
    runFail(repo, ["validate"], /not a known pre-canonical record/, {});

    // (b2) The SAME record, registered by its full immutable identity, is
    //      accepted under structural-only legacy validation.
    {
      const registryFile = path.join(repo, "control", "legacy-review-fingerprints.json");
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      const current = taskOf(repo, "PL-AI-0001").review;
      registry.records.push({
        taskId: "PL-AI-0001",
        reviewedCommitSha: current.reviewedCommitSha,
        reviewedTreeHash: current.reviewedTreeHash,
        reviewedAt: current.reviewedAt,
        note: "test fixture",
      });
      fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");

      assert.match(
        run(repo, CLI, ["validate"]),
        /AI control plane valid/,
        "an exactly registered pre-canonical record must validate structurally",
      );

      // (b3) Altering that registered record breaks the exact match again.
      patchReview((r) => {
        delete r.reviewedFingerprintSource;
        r.reviewedTreeHash = "e".repeat(63) + "d";
      });
      runFail(repo, ["validate"], /not a known pre-canonical record/, {});

      // (b4) Task id alone must not be enough: a different commit under the
      //      same task must still fail.
      patchReview((r) => {
        delete r.reviewedFingerprintSource;
        r.reviewedTreeHash = "e".repeat(64);
        r.reviewedCommitSha = "0".repeat(40);
      });
      runFail(repo, ["validate"], /cannot be resolved|not a known pre-canonical record/, {});

      // Restore the registry so later assertions are unaffected.
      registry.records = registry.records.filter((e) => e.taskId !== "PL-AI-0001");
      fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + "\n");
    }

    // (c) Explicit git-object + mismatched hash -> hard failure.
    patchReview((r) => {
      r.reviewedFingerprintSource = "git-object";
      r.reviewedTreeHash = "f".repeat(64);
    });
    runFail(
      repo,
      ["validate"],
      /does not match the content at its own reviewed commit/,
      {},
    );

    // (d) Unknown explicit source -> fail closed, never silently downgraded.
    patchReview((r) => {
      r.reviewedFingerprintSource = "sha512-of-vibes";
    });
    runFail(repo, ["validate"], /unknown reviewedFingerprintSource/, {});

    // (e) Explicit worktree source -> known non-canonical, structural only.
    patchReview((r) => {
      r.reviewedFingerprintSource = "worktree";
      r.reviewedTreeHash = "a".repeat(64);
    });
    assert.match(
      run(repo, CLI, ["validate"]),
      /AI control plane valid/,
      "an explicitly non-canonical record must not be treated as corrupt",
    );
  }

  /* ---------------------------------------------------------------------
   * 9s. A WIDENED base is rejected exactly like a narrowed one.
   *
   *     The GPT worker used to accept a wider base, review it, publish a
   *     decision, and only then have the control plane reject it -- wasting a
   *     model review and stranding the task. Both sides now use the shared
   *     validator, which requires the expected base EXACTLY.
   * ------------------------------------------------------------------- */
  {
    const OLDER = "e1".repeat(20);
    const START = "e2".repeat(20);
    const HEAD = "e3".repeat(20);
    const repo = freshRepo();
    const lane = busFile(repo, "gpt-to-claude");

    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: START });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: HEAD });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: HEAD });

    const forge = (id, baseSha) => {
      fs.writeFileSync(
        path.join(lane, `${id}.json`),
        JSON.stringify(
          {
            id,
            fromAgent: "gpt-architect",
            toAgent: "claude-lead",
            taskId: "PL-AI-0001",
            type: "review_approved",
            commitSha: HEAD,
            baseSha,
            summary: "decision with a non-exact base",
            evidence: [],
            createdAt: "2026-08-15T00:00:00.000Z",
            status: "open",
          },
          null,
          2,
        ) + "\n",
      );
    };

    // WIDER than expected: starts before implementation began.
    forge("MSG-20260815T000000010Z-review_approved-aaaa1111", OLDER);
    runFail(repo, ["process", "claude-lead"], /expects a review starting at exactly/, {
      LIBERTY_COMMIT_SHA: HEAD,
    });
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "a widened range must not be recorded");

    // The exact expected base is accepted.
    forge("MSG-20260815T000000011Z-review_approved-aaaa2222", START);
    run(repo, CLI, ["process", "claude-lead"], { LIBERTY_COMMIT_SHA: HEAD });
    assert.equal(taskOf(repo, "PL-AI-0001").review?.reviewedBaseSha, START);
  }

  /* ---------------------------------------------------------------------
   * 9t. The orchestrator stays enabled after its own bootstrap completes.
   *
   *     Gating on PL-AI-0002 being IN_PROGRESS switched the factory off the
   *     moment it became ready to run.
   * ------------------------------------------------------------------- */
  {
    const SHA = "f1".repeat(20);
    const repo = freshRepo();
    // The gate prints its JSON decision followed by a human-readable summary,
    // so extract the object rather than parsing the whole stream.
    const gate = () => {
      const out = run(repo, "scripts/cloud/orchestrator-gate.mjs", [], {
        LIBERTY_COMMIT_SHA: SHA,
      });
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      assert.ok(start >= 0 && end > start, `no JSON decision in gate output:\n${out}`);
      return JSON.parse(out.slice(start, end + 1));
    };

    // Nothing done yet: dormant.
    assert.equal(gate().orchestrate, false, "dormant before the bootstrap completes");

    const complete = (id) => {
      run(repo, CLI, ["claim", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["start", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      for (const g of taskOf(repo, id).qualityGates) {
        run(repo, CLI, ["gate", id, g, "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
      }
      run(repo, CLI, ["review", id], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["approve", id, "gpt-architect", "reviewed"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["done", id], { LIBERTY_COMMIT_SHA: SHA });
    };

    complete("PL-AI-0001");
    assert.equal(
      gate().orchestrate,
      false,
      "still dormant while PL-AI-0002 is unfinished",
    );

    complete("PL-AI-0002");
    const after = gate();
    assert.equal(after.bootstrapStatus, "DONE");
    assert.equal(after.orchestratorStatus, "DONE");
    assert.equal(
      after.orchestrate,
      true,
      "the orchestrator must stay ENABLED once both bootstrap tasks are DONE",
    );
  }

  /* ---------------------------------------------------------------------
   * 9u. Reviewer safety mechanisms, executed without an API key.
   *
   *     These are the paths that stop unseen code being approved, so static
   *     inspection is not sufficient evidence for them.
   * ------------------------------------------------------------------- */
  {
    const {
      buildReviewChunks,
      unreviewableDecision,
      assertPartCoherent,
      aggregateDecision,
      isBinaryDiff,
    } = await import("../scripts/cloud/review-chunking.mjs");

    const approved = (summary, extra = {}) => ({
      decision: "review_approved",
      summary,
      reviewedScopeConfirmed: true,
      blockingFindings: [],
      nonBlockingFindings: [],
      ...extra,
    });
    const rejected = (summary) => ({
      decision: "changes_requested",
      summary,
      reviewedScopeConfirmed: true,
      blockingFindings: [
        { severity: "high", file: "a.ts", finding: "f", requestedChange: "c" },
      ],
      nonBlockingFindings: [],
    });

    // --- chunking covers every file, never truncates ---
    {
      const files = ["a.ts", "b.ts", "c.ts"];
      const { chunks, oversizedFiles, binaryFiles } = buildReviewChunks({
        inScope: files,
        maxBytes: 100,
        diffFor: () => "x".repeat(60),
      });
      assert.equal(oversizedFiles.length, 0);
      assert.equal(binaryFiles.length, 0);
      assert.ok(chunks.length > 1, "60-byte files under a 100-byte budget must split");
      assert.deepEqual(
        chunks.flatMap((c) => c.files).sort(),
        [...files].sort(),
        "every in-scope file must appear in exactly one chunk",
      );
      for (const chunk of chunks) {
        assert.ok(chunk.patch.length <= 100, "no chunk may exceed the budget");
      }
    }

    // --- a single oversized file is refused, with no model call ---
    {
      const { chunks, oversizedFiles } = buildReviewChunks({
        inScope: ["huge.ts"],
        maxBytes: 100,
        diffFor: () => "x".repeat(5000),
      });
      assert.equal(chunks.length, 0, "an unreviewable file must not become a chunk");
      assert.equal(oversizedFiles.length, 1);

      const decision = unreviewableDecision({
        oversizedFiles,
        binaryFiles: [],
        maxBytes: 100,
      });
      assert.equal(decision.decision, "changes_requested");
      assert.equal(decision.reviewedScopeConfirmed, false);
      assert.match(decision.blockingFindings[0].finding, /above the 100-byte review budget/);
    }

    // --- binary diffs fail closed ---
    {
      assert.equal(isBinaryDiff("Binary files a/x.png and b/x.png differ"), true);
      assert.equal(isBinaryDiff("GIT binary patch\nliteral 1234"), true);
      assert.equal(isBinaryDiff("@@ -1 +1 @@\n-a\n+b"), false);

      const { chunks, binaryFiles } = buildReviewChunks({
        inScope: ["logo.png"],
        maxBytes: 10_000,
        diffFor: () => "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ",
      });
      assert.equal(chunks.length, 0, "a binary change must never be treated as reviewed content");
      assert.deepEqual(binaryFiles, ["logo.png"]);

      const decision = unreviewableDecision({ oversizedFiles: [], binaryFiles, maxBytes: 10_000 });
      assert.equal(decision.decision, "changes_requested");
      assert.match(decision.blockingFindings[0].finding, /binary change/);
    }

    // --- an approval without scope confirmation is refused ---
    assert.throws(
      () => assertPartCoherent(approved("looks fine", { reviewedScopeConfirmed: false }), 0, 1),
      /without reviewedScopeConfirmed/,
      "an approval the reviewer will not confirm must be refused",
    );
    assert.throws(
      () => assertPartCoherent({ ...approved("x"), blockingFindings: [{ severity: "high", file: "a", finding: "f", requestedChange: "c" }] }, 0, 1),
      /review_approved with blocking findings/,
    );
    assert.throws(
      () => assertPartCoherent({ ...rejected("x"), blockingFindings: [] }, 0, 1),
      /changes_requested with no blocking findings/,
    );

    // --- multi-chunk aggregation ---
    {
      const all = aggregateDecision([approved("part one"), approved("part two")], { inScopeCount: 4 });
      assert.equal(all.decision, "review_approved");
      assert.equal(all.reviewedScopeConfirmed, true);
      assert.match(all.summary, /Reviewed in 2 parts covering all 4 in-scope files/);

      const mixed = aggregateDecision([approved("part one"), rejected("part two")], { inScopeCount: 4 });
      assert.equal(mixed.decision, "changes_requested", "one rejecting part must reject the range");
      assert.equal(mixed.blockingFindings.length, 1);

      assert.throws(
        () =>
          aggregateDecision(
            [approved("one"), { ...approved("two"), reviewedScopeConfirmed: false }],
            { inScopeCount: 2 },
          ),
        /aggregate approval lacks full scope confirmation/,
        "one unconfirmed part must sink the whole approval",
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9v. Model filesystem boundary and orchestration self-modification guard.
   * ------------------------------------------------------------------- */
  {
    const SHA = "b7".repeat(20);
    const repo = freshRepo();

    // The guard restores trusted runtime code from HEAD, so it needs a real
    // repository. Without git it refuses outright -- correct production
    // behaviour, since an unverifiable runtime must not be trusted.
    const initGit = (...a) =>
      execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    initGit("init", "-q", "-b", "main");
    initGit("add", "-A");
    initGit("commit", "-q", "-m", "baseline");

    // --- snapshot / restore discards model edits to protected state ---
    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"], { LIBERTY_COMMIT_SHA: SHA });

    const runnerTemp = path.join(temp, `runner-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    const protectEnv = { RUNNER_TEMP: runnerTemp };

    run(repo, "scripts/cloud/protect-state.mjs", ["--snapshot"], protectEnv);

    // Simulate a model rewriting control state directly, bypassing the CLI.
    const tasksFile = path.join(repo, "control", "tasks.json");
    const tampered = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const victim = tampered.tasks.find((t) => t.id === "PL-0101");
    victim.status = "DONE";
    victim.review = {
      taskId: "PL-0101",
      reviewerAgent: "gpt-architect",
      implementationAgent: "claude-frontend",
      outcome: "APPROVED",
      evidence: "self-granted",
    };
    fs.writeFileSync(tasksFile, JSON.stringify(tampered, null, 2) + "\n");
    assert.equal(taskOf(repo, "PL-0101").status, "DONE", "the tamper must land before restore");

    run(repo, "scripts/cloud/protect-state.mjs", ["--restore"], protectEnv);

    assert.equal(
      taskOf(repo, "PL-0101").status,
      "IN_PROGRESS",
      "a direct edit to control/tasks.json must be discarded, not honoured",
    );
    assert.equal(
      taskOf(repo, "PL-0101").review,
      undefined,
      "a self-granted review must not survive the restore",
    );

    // Restore without a snapshot fails closed rather than continuing blind.
    const noSnapshot = path.join(temp, `runner-empty-${repoSeq}`);
    fs.mkdirSync(noSnapshot, { recursive: true });
    let failedClosed = false;
    try {
      run(repo, "scripts/cloud/protect-state.mjs", ["--restore"], { RUNNER_TEMP: noSnapshot });
    } catch (error) {
      failedClosed = /No protected-state snapshot/.test(
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
      );
    }
    assert.ok(failedClosed, "restore without a snapshot must fail closed");
  }

  /* ---------------------------------------------------------------------
   * 9w. Orchestration paths are refused for autonomous selection.
   * ------------------------------------------------------------------- */
  {
    const SHA = "b8".repeat(20);
    const repo = freshRepo();

    // PL-AI-0002 owns .github/**, control/**, scripts/**, docs/** -- it IS the
    // orchestration machinery, so an autonomous worker must never select it.
    const doneBootstrap = (id) => {
      run(repo, CLI, ["claim", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["start", id, "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
      for (const g of taskOf(repo, id).qualityGates) {
        run(repo, CLI, ["gate", id, g, "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
      }
      run(repo, CLI, ["review", id], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["approve", id, "gpt-architect", "reviewed"], { LIBERTY_COMMIT_SHA: SHA });
      run(repo, CLI, ["done", id], { LIBERTY_COMMIT_SHA: SHA });
    };
    doneBootstrap("PL-AI-0001");
    doneBootstrap("PL-AI-0002");

    const out = run(repo, "scripts/cloud/select-task.mjs", ["--agent", "claude-lead"], {
      LIBERTY_COMMIT_SHA: SHA,
    });
    assert.match(
      out,
      /privileged review-before-main lane|No autonomously workable task/,
      `an orchestration-owning task must not be auto-selected:\n${out}`,
    );
    // Nothing was claimed as a side effect.
    const claimedByLead = tasksOf(repo).filter(
      (t) => t.owner === "claude-lead" && ["CLAIMED", "IN_PROGRESS"].includes(t.status),
    );
    for (const t of claimedByLead) {
      assert.ok(
        !(t.allowedPaths ?? []).some((p) => /^(\.github|scripts|control|coordination\/agent-bus)/.test(p)),
        `${t.id} owns orchestration paths and must not have been claimed autonomously`,
      );
    }
  }

  /* ---------------------------------------------------------------------
   * 9x. End-to-end staging transaction, in the real workflow order.
   *
   *     select/start -> snapshot -> model edit -> restore -> gate mutation
   *     -> implementation staging -> control staging.
   *
   *     Both passes must commit exactly their own class of files. Rejecting the
   *     other class made the first ordinary autonomous task impossible to
   *     finalize, and no unit test caught it because the failure only appears
   *     when the passes run in sequence against real dirt.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });
    const stage = (mode, extra = []) =>
      run(repo, "scripts/cloud/stage-task-changes.mjs", [
        "--agent", "claude-frontend",
        "--task", "PL-0101",
        "--mode", mode,
        ...extra,
      ]);
    const stagedFiles = () =>
      git("diff", "--cached", "--name-only").split("\n").map((s) => s.trim()).filter(Boolean);

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    // 1. Deterministic select/start dirties control state.
    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"]);

    // 2. Snapshot AFTER the deterministic mutation, as the workflow does.
    const runnerTemp = path.join(temp, `runner-e2e-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    run(repo, "scripts/cloud/protect-state.mjs", ["--snapshot"], { RUNNER_TEMP: runnerTemp });

    // 3. Model edits its own task paths (legitimate) AND control state (not).
    fs.appendFileSync(path.join(repo, "apps/web/src/lib/catalog.ts"), "\n// model work\n");
    const tasksFile = path.join(repo, "control", "tasks.json");
    const tampered = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    tampered.tasks.find((t) => t.id === "PL-0101").status = "DONE";
    fs.writeFileSync(tasksFile, JSON.stringify(tampered, null, 2) + "\n");

    // 4. Restore discards the tamper but keeps the deterministic start state.
    run(repo, "scripts/cloud/protect-state.mjs", ["--restore"], { RUNNER_TEMP: runnerTemp });
    assert.equal(taskOf(repo, "PL-0101").status, "IN_PROGRESS", "restore must undo the tamper");
    assert.equal(taskOf(repo, "PL-0101").owner, "claude-frontend", "restore must keep the deterministic claim");

    // 5. Deterministic gate mutation dirties control state again.
    run(repo, CLI, ["gate", "PL-0101", "lint", "pass", "npm run lint exit 0"]);

    // 6. IMPLEMENTATION pass: commits task files, tolerates control dirt.
    const implOut = stage("implementation");
    const implStaged = stagedFiles();
    assert.ok(
      implStaged.includes("apps/web/src/lib/catalog.ts"),
      `implementation pass must stage the task's own file:\n${implOut}`,
    );
    assert.ok(
      implStaged.every((f) => !f.startsWith("control/") && !f.startsWith("coordination/")),
      `implementation pass must not stage control state, got: ${implStaged.join(", ")}`,
    );
    assert.match(implOut, /Left for the other staging pass/, "control dirt must be tolerated, not rejected");
    git("commit", "-q", "-m", "implementation");

    // 7. CONTROL pass: commits the deterministic state left behind.
    stage("control");
    const controlStaged = stagedFiles();
    assert.ok(controlStaged.includes("control/tasks.json"), "control pass must stage tasks.json");
    assert.ok(
      controlStaged.every((f) => f.startsWith("control/") || f.startsWith("coordination/") || f.startsWith("docs/MISSION_CONTROL")),
      `control pass must stage only control outputs, got: ${controlStaged.join(", ")}`,
    );
    assert.ok(
      !controlStaged.includes("apps/web/src/lib/catalog.ts"),
      "control pass must not re-stage implementation files",
    );
    git("commit", "-q", "-m", "control state");

    // 8. Nothing left behind, and an unrelated dirty path is still refused.
    assert.equal(git("status", "--porcelain").trim(), "", "both passes together must account for all dirt");
    fs.writeFileSync(path.join(repo, "UNRELATED.md"), "not owned by any task\n");
    let refused = false;
    try {
      stage("implementation");
    } catch (error) {
      refused = /REFUSING TO COMMIT/.test(`${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
    assert.ok(refused, "a path owned by no task must still be refused");
  }

  /* ---------------------------------------------------------------------
   * 9y. A GPT quarantine is publishable in control mode.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const lane = busFile(repo, "gpt-to-claude");
    const SHA = "c9".repeat(20);

    // The stager inspects the working tree with git, so the fixture needs a
    // real repository. Committing a baseline first means every mutation below
    // shows up as dirt, which is what the staging passes operate on.
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    // Put the task in REVIEW first. Task status is checked BEFORE the range,
    // deliberately: an early-arriving decision is transient and must not be
    // permanently quarantined just because it landed before the task was
    // submitted. Without this setup the fixture exercises the wrong branch.
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "smoke"], { LIBERTY_COMMIT_SHA: SHA });
    run(repo, CLI, ["review", "PL-AI-0001"], { LIBERTY_COMMIT_SHA: SHA });

    // A legacy decision with no baseSha, exactly as it sits on main today.
    const legacyId = "MSG-20260815T052113388Z-review_request-31445899";
    fs.writeFileSync(
      path.join(lane, `${legacyId}.json`),
      JSON.stringify(
        {
          id: legacyId,
          fromAgent: "gpt-architect",
          toAgent: "claude-lead",
          taskId: "PL-AI-0001",
          type: "review_approved",
          commitSha: SHA,
          summary: "legacy decision with no baseSha",
          evidence: [],
          createdAt: "2026-08-15T05:21:13.388Z",
          status: "open",
        },
        null,
        2,
      ) + "\n",
    );

    // Processing quarantines it durably.
    runFail(repo, ["process", "claude-lead"], /carries no baseSha/, {
      LIBERTY_COMMIT_SHA: SHA,
    });
    const rejections = fs
      .readdirSync(busFile(repo, "rejections"))
      .filter((n) => n.endsWith(".json"));
    assert.equal(rejections.length, 1, "the legacy decision must be quarantined");

    // gpt-architect owns no implementation task, so control mode is the ONLY
    // mode that can publish its output. Implementation mode has an empty
    // stageable set and would reject the quarantine it just produced.
    // Implementation mode FIRST, on a clean index. gpt-architect owns no
    // implementation task, so its stageable set is empty and every control
    // output is tolerated. It does not error -- it silently stages NOTHING,
    // which is the more dangerous failure: the publisher would commit an empty
    // change and the quarantine would never reach main, so the same legacy
    // message would be rediscovered on every run forever.
    run(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "gpt-architect",
      "--mode", "implementation",
    ]);
    assert.equal(
      git("diff", "--cached", "--name-only").trim(),
      "",
      "implementation mode stages nothing for a reviewer -- exactly why the publisher must pass --mode control",
    );

    // Control mode stages the quarantine, making it committable and durable.
    const controlOut = run(repo, "scripts/cloud/stage-task-changes.mjs", [
      "--agent", "gpt-architect",
      "--mode", "control",
    ]);
    assert.match(controlOut, /agent-bus\/rejections/, `quarantine must be staged:\n${controlOut}`);
    assert.ok(
      git("diff", "--cached", "--name-only")
        .split("\n")
        .some((f) => f.includes("agent-bus/rejections")),
      "the quarantine record must reach the index so it can be pushed",
    );
  }

  /* ---------------------------------------------------------------------
   * 9z. A model cannot substitute the code that polices it.
   *
   *     The model has Edit/Write, and every post-model step -- including the
   *     finalizer that holds GH_TOKEN -- executes FROM the workspace. Rewriting
   *     finalize-task.mjs would therefore run attacker code with push
   *     credentials. git is the immutable copy: the model can write the tree
   *     but cannot commit, so HEAD is authoritative.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const gitEnv = {
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (...a) =>
      execFileSync("git", a, {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...gitEnv },
      });

    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");

    run(repo, CLI, ["claim", "PL-0101", "claude-frontend"]);
    run(repo, CLI, ["start", "PL-0101", "claude-frontend"]);

    const runnerTemp = path.join(temp, `runner-adv-${++repoSeq}`);
    fs.mkdirSync(runnerTemp, { recursive: true });
    run(repo, "scripts/cloud/protect-state.mjs", ["--snapshot"], { RUNNER_TEMP: runnerTemp });

    // The model rewrites the guard, the stager, the finalizer, and the workflow
    // itself -- and plants a new script for good measure.
    const trusted = {
      "scripts/cloud/protect-state.mjs": "// neutered guard\nprocess.exit(0);\n",
      "scripts/cloud/stage-task-changes.mjs": "// stage everything\nprocess.exit(0);\n",
      "scripts/cloud/finalize-task.mjs": "// exfiltrate GH_TOKEN\nprocess.exit(0);\n",
      ".github/workflows/agent-claude-worker.yml": "name: pwned\n",
    };
    for (const [rel, body] of Object.entries(trusted)) {
      fs.writeFileSync(path.join(repo, rel), body);
    }
    fs.writeFileSync(path.join(repo, "scripts/cloud/backdoor.mjs"), "// planted\n");

    // Also tamper with control state, to confirm both defences run.
    const tasksFile = path.join(repo, "control", "tasks.json");
    const tampered = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    tampered.tasks.find((t) => t.id === "PL-0101").status = "DONE";
    fs.writeFileSync(tasksFile, JSON.stringify(tampered, null, 2) + "\n");

    // The restore step is invoked from the workspace -- i.e. the neutered copy
    // would run if the workflow used it. Simulate the workflow correctly by
    // running the committed version, which is what an immutable path provides.
    git("checkout", "HEAD", "--", "scripts/cloud/protect-state.mjs");
    // Combined streams: the tampering alert is a warning and goes to stderr.
    const out = runCombined(repo, "scripts/cloud/protect-state.mjs", ["--restore"], {
      RUNNER_TEMP: runnerTemp,
    });

    assert.match(out, /REVERTED \d+ unauthorized edit/, `guard must report the tampering:\n${out}`);

    for (const rel of Object.keys(trusted)) {
      const restored = fs.readFileSync(path.join(repo, rel), "utf8");
      assert.ok(
        !/neutered|stage everything|exfiltrate|pwned/.test(restored),
        `${rel} must be restored from HEAD, not left as the model wrote it`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(repo, "scripts/cloud/backdoor.mjs")),
      "a planted script must be removed, not merely left untracked",
    );
    assert.equal(
      taskOf(repo, "PL-0101").status,
      "IN_PROGRESS",
      "control-state tampering must also be discarded",
    );
    assert.equal(
      taskOf(repo, "PL-0101").owner,
      "claude-frontend",
      "the deterministic claim taken before the model must survive",
    );
    assert.equal(git("status", "--porcelain", "--", "scripts", ".github").trim(), "");
  }

  /* ---------------------------------------------------------------------
   * 9aa. Control-output and protected path sets cannot drift.
   * ------------------------------------------------------------------- */
  {
    const { CONTROL_OUTPUT_PATHS } = await import("../scripts/cloud/control-paths.mjs");
    const { PROTECTED_PATHS } = await import("../scripts/cloud/protect-state.mjs");

    assert.deepEqual(
      [...PROTECTED_PATHS].sort(),
      [...CONTROL_OUTPUT_PATHS].sort(),
      "everything control mode may commit must also be restored by the guard",
    );
    assert.ok(
      CONTROL_OUTPUT_PATHS.includes("docs/MISSION_CONTROL.md"),
      "the path that previously drifted must be covered by both",
    );
  }

  /* ---------------------------------------------------------------------
   * 10. Bootstrap into a new project still works.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const child = path.join(temp, "child-project");
    run(repo, "scripts/bootstrap-ai-project.mjs", [
      "--target",
      child,
      "--name",
      "Child Project",
      "--prefix",
      "CP",
    ]);
    run(child, CLI, ["validate"]);
    run(child, CLI, ["sync"]);
    assert.match(
      fs.readFileSync(
        path.join(child, "coordination", "PROJECT_STATUS.md"),
        "utf8",
      ),
      /Child Project/,
    );

    // The bus must work in a bootstrapped project too: the CLI imports
    // agent-bus.mjs, so a skeleton missing it fails at module resolution on the
    // very first command.
    assert.match(
      run(child, CLI, ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
    );
    assert.match(
      run(child, "scripts/agent-bus.mjs", ["inbox", "claude-lead"]),
      /No unacknowledged messages/,
      "the direct bus entry point must work in a bootstrapped project",
    );

    // The honest trust model travels with the skeleton rather than being
    // silently dropped when the control plane is reused.
    const childProject = JSON.parse(
      fs.readFileSync(path.join(child, "control", "project.json"), "utf8"),
    );
    assert.equal(
      childProject.agentBus.trustModel,
      "cooperative-github-writers",
    );
    assert.equal(childProject.agentBus.authenticatesSenderIdentity, false);
  }

  /* ---------------------------------------------------------------------
   * 11. The live repository state must be untouched by the whole run.
   *     This now also guards coordination/agent-bus, so a test that forgets
   *     freshRepo() cannot publish a real handoff message.
   * ------------------------------------------------------------------- */
  assert.equal(
    fs.readFileSync(liveTasksPath, "utf8"),
    liveTasksBefore,
    "running the test suite must not mutate the real control/tasks.json",
  );

  const liveStateAfter = snapshotLiveState();
  assert.deepEqual(
    [...liveStateAfter.entries()].sort(),
    [...liveStateBefore.entries()].sort(),
    "running the test suite must not mutate any live control/ or coordination/ file",
  );

  console.log("AI control plane tests passed (39 scenarios).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
