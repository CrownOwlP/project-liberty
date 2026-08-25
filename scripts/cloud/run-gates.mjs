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
  console.error("Usage: run-gates.mjs --task <taskId> [--execute-only | --record-only --evidence <text>]");
  process.exit(1);
}

/**
 * Executing gates and recording gates now happen in DIFFERENT JOBS, so they are
 * different modes.
 *
 *   --execute-only  Runs every executable gate and exits non-zero if any fails.
 *                   Records nothing. This runs in the gate job, which holds no
 *                   secret and no write token, because executing a gate means
 *                   executing model-authored code.
 *
 *   --record-only   Records the outcome without running anything. This runs in
 *                   the publisher job, which holds the write token and executes
 *                   no model-authored code.
 *
 * The obvious objection is that recording without running is exactly the
 * fabrication this system forbids. It is not, and the distinction is the whole
 * design: the publisher runs `if: success()` against the gate JOB, and a job's
 * conclusion is determined by GitHub from step exit codes. Model-authored code
 * cannot write it. Had the gate job instead emitted a results FILE, that file
 * would be an artifact produced by a runner where untrusted code executed, and
 * trusting it would be trusting the thing under test.
 *
 * What this does NOT claim: that the gates cannot be made to pass. The model
 * writes the tests, so of course it can write a passing one. Gate execution is
 * evidence that the declared checks ran and exited zero -- never evidence that
 * the change is correct. Independent review is what covers correctness, which
 * is why no task reaches DONE without it.
 */
const EXECUTE_ONLY = args.includes("--execute-only");
const RECORD_ONLY = args.includes("--record-only");
if (EXECUTE_ONLY && RECORD_ONLY) {
  console.error("--execute-only and --record-only are mutually exclusive.");
  process.exit(1);
}
const RECORD_EVIDENCE = flag("--evidence");
if (RECORD_ONLY && !RECORD_EVIDENCE) {
  console.error(
    "--record-only requires --evidence naming the job whose conclusion is being recorded. " +
    "Evidence that does not identify what was run is not evidence."
  );
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
/*
 * Set once this run has moved the task to BLOCKED.
 *
 * The control plane only accepts a gate result while a task is IN_PROGRESS or
 * REVIEW, so once the block below lands, every later `gate` call in this loop
 * would be refused -- and `node()` throws on a non-zero exit, which would kill
 * the runner before the summary at the bottom ever printed. The remaining gates
 * are still EXECUTED and reported, because knowing that three more gates would
 * also have failed is the useful part of a blocked run; only the recording is
 * skipped, since a blocked task has nowhere legitimate to put it.
 */
let taskBlockedByThisRun = false;
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
    taskBlockedByThisRun = true;
    blocked++;
    continue;
  }

  if (RECORD_ONLY) {
    // Runs nothing. The gate job already did, in isolation, and this job only
    // reaches this line when GitHub concluded that job succeeded.
    if (taskBlockedByThisRun) {
      console.error(`${gate}: not recorded; ${TASK_ID} was blocked earlier in this run`);
      continue;
    }
    node(CLI, "gate", TASK_ID, gate, "pass", `${classification.executor && ""}${RECORD_EVIDENCE}`.slice(0, 500));
    console.log(`${gate}: recorded pass (${RECORD_EVIDENCE})`);
    continue;
  }

  const result = runExecutableGate(classification.executor, {
    cwd: root,
    source: "isolated gate job",
  });

  if (!EXECUTE_ONLY && !taskBlockedByThisRun) {
    node(CLI, "gate", TASK_ID, gate, result.passed ? "pass" : "fail", result.evidence);
  }

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
