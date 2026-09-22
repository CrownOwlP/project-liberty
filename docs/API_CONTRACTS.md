# API Contracts

All JSON APIs live under `/api/v1` except health checks.

## `GET /api/health`

Response:

```json
{
  "status": "ok",
  "service": "project-liberty-web",
  "timestamp": "2026-03-04T09:15:00.000Z"
}
```

## `POST /api/v1/playback/session`

Purpose: issue a playback session for an already-identified title, or explain why not.

Implemented in `apps/web/src/app/api/v1/playback/session/` — `contract.ts` (schemas
and constructors), `issue-session.ts` (the decision), `handler.ts` (the HTTP half)
and `route.ts` (the Next entry point). The wire schemas live in that directory
rather than in `@liberty/contracts`; `contract.ts` records why and lists the move
as follow-up, so the paragraph at the end of this document about defining schemas
in `@liberty/contracts` first is not yet satisfied for this route.

Request:

```json
{
  "contentId": "aurora-fall",
  "capabilities": {
    "maxHeight": 2160,
    "supportedVideoCodecs": ["h264", "hevc"],
    "supportedAudioCodecs": ["aac", "eac3"],
    "preferredAudioLanguages": ["en"]
  }
}
```

Those are the only two fields, and the schema is `.strict()` at both levels.
**There is no field through which a client can name a media URL**, and an
unrecognised key is refused rather than stripped — zod's default is to drop
unknown keys, which would hand a client a perfectly successful session while
silently discarding the field it believed in. `contentId` is
`normalizedContentIdSchema`, so a path traversal, an absolute URL or a
provider-native id fails the schema before any resolver, adapter or URL parser
sees it. `capabilities` is `playbackCapabilitiesSchema` — the same shape
`/playback/resolve` takes, including the optional-with-no-default
`maxAudioChannels`, but `.strict()` here where that route leaves it open.

The server resolves candidates itself, through an injectable
`AuthorizedCandidateResolver` (`authorized-candidates.ts`). The default resolver
answers `not-configured` when `NODE_ENV` is `production`, because no provider
registry is wired into this app yet and serving development fixtures from a
hosted deployment would publish fabricated `owned` rights for files that do not
exist.

### The response is a discriminated union on `outcome`

```json
{
  "outcome": "granted",
  "reasons": [
    { "code": "session_issued", "candidateId": null, "detail": "1 candidate(s) authorized and ranked for aurora-fall" },
    { "code": "unsupported_video_codec", "candidateId": "aurora-fall-av1", "detail": "the device did not list the video codec this candidate states" },
    { "code": "candidate_ranked", "candidateId": "aurora-fall-dash", "detail": "…the ranking's own explanation…" }
  ],
  "session": {
    "sessionId": "f0f1e0a4-6d1c-4f0b-9a3e-2a1d4c5b6e7f",
    "contentId": "aurora-fall",
    "candidates": [
      {
        "id": "aurora-fall-dash",
        "providerId": "fixture",
        "uri": "https://fixtures.invalid/aurora-fall/manifest.mpd",
        "mimeType": "application/dash+xml",
        "compatibility": "verified"
      }
    ],
    "startAtSeconds": null,
    "expiresAt": "2026-03-04T09:20:00.000Z",
    "failoverPolicy": { "maxAttempts": 4, "maxTransientRetriesPerCandidate": 1 }
  }
}
```

- **`granted`** — a session exists and these are its candidates. HTTP 200.
- **`denied`** — we refuse. Either the request is not one we accept, or no
  candidate carries a rights basis we may play from. Retrying changes nothing.
  HTTP **413** when the primary reason is `request_body_too_large` (see *The
  request body is bounded* below), **400** when it is `request_malformed` or
  `request_field_not_permitted`, **403** otherwise.
- **`unavailable`** — we would have, and could not: nothing registered under that
  id, no provider configured, the provider could not answer, or nothing survived
  eligibility and transport. HTTP **404** when the primary reason is
  `content_not_found`, **503** otherwise.

The last two are a *remedy* distinction, not a severity one. A viewer told "try
again in a moment" about something we will never be entitled to play will keep
trying, and a viewer told "you may not watch this" about a CDN blip will stop.
The status is derived from the response by `playbackSessionHttpStatus`, so the
wire status and the outcome cannot disagree.

`denied` and `unavailable` carry `reasons` and nothing else — there is no
`session` field on them, empty or otherwise.

### `reasons` is non-empty on every branch

Not an optional field on a shared envelope: a non-empty tuple
(`z.array(...).nonempty()`) on each of the three branches, so a branch with no
reasons is not constructible, `reasons[0]` reads as a reason rather than as
possibly-undefined, and the three constructors each take the primary reason as a
required positional argument. This is product invariant 4 enforced by the type: a
denial with no trail breaks it exactly as badly as a grant with none.

`reasons[0]` is the **primary** reason, the one that decided the outcome. The
rest are the trail behind it — candidates dropped, and why — emitted in gate
order (rights, identity, eligibility, transport, ranked). Consumers may show the
primary and log the rest; they must not assume the trail is short.

Each reason is `{ code, candidateId, detail }`. `candidateId` is required and
nullable: `null` means the reason is about the request as a whole, and an absent
key would say only that nobody thought about it. `detail` is for humans and is
never parsed — the code is what anything decides on. The vocabulary is closed
(`playbackSessionReasonCodeSchema`) and deliberately spells the media-engine
`RejectionReason` and provider-SDK `UrlRejectionReason` values verbatim;
`engineReasonCode` and `urlReasonCode` are identity functions that exist so that
adding a reason to either package fails the build here rather than producing an
unlisted code at runtime.

### The request body is bounded

The route reads at most **16,384 bytes (16 KiB)** of request body. A larger body
is refused with

```json
{
  "outcome": "denied",
  "reasons": [
    {
      "code": "request_body_too_large",
      "candidateId": null,
      "detail": "the request body exceeds the 16384 byte cap"
    }
  ]
}
```

at HTTP **413**, with `cache-control: no-store` like every other answer from this
route. `detail` states the cap and, when the refusal came from an over-declared
`content-length`, the declared size; it never echoes any part of the body.

**Why its own code rather than `request_malformed`.** A body that is merely too
big is not malformed — the one below is a request this route would have granted
had it been shorter — and reporting a size refusal as a shape refusal would make
the reason trail lie about which limit was hit, in the one place that exists to
explain decisions accurately. It is `denied` rather than `unavailable` because
retrying the same body changes nothing: the caller must send a smaller one.

**Why 16 KiB.** `playbackSessionRequestSchema` is `.strict()` at both levels, so
the largest body it can legitimately accept is computable: a generous
`contentId`, both codec enums in full, and a hundred BCP-47 tags in
`preferredAudioLanguages` — far more than any real device profile lists — come to
roughly 4.2 KiB. The bound is about four times that, and it is also the figure
Node already applies to the other half of a request
(`--max-http-header-size`). The constant is `MAX_REQUEST_BODY_BYTES` in
`apps/web/src/app/api/v1/playback/session/handler.ts`, where the arithmetic is
written out. It is deliberately far below `/playback/resolve`'s 1 MiB: that route
accepts a client-supplied candidate array, this one accepts two fields of fixed
shape, and a bound should be the size of the thing it bounds.

**The bound is enforced by a metered read, not by `content-length`.** A declared
length is a claim: it is absent entirely under chunked transfer encoding and it
is trivially forged otherwise, so a route that trusted it would have a limit the
caller opts into. The header is consulted first and only ever to refuse *earlier*
— an honest over-declaration is turned away without a byte being read — and the
bytes are then counted as they arrive, with the read stopped the moment the
running total exceeds the cap. Peak memory is therefore the bound plus one chunk
regardless of what the header said or how much the sender goes on to send. A body
that cannot be read at all (a stream that fails mid-request) is
`request_malformed` at 400, not a size refusal.

The check runs in `handler.ts`, in front of the build-target seam, so the hosted
build and the desktop build get the same bound from the same code, and the
refusal short-circuits before either implementation is handed the body.

This bound is on the **envelope**. It is not a substitute for the per-field bounds
on `streamCandidateSchema` in `@liberty/contracts`, nor they for it: a body
comfortably under 16 KiB can still carry one very long field.

### The granted session

`candidates` is non-empty and in preference order. Each entry carries `id` (the
attribution key every reported failure is keyed by, not a URL and not an index),
`providerId`, `uri`, `mimeType` (required-and-nullable; `null` means the resolver
could not state one) and `compatibility`, which is `verified` or `unverified` per
candidate — `unverified` says the stream survived eligibility by not being
disqualified rather than by being qualified, so a decode error on it is a
foreseeable outcome rather than evidence the provider has gone bad.

**`id` and `providerId` are bounded on the wire at the SAME limits the
`StreamCandidate` contract enforces** — `MAX_STREAM_CANDIDATE_ID_CHARS` (141) and
`MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS` (64), imported from
`@liberty/contracts/domains/playback` rather than restated as numbers (PL-0711).

The two are one value at two seams. The contract bound governs what a **provider
may produce**; this bound governs what the **session may publish**. Until PL-0711
only the first existed, so an oversized identifier refused upstream could
re-expand downstream after passing through another producer — the bound stopped
at the seam instead of travelling with the value. A copied literal here would
have made the two agree by coincidence, and the day somebody tuned the contract
the session would have silently stopped matching it; `contract.bounds.test.ts`
asserts the imported symbols are used and that no numeric literal of either
value appears in the module.

A response whose candidate exceeds either bound does not reach a caller as a
granted session: `handler.ts` validates every response against
`playbackSessionResponseSchema` before it leaves, so the failure is a 500 naming
a service that produced something it may not say. The failure output describes
the violation **without reprinting the offending value**, which is also asserted.

`uri` and `mimeType` remain unbounded. They have no authoritative constant to
import, and inventing one for them here would be the second vocabulary PL-0711
exists to prevent — raised as a follow-up rather than decided in passing.

`startAtSeconds` is `null` rather than `0`: `null` means engine default, which is
the beginning for VOD and the live edge for live. Nothing sets it today.

`failoverPolicy` is published rather than left for the client to hardcode, so the
attempt budget is changeable without shipping a new bundle. It is
`DEFAULT_FAILOVER_POLICY` from `@liberty/media-engine`.

The primary reason on a grant is `session_issued` or
`session_issued_unverified_compatibility`, read off the compatibility of the head
of the *published* list rather than off the ranking's own pick. The two can
differ — the engine's pick may have failed the transport check and been dropped —
and reporting the session as verified because of a candidate we are not sending
would describe a choice nobody made.

`expiresAt` bounds the session at `PLAYBACK_SESSION_TTL_MS` (five minutes) after
issuance — a start-up budget, not a viewing budget. **No playback credential is
minted yet**: `uri` is whatever the resolver stated. The bound is stated in the
contract from the start so that clients do not learn to cache a session forever
before there is something worth expiring.

### Gate order

The decision runs shape → resolution → rights → identity → eligibility and
scoring → transport, and the order is load-bearing. Rights precedes identity, so
two copies of an unrightsed candidate are reported as a rights refusal rather
than as a duplicate-id drop. Transport (`@liberty/provider-sdk`'s `checkUrl`) runs
immediately before a URL is published, so a resolver that was compromised,
misconfigured or simply new gets no opportunity to publish a link-local address, a
`file:` URI or an origin carrying embedded credentials.

Duplicate candidate ids cause **all** entries sharing that id to be dropped, not
deduplicated: the id is the failover attribution key, and keeping "the first one"
would make the survivor depend on the resolver's ordering.

The response is a function of the *set* of resolved candidates, not of the order
the resolver returned them in — `issue-session.property.test.ts` permutes the
input and requires an identical whole response.

### Everything else about the wire

A body that is not JSON is a malformed request, not a server fault: it reaches
the schema as `null` and produces the same well-formed `denied` any other
malformed body produces. Nothing inspects `content-type`.

The response is validated against `playbackSessionResponseSchema` before it
leaves the server. A regression that drops the reason trail therefore surfaces as
HTTP 500 `playback_session_failed_validation` — the one response that is not a
member of the union, deliberately, because it is not a playback decision at all.

Served `cache-control: no-store` on every path including the 500: a playback
session is per-viewer, per-device and time-bounded, and a shared cache holding one
would serve one viewer's session to another.

## Content protection on a playback candidate

Defined by PL-0902 in `@liberty/contracts`:
`packages/contracts/src/shared/drm.ts` (the vocabulary) and
`packages/contracts/src/domains/playback.ts` (`resolvedStreamCandidateSchema`).

**No route emits this yet.** It is written here before the wire carries it, on
purpose: PL-0501 issues the playback session that will carry it, and retrofitting
a discriminated field into a shipped response is the change PL-0501's acceptance
warns about. What follows is the contract PL-0501 implements, not a description
of today's `/playback/session` response — the shape documented under
[The granted session](#the-granted-session) is unchanged until PL-0501 lands.

### Why it exists

`docs/DESKTOP_PLAYBACK.md` §4: the desktop build routes between an mpv adapter
that has **no Content Decryption Module and cannot be given one** and a
Shaka/EME adapter that has one, and `PlayerAdapter.canPlay` must return a
reasoned decision on both branches. A refusal that says `drm_required` without
naming a system is not a debuggable trail, which is product invariant 4. So the
candidate states a capability descriptor, not a boolean.

This describes an encryption requirement so that a player which cannot satisfy it
**refuses**. It adds no decryption, no key handling and no fallback: there is no
key, key id, initialisation data, PSSH or certificate anywhere in the contract,
and the protection descriptor is `.strict()` at every variant so a producer that
tries to attach one gets a parse failure rather than a silent strip. The mpv
adapter's refusal stays a refusal.

### The descriptor

`contentProtectionSchema` is a discriminated union on `state` with **three**
members:

```json
{ "state": "clear" }
{ "state": "unknown", "why": "provider_did_not_state" }
{ "state": "protected", "keySystem": "widevine", "licenseUrl": "https://licence.example/acquire" }
```

- `clear` is an **assertion** that the stream is unencrypted. Somebody looked.
- `unknown` is an assertion that nobody established it. It carries no key system
  because there is none, and `why` is closed
  (`provider_did_not_state`, `provider_value_unrecognised`, `not_inspected`) so
  the trail sends a reader to the producer, to the normalizer or to inspection
  rather than saying only that something was not known.
- `protected` names the key system from a closed vocabulary
  (`widevine`, `playready`, `fairplay`, `clearkey`) and the licence acquisition
  endpoint where the boundary that produced the candidate knows one.
  `licenseUrl` is required-and-nullable: `null` means the endpoint was not
  stated, and routing does not depend on it — `canPlay` needs the *system*, a
  load needs the *endpoint*.

`licenseUrl` must be `https` with no credentials in the authority. A licence
exchange over `http` publishes the CDM's challenge to the path, and
`https://user:pass@host/` is the shape `checkUrl` already refuses before a media
URL is published; a licence endpoint is not held to a lesser standard than a
media URL.

**Unknown must never read as clear.** `requiresContentDecryptionModule()` returns
`true` for `unknown` as well as for `protected`, so an unestablished encryption
state routes to the adapter that has a CDM and is refused by the native adapter
under `drm_required_no_cdm` with a reason that says the state was *unstated*
rather than positive. Getting that backwards is the one way this design produces
a product-invariant-2 incident.

### Where it lives, and why

On the **resolved candidate** — `resolvedStreamCandidateSchema`, which is
`streamCandidateSchema` plus `protection` — and restated verbatim by the playback
session that publishes that candidate. It is **not** on `streamCandidateSchema`.

`streamCandidateSchema` is the ranker's input. `docs/DESKTOP_PLAYBACK.md` §4
rules that a desktop client reports the **union** of both engines' capabilities
and that per-candidate routing decides afterwards, explicitly accepting that
ranking may prefer a candidate only one adapter can play. Ranking therefore has
no use for a key system, and the first score component that discounted protected
candidates would be a second opinion about routing living in the one component §4
says must not hold one.

`packages/provider-sdk/src/fixture/provider.ts` keeps the playable address off
`StreamCandidate` and on a separate `FixtureCandidate`, so `@liberty/media-engine`
"could not read `uri` even by accident", and because that seam is where a
short-lived playback credential would be minted. That argument is not
candidate-versus-session — it is **ranker-input versus player-input** — and both
halves of this descriptor are player-input. The licence endpoint is an address in
exactly `uri`'s class and follows it. The key system is not an address at all: it
is a stable capability fact of the same kind as `protocol` and `videoCodec`, so
nothing in the `uri` argument excludes it from a candidate — what excludes it
from the *scored* candidate is the paragraph above.

Consequence: adding this field changed no existing candidate's meaning.
`streamCandidateSchema` is byte-for-byte what it was, every current producer
still parses, and `/playback/resolve` is unaffected. A candidate that states no
protection remains a valid thing to **rank** and is not a valid thing to
**play**.

### What PL-0501 has to do

1. Add `protection: contentProtectionSchema` to `playbackSessionCandidateSchema`
   in `apps/web/src/app/api/v1/playback/session/contract.ts`, carrying the
   resolved candidate's value verbatim rather than re-deriving one.
2. Pin the obligation so it cannot be dropped later:

   ```ts
   const SESSION_CANDIDATE_STATES_PROTECTION: StatesContentProtection<PlaybackSessionCandidate> = true;
   ```

   `StatesContentProtection` is exported from
   `@liberty/contracts/domains/playback` and resolves to `never` for a shape
   without the field, so the declaration stops compiling if it is removed or
   renamed. This is the inverse of `domains/live.ts`'s `CarriesNoPlayability`.
3. Add `export * from "./shared/drm";` to `packages/contracts/src/index.ts`.
   PL-0902's write surface did not include the barrel, so the vocabulary is
   reachable today only through its authoritative subpath,
   `@liberty/contracts/shared/drm`. That is a real public surface — the barrel is
   a compatibility re-export and `domains/live.ts` is already absent from it — but
   the omission should not outlive the next task that owns `index.ts`.

The session's descriptor is a copy, not a second opinion. Two boundaries each
deciding what a candidate's protection is would eventually disagree, and the
disagreement would surface as a router refusing a candidate the session
advertised as clear.

### Normalization stays inside `@liberty/provider-sdk`

`keySystemSchema` is a closed enum, so a provider's own spelling —
`com.widevine.alpha`, `com.microsoft.playready`, `org.w3.clearkey`, `DRM: WV` —
**does not parse**. There is exactly one place that spelling can be turned into a
contract value, and product invariant 3 says which: the adapter, behind
`@liberty/provider-sdk`. Nothing outside that package should contain a mapping
table, and the contract is shaped so that nothing outside it can.

The failure mode is the part that matters. An adapter that meets a spelling it
cannot map **must** emit `{ "state": "unknown", "why": "provider_value_unrecognised" }`.
It must not emit `clear`, and it must not omit the field: an unmapped provider
string becoming a claim that the stream is unencrypted is exactly the accident
the third state exists to prevent. `PROTECTION_NOT_STATED` is exported as the
safe default so that "I do not know" is a one-token import and `{ state: "clear" }`
is the thing somebody has to type deliberately.

## `POST /api/v1/playback/resolve`

Purpose: rank already-authorized candidates for the requesting device.

**Not part of a hosted deployment.** This route accepts a client-supplied
candidate list, including each candidate's `rights`, and answers with a full
playability verdict — unauthenticated. When `NODE_ENV` is `production` it
therefore returns **404 `route_not_available`** before reading the body, with no
`selected` and no `ranked` anywhere in the response. Callers use
`POST /api/v1/playback/session`, where the server resolves candidates and the
client only names content.

404 rather than 403 because in a hosted deployment this is not a resource the
caller lacks permission for — it is a resource that is not there, and a 403
would confirm to an unauthenticated caller that it exists somewhere. The guard
lives in `apps/web/src/app/api/v1/playback/resolve/handler.ts`, not in this
document: the sentence below about the scaffold being for testability was always
here, and the security review's finding was precisely that a sentence in a
document is not a control.

Everything that follows describes the route as it behaves in a development
build.

Request:

```json
{
  "contentId": "aurora-fall",
  "capabilities": {
    "maxHeight": 2160,
    "supportedVideoCodecs": ["h264", "hevc"],
    "supportedAudioCodecs": ["aac", "eac3"],
    "preferredAudioLanguages": ["en"]
  },
  "candidates": [
    {
      "id": "aurora-fall-hls-1080",
      "providerId": "demo-owned-library",
      "rights": "owned",
      "protocol": "hls",
      "height": 1080,
      "bitrateKbps": 8100,
      "estimatedLatencyMs": 240,
      "healthScore": 0.93,
      "videoCodec": "hevc",
      "audioCodec": "eac3"
    }
  ]
}
```

`candidates` must contain at least one entry: an empty array is a resolution request with nothing to resolve, which is a caller bug rather than a 422-worthy outcome, so it fails validation with 400 instead.

`capabilities.maxAudioChannels` is optional and has no default. Absent means the device has not reported its layout, which is not the same as claiming stereo — a device that stayed silent must not be silently downmixed.

Current scaffold accepts candidates directly for testability, which is why it is gated out of production rather than shipped. Production application code must resolve candidates server-side through authorized provider adapters instead of trusting client-supplied URLs.

A body that is not JSON is a malformed request, not a server fault: it fails validation with **400 `invalid_request`**, the same as any other body the schema rejects. It previously threw out of the route as a 500 with no reason trail.

Two size bounds answer **413** before any ranking happens, because the alternative is a small body buying a large amount of server work:

- `request_too_large` when a declared `content-length` exceeds 1 MiB, matching `@liberty/provider-sdk`'s `DEFAULT_MAX_RESPONSE_BYTES`. This reads a claim rather than measuring the stream, so it is a developer guardrail and not an attacker control; the metered read lands if this route ever ships hosted.
- `too_many_candidates` when `candidates` holds more than 100 entries. Checked *before* schema validation, since validating a hundred thousand candidates in order to report that there are too many of them is the same defect wearing a schema. `candidates` is bounded below by the schema (`.min(1)`) and above only here.

Success returns `selected`, `ranked`, `rejected` and a top-level `reason`. `rejected` carries the first disqualifying reason per candidate, so a candidate that never reached scoring is still explainable. If no candidate is playable, return HTTP 422 with `no_playable_candidate`.

All responses on this route are served `cache-control: no-store`, including the 404: a ranking verdict is per-device and per-request, and nothing between the route and the caller has business holding one for the next caller.

## `GET /api/v1/catalog/home`

Purpose: the rails the home experience renders.

Response:

```json
{
  "rails": [
    {
      "id": "movies",
      "title": "Films",
      "items": [
        {
          "id": "aurora-fall",
          "title": "Aurora Fall",
          "kind": "movie",
          "rights": "owned",
          "genre": "Sci-fi",
          "releaseYear": 2024,
          "runtimeMinutes": 128,
          "episodeCount": null
        }
      ]
    },
    {
      "id": "series",
      "title": "Series",
      "items": [
        {
          "id": "northstar",
          "title": "Northstar",
          "kind": "series",
          "rights": "owned",
          "genre": "Drama",
          "releaseYear": 2024,
          "runtimeMinutes": null,
          "episodeCount": 8
        }
      ]
    }
  ],
  "generatedAt": "2026-03-04T09:15:00.000Z"
}
```

`CatalogItem` is a discriminated union on `kind`. Both shape fields are always present in every branch, explicitly `null` where they do not apply: a `movie` or `episode` carries `runtimeMinutes` with `episodeCount: null`, a `series` the inverse. A provider omitting a field is saying something different from one asserting the field does not apply, so neither field is optional.

A rail with no surfaceable items is omitted entirely rather than returned empty, because an empty rail renders as a titled band of nothing. Clients must therefore treat rail presence as data, not layout: `rails` may itself be `[]` when nothing clears the rights gate, and that is a valid response meaning "genuinely nothing to show" — distinct from a failure, which is never an empty body.

**`rails: []` at 200 is now reachable only from a *configured* source.** It used to be what a deployment served, because the route called a synchronous loader whose return type had nowhere to put a reason — so a process with no catalog at all made a statement about the catalog. The route awaits `loadHomeCatalog` instead, and "no source is configured" is a 503 with its own code (below). A client receiving `{ "rails": [] }` may therefore rely on it meaning that a real source was asked and answered with nothing surfaceable.

Only rights on the `PLAYABLE_CONTENT_RIGHTS` allowlist are surfaced. Home rails cover top-level browsable kinds only; individual `episode` items are reachable through their series, never as a standalone rail entry.

Items within a rail are ordered by release year descending, then title ascending, so the same catalog always produces the same page.

### Failure branches

Every failure answers `{ "error": "<code>" }`. Never an empty body, never a 200, and never anything beyond the code: `CatalogLoadResult` carries a *reason*, not the Zod issue array an earlier version of this route attached to its 500 when it ran the parse itself. That array was never part of this contract, and the documented code has not changed.

| Status | `error` | Meaning |
| --- | --- | --- |
| 500 | `catalog_response_failed_validation` | The source answered and this server could not publish what it said — a fixture or provider regression, surfaced as a stable code rather than as malformed JSON the client has to defend against. A fault on this side of the boundary. |
| 503 | `catalog_source_not_configured` | No catalog metadata source is configured for this process, so nothing was consulted. Nothing is wrong with the request; the remedy is an operator's. See `docs/CATALOG_SOURCE.md`. |
| 503 | `catalog_source_unavailable` | A source is configured and it did not answer — a network fault, a timeout, an adapter throwing. |

The two 503s follow the precedent the profile, progress and watchlist routes set with `authentication_not_configured`: one status across this app for "this deployment is missing a dependency", so an operator reading across the surfaces sees a single signal. A reason this route does not recognise is answered **500** — the loader produced something the handler was not updated for, which is a server-side inconsistency and not the caller's problem. It is never silently downgraded to a 200.

The response is validated against `catalogHomeResponseSchema` inside `loadHomeCatalog` before it leaves the server, and the HTTP half does not re-parse what the loader has already checked. Every branch, both refusals included, is served `cache-control: no-store`: a cached refusal outlives the configuration that caused it.

## Profile, progress and watchlist routes

Implemented in `apps/web/src/app/api/v1/{profiles,progress,watchlist}/` — a `contract.ts`
(schemas, reason vocabulary, constructors, status), a `handler.ts` (the testable HTTP half)
and thin `route.ts` entry points, matching the shape `/playback/session` established. The
wire schemas live in those directories rather than in `@liberty/contracts`, for the reason
`playback/session/contract.ts` records; the move is follow-up for all four groups together.

Storage comes from a composition root at `apps/web/src/lib/db/`, which is a **consumer** of
`apps/web/src/app/api/deployment-environment.ts` rather than a second reading of `NODE_ENV`.
The selection is:

1. `DATABASE_URL` set and a `postgres:`/`postgresql:` URL → the PostgreSQL adapter over
   `@liberty/persistence`. Production; chosen by configuration, not by environment.
2. `DATABASE_URL` set and malformed → **refused**, never a fallback. Falling back to memory on
   an operator's typo would serve a volatile store from a process that believes it has a
   database.
3. `DATABASE_URL` unset, outside a deployment → an in-memory development adapter.
4. `DATABASE_URL` unset, in a deployment → **refused**, with the operator's remedy named.

The in-memory adapter cannot be selected in a deployment *by construction*, not by a runtime
condition: `createInMemoryRepository` requires a `NonDeploymentEnvironment`, which is the
branded capability `classifyRuntime` issues in `@liberty/contracts/shared/runtime` — not a
class, and with no constructor at all. Its brand key is a `unique symbol` that module never
exports, so no consumer can name the key or write one, and that single mint takes no argument
— it reads the running process — and answers `null` outside the `development`/`test`
allowlist, which is declared there and nowhere else and is frozen at runtime, so a consumer
cannot widen it by casting away its `readonly` and appending. Deleting the check is a compile
error. Every response names which adapter answered, as
`served_by_postgres_adapter` or `served_by_in_memory_adapter`.

**No SQL in these routes has been executed against PostgreSQL.** There is no database in the
development environment, so the PostgreSQL adapter is unexercised and the `integration` gate
on PL-0402/0403/0404 is not satisfiable from this lane.

### Identity, while there is no sign-in

`@liberty/auth` ships the seam but nothing in `apps/web` constructs it — there is no
`app/api/auth/[...all]` handler, no configured secret or mail transport, and no database for
the sessions PL-0401 chose. So in a deployment every route below answers `unavailable` with
`authentication_not_configured` (503). Outside a deployment they act as a **development
account**, gated by the same witness, defaulting to `development-account` and overridable per
request with `x-liberty-development-account` / `x-liberty-development-session` so that
cross-household behaviour can be exercised. No route reads a profile id from a client: the
active profile comes from `active_profile_selection`, written only by
`POST /api/v1/profiles/selection`.

### Shared response shape

Every route answers a discriminated union on `outcome` with a **non-empty** `reasons` array on
every branch — a tuple in the type, re-validated against the schema before the response
leaves the server, so a dropped trail is a 500 with a stable code rather than a decision
nobody can explain. `reasons[0]` is the primary reason; the adapter line is always present.
Every request schema is `.strict()` at every level, so an unaccepted field is refused as
`request_field_not_permitted` rather than silently stripped. All responses are `no-store`.

Authorization denials are published through `externalProfileAccessReason`, so "no such
profile" and "not your profile" both surface as `profile_unavailable` with **403** — never
404, because a differing status would restore the enumeration oracle the collapsed vocabulary
removes.

### `GET /api/v1/profiles`

`{ "outcome": "listed", "reasons": [...], "profiles": [ { "id", "displayName", "avatarKey", "maxRating", "createdAt" } ], "activeProfileId": string|null }` — 200.
Live profiles only. `userId` is never published. `activeProfileId` is `null` for "signed in,
nothing chosen", which is the profile picker's state.

### `POST /api/v1/profiles`

Request: `{ "displayName": string, "avatarKey": string|null, "maxRating": string|null }`,
`.strict()`. All three keys required; the two optional facts are nullable rather than absent.
`displayName` carries no schema-level length or blankness rule, deliberately —
`resolveProfileCreation` owns those and reports `display_name_is_blank` /
`display_name_too_long` with the limit named.

Response `{ "outcome": "created", "reasons": [...], "profile": {...} }` — **201**.
Refusals: `display_name_is_blank`, `display_name_too_long`, `avatar_key_too_long`,
`max_rating_too_long` → **400**; `profile_limit_reached`, `display_name_already_used` →
**409** (the request is well-formed and would have been accepted against a different account).

### `POST /api/v1/profiles/selection`

Request: `{ "profileId": string }`, `.strict()`. The one endpoint where a client names a
profile, which is what a picker does. No UUID pattern in the schema: `isMintedProfileId` is the
single authority and an unminted id is answered `profile_unavailable` like any other.

Response `{ "outcome": "selected", "reasons": [...], "profileId": string }` — 200. The trail
also carries the grant (`selectable_profile_of_account`).

### `GET /api/v1/progress/{contentId}`

`{ "outcome": "read", "reasons": [...], "progress": {...}|null }` — **200 including `null`**.
A title nobody has started is the ordinary case; a 404 would make every client's fetch wrapper
treat it as an error. The reason is `progress_absent`.

`progress` is `{ contentId, positionSeconds: number|null, runtimeSeconds: number|null,
writerEpoch, writerId, writeSeq, updatedAt }`. `positionSeconds: null` **is not 0**: it is a
row created by a lease, with nothing watched.

### `POST /api/v1/progress/{contentId}/lease`

Request: `{ "writerId": string }`, `.strict()`. Response
`{ "outcome": "leased", "reasons": [...], "lease": { "epoch": number, "writerId": string } }` — 200.

POST rather than PUT because each call *allocates* a new epoch and supersedes the previous
holder. A write cannot mint its own lease; that separation is the handoff mechanism.

### `PUT /api/v1/progress/{contentId}`

Request, `.strict()` at both levels:
`{ "lease": { "epoch": int>=0, "writerId": string }, "writeSeq": int>=0, "positionSeconds": number, "runtimeSeconds": number|null }`.

**There is no field through which a client can assert a time, and there must never be one.**
`writer-epoch.ts` rejects "latest client timestamp wins" and asserts the absence by test.
`positionSeconds` is unbounded in the schema on purpose — `resolveProgressWrite` owns it and
reports `position_not_representable` / `position_beyond_runtime` distinctly.

Response `{ "outcome": "written", "reasons": [...], "progress": {...} }` — 200. The trail
carries `current_writer` plus the resolver's notes (`retained_known_runtime`,
`runtime_restated`, `position_moved_backwards`, `position_first_reported`), because a grant
that quietly discarded information is as hard to debug as an unexplained denial.

Write refusals answer **409**, not 403: `no_writer_lease`, `epoch_not_issued`,
`superseded_by_newer_writer`, `writer_id_mismatch`, `stale_write_within_writer`. The caller is
authorized and well-formed; what it lacks is the lease, and the remedy is to take one. A
**rewind by the current writer is accepted** — position is not a term in the authority
decision.

`instant_not_representable` answers `unavailable` (503), not `refused`: that instant is the
server's own stamp and no client can influence it.

### `GET /api/v1/watchlist?limit=`

`{ "outcome": "listed", "reasons": [...], "entries": [ { "contentId", "addedAt" } ], "limit": int }` — 200.
Most recently added first, with `contentId` descending as the tie-break so the page is a total
order. `limit` defaults to 50 and is capped at 200; the applied value is echoed. A limit above
the cap is `limit_exceeds_page_maximum` (400); anything that is not a non-negative safe integer
— including a blank `?limit=`, which is *not* read as 0 — is `limit_not_representable` (400),
emitted by `parseListLimit` alone.

### `PUT` / `DELETE /api/v1/watchlist/{contentId}`

No body; both parse one anyway against a `.strict()` empty object, so a client that believed
it could send `addedAt` is told rather than having it dropped.

Response `{ "outcome": "mutated", "reasons": [...], "changed": boolean, "entry": { "contentId", "addedAt": string|null }|null }` — **always 200**.
The primary reason is one of `added`, `already_present`, `removed`, `not_present`. A double tap
is not a 409 and a retried remove is not a 404: the client is a button on a remote control
behind an unreliable network and a retry must converge. Re-adding does **not** move `addedAt`,
so the list is not reordered.

`entry.addedAt` is nullable, and the two adapters genuinely differ: PostgreSQL's
`ON CONFLICT DO NOTHING ... RETURNING` proves a row existed without returning it, so
`already_present` reports `null` there, while the in-memory adapter read the entry first and
reports the real value. Substituting the conflicting write's instant would fabricate a
first-added time, and that value is the list's sort key. Clients must handle `null`.

## Planned contracts

- `GET /api/v1/search?q=`
- `GET /api/v1/titles/:id`
- `GET /api/v1/live/channels`
- `GET /api/v1/live/epg`

Before implementing these routes, define request/response schemas in `@liberty/contracts`.
