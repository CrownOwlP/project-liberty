# Research — playback, player UI, telemetry and media inspection

> Compiled 2026-08-18. Every version, licence and date below was verified against a live
> source at that time, not recalled. Re-verify before acting on anything more than a week old;
> the whole point of this document is that stale dependency advice is expensive.

This covers PL-0501, PL-0502, PL-0503, PL-0504 and the media-inspection service that
`gpt-architect` ruled must sit behind its own boundary rather than inside `@liberty/provider-sdk`.

Nothing here is a decision. It is evidence for decisions, and several items need an
architecture ruling before they become tasks.

---

## The five findings that change what we build

1. **Do not run `ffprobe` against a manifest.** `hls_read_header()` opens *the first segment of
   every selected playlist*, so probing a master playlist downloads real media. Parse HLS and
   DASH manifests directly instead: they already declare `BANDWIDTH`, `RESOLUTION`, `CODECS`,
   `FRAME-RATE` (`#EXT-X-STREAM-INF`) and `@bandwidth`, `@width`, `@height`, `@codecs`
   (DASH `Representation`). That is one small GET instead of megabytes, it returns the *whole*
   ladder rather than one variant, and it removes the DASH/TS demuxer CVE surface from the hot
   path entirely. This decouples PL-0205's unknown-metadata problem from every FFmpeg licensing
   and sandboxing question.

2. **Every prebuilt `ffprobe` on npm is a GPL-3.0 binary, and several declare otherwise.**
   `ffprobe-static` declares MIT; `@ffprobe-installer/ffprobe` and `@ffmpeg-installer/ffmpeg`
   declare LGPL-2.1. All three ship GPL-3.0 builds. An SBOM scanner reading the top-level
   `license` field will report the wrong thing, and we would ship GPL-3.0 believing we shipped
   LGPL. `fluent-ffmpeg` is deprecated on npm and its repository was archived by the owner in
   May 2025.

3. **A browser cannot detect that lips are out of sync.** There is no audio clock for a
   `<video>` element; `video.currentTime` is the spec's "official playback position", not a
   clock; final alignment happens in the compositor and the OS audio stack. Routing through
   WebAudio to measure it makes things worse and is DRM-adjacent — W3C Bug 17347 is closed
   WONTFIX for exactly this reason. **PL-0504 needs reframing**: either it ships documented
   *proxies* (labelled as proxies), or it needs an external flash-and-blip rig. Shipping a proxy
   labelled as truth would be the same defect this project keeps rejecting elsewhere.

4. **Vidstack is effectively abandoned.** `vidstack` and `@vidstack/react` stable are both
   0.6.15, published April 2024; real work sits on a `next` tag that was never promoted. The
   maintainer joined Mux and is folding the work into a new player. Recommendation is
   **media-chrome** (MIT, Mux, first-party React wrappers, official Next.js TypeScript example).

5. **`shaka-video-element` hard-pins `shaka-player@~4.15.4`** while current is 5.2.6, and would
   silently install a second Shaka. Shaka 5.x is where CMCD v2 Event Mode lives, so this is not
   cosmetic. Build our own `<liberty-video>` on Mux's `custom-media-element` base class and read
   `shaka-video-element` as the reference implementation.

---

## Playback engine

**Shaka Player 5.2.6, Apache-2.0.** Bundled TypeScript definitions ship in the package, so the
common "you need a `global.d.ts`" advice is stale. Maintenance policy is unusually disciplined:
at most one breaking release per year, fixes backported to the two most recent release branches
plus a one-year LTS. Pin `~5.2.x` and budget one upgrade a year.

Two operational notes. The package unpacks to ~88 MB across 653 files — install and CI cost, not
bundle cost, but never import it from shared code. And `dist/shaka-player.compiled.js` is
Closure-compiled UMD, not ESM, so it will not tree-shake; measure the gzip cost at integration
and treat it as fixed overhead.

Integrate directly in a `"use client"` component importing Shaka inside `useEffect`, so the
module never enters the RSC graph. There is no maintained first-party React wrapper and none
worth the dependency. **Do not use the Shaka UI build** — it constructs the Player for you, is
driven by DOM attributes, and its Chromecast support needs a per-release receiver app ID only
Google can register. Its keyboard map is worth copying as a spec.

Shaka is browser-only. Enforce it mechanically with an import boundary preventing it from being
reachable from `app/api/**` or any server component.

---

## Failover — what Shaka actually gives us

Four surfaces at four blast radii: `shaka.util.Error.severity` (`CRITICAL` vs recoverable, which
is the fatal/non-fatal split handed to us); `streaming.failureCallback` with
`player.retryStreaming()` as the cheapest recovery; the `NetworkingEngine` `retry` event, which
can be `preventDefault()`ed to stop retries dead once a candidate is known dead; and three
independent `retryParameters` blocks (`drm`, `manifest`, `streaming`) that should be tuned
separately rather than left at defaults.

**The limitation to design around:** Shaka has no API to swap the source of a live session.
`player.load(newUri)` is a teardown — stats reset, buffer gone, position must be re-seeked, DRM
re-established. Two things change bytes without a session restart: `NetworkingEngine` request
filters (true zero-interruption CDN/edge failover *within* one candidate, and the right layer for
host-level failover — it belongs in `@liberty/media-engine`, not in a provider adapter), and
`preload()` / `PreloadManager` to warm candidate *n+1* while *n* still plays. So candidate-level
failover is a restart; make it a fast restart and do not pretend otherwise in the API contract.

**Two traps.** Error `data` is a positional array whose shape differs per error code — Shaka's own
docs warn "each type of error has its own data structure (or none at all)". Failover correctness
depends on decoding these, so it needs one typed adapter pinned to the Shaka minor with a test
that fails loudly on upgrade, not indexing scattered across call sites. And retries for failed
network requests are **not** reported as recoverable errors, so retry-storm telemetry must come
from the `retry` event or it will not exist.

Two hard requirements for every provider adapter, worth stating in `docs/API_CONTRACTS.md`:
CORS must allow the `Range` header, and every manifest and segment URL must be `https:`. A
candidate failing CORS preflight is unplayable in a way that looks like a generic network error.

---

## Player state machine (PL-0502)

XState 5.32.5, MIT, healthy. Worth adopting, but **scoped hard**.

media-chrome already owns UI state — controls visibility, hotkeys, menus, fullscreen requests —
via `<media-controller>`, and duplicating that in XState is the over-engineering failure mode.
Model only the session and candidate lifecycle: `idle → resolving → engineLoading →
loading(candidate n) → playing ⇄ buffering ⇄ seeking → {recovering | failingOver(n+1) | fatal} →
ended`, with orthogonal regions for drift monitoring and telemetry. That is roughly 150 lines, it
is the genuinely hard part, and `xstate/graph` can generate exhaustive path tests over failover —
which alone justifies the dependency for a five-candidate policy.

**The machine must be a mirror of truth, not the source of truth.** The `<video>` element and
Shaka are authoritative; the machine is a validated projection. Every browser and Shaka event
needs an inbound transition even in states where it "can't" happen. Teams that invert this end up
with desynced players — this is the explicit retrospective lesson from the most mature public
example of a video statechart.

Also worth copying from that example: every side effect declared as a named no-op and injected,
so the machine is pure and unit-testable without a DOM.

---

## Telemetry (PL-0503)

**Adopt CMCD v2 (CTA-5004-B, published April 2026) as the canonical vocabulary. Do not invent
metric names.** v2 added Event Mode — batched POSTs to a collector with `Content-Type:
application/cmcd` — which makes it a complete QoE wire protocol rather than just a CDN hint. The
QoE keys we need already exist: `msd` (media start delay), `bs`/`bsa`/`bsd`/`bsda` (buffer
starvation), `dfa` (dropped frames), `ltc` (live latency), `sta`, `ec`, `ttfb`/`ttlb`.

**Shaka has built-in CMCD v2 support including Event Mode**, config-only, vendoring the SVTA
`@svta/cml-cmcd` library — so batching, sequence numbers, retry, and once-per-session `msd`
gating are free and spec-correct, at roughly zero bundle cost. Event-mode POSTs route through
`NetworkingEngine`, inheriting our auth and request filters.

Three traps in Shaka's `getStats()`: all time fields are **seconds** while CMCD is
**milliseconds** (the most likely unit bug in this task); unavailable numerics are `NaN`, not
`null` or `0`; and `loadLatency` is **not** startup time — its own JSDoc says it does not imply
playback can start. `timeToFirstFrame` is startup time and is what maps to `msd`.

`stateHistory` and `switchHistory` are the reason trail invariant 4 asks for. `switchHistory`'s
`fromAdaptation` flag distinguishes ABR decisions from application `selectTrack()` calls, which is
precisely what makes the trail explanatory rather than merely descriptive.

**Rejected:** CTA-2066 is dead (no revision letter, tracker last active 2019, no implementations)
— borrow its rebuffering-ratio definitions, do not claim conformance. **Do not put OpenTelemetry
in the player bundle**: browser instrumentation is explicitly experimental, every OTLP exporter is
on the experimental track, and OTel is deprecating the Span Events API in favour of logs. Convert
CMCD to OTel at the server boundary, where the Node SDK is stable and `@liberty/observability`
already lives.

**Leak warning.** The CMCD `url` and `nor` keys carry media URLs including signed query strings
into telemetry. Keep `eventTargets` first-party only and strip or hash those server-side. This is
the same class of leak as the ffprobe `format.filename` problem below, through a different pipe —
one shared redaction helper in `@liberty/observability` should serve both.

---

## A/V sync (PL-0504) — reframe the task

See finding 3. What *is* observable and worth building:

- **`requestVideoFrameCallback`** — widely supported, but still a WICG draft with no strict timing
  guarantees. Unit trap: `mediaTime` and `processingDuration` are seconds while
  `presentationTime` and `expectedDisplayTime` are milliseconds. `mediaTime` may be 0 on live.
- **The highest-value detector is the "video hole"** — a discontinuity in the video SourceBuffer
  at the playhead while audio is contiguous across it. hls.js ships `nudgeOnVideoHole` for exactly
  this, citing a Chrome bug where playback continues past a video gap without rendering and then
  stalls. Detectable, loggable, recoverable. Make it experiment arm #1.
- **Assert `sequenceMode: false` explicitly** for both DASH and HLS. It is already the default, but
  there are current reports of drift after upgrading without setting it, and fMP4 segments carry
  accurate `tfdt`/`trun` timestamps that MSE segment mode uses correctly.
- **`HTMLMediaElement.buffered` is the intersection of all SourceBuffers** — read
  `sourceBuffer.buffered` per track or the measurement is meaningless.
- No standard metric name for drift exists anywhere. Coin `com.liberty-avs-*`, document them as
  proxies, and adopt ITU-R BT.1359-1's sign convention (positive = audio ahead) so a future
  external measurement is comparable.

---

## Media inspection service

**Recommendation: manifest parsing first, `ffprobe` reserved for progressive inputs and QC
reconciliation.** `m3u8-parser` (Apache-2.0, Brightcove, powers video.js VHS) and `mpd-parser`
(Apache-2.0, same family, actively maintained) normalise both into one shape. Note `mpd-parser`
depends on `@xmldom/xmldom`, which will parse attacker-influenced MPDs — pin it exactly and
size-limit the body before parsing.

Where `ffprobe` genuinely earns its place: a publisher can misdeclare a manifest, and **probed
facts versus provider-stated facts is exactly the provenance split the architect asked for.** The
divergence between them is a first-class signal, not merely metadata. Preserve
`{ videoCodec: "hevc", mediaEvidence: { videoCodec: { source: "probe", observedAt } } }` rather
than collapsing to a fact of unknowable origin.

**If we do run it:** the licensing answer is *don't distribute* — run it only in containers we
operate and never publish, making the media-inspection image private-registry-only. LGPL and
GPL-2 are not network-copyleft, so obligations never trigger. If images must be published, use a
`linux64-lgpl-shared` build and note it is LGPL-**3.0**, not 2.1.

**SSRF is wide open by default** — FFmpeg's docs state all protocols are allowed unless
restricted, so a bare `ffprobe <url>` accepts `file:`, `concat:`, `data:`, `unix:` and is a full
SSRF plus arbitrary-file-read primitive. And for HLS/DASH the input is second-order: whoever
controls the manifest controls the URLs ffprobe opens. Required: `-protocol_whitelist https,tls,tcp`
(never built from input), egress allowlist, DNS resolved by us with private-range rejection
*before* invoking, IP pinning against rebinding, and redirect validation — an allowlisted CDN
that 302s to a metadata endpoint bypasses hostname checks entirely.

**Credential leakage is unconditional**, not incidental: the official schema declares
`formatType/@filename` as required, so with `-show_format` the input URL including its signed
query string is always in the output and in error strings. The right fix is proxy indirection —
ffprobe fetches from an internal proxy with an opaque single-use token and never sees a
credential, which also gives us egress allowlisting and redirect control in one component.
Scrubbing in the parser is the second line; log redaction is only a backstop.

Sandbox as though there are unpatched bugs, because there are: recent CVEs include heap overflows
in the DASH demuxer triggered by manifest content and in the TS demuxer, and agent-driven fuzzing
found 21 new FFmpeg bugs in mid-2026 for about a thousand dollars of compute. "We're on latest" is
not containment.

---

## Sequencing notes

- **Build `<liberty-video>` first, thin.** It is the shared dependency of PL-0502, PL-0503 and
  PL-0504; once it exists those three proceed in parallel on disjoint paths.
- **The manifest-parser path has no FFmpeg dependency**, so media inspection can ship before any
  licensing or sandboxing decision is finalised. That takes the slowest legal question off the
  critical path.
- **Legal test content is a real task, not a footnote.** Our invariants forbid the usual
  shortcuts. Package public-domain sources into DASH and HLS with clear and test-DRM variants and
  check the output into fixtures. Multi-period, gap-containing and deliberately-broken manifests
  are needed to test failover at all.
- **PL-0501 is the rights-enforcement point.** The session response should be a discriminated
  union on outcome (`granted` | `denied` | `unavailable`) with `reasons` on *every* branch, not an
  optional field — a denial with no reason trail violates invariant 4 as much as a grant with none.
  Licence tokens must be short-lived and session-scoped, never a static licence URL in the bundle.
- **Define the hls.js contingency trigger now**, as a testable statement rather than a reflex:
  the concrete thing to measure is iOS/Safari, where Shaka may fall back to native `src=` HLS and
  lose the reason trail that `getStats()` and CMCD depend on.
