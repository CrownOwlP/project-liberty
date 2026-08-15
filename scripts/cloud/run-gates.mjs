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

/**
 * Executors for gates this runner can actually prove.
 *
 * Gate TYPE is derived from control/quality-gates.json, never from absence
 * here. Treating "no executor" as "review gate" silently relabels an
 * unimplemented executable gate as somebody else's problem -- which is how a
 * task with integration/e2e/performance requirements would appear to pass
 * without those ever running.
 */
const EXECUTORS = {
  "repo-validate": [process.execPath, ["scripts/validate-repo.mjs"]],
  lint: ["npm", ["run", "lint"]],
  typecheck: ["npm", ["run", "typecheck"]],
  unit: ["npm", ["run", "test"]],
  build: ["npm", ["run", "build"]],
  integration: ["npm", ["run", "test", "--", "--runInBand"]],
};

const tasks = JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
const task = tasks.find((t) => t.id === TASK_ID);
if (!task) {
  console.error(`Unknown task ${TASK_ID}`);
  process.exit(1);
}

const node = (...a) => execFileSync(process.execPath, a, { cwd: root, encoding: "utf8" });

const registry = JSON.parse(
  fs.readFileSync(path.join(root, "control", "quality-gates.json"), "utf8"),
).gates;

let failed = 0;
let blocked = 0;
for (const gate of task.qualityGates ?? []) {
  const definition = registry[gate];
  if (!definition) {
    console.error(`${gate}: not defined in control/quality-gates.json; cannot classify it`);
    blocked++;
    continue;
  }

  // ONLY an explicit agent-review command is a reviewer gate.
  if (definition.command === "agent-review") {
    console.log(`${gate}: agent-review gate, left for the independent reviewer`);
    continue;
  }

  const runnable = EXECUTORS[gate];
  if (!runnable) {
    // Defined as executable or task-specific, but this runner has no way to
    // prove it. Fail closed rather than pretend it belongs to the reviewer.
    console.error(
      `${gate}: defined as "${definition.command}" but no executor is implemented. ` +
      "Blocking rather than misreporting it as a review gate.",
    );
    node(CLI, "block", TASK_ID, `gate "${gate}" (${definition.command}) has no automated executor in the cloud worker`);
    blocked++;
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

if (failed || blocked) {
  console.error(
    `\n${TASK_ID}: ${failed} gate(s) failed, ${blocked} gate(s) had no executor. ` +
    "The task is not finalized.",
  );
  process.exit(1);
}
console.log(`\nAll executable gates run and recorded for ${TASK_ID}.`);
