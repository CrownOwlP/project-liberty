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
const agentIndex = args.indexOf("--agent");
const AGENT = agentIndex >= 0 ? args[agentIndex + 1] : null;
if (!AGENT) {
  console.error("Usage: stage-task-changes.mjs --agent <agentId>");
  process.exit(1);
}

const ACTIVE = ["CLAIMED", "IN_PROGRESS", "REVIEW"];

/**
 * Outputs every worker produces as a side effect of running the control plane
 * and the bus. Deliberately enumerated rather than wildcarded.
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
const owned = tasks.filter((t) => t.owner === AGENT && ACTIVE.includes(t.status));

const taskPrefixes = owned.flatMap((t) =>
  (t.allowedPaths ?? []).map(normalizePrefix).filter(Boolean),
);
const outputPrefixes = CONTROL_PLANE_OUTPUTS.map(normalizePrefix);

console.log(`Agent: ${AGENT}`);
console.log(`Active owned tasks: ${owned.map((t) => `${t.id} [${t.status}]`).join(", ") || "(none)"}`);
console.log(`Task-owned prefixes: ${taskPrefixes.join(", ") || "(none)"}`);

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
  console.error(`\nREFUSING TO COMMIT: ${rejected.length} dirty path(s) belong to no active task of ${AGENT}:`);
  for (const rel of rejected) console.error(`  ! ${rel}`);
  console.error(
    "\nAn autonomous worker must not commit files outside the task it is working on. " +
    "Either claim the task that owns them, or resolve them before the worker runs again.",
  );
  process.exit(1);
}

console.log(staged.length ? "\nAll dirty paths accounted for." : "\nNothing to commit.");
