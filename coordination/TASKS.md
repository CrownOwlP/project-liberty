# Project Liberty Task Board

Statuses: `READY`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`, `DONE`.

| ID | Priority | Lane | Status | Task | Acceptance |
| --- | --- | --- | --- | --- | --- |
| PL-0001 | P0 | Infra | READY | Generate/commit dependency lockfile | `npm install` + full `npm run check` green; CI uses `npm ci` |
| PL-0002 | P0 | Architecture | READY | Review scaffold contracts | No unresolved contradiction across product/architecture/API/rights docs |
| PL-0003 | P0 | Infra | READY | Environment validation | Missing required env is reported clearly; local postgres/redis health documented |
| PL-0101 | P0 | Frontend | READY | Catalog home data contract | Home route consumes typed catalog response; loading/error/empty states |
| PL-0102 | P0 | Frontend | READY | Search experience | Debounced accessible search; typed results; URL-addressable query |
| PL-0103 | P0 | Frontend | READY | Title details | Movie/series/episode details and play CTA using normalized IDs |
| PL-0201 | P0 | Media | READY | Expand candidate score model | Score dimensions documented and regression-tested |
| PL-0202 | P0 | Media | READY | Audio selection policy | Preferred language, codec, channels, fallback reason tests |
| PL-0203 | P0 | Media | READY | Subtitle selection policy | Preferred language, forced/default/off policy and tests |
| PL-0204 | P0 | Media | READY | Candidate failover policy | Retry/fallback decision is bounded and testable |
| PL-0301 | P0 | Provider | READY | Authorized fixture provider | Server-side provider adapter returns normalized authorized candidates |
| PL-0302 | P0 | Provider | BLOCKED | First production provider | Needs confirmed licensed API/provider and credentials |
| PL-0303 | P1 | Provider | READY | Provider health contract | Health sample shape and cache semantics defined |
| PL-0401 | P0 | Backend | READY | Auth integration decision | ADR plus protected profile boundary |
| PL-0402 | P0 | Backend | READY | Profile model | Create/select profile with authorization tests |
| PL-0403 | P0 | Backend | READY | Progress persistence | Idempotent write/read + resume contract |
| PL-0404 | P1 | Backend | READY | Watchlist persistence | Typed add/remove/list APIs with authorization |
| PL-0501 | P0 | Player | READY | Playback session API | Server resolves provider candidates; clients cannot submit arbitrary URLs |
| PL-0502 | P0 | Player | READY | Player state machine | Loading, ready, stalled, recoverable error, fatal error states |
| PL-0503 | P1 | Player | READY | Playback telemetry | Startup/rebuffer/failure events with privacy redaction |
| PL-0504 | P1 | Player | READY | A/V sync telemetry | Drift measurement contract and recovery threshold experiment |
| PL-0601 | P1 | Live | READY | Channel/EPG contracts | Licensed channel and EPG typed contracts |
| PL-0602 | P1 | Live | BLOCKED | Live provider integration | Needs licensed feed/provider access |
| PL-0701 | P0 | Test | READY | Critical E2E harness | Catalog -> title -> player -> progress fixture journey |
| PL-0702 | P0 | Security | READY | Provider/URL security review | SSRF/secrets/rights bypass findings resolved or documented |
| PL-0801 | P1 | Recommendations | READY | Recommendation boundary | Explainable initial ranking contract using catalog/history signals |
