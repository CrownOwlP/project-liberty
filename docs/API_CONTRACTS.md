# API Contracts

All JSON APIs live under `/api/v1` except health checks.

## `GET /api/health`

Response:

```json
{
  "status": "ok",
  "service": "project-liberty-web",
  "timestamp": "ISO-8601"
}
```

## `POST /api/v1/playback/resolve`

Purpose: rank already-authorized candidates for the requesting device.

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
  "candidates": []
}
```

Current scaffold accepts candidates directly for testability. Production application code must resolve candidates server-side through authorized provider adapters instead of trusting client-supplied URLs.

Success returns the selected/ranked candidates and a reason trail. If no candidate is playable, return HTTP 422 with `no_playable_candidate`.

## Planned contracts

- `GET /api/v1/catalog/home`
- `GET /api/v1/search?q=`
- `GET /api/v1/titles/:id`
- `POST /api/v1/playback/session`
- `PUT /api/v1/progress/:contentId`
- `GET /api/v1/watchlist`
- `PUT /api/v1/watchlist/:contentId`
- `GET /api/v1/live/channels`
- `GET /api/v1/live/epg`

Before implementing these routes, define request/response schemas in `@liberty/contracts`.
