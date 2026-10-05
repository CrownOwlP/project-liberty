# Experiment 1a — result sheet

Copy this file, fill it in on the machine, and paste it back. One copy **per
machine**: the matrix is three axes and a single machine is one cell of it.

> **NOT-TESTED is a legitimate answer and the most useful one you can give for
> something you could not try.** A criterion marked PASS that was not actually
> observed is the only outcome here that costs more than a failure, because
> decision D1 would then rest on it.

## The machine

| | |
|---|---|
| Windows version / build | |
| GPU(s) — and whether hybrid | |
| Graphics driver version | |
| Display(s): resolution, refresh, scaling | |
| WebView2 runtime version | |

`collect-evidence.cmd` fills all five of these into `exp-1a-evidence.txt`.
Paste that file in rather than typing them.

## The clip

| | |
|---|---|
| Container / codec / resolution / fps | |
| How you know (e.g. `mediainfo`, mpv's own output) | |

If this is not 4K60 HEVC or AV1, criterion 1 cannot be a PASS — mark it
NOT-TESTED and say why here.

## The seven

| # | Criterion | PASS / FAIL / NOT-TESTED | What you actually saw |
|---|---|---|---|
| 1 | Hardware-decoded — GPU Video Decode > 0 **and** `hwdec-current` ≠ `no` | | `hwdec-current` read: |
| 2 | HTML composited over video with real alpha | | |
| 3 | Button receives clicks and pauses | | |
| 4 | Resize / fast drag keep video and UI locked | | |
| 5 | Per-monitor DPI change breaks neither | | |
| 6 | `avsync` and `time-pos` stream at a usable rate | | |
| 7 | The matrix | | Which cells this machine covers: |

## Anything that looked wrong but is not on the list

Flicker on first paint, a black frame on resize, the window going opaque when
it loses focus, the spinner stuttering — write it down even if every criterion
passed. §10's criteria were written before anyone had run this.

## Verdict

- [ ] **1a PASSES on this machine** — all seven PASS, nothing marked NOT-TESTED.
- [ ] **1a FAILS on this machine** — which criterion, and what you saw.
- [ ] **Inconclusive** — something prevented the run. What.

A pass on one machine does not close Experiment 1a; §10's matrix does. It does
unblock Experiment 1b, which §10 says starts "after 1a passes, not before".
