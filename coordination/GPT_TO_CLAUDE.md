# GPT -> Claude Handoff

This file holds implementation/review context from GPT that does not fit a task's machine-readable fields.

Claude must check the relevant task in `control/tasks.json` before acting. Never treat prose here as permission to bypass task ownership, dependencies, allowed paths, or quality gates.

For review findings, include severity, evidence, files, requested change, and acceptance criteria.

## Current direction

Operate through the AI control plane. Prefer `npm run ai:dispatch` for the next safe work wave, claim tasks through the CLI, record gate evidence, and keep unrelated lanes moving when an external review is pending.
