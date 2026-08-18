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
function normalizePrefix(pattern) {
  return pattern
    .replace(/\\/g, "/")
    .replace(/\*\*.*$/, "")
    .replace(/\*.*$/, "")
    .replace(/\/$/, "");
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
 */
function taskPathspecs(task) {
  return [
    ...new Set((task.allowedPaths ?? []).map(normalizePrefix).filter(Boolean)),
  ];
}

/**
 * The REVIEWED surface: everything an approval binds to.
 *
 * allowedPaths is in the union by construction rather than by convention. If a
 * task could write a file that its own fingerprint did not cover, it could
 * change its approved content without invalidating the approval -- which is the
 * exact failure the fingerprint exists to prevent.
 *
 * Absent or empty reviewDependencies therefore reduces to allowedPaths, so the
 * tasks that predate this field fingerprint precisely what they always did.
 */
function reviewSurfacePatterns(task) {
  const declared = task.reviewDependencies ?? [];
  if (
    !Array.isArray(declared) ||
    declared.some((p) => typeof p !== "string" || !p.trim())
  ) {
    // Fail closed rather than skipping the unusable entries. `validate` reports
    // this properly, so anything reaching here bypassed it -- and silently
    // fingerprinting a NARROWER surface than the task declares would record an
    // approval that claims to cover a shared vocabulary it never hashed, which
    // is the precise failure this field exists to prevent.
    throw new Error(
      `${task.id}: reviewDependencies must be an array of non-empty path globs; ` +
        "refusing to fingerprint a review surface that cannot be determined",
    );
  }
  return [...(task.allowedPaths ?? []), ...declared];
}
function reviewPathspecs(task) {
  return [
    ...new Set(reviewSurfacePatterns(task).map(normalizePrefix).filter(Boolean)),
  ];
}

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
function taskWorktreeIsDirty(task) {
  if (process.env.LIBERTY_COMMIT_SHA) return false; // test harness has no git
  const pathspecs = taskPathspecs(task);
  if (!pathspecs.length) return false;
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
    return (
      status
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^\S+\s+/, ""))
        .filter((rel) => !excludedFromFingerprint(rel) && !rel.endsWith(".tmp"))
        .length > 0
    );
  } catch {
    return false;
  }
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
    const surface = (task.reviewDependencies ?? []).length
      ? "allowedPaths + reviewDependencies"
      : "allowedPaths";
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
  if (reviewer.id === implementationAgent)
    throw new Error(
      `self-approval is prohibited: ${reviewer.id} implemented ${task.id}`,
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
    for (const p of task.allowedPaths ?? []) {
      if (!normalizePrefix(p))
        warnings.push(
          `${task.id}: allowedPath "${p}" normalizes to the repository root and will conflict with every other task`,
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
      } else {
        const writable = taskPathspecs(task);
        for (const p of task.reviewDependencies) {
          if (typeof p !== "string" || !p.trim()) {
            errors.push(
              `${task.id}: reviewDependencies entries must be non-empty strings, got ${JSON.stringify(p)}`,
            );
            continue;
          }
          const dep = normalizePrefix(p);
          if (!dep) {
            warnings.push(
              `${task.id}: reviewDependency "${p}" normalizes to the repository root, which would put the entire repository in the reviewed surface; it is dropped instead, so it protects nothing`,
            );
            continue;
          }
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

    if (task.review) {
      if (!amap.has(task.review.reviewerAgent))
        errors.push(
          `${task.id}: review record names unknown reviewer ${task.review.reviewerAgent}`,
        );
      if (task.review.reviewerAgent === task.review.implementationAgent)
        errors.push(
          `${task.id}: review record is a self-approval by ${task.review.reviewerAgent}`,
        );
      if (!REVIEW_OUTCOMES.includes(task.review.outcome))
        errors.push(
          `${task.id}: invalid review outcome ${task.review.outcome}`,
        );
      if (task.status !== "DONE" && task.review.outcome === "APPROVED") {
        const current = implementationFingerprint(task);
        if (current.treeHash !== task.review.reviewedTreeHash)
          warnings.push(
            `${task.id}: approval is stale; implementation changed since review`,
          );
      }
    }
    if (task.status === "DONE") {
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
    const [taskId, agentId] = args;
    const task = requireTask(d.taskDoc, taskId);
    if (agentId && task.owner !== agentId)
      throw new Error(`${taskId} is owned by ${task.owner}, not ${agentId}`);
    task.implementationAgent = task.owner ?? task.implementationAgent;
    // Capture the commit implementation started from, so the FIRST review has a
    // real lower bound instead of guessing at the parent commit. Never
    // overwritten within an implementation round: a task returned to
    // IN_PROGRESS by changes_requested keeps its original base, and re-reviews
    // use the previously reviewed commit anyway.
    if (!task.implementationBaseSha) {
      const startedFrom = currentCommitSha();
      if (startedFrom) task.implementationBaseSha = startedFrom;
    }
    transition(task, "IN_PROGRESS", d.policies);
    event("task.started", {
      taskId,
      agentId: task.owner,
      implementationBaseSha: task.implementationBaseSha ?? null
    });
    syncAll(d, false);
    console.log(
      `${taskId} started${task.implementationBaseSha ? ` from ${task.implementationBaseSha.slice(0, 12)}` : ""}.`,
    );
  } else if (command === "review") {
    const [taskId] = args;
    const task = requireTask(d.taskDoc, taskId);
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
    const [taskId, gate, status, ...noteParts] = args;
    const task = requireTask(d.taskDoc, taskId);
    if (!task.qualityGates.includes(gate))
      throw new Error(`${gate} is not required by ${taskId}`);
    if (!d.gateDoc.gates[gate]) throw new Error(`Unknown gate ${gate}`);
    if (!["pass", "fail"].includes(status))
      throw new Error("Gate status must be pass or fail");
    const evidence = noteParts.join(" ");
    if (!evidence)
      throw new Error(
        "Gate evidence is required; it must identify the command, review, benchmark, or test performed",
      );
    task.gateResults ??= {};
    task.gateResults[gate] = { status, at: now(), evidence };
    event("task.gate", { taskId, gate, status, evidence });
    saveTasks(d.taskDoc);
    syncAll(d, false);
    console.log(`${taskId} gate ${gate}: ${status}.`);
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
    const next = depsDone(task, taskMap(d.taskDoc.tasks)) ? "READY" : "BACKLOG";
    transition(task, next, d.policies);
    event("task.unblocked", { taskId, status: next });
    syncAll(d, false);
    console.log(`${taskId} -> ${next}.`);
  } else if (command === "release") {
    const [taskId] = args;
    const task = requireTask(d.taskDoc, taskId);
    if (!["CLAIMED", "IN_PROGRESS"].includes(task.status))
      throw new Error(`${taskId} is not releasable from ${task.status}`);
    transition(task, "READY", d.policies);
    const owner = task.owner;
    task.owner = null;
    event("task.released", { taskId, owner });
    syncAll(d, false);
    console.log(`${taskId} released.`);
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
      console.log(
        `Review base: ${baseSha.slice(0, 12)} (${lastReviewed ? "previous review" : "implementation start"})`,
      );
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
  review <taskId>
  approve <taskId> <reviewerAgent> <evidence>
  request-changes <taskId> <reviewerAgent> <evidence>
  review-status <taskId>
  gate <taskId> <gate> <pass|fail> <evidence>
  done <taskId>
  block <taskId> <reason>
  unblock <taskId>
  release <taskId>
  event <type> [message]

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
