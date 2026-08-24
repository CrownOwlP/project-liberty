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
- `POST /api/v1/playback/session`
- `PUT /api/v1/progress/:contentId`
- `GET /api/v1/watchlist`
- `PUT /api/v1/watchlist/:contentId`
- `GET /api/v1/live/channels`
- `GET /api/v1/live/epg`

Before implementing these routes, define request/response schemas in `@liberty/contracts`.
