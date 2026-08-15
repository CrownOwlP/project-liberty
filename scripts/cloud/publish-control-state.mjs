#!/usr/bin/env node
/**
 * Durable publication of control-plane state ONLY.
 *
 * Used when a run ends without finalizing a task -- a failed gate, a gate with
 * no executor, a blocked task. Those transitions exist only in the ephemeral
 * runner's checkout; if the job exits without pushing them, remote `main` never
 * learns the task failed, the scheduler selects it again, and the same failure
 * repeats forever.
 *
 * Deliberately narrow: it stages control-mode state only. The model's
 * implementation dirt is tolerated but NEVER committed, because unreviewed
 * implementation must not reach `main` on a failure path.
 *
 * Usage: node scripts/cloud/publish-control-state.mjs --agent claude-lead --task PL-0101 --reason "gate failure"
 */
import { execFileSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const AGENT = flag("--agent");
const TASK_ID = flag("--task");
const REASON = flag("--reason") || "control-plane state";
if (!AGENT) {
  console.error("Usage: publish-control-state.mjs --agent <agentId> [--task <taskId>] [--reason <text>]");
  process.exit(1);
}

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const node = (...a) => execFileSync(process.execPath, a, { cwd: root, encoding: "utf8" });

git("config", "user.name", `liberty-${AGENT}[bot]`);
git("config", "user.email", `${AGENT}@project-liberty.local`);

const stageArgs = ["scripts/cloud/stage-task-changes.mjs", "--agent", AGENT, "--mode", "control"];
if (TASK_ID) stageArgs.push("--task", TASK_ID);

try {
  console.log(node(...stageArgs));
} catch (error) {
  console.error(error.stdout ?? "");
  console.error(error.stderr ?? "");
  console.error("Control-state staging rejected the working tree; nothing published.");
  process.exit(1);
}

if (!git("diff", "--cached", "--name-only").trim()) {
  console.log("No control-plane state to publish.");
  process.exit(0);
}

git("commit", "-m", `${TASK_ID ? `${TASK_ID}: ` : ""}${REASON} (autonomous ${AGENT})`);

git("fetch", "origin", "main");
try {
  execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: root, stdio: "ignore" });
} catch {
  console.error(
    "origin/main has diverged from HEAD. Nothing pushed; refusing to rewrite reviewed history.",
  );
  process.exit(1);
}
git("push", "origin", "HEAD:main");

console.log(
  `Published control state: ${REASON}. The model's implementation changes were NOT committed.`,
);
