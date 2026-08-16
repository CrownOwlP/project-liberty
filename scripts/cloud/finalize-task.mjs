#!/usr/bin/env node
/**
 * Deterministic post-model finalization.
 *
 * The model edits and tests. It does NOT commit, push, transition tasks, or
 * publish handoffs. Everything below the model's boundary is done here, by
 * code, so the ownership-aware staging guard actually protects the commit
 * rather than running after the model already pushed it.
 *
 * Sequence:
 *   1. identify the single task this agent is finalizing
 *   2. stage only that task's allowedPaths plus enumerated control outputs
 *   3. commit
 *   4. fast-forward push (never rebase; approvals are bound to commit shas)
 *   5. transition the task to REVIEW
 *   6. publish the review request with --sha auto --base auto
 *   7. push the bus/control state
 *
 * Usage: node scripts/cloud/finalize-task.mjs --agent claude-lead
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertNoPersistedCredential,
  fetchMain,
  pushHeadToMain,
  remoteIsAncestorOfHead
} from "./git-auth.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const AGENT = flag("--agent");
const TASK_ID = flag("--task");
if (!AGENT) {
  console.error("Usage: finalize-task.mjs --agent <agentId> [--task <taskId>]");
  process.exit(1);
}

/*
 * Sibling resolution, not cwd. This is the step that holds the push credential:
 * if it reached back into the workspace for the control plane or the stager, a
 * model that rewrote either would be running code inside the one privileged
 * step. See the fuller note in run-gates.mjs.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "ai-control-plane.mjs");
const STAGER = path.join(HERE, "stage-task-changes.mjs");
function git(...a) {
  return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function node(...a) {
  return execFileSync(process.execPath, a, { cwd: root, encoding: "utf8" });
}
function readTasks() {
  return JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
}

/*
 * The model has just finished running in this checkout. If a credential is
 * sitting in .git/config at this point it was readable by the model for the
 * whole of that run, so the correct response is to halt rather than to push and
 * hope. Checked before any work, so the failure is unambiguous.
 */
assertNoPersistedCredential(root, "before finalizing");

/* ---------------------------------------------------------------------------
 * 1. Which task is being finalized?
 * ------------------------------------------------------------------------ */
const inProgress = readTasks().filter((t) => t.owner === AGENT && t.status === "IN_PROGRESS");

let task;
if (TASK_ID) {
  task = inProgress.find((t) => t.id === TASK_ID);
  if (!task) {
    console.error(`${TASK_ID} is not IN_PROGRESS for ${AGENT}; refusing to finalize a task that was not selected.`);
    process.exit(1);
  }
} else {
  if (!inProgress.length) {
    console.log(`No IN_PROGRESS task owned by ${AGENT}; nothing to finalize.`);
    process.exit(0);
  }
  if (inProgress.length > 1) {
    console.error(
      `${AGENT} owns ${inProgress.length} IN_PROGRESS tasks: ${inProgress.map((t) => t.id).join(", ")}. ` +
      "Pass --task to name the one being finalized; a commit must map to exactly one review.",
    );
    process.exit(1);
  }
  task = inProgress[0];
}
console.log(`Finalizing ${task.id}: ${task.title}`);

/* ---------------------------------------------------------------------------
 * 2. Stage, with ownership enforced by the shared stager.
 * ------------------------------------------------------------------------ */
git("config", "user.name", `liberty-${AGENT}[bot]`);
git("config", "user.email", `${AGENT}@project-liberty.local`);

function stage(mode) {
  try {
    console.log(
      node(STAGER, "--agent", AGENT, "--task", task.id, "--mode", mode),
    );
  } catch (error) {
    console.error(error.stdout ?? "");
    console.error(error.stderr ?? "");
    console.error(`Refusing to finalize: ${mode} staging rejected the working tree.`);
    process.exit(1);
  }
}

// Implementation staging covers ONLY the task's own allowedPaths. Control and
// bus outputs are staged later, after the deterministic steps that produce them.
stage("implementation");

const staged = git("diff", "--cached", "--name-only").trim();
if (!staged) {
  console.log("Nothing staged; the model made no committable changes. Leaving the task IN_PROGRESS.");
  process.exit(0);
}
console.log(`Staged:\n${staged}`);

/* ---------------------------------------------------------------------------
 * 3. Commit the implementation LOCALLY. Nothing is pushed yet.
 *
 * The implementation commit and its review-request state must reach the remote
 * together. Pushing the implementation first opens a window where a crash, a
 * permission failure or a divergence leaves unreviewed code on main with no
 * corresponding review request -- which is precisely the state the whole
 * enforcement model exists to prevent.
 * ------------------------------------------------------------------------ */
git("commit", "-m", `${task.id}: ${task.title} (autonomous ${AGENT})`);
const implementationSha = git("rev-parse", "HEAD").trim();
console.log(`Implementation committed locally: ${implementationSha}`);

/* ---------------------------------------------------------------------------
 * 4. Transition and publish the handoff, still locally.
 * ------------------------------------------------------------------------ */
node(CLI, "review", task.id);

// The explicit implementation sha, not `auto`: `auto` would resolve to whatever
// HEAD happens to be, and HEAD is about to move again for the bus commit.
// `--base auto` resolves the previously reviewed commit, or the commit
// implementation started from, giving the reviewer the full cumulative range.
const summary = `${task.id} ready for independent review: ${task.title}`;
const gateSummary =
  Object.entries(readTasks().find((t) => t.id === task.id)?.gateResults ?? {})
    .map(([gate, r]) => `${gate}:${r.status}`)
    .join(",") || "none recorded";

const handoffArgs = [
  CLI, "handoff",
  "--from", AGENT,
  "--to", task.reviewAgent,
  "--type", "review_request",
  "--task", task.id,
  "--sha", implementationSha,
  "--base", "auto",
  "--summary", summary,
  "--evidence", `implementation=${implementationSha}`,
  "--evidence", `gates=${gateSummary}`,
];
console.log(node(...handoffArgs));

stage("control");
if (git("diff", "--cached", "--name-only").trim()) {
  git("commit", "-m", `${task.id}: request ${task.reviewAgent} review via agent bus`);
}

/* ---------------------------------------------------------------------------
 * 5. ONE remote transaction. Both commits, or neither.
 * ------------------------------------------------------------------------ */
fetchMain(root);
if (!remoteIsAncestorOfHead(root)) {
  console.error(
    "Remote main has diverged from HEAD. Nothing has been pushed. Refusing to rewrite reviewed " +
    "history; halting so orchestration can resolve it deliberately.",
  );
  process.exit(1);
}
pushHeadToMain(root);

console.log(
  `\nPushed implementation ${implementationSha.slice(0, 12)} together with its review request.\n` +
  `${task.id} is now in REVIEW awaiting ${task.reviewAgent}. Implementation stops here.`,
);
