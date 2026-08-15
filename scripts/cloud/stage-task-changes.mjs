#!/usr/bin/env node
/**
 * Explicit, ownership-aware staging for autonomous workers.
 *
 * `git add -A` in an unattended worker is unsafe: it sweeps whatever happens to
 * be dirty into a commit attributed to the active task, which is exactly how
 * unrelated work ends up inside a reviewed range.
 *
 * This stages only:
 *   1. files inside the allowedPaths of a task the agent actively owns, and
 *   2. an explicit allowlist of control-plane and bus outputs that every worker
 *      legitimately produces regardless of task.
 *
 * Anything else that is dirty is reported and the process exits non-zero, so a
 * surprise never becomes a silent commit.
 *
 * Usage: node scripts/cloud/stage-task-changes.mjs --agent claude-lead
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const AGENT = flag("--agent");
// Optional but strongly preferred. Without it, prefixes come from EVERY active
// task this agent owns -- and claude-lead has maxParallel 2, so a commit could
// silently include a second task's paths.
const TASK_ID = flag("--task");
if (!AGENT) {
  console.error("Usage: stage-task-changes.mjs --agent <agentId> [--task <taskId>]");
  process.exit(1);
}

/**
 * Staging mode.
 *
 *   implementation  ONLY the selected task's allowedPaths. No control-plane
 *                   exception -- otherwise a model that edited control/tasks.json
 *                   directly would have that rewrite staged as a legitimate
 *                   "worker output".
 *   control         ONLY the enumerated control/bus outputs, run AFTER the
 *                   deterministic gate/review/handoff mutations produced them.
 */
const MODE = flag("--mode") || "implementation";
if (!["implementation", "control"].includes(MODE)) {
  console.error(`Unknown --mode ${MODE}; expected implementation or control`);
  process.exit(1);
}

const ACTIVE = ["CLAIMED", "IN_PROGRESS", "REVIEW"];

/**
 * Outputs produced by deterministic control-plane and bus operations.
 * Deliberately enumerated rather than wildcarded.
 */
const CONTROL_PLANE_OUTPUTS = [
  "control/tasks.json",
  "control/events.jsonl",
  "control/queues",
  "control/mission-control.json",
  "docs/MISSION_CONTROL.md",
  "coordination/agent-bus",
  "coordination/PROJECT_STATUS.md",
  "coordination/TASKS.md",
];

function git(...a) {
  return execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function normalizePrefix(pattern) {
  return pattern.replace(/\\/g, "/").replace(/\*\*.*$/, "").replace(/\*.*$/, "").replace(/\/$/, "");
}
function underPrefix(rel, prefix) {
  return prefix && (rel === prefix || rel.startsWith(prefix + "/"));
}

const tasks = JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
const owned = TASK_ID
  ? tasks.filter((t) => t.id === TASK_ID)
  : tasks.filter((t) => t.owner === AGENT && ACTIVE.includes(t.status));

if (TASK_ID && !owned.length) {
  console.error(`Unknown task ${TASK_ID}`);
  process.exit(1);
}
if (TASK_ID && owned[0].owner !== AGENT) {
  console.error(`${TASK_ID} is owned by ${owned[0].owner ?? "nobody"}, not ${AGENT}`);
  process.exit(1);
}

const taskPrefixes =
  MODE === "implementation"
    ? owned.flatMap((t) => (t.allowedPaths ?? []).map(normalizePrefix).filter(Boolean))
    : [];
const outputPrefixes = MODE === "control" ? CONTROL_PLANE_OUTPUTS.map(normalizePrefix) : [];

console.log(`Agent: ${AGENT} | mode: ${MODE}`);
console.log(`Scoped tasks: ${owned.map((t) => `${t.id} [${t.status}]`).join(", ") || "(none)"}`);
console.log(`Stageable prefixes: ${[...taskPrefixes, ...outputPrefixes].join(", ") || "(none)"}`);

// `-z` and NUL splitting: filenames can contain spaces, and a quoted path would
// otherwise be staged under the wrong name.
const dirty = git("status", "--porcelain", "-z", "--untracked-files=all")
  .split("\0")
  .filter(Boolean)
  .map((entry) => entry.slice(3))
  .filter(Boolean);

const staged = [];
const rejected = [];
for (const rel of dirty) {
  const ownedByTask = taskPrefixes.some((p) => underPrefix(rel, p));
  const isOutput = outputPrefixes.some((p) => underPrefix(rel, p));
  if (ownedByTask || isOutput) staged.push(rel);
  else rejected.push(rel);
}

for (const rel of staged) git("add", "--", rel);

console.log(`\nStaged ${staged.length} file(s):`);
for (const rel of staged) console.log(`  + ${rel}`);

if (rejected.length) {
  console.error(`\nREFUSING TO COMMIT (${MODE} mode): ${rejected.length} dirty path(s) are not stageable here:`);
  for (const rel of rejected) console.error(`  ! ${rel}`);
  console.error(
    MODE === "implementation"
      ? "\nImplementation staging covers ONLY the selected task's allowedPaths. Control-plane and bus " +
        "state is staged separately, after the deterministic steps that legitimately produce it -- so a " +
        "direct edit to control/tasks.json can never be committed as an implementation change."
      : "\nControl staging covers ONLY the enumerated control-plane and bus outputs.",
  );
  process.exit(1);
}

console.log(staged.length ? "\nAll dirty paths accounted for." : "\nNothing to commit.");
