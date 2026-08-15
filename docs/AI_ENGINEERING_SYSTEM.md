# Reusable AI Engineering System

The repository contains a project-agnostic control plane that can be reused for future software projects.

## What it provides

- machine-readable task/dependency graph;
- explicit task state machine;
- capability-based agent registry;
- safe write-path ownership;
- automatic readiness calculation;
- conflict-free dispatch recommendations;
- per-agent generated queues;
- review routing;
- explicit quality-gate evidence;
- append-only event/audit log;
- generated human-readable project status;
- bootstrap script for new repositories.

## Why this is faster than simply spawning more agents

Parallel agents only improve throughput when tasks are dependency-independent and their write surfaces do not collide. The dispatcher therefore optimizes for **safe concurrency**, not raw agent count. That keeps implementation lanes productive while reducing merge conflicts and duplicated work.

## Provider independence

`control/agents.json` can register Claude Code agents, OpenAI/Codex agents, human specialists, or other future executors. The control plane does not require one model to own a permanent role.

## Reuse

From the Project Liberty repository:

```bash
node scripts/bootstrap-ai-project.mjs --target ../new-project --name "New Project" --prefix NP
```

This creates the control state, CLI, queues, and generated-status placeholders in the target repository. Then define project-specific tasks and agent capabilities.

## Automation boundary

The control plane can automatically compute readiness, claims, queues, conflicts, status, and quality evidence. Directly invoking an external hosted model still requires an adapter/runtime with credentials and permissions. Claude Code Desktop can orchestrate its local subagents directly; ChatGPT/OpenAI work can be routed through a shared GitHub repository today and can later be automated through an API-driven agent runner.
