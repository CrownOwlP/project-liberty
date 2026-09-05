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
import { listMessages, listJournal } from "../agent-bus.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
// A `--`-prefixed token is the next FLAG, not this flag's value: without the
// guard, `--worker --phase build` reads back as `worker.active === "--phase"`
// and the snapshot names a worker that does not exist. Same rule, same shape,
// as `agent-dispatcher.mjs`.
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

function readJson(rel, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); } catch { return fallback; }
}
function git(...a) {
  try {
    return execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

// The `readJson` fallback only covers an unreadable or unparseable file. A file
// that parses to something without a `tasks` array -- `{}`, `null`, a bare list
// -- would still yield `undefined` here and throw on the first `.filter` below,
// so the SHAPE is defaulted separately from the read.
const tasks = readJson("control/tasks.json", {})?.tasks ?? [];
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

// Outputs live under control/ and docs/, which PL-AI-0002 owns. coordination/
// belongs to PL-AI-0001, so writing there would put the orchestrator outside
// its own allowedPaths.
const outFile = path.join(root, "control", "mission-control.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + "\n");

/**
 * Phone-readable view.
 *
 * GitHub renders Markdown well on mobile, so committing this alongside the JSON
 * gives a watchable dashboard with no hosting, no build step and no auth beyond
 * the repository itself.
 */
function renderMarkdown(s) {
  const bar = (pct) => "█".repeat(Math.round(pct / 5)).padEnd(20, "░");
  const rows = (items, render, empty) =>
    items.length ? items.map(render).join("\n") : `_${empty}_`;

  return [
    "# Project Liberty — Mission Control",
    "",
    `> Generated ${s.generatedAt} · regenerated automatically by each cloud worker.`,
    "",
    // Provenance, in the page itself.
    //
    // This file has been read as a status report and believed while it was
    // months out of date, because nothing on the page said what would make it
    // move. The timestamp above is the last time the generator RAN -- not the
    // last time any of these facts changed -- and the generator only runs when
    // a cloud worker runs or somebody invokes it by hand. So a stale page is
    // not a stale system; it is an absent worker, and the two need different
    // responses.
    //
    // The regeneration command is printed rather than described because the
    // outputs are committed: a reader who spots stale data can fix it, and the
    // fix is one command they should not have to go looking for.
    "> **Generated file — do not edit.** `scripts/cloud/mission-control-status.mjs` writes this",
    "> and `control/mission-control.json` from committed state; any hand edit is overwritten on the",
    "> next run. The timestamp above is when the generator last ran, not when the project last",
    "> changed: if it predates the head commit, no worker has refreshed this since. Regenerate with",
    "> `node scripts/cloud/mission-control-status.mjs --worker <agentId> --phase <phase>`.",
    "",
    // `Run: local` below is emitted whenever GITHUB_RUN_ID is unset, so it is
    // also the tell for "this snapshot did not come from GitHub Actions".
    "> **`Run: local`** means the snapshot was produced outside GitHub Actions. A hosted worker run",
    "> records its run URL instead.",
    "",
    `## Progress — ${s.progress.done}/${s.progress.total} tasks (${s.progress.percent}%)`,
    "",
    "```",
    `${bar(s.progress.percent)} ${s.progress.percent}%`,
    "```",
    "",
    "## Right now",
    "",
    `- **Worker:** ${s.worker.active} — *${s.worker.phase}*`,
    s.worker.runUrl ? `- **Run:** ${s.worker.runUrl}` : "- **Run:** local",
    `- **Commit:** \`${(s.commit.sha ?? "unknown").slice(0, 12)}\` ${s.commit.subject ?? ""}`,
    `- **Next up:** ${s.nextSelectedTask ? `${s.nextSelectedTask.taskId} → ${s.nextSelectedTask.assignedTo}` : "nothing dispatchable"}`,
    `- **Ready queue:** ${s.readyCount}`,
    "",
    "## In flight",
    "",
    rows(s.currentTasks, (t) => `- **${t.id}** [${t.status}] ${t.title} — ${t.owner ?? "unassigned"}`, "No tasks are active."),
    "",
    "## Waiting on GPT review",
    "",
    rows(s.pendingGptReview, (m) => `- **${m.taskId}** @ \`${(m.commitSha ?? "").slice(0, 12)}\` — since ${m.createdAt}`, "Nothing awaiting review."),
    "",
    "## Waiting on Claude rework",
    "",
    rows(s.pendingClaudeRework, (t) => `- **${t.taskId}** — changes requested by ${t.reviewer}`, "No rework outstanding."),
    "",
    "## Blocked",
    "",
    rows(s.blockers, (b) => `- **${b.id}** ${b.title}\n  - ${b.reason}`, "Nothing blocked."),
    "",
    "## Recovery",
    "",
    `- **Durable journal:** ${s.recovery.durableJournal ? "yes (cloud mode)" : "no (local checkout only)"}`,
    rows(s.recovery.inFlight, (e) => `- ⚠️ **${e.messageId}** stuck in ${e.state} (claimed by ${e.claimedBy})`, "No interrupted transactions."),
    "",
    "## Quarantined messages",
    "",
    rows(s.quarantined, (q) => `- \`${q.messageId}\` — ${q.reason}`, "None."),
    "",
    "## Last autonomous transition",
    "",
    s.lastSuccessfulTransition
      ? "```json\n" + JSON.stringify(s.lastSuccessfulTransition, null, 2) + "\n```"
      : "_No autonomous transition recorded yet._",
    ""
  ].join("\n");
}

fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "MISSION_CONTROL.md"), renderMarkdown(snapshot));
console.log(`Mission control snapshot written: ${done.length}/${snapshot.progress.total} done, ` +
  `${pendingGptReview.length} awaiting GPT, ${pendingClaudeRework.length} awaiting rework, ${blocked.length} blocked.`);
