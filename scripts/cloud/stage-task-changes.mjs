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

/**
 * Classify without staging, and fail if anything is out of scope.
 *
 * WHY THIS MODE EXISTS. Allowed-path enforcement used to happen only inside the
 * finalizer -- which runs AFTER the deterministic gate runner. So this was
 * still possible:
 *
 *   model rewrites root package.json  ("test": "<anything>")
 *     -> run-gates executes `npm run test`
 *       -> the rewritten script runs
 *         -> finalizer rejects package.json, far too late
 *
 * That is the npm-script trampoline again, relocated from the model step into
 * the gate step. Removing Bash from the model did nothing about it, because the
 * command is executed by a trusted step reading an untrusted file.
 *
 * Run from the trusted store immediately after the restore and BEFORE any
 * workspace-derived command, this refuses the checkout while the sentinel is
 * still inert. Because both staging passes happen later in the run, anything in
 * EITHER category is acceptable here; only a path in neither is a problem.
 */
const CHECK_ONLY = args.includes("--check-only");

const ACTIVE = ["CLAIMED", "IN_PROGRESS", "REVIEW"];

/**
 * Outputs produced by deterministic control-plane and bus operations.
 *
 * Imported from the shared source so this set and the guard's protected set
 * cannot drift. A path committable here but unprotected there is a path where
 * a model edit survives and gets committed as deterministic state.
 */
import { CONTROL_OUTPUT_PATHS as CONTROL_PLANE_OUTPUTS } from "./control-paths.mjs";

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

/*
 * Three categories, not two.
 *
 * A single run legitimately produces BOTH kinds of dirt: select/start, mission
 * control and the gate runner mutate control state, while the model mutates the
 * task's own files. Each staging pass must commit its own category, leave the
 * other alone for the pass that owns it, and still refuse anything unexpected.
 *
 * Treating the other category as "unexpected" is what made the first ordinary
 * autonomous task impossible to finalize.
 */
// allowedPaths, never the reviewed surface: staging is a write. A declared
// reviewDependency was reserved by no collision check, so another lane may be
// editing it right now, and committing it here would put that lane's work in
// this task's commit with neither of them owning it.
const allTaskPrefixes = owned
  .flatMap((t) => (t.allowedPaths ?? []).map(normalizePrefix))
  .filter(Boolean);
const allOutputPrefixes = CONTROL_PLANE_OUTPUTS.map(normalizePrefix);

const stagePrefixes = MODE === "implementation" ? allTaskPrefixes : allOutputPrefixes;
const toleratePrefixes = MODE === "implementation" ? allOutputPrefixes : allTaskPrefixes;

console.log(`Agent: ${AGENT} | mode: ${MODE}`);
console.log(`Scoped tasks: ${owned.map((t) => `${t.id} [${t.status}]`).join(", ") || "(none)"}`);
console.log(`Stage: ${stagePrefixes.join(", ") || "(none)"}`);
console.log(`Tolerate (left for the other pass): ${toleratePrefixes.join(", ") || "(none)"}`);

// `-z` and NUL splitting: filenames can contain spaces, and a quoted path would
// otherwise be staged under the wrong name.
const dirty = git("status", "--porcelain", "-z", "--untracked-files=all")
  .split("\0")
  .filter(Boolean)
  .map((entry) => entry.slice(3))
  .filter(Boolean);

const staged = [];
const tolerated = [];
const rejected = [];
for (const rel of dirty) {
  if (stagePrefixes.some((p) => underPrefix(rel, p))) staged.push(rel);
  else if (toleratePrefixes.some((p) => underPrefix(rel, p))) tolerated.push(rel);
  else rejected.push(rel);
}

if (CHECK_ONLY) {
  if (rejected.length) {
    console.error(
      `\nOUT-OF-SCOPE EDITS (${rejected.length}). Refusing to run any workspace-derived command:`,
    );
    for (const rel of rejected) console.error(`  ! ${rel}`);
    console.error(
      "\nThese belong to no active task's allowedPaths and to no deterministic control output. " +
      "The gate runner would execute definitions read from the workspace -- root package.json " +
      "scripts, config files, test setup -- so an out-of-scope edit must stop the job BEFORE the " +
      "gates, not be rejected by the finalizer after they have already run it.",
    );
    process.exit(1);
  }
  console.log(
    `\nAll ${staged.length + tolerated.length} dirty path(s) are in scope ` +
    "(task allowedPaths or deterministic control outputs). Safe to run the gates.",
  );
  process.exit(0);
}

for (const rel of staged) git("add", "--", rel);

console.log(`\nStaged ${staged.length} file(s):`);
for (const rel of staged) console.log(`  + ${rel}`);
if (tolerated.length) {
  console.log(`\nLeft for the other staging pass (${tolerated.length}):`);
  for (const rel of tolerated) console.log(`  ~ ${rel}`);
}

if (rejected.length) {
  console.error(`\nREFUSING TO COMMIT (${MODE} mode): ${rejected.length} dirty path(s) are not stageable here:`);
  for (const rel of rejected) console.error(`  ! ${rel}`);
  console.error(
    MODE === "implementation"
      ? "\nImplementation staging commits ONLY the selected task's allowedPaths, and leaves deterministic " +
        "control/bus outputs for the control pass. A path in neither set belongs to no task at all."
      : "\nControl staging commits ONLY the enumerated control-plane and bus outputs, and leaves the " +
        "selected task's implementation files for the implementation pass.",
  );
  process.exit(1);
}

console.log(staged.length ? "\nAll dirty paths accounted for." : "\nNothing to commit.");
