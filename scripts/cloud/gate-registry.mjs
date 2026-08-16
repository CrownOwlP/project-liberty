/**
 * The single definition of how a quality gate is classified and executed.
 *
 * There used to be two: `run-gates.mjs` carried an EXECUTORS table and
 * `advance-completable.mjs` carried a RUNNABLE table. They drifted --
 * run-gates could execute `integration`, advance-completable could not, and its
 * fallback treated "no executor" as "no automated evidence available". So an
 * implementation could pass its integration gate at finalize time, receive an
 * independent approval, and then be permanently refused completion by the very
 * worker meant to complete it. Every task carrying a gate one runner knows and
 * the other does not would strand in REVIEW forever.
 *
 * Two tables encoding the same policy will always drift eventually. This module
 * is the one both import, so adding an executor adds it everywhere at once and
 * a gate that is unimplemented is unimplemented consistently.
 *
 * Classification rules, in order:
 *   1. Not in control/quality-gates.json  -> `undefined`     (fail closed)
 *   2. command === "agent-review"         -> `review`        (reviewer's job)
 *   3. No executor implemented here       -> `unimplemented` (fail closed)
 *   4. Otherwise                          -> `executable`
 *
 * Rule 3 is the one that matters. Gate TYPE comes from the registry file, never
 * from absence here: treating "I have no executor" as "this must be a review
 * gate" silently relabels an unimplemented executable gate as somebody else's
 * problem, which is how a task with real integration or performance
 * requirements would appear to pass without those ever running.
 */
import { execFileSync } from "node:child_process";

/** A gate whose registry command is exactly this is the reviewer's to satisfy. */
export const REVIEW_COMMAND = "agent-review";

/**
 * Gates this repository can actually prove by running something.
 *
 * Keyed by gate NAME rather than by registry command, because the name is what
 * a task lists in `qualityGates` and is what both callers iterate over.
 */
export const GATE_EXECUTORS = {
  "repo-validate": { command: "node", args: ["scripts/validate-repo.mjs"] },
  lint: { command: "npm", args: ["run", "lint"] },
  typecheck: { command: "npm", args: ["run", "typecheck"] },
  unit: { command: "npm", args: ["run", "test"] },
  build: { command: "npm", args: ["run", "build"] },
  integration: { command: "npm", args: ["run", "test", "--", "--runInBand"] }
};

export function executorLabel(executor) {
  return [executor.command, ...executor.args].join(" ");
}

/**
 * `node` must be the interpreter already running, not whatever `node` resolves
 * to on PATH -- the workflow pins a version via .nvmrc and a gate executed
 * under a different runtime is not evidence about the pinned one. On Windows
 * npm is a shim that execFile cannot invoke without its extension.
 */
export function resolveBinary(command) {
  if (command === "node") return process.execPath;
  if (command === "npm" && process.platform === "win32") return "npm.cmd";
  return command;
}

/**
 * @param {string} gate           gate name as it appears in a task's qualityGates
 * @param {object} registry       parsed `control/quality-gates.json` .gates
 * @returns {{kind: "undefined"|"review"|"unimplemented"|"executable", gate: string,
 *            definition?: object, executor?: object, reason: string}}
 */
export function classifyGate(gate, registry) {
  const definition = registry?.[gate];

  if (!definition) {
    return {
      kind: "undefined",
      gate,
      reason: `"${gate}" is not defined in control/quality-gates.json, so it cannot be classified`
    };
  }

  if (definition.command === REVIEW_COMMAND) {
    return {
      kind: "review",
      gate,
      definition,
      reason: `"${gate}" is an ${REVIEW_COMMAND} gate, satisfied by the independent reviewer`
    };
  }

  const executor = GATE_EXECUTORS[gate];
  if (!executor) {
    return {
      kind: "unimplemented",
      gate,
      definition,
      reason:
        `"${gate}" is defined as "${definition.command}" but no executor is implemented in ` +
        "scripts/cloud/gate-registry.mjs. Blocking rather than misreporting it as a review gate."
    };
  }

  return {
    kind: "executable",
    gate,
    definition,
    executor,
    reason: `"${gate}" runs ${executorLabel(executor)}`
  };
}

/**
 * Runs the gate and reports what happened. Never consults a previously recorded
 * result: a pre-existing "pass" is exactly what an untrusted writer would leave
 * behind, so it is never accepted as evidence for skipping the run.
 *
 * @returns {{passed: boolean, label: string, evidence: string}}
 */
export function runExecutableGate(executor, { cwd = process.cwd(), source = "gate runner" } = {}) {
  const label = executorLabel(executor);
  try {
    execFileSync(resolveBinary(executor.command), executor.args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe"
    });
    return { passed: true, label, evidence: `${label} exit 0 (${source})` };
  } catch (error) {
    return {
      passed: false,
      label,
      evidence: `${label} exit ${error.status ?? "non-zero"} (${source})`
    };
  }
}
