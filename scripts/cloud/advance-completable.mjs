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

const root = process.cwd();
const CLI = "scripts/ai-control-plane.mjs";

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}
function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8" });
}

const gates = readJson("control/quality-gates.json").gates;
const tasks = readJson("control/tasks.json").tasks;

/** Gate command -> how to actually run it. Anything absent is agent-review. */
const RUNNABLE = {
  "repo-validate": ["node", "scripts/validate-repo.mjs"],
  lint: ["npm", "run", "lint"],
  typecheck: ["npm", "run", "typecheck"],
  unit: ["npm", "run", "test"],
  build: ["npm", "run", "build"]
};

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
    if (task.gateResults?.[gate]?.status === "pass") {
      console.log(`  ${gate}: already recorded`);
      continue;
    }

    const runnable = RUNNABLE[gate];
    if (runnable) {
      const [cmd, ...args] = runnable;
      const shell = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
      try {
        execFileSync(shell, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
        cli("gate", task.id, gate, "pass", `${runnable.join(" ")} exit 0 (autonomous worker)`);
        console.log(`  ${gate}: pass`);
      } catch (error) {
        const detail = `${runnable.join(" ")} exit ${error.status ?? "non-zero"}`;
        cli("gate", task.id, gate, "fail", detail);
        console.error(`  ${gate}: FAIL - ${detail}`);
        ok = false;
      }
      continue;
    }

    // An agent-review gate is satisfied by the independent review itself. The
    // evidence cites that review record rather than asserting a test ran.
    if (gates[gate]?.command === "agent-review") {
      const evidence = `independent review by ${task.review.reviewerAgent} at ` +
        `${String(task.review.reviewedCommitSha).slice(0, 12)}: ${task.review.evidence}`;
      cli("gate", task.id, gate, "pass", evidence.slice(0, 500));
      console.log(`  ${gate}: pass (review-backed)`);
      continue;
    }

    console.error(`  ${gate}: no automated evidence available; leaving ${task.id} in REVIEW`);
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
