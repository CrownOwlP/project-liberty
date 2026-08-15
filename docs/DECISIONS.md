# Architecture Decisions

## ADR-001 - Modular monorepo first

**Status:** Accepted

Use Next.js plus shared TypeScript packages in one Turborepo. Extract services only when scale or deployment boundaries require it.

**Reason:** Maximum iteration speed, simple local development, and clean parallel ownership for AI agents.

## ADR-002 - Provider adapter boundary

**Status:** Accepted

Provider-specific catalog/playback behavior must live behind `@liberty/provider-sdk`.

**Reason:** Prevent provider quirks and credentials from leaking through the product and media engine.

## ADR-003 - Deterministic playback ranking

**Status:** Accepted

Candidate ranking is a pure deterministic policy with a reason trail.

**Reason:** Reproducible tests and diagnosable playback behavior.

## ADR-005 - Weighted, decomposable candidate score model

**Status:** Accepted (PL-0201)

Candidate scoring is a sum of independently weighted dimensions rather than a single opaque
formula. Each dimension normalizes to `[0, 1]` and contributes `raw * weight`, so the total is
always reconstructible from its parts.

| Dimension | Weight | Meaning |
| --- | ---: | --- |
| `resolution` | 40 | rendition height against the client ceiling |
| `health` | 30 | provider health sample |
| `bitrateEfficiency` | 12 | distance from a target bitrate for that height |
| `codecEfficiency` | 10 | compression efficiency at equal perceptual quality |
| `protocolAdaptivity` | 8 | adaptive (HLS/DASH) vs progressive delivery |
| `latency` | -15 | estimated startup latency penalty |

Positive weights sum to 100; `latency` is the only penalty. Both are asserted in tests, so a
future weight change cannot silently unbalance the model.

**Reason:** A single expression could not answer "why was this stream chosen?" — the reason trail
required by the playback invariants. Decomposition also makes each dimension independently
regression-testable for monotonicity.

**Notes:**

- `bitrateEfficiency` is a *distance* from target, not a maximum. Over-provisioned streams waste
  bandwidth and raise rebuffer risk, so they are penalised like under-provisioned ones.
- Determinism is a hard requirement: no clocks, randomness, I/O, or ambient state. Ties break on
  candidate id so results never depend on input ordering.

## ADR-006 - Rights checked before scoring, via allowlist

**Status:** Accepted (PL-0201)

`PLAYABLE_RIGHTS` is an explicit allowlist (`licensed`, `owned`, `public-domain`) evaluated as the
first eligibility check, before any technical property. A candidate with unplayable rights is never
scored, ranked, or surfaced.

**Reason:** Enforces the product invariant that only licensed, user-owned, or public-domain content
enters playback resolution. An allowlist fails closed: any rights value added later is non-playable
until explicitly reviewed, whereas a denylist would silently admit it.

## ADR-004 - PostgreSQL source of truth, Redis optional

**Status:** Proposed

Use PostgreSQL for durable state and Redis only for ephemeral/cached workloads. Final ORM choice is deferred to the persistence task.
