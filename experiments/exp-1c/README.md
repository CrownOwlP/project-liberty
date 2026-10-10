# Experiment 1c — the compositing proof, second attempt

**Specified against** `docs/DESKTOP_PLAYBACK.md` §1 and §10. **This is a
throwaway.** It is not product code, it is not a workspace member, nothing in
Project Liberty imports it, and it is not shipped.

---

## Why there is a 1c at all

**Experiment 1a failed.** It asked whether a child HWND running libmpv can
composite beneath a transparent WebView2, and after three runs on your machine
the answer was no — with mpv completely exonerated:

| | |
|---|---|
| the local HEVC file | opened |
| D3D11 on the RTX 3050 | initialised |
| `hwdec-current` | `d3d11va` — hardware decode active |
| video output | `gpu-next`, 1280x720 |
| first video frame | reported **shown** by mpv |
| the child HWND | 1280x720, correct, at `HWND_BOTTOM` |
| the Pause button | reached mpv |
| `put_DefaultBackgroundColor(0,0,0,0)` | **accepted and reported successful** |
| **what you saw** | **the UI, and no video at all** |

Criterion 1 PASS, criterion 3 PASS, criterion 2 FAIL. Nothing left to fix
inside that arrangement, so this is a different arrangement.

## What changed, in one picture

**1a — two windows, and window z-order decided what you saw:**

```text
Top-level HWND
├── child HWND          ──►  mpv --wid                      (below)
└── WebView2 controller's own HWND, DefaultBackgroundColor A=0   (above)
```

**1c — no windows, one visual tree, and DWM composites it:**

```text
Top-level HWND  (paints nothing at all; no background brush)
└── IDCompositionTarget
    └── root visual
        ├── video visual  ──►  SetContent(mpv's composition swapchain)  (below)
        └── web  visual   ──►  SetRootVisualTarget on the WebView2
                               COMPOSITION controller                   (above)
```

Three things make that buildable, and each was verified by reading source
rather than by hoping:

- **mpv** takes `--d3d11-output-mode=composition`, which creates its D3D11
  swapchain with **no window at all**, sizes itself from
  `--d3d11-composition-size=<WxH>`, and publishes the swapchain's address
  through the `display-swapchain` property. All three exist at the **exact mpv
  commit this project already pins**, so the DLL beside this exe is the same
  one 1a used.
- **WebView2** has a second kind of controller —
  `CreateCoreWebView2CompositionController` — that renders into a DComp visual
  you give it instead of into a window of its own.
- **DirectComposition** puts both in one tree, where "above" is a property of
  the tree rather than of a window hierarchy.

## Why this one is not a Tauri app

Composition hosting is a **creation-time** decision: the webview has to be
created through `CreateCoreWebView2CompositionController` *instead of*
`CreateCoreWebView2Controller`. wry — and so Tauri — always creates a
**windowed** controller and hands it out afterwards, and there is no way to
convert one into the other. That is why
[tauri-apps/wry#1762](https://github.com/tauri-apps/wry/pull/1762), which adds
exactly this, is a change *inside* wry rather than something an app can do from
outside.

So this experiment owns its window, its message loop and its webview creation.
Measured rather than estimated: **1,482 lines of Rust** (1,040 once comments
and blanks are removed) in six files, and **24 packages in the whole locked
dependency graph** against Experiment 1a's 419 — dropping Tauri is most of
that. Experiment 1a was 672 lines, so 1c is roughly twice the code and a
seventeenth of the dependencies, which is the trade this arrangement makes:
the host does by hand what wry would otherwise do for it.

That is over §10's "under 300 lines" budget, which was written for 1a and for
the `wid` arrangement. The extra lines are not features — they are the window,
the message loop, the DComp tree, and the mouse and DPI forwarding a
composition-hosted webview cannot do for itself. Worth saying rather than
quietly exceeding.

**The Liberty application is untouched.** If 1c passes, *how* that reaches the
product is a separate decision and gpt-architect's to make.

---

## The whole run, in three commands

Everything below assumes the artifact has been unzipped to **`D:\exp-1c\`**.
Any folder works; that one is used throughout so the commands can be copied
rather than adapted. Keep `exp-1c.exe` and the mpv DLL **in the same folder** —
the executable loads that DLL by name from its own directory, so moving either
one alone produces a startup failure that looks like a code fault and is not.

```bat
cd /d D:\exp-1c
collect-evidence.cmd
exp-1c.exe "D:\clips\your-4k60-hevc-or-av1.mkv"
```

1. **`cd /d D:\exp-1c`** — the exe must run from its own folder.
2. **`collect-evidence.cmd`** — writes `exp-1c-evidence.txt` beside itself:
   Windows build, GPU and driver, displays, DPI scaling, **WebView2 version and
   `dcomp.dll` version**. It starts nothing and changes nothing, and it
   **cannot observe any of the eight criteria** — it records the machine, not
   the experiment. Run it first so the machine is recorded even if the next
   command fails.
3. **`exp-1c.exe "<your clip>"`** — substitute your own file. With no argument
   it prints what it wants and exits 2 rather than opening an empty window, so
   **double-clicking the exe does nothing useful**.

`exp-1c.exe` is **UNSIGNED**, so SmartScreen will warn. That warning is
correct: nothing has signed this and this project holds no Authenticode
certificate.

## What you should see if it works

A 1280x720 window. A dashed white frame 8px inside it, and the video filling
that frame exactly. A **magenta-to-cyan wash across the whole window that tints
the moving picture rather than covering it**. A translucent panel at the top
left with a blurred background, a spinning indicator, a Pause button, a click
counter and a live table of mpv properties with `time-pos` advancing.

**Criterion 2 is the gradient, and there are three different-looking outcomes:**

- video visible **and tinted** magenta/cyan → **pass**
- video visible but the gradient **invisible** → the page is drawing and its
  alpha is being thrown away → **fail**, and worth saying separately
- **no video**, gradient over black → the same symptom 1a produced → **fail**

The dashed frame exists so that "the video is there but offset or wrongly
scaled" and "there is no video" cannot be confused.

## Read the log before concluding anything

**`exp-1c-diagnostic.log`**, beside the exe, written every run. Every
construction step reports its own outcome as `STEP` / `OK` / `FAIL`, so a run
that shows nothing says *where* it stopped. That is the single most valuable
thing three rounds of Experiment 1a taught, and it is why this experiment has
it from the first build rather than from the third.

**Find the first `FAIL` line.** Three of them mean the run cannot be used to
judge the arrangement at all:

| the log says | what it means | what to do |
|---|---|---|
| `ICoreWebView2Environment3 is NOT AVAILABLE` | the WebView2 Evergreen runtime predates composition hosting | update the runtime, re-run. **Not a 1c result** |
| `mpv has not published a composition swapchain after 50 polls` | either no video output came up — check `current-vo` and `vo-configured` in the panel and mpv's own log lines above — or this libmpv predates `--d3d11-output-mode` | **Not a 1c result** |
| `DCompositionCreateDevice failed` | DirectComposition is unavailable on this machine | **Not a 1c result** |

A run with **no `FAIL` line and still no video** is the real result this
experiment exists to produce, and it is the one that sends decision D1 to the
pivot. A run where `SetContent` is accepted and the picture appears is the one
that saves it.

## If something goes wrong, send back these five

Nothing needs to be summarised or interpreted first — a description of a
failure is worth much less than the failure.

| file | where | why |
|---|---|---|
| **`exp-1c-diagnostic.log`** | **beside the exe, every run** | **every construction step and mpv's own account. The first thing to send** |
| `exp-1c-evidence.txt` | beside the exe, from step 2 | the machine it happened on |
| `RESULTS-TEMPLATE.md` | filled in as far as you got | which criterion, and what you saw |
| `PROVENANCE.txt` | in the unzipped folder | which exe and which mpv build |
| a screenshot or short clip | — | for criteria 1, 2, 5 and 6 a picture settles in one second what paragraphs cannot |

If the window never appeared at all, say so in as many words — "nothing
happened" is a specific, useful result and is not the same as a crash.

---

## The eight criteria

Copied from the commander's instruction rather than paraphrased. Every one of
them is something **a person has to look at**; none can be established by CI.

1. Video visibly playing underneath the HTML overlay.
2. Real transparency — the HTML gradient tints the video.
3. Clickable HTML controls that pause and resume playback.
4. Active GPU hardware decoding.
5. Correct resizing and window movement.
6. Correct DPI behaviour.
7. Live playback telemetry, including `time-pos` and `avsync`.
8. No orphaned processes or unacceptable shutdown behaviour.

**The matrix from §10 still applies and is still unmet**, and it is the part
most likely to be skipped:

| Axis | Values | Why |
|---|---|---|
| OS | Windows 10 22H2, Windows 11 24H2+ | WebView2 behaviour and DWM differ |
| GPU | Intel/AMD iGPU, NVIDIA dGPU, **and a hybrid-graphics laptop running both** | hybrid graphics is the classic failure case for composition and it is the configuration most users have |
| DPI | 100%, 150%, **and a drag between two monitors at different scalings** | per-monitor DPI transitions are where geometry breaks |

A pass on one machine is one cell. It is enough to change the architecture
conversation; it is not enough to close the experiment.

---

## What is deliberately absent

No Tauri, no Next.js, no sidecar, no adapter, no product code, no provider, no
network, no DRM routing, no packaging, no LGPL build. Every one of them would
make a failure ambiguous, which is the one thing this experiment cannot afford.

**Touch and pen input are also absent**, deliberately. A composition-hosted
webview gets no input from Windows at all, so this host forwards mouse messages
to `SendMouseInput` and hands focus over with `MoveFocus` — which is what
criterion 3 needs. `SendPointerInput` for touch and pen is *not* implemented:
wry's own PR describes its touch path as best-effort with zeroed himetric
fields, none of the eight criteria is about touch, and a half-working path
nobody has tested would be a second variable in a failure.

**OLE drag-and-drop is not implemented either**, for the same reason and with
the same precedent — wry#1762 calls its own drag-drop untested in composition
mode and the app that produced it disables the feature.

## What compiling proves

That the harness builds and links. Nothing else. `cargo check` cannot even
prove that much here: `libmpv2-sys` emits `cargo:rustc-link-lib=mpv` and
nothing more, and this experiment additionally links `dcomp.dll` and
WebView2's loader, so the question is decided at a link step `check` skips.

**A green CI run is not a pass**, and no gate in this project may claim one
from it. It has been three rounds since anything was claimed from a green
build, and that is not going to change here.
