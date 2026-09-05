#!/usr/bin/env node
/**
 * Deterministic pre-model task selection.
 *
 * Claiming and starting a task are control-plane MUTATIONS and must not be
 * reachable by the model. This selects exactly one dispatchable task, claims and
 * starts it through the CLI, and emits the task id for the model step to work on.
 *
 * Priority: a task already IN_PROGRESS for this agent (rework after
 * changes_requested comes first), otherwise the top of the dispatchable wave.
 *
 * Usage: node scripts/cloud/select-task.mjs --agent claude-lead
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
// The orchestration guard used to live in this file. It now has a second caller
// (`agent-dispatcher.mjs`), and two copies of the rule that decides what an
// agent may autonomously write is exactly the drift this repository has been
// bitten by before. Behaviour is unchanged; see orchestration-surface.mjs,
// which carries the original reasoning verbatim.
import { touchesOrchestration } from "./orchestration-surface.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const i = args.indexOf("--agent");
const AGENT = i >= 0 ? args[i + 1] : null;

const CLI = "scripts/ai-control-plane.mjs";
const node = (...a) => execFileSync(process.execPath, a, { cwd: root, encoding: "utf8" });
const tasks = () =>
  JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;

function emit(taskId, note) {
  console.log(note);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `task=${taskId ?? ""}\nselected=${taskId ? "true" : "false"}\n`);
  }
}

/**
 * `process.exitCode`, never `process.exit()`.
 *
 * `process.exit()` terminates before a piped stdout has necessarily flushed on
 * Windows, which this repository has already been bitten by: the output is
 * truncated and the truncation looks like the program having produced less.
 * That is exactly this file's hazard -- every early return below has just run
 * `emit()`, which both writes stdout and appends to GITHUB_OUTPUT. Setting the
 * code and returning out of `main()` lets Node drain normally. The same rule,
 * and the same reasoning, is stated in `agent-dispatcher.mjs`.
 */
function main() {
  if (!AGENT) {
    console.error("Usage: select-task.mjs --agent <agentId>");
    process.exitCode = 1;
    return;
  }

  // 1. Rework first: a task sent back by changes_requested is already IN_PROGRESS.
  const inProgress = tasks().filter((t) => t.owner === AGENT && t.status === "IN_PROGRESS");
  if (inProgress.length > 1) {
    console.error(
      `${AGENT} owns ${inProgress.length} IN_PROGRESS tasks: ${inProgress.map((t) => t.id).join(", ")}. ` +
      "A run finalizes exactly one task so a commit maps to exactly one review. Resolve this first.",
    );
    process.exitCode = 1;
    return;
  }
  if (inProgress.length === 1) {
    const blocked = touchesOrchestration(inProgress[0]);
    if (blocked.length) {
      emit(
        null,
        `${inProgress[0].id} owns orchestration paths (${blocked.join(", ")}) and cannot be worked ` +
        "autonomously. It requires the privileged review-before-main lane.",
      );
      process.exitCode = 0;
      return;
    }
    emit(inProgress[0].id, `Continuing ${inProgress[0].id}: ${inProgress[0].title}`);
    process.exitCode = 0;
    return;
  }

  // 2. Otherwise take the head of the dispatchable wave.
  const dispatch = node(CLI, "dispatch");
  const candidates = dispatch
    .split("\n")
    .filter((l) => new RegExp(`-> ${AGENT}\\b`).test(l))
    .map((l) => l.trim().split(" ")[0]);

  const all = tasks();
  const skipped = [];
  let taskId = null;
  for (const id of candidates) {
    const candidate = all.find((t) => t.id === id);
    const blocked = candidate ? touchesOrchestration(candidate) : [];
    if (blocked.length) {
      skipped.push(`${id} (${blocked.join(", ")})`);
      continue;
    }
    taskId = id;
    break;
  }

  if (skipped.length) {
    console.log(
      `Skipped, requires the privileged review-before-main lane: ${skipped.join("; ")}`,
    );
  }
  if (!taskId) {
    emit(null, `No autonomously workable task for ${AGENT}. Nothing to implement this run.`);
    process.exitCode = 0;
    return;
  }

  node(CLI, "claim", taskId, AGENT);
  node(CLI, "start", taskId, AGENT);
  const started = tasks().find((t) => t.id === taskId);
  emit(taskId, `Claimed and started ${taskId}: ${started?.title ?? ""}`);
}

main();
