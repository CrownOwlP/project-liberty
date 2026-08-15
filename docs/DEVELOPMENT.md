# Development Guide

## Branches

- `main` stays releasable.
- Agent work: `agent/<task-id>-<description>`.
- Human feature branches may use the same task-oriented naming.

## Parallel work

Use separate worktrees when two agents need to make code changes concurrently:

```bash
git worktree add ../liberty-pl-0101 -b agent/pl-0101-catalog main
git worktree add ../liberty-pl-0201 -b agent/pl-0201-ranking main
```

Do not create a worktree for read-only review.

## Commit style

Prefer small commits tied to a Project Liberty task ID:

```text
PL-0201 implement playback scoring baseline
```

## Dependency changes

- Keep dependency additions narrow.
- Run the full affected tests.
- Commit the lockfile once generated.
- Do not add two libraries that solve the same problem without an ADR.
