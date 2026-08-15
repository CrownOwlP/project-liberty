#!/usr/bin/env node
/**
 * Mission Control feed.
 *
 * Writes coordination/mission-control.json: a single phone-readable snapshot of
 * what the autonomous system is doing. Derived entirely from committed state, so
 * it is accurate for anyone who pulls the repo and needs no live connection.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { listMessages, listJournal, readRejection } from "../agent-bus.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

function readJson(rel, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); } catch { return fallback; }
}
function git(...a) {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

const tasks = readJson("control/tasks.json", { tasks: [] }).tasks;
const events = (() => {
  try {
    return fs.readFileSync(path.join(root, "control/events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
})();

const active = tasks.filter((t) => ["CLAIMED", "IN_PROGRESS", "REVIEW"].includes(t.status));
const blocked = tasks.filter((t) => t.status === "BLOCKED");
const done = tasks.filter((t) => t.status === "DONE");
const ready = tasks.filter((t) => t.status === "READY");

const pendingGptReview = listMessages(root, { toAgent: "gpt-architect" })
  .filter((m) => ["review_request", "implementation_ready"].includes(m.type))
  .map((m) => ({ id: m.id, taskId: m.taskId, commitSha: m.commitSha, createdAt: m.createdAt }));

const pendingClaudeRework = tasks
  .filter((t) => t.review?.outcome === "CHANGES_REQUESTED")
  .map((t) => ({ taskId: t.id, reviewer: t.review.reviewerAgent, summary: t.review.evidence }));

const inFlight = listJournal(root)
  .filter((e) => !(e.state === "ACKNOWLEDGED" && e.eventsEmitted === true))
  .map((e) => ({ messageId: e.messageId, state: e.state, claimedBy: e.claimedBy }));

const lastTransition = [...events].reverse()
  .find((e) => ["task.done", "task.review_recorded", "bus.message_processed"].includes(e.type)) ?? null;

const rejections = (() => {
  const dir = path.join(root, "coordination/agent-bus/rejections");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => {
    const r = readJson(`coordination/agent-bus/rejections/${n}`);
    return r ? { messageId: r.messageId, reason: r.reason, at: r.rejectedAt } : null;
  }).filter(Boolean);
})();

/** The task the orchestrator would pick next, straight from the dispatcher. */
function nextSelectedTask() {
  try {
    const out = execFileSync(process.execPath, ["scripts/ai-control-plane.mjs", "dispatch"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    });
    const line = out.split("\n").find((l) => / -> /.test(l));
    if (!line) return null;
    const [taskId, rest] = line.split(" -> ");
    return { taskId: taskId.trim(), assignedTo: rest.split(" ")[0].trim() };
  } catch { return null; }
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  worker: {
    active: flag("--worker", "none"),
    phase: flag("--phase", "idle"),
    runId: process.env.GITHUB_RUN_ID ?? null,
    runUrl: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null
  },
  progress: {
    done: done.length,
    total: tasks.filter((t) => t.status !== "CANCELED").length,
    percent: tasks.length ? Math.round((done.length / tasks.filter((t) => t.status !== "CANCELED").length) * 100) : 0
  },
  currentTasks: active.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner })),
  pendingGptReview,
  pendingClaudeRework,
  nextSelectedTask: nextSelectedTask(),
  readyCount: ready.length,
  blockers: blocked.map((t) => ({ id: t.id, title: t.title, reason: t.blocker })),
  commit: {
    sha: git("rev-parse", "HEAD"),
    subject: git("log", "-1", "--pretty=%s"),
    committedAt: git("log", "-1", "--pretty=%cI")
  },
  ci: {
    // Populated by the workflow; null locally.
    conclusion: process.env.LIBERTY_CI_CONCLUSION ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null
  },
  lastSuccessfulTransition: lastTransition,
  recovery: { inFlight, durableJournal: Boolean(process.env.LIBERTY_JOURNAL_DIR) },
  quarantined: rejections
};

const outFile = path.join(root, "coordination", "mission-control.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`Mission control snapshot written: ${done.length}/${snapshot.progress.total} done, ` +
  `${pendingGptReview.length} awaiting GPT, ${pendingClaudeRework.length} awaiting rework, ${blocked.length} blocked.`);
