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

## ADR-004 - PostgreSQL source of truth, Redis optional

**Status:** Proposed

Use PostgreSQL for durable state and Redis only for ephemeral/cached workloads. Final ORM choice is deferred to the persistence task.
