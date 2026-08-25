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
  HTTP **400** when the primary reason is `request_malformed` or
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

### The granted session

`candidates` is non-empty and in preference order. Each entry carries `id` (the
attribution key every reported failure is keyed by, not a URL and not an index),
`providerId`, `uri`, `mimeType` (required-and-nullable; `null` means the resolver
could not state one) and `compatibility`, which is `verified` or `unverified` per
candidate — `unverified` says the stream survived eligibility by not being
disqualified rather than by being qualified, so a decode error on it is a
foreseeable outcome rather than evidence the provider has gone bad.

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

Only rights on the `PLAYABLE_CONTENT_RIGHTS` allowlist are surfaced. Home rails cover top-level browsable kinds only; individual `episode` items are reachable through their series, never as a standalone rail entry.

Items within a rail are ordered by release year descending, then title ascending, so the same catalog always produces the same page.

The response is validated against `catalogHomeResponseSchema` before it leaves the server. A fixture or provider regression therefore surfaces as HTTP 500 with `catalog_response_failed_validation` rather than as malformed JSON the client has to defend against. Served `cache-control: no-store`.

## Planned contracts

- `GET /api/v1/search?q=`
- `GET /api/v1/titles/:id`
- `PUT /api/v1/progress/:contentId`
- `GET /api/v1/watchlist`
- `PUT /api/v1/watchlist/:contentId`
- `GET /api/v1/live/channels`
- `GET /api/v1/live/epg`

Before implementing these routes, define request/response schemas in `@liberty/contracts`.
