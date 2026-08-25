# AI Engineering Control Plane

This directory is the machine-readable operating system for the engineering team. It is intentionally model-agnostic and can be copied into future repositories.

## Source of truth

- `project.json` - project identity and operating principles.
- `tasks.json` - dependency graph, ownership, status, allowed write paths, reviewers, and quality gates.
- `agents.json` - available agent roles and capabilities.
- `quality-gates.json` - named validation gates.
- `policies.json` - status machine, completion rules, parallelism, and escalation policy.
- `adapters.json` - how local Claude, OpenAI/shared-repo workflows, and human approvals connect.
- `events.jsonl` - append-only audit trail.
- `queues/` - generated per-agent queues; do not treat these as source of truth.

## Commands

Run from repository root:

```bash
npm run ai:validate
npm run ai:status
npm run ai:ready
npm run ai:dispatch
npm run ai:dispatch -- --apply
npm run ai:queue -- claude-media
npm run ai:claim -- PL-0201 claude-media
npm run ai:start -- PL-0201 claude-media
npm run ai:review -- PL-0201 claude-media
npm run ai:gate -- PL-0201 unit pass "vitest green"
npm run ai:gate -- PL-0201 unit pass --agent claude-media "vitest green"
npm run ai:done -- PL-0201
npm run ai:block -- PL-0302 "Awaiting licensed provider credentials"
npm run ai:release -- PL-0201 claude-media
npm run ai:sync
```

`ai:dispatch` recommends a conflict-free wave. `--apply` claims the recommended tasks but does not invoke external models by itself.

## Gate results

A gate result is evidence about work performed against a task, so the control
plane only accepts one while the task is `IN_PROGRESS` or `REVIEW` and has an
owner. `READY`, `BACKLOG`, `CLAIMED`, `BLOCKED`, `DONE` and `CANCELED` are all
refused.

- `IN_PROGRESS` is the normal case: claim, start, then record.
- `REVIEW` is permitted because a reviewer re-runs checks, and because the
  deterministic completion path (`scripts/cloud/advance-completable.mjs`) records
  every gate for an approved task that is still in `REVIEW`.
- `CLAIMED` is refused: a claim reserves a task, it does not open it. `ai:dispatch
  --apply` claims whole waves at once, and a claimed-but-unstarted task has no
  `implementationBaseSha` to bind evidence to.
- `DONE` is refused: gate results are the completion evidence, and editing them
  afterwards would leave no transition in `events.jsonl` to notice.

Each result records `by` (the owner the control plane granted) and the `commitSha`
it was recorded at. `commitSha` is provenance, not yet an enforced staleness
check.

## Path declarations, and why the root is refused

Two path surfaces exist and are deliberately not one:

| surface | field | decides |
| --- | --- | --- |
| write / collision / staging | `allowedPaths` | what an implementer may edit |
| reviewed / fingerprinted | `allowedPaths` + `reviewDependencies` | what an approval binds to |

`reviewDependencies` is read-only. It reserves nothing, so two tasks with
disjoint `allowedPaths` and the same declared dependency stay concurrently
claimable — the bottleneck the field exists to remove.

Both fields are reduced to their longest literal prefix, and an entry that
reduces to the repository root is an **error**, not a warning. `"**"`, `"*"`,
`"/"` and `"/**"` reduce to the empty string and used to be dropped; `"."` and
`"./"` reduce to `"."` and used to be hashed as the whole tree while every path
still classified as outside the review surface. Either way the declaration and
the enforced surface disagreed, and the operator was told only that the entry
"protects nothing".

The rule is: **a declared path may never make the enforced surface narrower than
what was declared.** A declaration that cannot be turned into a usable prefix is
refused rather than dropped. `validate` reports it against the field, and
`scripts/review-surface.mjs` throws at the point of use for anything that reached
a fingerprint without being validated first.

Breadth is not the offence. `packages/**` reduces to `packages` and is an
ordinary, legal, wide declaration.

## Ownership assertions

`start`, `review`, `release` and `gate --agent` all take an optional agent id.
None of them authenticate — nothing in a local CLI can. They exist so a caller
that is wrong about who owns a task is refused loudly rather than silently
mutating another agent's lane.

## Returning a task to a queue

`ai:release` and `ai:unblock` null the owner and put the task back in
`READY`/`BACKLOG`. Both discard `gateResults`, because evidence is bound to one
implementation round under one owner; leaving it behind would let the next
claimant inherit passes for work that no longer exists. `ai:done` also nulls the
owner but keeps the results — there they are the completion record.

## Reuse in a new project

From this repository:

```bash
node scripts/bootstrap-ai-project.mjs --target ../new-project --name "New Project" --prefix NP
```

This installs a fresh control-plane skeleton and CLI into another repository. The new project then defines its own tasks, agents, gates, and policies.
