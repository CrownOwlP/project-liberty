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

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const AGENT = flag("--agent");
if (!AGENT) {
  console.error("Usage: finalize-task.mjs --agent <agentId>");
  process.exit(1);
}

const CLI = "scripts/ai-control-plane.mjs";
function git(...a) {
  return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function node(...a) {
  return execFileSync(process.execPath, a, { cwd: root, encoding: "utf8" });
}
function readTasks() {
  return JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
}

/* ---------------------------------------------------------------------------
 * 1. Which task is being finalized?
 * ------------------------------------------------------------------------ */
const inProgress = readTasks().filter((t) => t.owner === AGENT && t.status === "IN_PROGRESS");

if (!inProgress.length) {
  console.log(`No IN_PROGRESS task owned by ${AGENT}; nothing to finalize.`);
  process.exit(0);
}
if (inProgress.length > 1) {
  console.error(
    `${AGENT} owns ${inProgress.length} IN_PROGRESS tasks: ${inProgress.map((t) => t.id).join(", ")}. ` +
    "Finalization is deliberately single-task so a commit can be attributed to exactly one review. " +
    "Resolve this before the worker runs again.",
  );
  process.exit(1);
}
const task = inProgress[0];
console.log(`Finalizing ${task.id}: ${task.title}`);

/* ---------------------------------------------------------------------------
 * 2. Stage, with ownership enforced by the shared stager.
 * ------------------------------------------------------------------------ */
git("config", "user.name", `liberty-${AGENT}[bot]`);
git("config", "user.email", `${AGENT}@project-liberty.local`);

try {
  console.log(node("scripts/cloud/stage-task-changes.mjs", "--agent", AGENT));
} catch (error) {
  console.error(error.stdout ?? "");
  console.error(error.stderr ?? "");
  console.error("Refusing to finalize: dirty paths outside the active task.");
  process.exit(1);
}

const staged = git("diff", "--cached", "--name-only").trim();
if (!staged) {
  console.log("Nothing staged; the model made no committable changes. Leaving the task IN_PROGRESS.");
  process.exit(0);
}
console.log(`Staged:\n${staged}`);

/* ---------------------------------------------------------------------------
 * 3/4. Commit and fast-forward push. Never rebase.
 * ------------------------------------------------------------------------ */
git("commit", "-m", `${task.id}: ${task.title} (autonomous ${AGENT})`);

git("fetch", "origin", "main");
try {
  execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root, stdio: "ignore" });
} catch {
  console.error(
    "origin/main has diverged from HEAD. Refusing to rewrite reviewed history; " +
    "halting so orchestration can resolve it deliberately.",
  );
  process.exit(1);
}
git("push", "origin", "HEAD:main");
const implementationSha = git("rev-parse", "HEAD").trim();
console.log(`Pushed implementation ${implementationSha}`);

/* ---------------------------------------------------------------------------
 * 5/6/7. Transition, publish the request, push the bus state.
 * ------------------------------------------------------------------------ */
node(CLI, "review", task.id);

// --sha auto pins the commit just pushed; --base auto resolves the previously
// reviewed commit, or the commit implementation started from, so the reviewer
// receives the full cumulative range. Neither may be omitted.
const summary = `${task.id} ready for independent review: ${task.title}`;
const evidence = [
  `implementation=${implementationSha}`,
  `gates=${Object.entries(task.gateResults ?? {})
    .map(([gate, r]) => `${gate}:${r.status}`)
    .join(",") || "none recorded"}`,
];
const handoffArgs = [
  CLI, "handoff",
  "--from", AGENT,
  "--to", task.reviewAgent,
  "--type", "review_request",
  "--task", task.id,
  "--sha", "auto",
  "--base", "auto",
  "--summary", summary,
];
for (const item of evidence) handoffArgs.push("--evidence", item);
console.log(node(...handoffArgs));

try {
  console.log(node("scripts/cloud/stage-task-changes.mjs", "--agent", AGENT));
} catch (error) {
  console.error(error.stdout ?? "");
  console.error(error.stderr ?? "");
  process.exit(1);
}

if (git("diff", "--cached", "--name-only").trim()) {
  git("commit", "-m", `${task.id}: request ${task.reviewAgent} review via agent bus`);
  git("fetch", "origin", "main");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root, stdio: "ignore" });
  } catch {
    console.error("origin/main diverged before the handoff push; halting rather than rewriting history.");
    process.exit(1);
  }
  git("push", "origin", "HEAD:main");
  console.log("Review request published and pushed.");
}

console.log(`\n${task.id} is now in REVIEW awaiting ${task.reviewAgent}. Implementation stops here.`);
