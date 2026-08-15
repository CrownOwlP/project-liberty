# Release Criteria

## Foundation release

- Repository validator passes.
- Dependency lockfile committed.
- CI green on main.
- Home and watch development routes build.
- Playback ranking tests pass.
- Provider-rights boundary is enforced in code and docs.

## MVP release

- Authentication and profile authorization complete.
- Catalog/search/title flow complete.
- At least one authorized provider adapter complete.
- Playback session creation does not trust arbitrary client URLs.
- Audio/subtitle preferences implemented.
- Progress/watchlist persistence implemented.
- Critical E2E flows green.
- Security review has no unresolved critical/high findings.
- Structured playback failure telemetry available.
- Backup/restore and incident basics documented.
