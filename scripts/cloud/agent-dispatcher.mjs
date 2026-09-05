#!/usr/bin/env node
/**
 * The optional API-driven autonomous dispatcher (PL-AI-0003).
 *
 * OPTIONAL, AND OFF. Two switches must both be on before this program does
 * anything at all: `control/adapters.json` -> `dispatcher.enabled` must be
 * `true` (it ships `false`), and the environment variable that block names must
 * equal exactly `"1"`. Neither default is on, and neither implies the other.
 * With the shipped configuration, `--apply` plans, prints, writes nothing and
 * exits 0 -- the same posture `orchestrator-gate.mjs` takes, where a dormant
 * scheduled run is not a failure.
 *
 * All policy lives in `dispatch-policy.mjs`, which is pure and has no network,
 * no clock and no file system. This file is the shell: it reads control state,
 * hands it to the planner, prints the plan, and -- only when armed and only with
 * `--apply` -- invokes the provider runner for each dispatchable decision and
 * appends an audit record.
 *
 * ============================================================================
 * WHAT IT CANNOT DO
 * ============================================================================
 *
 * There is no `--claim` flag and there will not be one. This program never
 * writes `control/tasks.json`, never records a quality gate, and never
 * transitions a task. Dispatching work is not the same act as asserting that
 * the work was done, and a gate result is evidence attributed to whoever ran
 * the command -- fabricating one is the cardinal defect in this repository. The
 * receiving lane claims and gates its own work through the enforced
 * control-plane path, or nothing is recorded.
 *
 * `test-dispatcher.mjs` asserts this rather than trusting the comment: it runs
 * `--apply` against a fixture repository and requires `control/tasks.json` to
 * come back byte-identical.
 *
 * Usage:
 *   node scripts/cloud/agent-dispatcher.mjs [--plan] [--json] [--root DIR]
 *   node scripts/cloud/agent-dispatcher.mjs --apply --as <agentId> [--root DIR]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  DISPATCH,
  UNREADABLE_LEDGER,
  planDispatch,
  classifyRunnerFailure,
  resolveDispatcherConfig
} from "./dispatch-policy.mjs";
// The runner registry lives in its own module because this file is a CLI and
// executes on import: nothing could test a registry declared here. See
// dispatch-runners.mjs for what is real and what is a declared-but-unbuilt seam.
import { PROVIDER_RUNNERS } from "./dispatch-runners.mjs";

/* ---------------------------------------------------------------------------
 * Argument parsing
 * ------------------------------------------------------------------------- */
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const root = path.resolve(value("--root", process.cwd()));
const apply = has("--apply");
const asJson = has("--json");
const fromAgent = value("--as");

/**
 * `process.exitCode`, never `process.exit()`.
 *
 * `process.exit()` terminates before a piped stdout has necessarily flushed on
 * Windows, which this repository has already been bitten by: the output is
 * truncated and the truncation looks like the program having produced less.
 * Setting the code and returning lets Node drain normally.
 */
function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

/* ---------------------------------------------------------------------------
 * Reading control state
 * ------------------------------------------------------------------------- */
function readJsonOrThrow(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}
/**
 * The budget ledger, with "absent" and "unreadable" kept apart.
 *
 * `null` means the file does not exist -- nothing has been spent, which is a
 * correct initial state. `UNREADABLE_LEDGER` means it exists and could not be
 * read, which means spend is unknown and every metered dispatch refuses.
 * Returning `null` for both would make deleting or corrupting one file the way
 * to reset the budget.
 */
function readLedger(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return UNREADABLE_LEDGER;
  }
}

/**
 * Approvals, keyed by id.
 *
 * An approval that cannot be parsed is DROPPED, not repaired and not guessed
 * at, which leaves the dispatch it would have covered refused with
 * `human_approval_missing`. That is the right direction: an unreadable file is
 * not consent. The count of dropped files is printed so the operator can tell
 * "nobody approved this" from "the approval is corrupt".
 */
function readApprovals(dir) {
  const abs = path.join(root, dir);
  const approvals = new Map();
  let unreadable = 0;
  if (!fs.existsSync(abs)) return { approvals, unreadable };
  for (const name of fs.readdirSync(abs).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(abs, name), "utf8"));
      const id = typeof record?.approvalId === "string" ? record.approvalId : name.slice(0, -".json".length);
      approvals.set(id, { ...record, approvalId: id });
    } catch {
      unreadable += 1;
    }
  }
  return { approvals, unreadable };
}

/**
 * Prior attempts per (task, provider), read from the audit log.
 *
 * ACROSS RUNS, deliberately. An in-memory counter would reset the retry ceiling
 * every time the scheduler fired, which is the same as having no ceiling.
 *
 * An unparseable line makes this an UNDERCOUNT, and an undercounted attempt
 * ledger silently widens the retry budget -- so a single bad line refuses the
 * whole run rather than being skipped. That is the only safe reading: the
 * failure of a corrupt audit log must not be "more retries".
 */
function readAttempts(rel) {
  const abs = path.join(root, rel);
  const attempts = new Map();
  if (!fs.existsSync(abs)) return { attempts, problems: [] };
  const problems = [];
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      problems.push(`${rel}:${index + 1} is not parseable JSON; refusing to run on an attempt count that may be short`);
      return;
    }
    // An attempt is a dispatch that was actually sent. A refusal sent nothing,
    // so counting it would spend the retry budget on decisions the dispatcher
    // made entirely by itself.
    if (record?.outcome !== "dispatched" && record?.outcome !== "failed") return;
    const key = `${record.taskId}::${record.providerId}`;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
  });
  return { attempts, problems };
}

/* ---------------------------------------------------------------------------
 * Audit
 * ------------------------------------------------------------------------- */

/**
 * Append-only JSONL, one record per DECISION -- refusals included.
 *
 * An audit log that only records what happened is not an audit log; the useful
 * question after an incident is usually "why did it not dispatch", and a log of
 * successes cannot answer it.
 *
 * The id is DERIVED, not random, from the facts that identify this decision.
 * Two runs that reach the same decision for the same attempt produce the same
 * id, so a crash between the runner call and the append cannot be distinguished
 * from a duplicate by luck -- it can be spotted by id, which is the same
 * property `agent-bus.mjs` gets from deterministic event ids.
 *
 * The tuple is joined with a SPACE, and the separator must stay a printable
 * character. It was briefly a literal NUL byte, which made git classify this
 * whole file as binary -- no diff, no blame -- and made every directory-wide
 * ripgrep skip it silently, so the file became unreviewable and unsearchable
 * for the sake of a separator no reader can see. None of the joined fields is
 * free text, so a space cannot collide across distinct tuples here.
 *
 * Written ONLY under `--apply`. A planning run that wrote audit records would
 * make "what would happen" indistinguishable from "what happened".
 */
function auditId(record) {
  return crypto
    .createHash("sha256")
    .update([record.runId, record.taskId, record.providerId, record.attempt, record.outcome].join(" "))
    .digest("hex")
    .slice(0, 16);
}

function appendAudit(rel, record) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify({ id: auditId(record), ...record }) + "\n");
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */
let adapterDoc;
let taskDoc;
let agentDoc;
let policies;
let controlStateRead = false;
try {
  adapterDoc = readJsonOrThrow("control/adapters.json");
  taskDoc = readJsonOrThrow("control/tasks.json");
  agentDoc = readJsonOrThrow("control/agents.json");
  policies = readJsonOrThrow("control/policies.json");
  controlStateRead = true;
} catch (error) {
  fail(`Cannot read control state under ${root}: ${error.message}`);
}

if (controlStateRead) {
  const resolved = resolveDispatcherConfig(adapterDoc);
  const config = resolved.ok ? resolved.config : null;

  const ledger = config ? readLedger(config.budget.ledger) : null;
  const { approvals, unreadable } = config
    ? readApprovals(config.approvalsDir)
    : { approvals: new Map(), unreadable: 0 };
  const { attempts, problems: auditProblems } = config
    ? readAttempts(config.auditLog)
    : { attempts: new Map(), problems: [] };

  const plan = planDispatch({
    tasks: taskDoc.tasks ?? [],
    agents: agentDoc.agents ?? [],
    policies,
    adapterDoc,
    env: process.env,
    ledger,
    approvals,
    runners: PROVIDER_RUNNERS,
    attempts,
    now: Date.now()
  });

  if (asJson) {
    console.log(JSON.stringify({ ...plan, auditProblems, unreadableApprovals: unreadable }, null, 2));
  } else {
    console.log("=== OPTIONAL AUTONOMOUS DISPATCHER ===");
    console.log(plan.armed ? "State: ARMED" : "State: DISARMED (default)");
    console.log(plan.summary);
    if (plan.configProblems.length) {
      console.log("\n--- configuration problems (all dispatch refused) ---");
      for (const problem of plan.configProblems) console.log(`- ${problem}`);
    }
    if (unreadable) {
      console.log(`\n${unreadable} approval file(s) could not be parsed and were ignored. An unreadable file is not consent.`);
    }
    console.log("\n--- decisions ---");
    if (!plan.decisions.length) console.log("(none) No READY task is a dispatch candidate.");
    for (const decision of plan.decisions) {
      const cost = decision.estimate.known
        ? `${decision.estimate.amount} ${decision.estimate.currency} (${decision.estimate.basis})`
        : `cost unknown: ${decision.estimate.reason}`;
      console.log(
        `${decision.taskId} -> ${decision.agentId ?? "(no agent)"} via ${decision.providerId ?? "(no provider)"}: ` +
        `${decision.decision.toUpperCase()} [${cost}]`
      );
      for (const refusal of decision.refusals) console.log(`    ${refusal.code}: ${refusal.detail}`);
    }
    console.log(
      "\nThis program never claims a task, records a gate result, or transitions anything. " +
      "The receiving lane does that itself, through the control plane."
    );
  }

  // Every fatal condition below refuses the RUN, not just a decision: an
  // undercounted attempt log or an invalid configuration makes every decision
  // above untrustworthy, and half-trusting a plan is worse than refusing it.
  if (auditProblems.length) {
    for (const problem of auditProblems) console.error(problem);
    fail("Refusing to dispatch: the audit log could not be read in full.");
  } else if (plan.configProblems.length && apply) {
    fail("Refusing to dispatch: the dispatcher configuration is invalid.");
  } else if (apply && !plan.armed) {
    // Deliberately exit 0. A dormant scheduled run is not a failure -- the same
    // rule orchestrator-gate.mjs states. Nothing was written.
    console.log("\n--apply requested, but the dispatcher is disarmed. Nothing was dispatched and nothing was written.");
  } else if (apply) {
    if (!fromAgent) {
      fail(
        "--apply requires --as <agentId>: a dispatch publishes a message under an author, and this " +
        "program will not choose an identity to publish under on its own. Note that the bus does not " +
        "authenticate this value -- see the cooperative-github-writers trust model in " +
        "coordination/agent-bus/README.md."
      );
    } else if (!(agentDoc.agents ?? []).some((a) => a.id === fromAgent && a.kind !== "executive")) {
      fail(`--as ${fromAgent} is not a non-executive agent in control/agents.json`);
    } else {
      const runId = crypto.randomUUID();
      const tasksById = new Map((taskDoc.tasks ?? []).map((t) => [t.id, t]));
      let dispatched = 0;
      let failed = 0;

      for (const decision of plan.decisions) {
        const base = {
          at: new Date().toISOString(),
          runId,
          taskId: decision.taskId,
          providerId: decision.providerId,
          agentId: decision.agentId,
          runnerId: decision.runnerId,
          attempt: decision.attempt,
          approvalId: decision.approvalId,
          estimate: decision.estimate
        };

        if (decision.decision !== DISPATCH) {
          appendAudit(config.auditLog, { ...base, outcome: "refused", refusals: decision.refusals });
          continue;
        }

        const runner = PROVIDER_RUNNERS.get(decision.runnerId);
        const invocation = runner.buildInvocation({
          task: tasksById.get(decision.taskId),
          agentId: decision.agentId,
          fromAgent,
          decision
        });
        try {
          const output = runner.run(invocation, { root });
          appendAudit(config.auditLog, {
            ...base,
            outcome: "dispatched",
            detail: String(output).trim().split("\n").slice(-2).join(" | ").slice(0, 400)
          });
          dispatched += 1;
          console.log(`DISPATCHED ${decision.taskId} -> ${decision.agentId} via ${decision.runnerId}`);
        } catch (error) {
          const classification = classifyRunnerFailure(error);
          appendAudit(config.auditLog, {
            ...base,
            outcome: "failed",
            classification,
            detail: String(error?.message ?? error).slice(0, 400)
          });
          failed += 1;
          console.error(`FAILED ${decision.taskId} (${classification}): ${error?.message ?? error}`);
        }
      }

      console.log(`\nDispatched ${dispatched}, failed ${failed}.`);
      // A failed dispatch is a run failure: the retry ceiling is bounded and an
      // exhausted one must eventually be visible rather than absorbed.
      if (failed) process.exitCode = 1;
    }
  }
}
