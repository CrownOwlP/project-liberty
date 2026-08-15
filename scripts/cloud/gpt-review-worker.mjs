#!/usr/bin/env node
/**
 * Autonomous gpt-architect review worker.
 *
 * Reads unacknowledged messages addressed to gpt-architect from the agent bus,
 * reviews the EXACT commit each one names, and publishes a structured decision
 * back through the bus. Runs in GitHub Actions; never needs a human.
 *
 * Hard rules enforced here, not left to the model:
 *   - the decision is read from a STRUCTURED enum field, never parsed from prose
 *   - the review targets message.commitSha, not HEAD and not main
 *   - a RE-review covers the CUMULATIVE corrective delta (see resolveReviewBase)
 *   - files outside the task's allowedPaths are shown as CONTEXT ONLY and are
 *     explicitly excluded from the verdict; commits do sweep in unrelated work
 *   - test evidence is never invented
 *   - the worker refuses to review a task it implemented
 *
 * Requires: OPENAI_API_KEY. Never accepts a key as an argument.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  listMessages,
  acknowledge,
  readRejection,
  rejectMessage
} from "../agent-bus.mjs";

const root = process.cwd();
const AGENT = "gpt-architect";
const MODEL = process.env.OPENAI_REVIEW_MODEL || "gpt-5";
const MAX_PATCH_BYTES = Number(process.env.REVIEW_MAX_PATCH_BYTES || 400_000);

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is not set. Add it as a repository secret; never pass it on the command line.");
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}
function normalizePrefix(pattern) {
  return pattern.replace(/\\/g, "/").replace(/\*\*.*$/, "").replace(/\*.*$/, "").replace(/\/$/, "");
}
function withinAllowedPaths(rel, allowedPaths = []) {
  return allowedPaths.some((raw) => {
    const prefix = normalizePrefix(raw);
    return prefix && (rel === prefix || rel.startsWith(prefix + "/"));
  });
}

/** Decision shape the model MUST return. No free-form approval is accepted. */
const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "summary", "blockingFindings", "nonBlockingFindings", "reviewedScopeConfirmed"],
  properties: {
    decision: { type: "string", enum: ["review_approved", "changes_requested"] },
    summary: { type: "string" },
    reviewedScopeConfirmed: {
      type: "boolean",
      description: "True only if the verdict rests solely on files inside the task's allowedPaths."
    },
    blockingFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "finding", "requestedChange"],
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium"] },
          file: { type: "string" },
          finding: { type: "string" },
          requestedChange: { type: "string" }
        }
      }
    },
    nonBlockingFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "note"],
        properties: { file: { type: "string" }, note: { type: "string" } }
      }
    }
  }
};

async function callOpenAI(payload, attempt = 1) {
  const maxAttempts = 5;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`retryable upstream status ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    if (!response.ok) {
      throw Object.assign(
        new Error(`OpenAI error ${response.status}: ${(await response.text()).slice(0, 800)}`),
        { fatal: true }
      );
    }
    return await response.json();
  } catch (error) {
    if (error.fatal || attempt >= maxAttempts) throw error;
    // Bounded exponential backoff so a transient failure never needs a human.
    const waitMs = Math.min(2 ** attempt * 1000, 30_000) + Math.floor(Math.random() * 500);
    console.error(`attempt ${attempt} failed (${error.message}); retrying in ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return callOpenAI(payload, attempt + 1);
  }
}

function extractStructured(result) {
  const text = result.output_text
    ?? result.output?.flatMap((item) => item.content ?? [])
      .map((chunk) => chunk.text ?? "")
      .join("");
  if (!text) throw new Error("model returned no structured output");
  return JSON.parse(text);
}

function isAncestorOf(candidate, descendant) {
  if (!candidate || !/^[0-9a-f]{40}$/.test(candidate)) return false;
  if (candidate === descendant) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", candidate, descendant], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lower bound of the review range.
 *
 * A RE-review must show the cumulative corrective delta, not just the newest
 * commit: fixes for one round of findings are normally spread across several
 * commits, and `sha~1..sha` would hide everything but the last one. That is how
 * a reviewer ends up approving work it never actually saw.
 *
 * Precedence: the message's explicit baseSha, then the commit this task was
 * last reviewed at, then the parent commit.
 */
function resolveReviewBase(task, message) {
  // FAIL CLOSED. Every rejection here happens before any model call, so an
  // unresolvable range costs nothing and can never produce a verdict.
  if (!message.baseSha) {
    throw new Error(
      `${message.id} carries no baseSha. A review must state the exact range it covers. ` +
      "Republish with --base <sha> or --base auto."
    );
  }
  if (!/^[0-9a-f]{40}$/.test(message.baseSha)) {
    throw new Error(`${message.id} baseSha is not a full 40-character hex sha: ${message.baseSha}`);
  }
  if (message.baseSha === message.commitSha) {
    throw new Error(`${message.id} baseSha equals commitSha; an empty range reviews nothing`);
  }
  if (!isAncestorOf(message.baseSha, message.commitSha)) {
    throw new Error(
      `${message.id} baseSha ${message.baseSha.slice(0, 12)} is not an ancestor of ` +
      `${message.commitSha.slice(0, 12)}. The range is not a real line of history, so the diff would be meaningless.`
    );
  }

  // Cross-check against the task's own record. A narrower range than the task
  // actually accumulated would hide earlier corrective commits from the reviewer.
  const priorReviewed = [...(task.reviewHistory ?? [])]
    .reverse()
    .map((entry) => entry.reviewedCommitSha)
    .find((sha) => /^[0-9a-f]{40}$/.test(String(sha)) && sha !== message.commitSha);
  const expected = priorReviewed ?? task.implementationBaseSha ?? null;

  if (expected && expected !== message.baseSha && isAncestorOf(expected, message.baseSha)) {
    throw new Error(
      `${message.id} baseSha ${message.baseSha.slice(0, 12)} is NEWER than the expected base ` +
      `${expected.slice(0, 12)} (${priorReviewed ? "previous review" : "implementation start"}). ` +
      "That would hide part of the delta under review. Republish with --base auto."
    );
  }

  return {
    base: message.baseSha,
    source: priorReviewed ? "explicit baseSha (re-review)" : "explicit baseSha (first review)"
  };
}

function buildReviewContext(task, message) {
  const commitSha = message.commitSha;
  const allowed = task.allowedPaths ?? [];
  const { base, source } = resolveReviewBase(task, message);

  const changed = git("diff", "--name-only", base, commitSha)
    .split("\n").map((s) => s.trim()).filter(Boolean);

  const inScope = changed.filter((rel) => withinAllowedPaths(rel, allowed));
  const outOfScope = changed.filter((rel) => !withinAllowedPaths(rel, allowed));

  let patch = "";
  if (inScope.length) {
    patch = git("diff", base, commitSha, "--", ...inScope);
    if (patch.length > MAX_PATCH_BYTES) {
      patch = patch.slice(0, MAX_PATCH_BYTES) + "\n[... diff truncated for length ...]\n";
    }
  }
  return { base, source, inScope, outOfScope, patch };
}

function contextDoc(rel) {
  const abs = path.join(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").slice(0, 20_000) : "";
}

async function reviewMessage(message) {
  const tasks = readJson("control/tasks.json").tasks;
  const task = tasks.find((t) => t.id === message.taskId);
  if (!task) throw new Error(`unknown task ${message.taskId}`);

  if (task.implementationAgent === AGENT || task.owner === AGENT) {
    throw new Error(`${AGENT} implemented ${task.id} and must not review its own work`);
  }

  // A request for a task that already finished is stale by definition. `main`
  // still carries review requests published before the baseSha schema existed,
  // and one of those must not fail the hosted workflow on every single run.
  if (["DONE", "CANCELED"].includes(task.status)) {
    throw new Error(
      `stale review request: ${task.id} is already ${task.status}, so there is nothing left to review`
    );
  }

  const ctx = buildReviewContext(task, message);
  console.log(`  review range: ${ctx.base.slice(0, 12)}..${message.commitSha.slice(0, 12)} (${ctx.source})`);
  console.log(`  in scope: ${ctx.inScope.length} file(s); out of scope: ${ctx.outOfScope.length}`);

  const instructions = [
    "You are gpt-architect, the independent architecture and security reviewer for Project Liberty.",
    "Return ONLY the structured decision object. Never approve work you cannot see.",
    "",
    "Review rules:",
    "- Judge ONLY files inside the task's allowedPaths. Files listed as out-of-scope were swept",
    "  into the same commit range by another task and MUST NOT influence your verdict.",
    "- The diff is the CUMULATIVE range shown. Treat it as the complete set of changes under review.",
    "- Never fabricate test evidence. If you need a result you do not have, that is a blocking",
    "  finding, not an assumption.",
    "- Enforce the product invariants: only licensed/owned/public-domain content may enter playback",
    "  resolution; no DRM/paywall/geo bypass; provider adapters stay behind the provider SDK;",
    "  playback decisions expose a reason trail; API behaviour matches docs/API_CONTRACTS.md.",
    "- changes_requested requires at least one blocking finding.",
    "- review_approved requires zero blocking findings."
  ].join("\n");

  const input = [
    `## Task ${task.id}: ${task.title}`,
    `Lane: ${task.lane} | Priority: ${task.priority}`,
    `Acceptance: ${task.acceptance}`,
    `allowedPaths: ${JSON.stringify(task.allowedPaths)}`,
    `Required gates: ${JSON.stringify(task.qualityGates)}`,
    "",
    `## Review range: ${ctx.base}..${message.commitSha}`,
    `Range basis: ${ctx.source}`,
    `Request summary: ${message.summary}`,
    `Evidence supplied by the implementer: ${JSON.stringify(message.evidence ?? [])}`,
    "",
    `## In-scope changed files (${ctx.inScope.length})`,
    ctx.inScope.join("\n") || "(none)",
    "",
    `## OUT OF SCOPE - context only, must not affect the verdict (${ctx.outOfScope.length})`,
    ctx.outOfScope.join("\n") || "(none)",
    "",
    "## Cumulative diff (in-scope only)",
    "```diff",
    ctx.patch || "(no in-scope changes)",
    "```",
    "",
    "## Architecture context",
    contextDoc("docs/ARCHITECTURE.md"),
    "",
    "## Content rights context",
    contextDoc("docs/CONTENT_RIGHTS.md")
  ].join("\n");

  const result = await callOpenAI({
    model: MODEL,
    instructions,
    input,
    text: {
      format: { type: "json_schema", name: "liberty_review_decision", strict: true, schema: DECISION_SCHEMA }
    }
  });

  const decision = extractStructured(result);

  if (decision.decision === "review_approved" && decision.blockingFindings.length > 0) {
    throw new Error("model returned review_approved with blocking findings; refusing an inconsistent verdict");
  }
  if (decision.decision === "changes_requested" && decision.blockingFindings.length === 0) {
    throw new Error("model returned changes_requested with no blocking findings; refusing an unactionable verdict");
  }
  return { task, decision, ctx };
}

function publishDecision(message, task, decision, ctx) {
  const evidence = [
    `reviewedRange=${ctx.base}..${message.commitSha}`,
    `rangeBasis=${ctx.source}`,
    `inScopeFiles=${ctx.inScope.length}`,
    `outOfScopeIgnored=${ctx.outOfScope.length}`,
    `model=${MODEL}`,
    `inReplyTo=${message.id}`,
    ...decision.blockingFindings.map((f) => `${f.severity}:${f.file}: ${f.finding} -> ${f.requestedChange}`),
    ...decision.nonBlockingFindings.map((f) => `note:${f.file}: ${f.note}`)
  ];

  const args = [
    "handoff",
    "--from", AGENT,
    "--to", task.implementationAgent || task.owner || "claude-lead",
    "--type", decision.decision,
    "--task", task.id,
    "--sha", message.commitSha,
    // Carried through so the decision itself records the exact range reviewed,
    // not just its endpoint.
    "--base", ctx.base,
    "--summary", decision.summary.slice(0, 900)
  ];
  for (const item of evidence) args.push("--evidence", item.slice(0, 500));

  const out = execFileSync(process.execPath, ["scripts/ai-control-plane.mjs", ...args], {
    cwd: root, encoding: "utf8"
  });
  console.log(out.trim());
  return out.match(/Published (MSG-\S+)/)?.[1] ?? null;
}

const pending = listMessages(root, { toAgent: AGENT })
  .filter((m) => ["review_request", "implementation_ready"].includes(m.type));

if (!pending.length) {
  console.log("No review requests pending for gpt-architect.");
  process.exit(0);
}

let handled = 0;
let failed = 0;
for (const message of pending) {
  if (readRejection(root, message.id)) continue;
  console.log(`\n=== Reviewing ${message.id} (${message.taskId} @ ${message.commitSha?.slice(0, 12)}) ===`);
  try {
    const { task, decision, ctx } = await reviewMessage(message);
    const publishedId = publishDecision(message, task, decision, ctx);
    // Acknowledge only AFTER the decision is durably published, so a crash in
    // between leaves the request pending rather than silently consumed.
    acknowledge(root, message.id, {
      agent: AGENT,
      outcome: "processed",
      applied: `${decision.decision} published as ${publishedId}`
    });
    console.log(`${message.id}: ${decision.decision} (${decision.blockingFindings.length} blocking)`);
    handled++;
  } catch (error) {
    // These defects are intrinsic to the message: the range cannot be
    // established, the task is gone, or the request is stale. None can become
    // reviewable without being republished, so each is quarantined once and
    // then skipped forever. Anything else stays pending and is retried.
    const permanent = /unknown task|must not review its own work|baseSha|stale review request/;
    if (permanent.test(error.message)) {
      rejectMessage(root, message.id, { agent: AGENT, reason: error.message, message });
      console.error(`REJECT ${message.id}: ${error.message}`);
    } else {
      console.error(`RETRY ${message.id}: ${error.message}`);
    }
    failed++;
  }
}

console.log(`\nReviewed ${handled} request(s)${failed ? `, ${failed} unresolved` : ""}.`);
if (failed) process.exitCode = 1;
