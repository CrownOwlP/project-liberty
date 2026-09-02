#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  MESSAGE_TYPES,
  acknowledge,
  advanceJournal,
  claimJournal,
  createMessage,
  findMessage,
  laneFor,
  listJournal,
  listMalformed,
  listMessages,
  readJournal,
  readRejection,
  rejectMessage,
  releaseJournal,
  validateMessage,
} from "./agent-bus.mjs";
import {
  RANGE_PERMANENT,
  RANGE_TRANSIENT,
  expectedReviewBase,
  gitAdapter,
  validateReviewRange,
} from "./review-range.mjs";
import {
  normalizePrefix,
  normalizesToRepositoryRoot,
  reviewPathspecs,
  reviewSurfaceLabel,
  reviewSurfacePatterns,
} from "./review-surface.mjs";

const root = process.cwd();
const controlDir = path.join(root, "control");
const files = {
  project: path.join(controlDir, "project.json"),
  tasks: path.join(controlDir, "tasks.json"),
  agents: path.join(controlDir, "agents.json"),
  gates: path.join(controlDir, "quality-gates.json"),
  policies: path.join(controlDir, "policies.json"),
  milestones: path.join(controlDir, "milestones.json"),
  adapters: path.join(controlDir, "adapters.json"),
  legacyReviews: path.join(controlDir, "legacy-review-fingerprints.json"),
  events: path.join(controlDir, "events.jsonl"),
  queues: path.join(controlDir, "queues"),
  statusMd: path.join(root, "coordination", "PROJECT_STATUS.md"),
  tasksMd: path.join(root, "coordination", "TASKS.md"),
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, value) {
  // Write-then-rename: a crash mid-write leaves the previous file intact rather
  // than a truncated one. Task state is the durable commit point of the bus
  // transaction, so a partial write there would be unrecoverable.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}
function now() {
  return new Date().toISOString();
}

/**
 * Audit log with exactly-once semantics.
 *
 * An event may carry a deterministic `eventId`. Emission checks the log for that
 * id first, so a crash anywhere between "event appended" and "journal marked
 * finalized" cannot produce a physical duplicate on replay: recovery recomputes
 * the same ids and finds them already present.
 *
 * Events without an id (ordinary CLI operations) are appended unconditionally.
 */
let emittedEventIds = null;
function loadEmittedEventIds() {
  if (emittedEventIds) return emittedEventIds;
  emittedEventIds = new Set();
  if (!fs.existsSync(files.events)) return emittedEventIds;
  for (const line of fs.readFileSync(files.events, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.eventId) emittedEventIds.add(parsed.eventId);
    } catch {
      /* a torn trailing line must not break emission */
    }
  }
  return emittedEventIds;
}
function event(type, details = {}, eventId = null) {
  fs.mkdirSync(controlDir, { recursive: true });
  if (eventId) {
    const seen = loadEmittedEventIds();
    if (seen.has(eventId)) return false;
    seen.add(eventId);
  }
  const record = eventId
    ? { ts: now(), eventId, type, ...details }
    : { ts: now(), type, ...details };
  fs.appendFileSync(files.events, JSON.stringify(record) + "\n");
  return true;
}
/**
 * The audit log, parsed, for checks that corroborate task state against it.
 *
 * A snapshot taken on first use: the only consumer is `validate`, which reads
 * before anything in the same process appends. Torn trailing lines are skipped
 * for the same reason emission tolerates them -- a half-written last line is a
 * crash artefact, not evidence of anything.
 */
let eventRecords = null;
function readEventRecords() {
  if (eventRecords) return eventRecords;
  eventRecords = [];
  if (!fs.existsSync(files.events)) return eventRecords;
  for (const line of fs.readFileSync(files.events, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      eventRecords.push(JSON.parse(line));
    } catch {
      /* a torn trailing line must not break validation */
    }
  }
  return eventRecords;
}
/** Stable across runs and machines: same message + slot + type => same id. */
function deterministicEventId(messageId, slot, type) {
  return crypto
    .createHash("sha256")
    .update(`${messageId}\0${slot}\0${type}`)
    .digest("hex")
    .slice(0, 32);
}
function data() {
  return {
    project: readJson(files.project),
    taskDoc: readJson(files.tasks),
    agentDoc: readJson(files.agents),
    gateDoc: readJson(files.gates),
    policies: readJson(files.policies),
    milestoneDoc: fs.existsSync(files.milestones)
      ? readJson(files.milestones)
      : { milestones: [] },
    adapterDoc: fs.existsSync(files.adapters)
      ? readJson(files.adapters)
      : { adapters: [] },
  };
}
function taskMap(tasks) {
  return new Map(tasks.map((t) => [t.id, t]));
}
function agentMap(agents) {
  return new Map(agents.map((a) => [a.id, a]));
}
function priorityRank(p) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[p] ?? 9;
}
function isDone(id, map) {
  return map.get(id)?.status === "DONE";
}
function depsDone(task, map) {
  return (task.dependencies ?? []).every((id) => isDone(id, map));
}
function pathsOverlap(aPaths = [], bPaths = []) {
  for (const aRaw of aPaths) {
    for (const bRaw of bPaths) {
      const a = normalizePrefix(aRaw);
      const b = normalizePrefix(bRaw);
      if (!a || !b) return true;
      if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
        return true;
    }
  }
  return false;
}
function active(task, policies) {
  return policies.activeStatuses.includes(task.status);
}
function capabilityScore(agent, task) {
  if (
    !agent.capabilities?.includes(task.lane) &&
    !agent.capabilities?.includes("*")
  )
    return -1;
  let score = 10;
  if (task.preferredAgent === agent.id) score += 100;
  if (agent.kind === "local-subagent") score += 10;
  if (task.lane === "Architecture" || task.lane === "Recommendations") {
    if (agent.id === "gpt-architect") score += 40;
  }
  if (task.lane === "Coordination" && agent.id === "claude-lead") score += 30;
  return score;
}
function usageByAgent(tasks, policies) {
  const usage = new Map();
  for (const task of tasks) {
    if (task.owner && active(task, policies))
      usage.set(task.owner, (usage.get(task.owner) ?? 0) + 1);
  }
  return usage;
}
function conflictWithActive(task, tasks, policies) {
  return tasks
    .filter((t) => active(t, policies) && t.id !== task.id)
    .find((other) => pathsOverlap(task.allowedPaths, other.allowedPaths));
}
function refreshReadiness(tasks) {
  const map = taskMap(tasks);
  let changed = 0;
  for (const task of tasks) {
    if (
      [
        "DONE",
        "CANCELED",
        "CLAIMED",
        "IN_PROGRESS",
        "REVIEW",
        "BLOCKED",
      ].includes(task.status)
    )
      continue;
    const next = depsDone(task, map) ? "READY" : "BACKLOG";
    if (task.status !== next) {
      task.status = next;
      changed++;
    }
  }
  return changed;
}

/* ---------------------------------------------------------------------------
 * Execution availability
 *
 * An agent lane is "locally executable" when the adapter serving its kind can
 * both run commands and edit local files. External reasoning lanes (for example
 * gpt-architect via the shared-repository adapter) stay queued for their own
 * agent, but must never consume path ownership or capacity from the local wave.
 * ------------------------------------------------------------------------- */
function adapterFor(agent, d) {
  return (
    (d.adapterDoc.adapters ?? []).find((a) =>
      (a.agentKinds ?? []).includes(agent.kind),
    ) ?? null
  );
}
function agentExecutable(agent, d) {
  if (typeof agent.executionAvailable === "boolean")
    return agent.executionAvailable;
  if (agent.kind === "executive") return false;
  const adapter = adapterFor(agent, d);
  if (!adapter) return false;
  return (
    adapter.canExecuteCommands === true && adapter.canEditLocalFiles === true
  );
}
function executableAgents(d) {
  return d.agentDoc.agents.filter((a) => agentExecutable(a, d));
}

/* ---------------------------------------------------------------------------
 * Dispatch classification
 * ------------------------------------------------------------------------- */
function classifyTasks(d) {
  refreshReadiness(d.taskDoc.tasks);
  const tasks = d.taskDoc.tasks;
  const map = taskMap(tasks);
  const amap = agentMap(d.agentDoc.agents);
  const local = executableAgents(d);
  const out = {
    readyAndExecutable: [],
    readyButExternal: [],
    blocked: [],
    active: [],
    backlog: [],
    done: [],
  };

  for (const task of tasks) {
    if (task.status === "CANCELED") continue;
    if (task.status === "DONE") {
      out.done.push(task);
      continue;
    }
    if (task.status === "BLOCKED") {
      out.blocked.push({
        task,
        reason: task.blocker ?? "blocked without recorded reason",
      });
      continue;
    }
    if (active(task, d.policies)) {
      out.active.push(task);
      continue;
    }
    if (task.status !== "READY") {
      const missing = (task.dependencies ?? []).filter(
        (id) => !isDone(id, map),
      );
      out.backlog.push({
        task,
        reason: missing.length
          ? `waiting on ${missing.join(", ")}`
          : "not READY",
      });
      continue;
    }

    const preferred = task.preferredAgent
      ? amap.get(task.preferredAgent)
      : null;
    if (preferred && !agentExecutable(preferred, d)) {
      const adapter = adapterFor(preferred, d);
      out.readyButExternal.push({
        task,
        agent: preferred,
        reason: `reserved for ${preferred.id} via ${adapter?.id ?? "external adapter"}; not locally executable`,
      });
      continue;
    }
    const eligible = local.filter((a) => capabilityScore(a, task) >= 0);
    if (!eligible.length) {
      out.readyButExternal.push({
        task,
        agent: preferred,
        reason: `no locally executable agent advertises lane ${task.lane}`,
      });
      continue;
    }
    out.readyAndExecutable.push(task);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Wave planning
 *
 * Maximizes the number of simultaneously dispatchable tasks subject to
 * dependencies, allowedPaths disjointness, agent capability and agent capacity.
 * A naive priority-ordered greedy scan can pick an early task whose broad
 * allowedPaths starve several other lanes, so we search for a maximum feasible
 * set instead and only fall back to greedy if the search budget is exhausted.
 * ------------------------------------------------------------------------- */
function waveKey(sel) {
  return sel
    .map((x) => x.task.id)
    .sort()
    .join(",");
}
function betterWave(a, b) {
  if (a.length !== b.length) return a.length > b.length;
  const pa = a.reduce((s, x) => s + priorityRank(x.task.priority), 0);
  const pb = b.reduce((s, x) => s + priorityRank(x.task.priority), 0);
  if (pa !== pb) return pa < pb;
  return waveKey(a) < waveKey(b);
}
function greedyWave(candidates, agents, baseUsage) {
  const usage = new Map(baseUsage);
  const selected = [];
  for (const task of candidates) {
    if (
      selected.some((c) => pathsOverlap(task.allowedPaths, c.task.allowedPaths))
    )
      continue;
    const options = agents
      .filter(
        (a) =>
          capabilityScore(a, task) >= 0 &&
          (usage.get(a.id) ?? 0) < a.maxParallel,
      )
      .sort(
        (x, y) =>
          capabilityScore(y, task) - capabilityScore(x, task) ||
          x.id.localeCompare(y.id),
      );
    if (!options.length) continue;
    selected.push({ task, agent: options[0] });
    usage.set(options[0].id, (usage.get(options[0].id) ?? 0) + 1);
  }
  return selected;
}
function planExecutableWave(d, classification) {
  const tasks = d.taskDoc.tasks;
  const agents = executableAgents(d);
  const baseUsage = usageByAgent(tasks, d.policies);
  const candidates = classification.readyAndExecutable
    .filter((t) => !conflictWithActive(t, tasks, d.policies))
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.id.localeCompare(b.id),
    );

  let best = [];
  let nodes = 0;
  let exhausted = false;
  const budget = 300000;

  function dfs(i, chosen, usage) {
    if (exhausted) return;
    if (++nodes > budget) {
      exhausted = true;
      return;
    }
    // Must stay `<`, not `<=`: equal-length branches have to remain reachable
    // so betterWave() can apply the priority and lexicographic tie-breaks.
    if (chosen.length + (candidates.length - i) < best.length) return;
    if (i === candidates.length) {
      if (betterWave(chosen, best)) best = chosen.map((x) => ({ ...x }));
      return;
    }
    const task = candidates[i];
    if (
      !chosen.some((c) => pathsOverlap(task.allowedPaths, c.task.allowedPaths))
    ) {
      const options = agents
        .filter(
          (a) =>
            capabilityScore(a, task) >= 0 &&
            (usage.get(a.id) ?? 0) < a.maxParallel,
        )
        .sort(
          (x, y) =>
            capabilityScore(y, task) - capabilityScore(x, task) ||
            x.id.localeCompare(y.id),
        );
      for (const agent of options) {
        usage.set(agent.id, (usage.get(agent.id) ?? 0) + 1);
        chosen.push({ task, agent });
        dfs(i + 1, chosen, usage);
        chosen.pop();
        usage.set(agent.id, usage.get(agent.id) - 1);
        if (exhausted) return;
      }
    }
    dfs(i + 1, chosen, usage);
  }

  dfs(0, [], new Map(baseUsage));
  if (exhausted) {
    const fallback = greedyWave(candidates, agents, baseUsage);
    if (betterWave(fallback, best)) best = fallback;
  }
  return best;
}
function deferredReasons(d, classification, wave) {
  const chosen = new Set(wave.map((w) => w.task.id));
  const out = [];
  for (const task of classification.readyAndExecutable) {
    if (chosen.has(task.id)) continue;
    const activeClash = conflictWithActive(task, d.taskDoc.tasks, d.policies);
    const waveClash = wave.find((w) =>
      pathsOverlap(task.allowedPaths, w.task.allowedPaths),
    );
    out.push({
      task,
      reason: activeClash
        ? `allowedPaths overlap active ${activeClash.id} (owner ${activeClash.owner ?? "unassigned"})`
        : waveClash
          ? `allowedPaths overlap dispatched ${waveClash.task.id}`
          : "no locally executable agent has capacity for this lane in this wave",
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Implementation fingerprinting
 *
 * Binds a review approval to the exact implementation content it reviewed.
 * Generated control-plane bookkeeping is excluded, otherwise recording the
 * approval itself would immediately invalidate the approval.
 *
 * Two surfaces, deliberately not one:
 *
 *   write / collision / staging   allowedPaths
 *   reviewed                      allowedPaths + reviewDependencies
 *
 * Collapsing them is what forced every contract-touching task to reserve
 * `packages/contracts/**` in full: narrowing allowedPaths to unblock those lanes
 * would also have narrowed what their approvals bind to, so a later edit to a
 * shared schema would silently stop invalidating the reviews that relied on it.
 * ------------------------------------------------------------------------- */
const fingerprintExclusions = [
  "control/tasks.json",
  "control/events.jsonl",
  "control/queues",
  "coordination/PROJECT_STATUS.md",
  "coordination/TASKS.md",
  // Handoff traffic is coordination metadata, not implementation. Without this
  // exclusion, publishing a review request would change the fingerprint of the
  // very task being reviewed and invalidate the approval that came back.
  "coordination/agent-bus",
];
function excludedFromFingerprint(rel) {
  // Write-then-rename temporaries are transient artefacts, never implementation.
  if (rel.endsWith(".tmp")) return true;
  return fingerprintExclusions.some(
    (ex) => rel === ex || rel.startsWith(ex + "/"),
  );
}
function filesForPattern(pattern) {
  const prefix = normalizePrefix(pattern);
  if (!prefix) return [];
  const abs = path.join(root, prefix);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile())
    return excludedFromFingerprint(prefix) ? [] : [prefix];
  const out = [];
  const stack = [prefix];
  while (stack.length) {
    const rel = stack.pop();
    for (const entry of fs.readdirSync(path.join(root, rel), {
      withFileTypes: true,
    })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const childRel = `${rel}/${entry.name}`;
      if (excludedFromFingerprint(childRel)) continue;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  return out;
}
/**
 * The WRITE surface, and only that.
 *
 * Never widened by reviewDependencies. A declared dependency is read-only by
 * construction: no collision check reserved it, so another active task may be
 * editing it at the same moment, and treating it as writable here would hand out
 * an ownership claim the scheduler never granted.
 *
 * The `.filter(Boolean)` is only safe because `validate` now REFUSES a
 * root-normalizing allowedPath rather than warning about one. Read on its own it
 * is the exact fail-open this control plane was caught in once already: a path
 * declared, accepted, and then silently dropped, taking the fingerprint and the
 * dirty-tree check with it. Do not relax that check on the assumption that
 * something downstream copes.
 */
function taskPathspecs(task) {
  return [
    ...new Set((task.allowedPaths ?? []).map(normalizePrefix).filter(Boolean)),
  ];
}

/*
 * The REVIEWED surface lives in ./review-surface.mjs, not here.
 *
 * It moved out the moment it acquired a second consumer. The reviewer's diff
 * builder must be derived from the same function as the fingerprint below, or an
 * approval ends up cryptographically bound to files the reviewer was never
 * shown -- stronger evidence resting on a weaker basis. A copy that agrees today
 * is not a guarantee; a shared function is.
 */

/**
 * Canonical fingerprint from git object ids.
 *
 * Hashing working-tree bytes makes the fingerprint depend on the platform:
 * `core.autocrlf` rewrites line endings on checkout, so Windows and Linux
 * clones of the SAME commit produce different hashes and an approval recorded
 * on one machine reads as stale on the other. Git blob ids are computed over
 * canonical repository content, so they are identical everywhere.
 *
 * Returns null when git or the commit is unavailable, so callers can decide.
 */
function gitFingerprint(task, commitish = "HEAD") {
  const pathspecs = reviewPathspecs(task);
  if (!pathspecs.length) return null;
  try {
    const out = execFileSync(
      "git",
      ["ls-tree", "-r", "-z", commitish, "--", ...pathspecs],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const entries = [];
    for (const record of out.split("\0")) {
      if (!record.trim()) continue;
      // "<mode> <type> <objectid>\t<path>"
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(/\s+/);
      const rel = record.slice(tab + 1);
      const objectId = meta[2];
      if (!objectId || meta[1] !== "blob") continue;
      if (excludedFromFingerprint(rel)) continue;
      entries.push([rel, objectId]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const hash = crypto.createHash("sha256");
    for (const [rel, objectId] of entries) {
      hash.update(rel);
      hash.update("\0");
      hash.update(objectId);
      hash.update("\0");
    }
    return {
      treeHash: hash.digest("hex"),
      fileCount: entries.length,
      source: "git-object",
    };
  } catch {
    return null;
  }
}

/** Working-tree fallback for environments without git (the test fixtures). */
function worktreeFingerprint(task) {
  const set = new Set();
  // The Set is what makes a redundantly-declared dependency a no-op: a pattern
  // already covered by allowedPaths contributes the same relative paths, so the
  // union is idempotent and the hash does not move.
  for (const pattern of reviewSurfacePatterns(task))
    for (const rel of filesForPattern(pattern)) set.add(rel);
  const sorted = [...set].sort();
  const hash = crypto.createHash("sha256");
  for (const rel of sorted) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return {
    treeHash: hash.digest("hex"),
    fileCount: sorted.length,
    source: "worktree",
  };
}

function implementationFingerprint(task, commitish = "HEAD") {
  return gitFingerprint(task, commitish) ?? worktreeFingerprint(task);
}

/**
 * Uncommitted changes to files this task owns. Scoped to allowedPaths so an
 * unrelated edit elsewhere in the repo cannot block a review decision, while a
 * dirty implementation tree still does.
 *
 * Stays on allowedPaths and is NOT widened to the reviewed surface. A shared
 * dependency is co-owned by whichever task actually holds it, and that task's
 * in-flight edits are none of this task's business: widening here would let one
 * lane's uncommitted work block every other lane that merely reads the same
 * vocabulary -- reintroducing the package-wide mutex through the back door.
 */
function taskWorktreeDirtyPaths(task) {
  const pathspecs = taskPathspecs(task);
  // No write surface means no question to ask. Passing zero pathspecs to
  // `git status` would ask about the WHOLE repository instead, and every
  // control-plane command dirties control/tasks.json, so the answer would be
  // "dirty" for reasons that have nothing to do with this task.
  if (!pathspecs.length) return [];
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--", ...pathspecs],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\S+\s+/, ""))
      .filter((rel) => !excludedFromFingerprint(rel) && !rel.endsWith(".tmp"));
  } catch {
    return [];
  }
}
/**
 * The same question as a boolean, for the review/completion paths.
 *
 * `LIBERTY_COMMIT_SHA` short-circuits it because the bus fixtures simulate a
 * moving HEAD in repositories that have no git at all, where `git status` says
 * nothing. Callers that have ALREADY established that git is present -- the
 * reconciliation path does, and refuses to run without it -- must call
 * `taskWorktreeDirtyPaths` directly instead, or an environment variable would
 * switch off a check whose whole point is that it reads real history.
 */
function taskWorktreeIsDirty(task) {
  if (process.env.LIBERTY_COMMIT_SHA) return false; // test harness has no git
  return taskWorktreeDirtyPaths(task).length > 0;
}
function currentCommitSha() {
  // Explicit override exists so the handoff-bus commit-binding rules can be
  // exercised in a test repository that has no git history. It is read before
  // git so a test can simulate "HEAD moved since GPT reviewed".
  if (process.env.LIBERTY_COMMIT_SHA) return process.env.LIBERTY_COMMIT_SHA;
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Independent review enforcement
 * ------------------------------------------------------------------------- */
const REVIEW_REQUIRED_FIELDS = [
  "taskId",
  "implementationAgent",
  "reviewerAgent",
  "reviewerClass",
  "reviewerProvider",
  "reviewedCommitSha",
  "reviewedTreeHash",
  "outcome",
  "reviewedAt",
  "evidence",
];
const REVIEW_OUTCOMES = ["APPROVED", "CHANGES_REQUESTED"];

function reviewRequired(task, policies) {
  if (task.requiresIndependentReview === false) return false;
  if (policies.review?.requireIndependentReview === false) return false;
  return Boolean(task.reviewAgent);
}
/**
 * Everything about a review record that is true regardless of WHEN it is
 * checked: required fields, outcome, reviewer identity and independence.
 *
 * Deliberately excludes anything about the current working tree, so the same
 * checks can be applied to a task being completed now AND to a task that
 * completed months ago.
 */
function reviewRecordProblems(task, policies) {
  const problems = [];
  if (!reviewRequired(task, policies)) return problems;
  const r = task.review;
  if (!r) {
    problems.push(
      `no independent review record; run: node scripts/ai-control-plane.mjs approve ${task.id} ${task.reviewAgent} "<evidence>"`,
    );
    return problems;
  }
  for (const field of REVIEW_REQUIRED_FIELDS) {
    if (r[field] === undefined || r[field] === null || r[field] === "")
      problems.push(`review record missing required field: ${field}`);
  }
  if (r.outcome === "CHANGES_REQUESTED")
    problems.push(
      "review outcome is CHANGES_REQUESTED; rework and obtain a new approval",
    );
  else if (r.outcome !== "APPROVED")
    problems.push(`review outcome ${r.outcome} is not APPROVED`);
  if (r.reviewerAgent && r.reviewerAgent === r.implementationAgent) {
    problems.push(
      `self-approval is prohibited: ${r.reviewerAgent} implemented and approved ${task.id}`,
    );
  }
  // The owner of the implementation round counts too. Only recorded since
  // `implementationOwner` was added, and only checked when present, so historical
  // records -- whose owner WAS their implementationAgent -- are unaffected.
  else if (r.implementationOwner && r.reviewerAgent === r.implementationOwner) {
    problems.push(
      `self-approval is prohibited: ${r.reviewerAgent} owned the implementation round for ${task.id} ` +
        `(recorded implementer ${r.implementationAgent})`,
    );
  }
  if (task.reviewAgent && r.reviewerAgent !== task.reviewAgent) {
    problems.push(
      `independent review must come from ${task.reviewAgent}, but record names ${r.reviewerAgent}; automatic reviewer substitution is not permitted`,
    );
  }
  return problems;
}

/**
 * Checks for a task being reviewed or completed RIGHT NOW.
 *
 * Current-HEAD drift and working-tree dirt matter here: the task is about to
 * claim that what was reviewed is what exists.
 */
function reviewProblems(task, policies) {
  const problems = reviewRecordProblems(task, policies);
  if (!reviewRequired(task, policies) || !task.review) return problems;
  const r = task.review;

  const current = implementationFingerprint(task);
  if (r.reviewedTreeHash !== current.treeHash) {
    // Naming the surface matters once dependencies exist: an owner who has
    // touched nothing in their own allowedPaths would otherwise read this as a
    // control-plane fault rather than as the shared-vocabulary change it is.
    const surface = reviewSurfaceLabel(task);
    problems.push(
      `stale review: implementation under ${surface} changed after approval (approved ${String(r.reviewedTreeHash).slice(0, 12)}, current ${current.treeHash.slice(0, 12)})`,
    );
  }
  // Canonical fingerprints are git content and by design cannot see uncommitted
  // work, so dirt is checked separately -- otherwise a task could reach DONE
  // with unreviewed edits sitting in the working tree.
  if (taskWorktreeIsDirty(task)) {
    problems.push(
      "uncommitted changes under this task's allowedPaths; commit or stash them before completing",
    );
  }
  return problems;
}

/**
 * Exact compatibility registry for pre-canonical review records.
 *
 * Matched on the FULL immutable identity of a review, never on task id alone:
 * keying by task would let a modified legacy record keep bypassing verification.
 */
function isKnownLegacyReview(task, review) {
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(files.legacyReviews, "utf8")).records ?? [];
  } catch {
    return false;
  }
  return records.some(
    (entry) =>
      entry.taskId === task.id &&
      entry.reviewedCommitSha === review.reviewedCommitSha &&
      entry.reviewedTreeHash === review.reviewedTreeHash &&
      entry.reviewedAt === review.reviewedAt,
  );
}

function gitAvailable() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function commitResolves(sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return false;
  try {
    execFileSync("git", ["rev-parse", "--verify", `${sha}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Provenance reconciliation: implementations that predate their own claim
 *
 * `start` captures HEAD as `implementationBaseSha` because, normally, HEAD IS the
 * commit implementation is about to begin from. That assumption breaks for work
 * written and COMMITTED before any claim existed -- unclaimed preflight
 * implementation -- and the field is not descriptive metadata that can absorb the
 * error. `expectedReviewBase()` uses it as the EXACT lower bound of the first
 * review range, and `validateReviewRange()` refuses a base that is either wider
 * or narrower than that. A HEAD-captured base on such a task therefore hands the
 * reviewer a range that starts AFTER the code it was asked to judge, with the
 * full authority of a machine-readable field.
 *
 * COMMITTED, NOT PUSHED, and the two are not interchangeable. This whole path
 * reads the local worktree and the local commit graph; nothing here contacts a
 * remote, so a clean checkout whose commits have never left the machine satisfies
 * every check below. The contract used to say "pushed commits" -- in the dirty-
 * tree error, in the audit note, in the CLI help and in control/README.md -- which
 * asserted remote reachability while establishing only local committedness. That
 * is a provenance overclaim of exactly the class this mechanism exists to remove:
 * a record that reads as stronger than what produced it.
 *
 * Adding a remote-reachability check instead was REJECTED, and the narrowing is
 * the repair. Upstream configuration is not universal, a detached CI clone makes
 * "pushed" ambiguous to even define, and reconciliation legitimately runs locally
 * moments BEFORE the resulting commits are pushed -- so the check would refuse
 * correct work and still not prove what the sentence claimed. Remote availability
 * is real but belongs one step later: a review decision binds to a commit sha,
 * and the reviewer has to be able to fetch that sha. That is where the question
 * is both meaningful and answerable, and it is not here. The invariant here is
 * only that the asserted range contains COMMITTED history rather than
 * working-tree material.
 *
 * Three repairs were considered and two rejected:
 *
 *   put the true range in gate evidence  REJECTED. It creates two competing
 *       truths and makes the machine-readable one the false one. Prose cannot
 *       repair a structural field; every automated consumer reads the field.
 *   hand-edit control/tasks.json         REJECTED. The value would be right and
 *       its provenance invisible -- the same defect one level up, and indis-
 *       tinguishable in a diff from someone quietly widening their own scope.
 *   an explicit, validated, separately-audited operation  ADOPTED, below.
 *
 * The operation deliberately does not trust its own argument. A mechanism that
 * accepts any forty hex characters has only moved the lie from the field to the
 * command line.
 *
 * WHAT CANNOT BE PROVEN, stated rather than papered over: git does not attribute
 * commits to tasks. Nothing here can prove a supplied base is THE commit
 * immediately before this task's implementation, because no record anywhere says
 * which commits were this task's. The checks below prove the weaker properties
 * that ARE decidable, and the audit event publishes the resulting window so a
 * reviewer can interrogate the rest instead of taking it on trust.
 *
 * The bound that IS provable, and the reason this is not a new attack surface:
 * HEAD is the NARROWEST base expressible, an ordinary `start` already writes it
 * unchallenged, and the first check below refuses it outright. So relative to the
 * command it supplements, this one can only ever widen a review range. Every
 * check after that narrows the remaining room further.
 * ------------------------------------------------------------------------- */

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * HEAD according to git, ignoring LIBERTY_COMMIT_SHA.
 *
 * `currentCommitSha()` honours that override so the bus tests can simulate a
 * moving HEAD in fixture repositories that have no history. Reconciliation must
 * NOT read it: the entire value of the operation is that the claim is checkable
 * against real history, and an environment variable that redefines HEAD would let
 * the caller declare the very fact being verified.
 */
function realHeadSha() {
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** Parent shas of one commit, or null if it cannot be read. */
function commitParents(sha) {
  try {
    const out = execFileSync("git", ["rev-list", "--parents", "-n", "1", sha], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split(/\s+/).slice(1);
  } catch {
    return null;
  }
}

/**
 * Non-generated files under `pathspecs` that ONE commit changed.
 *
 * Deliberately not `git log -1 <sha> -- <paths>`, which is the obvious spelling
 * and the wrong one: with a pathspec, log applies history simplification and
 * walks BACKWARDS to the first commit that touched those paths, so it happily
 * reports an ancestor's files as though they were this commit's. Anything built
 * on it would then be reporting about the wrong commit, and would look perfectly
 * healthy while doing it.
 *
 * This once fed a refusal (a base whose touches overlapped the window was
 * rejected). That verdict was removed -- see `assertReconcilableBase` -- but the
 * computation is unchanged and is now PUBLISHED as evidence, so its accuracy
 * still matters exactly as much: a reviewer is told to weigh this list.
 */
function surfaceFilesTouchedBy(sha, pathspecs) {
  const parents = commitParents(sha);
  if (parents === null) return null;
  try {
    const diff = (args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      });
    let out = "";
    if (parents.length > 1) {
      /*
       * EVERY parent, unioned -- not just the first.
       *
       * A merge reports an empty diff under diff-tree unless it is told which
       * parent to compare against, and an empty result here is not "no answer",
       * it is the REASSURING answer: "this commit changed nothing under the
       * surface it precedes". Publishing that about exactly the commit shape most
       * likely to sit at a lane boundary is the worst available outcome.
       * First-parent alone was the previous spelling and has a hole of the same
       * shape: a merge that resolved the reviewed files TOWARDS the mainline is
       * TREESAME to its first parent while differing from its second, so a
       * conflict resolution sitting inside an implementation stream reported
       * itself as touching nothing.
       *
       * The union is deliberately the OVER-reporting direction. It can attribute
       * to a merge a file it only inherited from the branch it merged, which
       * makes the published evidence say slightly more happened here than did.
       * Since the reviewer's failure mode is being reassured, evidence that
       * prompts an unnecessary question is cheap and evidence that suppresses a
       * necessary one is not.
       */
      for (const parent of parents) {
        out += diff([
          "diff", "--no-renames", "--name-only", parent, sha,
          "--", ...pathspecs,
        ]);
      }
    } else {
      // --root so a repository's first commit reports its files rather than an
      // empty diff against nothing.
      out = diff([
        "diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r",
        "--root", sha, "--", ...pathspecs,
      ]);
    }
    return [
      ...new Set(
        out
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((rel) => !excludedFromFingerprint(rel)),
      ),
    ];
  } catch {
    return null;
  }
}

/**
 * Non-generated files under `pathspecs` that differ between two commits.
 *
 * `--no-renames` is pinned here and in `surfaceFilesTouchedBy`. It was
 * originally pinned because the two results were INTERSECTED and porcelain
 * `git diff` (which honours `diff.renames`, on by default, and collapses a
 * rename to its destination alone) disagreed with plumbing `diff-tree` (rename
 * detection off, a rename reported as its two endpoints) about how to spell the
 * same file. That intersection is gone with the overlap refusal, and the flag
 * stays for a reason that outlives it: both counts are PUBLISHED into the
 * provenance record and RE-DERIVED by `validate`. Left to configuration, a
 * record written on a machine with `diff.renames` off would be re-checked on one
 * with it on, and an honest record would draw a mismatch warning from nothing
 * but a git config difference. A published number has to mean the same thing
 * everywhere it is read.
 */
function surfaceFilesChangedBetween(base, head, pathspecs) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--no-renames", "--name-only", base, head, "--", ...pathspecs],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((rel) => !excludedFromFingerprint(rel));
  } catch {
    return null;
  }
}

/**
 * Commits in `base..head` that touched `pathspecs`, newest first.
 *
 * `--full-history` is not optional here. With a pathspec, `git log` applies
 * history simplification by default and PRUNES commits it considers TREESAME --
 * most visibly the side of a merge whose changes were also reached another way.
 * The one field a reviewer is told to interrogate is `oldestSurfaceCommit` ("is
 * there an earlier commit that also belongs to this implementation?"), and
 * simplification answers that question by quietly deleting candidates: the
 * published window would understate itself and read as reassurance.
 * `--full-history` reports every commit in the range that touched the surface,
 * which is what the record claims to be.
 */
function surfaceCommitsBetween(base, head, pathspecs) {
  try {
    const out = execFileSync(
      "git",
      [
        "log", "--full-history", "--format=%H", `${base}..${head}`,
        "--", ...pathspecs,
      ],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Everything MECHANICALLY decidable about a claimed pre-implementation base.
 * Throws on the first failure; returns what it verified so the caller can record
 * it.
 *
 * Each refusal exists because a specific falsehood would otherwise pass, or
 * because an answer could not be computed and must not be published as though it
 * had been. Nothing here refuses a base on an inference about task intent: git
 * does not attribute commits to tasks, one attempt to do so anyway was removed
 * on review, and the reasoning is recorded at the evidence step below so it is
 * not re-invented.
 */
function assertReconcilableBase(task, baseSha) {
  const short = (sha) => String(sha).slice(0, 12);

  // A ref name is not a durable record. `HEAD~3` means something different on
  // every later day, and the field it lands in is read months afterwards.
  if (!FULL_SHA.test(String(baseSha))) {
    throw new Error(
      "--base must be a full 40-character lowercase hex sha; a ref expression such as HEAD~3 " +
        "resolves differently later and cannot be a durable record of where implementation began",
    );
  }

  // Fail CLOSED on a missing repository. Everything below is a claim about
  // history; recording an unverifiable one is precisely what this command exists
  // to stop, so "cannot check" must never read as "checked".
  if (!gitAvailable()) {
    throw new Error(
      `cannot reconcile ${task.id}: no git repository is available here, so the supplied base cannot be ` +
        "verified against history. Reconciliation is a claim about the past; recording an unverifiable one " +
        "would leave exactly the false structural field it exists to prevent",
    );
  }
  const head = realHeadSha();
  if (!head) {
    throw new Error(
      `cannot reconcile ${task.id}: HEAD does not resolve, so the base cannot be placed in this history`,
    );
  }
  if (!commitResolves(baseSha)) {
    throw new Error(
      `--base ${short(baseSha)} does not resolve to a commit in this repository; fetch the history that ` +
        "contains it, or you are naming a commit that does not exist",
    );
  }
  if (baseSha === head) {
    throw new Error(
      `--base ${short(baseSha)} is HEAD, so the range ${short(baseSha)}..HEAD is empty and there is no ` +
        "pre-existing implementation to reconcile. A task whose work begins at HEAD is an ordinary start",
    );
  }
  if (!isAncestorCommit(baseSha, head)) {
    throw new Error(
      `--base ${short(baseSha)} is not an ancestor of HEAD ${short(head)}; that range is not a real line of ` +
        "history, so no review could ever be performed over it",
    );
  }

  // Without a surface there is nothing to test a base against, and the review
  // that consumes the base would bind to nothing either.
  const pathspecs = reviewPathspecs(task);
  if (!pathspecs.length) {
    throw new Error(
      `${task.id} declares no reviewable paths, so a base cannot be checked against anything; ` +
        "declare allowedPaths before reconciling",
    );
  }
  const surface = reviewSurfaceLabel(task);
  /*
   * The WRITE surface. Nothing below measures over it any more -- both the
   * window and the base-commit evidence are computed on the REVIEWED surface --
   * but its absence is still refused, and the reason has moved rather than
   * disappeared.
   *
   * The dirty-tree refusal immediately below is scoped to `allowedPaths`, and
   * `taskWorktreeDirtyPaths` reports a task that declares none as CLEAN: zero
   * pathspecs would otherwise ask `git status` about the whole repository, where
   * every control-plane command dirties control/tasks.json. So a task with no
   * allowedPaths would sail past the one check that enforces "the implementation
   * is already committed", which is the assertion this entire operation makes.
   * `validate` only warns about an empty allowedPaths, so this is where the
   * missing declaration finally costs something -- and such a task is
   * unreviewable and unreservable regardless.
   */
  const writePathspecs = taskPathspecs(task);
  if (!writePathspecs.length) {
    throw new Error(
      `${task.id} declares no allowedPaths, so the "already committed" check below has no surface to run on ` +
        "and would pass vacuously on a working tree full of the very implementation being asserted as " +
        "already committed. Declare the paths this task writes before reconciling",
    );
  }

  /*
   * A DIRTY WORKING TREE CONTRADICTS THE ASSERTION ON ITS FACE.
   *
   * Reconciliation asserts "the implementation already exists in committed Git
   * history". Uncommitted work under this task's own paths says the opposite,
   * and the documentation has always said so -- but nothing enforced it. The
   * central check below only catches an uncommitted implementation when NOTHING
   * under the surface changed in base..HEAD, which is a coincidence rather than
   * a rule: on a wide surface (`scripts/**`, `packages/**`) another lane's
   * commits satisfy it trivially, so an implementation that exists only in the
   * working tree could reconcile to a base that predates nothing at all and
   * publish a window built entirely from other people's commits.
   *
   * Scoped to allowedPaths, like every other dirty-tree check here: a shared
   * dependency is co-owned, and another lane's in-flight edits to it are not
   * this task's business. `taskWorktreeDirtyPaths` rather than
   * `taskWorktreeIsDirty` because git is already known to be present -- an
   * environment variable must not be able to switch this off.
   *
   * WHAT THIS PROVES, EXACTLY: that nothing under allowedPaths is uncommitted.
   * It says nothing about a remote, and the message below must not either. It
   * once claimed the implementation "ALREADY EXISTS in pushed commits", which a
   * clean branch of three never-pushed commits satisfies without contradiction --
   * the error asserting more than the check establishes. See the section header
   * for why a remote-reachability check was rejected rather than added.
   */
  const dirty = taskWorktreeDirtyPaths(task);
  if (dirty.length) {
    throw new Error(
      `cannot reconcile ${task.id}: ${dirty.length} uncommitted change(s) under its allowedPaths ` +
        `(${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). Reconciliation asserts that the ` +
        "implementation ALREADY EXISTS in committed Git history, so a dirty tree contradicts it: whatever is " +
        "uncommitted cannot be inside the range being asserted. Commit or stash it -- and if the " +
        "implementation itself is the uncommitted work, this is an ordinary start",
    );
  }

  const changed = surfaceFilesChangedBetween(baseSha, head, pathspecs);
  if (changed === null) {
    throw new Error(
      `cannot diff ${short(baseSha)} against HEAD ${short(head)}; refusing to record an unverified base`,
    );
  }
  /*
   * THE CENTRAL CHECK. If nothing under the reviewed surface changed between the
   * claimed base and HEAD, then either the base sits at or after the
   * implementation -- the exact falsehood being prevented, wearing a validated
   * costume -- or the work is not committed yet, in which case an ordinary start
   * is correct and this command is not.
   */
  if (!changed.length) {
    throw new Error(
      `nothing under ${surface} changed between ${short(baseSha)} and HEAD, so ${task.id} has no ` +
        "pre-existing implementation reachable from that base. Either the base is at or after the " +
        "implementation, or the work is not committed; an uncommitted implementation is an ordinary start",
    );
  }

  /*
   * EVIDENCE, NOT A VETO: what the base commit ITSELF changed under the reviewed
   * surface.
   *
   * This computation used to be a REFUSAL. If the base commit touched a file the
   * window goes on to change, the base was rejected as "inside the
   * implementation" and the operator was told to name an earlier commit, with
   * `<sha>^` offered as the usual answer. It was removed on review, and the
   * reason is worth recording in full, because a same-file heuristic is exactly
   * the kind of thing that gets re-invented by the next person who wants this
   * field to defend itself.
   *
   * WHY IT WAS WRONG. `implementationBaseSha` means one thing: the commit this
   * implementation actually began from. The refusal could only ever be satisfied
   * by walking backwards until the overlap stopped, so its remedy did not
   * produce that commit -- it produced a DELIBERATELY WIDENED one that happened
   * to pass a file test. The mechanism's own advice therefore corrupted the
   * meaning of the field the mechanism exists to make true, and a widened base
   * validates, publishes, and reads to every later consumer as the structural
   * lower bound it is not. "An earlier commit that is probably safe enough" is a
   * different field from "where this implementation began", and only one of them
   * is the one being written.
   *
   * AND THE INFERENCE WAS NEVER SOUND. Git does not attribute commits to tasks.
   * "The base edits a file the window also edits" is equally the signature of
   * two lanes co-tenanted in one directory, a revert, a formatting pass, a
   * dependency bump, or a rebase. An earlier round narrowed which paths the
   * check consulted (from the reviewed surface to the write surface) after it
   * refused every candidate base for a task with churning `reviewDependencies`.
   * That made the heuristic wrong less often; it did not make it a fact, and a
   * less-often-wrong veto is still a veto exercised on a guess about intent.
   *
   * SO THE COMPUTATION STAYS AND ITS VERDICT GOES. The touches are published,
   * and the reviewer -- who can read a commit message, ask the implementer, and
   * knows what the task was -- judges what they mean. That is the correct
   * division: the tool reports facts it can establish, the human answers the
   * question no tool can.
   *
   * On the REVIEWED surface, not the write surface. Every other published field
   * (`reviewSurface`, the window, `changedFileCount`) is measured there, and a
   * record whose fields silently describe two different surfaces is one a
   * reviewer must disambiguate before they can use it. The old split existed to
   * serve the veto's question ("is this base in THIS task's stream?"); with no
   * veto there is no second question, only one report.
   *
   * Deliberately NOT published pre-intersected with `changed`. An "overlapping
   * files" field would be the removed verdict wearing a data costume, and it
   * would invite the next reader to restore the refusal from it. The window and
   * the changed files are both published beside this; anyone who wants the
   * intersection can compute it and defend it themselves.
   */
  const baseTouches = surfaceFilesTouchedBy(baseSha, pathspecs);
  if (baseTouches === null) {
    /*
     * FAIL CLOSED, for the same reason the window below does. An unknown
     * published as an empty list would read as "the base commit itself changed
     * nothing under the reviewed surface" -- a positive claim about this commit,
     * and the most reassuring one available -- rather than as "the question could
     * not be answered". Note what this refusal is and is not: it is about
     * COMPUTABILITY, not about what the answer turned out to be.
     */
    throw new Error(
      `cannot inspect what ${short(baseSha)} itself changed under ${surface}; that is published evidence a ` +
        "reviewer is told to weigh, and an uncomputed answer must not be recorded as an empty one",
    );
  }

  /*
   * FAIL CLOSED, like both of its siblings above.
   *
   * This used to be `?? []`, which turned a git failure into a published window
   * of zero commits sitting beside a non-zero changed-file count -- a record
   * that contradicts itself, and reads to a reviewer as "no commits to
   * interrogate" rather than "the window could not be computed". The window is
   * not decoration: it is the only material the reviewer has for the one
   * question no check here can answer.
   */
  const commits = surfaceCommitsBetween(baseSha, head, pathspecs);
  if (commits === null) {
    throw new Error(
      `cannot list the commits between ${short(baseSha)} and HEAD ${short(head)} under ${surface}; the ` +
        "published window is what a reviewer interrogates, so refusing to record a base whose window is " +
        "unknown is the only honest outcome",
    );
  }
  return {
    head,
    changedFiles: changed,
    surfaceCommits: commits,
    surface,
    baseTouches,
  };
}

/**
 * How many of the window's commits the record publishes in full.
 *
 * Kept from the OLDEST end. The reviewer is pointed at exactly one question --
 * "is there an EARLIER commit that also belongs to this implementation?" -- and
 * the record used to answer it by publishing the twenty NEWEST commits and
 * dropping the oldest end, which is the only end that question is about. A
 * truncated list is flagged as truncated and both endpoints are always named
 * exactly, so a reader can tell "there are no more" from "there are more and
 * they are not listed here".
 */
const SURFACE_COMMIT_PUBLISH_LIMIT = 20;

/**
 * How many of the base commit's own surface touches the record publishes.
 *
 * A separate constant from the one above rather than a shared "publish limit":
 * they cap different things for different reasons, and a single number would
 * make one of the two look like a consequence of the other. Kept from the FRONT
 * here, unlike the commit window -- git's file order carries no "oldest end" for
 * the reviewer's question to be about, so there is no end worth preferring, and
 * the truncation flag is what stops a capped list reading as a complete one.
 */
const BASE_TOUCH_PUBLISH_LIMIT = 20;

const PROVENANCE_KIND = "reconciled-existing-implementation";

/**
 * Whether an `implementationBaseProvenance` record can be believed.
 *
 * WHAT THIS CAN AND CANNOT DO, because overstating it would be worse than not
 * doing it. Nothing in a local CLI can stop a hand-edit of control/tasks.json.
 * The goal is therefore not that a forged record is impossible but that it is
 * DETECTABLE: the previous validation checked three fields (kind, a matching
 * baseSha, a non-empty reason), so a five-line stub pasted onto an ordinarily
 * started task passed `ai:validate` cleanly -- and `review-status` and
 * `handoff --base auto` then told the reviewer, with the full authority of the
 * control plane, that the range predates the claim. Everything else the record
 * published (the window, its endpoints, the changed-file count, who reconciled
 * it, who implemented it, the surface) was accepted verbatim while
 * control/README.md instructed reviewers to lean on precisely those fields.
 *
 * So the record is now checked three ways:
 *
 *   SHAPE          every field the CLI writes, typed and cross-consistent. A
 *                  forger must now produce a whole coherent record rather than
 *                  a marker.
 *   HISTORY        the parts git can settle cheaply and durably: the base is an
 *                  ancestor of the head it claims, and the published endpoints
 *                  really lie inside that window. Errors, because these are
 *                  facts about history that no later legitimate edit changes.
 *   CORROBORATION  `events.jsonl` must carry the `task.started_reconciled` event
 *                  that this record's existence implies. Append-only and
 *                  separately written, so a forgery now needs two consistent
 *                  edits in two files instead of one, and an inconsistency names
 *                  itself.
 *
 * Counts are re-derived but reported as WARNINGS, not errors: `allowedPaths` and
 * `reviewDependencies` may legitimately be redeclared after a reconciliation, and
 * a recomputation over the new surface then disagrees with a record that was
 * honest when written. Turning that into an error would strand a correct task.
 *
 * What remains open is stated in control/README.md rather than papered over: a
 * forger who supplies a genuine base, a genuine head and a matching audit line
 * still passes, because git does not attribute commits to tasks.
 */
function reconciliationProvenanceProblems(task, amap, surfaceUsable) {
  const errors = [];
  const warnings = [];
  const p = task.implementationBaseProvenance;
  const id = task.id;
  const short = (sha) => String(sha).slice(0, 12);

  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    errors.push(
      `${id}: implementationBaseProvenance must be an object written by ` +
        "`start --reconcile-existing`",
    );
    return { errors, warnings };
  }
  if (p.kind !== PROVENANCE_KIND) {
    errors.push(
      `${id}: unknown implementationBaseProvenance kind ${JSON.stringify(p.kind)}; ` +
        "refusing to guess how this base was established",
    );
  }

  /* --- the field it exists to explain -------------------------------- */
  if (!task.implementationBaseSha) {
    errors.push(
      `${id}: implementationBaseProvenance records a reconciliation but the task has no ` +
        "implementationBaseSha to explain",
    );
  } else if (p.baseSha !== task.implementationBaseSha) {
    errors.push(
      `${id}: implementationBaseProvenance describes ${short(p.baseSha)} but ` +
        `implementationBaseSha is ${short(task.implementationBaseSha)}; the record does not ` +
        "explain the field it is attached to",
    );
  }

  /* --- shape ---------------------------------------------------------- */
  const isSha = (v) => typeof v === "string" && FULL_SHA.test(v);
  const isCount = (v) => Number.isInteger(v) && v >= 0;
  if (!isSha(p.baseSha))
    errors.push(
      `${id}: implementationBaseProvenance.baseSha must be a full 40-character hex sha`,
    );
  if (!isSha(p.headAtReconciliation))
    errors.push(
      `${id}: implementationBaseProvenance.headAtReconciliation must be a full 40-character hex sha; ` +
        "without the head it was reconciled against, the published window names no range",
    );
  else if (p.headAtReconciliation === p.baseSha)
    errors.push(
      `${id}: implementationBaseProvenance reconciles ${short(p.baseSha)} against itself; an empty ` +
        "window cannot contain a pre-existing implementation",
    );
  if (typeof p.reason !== "string" || !p.reason.trim())
    errors.push(
      `${id}: implementationBaseProvenance carries no reason; a reconciled base is an assertion ` +
        "and must say how it was determined",
    );
  if (typeof p.reconciledAt !== "string" || Number.isNaN(Date.parse(p.reconciledAt)))
    errors.push(
      `${id}: implementationBaseProvenance.reconciledAt must be an ISO timestamp`,
    );
  for (const field of ["reconciledBy", "implementationAgent"]) {
    const value = p[field];
    if (typeof value !== "string" || !value)
      errors.push(
        `${id}: implementationBaseProvenance.${field} must name an agent`,
      );
    else if (amap && !amap.has(value))
      errors.push(
        `${id}: implementationBaseProvenance.${field} names unknown agent ${value}`,
      );
  }
  // Deliberately NOT required to equal task.implementationAgent: `release` keeps
  // the base and its provenance, so a later claimant legitimately becomes the
  // task's implementationAgent while this record still names who wrote the
  // pre-existing code. The record describes one moment, not the current state.
  const LABELS = ["allowedPaths", "allowedPaths + reviewDependencies"];
  if (!LABELS.includes(p.reviewSurface))
    errors.push(
      `${id}: implementationBaseProvenance.reviewSurface must be one of ${LABELS.join(" | ")}`,
    );
  else if (surfaceUsable && p.reviewSurface !== reviewSurfaceLabel(task))
    warnings.push(
      `${id}: implementationBaseProvenance was recorded against ${p.reviewSurface} but the task now ` +
        `declares ${reviewSurfaceLabel(task)}; the published window describes the older surface`,
    );

  if (!isCount(p.surfaceCommitCount))
    errors.push(
      `${id}: implementationBaseProvenance.surfaceCommitCount must be a non-negative integer`,
    );
  if (!isCount(p.changedFileCount))
    errors.push(
      `${id}: implementationBaseProvenance.changedFileCount must be a non-negative integer`,
    );
  else if (p.changedFileCount === 0)
    errors.push(
      `${id}: implementationBaseProvenance reports 0 changed files, but a reconciled base is only ` +
        "accepted when something under the reviewed surface changed between it and HEAD",
    );

  const published = p.surfaceCommits;
  if (!Array.isArray(published) || !published.every(isSha)) {
    errors.push(
      `${id}: implementationBaseProvenance.surfaceCommits must be an array of full hex shas`,
    );
  } else {
    if (isCount(p.surfaceCommitCount) && published.length > p.surfaceCommitCount)
      errors.push(
        `${id}: implementationBaseProvenance publishes ${published.length} commit(s) but claims a window of ` +
          `${p.surfaceCommitCount}`,
      );
    // The endpoints are the record's whole reviewer-facing value, so they are
    // pinned to the list rather than trusted alongside it.
    const oldest = published[published.length - 1] ?? null;
    const newest = published[0] ?? null;
    if ((p.oldestSurfaceCommit ?? null) !== oldest)
      errors.push(
        `${id}: implementationBaseProvenance.oldestSurfaceCommit ${short(p.oldestSurfaceCommit)} is not the ` +
          "oldest commit it publishes; the window is kept from the oldest end precisely so this holds",
      );
    if (p.surfaceCommitsTruncated === undefined) {
      warnings.push(
        `${id}: implementationBaseProvenance predates surfaceCommitsTruncated/newestSurfaceCommit; its ` +
          "published window cannot be checked for completeness",
      );
    } else {
      if (typeof p.surfaceCommitsTruncated !== "boolean")
        errors.push(
          `${id}: implementationBaseProvenance.surfaceCommitsTruncated must be a boolean`,
        );
      else if (
        isCount(p.surfaceCommitCount) &&
        p.surfaceCommitsTruncated !== (published.length < p.surfaceCommitCount)
      )
        errors.push(
          `${id}: implementationBaseProvenance says surfaceCommitsTruncated=${p.surfaceCommitsTruncated} ` +
            `while publishing ${published.length} of ${p.surfaceCommitCount} commit(s)`,
        );
      if (!p.surfaceCommitsTruncated && (p.newestSurfaceCommit ?? null) !== newest)
        errors.push(
          `${id}: implementationBaseProvenance.newestSurfaceCommit ${short(p.newestSurfaceCommit)} is not the ` +
            "newest commit it publishes",
        );
      if (p.surfaceCommitsTruncated && !isSha(p.newestSurfaceCommit))
        errors.push(
          `${id}: implementationBaseProvenance truncates its window, so newestSurfaceCommit must name the ` +
            "end the list no longer reaches",
        );
    }
    if (isCount(p.changedFileCount) && p.changedFileCount > 0 && p.surfaceCommitCount === 0)
      warnings.push(
        `${id}: implementationBaseProvenance publishes an empty commit window beside ${p.changedFileCount} ` +
          "changed file(s); the record contradicts itself",
      );
  }

  /*
   * The base commit's own surface touches: shape-checked like everything else,
   * because a published EVIDENCE field a reviewer is told to weigh is exactly as
   * worth forging as the window. An emptied list is the cheap forgery here -- it
   * makes a base read as untouched by the surface it precedes -- so the git
   * section below re-derives the count.
   *
   * ABSENCE IS A WARNING, not an error, on the same reasoning as
   * `surfaceCommitsTruncated`: a record written before this field existed is old,
   * not fabricated, and erroring would strand a task whose reconciliation was
   * honest under the rules of its day.
   */
  if (p.baseCommitSurfaceTouches === undefined) {
    warnings.push(
      `${id}: implementationBaseProvenance predates baseCommitSurfaceTouches, so what the base commit ` +
        "itself changed under the reviewed surface was never published and cannot be recovered from the " +
        "record",
    );
  } else if (
    !Array.isArray(p.baseCommitSurfaceTouches) ||
    !p.baseCommitSurfaceTouches.every((f) => typeof f === "string" && f)
  ) {
    errors.push(
      `${id}: implementationBaseProvenance.baseCommitSurfaceTouches must be an array of file paths`,
    );
  } else {
    if (!isCount(p.baseCommitSurfaceTouchCount))
      errors.push(
        `${id}: implementationBaseProvenance.baseCommitSurfaceTouchCount must be a non-negative integer`,
      );
    else if (p.baseCommitSurfaceTouches.length > p.baseCommitSurfaceTouchCount)
      errors.push(
        `${id}: implementationBaseProvenance publishes ${p.baseCommitSurfaceTouches.length} base-commit ` +
          `touch(es) but claims ${p.baseCommitSurfaceTouchCount}`,
      );
    if (typeof p.baseCommitSurfaceTouchesTruncated !== "boolean")
      errors.push(
        `${id}: implementationBaseProvenance.baseCommitSurfaceTouchesTruncated must be a boolean`,
      );
    else if (
      isCount(p.baseCommitSurfaceTouchCount) &&
      p.baseCommitSurfaceTouchesTruncated !==
        (p.baseCommitSurfaceTouches.length < p.baseCommitSurfaceTouchCount)
    )
      errors.push(
        `${id}: implementationBaseProvenance says baseCommitSurfaceTouchesTruncated=` +
          `${p.baseCommitSurfaceTouchesTruncated} while publishing ` +
          `${p.baseCommitSurfaceTouches.length} of ${p.baseCommitSurfaceTouchCount} touch(es)`,
      );
  }

  /*
   * --- corroboration against the append-only audit trail ---------------
   *
   * This assumes events.jsonl is the complete log this repository has kept from
   * the start: it is append-only, committed, and nothing here rotates or
   * truncates it. If a project ever starts trimming it, a task whose
   * reconciliation event was trimmed away while a LATER ordinary `task.started`
   * survived would be reported as a forgery. The absence of any start event at
   * all is therefore only a warning -- that shape is indistinguishable from a
   * fresh or rebuilt log -- while a log that remembers this task starting but
   * not being reconciled is a contradiction, because the CLI writes the record
   * and the event in the same operation.
   */
  const starts = readEventRecords().filter(
    (e) =>
      e?.taskId === id &&
      (e.type === "task.started" || e.type === "task.started_reconciled"),
  );
  if (!starts.length) {
    warnings.push(
      `${id}: no start event in control/events.jsonl, so this reconciliation cannot be corroborated ` +
        "against the audit trail (a truncated or rotated log looks the same as a fabricated record)",
    );
  } else if (
    !starts.some(
      (e) =>
        e.type === "task.started_reconciled" &&
        e.implementationBaseSha === p.baseSha,
    )
  ) {
    errors.push(
      `${id}: implementationBaseProvenance claims a reconciliation at ${short(p.baseSha)}, but ` +
        "control/events.jsonl records no matching task.started_reconciled event for this task. The CLI " +
        "writes both together, so the record was not written by the operation it names",
    );
  }

  /* --- what git can still settle --------------------------------------- */
  if (!isSha(p.baseSha) || !isSha(p.headAtReconciliation))
    return { errors, warnings };
  if (!gitAvailable()) {
    warnings.push(
      `${id}: no git repository here, so the reconciled window could not be re-derived`,
    );
    return { errors, warnings };
  }
  if (!commitResolves(p.baseSha) || !commitResolves(p.headAtReconciliation)) {
    // Transient by nature (shallow clone, missing fetch), and a validator that
    // errors here would fail on every CI checkout that does not fetch depth.
    warnings.push(
      `${id}: ${short(p.baseSha)}..${short(p.headAtReconciliation)} is not fully present in this checkout, ` +
        "so the reconciled window could not be re-derived",
    );
    return { errors, warnings };
  }
  if (!isAncestorCommit(p.baseSha, p.headAtReconciliation)) {
    errors.push(
      `${id}: implementationBaseProvenance claims a window ${short(p.baseSha)}..` +
        `${short(p.headAtReconciliation)}, but the base is not an ancestor of that head; the range it ` +
        "publishes is not a real line of history",
    );
    return { errors, warnings };
  }
  for (const [field, sha] of [
    ["oldestSurfaceCommit", p.oldestSurfaceCommit],
    ["newestSurfaceCommit", p.newestSurfaceCommit],
  ]) {
    if (!isSha(sha)) continue;
    if (!commitResolves(sha)) {
      warnings.push(
        `${id}: implementationBaseProvenance.${field} ${short(sha)} is not present in this checkout`,
      );
      continue;
    }
    if (
      sha === p.baseSha ||
      !isAncestorCommit(p.baseSha, sha) ||
      !isAncestorCommit(sha, p.headAtReconciliation)
    ) {
      errors.push(
        `${id}: implementationBaseProvenance.${field} ${short(sha)} is not inside the window ` +
          `${short(p.baseSha)}..${short(p.headAtReconciliation)} it is published as part of`,
      );
    }
  }
  if (!surfaceUsable) return { errors, warnings };

  const pathspecs = reviewPathspecs(task);
  if (!pathspecs.length) return { errors, warnings };
  const commits = surfaceCommitsBetween(
    p.baseSha,
    p.headAtReconciliation,
    pathspecs,
  );
  if (commits && commits.length !== p.surfaceCommitCount) {
    warnings.push(
      `${id}: implementationBaseProvenance claims ${p.surfaceCommitCount} commit(s) under ${p.reviewSurface} ` +
        `in its window; recomputing over the current surface finds ${commits.length}. Either the declared ` +
        "surface moved after the reconciliation, or the published window is not the window",
    );
  }
  const changed = surfaceFilesChangedBetween(
    p.baseSha,
    p.headAtReconciliation,
    pathspecs,
  );
  if (changed && changed.length !== p.changedFileCount) {
    warnings.push(
      `${id}: implementationBaseProvenance claims ${p.changedFileCount} changed file(s) in its window; ` +
        `recomputing over the current surface finds ${changed.length}`,
    );
  }
  /*
   * The evidence field is re-derived too, and lands in the same bucket as the
   * counts for the same reason: `allowedPaths` and `reviewDependencies` may be
   * legitimately redeclared after a reconciliation, and a recomputation over the
   * new surface then disagrees with a record that was honest when written.
   *
   * A WARNING is therefore the strongest honest verdict, and it is worth having
   * even so: the cheap forgery on this field is an emptied list, which makes a
   * base read as untouched by the surface it precedes, and that shows up here
   * whenever the surface has not moved. Only the count is compared, not the set:
   * a set comparison is no more conclusive under redeclaration and reads as a
   * much stronger claim than it is.
   */
  if (isCount(p.baseCommitSurfaceTouchCount)) {
    const baseTouches = surfaceFilesTouchedBy(p.baseSha, pathspecs);
    if (baseTouches && baseTouches.length !== p.baseCommitSurfaceTouchCount) {
      warnings.push(
        `${id}: implementationBaseProvenance claims the base commit itself changed ` +
          `${p.baseCommitSurfaceTouchCount} file(s) under ${p.reviewSurface}; recomputing over the current ` +
          `surface finds ${baseTouches.length}. Either the declared surface moved after the reconciliation, ` +
          "or the published evidence is not what the commit contains",
      );
    }
  }
  return { errors, warnings };
}

/**
 * Checks for a task that is ALREADY DONE.
 *
 * A completed task must prove what it reviewed at the commit it reviewed --
 * not that its paths were never touched again. Applying current-HEAD drift or
 * working-tree dirt here would turn every finished broad-scope task into a
 * permanent write-lock on those paths, so a later task legitimately editing an
 * overlapping path would "invalidate" completed history.
 */
function historicalReviewProblems(task, policies) {
  const problems = reviewRecordProblems(task, policies);
  if (problems.length) return problems;
  if (!reviewRequired(task, policies) || !task.review) return problems;
  const r = task.review;

  // Without a repository there is no history to verify against; the structural
  // checks above still applied.
  if (!gitAvailable()) return problems;

  /*
   * Fingerprint provenance.
   *
   *   "git-object"  canonical, reproducible from the commit -> verify strictly
   *   "worktree"    explicitly non-canonical -> structural checks only
   *   absent        AMBIGUOUS. Records written after canonical fingerprinting
   *                 but before this field existed carry canonical hashes and
   *                 must be fully verified. Treating every missing field as
   *                 unverifiable legacy would silently demote exactly the most
   *                 recent reviews. So: attempt the canonical recomputation. A
   *                 match proves it was canonical; only a mismatch means it is
   *                 genuinely pre-canonical.
   *   anything else fail closed rather than guess.
   */
  const source = r.reviewedFingerprintSource;
  const KNOWN_SOURCES = ["git-object", "worktree"];
  if (source !== undefined && source !== null && !KNOWN_SOURCES.includes(source)) {
    problems.push(
      `unknown reviewedFingerprintSource "${source}"; refusing to guess how this review was fingerprinted`,
    );
    return problems;
  }
  if (source === "worktree") return problems;

  const declaredCanonical = source === "git-object";

  // Inability to verify is NEVER by itself a reason to accept a record. An
  // unresolvable commit is exactly what a tampered record would present, so the
  // only thing that excuses it is an exact match in the legacy registry.
  if (!commitResolves(r.reviewedCommitSha)) {
    if (!declaredCanonical && isKnownLegacyReview(task, r)) return problems;
    problems.push(
      `reviewed commit ${String(r.reviewedCommitSha).slice(0, 12)} cannot be resolved in this repository, ` +
      "so the historical review cannot be verified" +
      (declaredCanonical
        ? ""
        : ", and this record is not a known pre-canonical record in control/legacy-review-fingerprints.json"),
    );
    return problems;
  }

  const atReviewed = gitFingerprint(task, r.reviewedCommitSha);
  if (!atReviewed) {
    if (!declaredCanonical && isKnownLegacyReview(task, r)) return problems;
    problems.push(
      `cannot recompute the fingerprint at reviewed commit ${String(r.reviewedCommitSha).slice(0, 12)}` +
      (declaredCanonical
        ? ""
        : ", and this record is not a known pre-canonical record in control/legacy-review-fingerprints.json"),
    );
    return problems;
  }

  if (atReviewed.treeHash === r.reviewedTreeHash) return problems; // verified

  if (declaredCanonical) {
    problems.push(
      `review record does not match the content at its own reviewed commit ` +
      `${String(r.reviewedCommitSha).slice(0, 12)} (recorded ${String(r.reviewedTreeHash).slice(0, 12)}, ` +
      `actual ${atReviewed.treeHash.slice(0, 12)})`,
    );
    return problems;
  }

  // Absent source AND the canonical recomputation does not match.
  //
  // A mismatch is NOT evidence of a pre-canonical record: a tampered canonical
  // record produces exactly the same mismatch and would downgrade itself into
  // structural-only validation. Compatibility must be proven against an exact,
  // immutable identity, never inferred.
  if (isKnownLegacyReview(task, r)) return problems;

  problems.push(
    `review record does not match the content at its own reviewed commit ` +
    `${String(r.reviewedCommitSha).slice(0, 12)} (recorded ${String(r.reviewedTreeHash).slice(0, 12)}, ` +
    `actual ${atReviewed.treeHash.slice(0, 12)}), and it is not a known pre-canonical record in ` +
    "control/legacy-review-fingerprints.json",
  );
  return problems;
}
/**
 * Every precondition for recording a review, with no mutation and no side
 * effects. Separated so the bus can validate a message BEFORE it consumes an
 * exclusive claim, and so a rejection never leaves a half-applied transition.
 */
function assertReviewAllowed(task, reviewer, outcome, evidence) {
  const implementationAgent = task.implementationAgent ?? task.owner ?? null;
  if (!implementationAgent)
    throw new Error(
      `${task.id} has no recorded implementation agent; claim and start it through the control plane first`,
    );
  /*
   * EVERY identity on the implementation side, not just the headline one.
   *
   * `implementationAgent` and `owner` are normally the same agent, because
   * `claim` sets both. They diverge in exactly one place --
   * `start --reconcile-existing --implementation-agent <id>` -- and comparing the
   * reviewer against `implementationAgent ?? owner` there produced a real
   * escalation rather than the "no new capability" the flag claimed: asserting
   * some third party as the implementer REMOVED the owner from the comparison,
   * so on a task with no designated reviewAgent the owner could then approve
   * their own work. The flag was supposed to add an attribution, not launder one
   * away.
   *
   * A set closes it and also removes a perverse incentive that was pointing the
   * wrong way: naming a third-party implementer honestly used to be the thing
   * that unlocked self-approval, while saying nothing left the owner blocked.
   * Now the declaration can only ever ADD an implementer, so honesty costs
   * nothing and silence gains nothing.
   *
   * `scripts/cloud/gpt-review-worker.mjs` already declined work on
   * `task.implementationAgent === AGENT || task.owner === AGENT`; this brings the
   * control plane in line with the stricter of the two rather than leaving the
   * enforcement point weaker than the worker that defers to it.
   */
  const implementers = [
    ...new Set([task.implementationAgent, task.owner].filter(Boolean)),
  ];
  if (implementers.includes(reviewer.id))
    throw new Error(
      `self-approval is prohibited: ${reviewer.id} ` +
        `${reviewer.id === implementationAgent ? "implemented" : "owns the implementation round for"} ` +
        `${task.id}${implementers.length > 1 ? ` (implementation side: ${implementers.join(", ")})` : ""}`,
    );
  if (task.reviewAgent && reviewer.id !== task.reviewAgent) {
    throw new Error(
      `${task.id} requires independent review by ${task.reviewAgent}; ${reviewer.id} may not substitute automatically`,
    );
  }
  if (!REVIEW_OUTCOMES.includes(outcome))
    throw new Error(
      `Review outcome must be one of ${REVIEW_OUTCOMES.join(", ")}`,
    );
  if (!evidence) throw new Error("Review evidence/reference is required");
  return implementationAgent;
}

/**
 * Stages a review onto the in-memory task. Emits NO event: the audit record is
 * appended by the caller only after task state is durably persisted, so
 * events.jsonl can never claim a review that task state does not show.
 */
function recordReview(
  task,
  reviewer,
  outcome,
  evidence,
  boundCommitSha = null,
  boundBaseSha = null,
) {
  const implementationAgent = assertReviewAllowed(
    task,
    reviewer,
    outcome,
    evidence,
  );
  // Fingerprint the REVIEWED commit, not the working tree, so the record binds
  // to exactly the content the reviewer saw.
  const fingerprint = implementationFingerprint(task, boundCommitSha ?? "HEAD");
  const record = {
    taskId: task.id,
    implementationAgent,
    // The OTHER identity on the implementation side. These are the same agent
    // unless a reconciliation asserted a third-party implementer, and in that
    // case a record naming only `implementationAgent` would let a later
    // historical check re-derive a self-approval rule weaker than the one
    // `assertReviewAllowed` actually applied. Deliberately NOT added to
    // REVIEW_REQUIRED_FIELDS: every record written before this field existed
    // would otherwise be reported as structurally incomplete, and their owner
    // was their implementer anyway.
    implementationOwner: task.owner ?? null,
    reviewerAgent: reviewer.id,
    reviewerClass: reviewer.kind,
    reviewerProvider: reviewer.provider,
    reviewedCommitSha:
      boundCommitSha ?? currentCommitSha() ?? "unavailable-no-git",
    // The range is part of the record, not just the message evidence: an
    // endpoint alone does not say how much work the reviewer actually saw.
    reviewedBaseSha: boundBaseSha ?? task.implementationBaseSha ?? null,
    reviewedTreeHash: fingerprint.treeHash,
    reviewedFileCount: fingerprint.fileCount,
    // Records the hashing scheme so a historical check knows whether the value
    // is reproducible from a commit at all.
    reviewedFingerprintSource: fingerprint.source,
    // The widened surface, stated rather than implied. A hash cannot be read
    // backwards, so without this a reader cannot tell whether an approval bound
    // to a shared vocabulary or only to the task's own files -- and that is
    // precisely the question when deciding whether a later schema edit should
    // have invalidated this record. Empty for a task that declares none, which
    // is every task authored before the field existed.
    reviewedDependencies: [...(task.reviewDependencies ?? [])],
    outcome,
    reviewedAt: now(),
    evidence,
  };
  task.review = record;
  task.reviewHistory ??= [];
  task.reviewHistory.push(record);
  return record;
}

/** Serializable audit payload for a review. Emitted only AFTER task state is saved. */
function reviewEventPayload(task, record) {
  return {
    type: "task.review_recorded",
    details: {
      taskId: task.id,
      reviewerAgent: record.reviewerAgent,
      implementationAgent: record.implementationAgent,
      outcome: record.outcome,
      reviewedBaseSha: record.reviewedBaseSha,
      reviewedCommitSha: record.reviewedCommitSha,
      reviewedTreeHash: record.reviewedTreeHash,
      evidence: record.evidence,
    },
  };
}
/**
 * Emit the audit records a bus message intends to produce.
 *
 * Each entry is stamped with a deterministic id derived from the message id and
 * its slot in the list, so replaying the exact same intent is a no-op. Returns
 * the number actually written.
 */
function emitAudit(messageId, entries = []) {
  let written = 0;
  entries.forEach((entry, index) => {
    const id = deterministicEventId(messageId, `audit:${index}`, entry.type);
    if (event(entry.type, entry.details, id)) written++;
  });
  return written;
}
function emitProcessed(messageId, details) {
  return event(
    "bus.message_processed",
    details,
    deterministicEventId(messageId, "processed", "bus.message_processed"),
  );
}

/* ---------------------------------------------------------------------------
 * Handoff bus -> control plane
 *
 * The bus only transports. Everything a decision asserts is re-checked here
 * against the control plane before any state moves.
 * ------------------------------------------------------------------------- */

/**
 * A review decision is made against a specific commit. If HEAD has moved since
 * the reviewer looked at the code, applying the decision now would stamp the
 * CURRENT tree as approved -- silently laundering unreviewed code through the
 * bus. Refuse instead.
 */
function isAncestorCommit(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Files under the task's REVIEWED surface that changed between the reviewed
 * commit and HEAD. Returns null if the comparison cannot be made at all.
 *
 * The reviewed surface, not the write surface: this is the question "is what the
 * reviewer looked at still what is here", and the reviewer looked at the shared
 * vocabulary too. Scoping it to allowedPaths would accept an approval whose
 * dependency has moved underneath it -- the stale-fingerprint check would still
 * refuse the task at DONE, but only after the decision had been recorded as
 * valid, which is a far more confusing failure than refusing to bind it now.
 */
function reviewedPathsDrifted(sha, task) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", sha, "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (rel) =>
          !excludedFromFingerprint(rel) &&
          pathsOverlap([rel], reviewSurfacePatterns(task)),
      );
  } catch {
    return null;
  }
}

function assertCommitBinding(message, task) {
  if (!message.commitSha) {
    throw new Error(
      `${message.id} carries no commitSha; a review decision must bind to reviewed code`,
    );
  }
  const current = currentCommitSha();
  // Fail CLOSED. If HEAD cannot be resolved we cannot prove the decision applies
  // to the code in front of us, and accepting it would let any fabricated sha
  // through.
  if (!current) {
    throw new Error(
      `${message.id}: cannot resolve HEAD, so a commit-bound review decision cannot be verified; refusing to apply it`,
    );
  }

  if (process.env.LIBERTY_COMMIT_SHA) {
    // Test harness: the fixture repositories have no git history, so fall back
    // to strict equality.
    if (current !== message.commitSha) {
      throw new Error(
        `stale handoff: ${message.id} reviewed ${message.commitSha.slice(0, 12)} but HEAD is ${current.slice(0, 12)}`,
      );
    }
  } else if (current !== message.commitSha) {
    // HEAD moving is NORMAL: publishing a handoff is itself a commit, so a round
    // trip always advances it. Requiring equality would deadlock every exchange.
    // What must actually hold is that nothing the reviewer looked at has changed.
    if (!isAncestorCommit(message.commitSha, current)) {
      throw new Error(
        `stale handoff: ${message.id} reviewed ${message.commitSha.slice(0, 12)}, which is not an ancestor of HEAD ` +
          `${current.slice(0, 12)}; the branch was rewritten or the review targets unrelated history`,
      );
    }
    const drifted = reviewedPathsDrifted(message.commitSha, task);
    if (drifted === null) {
      throw new Error(
        `${message.id}: cannot diff ${message.commitSha.slice(0, 12)} against HEAD; refusing to apply`,
      );
    }
    if (drifted.length) {
      throw new Error(
        `stale handoff: ${message.id} reviewed ${message.commitSha.slice(0, 12)}, but ${drifted.length} reviewed file(s) ` +
          `changed since: ${drifted.slice(0, 5).join(", ")}${drifted.length > 5 ? ", ..." : ""}; request a fresh review`,
      );
    }
  }
  // Canonical fingerprints cannot see uncommitted work, so a dirty
  // implementation tree is rejected explicitly rather than silently accepted.
  if (taskWorktreeIsDirty(task)) {
    throw new Error(
      `${message.id}: this task's allowedPaths have uncommitted changes, so the working tree does not match ` +
        `reviewed commit ${message.commitSha.slice(0, 12)}; commit or stash before applying a review decision`,
    );
  }
}

/**
 * A defect in the message itself. Messages are immutable, so this can never
 * become valid and the message is quarantined permanently.
 */
class PermanentRejection extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentRejection";
    this.permanent = true;
  }
}

/**
 * Every precondition, checked without mutating anything.
 *
 * Runs BEFORE the exclusive claim is taken, so a message that can never apply
 * does not consume a claim and does not need rollback. Failures are classified:
 * PermanentRejection means the message is defective and is quarantined; a plain
 * Error means the repository is not ready yet and the message will be retried.
 */
const reviewGit = gitAdapter(execFileSync, root);

/**
 * Validate an INBOUND review range.
 *
 * Creation-time checks only protect messages we publish ourselves. A message
 * arriving over the bus is peer-authored and untrusted: it may be hand-written,
 * stale, or replayed. A decision that names a valid commitSha but the wrong
 * range is the dangerous case, because it looks correct while covering less
 * work than the reviewer was asked to judge.
 */
/**
 * Thin mapping of the SHARED validator onto this module's error types.
 * The GPT worker uses the same implementation, so the two sides cannot drift.
 */
function assertReviewRange(message, task) {
  const result = validateReviewRange({
    baseSha: message.baseSha,
    commitSha: message.commitSha,
    task,
    label: message.id,
    git: reviewGit,
  });
  if (result.status === RANGE_PERMANENT) throw new PermanentRejection(result.reason);
  if (result.status === RANGE_TRANSIENT) throw new Error(result.reason);
}

function validateBusMessage(d, message, actingAgent) {
  // --- permanent: intrinsic to the message ---
  if (message.toAgent !== actingAgent) {
    throw new PermanentRejection(
      `${message.id} is addressed to ${message.toAgent}, not ${actingAgent}`,
    );
  }
  const structural = validateMessage(message);
  if (structural.length) {
    throw new PermanentRejection(
      `${message.id} is malformed:\n  - ${structural.join("\n  - ")}`,
    );
  }

  if (
    message.type === "review_approved" ||
    message.type === "changes_requested"
  ) {
    let task;
    let reviewer;
    try {
      task = requireTask(d.taskDoc, message.taskId);
      reviewer = requireAgent(d, message.fromAgent);
    } catch (error) {
      throw new PermanentRejection(error.message);
    }
    const outcome =
      message.type === "review_approved" ? "APPROVED" : "CHANGES_REQUESTED";

    // --- transient: depends on repository state, so it may resolve later ---
    // Checked FIRST. A task that is not yet in REVIEW has no owner and no
    // implementation agent, so the reviewer checks below would fail for a purely
    // situational reason and permanently quarantine a decision that is merely
    // early. A stale sha, a moved HEAD and a dirty tree are the same class.
    if (task.status !== "REVIEW") {
      throw new Error(
        `${task.id} is ${task.status}; a review decision only applies to a task in REVIEW`,
      );
    }

    // --- permanent: reviewer identity and range are intrinsic to the message ---
    // Only meaningful once the task is in REVIEW and an implementation agent
    // exists to compare against.
    try {
      assertReviewAllowed(task, reviewer, outcome, busEvidence(message));
    } catch (error) {
      throw new PermanentRejection(error.message);
    }
    assertReviewRange(message, task);

    assertCommitBinding(message, task);
  }

  if (message.type === "review_request") {
    let task;
    let requester;
    try {
      task = requireTask(d.taskDoc, message.taskId);
      requester = requireAgent(d, message.fromAgent);
    } catch (error) {
      throw new PermanentRejection(error.message);
    }

    // Repository state can legitimately lag behind an immutable request, so an
    // early request remains retryable. Once implementation is in progress, the
    // sender and recipient are fixed properties and identity failures are final.
    if (task.status !== "IN_PROGRESS") {
      throw new Error(
        `${task.id} is ${task.status}; a review request only applies to a task in IN_PROGRESS`,
      );
    }

    const implementationAgent = task.implementationAgent ?? task.owner ?? null;
    if (!implementationAgent) {
      throw new Error(
        `${task.id} has no recorded implementation agent; claim and start it through the control plane first`,
      );
    }
    if (requester.id !== implementationAgent) {
      throw new PermanentRejection(
        `${message.id} claims ${requester.id} requested review, but ${implementationAgent} implements ${task.id}`,
      );
    }
    if (message.toAgent !== task.reviewAgent) {
      throw new PermanentRejection(
        `${task.id} requires independent review by ${task.reviewAgent}, not ${message.toAgent}`,
      );
    }
    if (requester.id === message.toAgent) {
      throw new PermanentRejection(
        `self-review is prohibited: ${requester.id} cannot request review from itself for ${task.id}`,
      );
    }

    // Enter review only against the same committed implementation named by the
    // requester. The returning decision is independently bound again.
    assertCommitBinding(message, task);
  }

  if (message.type === "blocker" && message.taskId) {
    try {
      requireTask(d.taskDoc, message.taskId);
    } catch (error) {
      throw new PermanentRejection(error.message);
    }
  }
}

function busEvidence(message) {
  return message.evidence?.length
    ? `${message.summary} [${message.evidence.join("; ")}] (via ${message.id})`
    : `${message.summary} (via ${message.id})`;
}

function applyBusMessage(d, message, actingAgent) {
  validateBusMessage(d, message, actingAgent);

  switch (message.type) {
    case "review_approved":
    case "changes_requested": {
      const task = requireTask(d.taskDoc, message.taskId);
      const reviewer = requireAgent(d, message.fromAgent);
      const outcome =
        message.type === "review_approved" ? "APPROVED" : "CHANGES_REQUESTED";
      // Routed through the same enforcement path as a manual review: reviewer
      // identity, self-approval, designated reviewer and fingerprint binding all
      // still apply. The bus cannot bypass any of them.
      const record = recordReview(
        task,
        reviewer,
        outcome,
        busEvidence(message),
        message.commitSha,
        message.baseSha,
      );
      if (outcome === "CHANGES_REQUESTED")
        transition(task, "IN_PROGRESS", d.policies);
      return {
        summary: `${outcome} recorded on ${task.id} by ${reviewer.id}`,
        // Audit entries are DATA, not closures, so the journal can persist them
        // and crash recovery can emit exactly the same records.
        audit: [reviewEventPayload(task, record)],
      };
    }
    case "blocker": {
      if (!message.taskId)
        return { summary: "blocker noted (no task referenced)", audit: [] };
      const task = requireTask(d.taskDoc, message.taskId);
      if (task.status !== "BLOCKED") transition(task, "BLOCKED", d.policies);
      const reason = `${message.summary} (via ${message.id})`;
      task.blocker = reason;
      return {
        summary: `${task.id} BLOCKED`,
        audit: [
          {
            type: "task.blocked",
            details: { taskId: task.id, reason, source: message.id },
          },
        ],
      };
    }
    case "task_instruction":
    case "architecture_decision":
    case "implementation_ready":
      // Informational on receipt. These drive work, not automatic transitions:
      // nothing should silently change task state because a peer said so.
      return { summary: `${message.type} recorded for follow-up`, audit: [] };
    case "review_request": {
      const task = requireTask(d.taskDoc, message.taskId);
      transition(task, "REVIEW", d.policies);
      return {
        summary: `${task.id} moved to REVIEW for ${task.reviewAgent}`,
        audit: [
          {
            type: "task.review_requested",
            details: {
              taskId: task.id,
              owner: task.owner,
              reviewAgent: task.reviewAgent,
              requestedBy: message.fromAgent,
              reviewedCommitSha: message.commitSha,
              source: message.id,
            },
          },
        ],
      };
    }
    default:
      throw new Error(`no handler for message type ${message.type}`);
  }
}

function flagValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined
    ? args[index + 1]
    : fallback;
}
function flagValues(args, name) {
  const out = [];
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1] !== undefined)
      out.push(args[index + 1]);
  });
  return out;
}
function describeMessage(m) {
  return [
    `${m.id}`,
    `  ${m.fromAgent} -> ${m.toAgent}  [${m.type}]  status=${m.status}`,
    m.taskId ? `  task: ${m.taskId}` : null,
    m.commitSha ? `  commit: ${m.commitSha}` : null,
    `  ${m.summary}`,
    m.evidence?.length ? `  evidence: ${m.evidence.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function saveTasks(taskDoc) {
  writeJson(files.tasks, taskDoc);
}
function requireTask(taskDoc, id) {
  const task = taskDoc.tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}
function requireAgent(d, id) {
  const agent = d.agentDoc.agents.find((a) => a.id === id);
  if (!agent) throw new Error(`Unknown agent ${id}`);
  return agent;
}
function transition(task, next, policies) {
  const allowed = policies.transitions[task.status] ?? [];
  if (!allowed.includes(next))
    throw new Error(
      `Invalid transition ${task.status} -> ${next} for ${task.id}`,
    );
  task.status = next;
  task.updatedAt = now();
}
function allGatesPassed(task) {
  return (task.qualityGates ?? []).every(
    (gate) => task.gateResults?.[gate]?.status === "pass",
  );
}
/**
 * Discard gate evidence when a task stops having an owner and returns to a
 * queue. Returns the names dropped, so the audit trail says what was discarded
 * rather than leaving a silent gap.
 *
 * This is the SAME defect as the gate hole, reached entirely through legitimate
 * commands: `release` and `unblock` both null the owner and put the task back in
 * READY/BACKLOG while leaving gateResults behind. The next claimant -- possibly a
 * different agent, certainly a different implementation round -- inherits passing
 * evidence for work that no longer exists, and `done` accepts it. Re-recording a
 * gate costs one command; noticing an inherited one costs an audit.
 *
 * Deliberately NOT called from `done`, which also nulls the owner. There the
 * gate results are the completion evidence and must persist as history.
 */
function dropGateResults(task) {
  const dropped = Object.keys(task.gateResults ?? {});
  task.gateResults = {};
  return dropped;
}
function validateState(d) {
  const {
    taskDoc,
    agentDoc,
    gateDoc,
    policies,
    milestoneDoc = { milestones: [] },
  } = d;
  const errors = [];
  const warnings = [];
  const tasks = taskDoc.tasks ?? [];
  const agents = agentDoc.agents ?? [];
  const gates = gateDoc.gates ?? {};
  const map = taskMap(tasks);
  const amap = agentMap(agents);
  const ids = new Set();
  for (const task of tasks) {
    /*
     * Can this task's reviewed surface be computed at all?
     *
     * The two fingerprint-derived checks at the end of this loop call into
     * `review-surface.mjs`, which fails CLOSED rather than guessing at a surface
     * it cannot determine -- so running them against a task whose
     * reviewDependencies were just reported as invalid would abort the entire
     * validation with a stack trace, reporting nothing about the other thirty
     * tasks and never printing the message that names the offending field. The
     * task is already invalid and already blocking; a second finding derived
     * from a surface we just refused to compute would add nothing to it.
     */
    let reviewSurfaceUsable = true;
    if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!policies.statuses.includes(task.status))
      errors.push(`${task.id}: invalid status ${task.status}`);
    for (const dep of task.dependencies ?? [])
      if (!map.has(dep)) errors.push(`${task.id}: missing dependency ${dep}`);
    if (task.preferredAgent && !amap.has(task.preferredAgent))
      errors.push(`${task.id}: unknown preferredAgent ${task.preferredAgent}`);
    if (task.reviewAgent && !amap.has(task.reviewAgent))
      errors.push(`${task.id}: unknown reviewAgent ${task.reviewAgent}`);
    if (task.owner && !amap.has(task.owner))
      errors.push(`${task.id}: unknown owner ${task.owner}`);
    for (const gate of task.qualityGates ?? [])
      if (!gates[gate]) errors.push(`${task.id}: unknown quality gate ${gate}`);
    if (!task.acceptance) warnings.push(`${task.id}: missing acceptance text`);
    if (!task.allowedPaths?.length)
      warnings.push(
        `${task.id}: no allowedPaths; parallel write protection is weaker`,
      );
    /*
     * A root-normalizing allowedPath is an ERROR, not a warning, and the reason
     * is not the collision surface -- `pathsOverlap` already treats an empty
     * prefix as overlapping everything, so the old warning's claim that it "will
     * conflict with every other task" was true. It is everything else.
     *
     * `taskPathspecs` drops the entry, and from there THREE protections quietly
     * switch off at once: the fingerprint hashes zero files, so the stale-review
     * check can never fail and the approval binds to nothing; `taskWorktreeIsDirty`
     * sees no pathspecs and reports clean, so uncommitted work stops blocking
     * completion; and `select-task.mjs` stops seeing any orchestration prefix, so
     * a task owning the entire repository -- scripts/, control/, .github/ included
     * -- reads as autonomously workable. A declaration that broad cannot be
     * allowed to arrive as advice.
     *
     * `scripts/cloud/task-patch.mjs` already refuses "unbounded scope" outright
     * rather than warning about it; this brings the validator into line with the
     * strictest existing consumer instead of leaving them to disagree.
     */
    for (const p of task.allowedPaths ?? []) {
      if (normalizesToRepositoryRoot(p))
        errors.push(
          `${task.id}: allowedPath "${p}" normalizes to the repository root; it is dropped from the fingerprint, ` +
            "the dirty-tree check and the autonomy guard, and conflicts with every other task. " +
            "List the directories this task actually writes",
        );
    }
    /*
     * reviewDependencies widens ONLY the reviewed surface; it grants no write
     * permission and reserves nothing.
     *
     * A malformed entry is an error, not a warning. The fingerprint refuses to
     * guess at a surface it cannot determine, so the alternative to reporting it
     * here is every review and completion command for that task dying on a
     * runtime error with no indication of which field caused it.
     */
    if (task.reviewDependencies !== undefined) {
      if (!Array.isArray(task.reviewDependencies)) {
        errors.push(
          `${task.id}: reviewDependencies must be an array of path globs`,
        );
        reviewSurfaceUsable = false;
      } else {
        const writable = taskPathspecs(task);
        for (const p of task.reviewDependencies) {
          if (typeof p !== "string" || !p.trim()) {
            errors.push(
              `${task.id}: reviewDependencies entries must be non-empty strings, got ${JSON.stringify(p)}`,
            );
            reviewSurfaceUsable = false;
            continue;
          }
          if (normalizesToRepositoryRoot(p)) {
            /*
             * THE OBSERVED DEFECT. This was a warning saying the entry "protects
             * nothing", and that was an accurate description of a control plane
             * doing the wrong thing: `reviewSurfacePatterns` accepted any
             * non-empty string, `reviewPathspecs` then dropped it, and a task
             * declaring `reviewDependencies: ["**"]` was fingerprinted exactly
             * like a task declaring none. The approval came out NARROWER than
             * the task declared, which is the single failure this field exists
             * to prevent, and the operator was told about it in the same breath
             * as thirty other advisory lines.
             *
             * Warning-and-drop is never a safe answer for a protection: the
             * declaration is the operator's stated intent, so the only honest
             * responses are to honour it or to refuse it. Honouring "**" would
             * mean whole-repository review semantics, which nothing here
             * implements -- `classifyReviewPath` would still call every path
             * "outside" -- so it is refused, and `reviewSurfacePatterns` throws
             * for anything that bypasses this check.
             */
            errors.push(
              `${task.id}: reviewDependency "${p}" normalizes to the repository root, which is not a reviewable ` +
                "surface: it would be dropped from the fingerprint, making the approval narrower than declared. " +
                "Declare the directories the review actually depends on",
            );
            reviewSurfaceUsable = false;
            continue;
          }
          const dep = normalizePrefix(p);
          // Redundant, never wrong. allowedPaths is already inside the reviewed
          // surface and the union is idempotent, so this changes no hash, no
          // collision decision and no gate. Making it an error would mean a
          // later, unrelated widening of allowedPaths retroactively invalidates
          // the whole control plane -- a far worse failure than a duplicated
          // glob, and one a task editing its own paths could not foresee.
          const covering = writable.find(
            (w) => dep === w || dep.startsWith(w + "/"),
          );
          if (covering) {
            warnings.push(
              `${task.id}: reviewDependency "${p}" is already inside allowedPath "${covering}"; allowedPaths is always part of the reviewed surface, so this entry is redundant`,
            );
          }
        }
      }
    }
    if (
      task.preferredAgent &&
      amap.has(task.preferredAgent) &&
      capabilityScore(amap.get(task.preferredAgent), task) < 0
    ) {
      warnings.push(
        `${task.id}: preferredAgent ${task.preferredAgent} does not advertise lane ${task.lane}`,
      );
    }
    if (
      task.status === "READY" &&
      !agents.some((a) => capabilityScore(a, task) >= 0)
    ) {
      errors.push(
        `${task.id}: READY but no registered agent advertises lane ${task.lane}`,
      );
    }

    /*
     * A reconciliation record must agree with the field it explains, with the
     * history it publishes, and with the audit trail that should have produced
     * it. The checks live in `reconciliationProvenanceProblems`, next to the
     * command that writes the record, so the writer and the validator cannot
     * drift into disagreeing about what a well-formed record is.
     */
    if (task.implementationBaseProvenance !== undefined) {
      const provenance = reconciliationProvenanceProblems(
        task,
        amap,
        reviewSurfaceUsable,
      );
      errors.push(...provenance.errors);
      warnings.push(...provenance.warnings);
    }

    if (task.review) {
      if (!amap.has(task.review.reviewerAgent))
        errors.push(
          `${task.id}: review record names unknown reviewer ${task.review.reviewerAgent}`,
        );
      if (
        task.review.reviewerAgent === task.review.implementationAgent ||
        // Same widening as reviewRecordProblems: the round's owner is on the
        // implementation side even when a reconciliation named someone else as
        // the implementer. Checked only when the field is present, so records
        // written before it existed keep validating exactly as they did.
        (task.review.implementationOwner &&
          task.review.reviewerAgent === task.review.implementationOwner)
      )
        errors.push(
          `${task.id}: review record is a self-approval by ${task.review.reviewerAgent}`,
        );
      if (!REVIEW_OUTCOMES.includes(task.review.outcome))
        errors.push(
          `${task.id}: invalid review outcome ${task.review.outcome}`,
        );
      if (
        task.status !== "DONE" &&
        task.review.outcome === "APPROVED" &&
        reviewSurfaceUsable
      ) {
        const current = implementationFingerprint(task);
        if (current.treeHash !== task.review.reviewedTreeHash)
          warnings.push(
            `${task.id}: approval is stale; implementation changed since review`,
          );
      }
    }
    if (task.status === "DONE" && reviewSurfaceUsable) {
      // Historical integrity only: a completed task proves what it reviewed at
      // its own reviewed commit. It does not get to write-lock those paths
      // against every future task.
      for (const p of historicalReviewProblems(task, policies)) {
        errors.push(`${task.id} is DONE but ${p}`);
      }
    }
  }

  for (const milestone of milestoneDoc.milestones ?? []) {
    for (const id of milestone.tasks ?? [])
      if (!map.has(id))
        errors.push(`milestone ${milestone.id}: unknown task ${id}`);
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail = []) {
    if (visiting.has(id)) {
      errors.push(`dependency cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of map.get(id)?.dependencies ?? [])
      visit(dep, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);

  const activeTasks = tasks.filter((t) => active(t, policies));
  for (let i = 0; i < activeTasks.length; i++) {
    for (let j = i + 1; j < activeTasks.length; j++) {
      const a = activeTasks[i],
        b = activeTasks[j];
      if (a.owner !== b.owner && pathsOverlap(a.allowedPaths, b.allowedPaths)) {
        errors.push(
          `active write-path conflict: ${a.id} (${a.owner}) overlaps ${b.id} (${b.owner})`,
        );
      }
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
function renderTaskBoard(project, tasks) {
  const lines = [
    `# ${project.name} Task Board`,
    "",
    "> Generated from `control/tasks.json`. Do not edit status here; use `npm run ai:*` commands.",
    "",
    "Statuses: `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `REVIEW`, `BLOCKED`, `DONE`, `CANCELED`.",
    "",
    "| ID | Priority | Lane | Status | Owner | Review | Task | Acceptance |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const t of [...tasks].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.id.localeCompare(b.id),
  )) {
    const review = t.review
      ? `${t.review.outcome} by ${t.review.reviewerAgent}`
      : "-";
    lines.push(
      `| ${t.id} | ${t.priority} | ${t.lane} | ${t.status} | ${t.owner ?? "-"} | ${review} | ${t.title.replaceAll("|", "\\|")} | ${t.acceptance.replaceAll("|", "\\|")} |`,
    );
  }
  return lines.join("\n") + "\n";
}
function renderStatus(d) {
  const {
    project,
    taskDoc,
    agentDoc,
    policies,
    milestoneDoc = { milestones: [] },
  } = d;
  // Refresh first so the status counts below and the dispatch classification
  // further down are computed from the same task statuses.
  refreshReadiness(taskDoc.tasks);
  const tasks = taskDoc.tasks;
  const agents = agentDoc.agents;
  const counts = Object.fromEntries(
    policies.statuses.map((s) => [
      s,
      tasks.filter((t) => t.status === s).length,
    ]),
  );
  const activeTasks = tasks.filter((t) => active(t, policies));
  const blockers = tasks.filter((t) => t.status === "BLOCKED");
  const done = counts.DONE ?? 0;
  const total = tasks.filter((t) => t.status !== "CANCELED").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const classification = classifyTasks(d);
  const wave = planExecutableWave(d, classification);
  const lines = [
    `# ${project.name} - Project Status`,
    "",
    `> Generated ${now()} from the AI control plane.`,
    "",
    `**Overall completion:** ${done}/${total} executable tasks (${pct}%)`,
    "",
    "## Status summary",
    "",
    ...policies.statuses.map((s) => `- **${s}:** ${counts[s] ?? 0}`),
    "",
    "## Milestones / phases",
    "",
  ];
  for (const milestone of milestoneDoc.milestones ?? []) {
    const mtasks = (milestone.tasks ?? [])
      .map((id) => tasks.find((t) => t.id === id))
      .filter(Boolean);
    const mdone = mtasks.filter((t) => t.status === "DONE").length;
    const mblocked = mtasks.filter((t) => t.status === "BLOCKED").length;
    const mactive = mtasks.filter((t) => active(t, policies)).length;
    const mpct = mtasks.length ? Math.round((mdone / mtasks.length) * 100) : 0;
    const state =
      mdone === mtasks.length && mtasks.length
        ? "COMPLETE"
        : mblocked &&
            !mactive &&
            !mtasks.some((t) => ["READY", "BACKLOG"].includes(t.status))
          ? "BLOCKED"
          : mactive || mdone > 0
            ? "IN_PROGRESS"
            : "NOT_STARTED";
    lines.push(
      `- **${milestone.id} — ${milestone.name}:** ${state}, ${mdone}/${mtasks.length} (${mpct}%)${mblocked ? `, ${mblocked} blocked` : ""}`,
    );
  }
  lines.push("", "## Active work", "");
  if (!activeTasks.length)
    lines.push("No tasks are currently claimed, in progress, or in review.");
  else
    for (const t of activeTasks)
      lines.push(
        `- **${t.id}** [${t.status}] ${t.title} — owner: ${t.owner ?? "unassigned"}`,
      );

  lines.push("", "## Dispatch classification", "");
  lines.push(
    `- **READY_AND_EXECUTABLE:** ${classification.readyAndExecutable.length}`,
  );
  lines.push(
    `- **READY_BUT_EXTERNAL:** ${classification.readyButExternal.length}`,
  );
  lines.push(`- **BLOCKED:** ${classification.blocked.length}`);
  lines.push(
    `- **BACKLOG (dependency-gated):** ${classification.backlog.length}`,
  );

  lines.push("", "## Recommended executable wave", "");
  if (!wave.length)
    lines.push(
      "No conflict-free executable tasks can be assigned with current agent capacity.",
    );
  else
    for (const { task, agent } of wave)
      lines.push(
        `- **${task.id}** -> ${agent.id} (${task.priority}/${task.lane}) ${task.title}`,
      );

  lines.push("", "## Queued for external agents", "");
  if (!classification.readyButExternal.length)
    lines.push("No READY work is waiting on an external agent lane.");
  else
    for (const { task, reason } of classification.readyButExternal)
      lines.push(
        `- **${task.id}** (${task.priority}/${task.lane}) ${task.title} — ${reason}`,
      );

  lines.push("", "## Blockers", "");
  if (!blockers.length) lines.push("No blockers recorded.");
  else
    for (const t of blockers)
      lines.push(
        `- **${t.id}** ${t.title}: ${t.blocker ?? "reason not recorded"}`,
      );
  lines.push("", "## Agent capacity", "");
  const usage = usageByAgent(tasks, policies);
  for (const a of agents) {
    lines.push(
      `- **${a.id}:** ${usage.get(a.id) ?? 0}/${a.maxParallel} active${agentExecutable(a, d) ? "" : " (external lane; not locally executable)"}`,
    );
  }
  return lines.join("\n") + "\n";
}
function generateQueues(d) {
  const { taskDoc, agentDoc, policies } = d;
  const tasks = taskDoc.tasks;
  fs.mkdirSync(files.queues, { recursive: true });
  const classification = classifyTasks(d);
  const externalByAgent = new Map();
  for (const entry of classification.readyButExternal) {
    const key = entry.agent?.id ?? "unassigned";
    if (!externalByAgent.has(key)) externalByAgent.set(key, []);
    externalByAgent.get(key).push({
      id: entry.task.id,
      title: entry.task.title,
      priority: entry.task.priority,
      lane: entry.task.lane,
      reason: entry.reason,
    });
  }
  for (const agent of agentDoc.agents) {
    const assigned = tasks.filter(
      (t) => t.owner === agent.id && active(t, policies),
    );
    const review = tasks.filter(
      (t) => t.status === "REVIEW" && t.reviewAgent === agent.id,
    );
    const recommended = tasks
      .filter((t) => t.status === "READY" && capabilityScore(agent, t) >= 0)
      .sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          capabilityScore(agent, b) - capabilityScore(agent, a),
      )
      .slice(0, 20);
    writeJson(path.join(files.queues, `${agent.id}.json`), {
      generatedAt: now(),
      agent: agent.id,
      executionAvailable: agentExecutable(agent, d),
      assigned,
      review,
      reservedExternal: externalByAgent.get(agent.id) ?? [],
      recommended,
    });
  }
}
function syncAll(d, shouldEvent = true) {
  refreshReadiness(d.taskDoc.tasks);
  saveTasks(d.taskDoc);
  fs.mkdirSync(path.dirname(files.statusMd), { recursive: true });
  fs.writeFileSync(files.tasksMd, renderTaskBoard(d.project, d.taskDoc.tasks));
  fs.writeFileSync(files.statusMd, renderStatus(d));
  generateQueues(d);
  if (shouldEvent) event("control.sync", { tasks: d.taskDoc.tasks.length });
}

const [command = "help", ...args] = process.argv.slice(2);
try {
  const d = data();
  if (command === "validate") {
    refreshReadiness(d.taskDoc.tasks);
    const result = validateState(d);
    for (const w of result.warnings) console.warn(`WARN: ${w}`);
    if (result.errors.length) {
      for (const e of result.errors) console.error(`ERROR: ${e}`);
      process.exit(1);
    }
    console.log(
      `AI control plane valid: ${d.taskDoc.tasks.length} tasks, ${d.agentDoc.agents.length} agents.`,
    );
  } else if (command === "sync") {
    syncAll(d);
    console.log(
      "Synced machine state to human-readable status and agent queues.",
    );
  } else if (command === "status") {
    console.log(renderStatus(d));
  } else if (command === "ready") {
    const c = classifyTasks(d);
    for (const t of [...c.readyAndExecutable].sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    )) {
      console.log(
        `READY_AND_EXECUTABLE\t${t.id}\t${t.priority}\t${t.lane}\t${t.preferredAgent ?? "auto"}\t${t.title}`,
      );
    }
    for (const { task: t, agent } of c.readyButExternal) {
      console.log(
        `READY_BUT_EXTERNAL\t${t.id}\t${t.priority}\t${t.lane}\t${agent?.id ?? "unassigned"}\t${t.title}`,
      );
    }
    for (const { task: t, reason } of c.blocked) {
      console.log(
        `BLOCKED\t${t.id}\t${t.priority}\t${t.lane}\t-\t${t.title} (${reason})`,
      );
    }
  } else if (command === "dispatch") {
    const apply = args.includes("--apply");
    const c = classifyTasks(d);
    const wave = planExecutableWave(d, c);

    console.log("=== READY_AND_EXECUTABLE (dispatchable now) ===");
    if (!wave.length)
      console.log(
        "(none) No conflict-free executable tasks can be assigned with current agent capacity.",
      );
    for (const { task, agent } of wave)
      console.log(
        `${task.id} -> ${agent.id} (${task.priority}/${task.lane}) ${task.title}`,
      );

    const deferred = deferredReasons(d, c, wave);
    if (deferred.length) {
      console.log("\n--- deferred to a later wave ---");
      for (const { task, reason } of deferred)
        console.log(
          `${task.id} (${task.priority}/${task.lane}) ${task.title} — ${reason}`,
        );
    }

    console.log(
      "\n=== READY_BUT_EXTERNAL (reserved; does not reduce the local wave) ===",
    );
    if (!c.readyButExternal.length) console.log("(none)");
    for (const { task, agent, reason } of c.readyButExternal) {
      console.log(
        `${task.id} [${agent?.id ?? "unassigned"}] (${task.priority}/${task.lane}) ${task.title} — ${reason}`,
      );
    }

    console.log("\n=== BLOCKED ===");
    if (!c.blocked.length) console.log("(none)");
    for (const { task, reason } of c.blocked)
      console.log(
        `${task.id} (${task.priority}/${task.lane}) ${task.title} — ${reason}`,
      );

    if (apply) {
      for (const { task, agent } of wave) {
        task.owner = agent.id;
        task.implementationAgent = agent.id;
        transition(task, "CLAIMED", d.policies);
        event("task.claimed", {
          taskId: task.id,
          agentId: agent.id,
          source: "dispatch",
        });
      }
      syncAll(d, false);
      console.log(`\nClaimed ${wave.length} tasks.`);
    }
  } else if (command === "queue") {
    const agentId = args[0];
    if (!agentId) throw new Error("Usage: queue <agentId>");
    requireAgent(d, agentId);
    syncAll(d, false);
    console.log(
      fs.readFileSync(path.join(files.queues, `${agentId}.json`), "utf8"),
    );
  } else if (command === "claim") {
    const [taskId, agentId] = args;
    if (!taskId || !agentId) throw new Error("Usage: claim <taskId> <agentId>");
    refreshReadiness(d.taskDoc.tasks);
    const task = requireTask(d.taskDoc, taskId);
    const agent = requireAgent(d, agentId);
    if (task.status !== "READY")
      throw new Error(`${taskId} is ${task.status}, not READY`);
    if (capabilityScore(agent, task) < 0)
      throw new Error(
        `${agentId} does not advertise capability for lane ${task.lane}`,
      );
    const usage = usageByAgent(d.taskDoc.tasks, d.policies).get(agentId) ?? 0;
    if (usage >= agent.maxParallel)
      throw new Error(`${agentId} is at maxParallel ${agent.maxParallel}`);
    const conflict = conflictWithActive(task, d.taskDoc.tasks, d.policies);
    if (conflict)
      throw new Error(
        `${task.id} paths overlap active task ${conflict.id} owned by ${conflict.owner}`,
      );
    task.owner = agentId;
    task.implementationAgent = agentId;
    transition(task, "CLAIMED", d.policies);
    event("task.claimed", { taskId, agentId });
    syncAll(d, false);
    console.log(`${taskId} claimed by ${agentId}.`);
  } else if (command === "start") {
    /*
     * Two operations, one command, and deliberately no way to slide from one
     * into the other.
     *
     *   start <taskId> [agentId]
     *       Ordinary start. Captures HEAD as the base. Unchanged, and it must
     *       stay unchanged: every worker script and every documented invocation
     *       is this form.
     *
     *   start <taskId> [agentId] --reconcile-existing --base <sha> --reason "..."
     *                            [--implementation-agent <id>]
     *       Provenance reconciliation for an implementation that was written and
     *       COMMITTED BEFORE this task was claimed. Records the real
     *       pre-implementation commit instead of HEAD. "Committed", not
     *       "pushed": nothing on this path consults a remote, so the wider claim
     *       would be one the checks do not make.
     *
     * It shares `start` rather than becoming its own subcommand so that the
     * status machine, the ownership rule and the single write to
     * implementationBaseSha exist in exactly one place. A parallel
     * `reconcile-start` would be a second copy of the lifecycle, and two copies
     * of one policy drift -- this repository has already paid for that lesson
     * twice (the gate executor tables, the review-range validators). What makes
     * the operation impossible to reach by accident is not a separate command
     * name but the argument contract below: three flags must be present at once,
     * none of them means anything without the others, and each is refused
     * outright on an ordinary start.
     */
    const RECONCILE_FLAG = "--reconcile-existing";
    const VALUE_FLAGS = ["--base", "--implementation-agent", "--reason"];
    const KNOWN_FLAGS = new Set([RECONCILE_FLAG, ...VALUE_FLAGS]);
    /*
     * PRESENT and PRESENT-WITH-A-VALUE are different facts, and this command is
     * the one place where conflating them is unsafe.
     *
     * `flagValue` returns its fallback when the next argument is missing, so a
     * `--base` whose sha was lost to shell quoting or an empty variable came back
     * as null -- indistinguishable from "the operator never passed --base". The
     * refusal loop below only rejected non-null values, so
     * `ai:start -- PL-X claude-lead --base` recorded HEAD and printed success:
     * the accepted-and-ignored `--base` this whole mechanism calls the worst
     * available outcome, reachable through the mechanism itself.
     *
     * A following token that is itself one of this command's flags is also
     * treated as "no value", so `--base --reason "..."` cannot silently consume
     * `--reason` as a sha. Only this command's own flags qualify: an arbitrary
     * `--`-prefixed string could legitimately be the start of a --reason.
     */
    const valueFlag = (name) => {
      const index = args.indexOf(name);
      if (index < 0) return { present: false, value: null };
      const next = args[index + 1];
      return {
        present: true,
        value: next === undefined || KNOWN_FLAGS.has(next) ? null : next,
      };
    };
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (VALUE_FLAGS.includes(args[i])) {
        // Skip the value, but never skip another flag: the refusals below have
        // to see it.
        if (args[i + 1] !== undefined && !KNOWN_FLAGS.has(args[i + 1])) i++;
        continue;
      }
      if (args[i] === RECONCILE_FLAG) continue;
      // A mistyped flag must not fall through into the positional slots, where
      // it would be read as an agent id and produce an ownership error that says
      // nothing about the real mistake.
      if (args[i].startsWith("--"))
        throw new Error(
          `Unknown option ${args[i]}. Usage: start <taskId> [agentId] ` +
            `[${RECONCILE_FLAG} --base <sha> --reason "..." [--implementation-agent <id>]]`,
        );
      positional.push(args[i]);
    }
    const [taskId, agentId] = positional;
    const reconcile = args.includes(RECONCILE_FLAG);
    // Named `*Flag` because the reconcile block below binds `implementer` to the
    // resolved AGENT; two different things called the same name in nested scopes
    // is how a later edit reads the wrong one.
    const baseFlag = valueFlag("--base");
    const implementerFlag = valueFlag("--implementation-agent");
    const reasonFlag = valueFlag("--reason");
    const baseArg = baseFlag.value;
    const assertedImplementer = implementerFlag.value;
    const reconcileReason = reasonFlag.value;

    /*
     * The flags are refused on an ordinary start rather than ignored.
     *
     * Accepting `--base` silently would be the worst available outcome: the
     * operator who forgot `--reconcile-existing` would get a start that captured
     * HEAD while believing it had captured their base -- the exact false
     * structural field this whole mechanism exists to prevent, produced by the
     * mechanism itself. Honouring `--base` without the reconcile flag would be
     * almost as bad, because then the deliberate operation is one forgettable
     * word away from the routine one.
     *
     * Keyed on PRESENCE, not on value: a bare `--base` is exactly the case where
     * the operator most believes they passed one.
     */
    if (!reconcile) {
      for (const [flag, arg] of [
        ["--base", baseFlag],
        ["--implementation-agent", implementerFlag],
        ["--reason", reasonFlag],
      ]) {
        if (arg.present)
          throw new Error(
            `${flag} is only meaningful with ${RECONCILE_FLAG}. An ordinary start records the commit it ` +
              "actually starts from; if this implementation predates the claim, say so explicitly",
          );
      }
    }
    // Present but empty, WITH the reconcile flag. Same reasoning from the other
    // side: the operator asked for the deliberate operation and supplied nothing
    // for it to act on, and the refusals below key on the value.
    if (reconcile) {
      for (const [flag, arg] of [
        ["--base", baseFlag],
        ["--implementation-agent", implementerFlag],
        ["--reason", reasonFlag],
      ]) {
        // An empty STRING counts as empty too. `--implementation-agent ""` would
        // otherwise be dropped as falsy and silently replaced by the owner --
        // the same accepted-and-ignored shape, one argument over.
        if (arg.present && (arg.value === null || arg.value === ""))
          throw new Error(
            `${flag} was passed without a value. It is the substance of the operation, not a switch; a ` +
              "flag whose argument was lost to quoting or an empty variable must fail rather than be " +
              "silently treated as absent",
          );
      }
    }
    // And the reverse. "Reconcile" without a base would mean "capture HEAD, but
    // label it a reconciliation" -- the same lie with a misleading label on it.
    if (reconcile && !baseArg)
      throw new Error(
        `${RECONCILE_FLAG} requires --base <sha>: the whole operation is the assertion of a specific ` +
          "pre-implementation commit. Without one there is nothing to reconcile to",
      );
    if (reconcile && !reconcileReason)
      throw new Error(
        `${RECONCILE_FLAG} requires --reason "...": it must state how the base was determined, because ` +
          "no check here can prove which commits were this task's work. This is the reviewer's only account " +
          "of why this range and not another",
      );

    const task = requireTask(d.taskDoc, taskId);
    if (agentId && task.owner !== agentId)
      throw new Error(`${taskId} is owned by ${task.owner}, not ${agentId}`);
    // Without the agent id the line above checks nothing, so an unowned task
    // could be started and would become IN_PROGRESS with implementationAgent
    // undefined. Nothing downstream can recover from that: assertReviewAllowed
    // refuses the eventual review with "no recorded implementation agent" long
    // after the cause, and `gate` would have no owner to attribute to. Refuse
    // here, where the reason is still visible.
    if (!task.owner)
      throw new Error(
        `${taskId} has no owner; claim it through the control plane first`,
      );

    let reconciliation = null;
    if (reconcile) {
      /*
       * Reconciliation happens exactly once, at the moment a task is opened, and
       * the preconditions say so structurally rather than by convention.
       *
       * CLAIMED is required explicitly, and is STRICTER than transition() alone
       * would be: policies allow REVIEW -> IN_PROGRESS, so a plain `start` can
       * legitimately pull a task back out of review, and without this check the
       * reconcile path would inherit that route and let a base be asserted onto
       * a task whose reviewer is already looking at it.
       */
      if (task.status !== "CLAIMED")
        throw new Error(
          `${taskId} is ${task.status}; reconciliation records where an implementation round BEGAN, so it ` +
            "is only accepted on a CLAIMED task that has not been started yet",
        );
      /*
       * An existing base is a claim the control plane already published --
       * possibly to a reviewer. Overwriting it here would be the silent hand-edit
       * in command form. `release` (which also discards gate results) is the
       * supported way to abandon a round; the base deliberately survives it,
       * because the implementation it points at survives it too.
       */
      if (task.implementationBaseSha)
        throw new Error(
          `${taskId} already records implementationBaseSha ${task.implementationBaseSha.slice(0, 12)}; ` +
            "reconciliation establishes a base, it does not revise one",
        );
      // A review record means a round already completed against some range, and
      // expectedReviewBase() would use the reviewed commit rather than this base
      // anyway -- so the value would be written, believed, and never consulted.
      if (task.review || (task.reviewHistory ?? []).length)
        throw new Error(
          `${taskId} already carries a review record; the first review range is fixed by history at that ` +
            "point, and a reconciled base could no longer change what any reviewer sees",
        );
      // Only reachable through a hand-edited tasks.json (gate refuses CLAIMED,
      // release and unblock clear results), which is exactly why it is checked:
      // evidence predating the round it belongs to is the defect those two
      // commands were changed to close.
      if (Object.keys(task.gateResults ?? {}).length)
        throw new Error(
          `${taskId} is CLAIMED but already carries gate results (${Object.keys(task.gateResults).join(", ")}); ` +
            "evidence belongs to one implementation round, so this task's state is inconsistent. Release it first",
        );

      if (assertedImplementer) {
        const implementer = requireAgent(d, assertedImplementer);
        /*
         * Naming the reviewer as the implementer would make the task
         * unreviewable: assertReviewAllowed refuses a review whose reviewer is on
         * the implementation side. Failing here says so once, now, instead of at
         * approval time with the round already spent.
         *
         * Note what this argument is and is not. It is an ASSERTION, like
         * `gate --agent`; nothing in a local CLI authenticates it. It ADDS an
         * implementation-side identity and can never remove one, so it grants no
         * capability -- but that is now true because `assertReviewAllowed`
         * compares the reviewer against the SET {implementationAgent, owner},
         * and this comment used to claim it while the line it annotates
         * contradicted it. Setting implementationAgent to an asserted third party
         * used to displace the owner from the self-approval comparison, so on a
         * task with no designated reviewAgent an honest declaration was what
         * unlocked approving your own work -- while saying nothing left the
         * owner correctly blocked. That is an incentive pointing exactly the
         * wrong way, and it is closed at the comparison rather than here.
         */
        if (task.reviewAgent && implementer.id === task.reviewAgent)
          throw new Error(
            `--implementation-agent ${implementer.id} is ${taskId}'s designated reviewer; recording it as ` +
              "the implementer would make the task permanently unapprovable under the self-approval rule",
          );
      }

      reconciliation = assertReconcilableBase(task, baseArg);
    }

    task.implementationAgent = reconcile
      ? (assertedImplementer ?? task.owner)
      : (task.owner ?? task.implementationAgent);

    if (reconcile) {
      task.implementationBaseSha = baseArg;
      /*
       * The field now tells the truth about the RANGE. This records the truth
       * about its PROVENANCE, because a reviewer reading tasks.json or
       * `review-status` sees a base and cannot otherwise tell whether it was
       * captured or asserted -- and those two mean very different things about
       * how much to trust it. Absence means an ordinary start, so no existing
       * task changes shape.
       */
      const windowCommits = reconciliation.surfaceCommits;
      task.implementationBaseProvenance = {
        kind: PROVENANCE_KIND,
        baseSha: baseArg,
        reconciledAt: now(),
        reconciledBy: task.owner,
        implementationAgent: task.implementationAgent,
        headAtReconciliation: reconciliation.head,
        reviewSurface: reconciliation.surface,
        /*
         * The window, published rather than summarised, so the reviewer can ask
         * the one question no check here can answer: is there an EARLIER commit
         * that also belongs to this implementation?
         *
         * Both endpoints are always named exactly, and the truncated list is
         * kept from the OLDEST end. It used to be `slice(0, 20)` -- the twenty
         * NEWEST -- which dropped precisely the end the reviewer is sent to
         * interrogate, and did so silently, so a truncated window read as a
         * complete one that simply ended where it ended.
         */
        surfaceCommitCount: windowCommits.length,
        oldestSurfaceCommit: windowCommits[windowCommits.length - 1] ?? null,
        newestSurfaceCommit: windowCommits[0] ?? null,
        surfaceCommits: windowCommits.slice(-SURFACE_COMMIT_PUBLISH_LIMIT),
        surfaceCommitsTruncated:
          windowCommits.length > SURFACE_COMMIT_PUBLISH_LIMIT,
        changedFileCount: reconciliation.changedFiles.length,
        /*
         * The base commit's OWN touches under the reviewed surface. Published as
         * EVIDENCE for the reviewer's judgement, never as a verdict: a refusal
         * built on exactly this list was removed because its remedy ("name an
         * earlier commit") widened the base away from the truth the field is
         * supposed to hold. See `assertReconcilableBase` for the full account.
         *
         * Named for what it reports, not for what it might imply. It says which
         * files this commit changed -- not "overlap", not "suspicious", not
         * "inside the implementation" -- because a reader who sees a non-empty
         * list here is being handed a question to ask the implementer, not an
         * answer the control plane has already reached.
         */
        baseCommitSurfaceTouchCount: reconciliation.baseTouches.length,
        baseCommitSurfaceTouches: reconciliation.baseTouches.slice(
          0,
          BASE_TOUCH_PUBLISH_LIMIT,
        ),
        baseCommitSurfaceTouchesTruncated:
          reconciliation.baseTouches.length > BASE_TOUCH_PUBLISH_LIMIT,
        reason: reconcileReason,
      };
    } else if (!task.implementationBaseSha) {
      // Capture the commit implementation started from, so the FIRST review has a
      // real lower bound instead of guessing at the parent commit. Never
      // overwritten within an implementation round: a task returned to
      // IN_PROGRESS by changes_requested keeps its original base, and re-reviews
      // use the previously reviewed commit anyway.
      const startedFrom = currentCommitSha();
      if (startedFrom) task.implementationBaseSha = startedFrom;
    }

    transition(task, "IN_PROGRESS", d.policies);
    syncAll(d, false);
    /*
     * AFTER the task state is durably persisted, never before.
     *
     * The discipline `recordReview` states and `approve` follows: events.jsonl
     * must never assert something task state does not show. Emitting first meant
     * a failure in `syncAll` -- a full disk, a locked file, a crash between the
     * two -- left the audit trail claiming a reconciliation the task never
     * received, and the natural response (run it again) then appended a SECOND
     * one. These events carry no deterministic id, so nothing would have
     * deduplicated them, and `validate` now corroborates provenance records
     * against exactly this log.
     *
     * A DIFFERENT event type, not a flag on the same one. Anything scanning
     * events.jsonl for `task.started` -- a human reading the trail included --
     * must not be able to read a reconciliation as an ordinary start by
     * overlooking one field. Exactly one record is written either way, so the
     * trail still has one opening event per round.
     */
    if (reconcile) {
      event("task.started_reconciled", {
        taskId,
        agentId: task.owner,
        implementationAgent: task.implementationAgent,
        implementationBaseSha: task.implementationBaseSha,
        headAtReconciliation: reconciliation.head,
        surfaceCommitCount: reconciliation.surfaceCommits.length,
        oldestSurfaceCommit: task.implementationBaseProvenance.oldestSurfaceCommit,
        newestSurfaceCommit: task.implementationBaseProvenance.newestSurfaceCommit,
        surfaceCommitsTruncated:
          task.implementationBaseProvenance.surfaceCommitsTruncated,
        changedFileCount: reconciliation.changedFiles.length,
        // Carried into the audit trail as well as onto the task, because the two
        // are read by different people at different times and a reviewer working
        // from events.jsonl alone should not have to open tasks.json to see the
        // evidence the record is asking them to weigh.
        baseCommitSurfaceTouchCount:
          task.implementationBaseProvenance.baseCommitSurfaceTouchCount,
        baseCommitSurfaceTouches:
          task.implementationBaseProvenance.baseCommitSurfaceTouches,
        baseCommitSurfaceTouchesTruncated:
          task.implementationBaseProvenance.baseCommitSurfaceTouchesTruncated,
        reason: reconcileReason,
        // "committed", not "pushed": the checks behind this record read the local
        // worktree and the local commit graph only. An audit note claiming the
        // commits reached a remote would be asserting something nothing verified.
        note:
          "reconciliation of a pre-existing implementation already in committed Git history; the base " +
          "predates this claim and was NOT captured at start. This is not a new implementation start. " +
          "Verified against local committed history only -- no remote was consulted. baseCommitSurfaceTouches is " +
          "reported evidence, not a verdict: whether an earlier commit also belongs to this implementation " +
          "is a question for the reviewer, because git does not attribute commits to tasks.",
      });
    } else {
      event("task.started", {
        taskId,
        agentId: task.owner,
        implementationBaseSha: task.implementationBaseSha ?? null
      });
    }
    if (reconcile) {
      /*
       * The evidence is printed at the moment the operator can still act on it,
       * phrased as a report. It is deliberately NOT phrased as a warning: the
       * operator may well know that this commit is the correct base and that its
       * touches are another lane's, and a tool that editorialises here is one
       * step from the refusal that was removed.
       */
      const touches = reconciliation.baseTouches;
      const shown = touches.slice(0, 5).join(", ");
      const evidence =
        `  the base commit itself changed ${touches.length} file(s) under ${reconciliation.surface}` +
        (touches.length
          ? `: ${shown}${touches.length > 5 ? ", ..." : ""}\n` +
            "    (reported evidence, not a verdict -- git cannot say which commits were this task's work;\n" +
            "     confirm with the implementer that no earlier commit belongs to this implementation)"
          : "");
      console.log(
        `${taskId} started as a RECONCILED pre-existing implementation.\n` +
          `  base ${baseArg.slice(0, 12)} (asserted, not captured) .. HEAD ${reconciliation.head.slice(0, 12)}\n` +
          `  ${reconciliation.surfaceCommits.length} commit(s) touch ${reconciliation.surface}; ` +
          `${reconciliation.changedFiles.length} file(s) differ\n` +
          `${evidence}\n` +
          `  implementation agent: ${task.implementationAgent}\n` +
          `  reason: ${reconcileReason}`,
      );
    } else {
      console.log(
        `${taskId} started${task.implementationBaseSha ? ` from ${task.implementationBaseSha.slice(0, 12)}` : ""}` +
          `${task.implementationBaseProvenance ? " (inherited reconciled base)" : ""}.`,
      );
    }
  } else if (command === "review") {
    const [taskId, agentId] = args;
    const task = requireTask(d.taskDoc, taskId);
    // Same optional assertion as `start` and `release`. Submitting somebody
    // else's in-flight work for review is not a harmless nudge: it freezes the
    // implementation at whatever state it happens to be in and puts the reviewer
    // in front of a diff its author never offered.
    if (agentId && task.owner !== agentId)
      throw new Error(`${taskId} is owned by ${task.owner}, not ${agentId}`);
    transition(task, "REVIEW", d.policies);
    event("task.review_requested", {
      taskId,
      owner: task.owner,
      reviewAgent: task.reviewAgent,
    });
    syncAll(d, false);
    console.log(`${taskId} moved to REVIEW for ${task.reviewAgent}.`);
  } else if (command === "approve" || command === "request-changes") {
    // `--sha` states the commit the reviewer actually looked at. Without it the
    // record binds to whatever HEAD happens to be, which is wrong whenever the
    // review was performed out-of-band -- for example an external reviewer whose
    // connector cannot write back to the repository.
    const reviewedSha = flagValue(args, "--sha");
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--sha") {
        i++;
        continue;
      }
      positional.push(args[i]);
    }
    const [taskId, reviewerId, ...noteParts] = positional;
    if (!taskId || !reviewerId)
      throw new Error(
        `Usage: ${command} <taskId> <reviewerAgent> [--sha <sha>] <evidence>`,
      );
    const task = requireTask(d.taskDoc, taskId);
    const reviewer = requireAgent(d, reviewerId);
    if (task.status !== "REVIEW")
      throw new Error(
        `${taskId} is ${task.status}; move it to REVIEW before recording a review`,
      );

    if (reviewedSha) {
      if (!/^[0-9a-f]{40}$/.test(reviewedSha)) {
        throw new Error("--sha must be a full 40-character hex sha");
      }
      // Exactly the enforcement the bus applies: ancestor of HEAD, no drift in
      // the task's allowedPaths since, and a clean implementation tree.
      assertCommitBinding(
        { id: `${command}:${taskId}`, commitSha: reviewedSha },
        task,
      );
    }

    const outcome = command === "approve" ? "APPROVED" : "CHANGES_REQUESTED";
    const record = recordReview(
      task,
      reviewer,
      outcome,
      noteParts.join(" "),
      reviewedSha ?? null,
    );
    if (outcome === "CHANGES_REQUESTED")
      transition(task, "IN_PROGRESS", d.policies);
    syncAll(d, false);
    // Audit event only after the transition is durably persisted.
    const payload = reviewEventPayload(task, record);
    event(payload.type, payload.details);
    console.log(
      `${taskId} review recorded: ${outcome} by ${reviewer.id} (${reviewer.provider}) against ${record.reviewedTreeHash.slice(0, 12)}.`,
    );
    if (outcome === "CHANGES_REQUESTED")
      console.log(`${taskId} returned to IN_PROGRESS.`);
  } else if (command === "review-status") {
    const [taskId] = args;
    const task = requireTask(d.taskDoc, taskId);
    const problems = reviewProblems(task, d.policies);
    console.log(
      JSON.stringify(
        {
          taskId: task.id,
          status: task.status,
          reviewRequired: reviewRequired(task, d.policies),
          requiredReviewer: task.reviewAgent ?? null,
          implementationAgent: task.implementationAgent ?? task.owner ?? null,
          // The first review's lower bound, and how it was obtained. A reviewer
          // handed a range starting before the task was claimed would otherwise
          // have to guess whether that is a defect or a declared reconciliation;
          // absent provenance means the base was captured by an ordinary start.
          //
          // The provenance record is emitted WHOLE rather than summarised, so
          // every published field reaches the reviewer -- including
          // `baseCommitSurfaceTouches`, the files the base commit itself changed
          // under the reviewed surface. That one is reported evidence, not a
          // control-plane finding: nothing here can prove which commits were this
          // task's work, so the reviewer weighs it.
          implementationBaseSha: task.implementationBaseSha ?? null,
          implementationBaseProvenance: task.implementationBaseProvenance ?? null,
          review: task.review ?? null,
          // Printed next to the hash on purpose: the hash is the answer, and
          // this is the question it answered.
          allowedPaths: task.allowedPaths ?? [],
          reviewDependencies: task.reviewDependencies ?? [],
          currentTreeHash: implementationFingerprint(task).treeHash,
          gatesPassed: allGatesPassed(task),
          blockingProblems: problems,
        },
        null,
        2,
      ),
    );
  } else if (command === "gate") {
    /*
     * `--agent` is an ASSERTION, not authentication.
     *
     * Nothing in this process can prove who is calling it, so a mandatory agent
     * id would buy no check that the ownership rule below does not already make
     * -- while breaking every existing caller: CLAUDE.md documents the
     * four-positional form, and the two unattended recorders
     * (scripts/cloud/run-gates.mjs and scripts/cloud/advance-completable.mjs)
     * are jobs with no agent identity of their own. So it mirrors `start`'s
     * optional agent id instead: state who you believe you are and be refused
     * loudly if the control plane disagrees, rather than writing evidence under
     * somebody else's name.
     */
    const actingAgent = flagValue(args, "--agent");
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--agent") {
        i++;
        continue;
      }
      positional.push(args[i]);
    }
    const [taskId, gate, status, ...noteParts] = positional;
    if (!taskId || !gate || !status)
      throw new Error(
        "Usage: gate <taskId> <gate> <pass|fail> [--agent <agentId>] <evidence>",
      );
    const task = requireTask(d.taskDoc, taskId);
    // Already enforced before this change, and kept: a gate name outside the
    // task's own qualityGates is evidence about a contract nobody asked for.
    if (!(task.qualityGates ?? []).includes(gate))
      throw new Error(`${gate} is not required by ${taskId}`);
    if (!d.gateDoc.gates[gate]) throw new Error(`Unknown gate ${gate}`);
    if (!["pass", "fail"].includes(status))
      throw new Error("Gate status must be pass or fail");
    const evidence = noteParts.join(" ");
    if (!evidence)
      throw new Error(
        "Gate evidence is required; it must identify the command, review, benchmark, or test performed",
      );

    /*
     * A gate result is evidence ABOUT WORK BEING PERFORMED against this task, so
     * it may only be recorded while the control plane says work is legitimately
     * happening against it, and only under the owner the control plane granted.
     *
     * The defect this closes: round 25 recorded four passing gates on PL-0103
     * while it sat at READY with owner null. The claim had been refused (wrong
     * lane) and the REVIEW transition had been refused -- yet all four gate
     * writes succeeded, because this command checked argument shape and nothing
     * else. Every other lifecycle command enforced ownership and the status
     * machine; the one piece of state CLAUDE.md calls load-bearing completion
     * evidence was the only one anybody could write unattributed, into any
     * status, including BACKLOG and BLOCKED.
     *
     * PERMITTED, and why:
     *   IN_PROGRESS  work is executing. The normal case, and the one the
     *                round-25-style batch (claim, start, then gates) uses.
     *   REVIEW       not a concession -- a requirement. A reviewer legitimately
     *                re-runs checks, and the deterministic completion path in
     *                scripts/cloud/advance-completable.mjs records EVERY gate
     *                for an APPROVED task that is still in REVIEW. Refusing
     *                REVIEW would break completion outright, not merely
     *                inconvenience a reviewer.
     *
     * REFUSED, each considered rather than assumed:
     *   CLAIMED      reserved, not started. `dispatch --apply` claims a whole
     *                wave at once, so allowing it would let one command
     *                accumulate gate passes for tasks nobody ever opened -- the
     *                same unattributed evidence in a different costume. `start`
     *                is one command away and captures implementationBaseSha,
     *                which is what later binds the work to a range at all.
     *   BLOCKED      the control plane has said this cannot proceed. Worse,
     *                `unblock` returns the task to an unowned queue, so evidence
     *                recorded here would outlive the round that produced it and
     *                be inherited by the next claimant.
     *   READY        no owner exists. This is the reported defect itself.
     *   BACKLOG      dependencies are not even met; nothing can have been run.
     *   DONE         gate results ARE the completion evidence. Editing them
     *                afterwards would let a recorded `fail` be papered over with
     *                no transition anywhere in the audit trail.
     *   CANCELED     there is no work to evidence.
     */
    const GATE_RECORDABLE_STATUSES = ["IN_PROGRESS", "REVIEW"];
    if (!GATE_RECORDABLE_STATUSES.includes(task.status)) {
      throw new Error(
        `${taskId} is ${task.status}; a gate result may only be recorded while a task is ` +
          `${GATE_RECORDABLE_STATUSES.join(" or ")}. Claim and start it through the control plane first.`,
      );
    }
    // Reachable only through a hand-edited tasks.json, which is exactly why it
    // is checked: an ownerless active task would record evidence attributable to
    // nobody, which is the state this whole rule exists to make unrepresentable.
    if (!task.owner) {
      throw new Error(
        `${taskId} is ${task.status} but has no owner, so a gate result could not be attributed to anyone; ` +
          "claim it through the control plane first",
      );
    }
    if (actingAgent) {
      requireAgent(d, actingAgent);
      /*
       * In REVIEW the designated reviewer may name itself: re-running the suite
       * is part of reviewing. During IN_PROGRESS it may not. A reviewer
       * recording gates on somebody else's in-flight work is not review, it is
       * undeclared co-implementation, and it would later read as ordinary owner
       * evidence that assertReviewAllowed's self-approval check cannot see.
       */
      const permitted =
        task.status === "REVIEW"
          ? [task.owner, task.reviewAgent].filter(Boolean)
          : [task.owner];
      if (!permitted.includes(actingAgent))
        throw new Error(
          `${taskId} is ${task.status} and owned by ${task.owner}; ${actingAgent} may not record its gates ` +
            `(permitted: ${permitted.join(", ")})`,
        );
    }

    const recordedBy = actingAgent ?? task.owner;
    task.gateResults ??= {};
    task.gateResults[gate] = {
      status,
      at: now(),
      // WHO the control plane holds accountable -- not who typed the command.
      // The owner was established by `claim`, which checked lane capability,
      // capacity and path conflicts; a free-text argument proves none of that.
      by: recordedBy,
      // WHAT the result is about. Round 25's four passes were defensible as
      // commands that genuinely ran, and still worthless as evidence, because
      // nothing tied them to a tree. Recorded, and deliberately NOT yet enforced
      // at `done`: deciding when a gate goes stale is a separate policy question
      // (a docs-only commit should not invalidate a build gate), and inventing
      // an answer here would silently change what completion means.
      commitSha: currentCommitSha(),
      evidence,
    };
    event("task.gate", { taskId, gate, status, by: recordedBy, evidence });
    saveTasks(d.taskDoc);
    syncAll(d, false);
    console.log(`${taskId} gate ${gate}: ${status} (recorded by ${recordedBy}).`);
  } else if (command === "done") {
    const [taskId] = args;
    const task = requireTask(d.taskDoc, taskId);
    if (task.status !== "REVIEW")
      throw new Error(`${taskId} must be in REVIEW before DONE`);
    if (!depsDone(task, taskMap(d.taskDoc.tasks)))
      throw new Error(`${taskId} has incomplete dependencies`);
    if (!allGatesPassed(task)) {
      const missing = task.qualityGates.filter(
        (g) => task.gateResults?.[g]?.status !== "pass",
      );
      throw new Error(
        `${taskId} cannot complete; gates not passed: ${missing.join(", ")}`,
      );
    }
    const problems = reviewProblems(task, d.policies);
    if (problems.length) {
      throw new Error(
        `${taskId} cannot complete; independent review requirements unmet:\n  - ${problems.join("\n  - ")}`,
      );
    }
    transition(task, "DONE", d.policies);
    task.completedAt = now();
    event("task.done", {
      taskId,
      owner: task.owner,
      reviewerAgent: task.review?.reviewerAgent ?? null,
      reviewedCommitSha: task.review?.reviewedCommitSha ?? null,
    });
    task.owner = null;
    syncAll(d, false);
    console.log(`${taskId} DONE.`);
  } else if (command === "block") {
    const [taskId, ...reasonParts] = args;
    const reason = reasonParts.join(" ");
    if (!reason) throw new Error("Usage: block <taskId> <reason>");
    const task = requireTask(d.taskDoc, taskId);
    if (task.status !== "BLOCKED") transition(task, "BLOCKED", d.policies);
    task.blocker = reason;
    event("task.blocked", { taskId, reason });
    syncAll(d, false);
    console.log(`${taskId} BLOCKED: ${reason}`);
  } else if (command === "unblock") {
    const [taskId] = args;
    const task = requireTask(d.taskDoc, taskId);
    if (task.status !== "BLOCKED") throw new Error(`${taskId} is not BLOCKED`);
    task.owner = null;
    delete task.blocker;
    const dropped = dropGateResults(task);
    const next = depsDone(task, taskMap(d.taskDoc.tasks)) ? "READY" : "BACKLOG";
    transition(task, next, d.policies);
    event("task.unblocked", { taskId, status: next, clearedGates: dropped });
    syncAll(d, false);
    console.log(
      `${taskId} -> ${next}${dropped.length ? ` (cleared gate results: ${dropped.join(", ")})` : ""}.`,
    );
  } else if (command === "release") {
    const [taskId, agentId] = args;
    const task = requireTask(d.taskDoc, taskId);
    if (!["CLAIMED", "IN_PROGRESS"].includes(task.status))
      throw new Error(`${taskId} is not releasable from ${task.status}`);
    // Optional assertion, same shape as `start`. Releasing another agent's
    // active claim is how two lanes end up believing they own the same
    // allowedPaths: the scheduler's collision check only looks at ACTIVE tasks,
    // so a silently released task is immediately re-dispatchable underneath the
    // agent still writing to it.
    if (agentId && task.owner !== agentId)
      throw new Error(`${taskId} is owned by ${task.owner}, not ${agentId}`);
    transition(task, "READY", d.policies);
    const owner = task.owner;
    task.owner = null;
    const dropped = dropGateResults(task);
    event("task.released", { taskId, owner, clearedGates: dropped });
    syncAll(d, false);
    console.log(
      `${taskId} released${dropped.length ? ` (cleared gate results: ${dropped.join(", ")})` : ""}.`,
    );
  } else if (command === "handoff") {
    const from = flagValue(args, "--from");
    const to = flagValue(args, "--to");
    const type = flagValue(args, "--type");
    const summary = flagValue(args, "--summary");
    if (!from || !to || !type || !summary) {
      throw new Error(
        'Usage: handoff --from <agent> --to <agent> --type <type> --summary "..." [--task ID] [--sha SHA] [--evidence REF]...',
      );
    }
    if (!MESSAGE_TYPES.includes(type)) {
      throw new Error(
        `Unknown message type ${type}. Known types: ${MESSAGE_TYPES.join(", ")}`,
      );
    }
    const fromAgent = requireAgent(d, from);
    requireAgent(d, to);
    const taskId = flagValue(args, "--task");
    if (taskId) requireTask(d.taskDoc, taskId);

    // `--sha auto` resolves to HEAD so a review request can never quote a commit
    // the author retyped by hand.
    const shaArg = flagValue(args, "--sha");
    const commitSha = shaArg === "auto" ? currentCommitSha() : shaArg;
    if (shaArg === "auto" && !commitSha) {
      throw new Error(
        "--sha auto requested but the current commit could not be resolved",
      );
    }

    // `--base auto` resolves to the last commit this task was reviewed at, so a
    // re-review covers the whole corrective delta instead of only the newest
    // commit. Without it a reviewer re-reading `sha~1..sha` would miss earlier
    // fixes in the same round.
    const baseArg = flagValue(args, "--base");
    let baseSha = baseArg;
    if (baseArg === "auto") {
      if (!taskId) throw new Error("--base auto requires --task");
      const prior = requireTask(d.taskDoc, taskId);

      // RE-review: everything since the reviewer last looked.
      const lastReviewed = [...(prior.reviewHistory ?? [])]
        .reverse()
        .map((entry) => entry.reviewedCommitSha)
        .find((sha) => /^[0-9a-f]{40}$/.test(String(sha)) && sha !== commitSha);

      // FIRST review: everything since implementation began.
      baseSha = lastReviewed ?? prior.implementationBaseSha ?? null;

      if (!baseSha) {
        throw new Error(
          `--base auto could not resolve a review base for ${taskId}: no prior review and no implementationBaseSha. ` +
          "Start the task through the control plane so the base is captured, or pass --base <sha> explicitly. " +
          "There is deliberately no parent-commit fallback -- a reviewer must never be handed a narrower range than the work it is judging."
        );
      }
      // Naming the ORIGIN of the base, not just its value. A first review whose
      // range opens before the task was even claimed looks wrong to a reviewer
      // unless the message says why, and "why" is the difference between a base
      // captured at start and one asserted by reconciliation.
      const reconciled =
        !lastReviewed &&
        prior.implementationBaseProvenance?.kind ===
          "reconciled-existing-implementation";
      console.log(
        `Review base: ${baseSha.slice(0, 12)} (${
          lastReviewed
            ? "previous review"
            : reconciled
              ? "reconciled pre-existing implementation; base predates the claim"
              : "implementation start"
        })`,
      );
      /*
       * The evidence travels with the range, not just with the task file.
       *
       * A reviewer handed a reconciled range is being asked to judge one thing
       * the control plane cannot: whether an EARLIER commit also belongs to this
       * implementation. The most useful single fact for that judgement is what
       * the base commit itself changed under the reviewed surface -- so it is
       * stated here, where the range is announced, rather than left in a field
       * the reviewer would have to know to go and read. It is a report, not a
       * flag: a base that touches the surface is entirely normal when the
       * previous commit belonged to another lane.
       */
      if (reconciled) {
        const p = prior.implementationBaseProvenance;
        const touches = Array.isArray(p.baseCommitSurfaceTouches)
          ? p.baseCommitSurfaceTouches
          : null;
        const count = Number.isInteger(p.baseCommitSurfaceTouchCount)
          ? p.baseCommitSurfaceTouchCount
          : touches?.length;
        if (touches && count !== undefined) {
          console.log(
            `  the base commit itself changed ${count} file(s) under ${p.reviewSurface}` +
              (touches.length
                ? `: ${touches.slice(0, 5).join(", ")}` +
                  `${count > 5 ? ", ..." : ""}`
                : ""),
          );
          console.log(
            "  (evidence for your judgement, not a control-plane verdict: git does not attribute commits " +
              "to tasks, so whether an earlier commit belongs to this implementation is yours to settle)",
          );
        }
      }
    }
    if (baseSha && baseSha === commitSha) {
      throw new Error("--base equals --sha; an empty range reviews nothing");
    }

    const { message, file } = createMessage(root, {
      fromAgent: from,
      toAgent: to,
      type,
      taskId,
      commitSha,
      baseSha,
      summary,
      evidence: flagValues(args, "--evidence"),
      lane: laneFor(fromAgent.provider),
    });
    event("bus.message_published", {
      messageId: message.id,
      fromAgent: from,
      toAgent: to,
      type,
      taskId: taskId ?? null,
      commitSha: commitSha ?? null,
    });
    console.log(`Published ${message.id}`);
    console.log(path.relative(root, file).replace(/\\/g, "/"));
  } else if (command === "inbox") {
    const agentId = args.find((a) => !a.startsWith("--"));
    if (!agentId) throw new Error("Usage: inbox <agentId> [--all]");
    requireAgent(d, agentId);
    const all = args.includes("--all");
    const messages = listMessages(root, {
      toAgent: agentId,
      includeAcknowledged: all,
      includeRejected: all,
    });
    if (!messages.length) {
      console.log(`No unacknowledged messages for ${agentId}.`);
    } else {
      console.log(`${messages.length} message(s) for ${agentId}:\n`);
      for (const m of messages) {
        const rejection =
          m.status === "rejected" ? readRejection(root, m.id) : null;
        console.log(
          describeMessage(m) +
            (rejection ? `\n  rejected: ${rejection.reason}` : "") +
            "\n",
        );
      }
    }
  } else if (command === "ack") {
    const messageId = args.find((a) => !a.startsWith("--"));
    if (!messageId)
      throw new Error(
        'Usage: ack <messageId> [--agent <agentId>] [--note "..."]',
      );
    const found = findMessage(root, messageId);
    if (!found) throw new Error(`Unknown message ${messageId}`);
    const agentId = flagValue(args, "--agent", found.message.toAgent);
    requireAgent(d, agentId);
    if (found.message.toAgent !== agentId) {
      throw new Error(
        `${messageId} is addressed to ${found.message.toAgent}, not ${agentId}`,
      );
    }
    // A rejection and an acknowledgement are mutually exclusive verdicts.
    // Acking a quarantined message would make the audit trail report it as
    // successfully processed and hide the rejection reason.
    const quarantined = readRejection(root, messageId);
    if (quarantined) {
      throw new Error(
        `${messageId} was quarantined (${quarantined.reason}); a rejection is not an acknowledgement and must not be acked`,
      );
    }
    const record = acknowledge(root, messageId, {
      agent: agentId,
      outcome: "acknowledged",
      note: flagValue(args, "--note"),
    });
    event("bus.message_acknowledged", {
      messageId,
      acknowledgedBy: agentId,
      outcome: record.outcome,
    });
    console.log(`${messageId} acknowledged by ${agentId}.`);
  } else if (command === "process" || command === "recover") {
    const agentId = args.find((a) => !a.startsWith("--"));
    if (!agentId) throw new Error(`Usage: ${command} <agentId>`);
    requireAgent(d, agentId);

    /* ---------------------------------------------------------------------
     * Recovery pass.
     *
     * The journal records which side of the durable commit a crash happened on:
     *
     *   CLAIMED / APPLYING  task state was NOT saved -> release the claim so the
     *                       message is reprocessed cleanly from scratch
     *   APPLIED             task state WAS saved -> must not re-apply; finish the
     *                       transaction by writing the acknowledgement and event
     *   FAILED              retryable -> release the claim
     *
     * Recovery is agent-scoped. A run may touch an entry only when both the
     * journal claimant and the immutable message recipient match agentId.
     * Both branches are idempotent, so running recovery repeatedly is safe.
     * ------------------------------------------------------------------- */
    let recovered = 0;
    let recoverySkipped = 0;
    for (const entry of listJournal(root)) {
      // Terminal only once the audit records are also durable; otherwise a crash
      // between the acknowledgement and the event would lose them silently.
      if (entry.state === "ACKNOWLEDGED" && entry.eventsEmitted === true)
        continue;

      const found = findMessage(root, entry.messageId);
      const message = found?.message ?? null;
      const ownershipProblem =
        entry.claimedBy !== agentId
          ? `claimed by ${entry.claimedBy ?? "unknown"}`
          : !message
            ? "source message is missing or unreadable"
            : message.id !== entry.messageId
              ? `source message id is ${message.id ?? "missing"}`
              : validateMessage(message).length
                ? "source message is structurally invalid"
                : message.toAgent !== agentId
                  ? `addressed to ${message.toAgent}`
                  : null;

      if (ownershipProblem) {
        // Fail closed without releasing, acknowledging, advancing, or emitting
        // audit for a transaction owned by another agent (or with unverifiable
        // ownership). Its rightful recipient can recover it later.
        recoverySkipped++;
        console.log(
          `SKIP FOREIGN ${entry.messageId}: ${ownershipProblem}; ${agentId} cannot recover it`,
        );
        continue;
      }

      if (entry.state === "APPLIED" || entry.state === "ACKNOWLEDGED") {
        try {
          acknowledge(root, entry.messageId, {
            agent: agentId,
            outcome: "processed",
            applied: entry.applied,
            note: "finalized by crash recovery",
          });
        } catch (error) {
          if (!/already acknowledged/.test(error.message)) throw error;
        }
        // Replayed from the journal with the SAME deterministic ids, so any
        // record the interrupted run already wrote is skipped rather than
        // duplicated. This is what closes the "emitted, then crashed before the
        // journal was finalized" window.
        emitAudit(entry.messageId, entry.audit ?? []);
        emitProcessed(entry.messageId, {
          messageId: entry.messageId,
          agentId,
          applied: entry.applied,
          recovered: true,
        });
        advanceJournal(root, entry.messageId, "ACKNOWLEDGED", {
          recovered: true,
          eventsEmitted: true,
        });
        recovered++;
        console.log(
          `RECOVERED ${entry.messageId}: ${entry.applied} (task state was already persisted)`,
        );
      } else {
        // Nothing was durably applied, so discarding the claim cannot lose work.
        releaseJournal(root, entry.messageId);
        recovered++;
        console.log(
          `RELEASED  ${entry.messageId}: incomplete (${entry.state}); will be reprocessed`,
        );
      }
    }
    if (command === "recover") {
      console.log(
        `\nRecovered ${recovered} incomplete message(s)` +
          `${recoverySkipped ? `; skipped ${recoverySkipped} foreign transaction(s)` : ""}.`,
      );
      // Recovery only; do not start new work.
    } else {
      let applied = 0;
      let failed = 0;
      let quarantined = 0;

      /* ---------------------------------------------------------------------
       * Quarantine malformed inbound files FIRST.
       *
       * These can never be interpreted as messages, so they cannot be validated
       * or applied -- but they must not silently vanish either. Each becomes a
       * durable rejection record keyed by its message id where that is safe, or
       * by a deterministic hash of the filename where it is not, with the
       * original filename preserved as evidence.
       * ------------------------------------------------------------------- */
      for (const bad of listMalformed(root, { toAgent: agentId })) {
        if (readRejection(root, bad.key)) continue;
        const { created } = rejectMessage(root, bad.key, {
          agent: agentId,
          reason: bad.reason,
          message: bad.raw,
          originalFilename: bad.fileName,
        });
        if (created) {
          quarantined++;
          event("bus.message_rejected", {
            key: bad.key,
            agentId,
            reason: bad.reason,
            originalFilename: bad.fileName,
          });
          console.error(`REJECT ${bad.key} (${bad.fileName}): ${bad.reason}`);
        }
      }

      const pending = listMessages(root, { toAgent: agentId });
      if (!pending.length && !quarantined) {
        console.log(`No unacknowledged messages for ${agentId}.`);
      }

      for (const message of pending) {
        // 1. VALIDATE -- before any claim, so a rejected message costs nothing.
        try {
          validateBusMessage(d, message, agentId);
        } catch (error) {
          if (error.permanent) {
            // Quarantine: durable, shared, and NOT an acknowledgement. Only the
            // first run to discover it reports failure; later runs -- and other
            // checkouts -- skip it, so one bad file cannot wedge the queue.
            const { created } = rejectMessage(root, message.id, {
              agent: agentId,
              reason: error.message,
              message,
            });
            if (created) {
              quarantined++;
              event("bus.message_rejected", {
                messageId: message.id,
                agentId,
                reason: error.message,
              });
              console.error(`REJECT ${message.id}: ${error.message}`);
            } else {
              console.log(`SKIP   ${message.id}: previously rejected`);
            }
          } else {
            // Transient: repository state may change and make this valid later.
            failed++;
            console.error(`RETRY  ${message.id}: ${error.message}`);
          }
          continue;
        }

        // 2. CLAIM -- atomic (O_CREAT|O_EXCL). Only one run can ever hold it.
        try {
          claimJournal(root, message.id, agentId);
        } catch (error) {
          failed++;
          console.error(`SKIP ${message.id}: ${error.message}`);
          continue;
        }

        const rollback = JSON.stringify(d.taskDoc);
        let outcome;
        try {
          // 3. STAGE -- mutate in memory only.
          advanceJournal(root, message.id, "APPLYING");
          outcome = applyBusMessage(d, message, agentId);

          // 4. PERSIST TASK STATE -- the durable commit point. Nothing that can
          //    fail may run between this write and the APPLIED marker below, or a
          //    crash would look like "redo" when the state is already on disk.
          refreshReadiness(d.taskDoc.tasks);
          saveTasks(d.taskDoc);
          advanceJournal(root, message.id, "APPLIED", {
            applied: outcome.summary,
            audit: outcome.audit ?? [],
          });

          // Derived views are regenerated best-effort; they are reproducible from
          // tasks.json, so a failure here must not fail the transaction.
          try {
            syncAll(d, false);
          } catch (viewError) {
            console.error(
              `WARN ${message.id}: derived views not regenerated (${viewError.message}); run sync`,
            );
          }

          // 5. PERSIST ACKNOWLEDGEMENT.
          acknowledge(root, message.id, {
            agent: agentId,
            outcome: "processed",
            applied: outcome.summary,
          });
          advanceJournal(root, message.id, "ACKNOWLEDGED", {
            eventsEmitted: false,
          });

          // 6. AUDIT -- only now, once task state and acknowledgement are durable.
          //    Ids are deterministic, so a crash before the journal is finalized
          //    cannot cause a second physical copy on recovery.
          emitAudit(message.id, outcome.audit ?? []);
          emitProcessed(message.id, {
            messageId: message.id,
            agentId,
            applied: outcome.summary,
          });
          advanceJournal(root, message.id, "ACKNOWLEDGED", {
            eventsEmitted: true,
          });

          applied++;
          console.log(`OK   ${message.id}: ${outcome.summary}`);
        } catch (error) {
          // Nothing durable was written on this path unless we got past step 4;
          // if we did, the journal says APPLIED and recovery will finish it.
          const journal = readJournal(root, message.id);
          if (
            journal?.state === "APPLIED" ||
            journal?.state === "ACKNOWLEDGED"
          ) {
            console.error(
              `PARTIAL ${message.id}: task state persisted; run recover to finalize`,
            );
          } else {
            d.taskDoc = JSON.parse(rollback);
            advanceJournal(root, message.id, "FAILED", {
              error: error.message,
            });
            console.error(`SKIP ${message.id}: ${error.message}`);
          }
          failed++;
        }
      }
      console.log(
        `\nProcessed ${applied} message(s)` +
          `${failed ? `, ${failed} retryable` : ""}` +
          `${quarantined ? `, ${quarantined} newly rejected` : ""}` +
          `${recovered ? `, ${recovered} recovered` : ""}` +
          `${recoverySkipped ? `, ${recoverySkipped} foreign recovery skipped` : ""}.`,
      );
      // Non-zero for a NEW rejection or a retryable failure. A previously-recorded
      // rejection is not a failure of this run.
      if (failed || quarantined) process.exitCode = 1;
    }
  } else if (command === "event") {
    const [type, ...message] = args;
    if (!type) throw new Error("Usage: event <type> [message]");
    event(type, { message: message.join(" ") });
    console.log("Event recorded.");
  } else {
    console.log(`AI control plane commands:
  validate
  sync
  status
  ready
  dispatch [--apply]
  queue <agentId>
  claim <taskId> <agentId>
  start <taskId> [agentId]
  start <taskId> [agentId] --reconcile-existing --base <sha> --reason "..." [--implementation-agent <id>]
  review <taskId> [agentId]
  approve <taskId> <reviewerAgent> <evidence>
  request-changes <taskId> <reviewerAgent> <evidence>
  review-status <taskId>
  gate <taskId> <gate> <pass|fail> [--agent <agentId>] <evidence>
  done <taskId>
  block <taskId> <reason>
  unblock <taskId>              clears gate results; the task returns to a queue unowned
  release <taskId> [agentId]    clears gate results; the task returns to READY unowned
  event <type> [message]

A gate result may only be recorded while a task is IN_PROGRESS or REVIEW, and it
is attributed to the task's owner. The optional [agentId] / --agent arguments are
assertions, not authentication: they exist so a caller that is wrong about who
owns a task fails loudly instead of writing evidence under another agent's name.

start --reconcile-existing is for ONE case: an implementation that was written and
COMMITTED BEFORE the task was claimed. implementationBaseSha is the exact lower bound
of the first review range, so letting an ordinary start capture HEAD there would
make the machine-readable field false and hand the reviewer a range beginning after
the code. All three flags are required together, each is refused on an ordinary
start, the base is verified against real history, and the operation is audited as
task.started_reconciled -- never as task.started.

"Committed", not "pushed". Every check runs against the local worktree and the
local commit graph; no remote is contacted, so never-pushed commits pass. Remote
availability is a handoff/review concern -- the reviewer must be able to fetch the
sha a decision binds to -- not something reconciliation establishes.

The base is checked only against MECHANICAL facts (full sha, resolvable, ancestor
of HEAD, not HEAD, a non-empty reviewed surface with something changed in
base..HEAD, and a clean tree under allowedPaths). Whether it is really the commit
immediately before this task's work is not decidable from git, which does not
attribute commits to tasks, so it is PUBLISHED for a reviewer instead of guessed
at: the window, its endpoints, the files the base commit itself changed under the
reviewed surface, and your --reason. Name the true base; nothing here will ask you
to widen it.

Handoff bus (GitHub is the transport; no human relay):
  handoff --from <agent> --to <agent> --type <type> --summary "..." [--task ID] [--sha SHA|auto] [--evidence REF]...
  inbox <agentId> [--all]     --all also shows acknowledged and quarantined messages
  ack <messageId> [--agent <agentId>] [--note "..."]   refused for quarantined messages
  process <agentId>          recover, then apply pending messages
  recover <agentId>           recovery pass only

Also runnable directly as: node scripts/agent-bus.mjs <inbox|process|handoff|ack|recover> ...

Message types:
  ${MESSAGE_TYPES.join(", ")}

The bus transports decisions; it never bypasses designated reviewer, independent
review, self-approval rules, fingerprint binding, commit binding, or gates.

A message that is defective in itself (malformed, wrong recipient, wrong
reviewer) is quarantined to coordination/agent-bus/rejections/ -- durable and
shared, so no other checkout re-discovers it. A message that is merely early
(task not yet in REVIEW, stale sha, dirty tree) is retried, not quarantined.

Dispatch classes:
  READY_AND_EXECUTABLE  dependency-clear and a locally executable agent can take it now
  READY_BUT_EXTERNAL    reserved for an external agent lane; never reduces the local wave
  BLOCKED               explicitly blocked with a recorded reason
  BACKLOG               dependency-gated`);
  }
} catch (error) {
  console.error(`AI control plane error: ${error.message}`);
  process.exit(1);
}
