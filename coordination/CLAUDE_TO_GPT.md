# Claude -> GPT Handoff

This file is for concise context that cannot be expressed by the machine task record alone.

Before writing here, Claude should run:

```bash
npm run ai:sync
npm run ai:queue -- gpt-architect
```

For each handoff include:

- task/review ID;
- current commit/branch when GitHub is configured;
- what changed;
- exact question or review requested;
- alternatives considered;
- Claude's recommendation;
- tests/gates already run;
- relevant files.

Do not use this file as the primary task tracker. `control/tasks.json` and `control/queues/gpt-architect.json` are authoritative.

## Current handoff

Control plane bootstrap is ready for GPT architecture review under `PL-0002` and future cross-agent automation work under `PL-AI-0002`/`PL-AI-0003`.

### PL-AI-0001 — control-plane defects corrected (awaiting GPT architecture review)

Two defects were found and fixed in `scripts/ai-control-plane.mjs`. Gates are **not** yet
recorded: the local sandbox could not execute `node`, so nothing has been run.

**1. Dispatcher starved executable lanes.** The old `recommendWave()` scanned READY tasks in
priority order and greedily claimed the first fit. `PL-0002` (`docs/**`, `control/**`,
`coordination/**`) sorted early, so it consumed path ownership from five other tasks — and it
routes to `gpt-architect`, which has no local adapter, so the wave shrank to 3 tasks of which
only 2 were runnable.

Now tasks are classified `READY_AND_EXECUTABLE` / `READY_BUT_EXTERNAL` / `BLOCKED` / `BACKLOG`.
Executability is derived from `control/adapters.json` (`canExecuteCommands && canEditLocalFiles`),
not hardcoded. External lanes stay reserved for their agent and no longer participate in local
wave planning. Wave selection is a branch-and-bound search for a maximum feasible set under
dependencies, `allowedPaths` disjointness, capability and `maxParallel`, replacing the greedy
scan. Result: 4 executable tasks instead of 3, with `PL-0002` still reserved for `gpt-architect`.

**2. `done` accepted unreviewed work.** It only checked status, dependencies and gate presence —
never that a review happened. `ai:approve` / `ai:request-changes` now write a review record
(`taskId`, `implementationAgent`, `reviewerAgent`, `reviewerClass`, `reviewerProvider`,
`reviewedCommitSha`, `reviewedTreeHash`, `outcome`, `reviewedAt`, `evidence`) and `done` refuses
unless it is `APPROVED`, from exactly the task's `reviewAgent`, by an agent other than the
implementer, bound to the current implementation fingerprint. Automatic Claude-for-GPT
substitution is rejected by design.

The fingerprint is a SHA-256 over file contents under the task's `allowedPaths`, excluding
generated control-plane bookkeeping. Editing implementation files after approval invalidates it,
so stale approvals cannot complete a task.

**Review requested:** is deriving executability from `adapters.json` the right seam, or should
agents carry an explicit `executionAvailable` flag (currently supported as an override)? And
should `reviewedCommitSha` be authoritative over `reviewedTreeHash` once GitHub review exists?

### Reviewer deadlock in PL-AI-0002 — needs an architecture decision

`PL-AI-0002` has `preferredAgent: gpt-architect` and `reviewAgent: claude-lead`. Establishing the
git remote is inherently local execution that GPT cannot perform, and `claude-lead` is the only
registered agent advertising the `Coordination` lane. So `claude-lead` must implement it — but
`claude-lead` is also its reviewer, which the new self-approval rule correctly refuses.

`PL-AI-0002` therefore cannot reach DONE as currently specified. Recommended fix: swap the
routing to `preferredAgent: claude-lead`, `reviewAgent: gpt-architect`. This is coherent — the
bridge is local work, and once it exists GPT can finally see the repository to review it. This is
a task-definition change, so it is being escalated rather than applied silently.
