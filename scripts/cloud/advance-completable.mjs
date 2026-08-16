#!/usr/bin/env node
/**
 * Deterministic completion of already-approved tasks.
 *
 * A task that is in REVIEW with an APPROVED independent review still needs its
 * required gates recorded before it can reach DONE. Those gates are either real
 * commands (run them, record the outcome) or agent reviews (already satisfied by
 * the approval that arrived over the bus).
 *
 * This runs WITHOUT a model, so PL-AI-0001 can finish and unblock PL-AI-0002
 * while the orchestrator is still dormant.
 *
 * It never fabricates evidence: a gate command that fails is recorded as `fail`
 * and the task is left in REVIEW.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Same classification and executors run-gates.mjs uses. These two used to keep
// separate tables and drifted; see scripts/cloud/gate-registry.mjs.
import { classifyGate, runExecutableGate } from "./gate-registry.mjs";

const root = process.cwd();
// Sibling resolution, not cwd: see the note in run-gates.mjs. A trusted copy
// invoked from $RUNNER_TEMP must reach the trusted control plane, not the
// workspace one.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "ai-control-plane.mjs");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}
function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
}

const gates = readJson("control/quality-gates.json").gates;
const tasks = readJson("control/tasks.json").tasks;

const candidates = tasks.filter((t) => t.status === "REVIEW" && t.review?.outcome === "APPROVED");
if (!candidates.length) {
  console.log("No approved tasks are awaiting deterministic completion.");
  process.exit(0);
}

let completed = 0;
let stalled = 0;

for (const task of candidates) {
  console.log(`\n=== Completing ${task.id} (approved by ${task.review.reviewerAgent}) ===`);
  let ok = true;

  for (const gate of task.qualityGates ?? []) {
    const classification = classifyGate(gate, gates);

    // An agent-review gate is satisfied by the independent review itself. The
    // evidence cites that review record rather than asserting a test ran.
    if (classification.kind === "review") {
      const evidence = `independent review by ${task.review.reviewerAgent} at ` +
        `${String(task.review.reviewedCommitSha).slice(0, 12)}: ${task.review.evidence}`;
      cli("gate", task.id, gate, "pass", evidence.slice(0, 500));
      console.log(`  ${gate}: pass (review-backed)`);
      continue;
    }

    if (classification.kind === "executable") {
      // Deliberately does NOT skip an already-recorded pass. Trusting a recorded
      // result makes it completion evidence without this process ever proving the
      // command ran -- which is exactly what an untrusted writer would exploit.
      const result = runExecutableGate(classification.executor, {
        cwd: root,
        source: "autonomous worker"
      });
      cli("gate", task.id, gate, result.passed ? "pass" : "fail", result.evidence);
      if (result.passed) {
        console.log(`  ${gate}: pass`);
      } else {
        console.error(`  ${gate}: FAIL - ${result.evidence}`);
        ok = false;
      }
      continue;
    }

    // `undefined` or `unimplemented`. Fail closed and say which, so the reason a
    // task is stuck is visible rather than inferred.
    console.error(`  ${gate}: ${classification.reason}`);
    console.error(`  leaving ${task.id} in REVIEW`);
    ok = false;
  }

  if (!ok) {
    stalled++;
    continue;
  }

  try {
    console.log(cli("done", task.id).trim());
    // Unlock dependents immediately so the next wave can be dispatched.
    cli("sync");
    completed++;
  } catch (error) {
    console.error(`  cannot complete ${task.id}: ${error.stderr || error.message}`);
    stalled++;
  }
}

console.log(`\nCompleted ${completed} task(s)${stalled ? `, ${stalled} still blocked` : ""}.`);
