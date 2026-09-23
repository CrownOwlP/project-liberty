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

## Windows reliability certification

The table above has no manual, real-device, HDR, hardware-decode or Windows row,
and it should not grow one: those scenarios need an OWNER column this table does
not have, and two other documents already require hardware — `DESKTOP_PLAYBACK.md`
§10's compositing experiment and `AV_SYNC_MEASUREMENT.md`'s external flash-and-blip
rig, which exists because **a browser cannot measure lip-sync at all**.

`docs/WINDOWS_CERTIFICATION.md` (PW-0601) is that matrix. Forty-one rows across
lifecycle, playback, failure and recovery, Live TV, resources, install and update,
and architecture facts, each owned by **AUTO** (a `windows-latest` CI job), **RIG**
(the commander's Windows machine) or **BLOCKED** (needs access or hardware nobody
has yet).

**No row of it may be marked passed from the cloud engineering session**, which
can observe no Windows machine. That is why the owner column exists.
