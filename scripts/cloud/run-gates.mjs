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
import { fileURLToPath } from "node:url";
// Gate classification and execution are shared with advance-completable.mjs.
// See scripts/cloud/gate-registry.mjs for why there is exactly one table.
import { classifyGate, runExecutableGate } from "./gate-registry.mjs";

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

/*
 * Resolved relative to THIS FILE, not to the workspace.
 *
 * When the workflow invokes the trusted copy under $RUNNER_TEMP, a hardcoded
 * "scripts/ai-control-plane.mjs" would resolve against cwd and pull the
 * workspace copy back in -- so the trusted runner would record its gate results
 * through code the model could have rewritten. Sibling resolution keeps a
 * trusted invocation trusted all the way down, and behaves identically when run
 * from the workspace during local testing.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "ai-control-plane.mjs");

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
  const classification = classifyGate(gate, registry);

  if (classification.kind === "undefined") {
    console.error(`${gate}: ${classification.reason}`);
    blocked++;
    continue;
  }

  if (classification.kind === "review") {
    console.log(`${gate}: ${classification.reason}`);
    continue;
  }

  if (classification.kind === "unimplemented") {
    // Defined as executable or task-specific, but nothing here can prove it.
    // Fail closed rather than pretend it belongs to the reviewer.
    console.error(`${gate}: ${classification.reason}`);
    node(
      CLI,
      "block",
      TASK_ID,
      `gate "${gate}" (${classification.definition.command}) has no automated executor in the cloud worker`,
    );
    blocked++;
    continue;
  }

  const result = runExecutableGate(classification.executor, {
    cwd: root,
    source: "deterministic gate runner",
  });
  node(CLI, "gate", TASK_ID, gate, result.passed ? "pass" : "fail", result.evidence);
  if (result.passed) {
    console.log(`${gate}: pass`);
  } else {
    console.error(`${gate}: FAIL (${result.label})`);
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
