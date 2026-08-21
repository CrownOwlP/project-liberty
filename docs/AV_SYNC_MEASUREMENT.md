# A/V sync — what the browser can report, and how the real number is measured

> PL-0504. Read `docs/RESEARCH_PLAYBACK.md` finding 3 first; this document is the procedure that
> finding implies, plus the vocabulary the player ships instead of a measurement.

---

## The one-paragraph version

**A browser cannot measure audio/video sync.** There is no audio clock exposed for a `<video>`
element. `video.currentTime` is the HTML specification's *official playback position* — a position,
not a rendering clock — and the final alignment of picture and sound happens in the compositor and
the OS audio stack, neither of which is reachable from script. So the player ships **proxies**,
each labelled as a proxy, and the true offset is measured **with hardware, outside the browser**,
by the procedure below.

`apps/web/src/components/player/diagnostics/` implements the proxies. This document is the other
half: it is what you do when someone reports lip-sync and the proxies are all quiet, which is the
likely outcome, because the proxies are not measuring lip-sync.

---

## What the player reports, and what each signal is not

No standard metric name for A/V drift exists — not in CMCD v2 (CTA-5004-B), not in CTA-2066, not
in ISO/IEC 23009-1. PL-0503 adopts CMCD's vocabulary precisely so that we do not invent metric
names; here there was nothing to adopt, so the names are namespaced `com.liberty-avs-*` and
documented here as proxies.

| Metric | Evidence source | Fires when | What it is **not** |
| --- | --- | --- | --- |
| `com.liberty-avs-video-hole` | `sourceBuffer.buffered`, **per track** | the video SourceBuffer is discontinuous at or just ahead of the playhead while a single audio range covers the same interval | a skew. The magnitude is a span of the media timeline. |
| `com.liberty-avs-media-time-advance` | `requestVideoFrameCallback` | presented media time did not advance between two frame callbacks | a skew. It says the picture repeated, not where the audio was. |
| `com.liberty-avs-presented-frame-gap` | `requestVideoFrameCallback` | more than one frame was presented between callbacks | a dropped-frame count. It is a caveat on the signal above as much as a signal of its own. |
| `com.liberty-avs-sequence-mode-assertion` | the effective Shaka configuration | `manifest.{dash,hls}.sequenceMode` is `true`, **or is unstated** | evidence about any particular session. It is a configuration risk. |
| `com.liberty-avs-lip-sync-offset` | — | never; it is always reported as `unobservable` | available. This is the entry that says so out loud. |

**The video hole is the primary arm** and it is not a theoretical detector. hls.js ships
`nudgeOnVideoHole` for exactly this shape, citing a Chrome bug where playback continues past a gap
in the video buffer without rendering anything and then stalls. The user-visible symptom is a
frozen picture with audio continuing, which is what people report as "out of sync" — so it is the
closest observable analogue to the thing PL-0504 was originally asked for, and it is still a
different fact about the stream, which is why it is reported under its own name.

**`HTMLMediaElement.buffered` is the intersection of every SourceBuffer.** Read from the element,
the video and audio comparands are the same intersected set, the audio-contiguity half of the rule
can never be satisfied, and the detector becomes structurally incapable of firing while continuing
to look like it works. The diagnostics module makes this a compile error rather than a review
note: `readSourceBufferRanges("video", …)` and `readElementBufferedRanges(…)` return unrelated
types and only the former is accepted by a detector.

**`sequenceMode: false` is asserted, not assumed.** In MSE segments mode the browser uses the
`tfdt`/`trun` timestamps in each fMP4 segment, which is what puts both tracks on the same timeline.
In sequence mode those timestamps are discarded and each segment is appended immediately after the
last, so any per-track difference in segment duration accumulates as genuine, growing misalignment
— the one mechanism in this area that produces real drift *and* is visible from our own
configuration. It is already the shipped default in shaka-player 5.2.6 for both manifest families,
but Shaka's own JSDoc for `manifest.hls.sequenceMode` still claims the HLS default is `true`, and
there are current reports of drift appearing after an upgrade in players that never wrote it down.
An unstated value therefore fires the proxy.

---

## Prohibited: routing protected playback through Web Audio

Do not connect playback to Web Audio in order to obtain a clock. It is the usual next idea and it
is worse than the problem:

- it still does not measure **presented** alignment, which is decided downstream of anything script
  can observe;
- it makes the audio path of DRM-protected playback more invasive for the sake of instrumentation,
  against product invariant 2 and the isolation `docs/ARCHITECTURE.md` asks for;
- W3C Bug 17347 is closed **WONTFIX** on precisely this ground.

`PROHIBITED_AV_INSTRUMENTATION` in `diagnostics/av-continuity.ts` names the APIs, and a test scans
the directory for them, so the prohibition is enforced rather than written down.

---

## Sign convention

**ITU-R BT.1359-1: a positive offset means audio is AHEAD of video.** Every number in this document
and in `AvExternalMeasurement.audioAheadMs` uses that convention.

State it on every measurement, because roughly half the published tolerances in this area are
quoted with the opposite sign and **the tolerances are not symmetric** — audio ahead is detectable
at a much smaller magnitude than audio behind. A flipped sign therefore turns a failing measurement
into a passing one rather than merely changing its label.

---

## The tolerances, and the fact that only hardware can check them

| Source | Threshold | Meaning |
| --- | --- | --- |
| ITU-R BT.1359-1 | **detectability**: about **+45 ms** (audio ahead) to **−125 ms** (audio behind) | where an average viewer begins to notice |
| ITU-R BT.1359-1 | **acceptability**: about **+90 ms** to **−185 ms** | where an average viewer objects |
| EBU R37 | **±0**, tolerance **40 ms early / 60 ms late at the point of emission** | a production/emission budget, tighter than the perceptual limits because errors accumulate downstream |

Two things follow, and both are load-bearing:

1. **These are perceptual thresholds in milliseconds of presented output.** Nothing in the list
   above can be evaluated from inside a browser tab, at any sample rate, by any amount of
   cleverness. A number claimed against these thresholds without an instrument is a fabrication.
2. **EBU R37 is an emission budget, not a playback pass mark.** Our player is at the end of a chain
   we do not own. Measure against BT.1359-1 for "is this watchable", and use R37 only when
   arguing with an upstream about what they handed us.

---

## The external procedure: flash and blip

### What you need

- **Synchronised flash-and-blip content.** A clip in which a full-frame flash (black to white for
  exactly one frame) is authored on the *same presentation timestamp* as a short audio blip (a
  1 kHz tone burst of one or two frames' duration). Author several, spaced a few seconds apart, so
  one run yields several samples. Package it through the same DASH and HLS pipeline as real
  content, with clear and test-DRM variants — this is part of the legal test-content task
  `docs/RESEARCH_PLAYBACK.md` calls out, and the fixture belongs beside the multi-period and
  gap-containing manifests, not in a personal folder.
- **Either** a camera and microphone recording the screen and speakers together at a known,
  high frame rate (240 fps gives ±4.2 ms of quantisation; 60 fps gives ±16.7 ms, which is already
  a third of the detectability threshold and is not good enough on its own), **or** a dedicated
  A/V sync analyser with a photodiode and an audio input, which removes the quantisation question
  entirely and is the right purchase if this is done more than a handful of times.
- **Authoring provenance.** Whoever built the clip must state the intended flash-to-blip offset,
  which is zero by construction but must be *asserted*, not assumed. A mis-authored fixture
  produces a confident wrong number for every device measured against it.

### Running it

1. Record the device playing the clip: camera framing the whole screen, microphone in front of the
   speakers or a line tap on the audio output.
2. Note the acoustic path if you used a microphone. **Sound travels roughly 34 cm per millisecond**,
   so a microphone one metre from the speaker adds about 2.9 ms of apparent audio delay. Measure the
   distance and subtract it. A line tap avoids this entirely and is preferred.
3. In the recording, find the video frame containing the flash and the audio sample containing the
   blip onset.
4. `audioAheadMs = (video flash time) − (audio blip time)`, in milliseconds, per BT.1359-1: positive
   means the sound arrived first.
5. Repeat over every flash in the clip and report the **median and the spread**, not one sample. A
   single sample cannot distinguish a fixed offset from a wandering one, and a wandering one is the
   symptom that points at `sequenceMode` or at a segment-duration mismatch rather than at a device
   audio delay.
6. Repeat per device, per browser, per stream type (DASH and HLS), and per DRM configuration.
   These offsets are properties of a *combination*, not of our player.

### Recording the result

File it as an `AvExternalMeasurement`
(`apps/web/src/components/player/diagnostics/av-continuity.ts`). Every field is required and the
requirement is the point: a millisecond offset with no named instrument, no stated uncertainty and
no operator is a proxy wearing a measurement's clothes.

```
evidenceBasis:  "external-measurement"
metric:         "com.liberty-avs-lip-sync-offset"
evidenceSource: "external-av-sync-rig"
audioAheadMs:   <median, BT.1359-1 sign convention>
rig: {
  procedure:               "flash-and-blip",
  instrument:              "<camera model @ fps + mic, or analyser model>",
  instrumentUncertaintyMs: <half a frame period, or the analyser's spec>,
  measuredAtMs:            <supplied by the operator>,
  operator:                "<who>"
}
```

**Nothing in the browser constructs one of these, and a test asserts it.** That is the whole
separation: `audioAheadMs` exists on exactly one branch of the finding union, and that branch is
only reachable from a rig.

### Reading the number

Compare `audioAheadMs` against the BT.1359-1 rows above **after** adding the instrument's
uncertainty as an error bar. A measurement of +40 ms ± 17 ms does not clear the +45 ms
detectability threshold; it straddles it, and the honest report says so rather than rounding in the
direction of the outcome you were hoping for.

---

## Open items this document does not close

- **`control/tasks.json` still records PL-0504's old acceptance** ("Drift measurement contract,
  thresholds, and bounded recovery experiment are implemented"). That premise is the one this
  document rejects. The recorded acceptance needs updating to the approved wording; the task file
  is control-plane state and is not edited by hand.
- **`docs/OBSERVABILITY.md` lists "A/V drift measurement when available"** as a required signal.
  It is never available. That line should become the proxy set named above, with the drift
  measurement moved to this document as an external, hardware-only procedure.
- **The flash-and-blip fixture does not exist yet.** It is a real task with a rights dimension —
  our invariants forbid the usual shortcut of grabbing a clip — and it blocks any actual
  measurement, not just this procedure.
