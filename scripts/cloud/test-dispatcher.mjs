/**
 * Optional-dispatcher regression suite (PL-AI-0003).
 *
 * ---------------------------------------------------------------------------
 * NO NETWORK. NO API KEY. NO LIVE CONTROL STATE.
 * ---------------------------------------------------------------------------
 *
 * Every scenario plans over FIXTURES it constructs itself, never over whatever
 * `control/tasks.json` happens to contain today. That rule is copied
 * deliberately from `scripts/test-ai-control-plane.mjs`, which learned it three
 * times as a red build: a scenario that asserts today's data is a screenshot
 * wearing the costume of an invariant, and the project is supposed to move.
 *
 * The two scenarios that DO read the committed `control/adapters.json` are
 * marked, and they assert only that the shipped configuration REFUSES -- which
 * is a property of the file's intent, not of the backlog's contents.
 *
 * Plain node + `node:assert`, matching `test-ai-control-plane.mjs` and
 * `test-validate-env.mjs`. vitest is a workspace dependency and `turbo run test`
 * only visits workspaces; `scripts/` is not one, so a vitest suite here would be
 * written, committed and never executed -- worse than no suite, because the
 * coverage would be believed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT COVERED, AND WHY
 * ---------------------------------------------------------------------------
 *
 *  - `dispatch-runners.mjs` -> `agent-bus-handoff.run()`. Its ARGV is asserted;
 *    the execution is not, because running it publishes a real message into a
 *    real repository. Read scenario 20 as "this is what would be sent", never as
 *    "a message has been published this way".
 *  - The `openai-responses` runner. It is not registered and not written; the
 *    suite asserts precisely that, so the seam cannot quietly become a stub.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  COST_PRECISION,
  DISPATCH,
  METERED_ESTIMATE,
  NO_METERED_CALL,
  REFUSAL,
  REFUSED,
  UNREADABLE_LEDGER,
  budgetDecision,
  classifyRunnerFailure,
  dispatcherIsArmed,
  estimateCost,
  ledgerSpend,
  planDispatch,
  requiredApprovalCategories,
  resolveDispatcherConfig,
  retryDecision,
  roundCost,
  validateApproval
} from "./dispatch-policy.mjs";
import { PROVIDER_RUNNERS } from "./dispatch-runners.mjs";
import { pathsOverlap, touchesOrchestration } from "./orchestration-surface.mjs";

// `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter yields a
// leading-slash, percent-encoded string that is not a usable path.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DISPATCHER = path.join(REPO_ROOT, "scripts", "cloud", "agent-dispatcher.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "liberty-dispatcher-"));
let repoSeq = 0;

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */
const ENV_VAR = "LIBERTY_DISPATCHER_ENABLED";

const AGENTS = [
  { id: "gpt-architect", provider: "openai", kind: "external-reasoning" },
  { id: "claude-lead", provider: "anthropic", kind: "local-lead" },
  { id: "human-commander", provider: "human", kind: "executive" }
];

/** Mirrors control/policies.json -> escalation. Never read from the live file. */
const POLICIES = {
  escalation: { humanOnly: ["Credentials", "Budget", "Licensing", "IrreversibleProductionChange"] }
};

function dispatcherConfig(overrides = {}) {
  return {
    enabled: true,
    enableEnvVar: ENV_VAR,
    budget: {
      currency: "USD",
      perRunCeiling: 10,
      perTaskCeiling: 5,
      ledger: "state/ledger.json",
      ...(overrides.budget ?? {})
    },
    retries: { maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 30000, ...(overrides.retries ?? {}) },
    auditLog: "state/audit.jsonl",
    approvalsDir: "state/approvals",
    providers: overrides.providers ?? [
      { id: "test-provider", agentIds: ["gpt-architect"], runner: "metered", cost: MODEL_COST }
    ],
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => !["budget", "retries", "providers"].includes(k)))
  };
}

/** 2 USD exactly: 1000 in @ 1.00/1k + 1000 out @ 1.00/1k. Chosen so the arithmetic is checkable by eye. */
const MODEL_COST = {
  currency: "USD",
  inputPer1kTokens: 1,
  outputPer1kTokens: 1,
  estimatedInputTokens: 1000,
  estimatedOutputTokens: 1000
};

const RUNNERS = new Map([
  ["metered", { id: "metered", zeroCost: false, requiresCredential: true }],
  ["metered-nocred", { id: "metered-nocred", zeroCost: false, requiresCredential: false }],
  ["free", { id: "free", zeroCost: true, requiresCredential: false }]
]);

function fixtureTask(id, overrides = {}) {
  return {
    id,
    priority: "P1",
    lane: "Backend",
    status: "READY",
    title: `${id} fixture`,
    dependencies: [],
    allowedPaths: [`fixtures/${id.toLowerCase()}/**`],
    preferredAgent: "gpt-architect",
    reviewAgent: "claude-lead",
    qualityGates: [],
    acceptance: "fixture task used by the dispatcher scenarios",
    owner: null,
    gateResults: {},
    ...overrides
  };
}

function plan({ tasks, dispatcher, env = { [ENV_VAR]: "1" }, ledger = null, approvals = new Map(), attempts = new Map(), now = Date.parse("2026-09-04T00:00:00.000Z") }) {
  return planDispatch({
    tasks,
    agents: AGENTS,
    policies: POLICIES,
    adapterDoc: { adapters: [], dispatcher },
    env,
    ledger,
    approvals,
    runners: RUNNERS,
    attempts,
    now
  });
}

function only(result) {
  assert.equal(result.decisions.length, 1, `expected exactly one decision, got ${result.decisions.length}`);
  return result.decisions[0];
}
function codes(decision) {
  return decision.refusals.map((r) => r.code);
}

function approval(overrides = {}) {
  return {
    approvalId: "APPROVAL-0001",
    grantedBy: "human-commander",
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    categories: ["Budget", "Credentials"],
    budgetCeiling: { currency: "USD", amount: 5 },
    scope: { taskIds: "any", providerIds: "any" },
    ...overrides
  };
}

/** A temp repository containing only the four control documents the CLI reads. */
function freshRepo({ dispatcher, tasks }) {
  const repo = path.join(temp, `repo-${++repoSeq}`);
  fs.mkdirSync(path.join(repo, "control"), { recursive: true });
  const write = (rel, doc) =>
    fs.writeFileSync(path.join(repo, rel), JSON.stringify(doc, null, 2) + "\n");
  write("control/adapters.json", { $schemaVersion: 1, adapters: [], dispatcher });
  write("control/tasks.json", { $schemaVersion: 1, tasks });
  write("control/agents.json", { $schemaVersion: 1, agents: AGENTS });
  write("control/policies.json", { $schemaVersion: 1, ...POLICIES });
  return repo;
}

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [DISPATCHER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, [ENV_VAR]: "", ...env }
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

let scenarios = 0;
const scenario = () => (scenarios += 1);

try {
  /* -----------------------------------------------------------------------
   * 1. Configuration: an absent dispatcher block is invalid, not permissive.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const resolved = resolveDispatcherConfig({ adapters: [] });
    assert.equal(resolved.ok, false);
    assert.match(resolved.problems.join("\n"), /declares no dispatcher block/);

    const result = plan({ tasks: [fixtureTask("PL-D-0001")], dispatcher: undefined });
    assert.equal(result.armed, false);
    assert.equal(result.decisions.length, 0);
    assert.match(result.summary, new RegExp(REFUSAL.CONFIG_INVALID));
  }

  /* -----------------------------------------------------------------------
   * 2. Configuration: every field is checked, and ALL problems are reported.
   *
   *    Returning the first problem would make an operator fix one field per
   *    run, which is the complaint `resolveAuthConfig` in packages/auth
   *    records about exactly this shape of validator.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const broken = dispatcherConfig();
    broken.enabled = "yes";
    broken.budget.perRunCeiling = -1;
    broken.retries.maxAttempts = 0;
    broken.providers = [{ id: "", agentIds: "gpt-architect", runner: null, cost: [] }];
    const resolved = resolveDispatcherConfig({ dispatcher: broken });
    assert.equal(resolved.ok, false);
    const text = resolved.problems.join("\n");
    for (const expected of [
      /dispatcher\.enabled/,
      /perRunCeiling/,
      /maxAttempts/,
      /providers\[0\]\.id/,
      /providers\[0\]\.agentIds/,
      /providers\[0\]\.runner/,
      /providers\[0\]\.cost/
    ]) {
      assert.match(text, expected);
    }
    // Sorted, so the same broken file always reports in the same order.
    assert.deepEqual(resolved.problems, [...resolved.problems].sort());
  }

  /* -----------------------------------------------------------------------
   * 3. Arming needs BOTH switches, and the env comparison is exact.
   *
   *    A permissive parse is how a variable set to "false" turns something on.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const config = dispatcherConfig();
    assert.equal(dispatcherIsArmed(config, { [ENV_VAR]: "1" }), true);
    assert.equal(dispatcherIsArmed(config, {}), false);
    assert.equal(dispatcherIsArmed(config, { [ENV_VAR]: "true" }), false);
    assert.equal(dispatcherIsArmed(config, { [ENV_VAR]: "TRUE" }), false);
    assert.equal(dispatcherIsArmed(config, { [ENV_VAR]: " 1" }), false);
    assert.equal(dispatcherIsArmed(config, { [ENV_VAR]: "0" }), false);
    assert.equal(dispatcherIsArmed({ ...config, enabled: false }, { [ENV_VAR]: "1" }), false);
  }

  /* -----------------------------------------------------------------------
   * 4. Disarmed: every candidate is refused with `dispatcher_disabled`, and
   *    the plan still explains what else would have blocked it.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const result = plan({
      tasks: [fixtureTask("PL-D-0004")],
      dispatcher: dispatcherConfig({ enabled: false })
    });
    assert.equal(result.armed, false);
    const decision = only(result);
    assert.equal(decision.decision, REFUSED);
    assert.ok(codes(decision).includes(REFUSAL.DISABLED));
    assert.match(result.summary, /DISARMED/);
  }

  /* -----------------------------------------------------------------------
   * 5. Only READY tasks are candidates. BLOCKED especially: in this repository
   *    a blocked task is usually blocked on a human or a licence, which is the
   *    exact thing that must not be dispatched around.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const result = plan({
      tasks: [
        fixtureTask("PL-D-0005a", { status: "BLOCKED" }),
        fixtureTask("PL-D-0005b", { status: "BACKLOG" }),
        fixtureTask("PL-D-0005c", { status: "IN_PROGRESS", owner: "claude-lead" }),
        fixtureTask("PL-D-0005d", { status: "DONE" })
      ],
      dispatcher: dispatcherConfig()
    });
    assert.equal(result.decisions.length, 0, "no non-READY task may become a candidate");
  }

  /* -----------------------------------------------------------------------
   * 6. Cost is UNKNOWN far more often than it is a number, and unknown refuses.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const budget = { currency: "USD" };
    const metered = RUNNERS.get("metered");

    // No cost model at all -- the shipped default for every metered provider.
    assert.equal(estimateCost({ provider: { id: "p", cost: null }, runner: metered, budget }).known, false);

    // A negative rate.
    assert.equal(
      estimateCost({
        provider: { id: "p", cost: { ...MODEL_COST, inputPer1kTokens: -1 } },
        runner: metered,
        budget
      }).known,
      false
    );

    // A missing field.
    const missing = { ...MODEL_COST };
    delete missing.estimatedOutputTokens;
    assert.equal(estimateCost({ provider: { id: "p", cost: missing }, runner: metered, budget }).known, false);

    // A different currency. Silently converting would be the alternative, and
    // there is no exchange rate in this repository to convert with.
    assert.match(
      estimateCost({
        provider: { id: "p", cost: { ...MODEL_COST, currency: "EUR" } },
        runner: metered,
        budget
      }).reason,
      /prices in EUR but the budget is in USD/
    );

    // A model that computes exactly zero is a misconfigured rate table, not a
    // free lunch -- and accepting it would let a zeroed field disable the
    // ceiling check.
    assert.match(
      estimateCost({
        provider: { id: "p", cost: { ...MODEL_COST, inputPer1kTokens: 0, outputPer1kTokens: 0 } },
        runner: metered,
        budget
      }).reason,
      /computes 0/
    );
  }

  /* -----------------------------------------------------------------------
   * 7. A known estimate, at a declared precision.
   *
   *    Money computed from per-1k rates lands a fraction of an ulp away from
   *    the decimal value, and a budget check is an INEQUALITY -- so whether a
   *    plan fits could otherwise depend on summation order.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const estimate = estimateCost({
      provider: { id: "p", cost: MODEL_COST },
      runner: RUNNERS.get("metered"),
      budget: { currency: "USD" }
    });
    assert.equal(estimate.known, true);
    assert.equal(estimate.amount, 2);
    assert.equal(estimate.currency, "USD");
    assert.equal(estimate.basis, METERED_ESTIMATE);

    assert.equal(COST_PRECISION, 6);
    assert.equal(roundCost(0.1 + 0.2), 0.3);
    assert.equal(roundCost(1 / 3), 0.333333);
  }

  /* -----------------------------------------------------------------------
   * 8. Zero cost is accepted ONLY on the basis "this runner makes no metered
   *    call", never on an amount that merely happens to be zero. A runner that
   *    claims both is a contradiction and refuses.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const free = RUNNERS.get("free");
    const budget = { currency: "USD" };

    const ok = estimateCost({ provider: { id: "p", cost: null }, runner: free, budget });
    assert.equal(ok.known, true);
    assert.equal(ok.amount, 0);
    assert.equal(ok.basis, NO_METERED_CALL);

    const contradiction = estimateCost({ provider: { id: "p", cost: MODEL_COST }, runner: free, budget });
    assert.equal(contradiction.known, false);
    assert.match(contradiction.reason, /makes no metered call but provider p declares a cost model/);
  }

  /* -----------------------------------------------------------------------
   * 9. Ledger: absent means zero, unreadable means UNKNOWN, and the two must
   *    never collapse -- otherwise corrupting one file resets the budget.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const budget = { currency: "USD" };
    assert.deepEqual(
      { known: ledgerSpend(null, budget).known, amount: ledgerSpend(null, budget).amount },
      { known: true, amount: 0 }
    );
    assert.equal(ledgerSpend(UNREADABLE_LEDGER, budget).known, false);
    assert.equal(ledgerSpend("not an object", budget).known, false);
    assert.equal(ledgerSpend({ currency: "EUR", entries: [] }, budget).known, false);
    assert.equal(ledgerSpend({ currency: "USD", entries: {} }, budget).known, false);
    assert.equal(ledgerSpend({ currency: "USD", entries: [{ amount: "1.00" }] }, budget).known, false);

    const summed = ledgerSpend(
      { currency: "USD", entries: [{ amount: 1.5 }, { amount: 2.25 }, { amount: 0 }] },
      budget
    );
    assert.equal(summed.known, true);
    assert.equal(summed.amount, 3.75);
    assert.equal(summed.entries, 3);
  }

  /* -----------------------------------------------------------------------
   * 10. Budget: a zero ceiling means NO SPEND AUTHORIZED, not unlimited. This
   *     is the shipped default, so it is the refusal an operator meets first.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const estimate = { known: true, amount: 2, currency: "USD", basis: METERED_ESTIMATE };
    const spend = { known: true, amount: 0 };

    const zeroed = budgetDecision({
      estimate, spend, budget: { currency: "USD", perRunCeiling: 0, perTaskCeiling: 0 }
    });
    assert.equal(zeroed.ok, false);
    assert.equal(zeroed.code, REFUSAL.BUDGET_UNAUTHORIZED);

    // A per-task ceiling on its own is not authorization either.
    const halfZeroed = budgetDecision({
      estimate, spend, budget: { currency: "USD", perRunCeiling: 0, perTaskCeiling: 5 }
    });
    assert.equal(halfZeroed.code, REFUSAL.BUDGET_UNAUTHORIZED);
  }

  /* -----------------------------------------------------------------------
   * 11. Budget: unknown cost and unreadable ledger each refuse, with their own
   *     codes, and cost is checked first because an unpriced dispatch cannot be
   *     compared to any ledger.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const budget = { currency: "USD", perRunCeiling: 10, perTaskCeiling: 5 };
    assert.equal(
      budgetDecision({ estimate: { known: false, reason: "x" }, spend: { known: false }, budget }).code,
      REFUSAL.COST_UNKNOWN
    );
    assert.equal(
      budgetDecision({
        estimate: { known: true, amount: 1, currency: "USD", basis: METERED_ESTIMATE },
        spend: { known: false, reason: "corrupt" },
        budget
      }).code,
      REFUSAL.LEDGER_UNREADABLE
    );

    // A no-metered-call dispatch needs neither, because there is no spend for a
    // ceiling to bound.
    const free = budgetDecision({
      estimate: { known: true, amount: 0, currency: "USD", basis: NO_METERED_CALL },
      spend: { known: false, reason: "corrupt" },
      budget: { currency: "USD", perRunCeiling: 0, perTaskCeiling: 0 }
    });
    assert.equal(free.ok, true);
    assert.equal(free.charged, 0);
  }

  /* -----------------------------------------------------------------------
   * 12. Budget: per-task and per-run ceilings, and spend already in the ledger.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const budget = { currency: "USD", perRunCeiling: 10, perTaskCeiling: 5 };
    const big = { known: true, amount: 6, currency: "USD", basis: METERED_ESTIMATE };
    assert.equal(budgetDecision({ estimate: big, spend: { known: true, amount: 0 }, budget }).code, REFUSAL.BUDGET_EXHAUSTED);

    const two = { known: true, amount: 2, currency: "USD", basis: METERED_ESTIMATE };
    assert.equal(budgetDecision({ estimate: two, spend: { known: true, amount: 9 }, budget }).code, REFUSAL.BUDGET_EXHAUSTED);
    assert.equal(budgetDecision({ estimate: two, spend: { known: true, amount: 8 }, budget }).ok, true);

    // Exactly on the ceiling fits; over it does not.
    assert.equal(budgetDecision({ estimate: two, spend: { known: true, amount: 8 }, budget }).projected, 10);
  }

  /* -----------------------------------------------------------------------
   * 13. Budget accumulates ACROSS a plan. Ten tasks each individually under the
   *     run ceiling must not collectively blow through it -- the ledger would
   *     not learn about that until after the money was gone.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({
      budget: { currency: "USD", perRunCeiling: 5, perTaskCeiling: 5, ledger: "state/ledger.json" },
      providers: [{ id: "test-provider", agentIds: ["gpt-architect"], runner: "metered-nocred", cost: MODEL_COST }]
    });
    const approvals = new Map([["APPROVAL-0001", approval()]]);
    const result = plan({
      tasks: [fixtureTask("PL-D-0013a"), fixtureTask("PL-D-0013b"), fixtureTask("PL-D-0013c")],
      dispatcher,
      approvals
    });
    // 2 + 2 = 4 fits under 5; the third would make 6.
    assert.equal(result.totals.dispatch, 2);
    assert.equal(result.totals.plannedCost, 4);
    const third = result.decisions[2];
    assert.equal(third.decision, REFUSED);
    assert.ok(codes(third).includes(REFUSAL.BUDGET_EXHAUSTED));
  }

  /* -----------------------------------------------------------------------
   * 14. Escalation categories come from policies.json, never from a second copy
   *     in adapters.json. A category outside `humanOnly` needs no approval.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const metered = { known: true, amount: 2, currency: "USD", basis: METERED_ESTIMATE };
    const free = { known: true, amount: 0, currency: "USD", basis: NO_METERED_CALL };

    assert.deepEqual(
      requiredApprovalCategories({ estimate: metered, runner: RUNNERS.get("metered"), task: {}, policies: POLICIES }),
      ["Budget", "Credentials"]
    );
    assert.deepEqual(
      requiredApprovalCategories({ estimate: free, runner: RUNNERS.get("free"), task: {}, policies: POLICIES }),
      []
    );
    // The task-declared extension point.
    assert.deepEqual(
      requiredApprovalCategories({
        estimate: free,
        runner: RUNNERS.get("free"),
        task: { escalation: ["Licensing", "SomethingElse"] },
        policies: POLICIES
      }),
      ["Licensing"],
      "a triggered category outside humanOnly must not require approval"
    );
    // An empty humanOnly list means nothing here requires a human.
    assert.deepEqual(
      requiredApprovalCategories({
        estimate: metered,
        runner: RUNNERS.get("metered"),
        task: {},
        policies: { escalation: { humanOnly: [] } }
      }),
      []
    );
  }

  /* -----------------------------------------------------------------------
   * 15. Approvals: absent, non-human, expired, out of scope, uncovered
   *     category, and an insufficient ceiling all refuse.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const agentsById = new Map(AGENTS.map((a) => [a.id, a]));
    const task = fixtureTask("PL-D-0015");
    const provider = { id: "test-provider" };
    const estimate = { known: true, amount: 2, currency: "USD", basis: METERED_ESTIMATE };
    const categories = ["Budget", "Credentials"];
    const now = Date.parse("2026-09-04T00:00:00.000Z");
    const check = (record) =>
      validateApproval({ approval: record, task, provider, categories, estimate, agentsById, now });

    assert.equal(check(null).code, REFUSAL.APPROVAL_MISSING);

    // Signed by the implementation lane rather than a human. Checked on KIND,
    // so adding a second human approver is an agents.json change, and this
    // rejection cannot be relaxed by renaming an agent.
    assert.match(check(approval({ grantedBy: "claude-lead" })).detail, /only an agent of kind executive/);
    assert.match(check(approval({ grantedBy: "nobody" })).detail, /unknown approver/);

    assert.match(check(approval({ expiresAt: "2026-09-03T23:59:59.000Z" })).detail, /expired/);
    assert.match(check(approval({ expiresAt: "not a date" })).detail, /no parseable expiresAt/);

    assert.match(check(approval({ categories: ["Budget"] })).detail, /does not cover Credentials/);
    assert.match(check(approval({ scope: { taskIds: ["PL-OTHER"], providerIds: "any" } })).detail, /does not cover task/);
    assert.match(check(approval({ scope: { taskIds: "any", providerIds: ["other"] } })).detail, /does not cover provider/);

    assert.match(check(approval({ budgetCeiling: { currency: "USD", amount: 1 } })).detail, /authorizes 1 USD/);
    assert.match(check(approval({ budgetCeiling: { currency: "EUR", amount: 100 } })).detail, /no usable budgetCeiling/);

    const good = check(approval());
    assert.equal(good.ok, true);
    assert.equal(good.approvalId, "APPROVAL-0001");
  }

  /* -----------------------------------------------------------------------
   * 16. End to end through the planner: a metered dispatch with no approval is
   *     refused, and the identical plan with a valid approval dispatches.
   *
   *     The pair matters more than either half. It proves the approval is the
   *     thing that changed the outcome, not some other condition that happened
   *     to be satisfied.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig();
    const tasks = [fixtureTask("PL-D-0016")];

    const without = only(plan({ tasks, dispatcher }));
    assert.equal(without.decision, REFUSED);
    assert.deepEqual(codes(without), [REFUSAL.APPROVAL_MISSING]);
    assert.equal(without.approvalId, null);

    const withApproval = only(
      plan({ tasks, dispatcher, approvals: new Map([["APPROVAL-0001", approval()]]) })
    );
    assert.equal(withApproval.decision, DISPATCH);
    assert.equal(withApproval.approvalId, "APPROVAL-0001");
    assert.equal(withApproval.estimate.amount, 2);
    assert.equal(withApproval.attempt, 1);
  }

  /* -----------------------------------------------------------------------
   * 17. A provider naming an unregistered runner refuses with
   *     `runner_unavailable` rather than being skipped. A skipped provider
   *     looks identical to a provider that had nothing to do.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({
      providers: [{ id: "openai-responses", agentIds: ["gpt-architect"], runner: "openai-responses", cost: null }]
    });
    const decision = only(plan({ tasks: [fixtureTask("PL-D-0017")], dispatcher }));
    assert.ok(codes(decision).includes(REFUSAL.RUNNER_UNAVAILABLE));
    assert.ok(codes(decision).includes(REFUSAL.COST_UNKNOWN));
    assert.equal(decision.runnerId, "openai-responses");
  }

  /* -----------------------------------------------------------------------
   * 18. No provider routed to the task's preferredAgent, and no preferredAgent
   *     at all, are both `no_provider_configured`.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({
      providers: [{ id: "p", agentIds: ["someone-else"], runner: "free", cost: null }]
    });
    const unrouted = only(plan({ tasks: [fixtureTask("PL-D-0018a")], dispatcher }));
    assert.ok(codes(unrouted).includes(REFUSAL.NO_PROVIDER));

    const agentless = only(
      plan({ tasks: [fixtureTask("PL-D-0018b", { preferredAgent: null })], dispatcher })
    );
    assert.match(agentless.refusals.map((r) => r.detail).join(" "), /names no preferredAgent/);
  }

  /* -----------------------------------------------------------------------
   * 19. The orchestration guard, and the fact it is now ONE rule.
   *
   *     A task that may write .github, scripts, control or the agent bus could
   *     rewrite the reviewer that judges its own work. `**` and `.` reach the
   *     repository root and therefore reach all four -- the case that used to
   *     be invisible because an empty prefix reads as falsy.
   * -------------------------------------------------------------------- */
  scenario();
  {
    assert.deepEqual(touchesOrchestration({ allowedPaths: ["docs/**", "apps/web/src/**"] }), []);
    assert.deepEqual(touchesOrchestration({ allowedPaths: ["scripts/cloud/**"] }), ["scripts/cloud"]);
    assert.deepEqual(touchesOrchestration({ allowedPaths: ["**"] }), ["<repository root>"]);
    assert.deepEqual(touchesOrchestration({ allowedPaths: ["."] }), ["<repository root>"]);
    assert.deepEqual(touchesOrchestration({ allowedPaths: ["coordination/agent-bus/dispatch/**"] }), [
      "coordination/agent-bus/dispatch"
    ]);

    const dispatcher = dispatcherConfig({
      providers: [{ id: "p", agentIds: ["gpt-architect"], runner: "free", cost: null }]
    });
    const decision = only(
      plan({ tasks: [fixtureTask("PL-D-0019", { allowedPaths: ["scripts/**"] })], dispatcher })
    );
    assert.ok(codes(decision).includes(REFUSAL.ORCHESTRATION_SURFACE));
  }

  /* -----------------------------------------------------------------------
   * 20. Two dispatches in one plan may not reserve overlapping allowedPaths.
   *
   *     Advisory, not the boundary: the binding collision rule runs at claim
   *     time in the control plane, and the dispatcher never claims. Being
   *     stricter here costs a deferred task and nothing else.
   * -------------------------------------------------------------------- */
  scenario();
  {
    assert.equal(pathsOverlap(["packages/auth/**"], ["packages/auth/src/**"]), true);
    assert.equal(pathsOverlap(["packages/auth/**"], ["packages/media/**"]), false);
    assert.equal(pathsOverlap(["**"], ["packages/media/**"]), true);

    const dispatcher = dispatcherConfig({
      providers: [{ id: "p", agentIds: ["gpt-architect"], runner: "free", cost: null }]
    });
    const result = plan({
      tasks: [
        fixtureTask("PL-D-0020a", { allowedPaths: ["packages/shared/**"] }),
        fixtureTask("PL-D-0020b", { allowedPaths: ["packages/shared/src/**"] })
      ],
      dispatcher
    });
    assert.equal(result.decisions[0].decision, DISPATCH);
    assert.equal(result.decisions[1].decision, REFUSED);
    assert.ok(codes(result.decisions[1]).includes(REFUSAL.PATH_CONFLICT));
  }

  /* -----------------------------------------------------------------------
   * 21. Retries: deterministic backoff, a hard ceiling, and a cap.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const retries = { maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 30000 };
    assert.deepEqual(retryDecision({ attempts: 0, retries }), { ok: true, attempt: 1, waitMs: 1000 });
    assert.deepEqual(retryDecision({ attempts: 1, retries }), { ok: true, attempt: 2, waitMs: 2000 });
    assert.deepEqual(retryDecision({ attempts: 2, retries }), { ok: true, attempt: 3, waitMs: 4000 });
    assert.equal(retryDecision({ attempts: 3, retries }).code, REFUSAL.RETRIES_EXHAUSTED);

    // Capped, so a large multiplier cannot produce an unbounded wait.
    assert.equal(
      retryDecision({ attempts: 5, retries: { ...retries, maxAttempts: 99, backoffMultiplier: 10 } }).waitMs,
      30000
    );
    // Deterministic: no jitter, so the same input is the same wait every time.
    assert.equal(retryDecision({ attempts: 2, retries }).waitMs, retryDecision({ attempts: 2, retries }).waitMs);
  }

  /* -----------------------------------------------------------------------
   * 22. Retries are counted per (task, provider) and survive across runs.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({
      providers: [{ id: "p", agentIds: ["gpt-architect"], runner: "free", cost: null }]
    });
    const tasks = [fixtureTask("PL-D-0022")];

    const second = only(plan({ tasks, dispatcher, attempts: new Map([["PL-D-0022::p", 1]]) }));
    assert.equal(second.decision, DISPATCH);
    assert.equal(second.attempt, 2);
    assert.equal(second.waitMs, 2000);

    const exhausted = only(plan({ tasks, dispatcher, attempts: new Map([["PL-D-0022::p", 3]]) }));
    assert.equal(exhausted.decision, REFUSED);
    assert.ok(codes(exhausted).includes(REFUSAL.RETRIES_EXHAUSTED));
    assert.equal(exhausted.attempt, null);

    // A different provider has its own budget of attempts.
    const other = only(plan({ tasks, dispatcher, attempts: new Map([["PL-D-0022::other", 3]]) }));
    assert.equal(other.decision, DISPATCH);
  }

  /* -----------------------------------------------------------------------
   * 23. Failure classification, mirroring the reviewer's rule for the same
   *     class of upstream. Unknown shapes are TRANSIENT on purpose: the cost of
   *     being wrong is a bounded retry, not a discarded dispatch.
   * -------------------------------------------------------------------- */
  scenario();
  {
    assert.equal(classifyRunnerFailure(Object.assign(new Error("x"), { permanent: true })), "permanent");
    assert.equal(classifyRunnerFailure(Object.assign(new Error("x"), { status: 429 })), "transient");
    assert.equal(classifyRunnerFailure(Object.assign(new Error("x"), { status: 503 })), "transient");
    assert.equal(classifyRunnerFailure(Object.assign(new Error("x"), { status: 400 })), "permanent");
    assert.equal(classifyRunnerFailure(Object.assign(new Error("x"), { status: 401 })), "permanent");
    assert.equal(classifyRunnerFailure(new Error("ECONNRESET")), "transient");
    // The explicit flag wins over any status inspection.
    assert.equal(
      classifyRunnerFailure(Object.assign(new Error("x"), { permanent: true, status: 500 })),
      "permanent"
    );
  }

  /* -----------------------------------------------------------------------
   * 24. Planning is PURE: it does not mutate its inputs, and two identical
   *     calls produce identical results.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = Object.freeze(dispatcherConfig());
    const tasks = [fixtureTask("PL-D-0024a"), fixtureTask("PL-D-0024b")].map(Object.freeze);
    Object.freeze(tasks);
    const approvals = new Map([["APPROVAL-0001", Object.freeze(approval())]]);

    const first = plan({ tasks, dispatcher, approvals });
    const second = plan({ tasks, dispatcher, approvals });
    assert.deepEqual(first, second, "planDispatch must be deterministic for identical inputs");
    assert.equal(tasks.length, 2, "planDispatch must not mutate the task list");
  }

  /* -----------------------------------------------------------------------
   * 25. Ordering is deterministic: priority first, then task id.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({
      providers: [{ id: "p", agentIds: ["gpt-architect"], runner: "free", cost: null }]
    });
    const result = plan({
      tasks: [
        fixtureTask("PL-D-0025z", { priority: "P2", allowedPaths: ["fixtures/z/**"] }),
        fixtureTask("PL-D-0025b", { priority: "P0", allowedPaths: ["fixtures/b/**"] }),
        fixtureTask("PL-D-0025a", { priority: "P0", allowedPaths: ["fixtures/a/**"] })
      ],
      dispatcher
    });
    assert.deepEqual(result.decisions.map((d) => d.taskId), ["PL-D-0025a", "PL-D-0025b", "PL-D-0025z"]);
  }

  /* -----------------------------------------------------------------------
   * 26. The runner registry: what is real, and what is a declared seam.
   *
   *     `openai-responses` must stay UNREGISTERED. If somebody later adds a
   *     stub under that id, this assertion fails -- which is the point. The
   *     seam is allowed to be empty; it is not allowed to pretend.
   * -------------------------------------------------------------------- */
  scenario();
  {
    assert.deepEqual([...PROVIDER_RUNNERS.keys()], ["agent-bus-handoff"]);
    assert.equal(PROVIDER_RUNNERS.has("openai-responses"), false);

    const runner = PROVIDER_RUNNERS.get("agent-bus-handoff");
    assert.equal(runner.zeroCost, true);
    assert.equal(runner.requiresCredential, false);

    const task = fixtureTask("PL-D-0026");
    const invocation = runner.buildInvocation({
      task,
      agentId: "gpt-architect",
      fromAgent: "claude-lead",
      decision: { attempt: 1 }
    });
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args.slice(0, 10), [
      "scripts/ai-control-plane.mjs",
      "handoff",
      "--from", "claude-lead",
      "--to", "gpt-architect",
      "--type", "task_instruction",
      "--task", "PL-D-0026"
    ]);
    // The message says what it is NOT, so a receiving lane cannot infer that
    // anything was claimed on its behalf.
    assert.match(invocation.args.join(" "), /no claim, no gate and no task transition was recorded/);
    // `task_instruction` is deliberate: it is the one type the bus applies
    // without a task transition. A review_request here would move task state.
    assert.equal(invocation.args.includes("review_request"), false);
  }

  /* -----------------------------------------------------------------------
   * 27. CLI: the plan runs, exits 0, and says it is disarmed.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const repo = freshRepo({ dispatcher: dispatcherConfig({ enabled: false }), tasks: [fixtureTask("PL-D-0027")] });
    const { status, out } = runCli(["--plan", "--root", repo]);
    assert.equal(status, 0, out);
    assert.match(out, /State: DISARMED/);
    assert.match(out, new RegExp(REFUSAL.DISABLED));
    assert.match(out, /never claims a task, records a gate result, or transitions anything/);
  }

  /* -----------------------------------------------------------------------
   * 28. CLI: `--apply` while disarmed writes nothing and is NOT a failure.
   *
   *     Same rule orchestrator-gate.mjs states: a dormant scheduled run is not
   *     an error, and making it one would turn every cron tick red.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({ enabled: false });
    const repo = freshRepo({ dispatcher, tasks: [fixtureTask("PL-D-0028")] });
    const { status, out } = runCli(["--apply", "--as", "claude-lead", "--root", repo]);
    assert.equal(status, 0, out);
    assert.match(out, /disarmed\. Nothing was dispatched and nothing was written/);
    assert.equal(fs.existsSync(path.join(repo, dispatcher.auditLog)), false, "a disarmed run must write no audit log");
  }

  /* -----------------------------------------------------------------------
   * 29. CLI: `--apply` requires `--as`, and refuses an executive identity.
   *
   *     The dispatcher will not choose an identity to publish under. Note this
   *     is a refusal to GUESS, not an authentication check -- the bus does not
   *     authenticate `fromAgent` at all (cooperative-github-writers).
   * -------------------------------------------------------------------- */
  scenario();
  {
    const repo = freshRepo({ dispatcher: dispatcherConfig(), tasks: [fixtureTask("PL-D-0029")] });
    const missing = runCli(["--apply", "--root", repo], { [ENV_VAR]: "1" });
    assert.equal(missing.status, 1);
    assert.match(missing.out, /--apply requires --as/);

    const human = runCli(["--apply", "--as", "human-commander", "--root", repo], { [ENV_VAR]: "1" });
    assert.equal(human.status, 1);
    assert.match(human.out, /is not a non-executive agent/);
  }

  /* -----------------------------------------------------------------------
   * 30. CLI, THE LOAD-BEARING ONE: an armed `--apply` run writes audit records
   *     and leaves `control/tasks.json` BYTE-IDENTICAL.
   *
   *     This is the assertion behind every claim in this module's header that
   *     the dispatcher never claims a task or records a gate. A comment cannot
   *     fail; this can.
   *
   *     The provider here names an unregistered runner, so every decision is a
   *     refusal and no message is published into the fixture. What is being
   *     proven is the write surface, and a refusal exercises exactly the same
   *     one.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig({
      providers: [{ id: "openai-responses", agentIds: ["gpt-architect"], runner: "openai-responses", cost: null }]
    });
    const repo = freshRepo({ dispatcher, tasks: [fixtureTask("PL-D-0030")] });
    const tasksFile = path.join(repo, "control", "tasks.json");
    const before = fs.readFileSync(tasksFile);

    const { status, out } = runCli(["--apply", "--as", "claude-lead", "--root", repo], { [ENV_VAR]: "1" });
    assert.equal(status, 0, out);
    assert.match(out, /State: ARMED/);

    assert.deepEqual(
      fs.readFileSync(tasksFile),
      before,
      "an --apply run must leave control/tasks.json byte-identical: the dispatcher never claims or gates"
    );

    const audit = fs.readFileSync(path.join(repo, dispatcher.auditLog), "utf8").trim().split("\n");
    assert.equal(audit.length, 1);
    const record = JSON.parse(audit[0]);
    assert.equal(record.outcome, "refused");
    assert.equal(record.taskId, "PL-D-0030");
    assert.equal(record.providerId, "openai-responses");
    assert.match(record.id, /^[0-9a-f]{16}$/, "the audit id must be a derived digest, not a random value");
    assert.deepEqual(
      record.refusals.map((r) => r.code).sort(),
      [REFUSAL.COST_UNKNOWN, REFUSAL.RUNNER_UNAVAILABLE].sort()
    );
  }

  /* -----------------------------------------------------------------------
   * 31. CLI: a corrupt audit log refuses the whole run.
   *
   *     An unparseable line UNDERCOUNTS attempts, and an undercounted attempt
   *     log silently widens the retry budget. "More retries" is not an
   *     acceptable failure mode for a corrupt audit trail.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig();
    const repo = freshRepo({ dispatcher, tasks: [fixtureTask("PL-D-0031")] });
    const auditPath = path.join(repo, dispatcher.auditLog);
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.writeFileSync(auditPath, '{"outcome":"dispatched","taskId":"PL-D-0031","providerId":"p"}\nnot json\n');

    const { status, out } = runCli(["--apply", "--as", "claude-lead", "--root", repo], { [ENV_VAR]: "1" });
    assert.equal(status, 1);
    assert.match(out, /is not parseable JSON/);
    assert.match(out, /Refusing to dispatch: the audit log could not be read in full/);
  }

  /* -----------------------------------------------------------------------
   * 32. CLI: an unreadable approval file is not consent.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const dispatcher = dispatcherConfig();
    const repo = freshRepo({ dispatcher, tasks: [fixtureTask("PL-D-0032")] });
    const dir = path.join(repo, dispatcher.approvalsDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "APPROVAL-0001.json"), "{ this is not json");

    const { status, out } = runCli(["--plan", "--root", repo], { [ENV_VAR]: "1" });
    assert.equal(status, 0, out);
    assert.match(out, /1 approval file\(s\) could not be parsed/);
    assert.match(out, new RegExp(REFUSAL.APPROVAL_MISSING));
  }

  /* -----------------------------------------------------------------------
   * 33. CLI: an unreadable LEDGER refuses every metered dispatch, and is
   *     distinguishable from an absent one.
   * -------------------------------------------------------------------- */
  scenario();
  {
    // This fixture's provider carries a cost model and routes to a runner the
    // real registry does not have, so the estimate is METERED and the ledger
    // check is genuinely reached. (It also collects `runner_unavailable`, which
    // is not what this scenario is about and is asserted in scenario 17.)
    const dispatcher = dispatcherConfig();
    const repo = freshRepo({ dispatcher, tasks: [fixtureTask("PL-D-0033")] });

    const absent = runCli(["--plan", "--root", repo], { [ENV_VAR]: "1" });
    assert.equal(absent.status, 0, absent.out);
    assert.equal(
      absent.out.includes(REFUSAL.LEDGER_UNREADABLE),
      false,
      "an absent ledger means nothing has been spent, not that spend is unknown"
    );

    // Present but corrupt: spend is UNKNOWN, and unknown spend refuses.
    const ledgerPath = path.join(repo, dispatcher.budget.ledger);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "{ truncated");
    const corrupt = runCli(["--plan", "--root", repo], { [ENV_VAR]: "1" });
    assert.match(corrupt.out, new RegExp(REFUSAL.LEDGER_UNREADABLE));
    assert.match(corrupt.out, /exists but could not be read or parsed/);
  }

  /* -----------------------------------------------------------------------
   * 34. THE COMMITTED CONFIGURATION REFUSES.
   *
   *     One of the two scenarios that reads live `control/adapters.json`. It
   *     asserts only that the shipped file is OFF and unusable without a
   *     deliberate change -- a property of the file's intent, not of the
   *     backlog, so it does not go stale as the project moves.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const adapterDoc = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "control", "adapters.json"), "utf8")
    );
    const resolved = resolveDispatcherConfig(adapterDoc);
    assert.equal(resolved.ok, true, `the committed dispatcher block must validate:\n${resolved.problems.join("\n")}`);

    const config = resolved.config;
    assert.equal(config.enabled, false, "the committed dispatcher must ship disabled");
    assert.equal(dispatcherIsArmed(config, { [config.enableEnvVar]: "1" }), false, "enabled:false must veto the env var");
    assert.equal(config.budget.perRunCeiling, 0, "no spend may be authorized by the committed file");
    assert.equal(config.budget.perTaskCeiling, 0);

    // The routed provider names a runner this build does not register, so even
    // an operator who flips both switches gets a refusal rather than a call.
    const routed = config.providers.filter((p) => (p.agentIds ?? []).length > 0);
    assert.ok(routed.length > 0, "at least one provider must be routed, or the plan is silently empty");
    for (const provider of routed) {
      assert.equal(
        PROVIDER_RUNNERS.has(provider.runner),
        false,
        `committed provider ${provider.id} routes to registered runner ${provider.runner}; ` +
        "the shipped configuration must not be able to dispatch"
      );
      assert.equal(provider.cost, null, `committed provider ${provider.id} must declare no cost model`);
    }
  }

  /* -----------------------------------------------------------------------
   * 35. The committed configuration does NOT restate the escalation policy.
   *
   *     Two copies of an escalation list is one copy that quietly stops
   *     matching, and the one that would be trusted is whichever the dispatcher
   *     happened to read.
   * -------------------------------------------------------------------- */
  scenario();
  {
    const adapterDoc = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "control", "adapters.json"), "utf8")
    );
    const serialized = JSON.stringify(adapterDoc.dispatcher);
    for (const category of ["IrreversibleProductionChange", "Licensing"]) {
      assert.ok(
        !serialized.includes(category),
        `${category} appears in control/adapters.json; the escalation list belongs only in ` +
        "control/policies.json, and a second copy is a second thing to forget to update"
      );
    }
    // Conversely, policies.json is where they must be, so this assertion cannot
    // pass by both files having lost the list.
    const policies = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "control", "policies.json"), "utf8"));
    for (const category of ["Credentials", "Budget", "Licensing", "IrreversibleProductionChange"]) {
      assert.ok(
        (policies.escalation?.humanOnly ?? []).includes(category),
        `control/policies.json no longer escalates ${category} to a human`
      );
    }
  }

  console.log(`Optional dispatcher tests passed (${scenarios} scenarios).`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
