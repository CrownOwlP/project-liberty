# Architecture

## Strategy

Start as a modular TypeScript monorepo and only extract network services when load, deployment isolation, or ownership requires it. This keeps iteration fast while enforcing clean boundaries agents can work on independently.

## Logical layers

```text
Next.js web / route handlers
        |
application orchestration
        |
shared contracts + domain policies
        |
provider SDK ---- media engine ---- observability
        |
PostgreSQL / Redis / authorized provider APIs
```

## Packages

### `@liberty/contracts`

Stable transport/domain shapes. Contract changes should be intentional and reviewed.

### `@liberty/provider-sdk`

The only boundary through which content-provider-specific behavior enters core application logic. Adapters must return normalized, authorized candidates.

### `@liberty/media-engine`

Pure/deterministic policies for candidate rejection, compatibility, ranking, and later audio/subtitle selection. It must not fetch arbitrary URLs itself.

### `@liberty/observability`

Structured logging/tracing boundary. It must avoid sensitive data by default.

### `@liberty/web`

User experience plus thin HTTP route handlers. Route handlers validate input and call application/domain logic rather than embedding provider behavior.

## Scalability path

Extract only when justified:

- provider-health worker;
- metadata ingestion worker;
- recommendation service;
- live EPG ingest;
- playback telemetry pipeline.

Do not prematurely distribute the system. A modular monolith keeps local development and AI-agent coordination much faster.

## Critical invariants

- Rights authorization is checked before playback ranking.
- Provider credentials never reach clients.
- Untrusted provider URLs are never fetched by unrestricted generic server code.
- Playback policy is deterministic given the same inputs.
- Every playback failure has a machine-readable reason.
- Cross-module changes update contracts/docs first or in the same commit.
