import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
function freshRepo() {
  const repo = path.join(temp, `repo-${++repoSeq}`);
  fs.cpSync(source, repo, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) && !src.includes(`${path.sep}node_modules${path.sep}`)
  });
  return repo;
}
function tasksOf(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, "control", "tasks.json"), "utf8")).tasks;
}
function taskOf(repo, id) {
  return tasksOf(repo).find((t) => t.id === id);
}
/** Drive PL-AI-0001 from READY up to (but not including) DONE. */
function implementToReview(repo, { implementer = "claude-lead" } = {}) {
  run(repo, CLI, ["claim", "PL-AI-0001", implementer]);
  run(repo, CLI, ["start", "PL-AI-0001", implementer]);
  run(repo, CLI, ["gate", "PL-AI-0001", "repo-validate", "pass", "automated smoke"]);
  run(repo, CLI, ["gate", "PL-AI-0001", "architecture-review", "pass", "automated smoke"]);
  run(repo, CLI, ["review", "PL-AI-0001"]);
}

try {
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

  console.log("AI control plane tests passed (9 scenarios).");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
