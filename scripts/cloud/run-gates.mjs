#!/usr/bin/env node
/**
 * Deterministic post-model gate execution.
 *
 * Recording a gate is an assertion that a command actually ran and passed. If
 * the model can write gate results, the evidence is only as trustworthy as the
 * model's self-report -- and a completion path that trusts an already-recorded
 * pass turns that self-report into completion evidence.
 *
 * So: this runs every runnable gate ITSELF and records the real outcome. It
 * always re-runs, never trusting a pre-existing "pass". Review-only gates
 * (architecture-review, security-review, rights-review) are left for the
 * independent reviewer.
 *
 * Usage: node scripts/cloud/run-gates.mjs --task PL-0101
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
const TASK_ID = flag("--task");
if (!TASK_ID) {
  console.error("Usage: run-gates.mjs --task <taskId>");
  process.exit(1);
}

const CLI = "scripts/ai-control-plane.mjs";

/** Gate -> the command that proves it. Anything absent is a review gate. */
const RUNNABLE = {
  "repo-validate": [process.execPath, ["scripts/validate-repo.mjs"]],
  lint: ["npm", ["run", "lint"]],
  typecheck: ["npm", ["run", "typecheck"]],
  unit: ["npm", ["run", "test"]],
  build: ["npm", ["run", "build"]],
};

const tasks = JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
const task = tasks.find((t) => t.id === TASK_ID);
if (!task) {
  console.error(`Unknown task ${TASK_ID}`);
  process.exit(1);
}

const node = (...a) => execFileSync(process.execPath, a, { cwd: root, encoding: "utf8" });

let failed = 0;
for (const gate of task.qualityGates ?? []) {
  const runnable = RUNNABLE[gate];
  if (!runnable) {
    console.log(`${gate}: review gate, left for the independent reviewer`);
    continue;
  }

  const [cmd, cmdArgs] = runnable;
  const bin = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  const label = `${cmd} ${cmdArgs.join(" ")}`;

  // Always re-run. A pre-existing "pass" is exactly what an untrusted writer
  // would leave behind, so it is never accepted as evidence.
  try {
    execFileSync(bin, cmdArgs, { cwd: root, encoding: "utf8", stdio: "pipe" });
    node(CLI, "gate", TASK_ID, gate, "pass", `${label} exit 0 (deterministic gate runner)`);
    console.log(`${gate}: pass`);
  } catch (error) {
    node(CLI, "gate", TASK_ID, gate, "fail", `${label} exit ${error.status ?? "non-zero"} (deterministic gate runner)`);
    console.error(`${gate}: FAIL (${label})`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} gate(s) failed for ${TASK_ID}. The task stays IN_PROGRESS and is not finalized.`);
  process.exit(1);
}
console.log(`\nAll runnable gates recorded for ${TASK_ID}.`);
