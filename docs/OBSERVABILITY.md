# Observability

## Required signals

- request ID / playback session ID;
- provider resolution duration;
- number of candidates returned/rejected;
- winning candidate reason and score dimensions;
- startup time;
- rebuffer events;
- playback failure reason;
- A/V continuity proxies, plus the explicit statement that lip-sync offset is
  unobservable in a browser — see "A/V sync" below, and do not read that entry as
  a drift measurement;
- subtitle/audio-selection fallback reason.

This is the list a playback session is expected to be able to account for. It is
a requirement, not a claim that every line is already wired: where a signal is
implemented, the module that implements it is named below or in
`docs/AV_SYNC_MEASUREMENT.md`.

## A/V sync: four proxies, and the number the browser does not have

The list above used to carry "A/V drift measurement when available". It is
**never** available, and "when available" made a permanent impossibility read as
an optional field — so a reader could reasonably wait for the number, or worse,
fill it in from something that is not it.

**A browser cannot measure audio/video sync.** No audio clock is exposed for a
`<video>` element; `video.currentTime` is the HTML specification's *official
playback position*, which is a position and not a rendering clock; and the final
alignment of picture and sound happens in the compositor and the OS audio stack,
neither of which is reachable from script. Routing playback through Web Audio to
obtain a clock is **prohibited** (`PROHIBITED_AV_INSTRUMENTATION` in
`apps/web/src/components/player/diagnostics/av-continuity.ts`, enforced by a test
that scans the directory): it still would not measure *presented* alignment, and
W3C Bug 17347 is closed WONTFIX on that ground.

### What the browser can proxy

Four signals, each of which is a real, useful fact about the stream, and none of
which is an audio-versus-video offset. They are namespaced `com.liberty-avs-*`
because no standard metric name for A/V drift exists — not in CMCD v2
(CTA-5004-B), not in CTA-2066, not in ISO/IEC 23009-1 — so there was nothing to
adopt.

| Metric | Read from | Fires when | What it is not |
| --- | --- | --- | --- |
| `com.liberty-avs-video-hole` | `sourceBuffer.buffered`, **per track** | the video SourceBuffer is discontinuous at or just ahead of the playhead while a single audio range covers the same interval | a skew. Its magnitude is a span of the media timeline |
| `com.liberty-avs-media-time-advance` | `requestVideoFrameCallback` | presented media time was identical across two frame callbacks | a skew. It says the picture repeated, not where the audio was |
| `com.liberty-avs-presented-frame-gap` | `requestVideoFrameCallback` | more than one frame was presented between callbacks | a dropped-frame count; it is as much a caveat on the row above as a signal |
| `com.liberty-avs-sequence-mode-assertion` | the effective Shaka configuration | `manifest.{dash,hls}.sequenceMode` is `true`, or is unstated | evidence about a session. It is a configuration risk |

The video hole is the primary arm and it is not theoretical: hls.js ships
`nudgeOnVideoHole` for this exact shape. The user-visible symptom — a frozen
picture with audio continuing — is what people report as "out of sync", which is
why it is the closest observable analogue, and why it is reported under its own
name rather than as sync.

### What it cannot know, and how the report says so

`com.liberty-avs-lip-sync-offset` is emitted on **every** report with the literal
value `unobservable`, carrying reasons and no number. It is emitted rather than
omitted so that nobody has to infer from an absence that sync was not measured.
`audioAheadMs` exists on exactly one branch of the finding union — the external
measurement — and nothing in the browser constructs one; a test asserts it.

A **quiet proxy** and an **unobservable signal** are different answers and are
counted separately (`proxiesFired`, `proxiesQuiet`, `unobservable` in
`summariseAvContinuity`). `proxyFired: false` means the comparison was made and
the condition was not there. `evidenceBasis: "unobservable"` means it could not
be made at all — no per-track buffered readings, no `requestVideoFrameCallback`,
fewer than two frame readings yet, a backwards `mediaTime`. A dashboard that
reads "nothing fired" as "healthy" would score a browser we could not measure at
all as a clean session, which is why no single field in the summary is a health
verdict.

The collector receives **states, never magnitudes**: a CMCD custom key is an
untagged scalar, so a number sent there would sit beside CMCD's millisecond keys
with nothing saying it is not one. Magnitudes stay in the diagnostics panel,
where their unit is spelled out in words. When telemetry is on, the report is
emitted to the same collector as one CMCD v2 interval event (`e: "t"`),
deduplicated on everything but its timestamp so an unchanged session produces a
series of transitions rather than a copy every tick. It carries
`com.liberty-avs-proxies-fired`,
`-proxies-quiet`, `-unobservable`, `-policy-version`, `-buffered-evidence`,
`-config-evidence`, plus one state per finding. Provenance travels beside it:
`buffered-evidence` and `config-evidence` distinguish "we read it and it was
silent" from "we could not read it".

### What the external procedure is for

A true lip-sync offset is measured **with hardware, outside the browser**, by the
flash-and-blip procedure in `docs/AV_SYNC_MEASUREMENT.md`: synchronised
flash-and-blip content, a high-frame-rate camera plus microphone or a dedicated
A/V sync analyser, the acoustic path subtracted, a median and spread over several
flashes rather than one sample, per device, browser, stream type and DRM
configuration. It is filed as an `AvExternalMeasurement`, where the instrument,
its uncertainty, the operator and the measurement time are all required fields —
because a millisecond offset with no named instrument is a proxy wearing a
measurement's clothes. The sign convention is ITU-R BT.1359-1 (positive means
audio is ahead of video) and it is stated on every measurement, because the
published tolerances are not symmetric and a flipped sign turns a failing
measurement into a passing one.

The proxies do not replace that procedure, and the procedure does not make the
proxies redundant. The proxies run on every session and catch continuity faults
the rig would never see; the rig produces the one number the browser cannot.

## Privacy

Do not log raw tokens, cookies, full provider URLs, payment data, or unnecessary
personal profile fields.
