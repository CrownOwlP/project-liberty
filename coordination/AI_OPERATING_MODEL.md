# AI Engineering Operating Model

Project Liberty is the first workload for a reusable AI engineering system. The system is designed to maximize useful concurrency without turning the repository into a merge-conflict queue.

## Command hierarchy

- **Human commander:** goals, licensing, credentials, budget, irreversible production decisions.
- **Control plane:** task graph, dependencies, claims, status, path ownership, quality evidence, queues, audit trail.
- **GPT/OpenAI lane:** architecture, decomposition, difficult reasoning, review, research, integration design, high-leverage implementation when repository access is available.
- **Claude Code Desktop lane:** local execution, implementation, terminal-driven validation, agent-team coordination, debugging, integration.
- **Specialist agents:** frontend, backend, media, tests, security, infrastructure, and future domain specialists.
- **CI:** independent quality gate, never a substitute for local validation.

## No fixed ceiling on either AI

GPT and Claude are not artificially restricted to "architect" versus "coder" roles. Tasks are routed by capability, locality, dependency state, and conflict risk. Either system may design, implement, review, test, or debug when it is the strongest available executor.

The one hard distinction is environmental: Claude Code Desktop can directly operate the local `D:\project-liberty` worktree. ChatGPT cannot see that local drive unless the work is shared through GitHub or another supported bridge.

## Flow

1. Goals become machine-readable tasks.
2. Dependencies determine READY work.
3. Dispatcher chooses a conflict-free wave and best available agents.
4. Agents claim tasks before editing.
5. Work moves through CLAIMED -> IN_PROGRESS -> REVIEW.
6. Required gates record evidence.
7. Reviewer approves or sends the task back to IN_PROGRESS.
8. DONE unlocks dependent work automatically.
9. Status and queues regenerate from the source of truth.
10. Only true executive decisions escalate to the human commander.

## Sources of truth

- Machine task state: `control/tasks.json`
- Agent registry: `control/agents.json`
- Policy/state machine: `control/policies.json`
- Quality gates: `control/quality-gates.json`
- Audit trail: `control/events.jsonl`
- Human status view: `coordination/PROJECT_STATUS.md`
- Human task view: `coordination/TASKS.md`

Do not edit generated status/task views to change state.
