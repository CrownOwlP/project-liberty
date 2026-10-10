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

---

# The run sheet (PW-0603)

The matrix above is a **catalogue**: forty-one rows grouped by what they test.
This section is the **procedure**: what the commander does, in order, in one
sitting, and what to write down. The two are deliberately different documents
in one file, because working down a catalogue in catalogue order is how a
certification run goes wrong.

**This section delivers the sheet, not the results.** No row below may be
marked passed from the cloud engineering session, and a row recorded as passed
without an environment block is not evidence.

## Four things that are not obvious, and that the ordering exists for

**1. Most of the matrix cannot be run today, and it is not a hardware
problem.** The entire **B block** (sixteen playback rows) needs something to
play, and a production deployment of this product publishes **nothing**: the
catalog has no operator rights register, so every record is withheld by name
(`docs/CATALOG_SOURCE.md`), and no licensed provider is configured (`PL-0302`,
LAST_MILE 3). This is the system working as designed — a source knowing a work
exists is not authorization to surface it — but it means a commander who sets
aside an afternoon and starts at A1 discovers it at B1, three hours in. The
sitting that is actually runnable today is **Session 1 below, and nothing
else**. Everything else is listed in *Not runnable yet* with the gate that
releases it.

**2. G1 comes early, not at the end.** Experiment 1a is the last row of the
last group in the matrix, and it is the **third thing done** here. The whole
choice of Tauri (D1) rests on it, it has never been run, and a failure reverses
that decision through architecture review rather than being worked around
(`DESKTOP_PLAYBACK.md` §10). Running it at the end of a long sitting means
either discovering at hour four that the architecture is wrong, or — worse —
being tired enough to record a hopeful pass.

**3. F3 and F4 come last, because they destroy everything the other rows
need.** Uninstall and reinstall are the only rows that cannot be undone by
closing a window. Run them after every other row on this machine has a result.

**4. F5 can only be observed once.** SmartScreen and Defender warn on *first*
run of an unsigned installer, and Windows remembers. If the install step is
done without watching for it, the observation is gone until a different machine
or a reset reputation cache. Capture it at the moment of install or not at all.

## Before the sitting

Have these in hand; each has cost a sitting when it was missing.

- **A CI run that produced installers.** The `package` job of the *Windows
  package* workflow must have **succeeded**, and its artifact
  `liberty-windows-unsigned-<sha>` must still exist — retention is **14 days**.
  Note the run id and the commit sha now; both go in the environment block.
- **Administrator rights**, for the MSI and for Task Manager's handle counts.
- **About half a gigabyte free** on the system drive, and a machine you are
  willing to uninstall software from.
- **An expectation that Windows will warn you.** The installer is unsigned and
  will stay unsigned until an Authenticode certificate exists (LAST_MILE 6).
  The warning is row F5, not a failure.
- **The repository checkout, at the same commit as the artifact**, and `node`
  on `PATH`. Steps 2 and 5 run `scripts\windows\verify-install.mjs`, which uses
  **only Node builtins** — there is nothing to `npm install` — but it derives
  the paths it checks from `apps/desktop/src-tauri/src/sidecar.rs` by reading
  the Rust constants out of the source beside it. That is deliberate: the Rust
  constant is the contract and a copy of it is how this check drifted before.
  The consequence for the sitting is that the checkout must be **at the commit
  the installer was built from**, or the verifier is checking one build's
  layout against another build's expectations.

## Step 0 — Record the environment (2 minutes, one command)

**You do not type any of this by hand.** After Step 2 installs the
application and Step 3 launches it, one command collects every machine-
readable fact this matrix asks for:

```
node scripts\windows\qualify.mjs
```

It writes `liberty-qualification.json` beside you and prints a short summary.
Send that **one file** back with your notes. It records the Windows build,
GPU and driver, WebView2 runtime, display, audio and scaling; where the
application installed and whether `verify-install` accepts that tree; whether
`liberty-desktop.exe` and a `node.exe` are running; and whether `sidecar.log`
exists, how big it is, whether the handshake line is in it, and **a
classification of what went wrong in it — not its contents.**

**The report never quotes `sidecar.log`,** and that is deliberate rather than
cautious. An earlier version carried the last 16 KB of the file verbatim, which
put whatever happened to be in it — a token in a URL, an argv, an environment
dump — into a file written to be pasted into a chat. What the report carries
now is which entries of a fixed signature table in `scripts/windows/qualify.mjs`
matched, each with a plain-English explanation written in this repository, plus
line and byte counts. An **allowlist, not a redactor**: a redactor has to
predict what a secret looks like, and nothing can. If the failure is one the
table does not recognise, the report says exactly that in those words rather
than looking clean — and **the log itself is still on the machine**, at the path
the report prints, so nothing diagnostic is lost; it just does not travel
unless you choose to send it.

**An unavailable reading is recorded, not dropped.** If the WebView2 registry
key does not answer — common when the runtime is installed per-user — the
report says *why* rather than omitting the field. Treat `unavailable` as a
prompt to look in **Settings → Apps → Microsoft Edge WebView2 Runtime** and
add the version to your notes; it is not proof of absence.

**It deliberately claims nothing it cannot see,** and the file says so inside
itself. It cannot tell anyone that a window appeared, that WebView2 *rendered*
Liberty, that anything played, or what SmartScreen said. A WebView2 version is
not a render. Those rows are yours and they are the reason this sitting needs
a person at all.

**It runs on Windows only**, and refuses elsewhere with a reason, because
every reading in it is a Windows fact.

Two things still need your eyes, because Windows exposes them as settings
rather than as facts a script can read reliably: **HDR** (Settings → System →
Display → *Use HDR* — record on/off **and** whether the toggle exists at all)
and whether the **scaling** percentage the report captured matches what that
page shows.

## Step 1 — Get the artifact and prove the bytes (15 minutes)

1. Download `liberty-windows-unsigned-<sha>` from the CI run. It contains one
   `.msi`, one `.exe` (NSIS), and `artifact-inventory.json`.
2. Open `artifact-inventory.json`. It lists each artifact's `kind`, `name`,
   `bytes` and `sha256`, produced by the same job that built them.
3. Verify both files:

   ```powershell
   Get-FileHash -Algorithm SHA256 .\*.msi, .\*.exe | Format-List Path, Hash
   ```

   Compare each `Hash` to the matching `sha256` in the inventory, **case
   insensitively** — `Get-FileHash` prints uppercase and the inventory is
   lowercase. Compare the byte counts too.

**Expected:** two files, both hashes matching. **If a hash does not match:**
stop. Do not install it. That is a corrupted download or a wrong artifact, and
either way nothing measured afterwards is attributable to the commit.

**What this does not prove, stated so it is not over-read:** the inventory is a
SHA-256 taken by the job that built the files. It proves the bytes you have are
the bytes CI produced. It is **not a signature**, not a provenance attestation,
and not evidence that the installer installs anything.

**Install the MSI, not the NSIS executable**, unless you are specifically
testing the per-user path. The rest of this sheet assumes the MSI's machine-wide
layout: `C:\Program Files\Project Liberty`.

## Step 2 — Clean install, watched (20 minutes) — rows F1, F5

Run the MSI from an elevated prompt so the log is kept:

```powershell
msiexec /i ".\<the file>.msi" /l*v "$env:USERPROFILE\Desktop\liberty-install.log"
```

**Watch for the SmartScreen / Defender warning and record its exact wording and
the exact button you pressed** (row F5). Screenshot it. This is the only chance.

Then verify the installation is what it claims to be, rather than trusting that
the installer said it finished. The repository ships the verifier CI uses:

```powershell
node scripts\windows\verify-install.mjs "C:\Program Files\Project Liberty"
```

**Expected:** exit code 0, having found the executable, the packaged Node
runtime, the sidecar server entry and a **non-empty** `THIRD-PARTY-NOTICES.md`.
**If it refuses:** record its message verbatim — it names the missing entry, and
that message is the defect report. Do not launch the application; a partial
install produces failures in every later row that are not those rows' failures.

**F1 pass condition:** the MSI completes, the verifier exits 0, and
`C:\Program Files\Project Liberty\liberty-desktop.exe` exists.

## Step 3 — First launch, and the decision (45 minutes) — rows A1, G1

**A1 — cold start.** Launch it. **Expected:** a window appears, the home screen
renders, no error dialog. **Record the time from double-click to first paint**
(a stopwatch is fine; the number is a baseline, not a threshold).

Note what the home screen shows. On a correctly configured deployment with no
rights register it will offer **no titles**, and that is item 1 above, not a
failure of A1. A1 is about the window, the render and the absence of a crash.

**G1 — Experiment 1a. This is the decision point of the entire sitting.**
`DESKTOP_PLAYBACK.md` §10 specifies it. The question is whether a child HWND
composites *beneath* a transparent WebView2 — whether native video can be drawn
behind the web UI rather than inside it.

**What to capture, whatever the answer:** a screenshot, the GPU and driver from
Step 0, and a plain statement of what you saw — which layer was visible, which
was not, and whether anything flickered or tore.

**If it fails: stop the sitting and report it.** Do not work around it, do not
try a different window style, and do not continue to Step 4. A failure here
reverses decision D1 through architecture review, and three more hours of rows
measured on an architecture that is about to change is three hours spent.

## Step 4 — The rows that need no content (60 minutes)

These are every remaining row that a catalog publishing nothing can still
answer. Run them in this order; each leaves the app in the state the next one
expects.

| # | Action | Expected | Capture on failure |
| --- | --- | --- | --- |
| **A2** | Close the window. Launch again. | Second launch succeeds, same as A1. | Whether a `node.exe` from the app is still in Task Manager **before** the second launch — an orphaned sidecar holding the loopback port is the failure this row exists for. |
| **A3** | Launch. End the `liberty-desktop.exe` **process tree** from Task Manager. Wait 10 s. | **No `node.exe` belonging to the app remains.** The Job Object (PW-0102) should have taken it with the shell. | The surviving process's PID, command line (Task Manager → Details → right-click → *Command line* column) and parent. A survivor here is a real defect. |
| **A3b** | Launch again after A3. | Starts normally; no port conflict. | The error text, and whether `verify-install` still passes. |
| **G2** | Set display scaling to 100%, then 125%, 150%, 200% (Settings → System → Display). Launch at each; visit home, search, settings. | No clipped text, no control pushed off-screen, no unreadable label. | A screenshot **per scaling level that fails**, with the level in the filename. |
| **G3** | From the home screen, operate the whole app with **keyboard only** — Tab, Shift-Tab, Enter, Space, Escape. Reach every interactive element on home, search and settings. | Every control reachable and operable; focus always visible (PW-0310). | The element that cannot be reached, and the control you were on when focus was lost or trapped. |
| **E2** | Leave the app open and idle on the home screen for 10 minutes. Task Manager → Details → CPU for `liberty-desktop.exe` and the app's `node.exe`. | Recorded. An idle media application should not be holding a core. | Record the number regardless; this row's output is a measurement, not a verdict. |
| **C2** | Disable the network adapter. Launch the app. | Degraded mode that **names what is unavailable** (PW-0309) — not a blank window and not a spinner. | A screenshot of what it actually showed, and how long it showed it before settling. |

Re-enable the network when C2 is done.

## Step 5 — Uninstall and reinstall, last (30 minutes) — rows F3, F4

Destructive. Everything above must have a result first.

1. **Before uninstalling**, record what is in the user-data root so you can tell
   what survives:

   ```powershell
   $root = "$env:LOCALAPPDATA\app.projectliberty.desktop"
   Get-ChildItem -Recurse $root | Select-Object FullName, Length | Format-Table -AutoSize
   ```

   Expect `data`, `cache` and `logs` subdirectories, created by the application
   at first launch. **The installer never created them**, which is why the next
   expectation is what it is.

2. **F3 — uninstall** through Settings → Apps → Installed apps.

   **Expected:** `C:\Program Files\Project Liberty` is gone; **no** service, no
   scheduled task, and no `node.exe` from the app in Task Manager. The user-data
   root above **still exists, with its contents** — the uninstaller cannot
   remove what it never created, so the honest answer to "what user data does
   uninstall keep" is *all of it, there*.

   **Capture on failure:** the surviving path, and for a surviving process its
   PID and command line.

3. **F4 — reinstall** the same MSI. **Expected:** succeeds; `verify-install`
   exits 0 again; the application launches and the settings you chose earlier
   are **still there**, because that state was in the user-data root.

   **Capture on failure:** the installer's own log (`/l*v` as in Step 2) and
   whether the user-data root was modified (compare against the listing in 1).

## Not runnable yet, and exactly what releases each

Listed so that the gap between "the matrix has forty-one rows" and "the sitting
has about twenty" is visible rather than discovered.

| Rows | Blocked on | Releases when |
| --- | --- | --- |
| **B1–B16** (all playback), **A6** (sleep/wake mid-playback), **A7/E1/E3/E4** (long session, memory, GPU, handles) | Nothing to play: no operator rights register and no licensed provider | `PL-0302`, LAST_MILE 3 and 4 |
| **B11** multichannel, **B14** HDR | Hardware the commander may not have | A multichannel device / an HDR display — **skip honestly, do not mark failed** |
| **B12** lip-sync | The external flash-and-blip rig | `docs/AV_SYNC_MEASUREMENT.md`. A browser cannot measure this and neither can an eyeball |
| **D1–D4** live TV | Licensed live feed | `PL-0602` |
| **F6** update check | Code signing | LAST_MILE 6. Until a certificate exists the update path is **disabled by default and says so** |
| **F2** upgrade over a previous version | A genuine previous release to upgrade *from* | A second signed-or-not artifact from an earlier commit, kept deliberately. `PW-0505` |
| Every **AUTO** row | Nothing — they run on `windows-latest` | They are not the commander's; do not run them by hand |

## Reporting a failure

A defect report that cannot be reproduced costs more than no report. Include,
in this order:

1. **`liberty-qualification.json` from Step 0.** One file, collected by
   `node scripts\windows\qualify.mjs`, carrying the whole environment block.
   Two runs that disagree are two different machines until those fields say so.
2. **The row number** from the matrix, and which Step of this sheet you were in.
3. **What you did, what you expected, what happened** — in that order, in three
   sentences. The third one is the only one that is ever ambiguous later.
4. **A screenshot**, for anything visual. G1, G2 and C2 are not describable.
5. **The playback reason trail**, where playback was involved. The player
   publishes it, and it is the difference between "it stopped" and "candidate 2
   failed with X and failover found nothing".
6. **The installer log**, for anything in Step 2 or Step 5 — that is what the
   `/l*v` argument is for.
7. **`sidecar.log`**, for anything in Step 3, 4 or 5 — see below for where it
   is and what is in it. This is the one that was missing until PL-0734.
8. **The application version** from the About screen, and the **CI run id** and
   **commit sha** the artifact came from. Never "latest".

### The application log, and what it does and does not contain

**`%LOCALAPPDATA%\app.projectliberty.desktop\logs\sidecar.log`** — attach it
to any report from Step 3, 4 or 5.

This sheet previously said there was no such file, and it was right. The shell
created that directory and nothing wrote into it; the sidecar's stderr was
discarded outright (`Stdio::null()`), so a Node stack trace printed on the way
down went nowhere. PL-0734 closed that. What you now get:

- **both streams**, tagged `[out]` and `[err]`, interleaved in the order they
  were printed — which is usually the diagnosis;
- **written as the child runs**, not at exit. The shell's job object kills the
  sidecar when the shell goes, and a killed process never reaches an exit
  path, so anything buffered until then would be exactly the crash you are
  trying to report;
- **truncated per launch**, so the file is about the run you just did. Copy it
  before relaunching;
- **capped at 1 MB**, and it says so at the bottom if it hit the cap.

**The launch token is redacted** — replaced by value, not by pattern, because
the shell minted it. If you see `[redacted: launch token]` in the file that is
the protection working, not a fault.

**If the file is absent**, the shell could not open it and said so on its own
stdout; the launch continues regardless, because a shell that refused to start
because it could not write a diagnostic would be worse than the gap. Record its
absence — that is itself a finding.

## How long it takes, honestly

| | |
| --- | --- |
| Step 0, environment | 10 min |
| Step 1, artifact and hashes | 15 min |
| Step 2, install, watched | 20 min |
| Step 3, first launch and **G1** | 45 min |
| Step 4, the content-free rows | 60 min |
| Step 5, uninstall and reinstall | 30 min |
| **One sitting, attended** | **about 3 hours** |

Add the Step 0 scaling changes if the machine is not already at 100%, and add
the download time for the artifact on a slow connection.

**What that three hours does not include**, and did not shrink: the long-session
rows (A7, E1, E3, E4) are four hours of mostly unattended playback sampled at
0/1/2/4h, and they cannot start until there is something to play. They are a
**second sitting**, not an extension of this one, and the earlier figure of
"three to four hours attended plus four unattended" remains the right estimate
for the whole matrix once `PL-0302` lands. What this sheet claims is narrower
and true today: **three hours gets you every row that can currently be run.**
