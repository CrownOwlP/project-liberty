/**
 * Provider runners for the optional dispatcher (PL-AI-0003).
 *
 * A registry, not a switch statement, so "is there a runner for this provider"
 * is a lookup that can FAIL -- and failing is the common case. A provider
 * configured against a runner id this build does not register is refused with
 * `runner_unavailable` rather than silently skipped, because a skipped provider
 * looks identical to a provider that had nothing to do.
 *
 * SEPARATE FROM `agent-dispatcher.mjs` FOR ONE REASON: that file is a CLI and
 * executes on import, so nothing could test what is in here. The same split as
 * `review-chunking.mjs`, made for the same reason -- the pieces that decide what
 * gets sent must be executable without a key, a network, or a process.
 *
 * ============================================================================
 * WHAT IS ACTUALLY HERE, STATED PLAINLY
 * ============================================================================
 *
 *   agent-bus-handoff  REAL. Needs no credential and no network beyond the file
 *                      system. It publishes a `task_instruction` on the agent
 *                      bus through `ai-control-plane.mjs handoff`, which is how
 *                      the shared-repository lane (`gpt-architect`) is reached
 *                      today. It is informational by design: the bus README
 *                      records that `task_instruction` is acknowledged and
 *                      changes no task state. So "dispatched" here means "the
 *                      work was offered to that lane", never "assigned".
 *
 *                      Its `buildInvocation` is pure and is asserted in
 *                      `test-dispatcher.mjs`. Its `run` shells out, and that
 *                      call is NOT exercised by the suite -- publishing a real
 *                      message would write into a repository. Read the argv
 *                      assertion as covering what would be sent, not as
 *                      evidence that a message has ever been published this way.
 *
 *   openai-responses   NOT REGISTERED, and `control/adapters.json` routes the
 *                      openai provider at it deliberately, so the default plan
 *                      shows a live `runner_unavailable` refusal rather than an
 *                      empty section. A model-calling runner cannot be written
 *                      honestly here without a key to exercise it, and this
 *                      repository already has exactly one audited OpenAI caller:
 *                      `gpt-review-worker.mjs`, with its own retry policy,
 *                      prompt-injection instructions and structured-output
 *                      schema. An untested second copy of all three would be the
 *                      worse outcome. The seam is the deliverable; the call is
 *                      not built.
 */
import { execFileSync } from "node:child_process";

export const PROVIDER_RUNNERS = new Map([
  [
    "agent-bus-handoff",
    {
      id: "agent-bus-handoff",
      /** Publishes a file. No metered upstream call, so the cost is 0 by construction. */
      zeroCost: true,
      requiresCredential: false,
      describe: () =>
        "publishes a task_instruction on the agent bus (informational; changes no task state)",

      /**
       * Pure. Returns the argv this runner would execute, so a test can assert
       * the exact command without running it.
       */
      buildInvocation({ task, agentId, fromAgent, decision }) {
        return {
          // The running Node, not the string "node": the workflows pin a version
          // through `.nvmrc` and setup-node, and shelling out to whatever `node`
          // happens to be first on PATH is how a pinned toolchain stops being
          // pinned.
          command: process.execPath,
          args: [
            "scripts/ai-control-plane.mjs",
            "handoff",
            "--from", fromAgent,
            "--to", agentId,
            "--type", "task_instruction",
            "--task", task.id,
            "--summary",
            `Dispatched by agent-dispatcher: ${task.id} (${task.priority}/${task.lane}) ${task.title}`.slice(0, 900),
            // Evidence states what this message is and is not. A lane reading it
            // must not infer that anything was claimed on its behalf.
            "--evidence", `dispatcher=agent-bus-handoff attempt=${decision.attempt}`,
            "--evidence", "informational handoff; no claim, no gate and no task transition was recorded",
            "--evidence", `allowedPaths=${JSON.stringify(task.allowedPaths ?? [])}`.slice(0, 500)
          ]
        };
      },

      run(invocation, { root }) {
        return execFileSync(invocation.command, invocation.args, { cwd: root, encoding: "utf8" });
      }
    }
  ]
]);
