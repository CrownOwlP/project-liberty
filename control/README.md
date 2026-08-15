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
npm run ai:review -- PL-0201
npm run ai:gate -- PL-0201 unit pass "vitest green"
npm run ai:done -- PL-0201
npm run ai:block -- PL-0302 "Awaiting licensed provider credentials"
npm run ai:sync
```

`ai:dispatch` recommends a conflict-free wave. `--apply` claims the recommended tasks but does not invoke external models by itself.

## Reuse in a new project

From this repository:

```bash
node scripts/bootstrap-ai-project.mjs --target ../new-project --name "New Project" --prefix NP
```

This installs a fresh control-plane skeleton and CLI into another repository. The new project then defines its own tasks, agents, gates, and policies.
