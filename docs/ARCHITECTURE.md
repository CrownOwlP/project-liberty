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

Pure/deterministic policies for candidate rejection, compatibility, ranking, failover attempt scheduling, and later audio/subtitle selection. It must not fetch arbitrary URLs itself.

**One scheduling policy, and it now runs in the browser too.** `apps/web/src/components/player/playback-machine.ts` imports `scheduleAttempts` from this package and calls it on every failover, in the client. `planFailover` — the server-side entry point that ranks and then schedules — calls the same function. There is one implementation of the attempt policy and both entry points are wired to it.

That is a correction rather than a convenience. The player used to reimplement the scheduling policy in its own guards; both copies carried a comment asserting they agreed, and they did not. The player tried a retry before a fresh candidate, so with `maxAttempts: 4` and three candidates two of them could eat the budget two attempts apiece while the third authorized stream was never loaded once — and the breadth-before-depth fix had already landed in this package, where real playback never read it. A policy two components claim to share is not shared; a policy one of them calls is.

The split between `planFailover` and `scheduleAttempts` is what makes the sharing possible. `scheduleAttempts` takes an already-ordered list of candidate ids and **never reorders it**, so the client can call it: the player holds a candidate list the session already ranked and no `PlaybackCapabilities` to rank with, and a client-side re-rank would be a second opinion about preference that could disagree with the ranking the session published — after which the reason trail would explain a choice nobody made, and there would be no way to tell which ranking was authoritative. Ranking stays where the capabilities are; scheduling is shared.

Stated because the paragraph above invites the opposite assumption: `planFailover` currently has **no caller outside tests**. `POST /api/v1/playback/session` ranks with `rankStreamCandidates` and publishes a `failoverPolicy` for the client to schedule against; nothing on the server plans a failover today. So the shared-policy guarantee is real but presently one-sided — the browser is the live caller, and `planFailover` is the tested-but-dormant server half.

The consequence: this package's purity is now a bundle constraint as well as a testability one. Anything added here that a client cannot run — a Node built-in, a fetch, a secret — breaks the player, not only the server. (`@liberty/contracts` and `@liberty/observability` are also reached from client components, so this constraint is not unique to the media engine; `@liberty/provider-sdk` is not, and must not become so.)

Purity is necessary but not sufficient, so the two layers are now two **files**. `src/scheduling.ts` holds `scheduleAttempts` and the failure-kind policy and has no path to `./ranking`; `src/failover.ts` holds `planFailover`, keeps its `rankStreamCandidates` import, and re-exports the whole of `scheduling.ts` so no existing import path changed. The player imports `@liberty/media-engine/scheduling`, a subpath the package now publishes, rather than the barrel — the barrel re-exports `ranking`, `scoring`, `audio` and `subtitles`, and `failover.ts` value-imports `./ranking` for `planFailover` alone, so before the split a viewer downloaded the ranking and scoring engine to answer a question decided entirely from ids, failure kinds and a budget. `"sideEffects": false` is declared on the package (true of every module in it: all seven — `index`, `ranking`, `scoring`, `audio`, `subtitles`, `scheduling`, `failover` — are declaration-only, and the one module-scope call sorts a fresh spread copy) so a bundler may drop what the subpath does not reach.

Still outstanding: `scheduling.ts` value-imports `PLAYBACK_FAILURE_KINDS` from `@liberty/contracts/domains/failover`, whose first line is `import { z } from "zod"` and which builds its schemas at module scope, so **zod still reaches the player bundle**. The fix is a zod-free constant module inside `@liberty/contracts` that both the schema and the engine read; deriving the kinds from the engine's own policy table instead would type-check but would invert the stated invariant that membership is a schema fact and precedence is a product decision.

### `@liberty/observability`

Structured logging/tracing boundary. It must avoid sensitive data by default.

### `@liberty/web`

User experience plus thin HTTP route handlers. Route handlers validate input and call application/domain logic rather than embedding provider behavior.

## Desktop target and the `PlayerAdapter` boundary

The first production target is **Windows desktop**, and it is a shell around this application rather
than a second application. `docs/DESKTOP_PLAYBACK.md` is the record: the decisions, the evidence each
one rests on, the strongest argument against each, and the facts that would reverse each. This
section is the part of it the rest of the architecture has to know.

```text
Tauri v2 shell (Rust)  ──►  child HWND: libmpv, vo=gpu-next, gpu-context=d3d11
        │                          ▲
        │  WebView2 (DefaultBackgroundColor A=0, composited above)
        │      │
        │      └── the existing Next.js app, unchanged, served by a Next
        │          `output: 'standalone'` sidecar on loopback
        │
        └── PlayerAdapter ── WebPlayerAdapter (Shaka/EME, also the desktop DRM path)
                          └─ NativePlayerAdapter (libmpv)
```

**The application is preserved, not rewritten.** A static export would delete route handlers,
`proxy.ts`, `cookies()`, `headers()`, Server Actions and ISR; a standalone sidecar keeps all of them,
at the cost of a Node runtime, a loopback listener, supervision code we write ourselves, and Tauri's
CSP injection no longer reaching our pages.

**The shell choice is decided by compositing and by nothing else.** Putting HTML chrome over a
hardware-accelerated native video surface in one window on Windows is documented and shipping on
WebView2 and has no supported path on Chromium. Any size-based argument for Tauri is void: with a
Node sidecar the installer lands near Electron's.

**`PlayerAdapter` is the boundary the application and domain layers depend on**, not a concrete
player. No `shaka-player`, `mpv`/`libmpv`, `@tauri-apps/*` or `electron` type is reachable from it —
no `any`, no engine-handle passthrough, no opaque engine-configuration bag. Two implementations sit
behind it, and **capability routing between them is an explicit, reasoned decision taken before
playback**: `canPlay` returns a reason on both branches. mpv has no CDM and cannot be given one, so
the native adapter **refuses** a DRM-protected candidate with a named reason and never attempts it,
never falls back and never degrades. That is what makes invariant 2 structural here rather than
promised, and the named refusal is what satisfies invariant 4.

**The existing XState machine in `apps/web/src/components/player/playback-machine.ts` remains the
single source of playback truth.** The native adapter translates mpv's properties and events into the
machine's existing events; it does not become a second state machine. Candidate ranking stays in
`@liberty/media-engine`, provider-specific behavior stays in `@liberty/provider-sdk`, and media
addresses continue to come only from authorized provider resolution and the playback-session
boundary — the adapter has no method that accepts a URL.

**Provider resolution does not run on the user's machine, and that is a ruling rather than a
preference.** A sidecar runs this application's server on a machine the user administers, so
resolution running there would put the boundary enforcing invariants 1 and 2 in files the user can
read and replace, with provider credentials in its environment. The commander ruled on 2026-09-16
that the desktop build **proxies the provider-resolution and playback-session routes
(`/api/v1/playback/*`) to an authenticated backend service**, preserving the same application-facing
contract: same route, same URL, same request and response shape, same `docs/API_CONTRACTS.md`
behaviour, with the implementation selected **by build target and never by runtime configuration** —
a flag that could flip resolution back on-device is the same exposure with an extra step.

The proxy forwards an authenticated caller identity and **never receives a provider credential**, so
the sidecar holds no provider secret at all. That is what keeps invariants 1 and 2 enforceable on a
machine the user administers rather than merely asserted there, and it is what makes the desktop
build's loopback listener a session-isolation control rather than the last line in front of a
provider relationship. `docs/DESKTOP_PLAYBACK.md` §8 records the ruling, its cost, and the
alternatives it rejected. **PL-0501 builds `/api/v1/playback/session` with a target-selected
implementation from the start.**

Three contract gaps this decision exposed are tracked as their own tasks: **PL-0902** (DRM capability
on the candidate or session contract — `packages/contracts/src` carries no `drm` field today, and it
gates the capability routing above), **PL-0903** (an engine-unavailable reason that can represent
libmpv failing to load), and **PL-0904** (a playback error origin for native failures, so mpv errors
are not forced into Shaka's numeric codes).

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
- A playback engine is reached only through `PlayerAdapter`, and no engine type is reachable from it.
- Which engine plays a candidate is decided before playback, with a reason recorded on both branches.
- Cross-module changes update contracts/docs first or in the same commit.
