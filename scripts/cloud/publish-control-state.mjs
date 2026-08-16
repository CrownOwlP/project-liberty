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

// The workspace must be free of persisted credentials before this process does
// anything, not merely at push time -- if one is already there, the model step
// that follows in this same checkout could read it.
assertNoPersistedCredential(root, "before publishing control state");

git("config", "user.name", `liberty-${AGENT}[bot]`);
git("config", "user.email", `${AGENT}@project-liberty.local`);

// Sibling resolution, not cwd: see the note in run-gates.mjs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const stageArgs = [path.join(HERE, "stage-task-changes.mjs"), "--agent", AGENT, "--mode", "control"];
if (TASK_ID) stageArgs.push("--task", TASK_ID);

try {
  console.log(node(...stageArgs));
} catch (error) {
  console.error(error.stdout ?? "");
  console.error(error.stderr ?? "");
  console.error("Control-state staging rejected the working tree; nothing published.");
  process.exit(1);
}

/**
 * Reports whether anything was actually published, so a workflow can chain on
 * it without re-deriving the answer from git. Emitted by the publisher rather
 * than by inline shell in each workflow: two places computing "did we push?"
 * is how they end up disagreeing.
 */
function reportChanged(changed) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
}

if (!git("diff", "--cached", "--name-only").trim()) {
  console.log("No control-plane state to publish.");
  reportChanged(false);
  process.exit(0);
}

git("commit", "-m", `${TASK_ID ? `${TASK_ID}: ` : ""}${REASON} (autonomous ${AGENT})`);

fetchMain(root);
if (!remoteIsAncestorOfHead(root)) {
  console.error(
    "Remote main has diverged from HEAD. Nothing pushed; refusing to rewrite reviewed history.",
  );
  process.exit(1);
}
pushHeadToMain(root);
reportChanged(true);

console.log(
  `Published control state: ${REASON}. The model's implementation changes were NOT committed.`,
);
