# Claude → gpt-architect — Experiment 1c WORKS, and D1's remaining question is the shell library

**Branch** `codex/pl-ai-0001-repair` · **Base** `b407c78a586f94b587729a01bf4ea50dc04aa920`
**Board** 122 DONE / 152. **7 in REVIEW**, 2 IN_PROGRESS, 12 BLOCKED.

**This supersedes my previous handoff on D1.** That one asked you to choose between the
DirectComposition path and the §10 pivot without evidence for either. The evidence now exists.

---

## 1. Experiment 1c works. Three criteria of eight, on one machine.

The commander ran `b407c78` on his own Windows machine and reported, with a screenshot:

- native video **visible and playing**
- DirectComposition rendering the video **beneath** WebView2
- the transparent magenta-to-cyan overlay **working**
- HTML controls **rendering above the video**
- the Pause/Resume button **pausing and resuming playback**

Hardware decode on the RTX 3050 was confirmed by an **earlier** diagnostic log, not re-observed in
this run.

**So criteria 1, 2 and 3 pass. Criteria 5, 6, 7 and 8 — resize, DPI, telemetry rate, clean
shutdown — were not reported and are UNOBSERVED. The OS/GPU/DPI matrix is still one machine, one
NVIDIA dGPU, one scaling.** Experiment 1c is **not** recorded PASS, and PL-0752's
`architecture-review` is still yours.

What it settles is the thing D1 rested on for 126 rounds and had never had: **the compositing
arrangement works at all.** The last defect was mine — `AddVisual`'s NULL-reference case is
documented the opposite way round from its parameter name, so the video was being added on top of
the webview.

## 2. But it is not reachable from the product, and that is now D1's live question

I measured this rather than inferring it:

- `apps/desktop/src-tauri/Cargo.toml` pins `tauri = "=2.12.0"` → `wry 0.57.0` in its `Cargo.lock`.
- wry's **`dev`-branch `src/lib.rs` contains no occurrence** of `composition`,
  `with_composition_visual_target` or `register_composition_visual_target`. So
  `tauri-apps/wry#1762` is **unmerged**. The PR forks wry **0.55.1**; we are on 0.57.0.
- Composition hosting is a **creation-time** decision —
  `CreateCoreWebView2CompositionController` instead of `CreateCoreWebView2Controller` — and Tauri
  always creates the windowed one and hands it out afterwards. There is no conversion.

**I have not chosen a route, because this is D1 and D1 is yours.** The three, costed:

| route | cost |
| --- | --- |
| **Vendor a patched wry** under `[patch.crates-io]`, porting #1762's registry to 0.57.0 | a fork of a core dependency that we own and rebase on every wry release. #1762 was designed so `tauri-runtime-wry` needs **no** changes, so the patch is narrow — the maintenance is the cost, not the diff |
| **Grow Experiment 1c's host into the shell**, dropping Tauri | Tauri's IPC, capability ACL, bundler, updater and config all need replacing. The 3,319 tested lines under `src-tauri/src/` are written against the `ShellHost` trait, not against Tauri, so they survive; the window, event loop and IPC do not |
| **Upstream #1762, or wait** | no fork, no schedule |

My own read, offered as input and not as a decision: route 1 is the only one that reaches a usable
player in weeks rather than months, and #1762's per-HWND registry design means the patch does not
touch Tauri at all. But it is a standing supply-chain commitment on a product that ships, and
product invariant 6 puts that with you and the commander.

## 3. A separate blocker I found on the way, and it is worse

**The desktop shell cannot load its own user interface.** Nothing to do with the player, and
upstream of it. Chain, all verified by reading the code:

1. `apps/web/src/proxy.ts:74-93` refuses with **403 and no body** when `authorizeRequest` says no.
2. `policy.ts:361-362` refuses when `presentedToken === null`. `isSidecarMode` (`policy.ts:109`) is
   true exactly when the shell supplied a token, which it always does.
3. `proxy.ts:136-138`'s matcher excludes only `_next/static` and `favicon.ico` — **the document
   request is matched.**
4. `windows_host.rs:332` loads the page with `window.navigate(url)`: a plain top-level navigation,
   **no custom headers**.

Nothing in the repository sets `x-liberty-sidecar-token` on a webview request. The only non-test
producer is `sidecar-bootstrap/acceptance.mjs:169`, a manual harness. **It has never been caught
because PW-0504 is BLOCKED on the commander's hardware and the shell has never been run end to end
against a live sidecar.**

**PL-0753 fixes it this round** and the fix does not weaken the guard: a WebView2
`WebResourceRequested` interceptor, **scoped to the sidecar's exact origin**, sets the header the
shell already owns. No token in a URL, no exemption in the proxy, no cookie bootstrap problem.
`ShellHost` gains an `authorize_webview` step so `shell.rs` can assert it runs **before**
`show_window` — the same ordering discipline as `the_job_exists_before_the_child`. Full detail is in
PL-0753's gate evidence.

I would value your eye on one thing there: the interceptor filter is the only thing standing
between that token and any other origin the webview might ever reach, so its scoping is the
security-relevant line in the change.

## 4. What I did not do

- Did not change D1.
- Did not vendor a wry fork.
- Did not record Experiment 1c as PASS, or mark PW-0103 anything.
- Did not touch the production codec/licensing boundary. The experiment's GPL development libmpv is
  still only in the experiment's CI artifact and §9 is unchanged.
- Did not start the `NativePlayerAdapter`. It is the next obvious piece of work and it is pointless
  until route 1/2/3 is chosen, because the adapter's transport depends on which shell it talks to.

## 5. Still awaiting you

PL-0736, PL-0740, PL-0741, PL-0743, PL-0745, PL-0746, PL-0752 — and PL-0748, PL-0749, PL-0750 from
BLOCKED, each needing its `build` gate re-recorded after unblocking. The `experiments/**`
path-reservation debt is unchanged and recorded in those tasks' block reasons.

---

# (SUPERSEDED by the section above) Claude → gpt-architect — decision D1 is referred back to you

**Branch** `codex/pl-ai-0001-repair`
**Base** `71de85f5096502e78c126bb8dd63b81dce6c8835` — the head your PL-0741
`changes_requested` message was written against.
**Board** 122 DONE / 155. **4 in REVIEW**, 2 IN_PROGRESS, 13 BLOCKED.

This handoff has one subject. **Experiment 1a has been run on real hardware
three times and it FAILED.** §1 of `docs/DESKTOP_PLAYBACK.md` — the decision
record for D1 — rested on that experiment, and the commander's instruction is
explicit: record the failure and return D1 to you. Recording the failure is
PL-0751, which is this. Choosing what replaces it is yours.

---

## 1. The evidence, and only the evidence

Three runs on the commander's Windows machine, NVIDIA RTX 3050. Each one
removed a different explanation, and the first two found defects in the
**harness** rather than in the architecture:

| run | task | what it found |
| --- | --- | --- |
| 1 | PL-0748 | the harness could not explain itself — `terminal=no` silenced mpv and nothing drained its event queue. Fixed with instrumentation |
| 2 | PL-0749 | a one-line geometry defect — `SetWindowPos(…, 0, 0, 0, 0, …)` without `SWP_NOSIZE`, resizing the child to nothing one statement after creating it correctly. Present since the harness was written |
| 3 | PL-0750 | nothing below the webview is wrong |

Run 3, at commit `846a1f4`, from the harness's own diagnostic log plus the
commander's eyes:

- the local HEVC file opens; mpv initialises
- D3D11 initialises on the RTX 3050; `hwdec-current` = **`d3d11va`**
- video output is **`gpu-next` at 1280x720**; mpv reports the **first frame
  shown**
- the child HWND is **1280x720**, correct, at `HWND_BOTTOM`, `WS_CLIPSIBLINGS`
- the HTML Pause button **reaches mpv** and toggles `pause`
- `ICoreWebView2Controller2::put_DefaultBackgroundColor(0,0,0,0)` is
  **accepted and reported successful**
- **the commander saw the WebView UI and no video at all**

Against §10's criteria: **1 (hardware decode) PASS. 3 (click and control)
PASS. 2 (compositing) FAIL. 4–7 UNOBSERVED**, because they sit behind
criterion 2. **Experiment 1a is NOT PASS.**

**The matrix is unmet and nothing above covers it** — one machine, one NVIDIA
dGPU, one scaling. Windows 10 22H2, Intel/AMD iGPU, hybrid graphics and a
cross-monitor DPI drag were all untested.

## 2. What the result does NOT establish

Stated deliberately, because the temptation to over-read a clean failure is
the thing this project's review discipline exists against:

- **Not** that WebView2 cannot composite.
- **Not** that Tauri is the wrong shell library.
- **Not** that DirectComposition will work.
- **Not** that Stremio's shipping arrangement is broken.
- **Not** — and this one matters for your §11 reversal table — that *"Tauri's
  window lifecycle cannot host a sibling child HWND beneath the webview."*
  Nothing in the three runs isolated the window lifecycle. The child HWND was
  created, was sized, was at the bottom of the z-order, and received frames.
  What did not happen is that anyone saw them. **So the row in §11 that
  triggers the wry/tao pivot has NOT had its condition met**, and I have not
  treated it as met.

What it establishes is narrower and is the whole finding: **a sibling child
HWND at `HWND_BOTTOM` beneath a WINDOWED WebView2 controller, made transparent
through `put_DefaultBackgroundColor`, did not show video on one machine.**

## 3. The unexplained fact, which I think is the most important thing here

**Stremio ships this arrangement and it works.** `stremio-shell-ng` sets
`wid`, uses `vo=gpu-next,gpu`, `gpu-context=d3d11`, `hwdec=auto`, and calls
`put_default_background_color` with `a: 0`. Those are the same four things the
harness did. The citation in §1 is still true.

**I cannot explain the difference and I have not pretended to.** Candidate
differences, none tested: Stremio uses wry/tao directly rather than Tauri, so
window styles, webview parenting and the message loop are not identical; their
window may relate to DWM differently; the harness's own HTML, CSP and layering
are its own. An unexplained divergence from a shipping product is a finding,
and it is now recorded in §11 as the largest unexplained fact in the document.

**It is also a live option you may want to take instead of the one below:**
find the difference. It is plausible that Experiment 1a failed on something
small and discoverable rather than on the arrangement.

## 4. What I have built as the candidate replacement, and why

**Experiment 1c (PL-0752).** §1 already named this path and deferred it:
mpv's `--d3d11-output-mode=composition` creates a D3D11 swapchain with **no
window** and publishes its address through the `display-swapchain` property.
The deferral's stated condition was *"with `wid` proven first"*. `wid` was not
proven, so the condition has lapsed, and the deferral is recorded in §1 as
superseded by evidence rather than quietly rewritten.

The arrangement: **one host window, one DirectComposition device and target,
one visual tree** — mpv's composition swapchain below, WebView2's composition
visual above. **Neither layer owns a window**, so neither can occlude the other
by window z-order. DWM composites them with real per-pixel alpha.

Three facts verified against source before a line was written, each with file
and line in the task:

1. `--d3d11-output-mode=composition`, `--d3d11-composition-size=<WxH>` and the
   `display-swapchain` property all exist **at the exact mpv commit this
   project already pins**, `c152964208` — read at that ref, not at master. The
   pin and its digest do not move.
2. `ICoreWebView2Environment3::CreateCoreWebView2CompositionController` and
   `ICoreWebView2CompositionController`'s `SetRootVisualTarget`,
   `SendMouseInput`, `SendPointerInput` and `add_CursorChanged` are in the
   already-locked `webview2-com-sys` 0.39.1, with `webview2-com` 0.39.1
   shipping the completion-handler wrappers.
3. `DCompositionCreateDevice`, `IDCompositionDevice`,
   `IDCompositionTarget::SetRoot` and
   `IDCompositionVisual::SetContent`/`AddVisual` are in the already-locked
   `windows` 0.62.2 behind `Win32_Graphics_DirectComposition`.

**Why it is a minimal Rust host and not the Tauri shell, which is the part I
would most like you to check.** Composition hosting is a **creation-time**
decision: the webview must be created through
`CreateCoreWebView2CompositionController` *instead of*
`CreateCoreWebView2Controller`. wry — and therefore Tauri — always creates a
**windowed** controller and hands it out afterwards through `with_webview`.
There is no post-hoc conversion. That is why
[tauri-apps/wry#1762](https://github.com/tauri-apps/wry/pull/1762), which adds
exactly this, is a change *inside* wry. Forking wry for a throwaway is not
proportionate, so Experiment 1c owns its own window. **The Liberty application
is not touched.** wry#1762 is cited as reference for its input-forwarding map
and **not vendored** — it is a fork of wry 0.55.1, describes itself as
unverified by CI, and its touch, pen and OLE drag-drop paths are explicitly
best-effort or untested.

## 5. The question for you

D1 is yours and I have not changed it. Specifically:

1. **Does D1 survive on the composition path**, with §1's diagram replaced —
   no child HWND, no `wid`, one DComp visual tree — or is the §10 pivot
   (wry/tao, or `webview2` + `native-windows-gui` directly) now the live
   option?
2. **Should the Stremio divergence be chased first?** Experiment 1c is a new
   mechanism; finding why a known-good arrangement failed for us might be
   cheaper and would certainly be more informative.
3. **If 1c succeeds, what happens to the shell library?** Either Tauri has to
   be made to create a composition controller — which means wry#1762 or
   something like it, vendored and maintained — or the experiment's minimal
   host grows into the shell. Both are real costs and neither is my call.
4. **Is the minimal-host decision in §4 sound**, or have I missed a way to
   reach a composition controller from inside Tauri 2.12.0?

## 6. What Experiment 1c can and cannot establish

It can establish that the host compiles and links in Windows CI, and that is
all CI can establish. **Every one of the eight acceptance criteria the
commander set is something a person has to look at on real hardware**, and the
OS/GPU/DPI matrix is unchanged and unmet. A green build is not a pass, and I
have not recorded one as such for three rounds running.

## 7. Review debt I am carrying, stated rather than tidied

Four tasks are parked on `experiments/**` awaiting your verdict: **PL-0748,
PL-0749, PL-0750** are BLOCKED, each with its engineering complete and each
proven correct by the very run that found the next defect. They are blocked
only because `pathsOverlap` reserves one path for one task and the fixes had
to be sequential; `release` is refused from REVIEW, correctly, and `BLOCKED`
cannot reach `DONE`, so **each will need its `build` gate re-recorded** after
unblocking. The underlying cause is that all three declared
`allowedPaths: ["experiments/**"]` when their real write surface was one
directory. PL-0752 declares `experiments/exp-1c/**` instead. I have **not**
narrowed the three parked declarations, because `allowedPaths` is part of the
surface your verdict fingerprints and changing it under a reviewer is the thing
the lock exists to prevent.

Also awaiting you: **PL-0736, PL-0740, PL-0743, PL-0745, PL-0746**.

Your **PL-0741 `changes_requested`** message arrived and is read. You are
right: `sidecarLog()` returns a raw `tail` and the fixture asserts only
`JSON.stringify(log.handshake)`, so the test passes while the report carries
the secret. That is queued behind this round's player work and is not
forgotten.
