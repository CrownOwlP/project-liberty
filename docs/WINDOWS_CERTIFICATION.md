# Windows reliability certification

Every scenario the Windows product must survive, with an explicit owner for each:
**AUTO** (a CI job on `windows-latest`), **RIG** (the commander's Windows machine),
or **BLOCKED** (needs access or hardware nobody has yet).

> **No row in this document may be marked passed from the cloud engineering
> session.** Nothing there can observe a Windows machine: the container's Rust
> toolchain targets `x86_64-unknown-linux-gnu` only, and the linked computer
> exposes an isolated Linux VM. A `windows-latest` runner is the substitute for a
> build machine, and everything a runner cannot see is owed to the rig.

## Why this file exists beside `docs/TEST_MATRIX.md`

`TEST_MATRIX.md` has eight rows and every cell is an automated tier — Unit,
Contract, Integration, E2E. It has no manual column, no real-device row, no HDR
row and no Windows row, while two other documents already require real hardware:
`DESKTOP_PLAYBACK.md` §10 specifies a compositing experiment that can only run on
Windows, and `AV_SYNC_MEASUREMENT.md` specifies an external flash-and-blip rig
because **a browser cannot measure lip-sync at all**. A matrix with no owner
column cannot express either, so it silently expressed neither.

## The three owners, and what each can actually prove

| Owner | Runs on | Proves | Cannot prove |
| --- | --- | --- | --- |
| **AUTO** | `windows-latest` CI | The code runs on Windows, the installer builds, the contracts hold | Anything about a GPU, a display, an audio device, or a machine that sleeps |
| **RIG** | The commander's PC | That the product works for a person | Nothing reproducibly, unless the environment is recorded |
| **BLOCKED** | — | — | Named so it is visible, not quietly dropped |

**A RIG pass on unrecorded hardware is not evidence.** Every RIG result carries
the Windows build, GPU, driver version, WebView2 runtime version, display
(resolution, refresh, HDR capability) and audio device. Two runs that disagree
are two different machines until those fields say otherwise.

## Recording an environment

```
Windows build      : e.g. 10.0.26100.2314
GPU / driver       : e.g. NVIDIA RTX 4070 / 566.14
WebView2 runtime   : e.g. 131.0.2903.86
Display            : e.g. 3840x2160 @120Hz, HDR10 capable, scaling 150%
Audio device       : e.g. Realtek / HDMI passthrough, 5.1
Liberty version    : from the About screen (PW-0308) — never "latest"
Artifact           : the CI run id the installer came from (PW-0501)
```

---

## The matrix

### A. Lifecycle

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| A1 | Cold start on a machine that has never run it | RIG | Window appears, home renders, no console error dialog. Time to first paint recorded. |
| A2 | Normal restart | AUTO+RIG | Second launch succeeds. **AUTO covers the case that breaks most often: an orphaned `node.exe` holding the loopback port.** |
| A3 | Kill the shell; relaunch | RIG | No orphaned sidecar (Job Object, PW-0102). Task Manager shows no `node.exe` from the app. |
| A4 | Kill the sidecar while playing | AUTO | Supervision restarts it within its budget, or surfaces an honest failure. **Never a blank window.** |
| A5 | Sidecar fails to start, budget exhausted | AUTO | A named error the user can act on; the app does not sit on a spinner. |
| A6 | Sleep / wake mid-playback | RIG | Playback resumes or fails with a reason. A silent freeze is a failure. |
| A7 | Long session — 4h continuous playback | RIG | No crash; memory and handle count recorded at 0/1/2/4h. |

### B. Playback

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| B1 | Movie, 1080p, start to finish | RIG | No stall not explained by the reason trail. |
| B2 | Episode playback | RIG | As B1, plus correct episode identity on screen. |
| B3 | Seek — forward, back, repeatedly, to the last second | AUTO+RIG | Position settles; no stuck `seeking` phase. |
| B4 | Pause / resume, 20×| AUTO | Phase returns to `playing` each time. |
| B5 | Source switching (failover) | AUTO | Reason trail names the failed candidate and the one adopted. |
| B6 | Resume position | AUTO+RIG | Playback starts at the stored position via `startAtSeconds`, not by seeking after load. |
| B7 | Next episode | RIG | Plays the right episode and **re-applies the per-episode rights gate** (PW-0307). |
| B8 | Subtitles — on, off, switch language, forced track | RIG | Selection survives a failover (PW-0206). |
| B9 | Multiple audio tracks — switch language | RIG | Audio changes; no desync introduced. |
| B10 | Stereo output | RIG | Correct channel mapping. |
| B11 | Multichannel (5.1 / 7.1) | BLOCKED → RIG | Needs a multichannel device. **Skip honestly if absent; do not mark failed.** |
| B12 | Lip-sync / A/V drift | BLOCKED | Needs the external flash-and-blip rig in `AV_SYNC_MEASUREMENT.md`. **The browser cannot measure this and neither can a human eyeball reliably.** |
| B13 | 4K playback | RIG | Renders at 4K; dropped-frame count recorded. |
| B14 | HDR | BLOCKED → RIG | Needs an HDR display. Record whether tone mapping engaged. |
| B15 | Hardware decoding | RIG | GPU decode engaged (Task Manager → GPU → Video Decode). Record the codec. |
| B16 | Fullscreen ↔ windowed, repeatedly | RIG | No black frame that persists; no lost audio. |

### C. Failure and recovery

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| C1 | Network drops mid-playback, returns | AUTO+RIG | Buffering, then recovery, or an honest error — **never a silent stop**. |
| C2 | Offline at launch | AUTO | Degraded mode naming what is unavailable (PW-0309). |
| C3 | Backend unavailable | AUTO | `unavailable` / `provider_unavailable` with a reason trail. Already covered for the forwarder by the desktop e2e suite. |
| C4 | Sidecar down, shell up | AUTO | A **distinct** state from C2 and C3, because the remedies differ. |
| C5 | Malformed source | AUTO | Refused with a reason; no crash. |
| C6 | Unavailable source (404 / DNS failure) | AUTO | Failover attempted, then an honest failure. |
| C7 | DRM candidate on the native path | AUTO | **Refused with `drm_required_no_cdm`. Never a fallback, never a degrade.** This is a rights property, not a capability detail. |

### D. Live TV

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| D1 | Channel list renders | BLOCKED | Needs PL-0602 (licensed live feed). |
| D2 | Channel change | BLOCKED | Needs PL-0602. |
| D3 | EPG guide navigation | BLOCKED | Needs PL-0602. |
| D4 | A listing for an unentitled channel | BLOCKED | Must render as **information, not a play affordance** — `LIVE_TV.md`: *a listing is not an entitlement*. |

### E. Resources

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| E1 | Memory over a 4h session | RIG | Recorded at intervals; a monotonic climb is a failure even without a crash. |
| E2 | CPU at idle with the app open | RIG | Recorded. An idle media app should not hold a core. |
| E3 | GPU during 4K playback | RIG | Recorded, with decode engine utilisation. |
| E4 | Handle / thread count over a session | RIG | Recorded. Growth indicates a leak in the shell or the sidecar. |

### F. Install and update

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| F1 | Clean install, then launch | AUTO+RIG | AUTO on a fresh runner; RIG on a machine that has had it before. |
| F2 | Upgrade over a previous version | AUTO | **User data preserved.** The one that breaks most often and that nobody tests. |
| F3 | Uninstall | AUTO+RIG | No service, no scheduled task, no orphaned `node.exe`. States what user data it keeps. |
| F4 | Reinstall after uninstall | AUTO | Succeeds; no stale state. |
| F5 | SmartScreen / Defender on first run | RIG | **Expected to warn until a signing certificate exists** (LAST_MILE 6). Record the exact wording so the commander is not surprised. |
| F6 | Update check and apply | BLOCKED | Needs signing (LAST_MILE 6). Until then the update path is **disabled by default** and must say so. |

### G. Architecture facts

| # | Scenario | Owner | Pass condition |
| --- | --- | --- | --- |
| G1 | **Experiment 1a — child HWND composites beneath a transparent WebView2** | RIG | `DESKTOP_PLAYBACK.md` §10. **The entire choice of Tauri (D1) rests on this and it has never been run.** A failure stops the native-window lane and reverses D1 through architecture review — it is not worked around. |
| G2 | Display scaling at 100 / 125 / 150 / 200% | RIG | No clipping, no unreadable text, no lost controls. |
| G3 | Keyboard-only operation, whole app | AUTO+RIG | Every interactive element reachable (PW-0310). |

---

## Counts

| Owner | Rows |
| --- | --- |
| AUTO (or AUTO+RIG) | 17 |
| RIG only | 17 |
| BLOCKED | 7 |
| **Total** | **41** |

The BLOCKED seven are four Live TV rows (PL-0602), multichannel and HDR (hardware
the commander may not have), the lip-sync rig, and the signed update path
(LAST_MILE 6). **They are listed rather than dropped**, because a matrix that
omits what it cannot test reads as a matrix that passed.

## Reporting a failure

A defect report that cannot be reproduced costs more than no report. Include:

1. the environment block above, complete;
2. the row number;
3. **the playback reason trail** — the player already publishes it, and it is the
   difference between "it stopped" and "candidate 2 failed with X and failover
   found nothing";
4. the log file (location established by PW-0501);
5. the app version (About screen, PW-0308) and the CI artifact id.

## How long the rig half takes

Honestly: the RIG rows are roughly **three to four hours of attended time**, and
A7/E1 add four hours of mostly unattended playback that must be sampled at
intervals. It is not a fifteen-minute pass, and planning it as one is how a
certification run turns into a spot check.
