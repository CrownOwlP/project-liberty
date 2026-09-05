/**
 * The optional autonomous dispatcher's decision core (PL-AI-0003).
 *
 * PURE. No file system, no network, no clock, no environment reads beyond the
 * `env` object the caller hands in. Everything that decides whether a task may
 * be handed to a provider lives here so it can be executed in tests WITHOUT an
 * API key and without a network -- the same reason `review-chunking.mjs` was
 * split out of the GPT reviewer. `agent-dispatcher.mjs` is the I/O shell around
 * this file and contains no policy of its own.
 *
 * ============================================================================
 * WHAT THIS DOES NOT DO, AND WILL NOT BE EXTENDED TO DO
 * ============================================================================
 *
 * It does not claim tasks. It does not start them. It does not record gate
 * results. It does not write `control/tasks.json`, and there is no code path
 * anywhere in this module or its shell that opens that file for writing.
 *
 * That is not a missing feature. A gate result is evidence that a command,
 * review, benchmark or test actually ran, attributed to the agent that ran it.
 * A dispatcher recording one on behalf of a provider it merely SENT WORK TO
 * would be fabricating the single artefact this project's completion rule rests
 * on -- and it would be indistinguishable, in the file, from a real one. The
 * provider records its own gates through the enforced control-plane path, or no
 * gate is recorded.
 *
 * The same argument applies to claiming: `ai:claim` reserves an ownership and a
 * path surface. A dispatcher that claimed on a provider's behalf would create
 * ownership records for work nobody had started, and the release path discards
 * gate results, so the cleanup would be lossy as well as false.
 *
 * ============================================================================
 * FAIL CLOSED, EVERYWHERE
 * ============================================================================
 *
 * Every unknown refuses. Unknown cost refuses. Unreadable ledger refuses.
 * Absent approval refuses. Missing configuration refuses. Unregistered runner
 * refuses.
 *
 * Against the committed `control/adapters.json`, a candidate collects three
 * refusal codes at once -- `dispatcher_disabled`, `runner_unavailable` and
 * `cost_unknown` -- and two further grounds sit behind them, each of which would
 * refuse on its own if the first three were removed: the budget ceilings are
 * zero, and no human approval record exists. That redundancy is deliberate. A
 * single switch is a single mistake.
 */
import {
  // The shared orchestration guard and the shared path arithmetic. Neither is
  // policy of this module's own; both are imported rather than restated because
  // `select-task.mjs` enforces the identical rule, and two copies of a guard is
  // one copy that quietly stops matching.
  touchesOrchestration as touchesOrchestrationSurface,
  pathsOverlap as overlaps
} from "./orchestration-surface.mjs";

/* ---------------------------------------------------------------------------
 * Refusal vocabulary
 *
 * Flat string codes rather than nested structure, for the same reason
 * `packages/auth`'s `ProfileAccessReason` is flat: a refusal code has to be
 * loggable, countable and alertable as one dimension.
 *
 * Every code below is reachable and every one is asserted in
 * `test-dispatcher.mjs`. A `task_not_ready` code was drafted and REMOVED rather
 * than left declared: a non-READY task never becomes a candidate at all, so it
 * produces no decision and nothing could ever carry that code. An unreachable
 * member of a vocabulary is worse than a missing one -- it is a refusal an
 * operator can search the logs for forever.
 * ------------------------------------------------------------------------- */
export const REFUSAL = {
  CONFIG_INVALID: "dispatcher_config_invalid",
  DISABLED: "dispatcher_disabled",
  NO_PROVIDER: "no_provider_configured",
  RUNNER_UNAVAILABLE: "runner_unavailable",
  ORCHESTRATION_SURFACE: "orchestration_paths_require_privileged_lane",
  PATH_CONFLICT: "allowed_paths_conflict",
  COST_UNKNOWN: "cost_unknown",
  LEDGER_UNREADABLE: "ledger_unreadable",
  BUDGET_UNAUTHORIZED: "budget_ceiling_not_set",
  BUDGET_EXHAUSTED: "budget_exhausted",
  APPROVAL_MISSING: "human_approval_missing",
  APPROVAL_INVALID: "human_approval_invalid",
  RETRIES_EXHAUSTED: "retries_exhausted"
};

export const DISPATCH = "dispatch";
export const REFUSED = "refused";

/**
 * Priority ordering, stated here rather than imported.
 *
 * `ai-control-plane.mjs` has its own `priorityRank` and is a CLI module that
 * executes on import, so it cannot be imported. This is a SORT KEY, not a
 * policy: the worst outcome of the two disagreeing is that a plan lists tasks
 * in a different order than `dispatch` would, and since the dispatcher reserves
 * nothing, order costs nothing. Contrast `touchesOrchestration`, which is a
 * guard and was therefore extracted into a shared module rather than copied.
 */
const PRIORITY_ORDER = ["P0", "P1", "P2", "P3"];
function priorityRank(priority) {
  const i = PRIORITY_ORDER.indexOf(String(priority));
  return i < 0 ? PRIORITY_ORDER.length : i;
}

/**
 * Six decimal places, applied to every currency amount before it is compared or
 * stored.
 *
 * Money computed from per-1k-token rates lands on binary fractions that are a
 * fraction of an ulp away from the decimal value, and a budget check is an
 * INEQUALITY: without a declared precision, whether a plan fits its ceiling can
 * depend on the order the entries were summed. Same discipline as
 * `SCORE_PRECISION` in the media engine -- the guarantee is stated AT a
 * precision so it is exact rather than incidental.
 */
export const COST_PRECISION = 6;
export function roundCost(value) {
  const factor = 10 ** COST_PRECISION;
  return Math.round(value * factor) / factor;
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */

/**
 * Validate `control/adapters.json` -> `dispatcher`.
 *
 * Returns problems rather than throwing, and returns ALL of them, because the
 * caller is start-up code and fixing one field per run is a bad way to spend an
 * operator's afternoon. Same shape as `resolveAuthConfig` in `packages/auth`.
 *
 * An ABSENT `dispatcher` block is not an error and not a success: it is
 * `{ ok: false, problems: [...] }` like any other invalid configuration, and
 * the planner refuses everything with CONFIG_INVALID. A repository that has
 * never configured the dispatcher and one that has misconfigured it get the
 * same answer, which is the safe one.
 */
export function resolveDispatcherConfig(adapterDoc) {
  const problems = [];
  const raw = adapterDoc?.dispatcher;

  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: ["dispatcher: control/adapters.json declares no dispatcher block"] };
  }

  if (typeof raw.enabled !== "boolean") problems.push("dispatcher.enabled: must be a boolean");
  if (typeof raw.enableEnvVar !== "string" || !raw.enableEnvVar) {
    problems.push("dispatcher.enableEnvVar: must name the environment variable that arms the dispatcher");
  }

  const budget = raw.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    problems.push("dispatcher.budget: must be an object");
  } else {
    if (typeof budget.currency !== "string" || !budget.currency) {
      problems.push("dispatcher.budget.currency: must be a non-empty currency code");
    }
    if (!isFiniteNonNegative(budget.perRunCeiling)) {
      problems.push("dispatcher.budget.perRunCeiling: must be a finite number >= 0");
    }
    if (!isFiniteNonNegative(budget.perTaskCeiling)) {
      problems.push("dispatcher.budget.perTaskCeiling: must be a finite number >= 0");
    }
    if (typeof budget.ledger !== "string" || !budget.ledger) {
      problems.push("dispatcher.budget.ledger: must be a repository-relative path");
    }
  }

  const retries = raw.retries;
  if (!retries || typeof retries !== "object" || Array.isArray(retries)) {
    problems.push("dispatcher.retries: must be an object");
  } else {
    if (!isPositiveInteger(retries.maxAttempts)) {
      problems.push("dispatcher.retries.maxAttempts: must be an integer >= 1");
    }
    if (!isPositiveInteger(retries.backoffMs)) {
      problems.push("dispatcher.retries.backoffMs: must be an integer > 0");
    }
    if (typeof retries.backoffMultiplier !== "number" || !(retries.backoffMultiplier >= 1)) {
      problems.push("dispatcher.retries.backoffMultiplier: must be a number >= 1");
    }
    if (!isPositiveInteger(retries.maxBackoffMs)) {
      problems.push("dispatcher.retries.maxBackoffMs: must be an integer > 0");
    }
  }

  if (typeof raw.auditLog !== "string" || !raw.auditLog) {
    problems.push("dispatcher.auditLog: must be a repository-relative path");
  }
  if (typeof raw.approvalsDir !== "string" || !raw.approvalsDir) {
    problems.push("dispatcher.approvalsDir: must be a repository-relative path");
  }

  if (!Array.isArray(raw.providers)) {
    problems.push("dispatcher.providers: must be an array");
  } else {
    raw.providers.forEach((provider, index) => {
      const at = `dispatcher.providers[${index}]`;
      if (!provider || typeof provider !== "object") {
        problems.push(`${at}: must be an object`);
        return;
      }
      if (typeof provider.id !== "string" || !provider.id) problems.push(`${at}.id: must be a non-empty string`);
      if (typeof provider.runner !== "string" || !provider.runner) {
        problems.push(`${at}.runner: must name a runner`);
      }
      if (!Array.isArray(provider.agentIds) || provider.agentIds.some((a) => typeof a !== "string" || !a)) {
        problems.push(`${at}.agentIds: must be an array of agent ids`);
      }
      if (provider.cost !== null && (typeof provider.cost !== "object" || Array.isArray(provider.cost))) {
        // `null` is the honest spelling of "no cost model has been established".
        // It is accepted here and refused at estimate time, so the refusal names
        // the dispatch rather than the file.
        problems.push(`${at}.cost: must be an object or null`);
      }
    });
  }

  if (problems.length) return { ok: false, problems: problems.sort() };
  return { ok: true, config: raw, problems: [] };
}

/**
 * Two switches, both of which must be on, neither of which is on by default.
 *
 * `dispatcher.enabled` is committed state: it says the repository has decided
 * this mechanism may exist. The environment variable is runtime state: it says
 * THIS invocation, on THIS machine, was armed by whoever started it. Requiring
 * both means a merged configuration change cannot by itself make a scheduled
 * job start spending money, and an armed environment cannot dispatch in a
 * checkout that never opted in.
 *
 * The comparison is `=== "1"` exactly. "true", "yes", "TRUE" and " 1" are all
 * off. A permissive parse is how a variable set to "false" turns something on.
 */
export function dispatcherIsArmed(config, env) {
  const name = config?.enableEnvVar;
  return config?.enabled === true && typeof name === "string" && env?.[name] === "1";
}

/* ---------------------------------------------------------------------------
 * Cost
 * ------------------------------------------------------------------------- */

/**
 * What one dispatch is expected to cost.
 *
 * Returns `{ known: false, reason }` far more often than it returns a number,
 * and that is the point: a budget that cannot be enforced is not a budget. The
 * cases that refuse:
 *
 *   - the provider declares no cost model (`cost: null`), which is the shipped
 *     default for every metered provider in this repository
 *   - any rate or token estimate is missing, non-finite or negative
 *   - the model's currency differs from the budget's
 *   - the model computes exactly zero. A metered call that costs nothing is a
 *     misconfigured rate table, not a free lunch, and accepting it would let a
 *     zeroed field silently disable the ceiling check below.
 *   - the runner claims to make no metered call AND the provider declares a
 *     cost model. The two statements contradict, and a contradiction resolved
 *     in favour of either side is a guess.
 *
 * The one case that legitimately costs nothing is a runner that makes no
 * metered call at all -- publishing a bus message, for instance. That is
 * reported as `basis: "no_metered_call"`, and `budgetDecision` skips the
 * ceiling and approval requirements only for that basis, never for an amount
 * that merely happens to be zero.
 */
export const NO_METERED_CALL = "no_metered_call";
export const METERED_ESTIMATE = "token_rate_estimate";

export function estimateCost({ provider, runner, budget }) {
  const currency = budget?.currency;
  if (typeof currency !== "string" || !currency) {
    return { known: false, reason: "budget declares no currency" };
  }

  const zeroCostRunner = runner?.zeroCost === true;
  const hasModel = provider?.cost !== null && provider?.cost !== undefined;

  if (zeroCostRunner && hasModel) {
    return {
      known: false,
      reason: `runner ${runner.id} makes no metered call but provider ${provider.id} declares a cost model; the two contradict`
    };
  }
  if (zeroCostRunner) {
    return { known: true, amount: 0, currency, basis: NO_METERED_CALL };
  }
  if (!hasModel) {
    return {
      known: false,
      reason: `provider ${provider?.id ?? "(unnamed)"} declares no cost model, so a dispatch to it cannot be priced`
    };
  }

  const model = provider.cost;
  const fields = ["inputPer1kTokens", "outputPer1kTokens", "estimatedInputTokens", "estimatedOutputTokens"];
  const bad = fields.filter((f) => !isFiniteNonNegative(model[f]));
  if (bad.length) {
    return { known: false, reason: `provider ${provider.id} cost model has invalid ${bad.sort().join(", ")}` };
  }
  if (model.currency !== currency) {
    return {
      known: false,
      reason: `provider ${provider.id} prices in ${String(model.currency)} but the budget is in ${currency}`
    };
  }

  const amount = roundCost(
    (model.estimatedInputTokens / 1000) * model.inputPer1kTokens +
      (model.estimatedOutputTokens / 1000) * model.outputPer1kTokens
  );
  if (!(amount > 0)) {
    return {
      known: false,
      reason: `provider ${provider.id} cost model computes ${amount}; a metered call that prices at zero is a misconfigured rate table`
    };
  }
  return { known: true, amount, currency, basis: METERED_ESTIMATE };
}

/* ---------------------------------------------------------------------------
 * Ledger
 * ------------------------------------------------------------------------- */

/**
 * "The ledger file is there and I could not read it."
 *
 * A Symbol rather than a magic property, because a magic property is a value a
 * malformed ledger could itself carry, and the one thing this marker must not
 * be is forgeable by the document it describes. The shell passes it when a read
 * or a `JSON.parse` throws.
 */
export const UNREADABLE_LEDGER = Symbol("liberty.dispatcher.unreadable-ledger");

/**
 * Spend already committed, from the ledger document.
 *
 * `null` means the file does not exist, which is a real and correct initial
 * state: nothing has been spent. That is DISTINCT from a file that exists and
 * cannot be parsed, which means spend is UNKNOWN, and unknown spend refuses.
 * Collapsing the two -- treating an unreadable ledger as zero -- would make
 * corrupting one file the way to reset the budget.
 */
export function ledgerSpend(ledger, budget) {
  if (ledger === UNREADABLE_LEDGER) {
    return { known: false, reason: "the ledger file exists but could not be read or parsed" };
  }
  if (ledger === null || ledger === undefined) {
    return { known: true, amount: 0, entries: 0, basis: "no ledger recorded yet" };
  }
  if (typeof ledger !== "object" || Array.isArray(ledger)) {
    return { known: false, reason: "ledger is not an object" };
  }
  if (ledger.currency !== budget?.currency) {
    return {
      known: false,
      reason: `ledger is denominated in ${String(ledger.currency)} but the budget is in ${String(budget?.currency)}`
    };
  }
  if (!Array.isArray(ledger.entries)) {
    return { known: false, reason: "ledger.entries is not an array" };
  }
  let total = 0;
  for (const [index, entry] of ledger.entries.entries()) {
    if (!entry || typeof entry !== "object" || !isFiniteNonNegative(entry.amount)) {
      return { known: false, reason: `ledger.entries[${index}].amount is not a finite number >= 0` };
    }
    total += entry.amount;
  }
  return { known: true, amount: roundCost(total), entries: ledger.entries.length, basis: "sum of ledger entries" };
}

/* ---------------------------------------------------------------------------
 * Budget
 * ------------------------------------------------------------------------- */

/**
 * Does this dispatch fit?
 *
 * `alreadyPlanned` is the cost of dispatches already selected in THIS plan.
 * Without it, a wave of ten tasks each individually under the run ceiling would
 * collectively blow through it, and the ledger would not learn about that until
 * after the money was gone.
 */
export function budgetDecision({ estimate, spend, budget, alreadyPlanned = 0 }) {
  if (!estimate.known) {
    return { ok: false, code: REFUSAL.COST_UNKNOWN, detail: estimate.reason };
  }
  if (estimate.basis === NO_METERED_CALL) {
    // No metered call, no spend, nothing for a ceiling to bound. Note the check
    // is on the BASIS, not on `amount === 0`: see estimateCost.
    return { ok: true, charged: 0 };
  }
  if (!spend.known) {
    return { ok: false, code: REFUSAL.LEDGER_UNREADABLE, detail: spend.reason };
  }
  if (!(budget.perTaskCeiling > 0) || !(budget.perRunCeiling > 0)) {
    return {
      ok: false,
      code: REFUSAL.BUDGET_UNAUTHORIZED,
      detail:
        `budget ceilings are perTask=${budget.perTaskCeiling} perRun=${budget.perRunCeiling}; ` +
        "a zero ceiling is the shipped default and means no spend has been authorized"
    };
  }
  if (estimate.amount > budget.perTaskCeiling) {
    return {
      ok: false,
      code: REFUSAL.BUDGET_EXHAUSTED,
      detail: `estimated ${estimate.amount} ${estimate.currency} exceeds perTaskCeiling ${budget.perTaskCeiling}`
    };
  }
  const projected = roundCost(spend.amount + alreadyPlanned + estimate.amount);
  if (projected > budget.perRunCeiling) {
    return {
      ok: false,
      code: REFUSAL.BUDGET_EXHAUSTED,
      detail:
        `ledger ${spend.amount} + planned ${roundCost(alreadyPlanned)} + this ${estimate.amount} = ${projected} ` +
        `${estimate.currency}, over perRunCeiling ${budget.perRunCeiling}`
    };
  }
  return { ok: true, charged: estimate.amount, projected };
}

/* ---------------------------------------------------------------------------
 * Human approval
 * ------------------------------------------------------------------------- */

/**
 * Which human-only escalation categories this dispatch triggers.
 *
 * Read from `control/policies.json` -> `escalation.humanOnly`, never restated
 * here. Duplicating that list into `adapters.json` was the obvious design and
 * was rejected: two copies of an escalation policy is one copy that quietly
 * stops matching, and the one that would be trusted is whichever the dispatcher
 * happened to read.
 *
 * Three sources of a trigger:
 *   Budget       any dispatch that will actually be charged
 *   Credentials  any runner that declares it needs one
 *   task-level   `task.escalation`, an array the task itself may declare
 *
 * `task.escalation` is an EXTENSION POINT and is currently declared by no task
 * in `control/tasks.json`. It is honoured rather than invented for later so the
 * mechanism is one field away from use; it is named here as unexercised in
 * production data rather than presented as an existing control.
 *
 * A triggered category that is not in `humanOnly` needs no approval, which is
 * what makes this read the policy instead of hard-coding four strings.
 */
export function requiredApprovalCategories({ estimate, runner, task, policies }) {
  const humanOnly = new Set(policies?.escalation?.humanOnly ?? []);
  const triggered = new Set();

  if (estimate.known && estimate.basis !== NO_METERED_CALL && estimate.amount > 0) triggered.add("Budget");
  if (runner?.requiresCredential === true) triggered.add("Credentials");
  for (const category of task?.escalation ?? []) triggered.add(String(category));

  return [...triggered].filter((c) => humanOnly.has(c)).sort();
}

/**
 * Is there a valid human approval covering this dispatch?
 *
 * THE DISPATCHER NEVER WRITES ONE. This module has no function that produces an
 * approval record and `agent-dispatcher.mjs` has no code path that writes into
 * the approvals directory. An approval is a human act, recorded by a human, and
 * a program that could mint its own consent is not gated by consent at all.
 *
 * `grantedBy` must resolve to an agent whose `kind` is `executive` in
 * `control/agents.json` -- the same field `agentExecutable` in the control plane
 * uses to refuse execution to the human lane. Checking the KIND rather than the
 * literal id `human-commander` means adding a second approver is an
 * `agents.json` change rather than a code change, and means an approval signed
 * by `claude-lead` is rejected structurally rather than by a name comparison
 * somebody might later relax.
 */
export function validateApproval({ approval, task, provider, categories, estimate, agentsById, now }) {
  if (!approval) {
    return {
      ok: false,
      code: REFUSAL.APPROVAL_MISSING,
      detail: `no human approval covers ${categories.join(", ")} for ${task.id}`
    };
  }
  const bad = (detail) => ({ ok: false, code: REFUSAL.APPROVAL_INVALID, detail });

  const approver = agentsById.get(approval.grantedBy);
  if (!approver) return bad(`approval ${approval.approvalId} names unknown approver ${String(approval.grantedBy)}`);
  if (approver.kind !== "executive") {
    return bad(
      `approval ${approval.approvalId} was granted by ${approver.id} (kind ${approver.kind}); ` +
      "only an agent of kind executive may authorize a human-only category"
    );
  }

  const expires = Date.parse(String(approval.expiresAt));
  if (!Number.isFinite(expires)) return bad(`approval ${approval.approvalId} has no parseable expiresAt`);
  if (expires <= now) {
    return bad(`approval ${approval.approvalId} expired at ${approval.expiresAt}`);
  }

  const granted = new Set(Array.isArray(approval.categories) ? approval.categories : []);
  const uncovered = categories.filter((c) => !granted.has(c));
  if (uncovered.length) {
    return bad(`approval ${approval.approvalId} does not cover ${uncovered.join(", ")}`);
  }

  const scope = approval.scope ?? {};
  const covers = (list, value) => list === "any" || (Array.isArray(list) && list.includes(value));
  if (!covers(scope.taskIds, task.id)) {
    return bad(`approval ${approval.approvalId} does not cover task ${task.id}`);
  }
  if (!covers(scope.providerIds, provider.id)) {
    return bad(`approval ${approval.approvalId} does not cover provider ${provider.id}`);
  }

  if (categories.includes("Budget")) {
    const ceiling = approval.budgetCeiling;
    if (!ceiling || ceiling.currency !== estimate.currency || !isFiniteNonNegative(ceiling.amount)) {
      return bad(`approval ${approval.approvalId} has no usable budgetCeiling in ${estimate.currency}`);
    }
    if (estimate.amount > ceiling.amount) {
      return bad(
        `approval ${approval.approvalId} authorizes ${ceiling.amount} ${ceiling.currency}, ` +
        `below the estimated ${estimate.amount}`
      );
    }
  }

  return { ok: true, approvalId: approval.approvalId };
}

/* ---------------------------------------------------------------------------
 * Retries
 * ------------------------------------------------------------------------- */

/**
 * Whether another attempt is allowed, and how long to wait first.
 *
 * DETERMINISTIC, with no jitter. `gpt-review-worker.mjs` jitters its backoff and
 * is right to: it is smoothing concurrent retries against one upstream inside a
 * single run. This is a different question -- how many times has this task been
 * handed to this provider ACROSS runs -- and its answer is recorded in the audit
 * log and asserted in tests, so a random component would buy nothing and cost
 * reproducibility.
 *
 * `attempts` is the count of prior attempts read from the audit log, so the
 * ceiling survives a process restart. A counter held in memory would reset the
 * budget for failures every time the scheduler fired.
 */
export function retryDecision({ attempts, retries }) {
  if (attempts >= retries.maxAttempts) {
    return {
      ok: false,
      code: REFUSAL.RETRIES_EXHAUSTED,
      detail: `${attempts} attempt(s) already recorded; maxAttempts is ${retries.maxAttempts}`
    };
  }
  const waitMs = Math.min(
    Math.round(retries.backoffMs * retries.backoffMultiplier ** attempts),
    retries.maxBackoffMs
  );
  return { ok: true, attempt: attempts + 1, waitMs };
}

/**
 * Is a runner failure worth retrying?
 *
 * Mirrors the classification `gpt-review-worker.mjs` already applies to OpenAI
 * responses, because the two are answering the same question about the same
 * class of upstream. An explicit `permanent` flag wins over any status
 * inspection, so a runner that knows its own failure is final can say so.
 *
 * Unknown shapes are TRANSIENT. That is the one place this module does not fail
 * closed, and the direction is deliberate: the failure here is retrying
 * something hopeless a bounded number of times, which `maxAttempts` already
 * caps, against permanently discarding a dispatch that a network blip broke.
 */
export function classifyRunnerFailure(error) {
  if (error?.permanent === true) return "permanent";
  const status = error?.status;
  if (typeof status === "number") {
    if (status === 429 || status >= 500) return "transient";
    if (status >= 400) return "permanent";
  }
  return "transient";
}

/* ---------------------------------------------------------------------------
 * The plan
 * ------------------------------------------------------------------------- */

function providerFor(config, agentId) {
  return (config.providers ?? []).find((p) => (p.agentIds ?? []).includes(agentId)) ?? null;
}

/**
 * Which agent would this task go to?
 *
 * `preferredAgent` only. The dispatcher deliberately does not run the control
 * plane's capability-and-capacity wave search: that search exists to pick a
 * LOCAL executor, and this dispatcher's entire subject is the external lanes
 * the local wave explicitly excludes. Following the task's own stated routing
 * hint is both simpler and the thing an operator can predict from the file.
 */
function targetAgentFor(task) {
  return task?.preferredAgent ?? null;
}

/**
 * Build the dispatch plan.
 *
 * Pure and total: every task in `tasks` that is a candidate produces exactly one
 * decision, and a decision always carries the complete list of reasons it was
 * refused rather than only the first. A partial answer here would make an
 * operator fix one refusal per run, which is the same complaint
 * `resolveAuthConfig` records.
 *
 * @param {object} args
 * @param {object[]} args.tasks       control/tasks.json -> tasks
 * @param {object[]} args.agents      control/agents.json -> agents
 * @param {object}   args.policies    control/policies.json
 * @param {object}   args.adapterDoc  control/adapters.json
 * @param {object}   args.env         environment, for the arming variable
 * @param {object|null} args.ledger   parsed budget ledger, or null if absent
 * @param {Map}      args.approvals   approvalId -> approval record
 * @param {Map}      args.runners     runner id -> runner descriptor
 * @param {Map}      args.attempts    `${taskId}::${providerId}` -> prior attempt count
 * @param {number}   args.now         epoch millis, injected so this stays pure
 */
export function planDispatch({
  tasks = [],
  agents = [],
  policies = {},
  adapterDoc = {},
  env = {},
  ledger = null,
  approvals = new Map(),
  runners = new Map(),
  attempts = new Map(),
  now = 0
}) {
  const resolved = resolveDispatcherConfig(adapterDoc);
  if (!resolved.ok) {
    return {
      armed: false,
      configProblems: resolved.problems,
      decisions: [],
      totals: { dispatch: 0, refused: 0, plannedCost: 0, currency: null },
      summary: `dispatcher configuration is invalid (${REFUSAL.CONFIG_INVALID}); nothing can be dispatched`
    };
  }
  const config = resolved.config;
  const armed = dispatcherIsArmed(config, env);
  const budget = config.budget;
  const spend = ledgerSpend(ledger, budget);
  const agentsById = new Map(agents.map((a) => [a.id, a]));

  // Only READY tasks are candidates. BACKLOG has unmet dependencies, an active
  // status already has an owner, and BLOCKED is blocked -- in this repository
  // usually on a human or a licence, which is exactly what must not be
  // dispatched around.
  const candidates = [...tasks]
    .filter((t) => t?.status === "READY")
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || String(a.id).localeCompare(String(b.id)));

  const decisions = [];
  const selected = [];
  let plannedCost = 0;

  for (const task of candidates) {
    const refusals = [];
    const agentId = targetAgentFor(task);
    const provider = agentId ? providerFor(config, agentId) : null;
    const runner = provider ? runners.get(provider.runner) ?? null : null;

    if (!armed) {
      refusals.push({
        code: REFUSAL.DISABLED,
        detail:
          `dispatcher.enabled=${config.enabled} and ${config.enableEnvVar}=` +
          `${env?.[config.enableEnvVar] === undefined ? "(unset)" : JSON.stringify(env[config.enableEnvVar])}; ` +
          "both the committed switch and the runtime switch must be on"
      });
    }
    if (!agentId) {
      refusals.push({ code: REFUSAL.NO_PROVIDER, detail: `${task.id} names no preferredAgent` });
    } else if (!provider) {
      refusals.push({
        code: REFUSAL.NO_PROVIDER,
        detail: `no dispatcher provider is configured for agent ${agentId}`
      });
    } else if (!runner) {
      refusals.push({
        code: REFUSAL.RUNNER_UNAVAILABLE,
        detail:
          `provider ${provider.id} names runner "${provider.runner}", which is not registered in this build; ` +
          "no dispatch can be performed through it"
      });
    }

    const orchestration = touchesOrchestrationSurface(task);
    if (orchestration.length) {
      refusals.push({
        code: REFUSAL.ORCHESTRATION_SURFACE,
        detail:
          `${task.id} may write orchestration paths (${orchestration.join(", ")}); ` +
          "autonomy over the machinery that supervises autonomy requires the privileged review-before-main lane"
      });
    }

    const clash = selected.find((s) => overlaps(task.allowedPaths, s.task.allowedPaths));
    if (clash) {
      refusals.push({
        code: REFUSAL.PATH_CONFLICT,
        detail: `allowedPaths overlap ${clash.task.id}, already selected in this plan`
      });
    }

    const estimate = provider
      ? estimateCost({ provider, runner, budget })
      : { known: false, reason: "no provider" };

    let budgetResult = { ok: false, code: REFUSAL.COST_UNKNOWN, detail: "no provider" };
    if (provider) {
      budgetResult = budgetDecision({ estimate, spend, budget, alreadyPlanned: plannedCost });
      if (!budgetResult.ok) refusals.push({ code: budgetResult.code, detail: budgetResult.detail });
    }

    let approvalId = null;
    if (provider && estimate.known) {
      const categories = requiredApprovalCategories({ estimate, runner, task, policies });
      if (categories.length) {
        const approval = findApproval(approvals, { task, provider, categories });
        const verdict = validateApproval({
          approval, task, provider, categories, estimate, agentsById, now
        });
        if (!verdict.ok) refusals.push({ code: verdict.code, detail: verdict.detail });
        else approvalId = verdict.approvalId;
      }
    }

    const key = `${task.id}::${provider?.id ?? "-"}`;
    const retry = retryDecision({ attempts: attempts.get(key) ?? 0, retries: config.retries });
    if (!retry.ok) refusals.push({ code: retry.code, detail: retry.detail });

    const decision = {
      taskId: task.id,
      agentId,
      providerId: provider?.id ?? null,
      runnerId: provider?.runner ?? null,
      decision: refusals.length ? REFUSED : DISPATCH,
      refusals: refusals.sort((a, b) => a.code.localeCompare(b.code)),
      estimate,
      attempt: retry.ok ? retry.attempt : null,
      waitMs: retry.ok ? retry.waitMs : null,
      approvalId
    };
    decisions.push(decision);

    if (decision.decision === DISPATCH) {
      selected.push({ task, decision });
      plannedCost = roundCost(plannedCost + (budgetResult.charged ?? 0));
    }
  }

  const dispatchCount = decisions.filter((d) => d.decision === DISPATCH).length;
  return {
    armed,
    configProblems: [],
    decisions,
    totals: {
      dispatch: dispatchCount,
      refused: decisions.length - dispatchCount,
      plannedCost,
      currency: budget.currency
    },
    summary: armed
      ? `${dispatchCount} dispatchable, ${decisions.length - dispatchCount} refused, ` +
        `${plannedCost} ${budget.currency} planned against ledger ${spend.known ? spend.amount : "unknown"}`
      : "dispatcher is DISARMED; the plan below is what it would refuse or allow if it were armed"
  };
}

/**
 * The first approval that covers this dispatch.
 *
 * Deterministic: approvals are considered in sorted id order, so two equally
 * applicable records always yield the same choice. Coverage is checked
 * cheaply here and then re-checked in full by `validateApproval`, which is the
 * function that decides -- this only picks the candidate to judge, so a
 * near-miss cannot silently substitute for an exact match.
 */
function findApproval(approvals, { task, provider, categories }) {
  const covers = (list, value) => list === "any" || (Array.isArray(list) && list.includes(value));
  const ids = [...approvals.keys()].sort();
  for (const id of ids) {
    const approval = approvals.get(id);
    const scope = approval?.scope ?? {};
    if (!covers(scope.taskIds, task.id)) continue;
    if (!covers(scope.providerIds, provider.id)) continue;
    const granted = new Set(Array.isArray(approval?.categories) ? approval.categories : []);
    if (categories.some((c) => !granted.has(c))) continue;
    return approval;
  }
  // Fall back to the first by id so the refusal names a concrete record's
  // defect where one exists, rather than reporting "missing" for an approval
  // the operator can see in the directory.
  return ids.length ? approvals.get(ids[0]) : null;
}
