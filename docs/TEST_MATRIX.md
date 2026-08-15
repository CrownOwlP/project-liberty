# Test Matrix

| Area | Unit | Contract | Integration | E2E | Required before merge |
| --- | --- | --- | --- | --- | --- |
| Media ranking | Yes | Yes | Yes | Targeted | Yes |
| Provider adapter | Yes | Yes | Yes | Targeted | Yes |
| Auth/authorization | Yes | Yes | Yes | Yes | Yes |
| Progress/watchlist | Yes | Yes | Yes | Yes | Yes |
| Catalog/search | Yes | Yes | Yes | Smoke | Yes |
| Live/EPG | Yes | Yes | Yes | Targeted | Yes |
| UI components | Targeted | N/A | Targeted | Critical flows | Yes |
| Infrastructure | N/A | N/A | Smoke | Deploy smoke | Yes |

## Playback regression scenarios

- Highest resolution is not always selected when health is poor.
- Unsupported codecs are rejected.
- Device max resolution is respected.
- Deterministic tie-breaking.
- Audio language fallback.
- Subtitle forced/default preference.
- Provider candidate disappears during session creation.
- Health degradation triggers a safe fallback.
- A/V drift telemetry exceeds threshold.
- Resumed playback uses stored progress safely.
