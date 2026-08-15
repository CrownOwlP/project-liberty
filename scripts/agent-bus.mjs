import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Repo-native GPT <-> Claude handoff bus.
 *
 * Design constraints:
 *
 * 1. GitHub is the transport. Every message is a file, so `git push` / `git pull`
 *    is the delivery mechanism and no human has to relay anything.
 * 2. Messages are IMMUTABLE. A message file is written once and never edited.
 *    Acknowledgements live in a separate directory keyed by message id, so two
 *    agents working concurrently never touch the same file and merges stay clean.
 * 3. The bus TRANSPORTS decisions. It does not enforce them. Every review that
 *    arrives over the bus is applied through the same control-plane path as a
 *    manual review, so reviewer identity, self-approval, fingerprint binding,
 *    commit binding, gates and stale detection all still apply.
 */

export const MESSAGE_TYPES = [
  "task_instruction",
  "implementation_ready",
  "review_request",
  "review_approved",
  "changes_requested",
  "blocker",
  "architecture_decision"
];

/** Types that assert something about a specific commit and cannot omit it. */
export const SHA_REQUIRED_TYPES = [
  "implementation_ready",
  "review_request",
  "review_approved",
  "changes_requested"
];

/**
 * Types that must state the LOWER BOUND of the range they refer to.
 *
 * Enforced at publish time. There is deliberately no implicit parent-commit
 * fallback anywhere: a reviewer that silently narrows its own range when the
 * base is unknown ends up approving code it never read.
 */
export const BASE_REQUIRED_TYPES = [
  "implementation_ready",
  "review_request",
  "review_approved",
  "changes_requested"
];

/** Types that name a specific task and cannot omit it. */
export const TASK_REQUIRED_TYPES = [
  "implementation_ready",
  "review_request",
  "review_approved",
  "changes_requested"
];

export const BUS_ROOT = path.join("coordination", "agent-bus");
const LANES = {
  "gpt-to-claude": path.join(BUS_ROOT, "gpt-to-claude"),
  "claude-to-gpt": path.join(BUS_ROOT, "claude-to-gpt")
};
const ACK_DIR = path.join(BUS_ROOT, "acknowledgements");
const REJECTION_DIR = path.join(BUS_ROOT, "rejections");
/**
 * Journal location.
 *
 * Local default is gitignored: a crash is a property of one persistent machine.
 * An EPHEMERAL runner has no persistent disk, so a cloud worker sets
 * LIBERTY_JOURNAL_DIR to a committed path and pushes the journal as part of the
 * transaction. Recovery then works across runs because the state travelled with
 * the repository rather than dying with the container.
 */
const JOURNAL_DIR = process.env.LIBERTY_JOURNAL_DIR
  ? process.env.LIBERTY_JOURNAL_DIR.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  : path.join(BUS_ROOT, "journal");

/** True when the journal is committed rather than local-only. */
export const journalIsDurable = Boolean(process.env.LIBERTY_JOURNAL_DIR);

/**
 * Durable processing journal.
 *
 * The acknowledgement file alone cannot distinguish "crashed before the task
 * transition was saved" from "crashed after". The journal records which side of
 * the durable commit a crash happened on, so recovery can redo the first case
 * and finish (rather than repeat) the second.
 *
 *   RECEIVED     seen and structurally valid
 *   CLAIMED      exclusive claim taken; nothing applied yet
 *   APPLYING     transition staged in memory, about to persist task state
 *   APPLIED      task state is DURABLY PERSISTED -- must never be re-applied
 *   ACKNOWLEDGED acknowledgement written and audit event emitted (terminal)
 *   FAILED       could not be applied; retryable, message stays in the inbox
 */
export const JOURNAL_STATES = [
  "RECEIVED", "CLAIMED", "APPLYING", "APPLIED", "ACKNOWLEDGED", "FAILED"
];

export function busPaths(root) {
  return {
    root: path.join(root, BUS_ROOT),
    gptToClaude: path.join(root, LANES["gpt-to-claude"]),
    claudeToGpt: path.join(root, LANES["claude-to-gpt"]),
    acknowledgements: path.join(root, ACK_DIR),
    rejections: path.join(root, REJECTION_DIR),
    journal: path.join(root, JOURNAL_DIR)
  };
}

export function ensureBus(root) {
  const paths = busPaths(root);
  for (const dir of [paths.gptToClaude, paths.claudeToGpt, paths.acknowledgements, paths.rejections]) {
    fs.mkdirSync(dir, { recursive: true });
    const keep = path.join(dir, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
  }
  fs.mkdirSync(paths.journal, { recursive: true });
  if (!journalIsDurable) {
    // Local mode: crash-recovery state belongs to one machine. Committing it
    // would create conflicts between clones and let one machine's partial
    // processing look authoritative to another, so it is ignored in place.
    const ignore = path.join(paths.journal, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n!.gitignore\n");
  } else {
    // Durable mode: the journal is committed so an ephemeral runner's
    // in-flight transaction can be recovered by a later, different runner.
    const keep = path.join(paths.journal, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
  }
  return paths;
}

function journalFile(root, messageId) {
  return path.join(busPaths(root).journal, `${assertSafeMessageId(messageId)}.json`);
}

export function readJournal(root, messageId) {
  return readJsonIfPresent(journalFile(root, messageId));
}

/**
 * Atomic exclusive claim. `wx` means only one process can ever take it, which is
 * what makes re-running `process` unable to apply the same transition twice.
 */
export function claimJournal(root, messageId, agent) {
  ensureBus(root);
  const record = {
    messageId,
    state: "CLAIMED",
    claimedBy: agent,
    claimedAt: new Date().toISOString(),
    applied: null,
    error: null
  };
  try {
    fs.writeFileSync(journalFile(root, messageId), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`${messageId} is already claimed by an in-flight or crashed run`);
    }
    throw error;
  }
  return record;
}

/** Journal entries are mutable state; messages and acknowledgements are not. */
export function advanceJournal(root, messageId, state, extra = {}) {
  if (!JOURNAL_STATES.includes(state)) throw new Error(`unknown journal state: ${state}`);
  const current = readJournal(root, messageId) ?? { messageId };
  const next = { ...current, ...extra, state, updatedAt: new Date().toISOString() };
  // Write-then-rename: a torn journal file would make a durably-applied message
  // look un-applied, and re-applying it is exactly what the journal exists to
  // prevent.
  const file = journalFile(root, messageId);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
  return next;
}

export function releaseJournal(root, messageId) {
  const file = journalFile(root, messageId);
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function listJournal(root) {
  const dir = ensureBus(root).journal;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    // The FILENAME is authoritative for identity, so an unparseable or
    // shapeless entry is still releasable instead of wedging the queue: without
    // this, one junk file would make every future process/recover throw.
    .filter((name) => name.endsWith(".json") && MESSAGE_ID_PATTERN.test(name.slice(0, -".json".length)))
    .map((name) => ({
      state: "CLAIMED",
      ...(readJsonIfPresent(path.join(dir, name)) ?? {}),
      messageId: name.slice(0, -".json".length)
    }));
}

/** Which lane a message belongs in, derived from its provider, not its agent id. */
export function laneFor(fromAgentProvider) {
  return fromAgentProvider === "openai" ? "gptToClaude" : "claudeToGpt";
}

function compactTimestamp(iso) {
  // Strips `-`, `:` and `.`; the colons matter because they are illegal in
  // Windows filenames and the id becomes a filename.
  return iso.replace(/[-:.]/g, "");
}

/**
 * Message ids become file paths, so they are strictly constrained. Without this
 * a peer-authored message could carry `"id": "../../../scripts/agent-bus"` and
 * steer the acknowledgement write outside the bus directory.
 */
export const MESSAGE_ID_PATTERN = /^MSG-\d{8}T\d{9}Z-[a-z_]+-[0-9a-f]{8}$/;

/**
 * Quarantine key for a file whose own identity is unusable — unparseable, or a
 * filename that is not a safe message id. Derived from the filename so it is
 * deterministic and stable across machines and runs.
 */
export const REJECTION_KEY_PATTERN = /^(MSG-\d{8}T\d{9}Z-[a-z_]+-[0-9a-f]{8}|MALFORMED-[0-9a-f]{16})$/;

export function malformedRejectionKey(fileName) {
  return `MALFORMED-${crypto.createHash("sha256").update(fileName).digest("hex").slice(0, 16)}`;
}

export function assertSafeMessageId(messageId) {
  if (typeof messageId !== "string" || !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error(`unsafe or malformed message id: ${String(messageId)}`);
  }
  return messageId;
}

/** Accepts a real message id OR a derived malformed key. */
export function assertSafeRejectionKey(key) {
  if (typeof key !== "string" || !REJECTION_KEY_PATTERN.test(key)) {
    throw new Error(`unsafe or malformed rejection key: ${String(key)}`);
  }
  return key;
}

export function newMessageId(type, createdAt) {
  return `MSG-${compactTimestamp(createdAt)}-${type}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Structural validation. Deliberately independent of the control plane so a
 * malformed message is rejected before it can reach any task transition.
 */
export function validateMessage(message) {
  const errors = [];
  const required = ["id", "fromAgent", "toAgent", "type", "summary", "createdAt", "status"];
  for (const field of required) {
    if (message?.[field] === undefined || message[field] === null || message[field] === "") {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (message?.type && !MESSAGE_TYPES.includes(message.type)) {
    errors.push(`unknown message type: ${message.type}`);
  }
  if (message?.fromAgent && message.fromAgent === message.toAgent) {
    errors.push("fromAgent and toAgent must differ");
  }
  if (message?.type && TASK_REQUIRED_TYPES.includes(message.type) && !message.taskId) {
    errors.push(`${message.type} requires taskId`);
  }
  if (message?.type && SHA_REQUIRED_TYPES.includes(message.type) && !message.commitSha) {
    errors.push(`${message.type} requires commitSha so the decision binds to reviewed code`);
  }
  if (message?.evidence !== undefined && !Array.isArray(message.evidence)) {
    errors.push("evidence must be an array of references");
  }
  if (message?.commitSha && !/^[0-9a-f]{40}$/.test(message.commitSha)) {
    errors.push("commitSha must be a full 40-character hex sha, not a ref name or abbreviation");
  }
  if (message?.baseSha && !/^[0-9a-f]{40}$/.test(message.baseSha)) {
    errors.push("baseSha must be a full 40-character hex sha, not a ref name or abbreviation");
  }
  if (message?.baseSha && message.baseSha === message.commitSha) {
    errors.push("baseSha must differ from commitSha; an empty range reviews nothing");
  }
  if (message?.id !== undefined && !MESSAGE_ID_PATTERN.test(String(message.id))) {
    errors.push(`malformed id: ${String(message.id)}`);
  }
  return errors;
}

export function createMessage(root, fields) {
  const createdAt = fields.createdAt ?? new Date().toISOString();
  const message = {
    id: fields.id ?? newMessageId(fields.type, createdAt),
    fromAgent: fields.fromAgent,
    toAgent: fields.toAgent,
    taskId: fields.taskId ?? null,
    type: fields.type,
    commitSha: fields.commitSha ?? null,
    // Optional lower bound of the review range. On a RE-review this is the
    // previously reviewed commit, so the reviewer sees the cumulative
    // corrective delta rather than only the most recent commit.
    baseSha: fields.baseSha ?? null,
    summary: fields.summary,
    evidence: fields.evidence ?? [],
    createdAt,
    // Immutable initial status. Effective status is derived from the presence of
    // an acknowledgement file -- see effectiveStatus().
    status: "open"
  };

  const errors = validateMessage(message);
  if (errors.length) throw new Error(`invalid handoff message:\n  - ${errors.join("\n  - ")}`);

  // Enforced on CREATION rather than in validateMessage, so historical messages
  // published before this rule are not retroactively treated as malformed.
  if (BASE_REQUIRED_TYPES.includes(message.type) && !message.baseSha) {
    throw new Error(
      `${message.type} requires an explicit baseSha (full 40-hex). ` +
      "A review must state the exact range it covers; there is no parent-commit fallback. " +
      "Pass --base <sha>, or --base auto to resolve it from the task's review history."
    );
  }

  const paths = ensureBus(root);
  const dir = paths[fields.lane];
  if (!dir) throw new Error(`unknown lane: ${String(fields.lane)}`);
  const file = path.join(dir, `${assertSafeMessageId(message.id)}.json`);
  // `wx` -- never silently overwrite an existing message. Messages are immutable.
  fs.writeFileSync(file, JSON.stringify(message, null, 2) + "\n", { flag: "wx" });
  return { message, file };
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readAcknowledgement(root, messageId) {
  return readJsonIfPresent(
    path.join(busPaths(root).acknowledgements, `${assertSafeMessageId(messageId)}.json`)
  );
}

export function readRejection(root, key) {
  return readJsonIfPresent(
    path.join(busPaths(root).rejections, `${assertSafeRejectionKey(key)}.json`)
  );
}

/**
 * Files in the agent's inbound lane that could not be interpreted as messages.
 *
 * These must NOT be silently skipped: a permanently malformed peer file has to
 * become a durable rejection record, otherwise it stays invisible forever and
 * every checkout rediscovers it as a fresh anomaly. The lane determines the
 * recipient, because a file we cannot parse cannot tell us who it is for.
 */
export function listMalformed(root, { toAgent = null } = {}) {
  const paths = ensureBus(root);
  const lanes = [
    { dir: paths.gptToClaude, recipientHint: "claude" },
    { dir: paths.claudeToGpt, recipientHint: "gpt" }
  ];
  const out = [];
  for (const { dir, recipientHint } of lanes) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const stem = name.slice(0, -".json".length);
      const raw = readJsonIfPresent(path.join(dir, name));

      let reason = null;
      if (!raw) reason = "file is not valid JSON";
      else if (!MESSAGE_ID_PATTERN.test(stem)) reason = `filename is not a safe message id: ${name}`;
      else if (raw.id !== stem) reason = `id "${String(raw.id)}" does not match filename "${name}"`;
      else {
        const errors = validateMessage(raw);
        if (errors.length) reason = `structurally invalid: ${errors.join("; ")}`;
      }
      if (!reason) continue;

      // An unparseable file cannot name its recipient, so the lane decides.
      if (toAgent) {
        const claimed = raw && typeof raw.toAgent === "string" ? raw.toAgent : null;
        const belongs = claimed ? claimed === toAgent : toAgent.startsWith(recipientHint);
        if (!belongs) continue;
      }

      const key = MESSAGE_ID_PATTERN.test(stem) ? stem : malformedRejectionKey(name);
      out.push({ key, fileName: name, lane: path.basename(dir), reason, raw });
    }
  }
  return out;
}

/**
 * Quarantine a message that can never become valid.
 *
 * SHARED and committed, unlike the local journal: a message is immutable, so a
 * structural or identity defect in it is a fact about the message itself, not
 * about one machine. Recording it in the repo stops every other checkout from
 * rediscovering the same bad file and failing on it forever.
 *
 * A rejection is NOT an acknowledgement. `acknowledged` means "successfully
 * processed"; these two must never be conflated.
 */
export function rejectMessage(root, key, { agent, reason, message = null, originalFilename = null }) {
  assertSafeRejectionKey(key);
  const paths = ensureBus(root);
  const record = {
    messageId: key,
    // Preserved as evidence when the file's own identity was unusable and the
    // key had to be derived from the filename instead.
    originalFilename,
    rejectedBy: agent,
    rejectedAt: new Date().toISOString(),
    reason,
    messageType: message?.type ?? null,
    fromAgent: message?.fromAgent ?? null,
    toAgent: message?.toAgent ?? null,
    taskId: message?.taskId ?? null,
    commitSha: message?.commitSha ?? null
  };
  const file = path.join(paths.rejections, `${key}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    return { record, created: true };
  } catch (error) {
    if (error.code === "EEXIST") return { record: readJsonIfPresent(file) ?? record, created: false };
    throw error;
  }
}

export function effectiveStatus(root, message) {
  if (readAcknowledgement(root, message.id)) return "acknowledged";
  if (readRejection(root, message.id)) return "rejected";
  return "open";
}

/** All messages in both lanes, newest last, with derived status. */
export function listMessages(root, { toAgent = null, includeAcknowledged = false, includeRejected = false } = {}) {
  const paths = ensureBus(root);
  const out = [];
  for (const dir of [paths.gptToClaude, paths.claudeToGpt]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const message = readJsonIfPresent(path.join(dir, name));
      if (!message) continue;
      // The FILENAME is authoritative for identity, and a message that fails
      // structural validation is skipped rather than allowed to reach the sort
      // below -- otherwise one malformed file from the peer lane would throw and
      // take down inbox, process and ack for every message.
      if (message.id !== name.slice(0, -".json".length)) continue;
      if (validateMessage(message).length) continue;
      const status = effectiveStatus(root, message);
      if (toAgent && message.toAgent !== toAgent) continue;
      if (!includeAcknowledged && status === "acknowledged") continue;
      if (!includeRejected && status === "rejected") continue;
      out.push({ ...message, status });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function findMessage(root, messageId) {
  assertSafeMessageId(messageId);
  const paths = ensureBus(root);
  for (const dir of [paths.gptToClaude, paths.claudeToGpt]) {
    const file = path.join(dir, `${messageId}.json`);
    if (fs.existsSync(file)) {
      const message = readJsonIfPresent(file);
      if (message) return { message, file };
    }
  }
  return null;
}

/**
 * Claim a message exactly once.
 *
 * The `wx` flag is the whole idempotency mechanism: the filesystem guarantees
 * only one writer creates the acknowledgement, so a re-run of inbox processing
 * cannot re-apply a transition, re-request a review, or duplicate a handoff.
 * Throws if the message was already acknowledged.
 */
export function acknowledge(root, messageId, { agent, outcome = "processed", note = null, applied = null }) {
  assertSafeMessageId(messageId);
  const paths = ensureBus(root);
  const file = path.join(paths.acknowledgements, `${messageId}.json`);
  const record = {
    messageId,
    acknowledgedBy: agent,
    acknowledgedAt: new Date().toISOString(),
    outcome,
    applied,
    note
  };
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`${messageId} was already acknowledged; refusing to process it twice`);
    }
    throw error;
  }
  return record;
}

/* ---------------------------------------------------------------------------
 * Direct CLI entry point.
 *
 * The bus commands need the control plane's enforcement logic (reviewer
 * identity, fingerprint binding, gates), which lives in ai-control-plane.mjs.
 * Importing that module would execute its CLI, and having it import this one
 * back would be a cycle -- so when this file is run directly it simply forwards
 * to the control-plane CLI, which owns the enforcement.
 *
 *   node scripts/agent-bus.mjs inbox   claude-lead
 *   node scripts/agent-bus.mjs process claude-lead
 *   node scripts/agent-bus.mjs handoff --from ... --to ... --type ...
 *   node scripts/agent-bus.mjs ack     <messageId>
 * ------------------------------------------------------------------------- */
const BUS_COMMANDS = ["inbox", "process", "handoff", "ack", "recover"];

/**
 * Is this module the process entry point?
 *
 * Compared through realpath because Windows can hand the two sides different
 * spellings of the same file -- notably 8.3 short names under %TEMP%
 * (`DIEGOC~1`) and drive-letter case. A mismatch would make the shim silently
 * do nothing and exit 0, which looks like success.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const canonical = (p) => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  const self = canonical(fileURLToPath(import.meta.url));
  const entry = canonical(path.resolve(process.argv[1]));
  return process.platform === "win32"
    ? self.toLowerCase() === entry.toLowerCase()
    : self === entry;
}

if (isEntryPoint()) {
  const args = process.argv.slice(2);
  if (!args.length || !BUS_COMMANDS.includes(args[0])) {
    console.log(`Agent bus commands:\n  ${BUS_COMMANDS.join("\n  ")}\n\nRun with one of the above, e.g.:\n  node scripts/agent-bus.mjs inbox claude-lead`);
    process.exit(args.length ? 1 : 0);
  }
  const controlPlane = path.join(path.dirname(fileURLToPath(import.meta.url)), "ai-control-plane.mjs");
  const result = spawnSync(process.execPath, [controlPlane, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
