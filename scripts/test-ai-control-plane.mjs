import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const source = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-control-plane-"));
const CLI = "scripts/ai-control-plane.mjs";
let repoSeq = 0;

function run(cwd, script, args = []) {
  return execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function runFail(cwd, args, matcher) {
  let failed = false;
  let output = "";
  try {
    run(cwd, CLI, args);
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.ok(failed, `expected "${args.join(" ")}" to fail but it succeeded`);
  if (matcher) assert.match(output, matcher, `unexpected failure output for "${args.join(" ")}":\n${output}`);
  return output;
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
      !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) &&
      !src.includes(`${path.sep}node_modules${path.sep}`) && !src.endsWith(`${path.sep}node_modules`)
  });
  resetRuntimeState(repo);
  return repo;
}
function tasksOf(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, "control", "tasks.json"), "utf8")).tasks;
}
function taskOf(repo, id) {
  return tasksOf(repo).find((t) => t.id === id);
}
/** Drive PL-AI-0001 from READY up to (but not including) DONE. */
function implementToReview(repo) {
  const implementer = "claude-lead";
  run(repo, CLI, ["claim", "PL-AI-0001", implementer]);
  run(repo, CLI, ["start", "PL-AI-0001", implementer]);
  run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "automated smoke"]);
  run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "automated smoke"]);
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
      for (const entry of fs.readdirSync(path.join(source, rel), { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) stack.push(childRel);
        else if (entry.isFile()) {
          snapshot.set(childRel, createHash("sha256").update(fs.readFileSync(path.join(source, childRel))).digest("hex"));
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
      assert.equal(task.owner, null, `${task.id} should have no owner in a fresh scenario`);
      assert.deepEqual(task.gateResults, {}, `${task.id} should have no gate results`);
      assert.equal(task.review, undefined, `${task.id} should have no review record`);
      assert.equal(task.reviewHistory, undefined, `${task.id} should have no review history`);
      assert.equal(task.implementationAgent, undefined, `${task.id} should have no implementation agent`);
      assert.equal(task.updatedAt, undefined, `${task.id} should have no updatedAt timestamp`);
      assert.equal(task.completedAt, undefined, `${task.id} should have no completedAt timestamp`);

      // Definitions and routing survive the reset untouched.
      const source_ = liveById.get(task.id);
      assert.equal(task.preferredAgent, source_.preferredAgent, `${task.id} preferredAgent must be preserved`);
      assert.equal(task.reviewAgent, source_.reviewAgent, `${task.id} reviewAgent must be preserved`);
      assert.deepEqual(task.dependencies, source_.dependencies, `${task.id} dependencies must be preserved`);
      assert.deepEqual(task.allowedPaths, source_.allowedPaths, `${task.id} allowedPaths must be preserved`);

      if (source_.status === "BLOCKED") {
        assert.equal(task.status, "BLOCKED", `${task.id} must stay BLOCKED`);
        assert.equal(task.blocker, source_.blocker, `${task.id} blocker reason must be preserved`);
      } else if (source_.status !== "CANCELED") {
        const expected = (task.dependencies ?? []).length === 0 ? "READY" : "BACKLOG";
        assert.equal(task.status, expected, `${task.id} should reset to ${expected}`);
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

    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "architecture review recorded via shared repository"]);
    run(repo, CLI, ["done", "PL-AI-0001"]);
    run(repo, CLI, ["validate"]);

    const done = taskOf(repo, "PL-AI-0001");
    assert.equal(done.status, "DONE");
    assert.equal(done.review.outcome, "APPROVED");
    assert.equal(done.review.reviewerAgent, "gpt-architect");
    assert.equal(done.review.implementationAgent, "claude-lead");
    assert.equal(done.review.reviewerProvider, "openai");
    for (const field of ["taskId", "reviewerClass", "reviewedCommitSha", "reviewedTreeHash", "reviewedAt", "evidence"]) {
      assert.ok(done.review[field], `review record should carry ${field}`);
    }
    assert.equal(taskOf(repo, "PL-AI-0002").status, "READY", "dependent task should unlock after DONE");

    const status = run(repo, CLI, ["status"]);
    assert.match(status, /M0 .*IN_PROGRESS, 1\/4 \(25%\)/);
  }

  /* ---------------------------------------------------------------------
   * 2. Self-approval must fail.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    runFail(repo, ["approve", "PL-AI-0001", "claude-lead", "looks good to me"], /self-approval is prohibited/);
    assert.equal(taskOf(repo, "PL-AI-0001").review, undefined, "rejected self-approval must not be recorded");
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
      ["approve", "PL-AI-0001", "claude-security", "substituting for unavailable gpt lane"],
      /requires independent review by gpt-architect/
    );
    runFail(repo, ["done", "PL-AI-0001"], /no independent review record/);
  }

  /* ---------------------------------------------------------------------
   * 4. Stale approval must fail: code changed after the review.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    implementToReview(repo);
    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "approved at review time"]);

    const approvedHash = taskOf(repo, "PL-AI-0001").review.reviewedTreeHash;

    // Mutate a file inside the task's allowedPaths after approval.
    const touched = path.join(repo, "AGENTS.md");
    fs.appendFileSync(touched, "\n<!-- post-approval edit -->\n");

    runFail(repo, ["done", "PL-AI-0001"], /stale review: implementation under allowedPaths changed after approval/);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "REVIEW", "stale review must not complete the task");

    // A fresh approval against the new content restores completability.
    run(repo, CLI, ["approve", "PL-AI-0001", "gpt-architect", "re-reviewed after post-approval edit"]);
    const rehash = taskOf(repo, "PL-AI-0001").review.reviewedTreeHash;
    assert.notEqual(rehash, approvedHash, "fingerprint must change when implementation changes");
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
    run(repo, CLI, ["request-changes", "PL-AI-0001", "gpt-architect", "dispatcher still starves executable lanes"]);
    assert.equal(taskOf(repo, "PL-AI-0001").status, "IN_PROGRESS");
    assert.equal(taskOf(repo, "PL-AI-0001").review.outcome, "CHANGES_REQUESTED");

    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(repo, ["done", "PL-AI-0001"], /review outcome is CHANGES_REQUESTED/);
  }

  /* ---------------------------------------------------------------------
   * 6. Gate evidence remains mandatory (no silent bypass).
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    run(repo, CLI, ["claim", "PL-AI-0001", "claude-lead"]);
    run(repo, CLI, ["start", "PL-AI-0001", "claude-lead"]);
    runFail(repo, ["gate", "PL-AI-0001", "repo-validate", "pass"], /Gate evidence is required/);
    run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "npm run repo:validate exit 0"]);
    run(repo, CLI, ["review", "PL-AI-0001"]);
    runFail(repo, ["done", "PL-AI-0001"], /gates not passed: architecture-review/);
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
      ["PL-AI-0001", "claude-lead"]
    ]) {
      assert.match(executableBlock, new RegExp(`${taskId} -> ${agentId}`), `${taskId} should dispatch to ${agentId}`);
    }

    const assignedCount = (executableBlock.match(/ -> /g) ?? []).length;
    assert.equal(assignedCount, 4, `expected a 4-task executable wave, got ${assignedCount}:\n${out}`);

    // PL-0002 stays reserved for gpt-architect and is never reassigned locally.
    assert.doesNotMatch(executableBlock, /PL-0002 ->/, "PL-0002 must not be dispatched to a local agent");
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
    const claimed = tasks.filter((t) => t.status === "CLAIMED").map((t) => `${t.id}:${t.owner}`).sort();
    assert.deepEqual(claimed, [
      "PL-0001:claude-infra",
      "PL-0101:claude-frontend",
      "PL-0201:claude-media",
      "PL-AI-0001:claude-lead"
    ]);
    assert.equal(taskOf(repo, "PL-0002").status, "READY", "external task must remain queued, not claimed");
    assert.equal(taskOf(repo, "PL-0002").owner, null);
    run(repo, CLI, ["validate"]);
  }

  /* ---------------------------------------------------------------------
   * 9. Bootstrap into a new project still works.
   * ------------------------------------------------------------------- */
  {
    const repo = freshRepo();
    const child = path.join(temp, "child-project");
    run(repo, "scripts/bootstrap-ai-project.mjs", ["--target", child, "--name", "Child Project", "--prefix", "CP"]);
    run(child, CLI, ["validate"]);
    run(child, CLI, ["sync"]);
    assert.match(fs.readFileSync(path.join(child, "coordination", "PROJECT_STATUS.md"), "utf8"), /Child Project/);
  }

  /* ---------------------------------------------------------------------
   * 10. The live repository state must be untouched by the whole run.
   * ------------------------------------------------------------------- */
  assert.equal(
    fs.readFileSync(liveTasksPath, "utf8"),
    liveTasksBefore,
    "running the test suite must not mutate the real control/tasks.json"
  );

  const liveStateAfter = snapshotLiveState();
  assert.deepEqual(
    [...liveStateAfter.entries()].sort(),
    [...liveStateBefore.entries()].sort(),
    "running the test suite must not mutate any live control/ or coordination/ file"
  );

  console.log("AI control plane tests passed (11 scenarios).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
