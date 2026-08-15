# Ownership and Collision Rules

| Lane | Primary paths | Parallel-write rule |
| --- | --- | --- |
| Frontend | `apps/web/src/app`, `apps/web/src/components` | One writer per route/component subtree |
| Backend | backend route handlers/application services | Coordinate with frontend before changing response shapes |
| Media | `packages/media-engine` | Exclusive writer during scoring/policy tasks |
| Provider | `packages/provider-sdk`, provider adapters | Exclusive writer per provider adapter |
| Contracts | `packages/contracts` | Treat as shared lock; contract owner changes first |
| Infra | `.github`, `infra`, root build files | Avoid concurrent dependency/config edits |
| Docs/architecture | `docs`, `coordination` | Merge frequently; avoid overwriting handoff history |

## Claim format

Before code edits, add a row to `coordination/IN_PROGRESS.md`:

`TASK | AGENT | BRANCH/WORKTREE | PATHS | STARTED`

Agents may work in parallel only when their claimed paths do not overlap or when they explicitly coordinate a contract change.
