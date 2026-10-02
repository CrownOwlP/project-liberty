# Licensing of the media binaries Project Liberty ships (PW-0208)

> **Nothing here is legal advice.** It is a precise statement of technical
> facts counsel will need, in the form `docs/DESKTOP_PLAYBACK.md` §9 asks for:
> *"Counsel review is a precondition of shipping, named as such rather than
> assumed."* This document exists so that review has something reproducible to
> look at instead of a binary somebody downloaded.

**Status of this round.** The build recipe, the exclusion list, the pinned
versions and the patent finding below are complete and reviewable. The
**installer-delivered** half of the obligations — the written offer, the
licence texts and the attribution surface — is specified here and **not yet
implemented**, for a surface reason stated in §7. The patent finding in §6 is
a **stop-and-report**, which is what PW-0208's own acceptance instructs when
one is found.

---

## 1. The problem in one paragraph

mpv is GPLv2+ **by default** and LGPLv2.1+ **only if built without its
GPL-only files**. FFmpeg is LGPLv2.1+ **by default** and GPL **if any
GPL-only component is enabled**. A libmpv that links a GPL FFmpeg is a GPL
libmpv no matter how mpv itself was configured, so the licence of the thing we
ship is decided by the *conjunction* of two build configurations, not by
either one. `docs/DESKTOP_PLAYBACK.md` §9 records the consequence: **every
convenient prebuilt libmpv for Windows is a GPL build**, and the one LGPL
variant on offer is LGPLv3-encumbered through a statically linked FFmpeg and
arrives with its builder's own no-warranty disclaimer.

The remedy that section recommends, and that this document makes concrete:
**build both ourselves, from pinned sources, with the flags below, and record
what was actually linked.**

---

## 2. The exact configuration, and why each flag is there

### 2.1 FFmpeg

**Required, and the build must fail if either is present:**

| Flag | Must be | Why |
| --- | --- | --- |
| `--enable-gpl` | **absent** | It is the switch that relicenses the whole of FFmpeg to GPL. [FFmpeg's legal page](https://www.ffmpeg.org/legal.html): *"If those parts get used the GPL applies to all of FFmpeg."* |
| `--enable-nonfree` | **absent** | It produces a binary that is **undistributable at all**, not merely GPL. |
| `--enable-version3` | **absent** | It upgrades the result to LGPLv3, which pulls in GPLv3's Installation Information concept and the anti-tivoization constraint §9 flags against future tamper-resistance work. Nothing we need requires it. |

**Positively asserted:** `--disable-programs` (we ship libraries, not
`ffmpeg.exe`), `--disable-doc`, `--enable-shared --disable-static` (see §4 —
dynamic linking is not an optimisation here, it is the compliance mechanism),
and `--disable-debug` only if symbols are published separately.

**The external libraries FFmpeg itself marks as requiring `--enable-gpl`**, and
which must therefore not appear in our build, from
[`LICENSE.md`](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md):

> avisynth, frei0r, libcdio, libdavs2, librubberband, libvidstab, **libx264**,
> **libx265**, libxavs, libxavs2, libxvid

**Requiring `--enable-nonfree`**, and therefore forbidden outright:

> Fraunhofer FDK AAC, OpenSSL

Note the second one. **OpenSSL is a non-free combination for FFmpeg**, so a
build that reached for it to get TLS would be undistributable; use
`--enable-schannel` on Windows, which is the platform's own TLS and adds no
licence.

**GPL-only files inside FFmpeg** are excluded automatically by omitting
`--enable-gpl` — they are not separately switchable — but they are listed so an
audit can confirm their absence from the built objects: three x86 optimisation
files (`libavcodec/x86/flac_dsp_gpl.asm`, `libavcodec/x86/idct_mmx.c`,
`libavfilter/x86/vf_removegrain.asm`), a set of build and test helpers, and
roughly thirty `libavfilter` filters including `vf_delogo`, `vf_hqdn3d`,
`vf_spp`, `vf_pullup`, `vf_stereo3d` and `vf_lensfun` (which is **GPLv3+**).
None of them is reachable from playback.

### 2.2 mpv / libmpv

| Option | Must be | Why |
| --- | --- | --- |
| `gpl` | **`false`** | Default is `true`. This is the switch that excludes mpv's GPL-only files. |
| `libmpv` | `true` | We ship the library. |
| `cplayer` | `false` | We do not ship `mpv.exe`, and not building it removes a whole class of GPL-only surface. |
| `cdda`, `dvbin`, `dvdnav` | **`disabled`** | GPL-only in mpv, and `libcdio` is on FFmpeg's `--enable-gpl` list as well. Defaults are `auto`, which means *they will be enabled if the libraries happen to be present on the build machine* — the single most likely way an accidental GPL build gets produced. |
| `javascript`, `lua`, `libarchive`, `vapoursynth` | `disabled` | Not GPL problems, but each is a dependency we would have to licence-audit and ship for no gain in an embedded player. |
| `d3d11`, `wasapi`, `spirv-cross`, `shaderc` | `enabled` | The Windows path §1 and §5 of `DESKTOP_PLAYBACK.md` actually use. |

**`auto` IS THE TRAP, NOT `true`.** Every feature option above defaults to
`auto`, which resolves against whatever is installed on the builder. A CI
image that gains `libcdio` in a base-image refresh silently produces a
differently-licensed artifact from the same source and the same command. Every
option that bears on licensing is therefore pinned **explicitly**, including
the ones whose desired value equals today's default.

**What LGPL mode costs on Windows: nothing.** The files `-Dgpl=false` removes
are X11, OSS, VDPAU, VAAPI, jack, DVD, CDDA, DVB, the legacy Direct3D 9 video
output, and the GPLv2+ man pages. The D3D9 VO is **not** `gpu`/`gpu-next` on
`gpu-context=d3d11`, which is the path we use. mpv's own `Copyright` file says
it in terms: *"The intended use for LGPL mode is with libmpv."*

### 2.3 The switch that does not do what it looks like

mpv's `Copyright` is explicit, and it is worth repeating because it is the
sentence most likely to be skipped:

> using the `-Dgpl=false` configure switch does not in itself create a
> LGPLv2.1+ license grant.

It excludes the GPL-only files. **It does not grant anything**, and it says
nothing about what the result is linked against. §2.1 is the other half, and
§5 is how we prove both actually held.

---

## 3. Pinned versions

PW-0207's error mapping is built against a specific libmpv header, so these
are pins rather than minimums, and a change to any of them is a change that
requires requalification of the error table.

| Component | Pin | Notes |
| --- | --- | --- |
| mpv / libmpv | **0.41.0** (released 2025-12-21) | Latest stable at the time of writing. |
| FFmpeg | **9.0.2 "Lei"** (2026-09-18) | Latest stable. 8.1.3 and 7.1.5 are the live fallback branches if 9.x proves too new for libmpv 0.41.0's checks; the decision belongs with the build, not with this document. |
| libplacebo | pinned to whatever mpv 0.41.0 requires | LGPLv2.1+. |

**Recorded as a hash, not a version string.** A version number identifies a
release; it does not identify the bytes we shipped. Each artifact is vendored
into our own store with its **sha256 and provenance**, per §9's
recommendation, which also solves the separate operational problem that the
convenient third-party builders retain artifacts for thirty days.

---

## 4. Dynamic linking is the compliance mechanism, not a build preference

LGPLv2.1 §6 — and LGPLv3 §4, if we ever end up there — require that a user be
able to substitute a **modified** version of the library and still run the
application. The standard way to satisfy this for a closed-source application
is to ship the library as a replaceable DLL:

- `libmpv-2.dll` ships **beside** `liberty-desktop.exe`, never statically
  linked into it;
- nothing in the shell may **signature-check or hash-pin that DLL in a way
  that prevents substitution.** This is a live constraint on any future
  tamper-resistance work and it must be raised before that work is designed
  rather than after;
- the EULA **must not forbid reverse engineering for the purpose of debugging
  modifications to the library.** This is an easy clause to get wrong by
  inheriting boilerplate, and getting it wrong conflicts with the licence we
  are relying on.

---

## 5. The SBOM is built from what was linked, not from what a manifest said

`docs/RESEARCH_PLAYBACK.md`'s finding 2 is the warning: **every prebuilt
`ffprobe` on npm is a GPL-3.0 binary and several declare otherwise in their
package metadata.** An SBOM scanner that reads a top-level `license` field
reports the wrong answer with complete confidence.

So the build must emit, as an artifact alongside the DLL:

1. the **resolved configure line** for FFmpeg and the **resolved meson
   option set** for mpv, as the build system printed them — not as the script
   intended them;
2. the list of libraries **actually linked** into `libmpv-2.dll`, read from
   the binary (`dumpbin /dependents`, plus FFmpeg's own
   `--list-*` / `avutil` build-configuration string, which FFmpeg embeds), with
   each one's licence;
3. an assertion that fails the build if the embedded FFmpeg configuration
   string contains `--enable-gpl`, `--enable-nonfree` or `--enable-version3`.

Item 3 is the one that matters. It is cheap, it is mechanical, and it is the
only check in this document that cannot be satisfied by someone intending to
satisfy it and getting it wrong.

---

## 6. STOP AND REPORT: the patent position on H.264 and HEVC

PW-0208's acceptance says: *"NOT IN SCOPE: any decoder whose distribution
needs a patent licence this project does not hold — if one is required, stop
and report it as a commander decision rather than shipping it."* One is
required. This is that report.

**Copyright licensing and patent licensing are independent.** An LGPL FFmpeg
is correctly licensed under copyright law and says nothing about patents.
[FFmpeg's own legal page](https://www.ffmpeg.org/legal.html) declines to
advise — *"We do not know, we are not lawyers so we are not qualified to answer
this"* — while warning that *"once you start trying to make money from
patented technologies, the owners of the patents will come after their
licensing fees."*

**AVC / H.264.** [Via LA's AVC programme](https://www.via-la.com/licensing-programs/avc-h-264/)
covers decoders incorporated into products distributed to end users, which is
exactly what shipping `libmpv-2.dll` inside a desktop application is. Its
"Codec Products" royalty schedule is, as published: **$0.00 for the first
100,000 units per year** per affiliated legal entity, $0.20 per unit from
100,001 to 5,000,000, $0.10 beyond that, with an annual enterprise cap.

> **The zero is a rate, not an absence.** Below 100,000 units the royalty is
> nil; that is not the same as needing no licence, and it is the distinction
> most likely to be lost in a summary. Which of those two it is, is a question
> for counsel and not for this document.

**HEVC / H.265.** Worse, and structurally so: the patents are split across
**more than one pool** — Via LA's HEVC/VVC programme and Access Advance's HEVC
Advance pool — plus unpooled holders, so there is no single licence that
clears it. Access Advance's published rates changed effective **2026-07-01**.
A product that decodes HEVC is exposed to each of them separately.

**What this means for the build, concretely.** Both decoders are *present* in
any ordinary FFmpeg; disabling them is a `--disable-decoder=h264` /
`--disable-decoder=hevc` away. That is a product decision with a large cost —
it removes most of the content a media application exists to play — so it is
**the commander's and counsel's to make, not this task's**, and PW-0208 stops
here rather than choosing. The three options, stated without a recommendation:

1. ship both decoders and obtain the licences (AVC from Via LA; HEVC from
   each pool plus whatever diligence covers the unpooled holders);
2. ship neither, and rely on the platform's own Media Foundation decoders for
   those two codecs — which shifts the patent position to Microsoft's
   per-machine licensing and costs us the format coverage that motivated
   libmpv in the first place;
3. ship a build limited to royalty-free codecs (AV1, VP9, Opus, Vorbis, FLAC)
   and accept what that excludes.

Nothing in this round assumes an answer, and no build configuration in §2
turns a decoder off on the strength of a guess.

---

## 7. The installer's obligations: what ships, and what does not

The LGPL's **written offer** and **attribution** obligations have to be
satisfied by something the user receives, not by a file in a repository. §9 is
explicit: a sentence in a README nobody ships is not compliance. Concretely,
the installer must carry:

- the full texts of **LGPLv2.1** (and LGPLv3 if we ever take that path), plus
  the licence of every bundled dependency;
- an in-application **"Third-party licences"** view, reachable without a
  network connection;
- a **written offer valid three years** for the complete corresponding source
  of libmpv, FFmpeg and every LGPL dependency actually linked, at the exact
  revisions shipped, **together with the build scripts** — the configure line
  and meson options in §2 are part of "corresponding source", not commentary
  on it.

### What the installer carries as of round 105

The **attribution** half is built and ships. `apps/desktop/scripts/notices.mjs`
decides, `collect-notices.mjs` walks the packaged tree, and
`package-sidecar.mjs` calls it at the end of every package — so the document
is generated from the tree that was just laid out, by the thing that laid it
out, rather than by a second place that has to agree about the layout.

It writes `THIRD-PARTY-NOTICES.md` **into the packaged sidecar directory**,
which `tauri.conf.json` already carries wholesale as a bundle resource
(`"../sidecar/": "sidecar/"`). So the obligation reaches the installed machine
with **no packaging-configuration change** — which matters, because the
Windows packaging job is the only green signal this project has and an
unproven resource glob is a poor way to spend it.

**It never reduces a package to one string.** The declaration and the shipped
licence text are recorded as separate facts and classified against each other
— `declared-and-shipped`, `declared-only`, `shipped-only`, `neither` — because
§5's warning is that the two can disagree. Packages with **no evidence at all**
get their own heading rather than a table row, so they cannot be skimmed past.
The written offer is stated, together with the fact that **nothing shipped
today is LGPL**: the component that will carry that obligation is specified
here and not yet built, and an offer added at the same moment as the binary is
an offer nobody checked.

**Node's own licence now travels with the binary it covers.**
`package-sidecar.mjs` looks for the Node distribution's `LICENSE` beside the
runtime it was told to ship and one directory up — the two places every
mainstream distribution puts it — and copies it into the packaged tree. Node
is MIT and redistributes V8, OpenSSL, ICU and others under their own terms,
all stated in that one file; shipping the executable and leaving the file
behind was an obligation dropped for no reason except that nobody copied it.
The search is **guarded, not assumed**: if no licence is found the packaging
step warns and continues, and the generated notices say in terms that none
accompanied the binary. A packaging step that died there would trade a
missing text file for no installer at all, and the obligation does not
disappear because a file was not found.

`--strict` turns the no-evidence list into a non-zero exit and is
**deliberately not armed**. Arming it from a Linux session would be deciding
that a Windows packaging job should start failing on a list nobody has read.
The first packaging run prints the list; arming the gate is the next decision,
with the list in hand.

### What is still missing

The **in-application "Third-party licences" view**, reachable without a
network connection. That lives under `apps/web/src/app/**`, which is not
PW-0208's write surface, and it is the half a viewer actually sees. The
document above satisfies the obligation to accompany the binary; it does not
satisfy the obligation to be findable by the person using it.

PW-0208 therefore stays `IN_PROGRESS`, and the reason is the patent boundary
in §6 rather than this: the build recipe cannot be exercised, and must not be,
until the H.264/HEVC decision is made.

---

## 8. What is verified, and what is not

**Verified here:** the flag sets in §2 against FFmpeg's and mpv's own licensing
files; the exclusion lists, quoted from `LICENSE.md` and `Copyright`; the
version pins against the projects' release pages; the patent programmes'
published scope and rates against the licensors' own pages.

**UNVERIFIED, and not claimed:** no libmpv or FFmpeg build was produced. This
container's Rust and C toolchains target `x86_64-unknown-linux-gnu`; no
Windows `libmpv-2.dll` was compiled, no configure line was executed, and the
assertion in §5.3 has never run. Every statement about *what our build emits*
is a specification of what it must emit, not a measurement of what it did.

**Also unverified:** the notices generator described in §7 has never run
against a real packaged tree, because packaging happens on Windows. Its
decisions are covered by 17 cases in `apps/desktop/scripts/notices.test.mjs`
and it was exercised end-to-end against a synthetic tree — scoped packages,
the legacy `{ type }` manifest shape, a `LICENSE-MIT` file, a package with no
evidence, and `--strict` exiting 1. What the real dependency tree will say is
a thing the first Windows packaging run prints and nobody here can predict.

**And nothing runs that test suite automatically.** `apps/desktop` has no
`package.json`, so it is not an npm workspace and turbo never reaches it, and
`npm run test:scripts` lives in the root `package.json`, outside this task's
write surface. The same gap applies to `scripts/windows/test-lifecycle.mjs`'s
CI step. Both are named in the round handoff as one finding rather than worked
around twice.

---

## Sources

- [FFmpeg — Legal](https://www.ffmpeg.org/legal.html)
- [FFmpeg — `LICENSE.md`](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)
- [FFmpeg — Download / releases](https://ffmpeg.org/download.html)
- [mpv — releases](https://github.com/mpv-player/mpv/releases)
- [mpv — `Copyright`](https://github.com/mpv-player/mpv/blob/master/Copyright)
- [mpv — `meson.options`](https://github.com/mpv-player/mpv/blob/master/meson.options)
- [Via LA — AVC/H.264 licensing programme](https://www.via-la.com/licensing-programs/avc-h-264/)
- [Via LA — HEVC/VVC licensing programme](https://www.via-la.com/licensing-programs/hevc-vvc/)
- [Access Advance — HEVC Advance pool](https://accessadvance.com/licensing-programs/hevc-advance-patent-pool/)
- `docs/DESKTOP_PLAYBACK.md` §9, `docs/RESEARCH_PLAYBACK.md` finding 2
