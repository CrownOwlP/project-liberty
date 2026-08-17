# Project Liberty Task Board

> Generated from `control/tasks.json`. Do not edit status here; use `npm run ai:*` commands.

Statuses: `BACKLOG`, `READY`, `CLAIMED`, `IN_PROGRESS`, `REVIEW`, `BLOCKED`, `DONE`, `CANCELED`.

| ID | Priority | Lane | Status | Owner | Review | Task | Acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PL-0001 | P0 | Infra | DONE | - | APPROVED by gpt-architect | Generate and commit dependency lockfile | npm install and full npm run check are green; CI uses npm ci once lockfile exists |
| PL-0002 | P0 | Architecture | IN_PROGRESS | claude-lead | - | Review scaffold contracts | No unresolved contradiction across product, architecture, API, security, and content-rights contracts |
| PL-0003 | P0 | Infra | READY | - | - | Environment validation | Missing required environment is reported clearly; local PostgreSQL and Redis health are documented |
| PL-0101 | P0 | Frontend | DONE | - | APPROVED by gpt-architect | Catalog home data contract | Home route consumes typed catalog response and handles loading, error, and empty states |
| PL-0102 | P0 | Frontend | READY | - | - | Search experience | Debounced accessible search with typed results and URL-addressable query |
| PL-0103 | P0 | Frontend | READY | - | - | Title details | Movie, series, and episode details with play CTA using normalized IDs |
| PL-0201 | P0 | Media | DONE | - | APPROVED by gpt-architect | Expand candidate score model | Score dimensions are documented, deterministic, explainable, and regression-tested |
| PL-0202 | P0 | Media | REVIEW | claude-media | - | Audio selection policy | Preferred language, codec, channels, and fallback reasons are deterministic and tested |
| PL-0203 | P0 | Media | READY | - | - | Subtitle selection policy | Preferred language, forced, default, and off policies are explicit and tested |
| PL-0204 | P0 | Media | READY | - | - | Candidate failover policy | Retry and fallback behavior is bounded, deterministic, observable, and testable |
| PL-0301 | P0 | Provider | READY | - | - | Authorized fixture provider | Server-side fixture adapter returns normalized authorized candidates only |
| PL-0302 | P0 | Provider | BLOCKED | - | - | First production provider | Licensed provider integrated through provider SDK with credentials isolated server-side |
| PL-0401 | P0 | Backend | READY | - | - | Auth integration decision | ADR selects auth approach and defines protected profile boundary |
| PL-0402 | P0 | Backend | BACKLOG | - | - | Profile model | Profiles can be created and selected with authorization tests |
| PL-0403 | P0 | Backend | BACKLOG | - | - | Progress persistence | Idempotent progress write/read and resume contract with authorization |
| PL-0501 | P0 | Player | BACKLOG | - | - | Playback session API | Server resolves authorized provider candidates; clients cannot submit arbitrary media URLs |
| PL-0502 | P0 | Player | BACKLOG | - | - | Player state machine | Loading, ready, stalled, recoverable error, failover, and fatal error states are explicit |
| PL-0701 | P0 | Test | BACKLOG | - | - | Critical E2E harness | Catalog to title to player to progress fixture journey is reproducible in CI |
| PL-0702 | P0 | Security | BACKLOG | - | - | Provider and URL security review | SSRF, secret exposure, redirect, allowlist, and rights-bypass findings are resolved or explicitly accepted |
| PL-AI-0001 | P0 | Coordination | DONE | - | APPROVED by gpt-architect | Operationalize AI control plane in Claude Code Desktop | Claude Code uses machine-readable queues, claims tasks through the CLI, syncs status, and records handoffs rather than manually drifting task state |
| PL-0303 | P1 | Provider | BACKLOG | - | - | Provider health contract | Health sample shape, freshness, failure classes, and cache semantics are defined |
| PL-0404 | P1 | Backend | BACKLOG | - | - | Watchlist persistence | Typed add, remove, and list APIs with authorization |
| PL-0503 | P1 | Player | BACKLOG | - | - | Playback telemetry | Startup, rebuffer, quality switch, and failure events are observable with privacy redaction |
| PL-0504 | P1 | Player | BACKLOG | - | - | A/V sync telemetry and recovery experiment | Drift measurement contract, thresholds, and bounded recovery experiment are implemented |
| PL-0601 | P1 | Live | READY | - | - | Channel and EPG contracts | Licensed channel, program, schedule, and EPG contracts are typed and documented |
| PL-0602 | P1 | Live | BLOCKED | - | - | Live provider integration | Licensed live provider integrated with normalized channel/EPG contracts |
| PL-0801 | P1 | Recommendations | BACKLOG | - | - | Recommendation boundary | Explainable initial recommendation contract using catalog and history signals with privacy constraints |
| PL-AI-0002 | P1 | Coordination | READY | - | - | GitHub bridge for cross-agent review | GitHub becomes the shared state bridge for Claude Desktop and OpenAI review without manual file copying |
| PL-AI-0003 | P1 | Coordination | BACKLOG | - | - | Optional API-driven autonomous dispatcher | Optional external agent runner can dispatch queued tasks to configured providers with budgets, audit logs, retries, and human approval gates |
