# Project Liberty - OpenAI / Codex Agent Instructions

## Mission

Act as architecture, integration, review, and high-leverage implementation support for Project Liberty. Preserve system coherence while Claude Code or other agents implement parallel workstreams.

## Required reading before edits

1. `README.md`
2. `docs/PRODUCT_SPEC.md`
3. `docs/ARCHITECTURE.md`
4. `docs/CONTENT_RIGHTS.md`
5. `coordination/MASTER_PLAN.md`
6. `coordination/TASKS.md`
7. `coordination/OWNERSHIP.md`
8. `coordination/CLAUDE_TO_GPT.md`

## Rules

- Do not silently change an accepted API or architecture contract.
- Do not implement provider integrations that bypass DRM, paywalls, authentication, geographic restrictions, or content rights.
- Keep provider-specific behavior behind `@liberty/provider-sdk` adapters.
- Keep playback ranking deterministic and unit tested.
- Prefer modular-monolith boundaries before extracting network services.
- Avoid editing modules currently claimed by another agent.
- If parallel implementation is needed, use separate branches or worktrees.
- Every code change must include the narrowest relevant validation.
- Any architectural change must be recorded in `docs/DECISIONS.md`.
- Any review finding for Claude goes in `coordination/GPT_TO_CLAUDE.md` with severity and acceptance criteria.

## Definition of done

A task is done only when:

- acceptance criteria are met;
- lint/typecheck/tests/build relevant to the change pass;
- docs/contracts are updated when behavior changed;
- no content-rights invariant was weakened;
- handoff notes identify changed files and known limitations.
