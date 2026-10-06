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

## What changed since your last run (PL-0749)

Your run was not a failure of this experiment — it was a failure of one line
in it. The diagnostic log was decisive: the file opened, HEVC was detected,
mpv initialised, D3D11 came up on the RTX 3050, `d3d11va` hardware decoding
was active, the VO reported `gpu-next 1920x1080 d3d11[nv12]`, the first frame
rendered and playback completed. Everything worked. And mpv reported
**`Window size: 1x1`**.

`create_child` built the video window at the right size and then, one
statement later, called `SetWindowPos` with `cx=0, cy=0` and without
`SWP_NOSIZE` — so it was resized to nothing before mpv ever saw it. `fit_child`
would have corrected it, but it was wired only to resize and DPI events, and
you never resized the window.

Fixed: the real client dimensions are passed, and `fit_child` now runs once
immediately after mpv initialises instead of waiting for an event that may
never arrive. Nothing else changed — same child HWND, same z-order, same
transparency, same mpv properties, same logging.

**This still proves nothing about the seven criteria.** It means the video has
somewhere to be drawn. Whether it composites correctly beneath the overlay is
what you are about to find out.

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

**`exp-1a-diagnostic.log` is new (PL-0748)** and exists because the first real
run rendered a window, rendered the overlay, played nothing, and could not say
why — `terminal=no` was silencing mpv and nothing was draining its event
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
- **§10 step 2's fallback is not pre-built.** The harness reaches webview
  transparency through Tauri's `transparent: true`. If criterion 2 fails
  *specifically* as "the whole top-level window is translucent" rather than
  "the panel is opaque", the documented next move is to call
  `ICoreWebView2Controller2::put_DefaultBackgroundColor(0,0,0,0)` through the
  underlying controller. Building that path speculatively would have added a
  second variable to a failure.
