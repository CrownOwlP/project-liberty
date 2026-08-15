# Database Design

PostgreSQL is the source of truth. Redis is optional for ephemeral cache, rate limits, provider health snapshots, and short-lived session data.

## Planned tables

### Identity

- `users`
- `profiles`
- `profile_preferences`

### Catalog

- `titles`
- `seasons`
- `episodes`
- `genres`
- `title_genres`
- `provider_catalog_refs`

### Playback

- `provider_assets`
- `playback_sessions`
- `watch_progress`
- `playback_failures`
- `provider_health_samples`

### Library

- `watchlist_items`
- `history_events`

### Live

- `live_channels`
- `channel_provider_refs`
- `epg_programs`

### Operations

- `audit_events`
- `feature_flags`

## Data rules

- Use opaque public IDs; do not expose sequential database IDs.
- Store provider tokens/secrets outside ordinary tables when a managed secret store is available.
- Never persist arbitrary resolved media URLs longer than their provider contract permits.
- Make watch-progress writes idempotent and ordered by client event time plus server receipt time.
- Retain playback decision metadata long enough to debug failures without storing sensitive URLs unnecessarily.

An ORM/migration library is intentionally not pinned in this scaffold until the first persistence task chooses it and creates a real lockfile.
