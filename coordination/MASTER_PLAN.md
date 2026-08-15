# Master Plan

The goal is maximum safe parallelism: independent ownership lanes, explicit contracts, and fast integration gates.

## Wave 0 - Foundation

- `PL-0001` Lock dependencies and make CI reproducible.
- `PL-0002` Confirm architecture/contracts and repository ownership lanes.
- `PL-0003` Establish local dev stack and environment validation.

## Wave 1 - Vertical slice

Parallel lanes:

- Catalog: home/search/title details.
- Provider: authorized fixture adapter plus first real licensed provider adapter when credentials/rights are available.
- Media: playback capability, ranking, audio/subtitle policy.
- Identity/data: auth profiles, watch progress, watchlist.
- Player UI: session creation, loading/error/fallback states.

Integration target: `catalog -> detail -> provider -> playback decision -> player -> progress`.

## Wave 2 - Playback quality

- provider health sampling;
- startup/rebuffer telemetry;
- candidate fallback/retry policy;
- audio language/default/forced subtitle policy;
- A/V drift detection and player recovery strategy;
- device capability profiles.

## Wave 3 - Product depth

- recommendations;
- richer search;
- continue watching;
- parental controls;
- profile personalization;
- live channel/EPG experience.

## Wave 4 - Hardening

- security review and abuse controls;
- performance budgets;
- load tests;
- incident/rollback plan;
- backups and migration rehearsal;
- production observability dashboards.
