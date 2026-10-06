# Experiment 1a — the compositing proof

**Specified in** `docs/DESKTOP_PLAYBACK.md` §10. **This is a throwaway.** It is
not product code, it is not a workspace member, nothing in Project Liberty
imports it, and it is not shipped.

It exists to answer one question that decision **D1 (Tauri)** has rested on
since round 1 and that has never been asked of real hardware:

> Can a child HWND running libmpv composite **beneath** a transparent WebView2,
> with the HTML still visible over the video and still able to receive clicks?

If the answer is no, the pivot is wry/tao, or `webview2` plus
`native-windows-gui` directly — and the right response is to take D1 back
through architecture review, not to work around it here.

---

## What changed since your last run (PL-0750)

**Your last run produced the most useful result this experiment has had, and
it is a failure.** Everything beneath the webview now works and is proven to
work:

| | |
|---|---|
| child HWND geometry | **1280x720** — the `1x1` defect is gone |
| the HEVC file | opens |
| D3D11 on the RTX 3050 | initialises |
| `d3d11va` hardware decode | active |
| the video output | `gpu-next` at 1280x720 |
| the first frame | reported shown |
| the Pause button | reaches mpv |

So **criterion 1 (hardware decode) passes** and **criterion 3 (click and
control) passes**. And you still saw no video at all — only the UI. That is
**criterion 2 (compositing) failing**, and overall **Experiment 1a is NOT
PASS**.

What that combination rules out is almost everything. mpv decoded on the GPU,
configured a video output on a correctly-sized child window, and says it put a
frame on the screen. The child window is in the right place at the right size.
The only thing left between a frame mpv has drawn and an eye that cannot see
it is **what is painted on top of it**.

### What is painted on top of it

Tauri's `transparent: true` makes the **top-level window** layered. It does
*not* stop the WebView2 control inside that window from painting **its own
default background** — an opaque white — across its entire surface. The video
child sits at `HWND_BOTTOM`, behind that surface. An opaque WebView2
background hides it completely, and reports nothing while doing so: no error,
no event, no dropped frame. UI visible, video invisible, every component
insisting it is fine. Which is exactly what you saw.

### What this build does about it

It takes the fallback this README has named since the first version: it
reaches the underlying WebView2 controller through Tauri's `with_webview`,
queries it for `ICoreWebView2Controller2`, and calls
`put_DefaultBackgroundColor` with a fully transparent colour — `A=0, R=0,
G=0, B=0`. That is Microsoft's own API for this exact problem.

**Nothing else changed.** Same child HWND, same `HWND_BOTTOM`, same
`WS_CLIPSIBLINGS`, same mpv properties, same geometry, same diagnostics.

`ICoreWebView2Controller2` is a *later revision* of the controller Tauri hands
out, so the harness has to ask for it rather than assume it. The first lines
of `exp-1a-diagnostic.log` now say which of three things happened, and the
distinction matters:

- **`WebView2 DefaultBackgroundColor set to ARGB(0, 0, 0, 0)`** — the
  background was cleared. If video still does not appear after this line, the
  arrangement itself does not work.
- **`WebView2 put_DefaultBackgroundColor FAILED: ...`** — the call was made
  and refused.
- **`WebView2 ICoreWebView2Controller2 is NOT AVAILABLE ...`** — your
  installed WebView2 runtime is older than this API. That is a **runtime
  version result, not a compositing result**; updating the WebView2 Evergreen
  runtime and re-running is the next step, and Experiment 1a should not be
  recorded either way on it.

### This is the last corrective round

If video still does not show beneath the webview after explicit WebView2
transparency, **Experiment 1a is recorded FAIL** and decision D1 (native
playback architecture) goes back to gpt-architect. No further workaround
layers — no DWM tricks, no layered-window games, no moving mpv into its own
top-level window. At that point "the Tauri arrangement does not support the
compositing this product needs" is the honest finding, and it is worth more
than another round of patches.

---

## The whole run, in four commands

Everything below assumes the artifact has been unzipped to **`D:\exp-1a\`**.
Any folder works; that one is used throughout so the commands can be copied
rather than adapted. Keep `exp-1a.exe` and the mpv DLL **in the same folder** —
the executable loads that DLL by name from its own directory, so moving either
one alone produces a startup failure that looks like a code fault and is not.

```bat
cd /d D:\exp-1a
collect-evidence.cmd
exp-1a.exe "D:\clips\your-4k60-hevc-or-av1.mkv"
```

1. **`cd /d D:\exp-1a`** — the exe must run from its own folder.
2. **`collect-evidence.cmd`** — writes `exp-1a-evidence.txt` beside itself:
   Windows build, GPU and driver, displays, DPI scaling, WebView2 version. It
   starts nothing and changes nothing, and it **cannot observe any of the seven
   criteria** — it records the machine, not the experiment. Run it first so the
   machine is recorded even if the next command fails.
3. **`exp-1a.exe "<your clip>"`** — substitute your own file. With no argument
   it prints what it wants and exits 2 rather than opening an empty window, so
   **double-clicking the exe does nothing useful**.
4. Fill in **`RESULTS-TEMPLATE.md`** and send it back.

`exp-1a.exe` is **UNSIGNED**, so SmartScreen will warn. That warning is
correct: nothing has signed this and this project holds no Authenticode
certificate.

### If something goes wrong, send back these five

Five files, and nothing needs to be summarised or interpreted first — a
description of a failure is worth much less than the failure.

| file | where | why |
|---|---|---|
| **`exp-1a-diagnostic.log`** | **beside the exe, written every run** | **mpv's own account of what it did. This is the first thing to send** |
| `exp-1a-evidence.txt` | beside the exe, from step 2 | the machine it happened on |
| `RESULTS-TEMPLATE.md` | filled in as far as you got | which criterion, and what you saw |
| `PROVENANCE.txt` | in the unzipped folder | which exe and which mpv build |
| a screenshot or short clip | — | for criteria 2, 4 and 5 a picture settles in one second what paragraphs cannot |

**`exp-1a-diagnostic.log` is the first thing to look at and the first thing to
send.** Its opening lines now report whether the WebView2 background was
actually cleared (PL-0750) — read those before anything else, because a run
where the clear failed says nothing about compositing. It exists at all
because the first real run rendered a window, rendered the overlay, played
nothing, and could not say why — `terminal=no` was silencing mpv and nothing was draining its event
queue. The log now carries mpv's verbose output, every event it emits, the
exact file string that was passed and whether it resolved on disk. If the
overlay shows a red bar, that text is in there too, with everything that led
up to it.

Plus whatever the console printed, if it printed anything. If the window never
appeared at all, say so in as many words — "nothing happened" is a specific,
useful result and is not the same as a crash.

---

## What you need, and what you do not

**You do not need:** Rust, a C toolchain, Visual Studio, an mpv build, or any
assembly of dependencies. CI did all of that. You need the harness directory
and a video file.

**You need:**

1. **This directory, unzipped onto the machine under test.** `exp-1a.exe` and
   the mpv DLL beside it must stay in the same folder — the executable loads
   that DLL by name from its own directory.
2. **A local 4K60 HEVC or AV1 file.** Local, so there is no network variable
   and no rights question. 4K60 HEVC/AV1, because the hardware-decode
   criterion is the one that needs real work from the GPU — a 1080p H.264 clip
   will still show compositing, but a pass recorded from one **is not a pass**
   for criterion 1.
3. **WebView2 Evergreen runtime.** Present on any current Windows 10/11; if
   the window opens blank this is the first thing to check.

`exp-1a.exe` is **UNSIGNED**. SmartScreen will warn. That warning is correct —
nothing has signed this and this project holds no Authenticode certificate.

## Running it

```
exp-1a.exe "D:\clips\some-4k60-hevc.mkv"
```

Run it with no argument and it prints what it wants and exits 2, rather than
opening a window with nothing in it.

You should see a 1280×720 window: video filling it, a semi-transparent
gradient panel over the video, a spinner, a large button, and a table of mpv
properties updating about ten times a second.

---

## Pass criteria — all seven must hold

These are §10's, unchanged. **Every one is something a person has to look at.**
Record each as PASS / FAIL / NOT-TESTED in `RESULTS-TEMPLATE.md`; a criterion
you could not test is **not** a pass, and the template has a column for that
on purpose.

| # | Criterion | How to tell |
|---|---|---|
| 1 | Video plays **hardware-decoded** | Task Manager → Performance → GPU → the **Video Decode** graph is above zero, **and** the overlay's `hwdec-current` row is not `no` |
| 2 | HTML is **composited over** the video with real alpha | The gradient **tints** the video. If the panel is an opaque rectangle, or the video is invisible behind it, this fails |
| 3 | The button **receives clicks** and pauses playback | Click it: `pause` flips in the table and the picture stops. If nothing happens the child HWND ate the hit-testing |
| 4 | **Resize and drag keep video and UI locked together** | Drag the window edge slowly, then fast; drag the window fast between two monitors. No tearing, no lag, no letterbox flicker |
| 5 | **Per-monitor DPI change** breaks neither layout nor geometry | Drag onto a 150%-scaled display. The video must still fill the client area and the panel must still be where it was |
| 6 | `avsync` and `time-pos` **stream at a usable rate** | The rows visibly move. You can watch `avsync` drift |
| 7 | All of the above **on the matrix** | Below. This is the part most likely to be skipped |

### The matrix

| Axis | Values | Why it is in the matrix |
|---|---|---|
| OS | Windows 10 22H2 · Windows 11 24H2+ | WebView2 behaviour and DWM differ |
| GPU | Intel/AMD iGPU · NVIDIA dGPU · **a hybrid-graphics laptop running both** | Hybrid graphics is the classic failure case for child-HWND composition, and it is the configuration most of our users have |
| DPI | 100% · 150% · **a drag between two monitors at different scalings** | Per-monitor DPI transitions are where geometry breaks |

A result from one machine is a real result and worth recording. It is not the
matrix, and `RESULTS-TEMPLATE.md` will not let it be filed as one.

---

## What a build of this proves, and what it does not

CI (`.github/workflows/experiment-1a.yml`) **links** this binary against a real
libmpv — not a type-check, a link — so the artifact you were handed is known to
build rather than hoped to.

**That is the entire claim.** A green CI run says nothing about any of the
seven criteria. Nobody may record Experiment 1a as PASS from a compilation.

Three things are deliberately kept apart here, and must stay apart:

- **The technical compositing result** — what this experiment measures.
- **LGPL compliance** — the mpv DLL beside this executable is a **third-party,
  GPL-licensed** development build. §10 specifies this experiment with "no LGPL
  build" on purpose, so that a compositing failure cannot be confused with a
  fault in our own libmpv. It is not the §9 LGPL build, it is not a component
  of Project Liberty, and it must never be redistributed inside a Liberty
  artifact. `PROVENANCE.txt` in the handed-over directory records exactly which
  build it is.
- **Codec patent authorization** — untouched, and not inferable from anything
  here. Playing an HEVC file you own on your own machine is not distribution
  authorization for an HEVC decoder.

## What is deliberately absent from the harness

No Next.js, no sidecar, no adapter, no product code, no provider, no network,
no DRM routing, no packaging, no LGPL build. Every one of them would make a
failure ambiguous, which is the one thing this experiment cannot afford.

Two deviations from §10's text, both deliberate and both recorded here:

- **Tauri 2.12.0, not 2.11.5.** That is the version `apps/desktop/src-tauri`
  pins. Testing the version the product actually uses is a stronger result
  than testing the version the document happened to name.
- **§10 step 2's fallback is now built (PL-0750), because a real run
  demanded it.** Through PL-0749 the harness reached webview transparency
  through Tauri's `transparent: true` alone, and that was the right call at
  the time: building the fallback speculatively would have added a second
  variable to a failure. The Round-123 run removed the speculation. Criterion
  2 failed with mpv fully exonerated, which is the precise condition the
  fallback exists for, so the harness now also calls
  `ICoreWebView2Controller2::put_DefaultBackgroundColor(0, 0, 0, 0)` through
  the underlying controller. It is reached by querying the controller Tauri
  returns for the later interface, and all three outcomes — set, refused,
  interface unavailable — are named in the diagnostic log.
