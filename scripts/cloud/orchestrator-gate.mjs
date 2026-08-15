#!/usr/bin/env node
/**
 * PL-AI-0002 activation gate.
 *
 * The cloud workflow files land on main BEFORE PL-AI-0002 is claimable, so they
 * must be dormant until the control plane actually permits orchestrator work.
 * This gate is the guard. It never bypasses dependency or state enforcement --
 * it reads the same control/tasks.json the CLI does and reports what is allowed.
 *
 * Three distinct permissions, because collapsing them deadlocks the system:
 *
 *   review        GPT may review anything legitimately in REVIEW. Always open:
 *                 PL-AI-0001 cannot reach DONE without its own review, and
 *                 gating that on PL-AI-0001 being DONE is circular.
 *   complete      Deterministic control-plane advancement of an already-approved
 *                 task (record real gates, then done). No model, no new work.
 *   orchestrate   Autonomous implementation of NEW work, i.e. PL-AI-0002 itself.
 *                 Closed until PL-AI-0001 is DONE and PL-AI-0002 is claimable.
 *
 * Exits 0 even when closed: a dormant scheduled run is not a failure.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const tasks = JSON.parse(fs.readFileSync(path.join(root, "control", "tasks.json"), "utf8")).tasks;
const byId = (id) => tasks.find((t) => t.id === id);

const bootstrap = byId("PL-AI-0001");
const orchestrator = byId("PL-AI-0002");

/*
 * "The system is installed" is a DURABLE condition, not a transient one.
 *
 * Gating orchestration on PL-AI-0002 being *in progress* would switch the
 * autonomous system off the moment its own bootstrap task completed -- the
 * factory would shut down exactly when it became ready to run. The condition is
 * therefore both bootstrap tasks being DONE, which stays true forever after.
 */
const reasons = [];
if (!bootstrap) reasons.push("PL-AI-0001 is missing from the control plane");
if (!orchestrator) reasons.push("PL-AI-0002 is missing from the control plane");

const bootstrapDone = bootstrap?.status === "DONE";
if (!bootstrapDone) reasons.push(`PL-AI-0001 is ${bootstrap?.status ?? "unknown"}, not DONE`);

const orchestratorDone = orchestrator?.status === "DONE";
if (!orchestratorDone) {
  reasons.push(
    `PL-AI-0002 is ${orchestrator?.status ?? "unknown"}, not DONE; ` +
    "the orchestrator stays dormant until its own bootstrap is reviewed and complete",
  );
}

// Anything sitting in REVIEW keeps the review lane open regardless of the gate.
const awaitingReview = tasks.filter((t) => t.status === "REVIEW");
// Anything approved and waiting only on deterministic completion.
const completable = tasks.filter((t) => t.status === "REVIEW" && t.review?.outcome === "APPROVED");

const decision = {
  review: true,
  complete: completable.length > 0,
  orchestrate: Boolean(bootstrapDone && orchestratorDone),
  bootstrapStatus: bootstrap?.status ?? null,
  orchestratorStatus: orchestrator?.status ?? null,
  awaitingReview: awaitingReview.map((t) => t.id),
  completable: completable.map((t) => t.id),
  reasons
};

if (process.env.GITHUB_OUTPUT) {
  const out = [
    `review=${decision.review}`,
    `complete=${decision.complete}`,
    `orchestrate=${decision.orchestrate}`,
    `reason=${reasons.join("; ") || "all gates open"}`
  ].join("\n");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, out + "\n");
}

console.log(JSON.stringify(decision, null, 2));
if (!decision.orchestrate) {
  console.log(`\nOrchestrator DORMANT: ${reasons.join("; ")}`);
  console.log("Review and deterministic completion remain available so the bootstrap task can finish.");
} else {
  console.log("\nOrchestrator ACTIVE.");
}
