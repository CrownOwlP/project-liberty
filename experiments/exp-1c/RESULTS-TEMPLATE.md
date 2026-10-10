# Experiment 1c — result sheet

Copy this file, fill it in on the machine, and paste it back. One copy **per
machine**: the matrix is three axes and a single machine is one cell of it.

> **NOT-TESTED is a legitimate answer and the most useful one you can give for
> something you could not try.** A criterion marked PASS that was not actually
> observed is the only outcome here that costs more than a failure, because
> decision D1 would then rest on it.

## Before anything else: the first FAIL line

`exp-1c-diagnostic.log` is written beside the exe on every run and reports each
construction step by name. **Find the first line beginning `FAIL` and paste it
here**, because two of the possible outcomes are not results about compositing
at all:

| if the log says | then |
|---|---|
| `ICoreWebView2Environment3 is NOT AVAILABLE` | the WebView2 Evergreen runtime is too old for composition hosting. **Update it and re-run.** Do not record 1c either way |
| `mpv has not published a composition swapchain` | either no video output came up, or this libmpv predates `--d3d11-output-mode=composition`. Do not record 1c either way |
| `DCompositionCreateDevice failed` | DirectComposition is unavailable on this machine. Do not record 1c either way |
| no `FAIL` line at all, and still neither layer visible | **that is the real result this experiment exists to produce.** Say so plainly |

First FAIL line (or "none"):

```
```

## Then these four lines, whether or not anything said FAIL

They are what settle an empty overlay, and three of them are new this round.
Paste each verbatim.

`IsVisible READ AS ...` (this is the one that would have explained the last run
on its own):

```
```

`NavigationCompleted: ...`:

```
```

`DOMContentLoaded: ...` (or the line saying `ICoreWebView2_2 unavailable`):

```
```

`the page reported itself ALIVE: {...}` — the `innerWidth`/`innerHeight` in it
matter: `0` means the page had no area to draw in:

```
```

## The machine

| | |
|---|---|
| Windows version / build | |
| GPU(s) — and whether hybrid | |
| Graphics driver version | |
| Display(s): resolution, refresh, scaling | |
| WebView2 runtime version | |
| `dcomp.dll` version | |

`collect-evidence.cmd` fills all six of these into `exp-1c-evidence.txt`. Paste
that file in rather than typing them.

## The clip

| | |
|---|---|
| Container / codec / resolution / fps | |
| How you know (e.g. `mediainfo`, mpv's own log lines) | |

If this is not 4K60 HEVC or AV1, criterion 4 cannot be a PASS — mark it
NOT-TESTED and say why here.

## The eight

| # | Criterion | PASS / FAIL / NOT-TESTED | What you actually saw |
|---|---|---|---|
| 1 | **Video visibly playing underneath the HTML overlay** | | |
| 2 | **Real transparency** — the magenta-to-cyan gradient *tints* the moving picture rather than covering it | | |
| 3 | The **Pause button** pauses and resumes. The page's own click counter also increments | | counter reached: |
| 4 | **Hardware decode active** — Task Manager GPU "Video Decode" above zero **and** `hwdec-current` ≠ `no` | | `hwdec-current` read: |
| 5 | **Resize and window move** keep video and UI locked together — no tearing, no lag; drag fast between two monitors | | |
| 6 | **Per-monitor DPI change** (drag onto a 150%-scaled display) breaks neither layout nor video geometry | | |
| 7 | **Live telemetry** — `time-pos` advances and `avsync` is present in the panel at a usable rate | | |
| 8 | **Clean shutdown** — close the window; no `exp-1c.exe` and no `msedgewebview2.exe` left in Task Manager | | |

Criterion 2 is the one to be most careful about, because there are now **four**
different-looking outcomes and only one of them is a pass:

- the video shows and is **tinted** magenta at the top left, cyan at the bottom
  right, with the HTML over it → **PASS**
- **HTML visible but no video** → new this round, and informative: the
  webview's visual is opaque despite `DefaultBackgroundColor A=0`. It would
  mean composition hosting ignores the transparency rather than that the
  layering is wrong. **FAIL**, and say explicitly that you could see the HTML
- the video shows but the gradient is **invisible** → the page is drawing and
  its alpha is being discarded. **FAIL**, and say so
- **neither layer visible** → **FAIL**, and the four log lines above say which
  stage stopped

The dashed frame 8px inside the window is there so "the video is present but
offset or wrongly scaled" and "there is no video" look different. Say which.

## Anything that looked wrong but is not on the list

Flicker on first paint, a black frame on resize, the overlay going opaque when
the window loses focus, the spinner stuttering, hover states sticking after the
pointer leaves — write it down even if every criterion passed.

## Verdict

- [ ] **1c PASSES on this machine** — all eight PASS, nothing marked NOT-TESTED.
- [ ] **1c FAILS on this machine** — which criterion, and what you saw.
- [ ] **Inconclusive** — a runtime precondition was not met (see the table at
      the top). This is NOT a failure of the arrangement.

A pass on one machine does not close Experiment 1c; §10's matrix does. What a
pass **would** do is give decision D1 a working compositing arrangement to rest
on for the first time, which is what gpt-architect is currently being asked to
decide without.
