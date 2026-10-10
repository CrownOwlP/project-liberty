# Windows desktop playback — the shell, the sidecar, and the PlayerAdapter boundary

> PL-0901. Recorded 2026-09-15, before any of it is built, because the decision is large and
> expensive to reverse once a shell exists. **This task writes documentation only.** No shell, no
> adapter, no dependency and no source file is added by it; `control/tasks.json` declares
> `docs/DESKTOP_PLAYBACK.md` and `docs/ARCHITECTURE.md` as its entire write surface.
>
> **§8 was ruled by the commander on 2026-09-16** and now records a decision rather than the open
> question it published through round 42. Everything else is as recorded on 2026-09-15.
>
> Every version number, API identifier and licence quotation below comes from research verified
> against primary sources on 2026-09-15 (`desktop-research-01-shell-and-mpv.md`,
> `desktop-research-02-sidecar-and-security.md`). §11 states what was verified, what was not, and
> which specific facts would reverse each decision. Re-verify anything more than a few weeks old
> before acting on it.
>
> **The ADR-register entry for this decision is not written yet.** `docs/DECISIONS.md` is PL-0405's
> declared `allowedPaths` surface and PL-0405 is in REVIEW; appending an ADR there now would write
> into a file another task is being reviewed against, which is exactly the collision the control
> plane's path declarations exist to prevent. The register pointer — an `ADR-0xx — Windows desktop
> shell and the PlayerAdapter boundary` stub whose body is a link to this document — lands once
> PL-0405 clears review, and the number is not reserved here because the register is appended by
> whoever holds the file.

---

## 0. The decisions, and what each one rests on

| # | Decision | The evidence that decides it | The strongest argument against |
| --- | --- | --- | --- |
| D1 | **Tauri v2 shell** (pin `2.11.x`; current `2.11.5`, 2026-07-01) | HTML chrome composited over a hardware-accelerated native video surface, in one window, on Windows: supported and shipping on WebView2, unsupported on Chromium | WebView2 is Microsoft's, evergreen, and unpinnable; we cannot roll back a compositing regression under our users |
| D2 | **The existing Next.js app is preserved**, served by a **Next standalone sidecar** | `output: 'export'` deletes route handlers, `proxy.ts`, `cookies()`, `headers()`, Server Actions and ISR; `output: 'standalone'` keeps all of them | The precedent is one six-month-old app; cold start is unmeasured; Tauri's CSP injection does not reach an external http origin; we write the supervision code ourselves |
| D3 | **A `PlayerAdapter` boundary** the application and domain layers depend on | Two engines with disjoint strengths must be interchangeable without either one's types reaching the app | A boundary written before either implementation exists will be wrong somewhere; the mitigation is that it is small and that the state machine, not the adapter, holds the truth |
| D4 | **libmpv** for compatible non-DRM playback, **Shaka/EME** for DRM-capable playback, **capability routing explicit before playback** | mpv has no CDM and cannot be given one; Shaka has no MKV, no libass, no per-frame timing telemetry | Two engines is two failure surfaces, two telemetry shapes and two sets of bugs, for a product whose first principle is playback reliability |
| D5 | **Our own LGPL-compatible libmpv/FFmpeg build pipeline**, not a prebuilt | A stock prebuilt libmpv is a GPL build; the one LGPL variant on offer statically links an LGPLv3 FFmpeg and carries its builder's own no-warranty disclaimer | It is a week of build engineering for an artifact that does not exist yet, spent before the compositing proof says the architecture is real at all |
| D6 | **Provider resolution is proxied to an authenticated backend in the desktop build**, never resolved on the user-administered sidecar — **ruled by the commander on 2026-09-16** (§8) | A resolution boundary running on a machine its user administers is one they can read, patch and replace, with provider credentials in its environment | It adds a network round trip to the resolution path and a second route implementation that the web build never exercises |

**The second research report corrected the first on three points.** This document carries the
corrected version of each deliberately, and says so, because a document that quietly presents the
superseded version is worse than one that shows its working:

1. **The open-TCP-port objection against a sidecar was overweighted.** A loopback listener with a
   per-launch bearer token and `Host` validation is *more* defensible than mpv's JSON IPC over a
   named pipe, because our HTTP server can authenticate and mpv's IPC protocol cannot — mpv's own
   documentation says it is *"explicitly insecure: there is no authentication, no encryption"* and
   exposes `run`, which runs arbitrary system commands. The first report ranked these backwards.
   The argument that survives against a sidecar is not the port; it is the trust-boundary argument in
   §8, which is now ruled rather than open.
2. **Tauri's installer-size advantage does not survive the sidecar.** Measured at the one production
   precedent: ~160 MB total with 84 MB of Node, against ~200 MB for a comparable Electron app —
   roughly 1.25x, not 4x. **No size-based reasoning appears anywhere below**, and if it reappears in
   a later document it is wrong. The reason to choose Tauri is compositing and only compositing.
3. The third is narrower: **`pkg` is not dead.** Tauri's Node-sidecar guide links
   `@yao-pkg/pkg` 6.22.0 (2026-07-30), the maintained fork, not the archived `vercel/pkg`. The
   problem with the guide is worse than staleness and is stated in §2: the recommended approach
   cannot package a Next standalone server at all.

---

## 1. D1 — the shell is Tauri, and compositing is the whole reason

### What the product needs the shell to do

Put an HTML interface — controls, overlays, a subtitle layer, a spinner with real alpha — **on top
of a hardware-decoded native video surface, in one window**, on Windows, without the two layers
drifting apart during a drag, a resize or a monitor change.

### Why WebView2 can

`ICoreWebView2Controller2::put_DefaultBackgroundColor` accepts an alpha value restricted to
**exactly 0 or 255** — anything else returns `E_INVALIDARG` — and at `A=0` Microsoft's reference
says *"the hosting app's background content is rendered instead"*
([Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2)).
Windows 7 is the only excluded platform. That yields the arrangement directly:

```text
Top-level HWND (app window)
├── child HWND  ──►  mpv --wid, vo=gpu-next, gpu-context=d3d11   (below)
└── WebView2 controller HWND, DefaultBackgroundColor A=0         (above)
```

mpv renders through its own D3D11 pipeline with hardware decode and no texture copies; the HTML
floats over it.

**This is not a theory.** Stremio ships it in production on Windows: `stremio-shell-ng` sets
`wid` to the window handle, `vo=gpu-next,gpu,`, `gpu-context=d3d11`, `hwdec=auto`, and calls
`put_default_background_color(Color { r:255, g:255, b:255, a:0 })`. Their README quantifies the
alternative they abandoned — rendering through `mpv_render_context` into a Qt FBO — as **2–5x less
efficient**, because the ANGLE and multi-stage compose pipeline *"inhibits full HW acceleration."*
That is a measured verdict against the render-API-into-a-texture approach, from a shipping product,
on our exact platform.

### What happened when we built it — Experiment 1a, 2026-10-06 to 2026-10-10

**The arrangement in the diagram above was built and run on real hardware three times, and it did
not composite.** The evidence is recorded here rather than left in the experiment's own README,
because §1's argument rests on it.

What the third run (PL-0750, commit `846a1f4`) proved, all of it from the harness's own diagnostic
log plus the commander's eyes on the screen:

| | |
| --- | --- |
| the local HEVC file | opens |
| mpv initialisation | succeeds |
| D3D11 on an NVIDIA RTX 3050 | initialises |
| `hwdec-current` | `d3d11va` — hardware decode **active** |
| the video output | `gpu-next`, 1280x720 |
| the first video frame | reported **shown** by mpv |
| the child HWND | 1280x720, correct, at `HWND_BOTTOM` |
| the HTML Pause button | reaches mpv and toggles `pause` |
| `put_DefaultBackgroundColor(0,0,0,0)` | **accepted, and reported successful** |
| **what the commander saw** | **the WebView UI, and no video at all** |

So against §10's criteria: criterion 1 (hardware decode) **PASS**, criterion 3 (click and control)
**PASS**, criterion 2 (compositing) **FAIL**, criteria 4–7 **unobserved** because they sit behind
criterion 2. **Experiment 1a is NOT PASS.**

Two earlier runs are worth recording because each one removed a different explanation. The first
(PL-0748) showed only that the harness could not explain itself — `terminal=no` was silencing mpv
and nothing drained its event queue; the fix was instrumentation, not architecture. The second
(PL-0749) found a one-line geometry defect: `SetWindowPos` was called with `cx=0, cy=0` and without
`SWP_NOSIZE`, resizing the child to nothing one statement after creating it at the right size. Only
after both were fixed did the third run isolate the remaining question — and the answer was that
nothing below the webview was wrong.

**What this result does and does not establish.** It establishes that *this* arrangement — a sibling
child HWND at `HWND_BOTTOM` beneath a **windowed** WebView2 controller, made transparent through
`put_DefaultBackgroundColor` — did not show video on one Windows machine with one GPU. It does
**not** establish that WebView2 cannot composite, that Tauri is the wrong shell, that
DirectComposition will work, or that Stremio's shipping arrangement is broken.

**And the Stremio citation above is still true**, which is the uncomfortable part. A shipping
product sets `wid`, uses `vo=gpu-next,gpu`, `gpu-context=d3d11`, `hwdec=auto`, and calls
`put_default_background_color` with `a: 0` — the same four things this harness did. **The difference
between their result and ours is not explained.** Candidate differences not yet tested: Stremio uses
wry/tao directly rather than Tauri, so the window styles, the webview's own parenting and the
message loop are not identical; their window may be composed differently with respect to DWM; and
the harness's own HTML, CSP and layering are its own. An unexplained divergence from a shipping
product is a finding in its own right, and it is the reason the verdict above is scoped to the
arrangement as *this harness built it* rather than to the arrangement in principle.

### Why Chromium cannot

Four options, all of them dead ends:

- **Child HWND via `SetParent`.** Chromium no longer keeps child HWNDs in its window hierarchy and
  its compositor paints opaquely over its own surface; the child either occludes all web content or
  is invisible. [electron#26729](https://github.com/electron/electron/issues/26729) describes this
  exactly and was closed as `blocked/need-repro` — not fixed, not supported.
- **Two top-level windows**, video below and a frameless transparent window above. Two DWM surfaces
  with no shared present: the UI and the video desynchronise during drag and resize, there are two
  taskbar entries, and click-through needs `setIgnoreMouseEvents` plus forwarding. Acceptable for a
  game HUD; not for chrome that must track the video frame pixel-exactly.
- **Offscreen render into a texture.** `MPV_RENDER_API_TYPE_SW` is described in `render.h` itself as
  *"an extremely simple (but slow) renderer to memory surfaces"*; the GPU variant is what Stremio
  measured at 2–5x worse. **There is no D3D render-API backend** — the header lists exactly two,
  OpenGL and SW — so on Windows the render API forces ANGLE or CPU memory.
- **PPAPI**, which is what `mpv.js` used. Removed from Chromium. `mpv.js` last released 2018-07-28.

A search specifically for a shipping Electron + mpv application with UI over video found none. Every
serious one — Stremio, Jellyfin Media Player — uses Qt or WebView2.

### The strongest argument against D1, stated properly

**WebView2 is not ours.** Electron's real advantage is that we ship the exact Chromium we tested.
WebView2 is evergreen: Microsoft updates it under our users, and a regression in transparency or
compositing would be a production incident we can neither roll back nor hotfix — only wait out. For
a product whose differentiator is video rendering, handing rendering-adjacent behaviour to an
auto-updating OS component is a genuine, permanent risk.

Partial mitigations, neither of them free: WebView2 supports **fixed-version distribution** (ship a
pinned runtime, ~150 MB), which restores determinism and is worth keeping in the back pocket as
incident response rather than as the default; and Stremio is a large, visible consumer of exactly
this API, which makes a silent Microsoft regression in it somewhat less likely to go unnoticed.

Two further costs, neither of which changes the decision but both of which are real:

- **Rust and MSVC on the shell developer's machine.** A one-time setup and ~20 lines of CI. It does
  not touch the Next.js app: frontend work keeps running `next dev` and never installs Rust. The
  **bus factor does** need budgeting as a staffing decision rather than waved away — plan for two
  people able to work in the shell before launch. Stremio's entire mpv module is ~716 lines, much of
  it HDR display configuration we do not need at first, so the surface is small but it is owned.
- **Tauri's own IPC security is origin-string-based and has had a parsing bug.**
  [GHSA-7gmj-67g7-phm9](https://github.com/tauri-apps/tauri/security/advisories/GHSA-7gmj-67g7-phm9),
  *"Origin Confusion Allows Remote Pages to Invoke Local-Only IPC Commands"*, CVSS v4 6.1, affected
  2.0 through 2.11.0 and was patched in 2.11.1. We would be on 2.11.5 and therefore patched; the
  lesson to carry is not the CVE but its class, and it argues for §2's `frontendDist` path over a
  widened remote capability.

### And what happened when we built the replacement — Experiment 1c, 2026-10-10

**The DirectComposition arrangement works.** Observed by the commander on his own Windows machine,
against `b407c78`:

| | |
| --- | --- |
| native video | **visible, and playing** |
| the layering | DirectComposition renders the video **beneath** WebView2 |
| the transparent overlay | **works** — the magenta-to-cyan gradient composites over the video |
| the HTML controls | **render above the video** |
| the Pause/Resume button | **pauses and resumes playback** |
| hardware decode on the RTX 3050 | confirmed by the **earlier** diagnostic log, not re-observed in this run |

Evidence: a screenshot and the commander's direct observation.

**What that settles.** A libmpv **composition** swapchain
(`--d3d11-output-mode=composition`) and a **composition-hosted** WebView2
(`CreateCoreWebView2CompositionController` + `SetRootVisualTarget`) can live in one
`IDCompositionTarget`'s visual tree, composite with real per-pixel alpha, and take input — on one
machine. The last defect was a z-order inversion: `AddVisual`'s NULL-reference case is documented
the opposite way round from its parameter name, so the video was being added on top of the webview.

**What it does not settle, and no gate may claim from it.** Resize, window move, per-monitor DPI
change, telemetry rate and clean shutdown were not reported, so **five of the eight criteria are
unobserved**. The OS/GPU/DPI matrix below is unchanged and still one machine, one NVIDIA dGPU, one
scaling. Production integration had not begun when this was observed. Licensing is untouched.

**And it does not by itself make this arrangement reachable from the product.** See the paragraph
after next: composition hosting is a creation-time WebView2 decision, Tauri cannot make it, and
what that costs is a decision for architecture review rather than something this document settles.

One alternative was deliberately deferred rather than rejected, and **the deferral has now been
superseded by evidence** — recorded as superseded rather than quietly rewritten, because the
reasoning for it was sound when it was written.

> *As written on 2026-09-15:* mpv 0.41.0 added `--d3d11-output-mode=composition`, which creates a
> D3D11 swapchain **with no window** and exposes its address through the `display-swapchain` property
> (`--d3d11-composition-size=<WxH>` sets the size); mpv's docs say *"If you want to use the D3D11 GPU
> backend in WinUI applications, you need to set this to composition."* It is the modern
> DirectComposition-visual path and is strictly better than `wid` for advanced compositing — but it
> requires host code that can build a DComp visual tree, and it is **not** what Stremio ships. Treat
> it as a v2 optimisation with `wid` proven first, not as the v1 plan.

The condition that deferral rested on was *"with `wid` proven first"*. **`wid` was tried and was not
proven** — see the Experiment 1a result above. So the composition path is no longer a v2
optimisation; it is the candidate replacement, and the one stated obstacle to it — *"it requires host
code that can build a DComp visual tree"* — is simply the work. That work is **PL-0752, Experiment
1c**, and the three facts it needs were verified against source before any code was written:

- `--d3d11-output-mode=composition`, `--d3d11-composition-size=<WxH>` and the `display-swapchain`
  property are all present **at the exact mpv commit this project already pins**, `c152964208`
  (`video/out/d3d11/context.c`, `options/options.c`, `player/command.c`), so neither the pin nor its
  digest has to move.
- `ICoreWebView2Environment3::CreateCoreWebView2CompositionController` and
  `ICoreWebView2CompositionController`'s `SetRootVisualTarget`, `SendMouseInput`, `SendPointerInput`
  and `add_CursorChanged` are present in the already-locked `webview2-com-sys` 0.39.1.
- `DCompositionCreateDevice`, `IDCompositionDevice`, `IDCompositionTarget::SetRoot` and
  `IDCompositionVisual::SetContent`/`AddVisual` are present in the already-locked `windows` 0.62.2
  behind feature `Win32_Graphics_DirectComposition`.

**One structural fact decides where that host code lives, and it is worth stating plainly: composition
hosting is a creation-time decision.** The webview must be created through
`CreateCoreWebView2CompositionController` *instead of* `CreateCoreWebView2Controller`. wry and
therefore Tauri always create a **windowed** controller and hand it out afterwards through
`with_webview`; there is no post-hoc conversion from one to the other. That is why
[tauri-apps/wry#1762](https://github.com/tauri-apps/wry/pull/1762), which adds exactly this, is a
change *inside wry* rather than something an application can add from outside. Experiment 1c
therefore owns its own window and its own webview creation. It does not rewrite the Liberty
application, and it does not vendor that PR — the PR is a fork of wry 0.55.1, is unverified by CI by
its own account, and its touch, pen and OLE drag-drop paths are explicitly best-effort or untested.
What it is cited for is its input-forwarding map, which production use did exercise.

Note also that the composition path is plausible in Rust and essentially impossible from an Electron
main process, which is one more reason the shell choice does not turn on it.

### The integration blocker, measured 2026-10-10 and unresolved

Experiment 1c works. **It is not yet reachable from `apps/desktop`,** and the reason is the same
creation-time fact stated above, now with the versions filled in:

- `apps/desktop/src-tauri/Cargo.toml` pins `tauri = "=2.12.0"`, which resolves `wry 0.57.0`
  (`apps/desktop/src-tauri/Cargo.lock`).
- `tauri-apps/wry#1762`, which adds composition hosting, is **not merged**: `src/lib.rs` on wry's
  `dev` branch contains no occurrence of `composition`, `with_composition_visual_target` or
  `register_composition_visual_target`. The PR is a fork of **wry 0.55.1**; we are on 0.57.0.
- So there is no released or upstream wry that can create a composition controller, and Tauri
  offers no way to convert the windowed one it creates.

Three routes, and **none of them is taken here**, because the choice is D1's and D1 is with the
reviewer:

| route | what it costs |
| --- | --- |
| **Vendor a patched wry** under `[patch.crates-io]`, porting #1762's `register_composition_visual_target` registry to 0.57.0 | a ~30k-line fork of a core dependency that we then own and must rebase on every wry release. #1762 was explicitly designed so `tauri-runtime-wry` needs no changes, so the patch is narrow — but the maintenance is not |
| **Grow Experiment 1c's own host into the shell**, replacing Tauri | loses Tauri's IPC, capability ACL, bundler, updater and config; the shell's 3,319 tested lines in `apps/desktop/src-tauri/src/` are written against `ShellHost`, not against Tauri, so they survive — but the window, the event loop and the IPC do not |
| **Upstream #1762 or wait for it** | no fork to maintain, no control over the schedule |

Until one is chosen, `apps/desktop` keeps the arrangement §1 opens with, which **failed** — so the
product has no working native video path even though the experiment has one. That gap is the live
state of D1 and it is stated here rather than left to be rediscovered.

Tauri 3.0 is **13% complete with no due date, last touched 2026-06-18**, and its planned breaking
items are mostly Linux. Nothing suggests a forcing function inside our horizon; building on Tauri 2
is safe.

---

## 2. D2 — the application is preserved by a standalone sidecar

### What a static export would cost

Tauri's own Next.js guide is unambiguous — *"Tauri doesn't support server-based solutions"* — and
tells you to set `output: 'export'`. Against Next 16.3.5's static-export documentation, that removes:

| Feature | Under `output: 'export'` |
| --- | --- |
| Route handlers (`/api/v1/...`) | **GET only**, must be `force-static`, **cannot read `Request`** — build-time-frozen JSON |
| `proxy.ts` (ex-`middleware.ts`) | Unsupported |
| `cookies()` / `headers()` | Unsupported |
| Server Actions | Unsupported |
| ISR, Draft Mode, rewrites/redirects/headers, intercepting routes | Unsupported |
| `next/image` default loader | Needs a custom loader or `unoptimized: true` |
| Server Components | Work — they execute at `next build` and render to static HTML plus an RSC payload |

Moving every `/api/v1` route off Next and reworking every fetch path is a change to the
application's architecture, on the critical path, and the instruction for this target is that the
application is preserved rather than rewritten.

### What the sidecar keeps, and what it costs

`output: 'standalone'` under 16.3.5, verified against Next's self-hosting guide, keeps **all** of
it: dynamic Server Components, route handlers with every verb and a full `Request`, `proxy.ts`
(*"works self-hosted with zero configuration"*), `cookies()`, `headers()`, Server Actions, ISR and
Cache Components, and `next/image` optimisation (which needs `sharp`, a native addon).

The costs, each of which is work somebody has to do:

- **A Node runtime in the bundle.** `node-v24.21.0-win-x64.zip` is 35 MB compressed;
  installer-compressed, that is roughly the delta. **`pkg`, Node SEA and Bun `--compile` cannot
  swallow a Next standalone server**: `output: 'standalone'` produces a *directory tree*
  (`server.js` plus a traced `node_modules` subset plus `.next/`, and it does not even copy `public`
  or `.next/static` — you do that yourself), Node SEA is Stability 1.1 and supports a single
  embedded script, and `sharp` is a native addon that rules out a pure-JS single binary
  independently. [vercel/next.js discussion #80621](https://github.com/vercel/next.js/discussions/80621)
  is unanswered, with multiple developers reporting the same blockers. **So the packaging is
  `node.exe` plus the standalone tree shipped as Tauri `bundle.resources`, spawned as
  `node.exe server.js`** — not `externalBin`, which takes single target-triple-suffixed binaries.
- **A loopback listener**, with the controls §7 states.
- **Supervision code, which Tauri does not provide.** No restart, no health check, no lifecycle
  management; if the sidecar dies the webview shows a connection error and the app is bricked until
  relaunch. Orphan processes are the most consistently reported production problem with Tauri
  sidecars ([plugins-workspace#3062](https://github.com/tauri-apps/plugins-workspace/issues/3062),
  an open request for a lifecycle plugin that is **not shipped**). The remedy is a **Win32 Job
  Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**, which survives `TerminateProcess` where no
  signal handler does — **and we need that Job Object for mpv regardless**, so the marginal
  lifecycle cost of adding the Node sidecar to an existing job is close to zero. One Windows
  wrinkle: Next wants `SIGINT`/`SIGTERM` to drain in-flight requests and run `after()` callbacks,
  and **Windows has no `SIGTERM`**; a job kill is abrupt. Fine for a single-user local app that does
  not use `after()`, and a shutdown handshake is needed the moment it does.
- **Tauri's CSP injection stops applying.** `app.security.csp` is injected only into *bundled*
  assets and `data:` URLs. With an external http origin **Tauri cannot inject CSP into our pages at
  all**; the Next server must emit its own `Content-Security-Policy`, and Tauri's automatic
  nonce/hash management for its injected scripts is lost. This moves a security control from
  "the framework guarantees it" to "we remembered to configure it", and it belongs on the release
  checklist as an assertion, not a convention.

### Wiring, and the one part that needs a spike

Spawn the sidecar with `PORT=0` and have **the sidecar report its actually-bound port on stdout**
rather than being told which port to use — the pick-then-bind window is a TOCTOU race, and the one
production precedent hit the related failure (build-time-baked port env vars silently disagreeing
with runtime-assigned ports).

> **Corrected in round 95 (PW-0105).** This paragraph used to open "Discover a free port with
> `portpicker`". gpt-architect's ruling rejects that in terms — *"Do NOT replace the
> kernel-selected-port design with shell-selected/free-port probing"* — and the rest of the
> paragraph was already arguing against it. The kernel chooses; the child reports. The reporting
> half is implemented in `apps/web/src/lib/sidecar/bootstrap.ts`, which obtains the port from the
> live listener and never from `PORT`.

Then either:

- `Manager::add_capability(CapabilityBuilder::new(..).remote(url).window("main"))` — a real runtime
  API, gated behind the `dynamic-acl` cargo feature, which is **enabled by default**. This is the
  documented path and it widens the IPC origin surface to an http origin; or
- mutate `Context::config_mut()`'s `build.frontendDist` to the discovered URL before
  `Builder::run(context)`, after which `get_app_url()` reads it and `Webview::is_local_url()`
  considers the page **local** — default capabilities apply, no remote grant, no widened IPC
  surface. **This is the preferred path** and it is public API that mechanically produces the right
  result rather than a documented pattern. **Flag: unverified. Experiment 1b settles it**, and the
  documented `.remote()` path is the fallback with its widening recorded.

Compositing is unaffected by any of this. `put_DefaultBackgroundColor` is a property of the
controller, not of the loaded document's origin; wry sets it unconditionally when transparency is
requested; `wid` embedding is Win32 window management that has no idea a document was loaded, let
alone from where; and Tauri's `__TAURI_INVOKE_KEY__` guard arrives through the webview's
initialisation script, which runs regardless of origin.

### The strongest argument against D2

**The precedent is one app.** [Beadbox](https://github.com/vercel/next.js/discussions/90982) —
Next 16 inside a Tauri v2 sidecar, posted 2026-03-06, self-reported as production, built by a team
that says it used eight AI coding agents. That is not the class of evidence Stremio is for the mpv
half. No Tauri + Next-standalone example was found that has run in production for years at scale, and
the closest canonical example
([dieharders](https://github.com/dieharders/example-tauri-v2-python-server-sidecar)) is a static
export with a *separate* API sidecar, which is a different shape. **The shell half of this stack
would be its least-proven part.**

And **cold start is unmeasured.** A static export loads from a protocol handler, effectively
instantly; a sidecar pays process spawn plus Node bootstrap plus `server.js` require plus first
render, serially, before first paint. No credible published benchmark for Next standalone boot on a
desktop-class machine was found and none is invented here. It is an afternoon's measurement
(experiment 1b, step 4) and it decides whether a splash window is optional or mandatory. It is
exactly the kind of number that gets discovered after an architecture is locked.

---

## 3. D3 — the `PlayerAdapter` boundary

### What it is for

The application and domain layers depend on **`PlayerAdapter`**, never on a concrete player. Two
implementations sit behind it (§4). The boundary exists so that which engine is playing is a fact
about the build target and the candidate, not a fact the rest of the application has to know.

### The rule the boundary enforces

> **No `shaka-player`, `mpv`/`libmpv`, `@tauri-apps/*` or `electron` type is reachable from
> `PlayerAdapter` or from anything it imports.**

Reachable is the operative word, and it is mechanical rather than aspirational:

- **No `any`, anywhere in the boundary module.** `any` is the escape hatch that makes the rule
  unenforceable, because an engine handle passed as `any` satisfies every type check on the way out.
- **No engine handle passthrough.** There is no `getUnderlyingPlayer()`, no `nativeHandle`, no
  `mpvContext`. A caller that wants something the interface does not offer gets a new method with a
  stated meaning, or does without.
- **No opaque configuration passthrough.** `EngineConfig` in
  `apps/web/src/components/player/engine.ts` is `Readonly<Record<string, unknown>>` — a Shaka
  configuration fragment passed through untouched — and that is correct *there*, below the
  boundary, where it is deliberately opaque so PL-0503 can switch CMCD on without editing the port.
  **It must not be promoted onto `PlayerAdapter`**, because a `Record<string, unknown>` that
  everyone knows is really Shaka's config tree is a Shaka type wearing a structural disguise, and
  the mpv adapter would have nothing honest to do with it.
- **Enforced by a test, not by review.** This repository already has the mechanism: the A/V
  diagnostics directory is scanned for `PROHIBITED_AV_INSTRUMENTATION` identifiers by a test, so the
  prohibition is executed rather than remembered. The same shape applies here — a test walks the
  boundary module's import graph and fails on a forbidden specifier. Without it, the rule survives
  exactly until the first hurried afternoon.

Note the existing `ShakaEngine` / `ShakaPlayerHandle` port in `engine.ts` is **not** this boundary
and is not replaced by it. That port is the seam *inside* the web implementation, which exists so
Shaka can be injected and tested without a DOM. `PlayerAdapter` sits one layer above it, and the web
adapter is what connects the two.

### The interface

```ts
/* -------------------------------------------------------------------------
 * PlayerAdapter — the only playback surface the application and domain layers
 * may depend on.
 *
 * NOTHING IN THIS FILE OR ITS IMPORT GRAPH MAY REACH shaka-player, libmpv,
 * @tauri-apps/* OR electron. There is no `any` below, no engine handle is
 * returned by any method, and no opaque engine-configuration bag crosses this
 * line. A test asserts all four, because a rule about a module graph that is
 * checked by review is a rule that holds until the first hurried afternoon.
 * ---------------------------------------------------------------------- */

import type { PlaybackCandidate, PlaybackSession } from "./playback-session";

/** Which implementation. An identity for the reason trail, never a switch. */
export type PlayerAdapterId = "web-shaka" | "native-mpv";

/* --- capability routing -------------------------------------------------- */

/**
 * Why an adapter refuses a candidate. A CLOSED vocabulary, because a refusal
 * that reports free prose cannot be counted, grouped or alerted on, and
 * invariant 4 asks for a reason trail sufficient to debug candidate selection.
 */
export type PlayerRefusalCode =
  | "drm_required_no_cdm"
  | "protocol_unsupported"
  | "container_unsupported"
  | "video_codec_unsupported"
  | "audio_codec_unsupported"
  | "adaptive_bitrate_required"
  | "transport_not_permitted"
  | "adapter_unavailable";

/**
 * The answer to "can this adapter play this candidate", WITH A REASON ON BOTH
 * BRANCHES.
 *
 * An accepted candidate carries a reason for the same purpose a refused one
 * does: when playback then fails, the trail has to be able to say what the
 * router believed and on what evidence, and "it was not refused" is not that.
 * `confidence` mirrors `CompatibilityConfidence` in @liberty/contracts and means
 * the same thing here — `unverified` says nothing disqualified the candidate,
 * not that anything qualified it, so a decode failure on an `unverified`
 * acceptance is a normal outcome rather than a defect.
 */
export type CanPlayDecision =
  | {
      readonly playable: true;
      readonly adapterId: PlayerAdapterId;
      readonly confidence: "verified" | "unverified";
      readonly reason: string;
    }
  | {
      readonly playable: false;
      readonly adapterId: PlayerAdapterId;
      readonly refusal: PlayerRefusalCode;
      readonly reason: string;
    };

/* --- what a load is ------------------------------------------------------ */

/**
 * A load request names the AUTHORIZED SESSION and which of its candidates to
 * start, not a URL. The adapter reads the address off the candidate the session
 * published; it has no other way to obtain one and no method that accepts one.
 * See §7.
 */
export interface PlayerLoadRequest {
  readonly session: PlaybackSession;
  readonly candidateId: string;
  /** SECONDS, matching everything else in this directory. `null` = engine default. */
  readonly startAtSeconds: number | null;
  /**
   * Correlates every event this load produces. Monotonic per adapter instance.
   *
   * REQUIRED rather than generated internally, because the caller must be able
   * to discard events from a load it has already superseded — which is the same
   * problem `#loadToken` solves in `playback-controller.ts` and the same one
   * mpv's START_FILE/FILE_LOADED/PLAYBACK_RESTART correlation solves in §5.
   */
  readonly loadId: number;
}

/* --- what the adapter reports ------------------------------------------- */

export interface PlayerTimeline {
  readonly positionSeconds: number;
  /** `null` = not yet known, or a live stream with no duration. NEVER 0 for unknown. */
  readonly durationSeconds: number | null;
}

export type PlayerTrackKind = "audio" | "subtitle";

export interface PlayerTrack {
  readonly id: string;
  readonly kind: PlayerTrackKind;
  readonly label: string | null;
  /** BCP-47 where the source states one. `null` = unstated, never "und" invented by us. */
  readonly language: string | null;
  readonly codec: string | null;
  readonly channels: number | null;
  readonly isDefault: boolean;
  readonly isForced: boolean;
}

export type PlayerErrorSeverity = "recoverable" | "fatal";

export interface PlayerError {
  readonly severity: PlayerErrorSeverity;
  /**
   * TRUE when WE ended the operation — a superseded load, a stop we issued.
   * The state machine already has this concept and ignores such errors; an
   * adapter that reports its own control flow as a candidate failure makes every
   * failover look like a fault caused by the candidate it failed over TO.
   */
  readonly selfInflicted: boolean;
  /** Already redacted. No signed query strings, no raw engine payload. */
  readonly message: string;
  /** The adapter's own code, namespaced by adapter. Never cross-engine. */
  readonly code: string | null;
}

/**
 * A/V sync telemetry is OPTIONAL BY CAPABILITY, and an absent reading is not a
 * zero.
 *
 * `docs/AV_SYNC_MEASUREMENT.md` already draws this distinction for the browser
 * proxies and it is drawn the same way here: a quiet reading means the
 * comparison was made and found nothing; an unavailable reading means it could
 * not be made, and it carries NO magnitude, because a number in that position
 * would be an invention. A dashboard that averages absent readings as 0 reports
 * perfect synchronisation for a player that cannot measure it.
 *
 * NOTHING HERE IS A LIP-SYNC MEASUREMENT. mpv's `avsync` is the player's own
 * last A/V scheduling difference, not presented alignment; the external
 * flash-and-blip rig remains the only source of `com.liberty-avs-lip-sync-offset`
 * and this union must never be mapped onto that metric.
 */
export type AvSyncUnavailableReason =
  | "adapter_cannot_observe"
  | "audio_or_video_disabled"
  | "requires_display_sync"
  | "not_yet_sampled";

export type AvSyncTelemetry =
  | { readonly available: false; readonly why: AvSyncUnavailableReason }
  | {
      readonly available: true;
      /** The engine's internal A/V difference, SECONDS. A proxy, not a measurement. */
      readonly internalAvSyncSeconds: number;
      /** `null` where the engine does not report it. Never 0 for absent. */
      readonly totalCorrectionSeconds: number | null;
      readonly framesDroppedByOutput: number | null;
      readonly framesDroppedByDecoder: number | null;
    };

export type PlayerAdapterStatus =
  | { readonly status: "idle" }
  | { readonly status: "initialising" }
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "disposed" };

/**
 * Everything the adapter reports, as one union delivered to one listener.
 *
 * One stream rather than an event-emitter surface per concern, because the
 * consumer is a state machine that must see these in order: a `buffering` that
 * overtakes the `loaded` for the same load is precisely the desync the mirror
 * rule in `playback-machine.ts` exists to prevent.
 */
export type PlayerAdapterEvent =
  | { readonly type: "status"; readonly status: PlayerAdapterStatus }
  | { readonly type: "loadstarted"; readonly loadId: number }
  | {
      readonly type: "loaded";
      readonly loadId: number;
      readonly timeline: PlayerTimeline;
      readonly tracks: readonly PlayerTrack[];
    }
  | { readonly type: "playing"; readonly loadId: number }
  | { readonly type: "paused"; readonly loadId: number }
  | { readonly type: "position"; readonly positionSeconds: number }
  | { readonly type: "duration"; readonly durationSeconds: number | null }
  | {
      readonly type: "buffering";
      readonly stalled: boolean;
      /** 0–100 where the engine reports it; `null` where it does not. */
      readonly fillPercent: number | null;
    }
  | { readonly type: "seekstarted"; readonly positionSeconds: number }
  | { readonly type: "seekcompleted"; readonly positionSeconds: number }
  | { readonly type: "tracks"; readonly tracks: readonly PlayerTrack[] }
  | {
      readonly type: "trackselected";
      readonly kind: PlayerTrackKind;
      readonly trackId: string | null;
    }
  | { readonly type: "volume"; readonly level: number; readonly muted: boolean }
  | { readonly type: "error"; readonly loadId: number | null; readonly error: PlayerError }
  | { readonly type: "ended"; readonly loadId: number }
  | { readonly type: "telemetry"; readonly avSync: AvSyncTelemetry }
  /**
   * The adapter lost events and has re-read its state from the engine. Not an
   * error: mpv drops events on MPV_EVENT_QUEUE_OVERFLOW and the obligation is to
   * resync (§5). Surfaced because a session that resyncs repeatedly is a session
   * whose telemetry has holes, and a silent hole reads as a clean run.
   */
  | { readonly type: "resynchronised"; readonly droppedEvents: number | null };

/* --- the boundary ------------------------------------------------------- */

export interface PlayerAdapter {
  readonly id: PlayerAdapterId;

  /**
   * A REASONED DECISION TAKEN BEFORE PLAYBACK, not a guess discovered at load
   * time. Pure and synchronous: it reads the candidate's capability descriptor
   * and this adapter's declared capabilities, and it performs no I/O.
   */
  canPlay(candidate: PlaybackCandidate): CanPlayDecision;

  /** Load an authorized playback session's candidate. Rejects if `canPlay` refuses. */
  load(request: PlayerLoadRequest): Promise<void>;

  play(): Promise<void>;
  pause(): Promise<void>;
  /** SECONDS, absolute. */
  seek(positionSeconds: number): Promise<void>;
  stop(): Promise<void>;

  /** `null` deselects. An unknown id rejects rather than silently doing nothing. */
  selectAudioTrack(trackId: string | null): Promise<void>;
  selectSubtitleTrack(trackId: string | null): Promise<void>;

  /** `level` is 0–1. Muting is a separate fact, not `level === 0`. */
  setVolume(level: number, options?: { readonly muted?: boolean }): Promise<void>;

  /** Pull-side reads, for a consumer that needs a value now rather than the next event. */
  getTimeline(): PlayerTimeline;
  getTracks(): readonly PlayerTrack[];
  readAvSyncTelemetry(): AvSyncTelemetry;

  subscribe(listener: (event: PlayerAdapterEvent) => void): () => void;

  /**
   * Release the engine and every OS resource behind it. Idempotent, and it must
   * remain safe to call on an adapter that never loaded anything — a shell that
   * exits during startup is an ordinary case, and an mpv handle that outlives
   * its window is an orphaned native resource.
   */
  dispose(): Promise<void>;
}
```

### What this interface deliberately does not model

Controls visibility, hotkeys, menus, fullscreen and playback rate. `media-chrome` owns those through
`<media-controller>`, `docs/RESEARCH_PLAYBACK.md` names duplicating them as this area's
over-engineering failure mode, and `playback-machine.ts` already refuses to model them. Volume is on
the interface because it is an engine operation with two different implementations — it is not
modelled as *state* anywhere, and the machine mirrors `paused` as a fact for the same reason.

---

## 4. D4 — the two implementations, and the routing between them

### `WebPlayerAdapter` — Shaka plus `custom-media-element`, unchanged

The existing path, wrapping `PlaybackController`, `<liberty-video>` and the `ShakaEngine` port.
Unchanged on the web, **and it is also the DRM path on desktop**: a DRM-protected candidate in the
desktop build plays through WebView2's CDM via EME, in the same webview that draws the chrome.

Shaka is what it already is: DASH and HLS first-class including low-latency, a pluggable ABR manager,
EME with Widevine/PlayReady/FairPlay, and browser-limited container and codec support.

### `NativePlayerAdapter` — libmpv

A thin TypeScript client over Tauri `invoke()`/`listen()`, talking to a Rust module built on
**`libmpv2` 6.0.0** (2026-05-12, `libmpv2-sys` 4.0.1), which is the crate **Stremio pins exactly**.
It covers what Shaka structurally cannot: every FFmpeg container and codec, MKV, embedded ASS/SSA
through libass, PGS and VobSub, `hwdec=auto` with explicit per-codec control, libplacebo HDR and
tone mapping, and per-frame timing telemetry.

What it is **not** good at is the adaptive-streaming half, and routing has to know that. mpv reaches
DASH and HLS through FFmpeg's demuxers: [mpv#7033](https://github.com/mpv-player/mpv/issues/7033)
documents DASH as *"often broken"* with crashing bugs and an XML parser that is not always enabled,
and mpv has **no ABR logic at all** — `--hls-bitrate=<no|min|max|rate>` picks a fixed rendition at
load time and stays there. So a multi-variant ladder intended to adapt over a hostile network is a
web-adapter candidate even when it is unencrypted, and `adaptive_bitrate_required` exists in the
refusal vocabulary for precisely that case rather than as a placeholder.

`tauri-plugin-libmpv` 0.3.2 is a **reference implementation to vendor or fork, not a dependency**:
its npm companion was last published 2025-11-24, and its three-artifact design (plugin plus a
separate `libmpv-wrapper.dll` plus `libmpv-2.dll`) is moving parts we would rather collapse.

**JSON IPC over a named pipe is the designed-for fallback, not the plan.** The transport is
swappable behind this adapter deliberately, and IPC is orthogonal to `wid` — you can pass
`--wid=<HWND>` on the command line and still get in-window hardware-accelerated video, and every
property including `avsync` is reachable through `observe_property`, so there is no telemetry cliff.
Two things make it the fallback rather than the choice: mpv's IPC has **no authentication of any
kind** and exposes `run`, and shipping `mpv.exe` rather than `libmpv-2.dll` pushes us toward a GPL
binary — mpv's own `Copyright` file says *"it's not recommended to build mpv CLI in LGPL mode at
all"* (§9).

### mpv has no CDM, and that is a routing constraint rather than a gap

mpv has **no Content Decryption Module and cannot be given one**. Widevine and PlayReady CDMs are
proprietary licensed binaries distributed for browser and certified-device integration, not for
arbitrary desktop players ([mpv#8286](https://github.com/mpv-player/mpv/issues/8286) is the
canonical issue). Therefore:

> **The mpv adapter must REFUSE a DRM-protected candidate with a named reason
> (`drm_required_no_cdm`). It must never attempt it, never fall back and never degrade.**

The refusal is what makes **invariant 2** structural rather than promised: there is no code path in
the native adapter that could be mistaken for an attempt to play protected content without its CDM,
because the candidate never reaches `load()`. And because the refusal is a named code with a stated
reason, **invariant 4** is satisfied in the same motion — the trail says which adapter refused,
under which code, for which candidate.

The equivalent constraint in the other direction is weaker but real: Shaka has **no MKV, no libass,
no DTS or TrueHD passthrough, and coarse timing telemetry**, so a candidate whose container or codec
the browser cannot decode is refused by the web adapter under `container_unsupported` or
`video_codec_unsupported` with the same discipline. Neither adapter is a fallback for the other.
They are two capabilities and a router.

### What the playback-session boundary must surface

**This is a required contract addition, it does not exist today, and it is now
[PL-0902](#12-what-this-task-did-not-do) — which gates the capability routing specified in this
section.** `canPlay` cannot make a reasoned DRM decision from a contract that carries no DRM field,
so until PL-0902 lands, the routing described here is a specification with nothing to read.

`streamCandidateSchema` in `packages/contracts/src/domains/playback.ts` carries `rights`, `protocol`,
`height`, `bitrateKbps`, `videoCodec` and `audioCodec` — and **nothing that states whether the
stream is encrypted**. A grep for `drm` across `packages/contracts/src` returns nothing. So routing
as specified above cannot be decided from today's contract at all, and that fact is recorded here
rather than fixed here: the wire contract for a playback session is PL-0501's, the candidate
representation is PL-0201's, and this task's `allowedPaths` are two documents.

What the descriptor has to say, per candidate:

| Field | Meaning | Why routing needs it |
| --- | --- | --- |
| `drm` | `{ system, licenseUrl } \| null` | The whole DRM branch. `null` must mean *stated as clear*, not *unstated* — see below |
| `container` | the container/segment format | MKV and exotic containers are mpv-only; fMP4/TS are either |
| `protocol` | already present (`https`/`hls`/`dash`) | mpv has no ABR; a multi-variant ladder it would pin to one rendition |
| `requiresAdaptiveBitrate` | whether a fixed rendition is acceptable | mpv's `--hls-bitrate` picks once at load and stays there |
| `videoCodec` / `audioCodec` | already present, already nullable | the codec branches of both refusals |

**`null` in this descriptor must keep the meaning the codebase already gives it.**
`packages/contracts/src/domains/playback.ts` states the rule for the four media facts: `null` means
UNKNOWN and is the only thing that means unknown, required-and-nullable rather than optional,
because an omitted key cannot be distinguished from a producer that forgot. A `drm` field cannot be
required-and-nullable in that scheme *and* mean "clear" — so it needs three states, not two, and the
safe reading of *unstated* is **not** "clear". An unstated DRM status routes to the web adapter,
which has the CDM if one turns out to be needed, and the native adapter refuses it under
`drm_required_no_cdm` with a reason that says the status was unstated rather than positive. Getting
this backwards is the one way this design could produce an invariant-2 incident, and it is a
one-word mistake.

### The routing function

```text
candidate (with capability descriptor)
        │
        ├── WebPlayerAdapter.canPlay(candidate)    → CanPlayDecision (reason on both branches)
        ├── NativePlayerAdapter.canPlay(candidate) → CanPlayDecision (reason on both branches)
        │
        └── selectAdapter(...) → { chosen | null, decisions: readonly CanPlayDecision[] }
```

Properties it must have:

- **Pure, synchronous, and taken before playback.** No probing, no speculative load, no "try it and
  see". A routing decision discovered at load time is a routing decision that has already spent an
  attempt against `FailoverPolicy.maxAttempts`.
- **Every decision goes in the trail, not just the winning one.** "Native refused:
  `drm_required_no_cdm`; web accepted: `unverified`" is a debuggable line; "playing on web" is not.
- **It does not rank.** Candidate ranking stays in `@liberty/media-engine` (§7). Routing answers
  *which engine*, never *which candidate*, and it must consume the session's preference order
  without reordering it — the same rule `playback-machine.ts` already enforces by calling
  `scheduleAttempts` rather than `planFailover`.
- **A candidate no adapter accepts is a refusal with reasons, not a load.** It is handled the way
  the machine already handles a pre-attempt refusal, and the reasons are all of them.

**One consequence worth naming now, because it is PL-0501 and PL-0201 input.**
`playbackCapabilitiesSchema` describes **one** client with **one** codec list, and ranking runs
against it server-side. A desktop build has two engines with different capability sets. The
workable answer is that the client reports the **union** and per-candidate routing decides; the cost
is that ranking may prefer a candidate only one of the two adapters can play, which is acceptable
precisely because routing is per-candidate and every refusal is reasoned. The unworkable answers are
reporting only one engine's capabilities (which discards the other engine's whole point) and
re-ranking on the client (which produces a second opinion about preference that can disagree with
the one the session published — after which the reason trail explains a choice nobody made).

---

## 5. The mpv adapter's concrete mapping

All identifiers below are from `include/mpv/client.h` and `DOCS/man/input.rst` at client API 2.5
(mpv 0.41.0, released 2025-12-21), as verified in research report 01 §B3. Where an identifier was
**not** verified there it is marked, and it must be checked against the header when the adapter is
written rather than trusted from here.

### Pre-init options, set between `mpv_create()` and `mpv_initialize()`

| Option | Value | Why |
| --- | --- | --- |
| `wid` | the child HWND, as `uint32_t` | Window embedding. mpv creates its own window and reparents it under ours. **Negative values are rejected** — the docs are explicit that the handle must be cast to `uint32_t` |
| `vo` | `gpu-next,gpu` | `gpu-next` (libplacebo) is the default VO as of 0.41.0; `gpu` is the fallback |
| `gpu-context` | `d3d11` | The path Stremio ships |
| `hwdec` | `auto` | Hardware decode; verified at runtime with `hwdec-current` |
| `terminal` | `no` | No console attachment |
| `osc` | `no` | mpv's on-screen controller would draw a second UI under ours |
| `input-default-bindings` | `no` | mpv's own key handling would fight the webview's |
| `config` | **`no`** | **See below** |

**`config=no` is a correctness requirement, not a tidiness one.** With it unset, mpv reads the
user's `mpv.conf` from their own profile directory, and any option in it — `hwdec`, `vo`,
`framedrop`, `speed`, `af`, `vf`, `sub-*`, `ytdl` — changes playback behaviour underneath us on one
machine and not another. The consequences are concrete: a support engineer reading our reason trail
would be reading a session whose configuration we do not know and cannot see; a telemetry budget
built on frame-drop counts would be comparing machines with different `framedrop` settings; and a
filter chain from a config file would silently alter the picture we are claiming to have rendered.
The user's mpv configuration is theirs; this process is not their mpv.

### Commands, properties and events, mapped to the boundary

| `PlayerAdapter` concern | mpv identifier | Notes |
| --- | --- | --- |
| load | `loadfile <url> replace` | Over the in-process API. **Never a command line** — see §7 |
| play / pause | `pause` (flag property) | Mirrored, not commanded, into the machine |
| seek | `seek <seconds> absolute` (or `absolute+exact`) | Seconds, as everywhere in this codebase |
| stop | `stop` | Produces `END_FILE` with reason `_STOP` — our own control flow, not a failure |
| position | `time-pos` (double, RW) | `playback-time` and `percent-pos` also exist; `time-pos` is the one |
| duration | `duration` (double) | Absent on some live inputs — report `null`, never 0 |
| volume | `volume` (double, RW) plus `mute` (flag) | Two facts, kept separate |
| audio track | `aid` | Matches `track-list/N/id` where `type == "audio"` |
| subtitle track | `sid` | Matches `track-list/N/id` where `type == "sub"` |
| track metadata | `track-list` as `MPV_FORMAT_NODE` | Per-track `id`, `type`, `title`, `lang`, `codec`, `codec-desc`, `default`, `forced`, `hearing-impaired`, … Re-read on `MPV_EVENT_FILE_LOADED` |
| **buffering** | **`paused-for-cache`** | *"Whether playback is paused because of waiting for the cache."* **This is the buffering signal** |
| buffering progress | `cache-buffering-state` | *"The percentage (0-100) of the cache fill status until the player will unpause."* |
| buffer depth | `demuxer-cache-time`, `demuxer-cache-duration`, `demuxer-cache-state` | Depth and seekable ranges. Diagnostics, not lifecycle |
| seek in progress | `seeking` | True while seeking or restarting. Corroborating, not authoritative |
| failure | `MPV_EVENT_END_FILE` → `reason` ∈ `_EOF` / `_STOP` / `_QUIT` / `_ERROR` / `_REDIRECT`, plus `error` on `_ERROR` | **The primary playback-failure signal, and it belongs directly in the reason trail** |

**`core-idle` is not the buffering signal and must not be used as one.** Its documentation says it
is *"Whether the playback core is paused… can differ from `pause` in special situations, such as
when the player pauses itself due to low network cache"* — and it is also true while restarting and
while nothing is playing at all. It is false only when video is actually playing, so a player that
reads it as "buffering" reports a rebuffer during every startup and every seek, and the rebuffer
metric PL-0503 is built on becomes meaningless. `paused-for-cache` answers the question that was
asked.

### "Ready" is a correlation, not an event

Three events fire around a load — `MPV_EVENT_START_FILE`, `MPV_EVENT_FILE_LOADED`,
`MPV_EVENT_PLAYBACK_RESTART` — and **none of them alone means the session the caller asked for is
playing.** A rapid `loadfile` sequence (a failover, a viewer changing their mind) otherwise fires
"ready" for a file the user has already navigated away from, and the machine settles a restart that
belongs to a superseded load. Stremio's `VideoReadyState` correlates the three **against a monotonic
load id** for exactly this reason, and this adapter copies the pattern — which is why
`PlayerLoadRequest.loadId` is required rather than generated internally, and is the same problem
`#loadToken` already solves in `playback-controller.ts` for superseded Shaka loads.

`PLAYBACK_RESTART` is additionally ambiguous between "the load finished" and "the seek finished",
because mpv fires it after both. The adapter therefore needs the load id *and* a pending-seek flag
to know which of `loaded`/`playing` and `seekcompleted` it is looking at. Getting this wrong
produces a player that reports a seek completing when a load completed, which the state machine will
faithfully mirror.

### `MPV_EVENT_QUEUE_OVERFLOW` and the resync obligation

If the adapter is slow to drain the event queue, **mpv drops events**. A dropped `PROPERTY_CHANGE`
leaves a stale mirror; a dropped `END_FILE` leaves the machine believing a candidate is still
playing when it has already failed. So on overflow the adapter must **re-read every observed
property and re-emit the corresponding events** — at minimum `time-pos`, `duration`, `pause`,
`paused-for-cache`, `volume`, `mute`, `aid`, `sid` and `track-list` — and emit
`{ type: "resynchronised" }` so that a session which resyncs repeatedly is visible rather than
merely quiet. mpv is authoritative and the adapter is a mirror of it, which is the same rule the
state machine applies one layer up.

### A/V sync telemetry — conditional, and three of the four are weak

| Property | Documented meaning | Condition |
| --- | --- | --- |
| `avsync` | *"Last A/V synchronization difference."* | **Unavailable if audio or video is disabled** → `{ available: false, why: "audio_or_video_disabled" }` |
| `total-avsync-change` | *"Total A-V sync correction done."* | — |
| `frame-drop-count` | *"Frames dropped by VO (when using `--framedrop=vo`)."* | **Requires `--framedrop=vo`.** Without it the property is not a zero, it is not measuring |
| `decoder-frame-drop-count` | frames dropped by the decoder | — |
| `vo-delayed-frame-count` | *"Estimated number of frames delayed due to external circumstances in display-sync mode. Note that in general, mpv has to guess that this is happening, and the guess can be inaccurate."* | **display-sync only, and self-documented as a guess** |
| `mistimed-frame-count` | display-sync only; excludes external causes and rounding | **display-sync only** |

**Do not build budgets, SLOs or alerts on `vo-delayed-frame-count` or `mistimed-frame-count`.** They
are conditional on a mode we are not running by default and the documentation calls one of them a
guess. An adapter not in display-sync mode returns `{ available: false, why: "requires_display_sync" }`
for anything derived from them — an absent reading, not a zero.

**And none of this is a lip-sync measurement.** `docs/AV_SYNC_MEASUREMENT.md` establishes that
`com.liberty-avs-lip-sync-offset` is always `unobservable` from software and that the only source of
`audioAheadMs` is the external flash-and-blip rig. mpv's `avsync` is the player's internal
scheduling difference, not presented alignment, so it is a **new proxy with its own name** (the
obvious spelling is `com.liberty-avs-native-avsync`, under the same `com.liberty-avs-*` namespace and
the same "documented as a proxy" rule) and **naming it is PL-0504's call, not this task's.** Mapping
mpv's number onto the lip-sync metric would be precisely the "proxy wearing a measurement's clothes"
that document was written to prevent.

### Error classification will legitimately produce `null` more often here

`MPV_EVENT_END_FILE` with `_ERROR` carries an `error` field, and the mapping from mpv's error
values onto `PlaybackFailureKind` (`rights_unverifiable` / `decode_failed` / `source_unavailable` /
`network_transient`) is **coarser than Shaka's**. Shaka gives a category and a code; mpv frequently
collapses a network failure and a demuxer failure into one loading failure. The specific mpv error
constants were **not** verified by this task's research — report 01 §B3 verified that `_ERROR`
carries an `error` field and did not enumerate the `mpv_error` enum — so the mapping table must be
built against `client.h` when the adapter is written.

The design already handles the coarseness honestly, and it must be used rather than worked around:
`playback-failure.ts` rule 1 says a reporter that cannot tell which kind it saw **reports nothing**,
`playback-machine.ts` keeps `attemptsByCandidate` precisely so an unclassified attempt still costs
the budget and still marks the candidate tried, and `@liberty/media-engine` excludes such a candidate
as `attempt_failed_unclassified`. An invented `network_transient` buys retries for a failure that
will never succeed; an invented `decode_failed` permanently discards a stream that was briefly
unreachable. The native adapter will report `null` more often than the web one, and that is the
correct outcome rather than a deficiency to paper over.

---

## 6. The existing XState machine stays the single source of playback truth

**The adapter translates into the machine's existing events. It does not become a second state
machine.** `apps/web/src/components/player/playback-machine.ts` already models the session and
candidate lifecycle, owns failover through `scheduleAttempts`, and carries the reason trail invariant
4 asks for. A native adapter that kept its own lifecycle would produce two accounts of one session,
and the moment they disagreed there would be no way to say which was authoritative — which is the
defect that file's own history documents, in a different place, about a scheduling policy that lived
in two modules and diverged.

The machine's premise transfers unchanged: **it is a mirror of truth, not the source of it.** mpv is
authoritative in the native build exactly as the `<video>` element and Shaka are in the web build.

### The mapping, onto states and events that already exist

| mpv signal | Machine event | Where it lands |
| --- | --- | --- |
| adapter initialising (`mpv_create` done, `mpv_initialize` pending) | `ENGINE_STATE { status: "loading" }` | `engine` region → `.loading` |
| `mpv_initialize()` succeeded | `ENGINE_STATE { status: "ready" }` | `active.engineLoading` → `loading` via `engineEventIsReadyWithinBudget`, charging one attempt |
| `libmpv-2.dll` not loadable, or `mpv_initialize()` failed | `ENGINE_STATE { status: "unavailable", reason }` | `#fatal` via `stopWithEngineUnavailable`. **See the contract note below** |
| `MPV_EVENT_START_FILE` (matching load id) | `MEDIA_LOAD_START` | Recorded by `noteMediaSignal`, deliberately routed nowhere |
| `MPV_EVENT_FILE_LOADED` (matching load id) | `MEDIA_LOADED_METADATA { durationSeconds }`, then `MEDIA_CAN_PLAY` | `mirrorDuration`; `MEDIA_CAN_PLAY` is an inert signal |
| `MPV_EVENT_PLAYBACK_RESTART` (matching load id, no pending seek) | `MEDIA_PLAYING` | `active` → `playing`; `settleRestart` clears `awaitingFirstFrame`, which is what makes a failover resume rather than restart from zero |
| `pause` → `false` / `true` | `MEDIA_PLAY` / `MEDIA_PAUSE` | `mirrorPlayIntent` / `mirrorPauseIntent` — facts about the engine, never states |
| `time-pos` observed | `MEDIA_TIME_UPDATE { positionSeconds }` | `mirrorPosition`, and the `positionAdvanced` guard is what takes `buffering` and `recovering` back to `playing` |
| `duration` observed | `MEDIA_DURATION_CHANGE { durationSeconds }` | `mirrorDuration` |
| `paused-for-cache` → `true`, after the first frame | `MEDIA_WAITING` | `active` → `buffering`, entering `recordRebuffer` |
| `paused-for-cache` → `false` | *nothing directly* | The next advancing `MEDIA_TIME_UPDATE` leaves `buffering`. A synthetic `MEDIA_PLAYING` here would claim playback resumed before a frame proved it |
| `cache-buffering-state` | *nothing* | The machine has no percentage slot and must not grow one. It is adapter-level presentation and telemetry |
| `MPV_EVENT_SEEK` | `MEDIA_SEEKING { positionSeconds }` | `active` → `seeking` |
| `MPV_EVENT_PLAYBACK_RESTART` with a pending seek | `MEDIA_SEEKED { positionSeconds }` | `seeking` → `buffering`, then the clock advancing → `playing`. That two-step is the honest projection: a completed seek means the position moved, not that data is there |
| `END_FILE` reason `_EOF` | `MEDIA_ENDED` | `#ended`, which is deliberately not a final state |
| `END_FILE` reason `_ERROR` | `ENGINE_ERROR { error }` with `fatal: true` | `active` → `failingOver` via `recordCandidateFailure` |
| `END_FILE` reason `_STOP` or `_REDIRECT` | `ENGINE_ERROR { error }` with `aborted: true` | Taken by the `errorIsAborted` branch and dropped, exactly as Shaka's `LOAD_INTERRUPTED` is. **Our own control flow is not a candidate failure** |
| `END_FILE` reason `_QUIT`, `MPV_EVENT_SHUTDOWN` | `ENGINE_STATE { status: "destroyed" }` | `markReattaching`; the rebuild is not charged against the attempt budget |
| `MPV_EVENT_QUEUE_OVERFLOW` | re-read, then the ordinary mirror events | Plus the adapter's own `resynchronised` event. The machine has no event for it and does not need one |
| `track-list`, `aid`, `sid` | *nothing* | The machine deliberately does not model tracks; track state belongs to the adapter and the controls layer |
| `avsync` and the frame counters | *nothing* | PL-0504's diagnostics channel, as a named proxy (§5) |

### Two contract seams this mapping exposes, both now carrying task numbers

1. **`EngineUnavailableReason` has no native member — [PL-0903](#12-what-this-task-did-not-do).** It is
   `"engine_load_failed" | "host_unsupported" | "attach_failed"` in `engine.ts`, and the honest
   reading was that the union was Shaka-shaped: it needed either a native member or engine-neutral
   spelling before a native adapter could report truthfully through it.

   **Both halves are now closed, and this paragraph is kept because the reasoning still explains the
   shape.** PL-0903 moved the union to `engine.ts` and made `engine_load_failed` cover a native engine
   failing to load as well as a web one, rather than adding a libmpv-specific member. PL-0502 then
   renamed the member that was called `browser_unsupported` — a misnomer on desktop — to
   `host_unsupported`, as a complete migration with no alias. `host_unsupported` is the only spelling;
   the old name appears in this document only where it is describing this history.
2. **`PlaybackError` is engine-neutral in shape but Shaka-numbered in content —
   [PL-0904](#12-what-this-task-did-not-do).** `code`, `category`
   and `categoryName` are documented as pinned to Shaka 5.2.x, and `PlaybackErrorOrigin` is
   `"engine-load" | "configure" | "manifest-load" | "player-event" | "source-rejected"`. A native
   adapter must therefore report `code: null` and `category: null` and carry its mpv reason in
   `message` and `detail`, or the union gains a native origin and a `detail` variant for an END_FILE
   reason. Pushing an mpv error number into a Shaka-numbered field would produce a trail that reads
   as a Shaka error category and is not one.

Both are changes to files this task may not write (`reviewDependencies` are read-only here), and both
are now their own tasks rather than findings in a report — see §12. They are exactly the kind of
thing that is cheap now and expensive after two engines are reporting through one union.

---

## 7. Security and rights, as properties of this architecture

Each of these is the same invariant the project already holds, restated as something this
architecture makes structurally true rather than promised.

**Media addresses come only from authorized provider resolution and the playback-session boundary,
and the client can never submit one.** `PlayerLoadRequest` takes a `PlaybackSession` and a
`candidateId`; there is no method on `PlayerAdapter` that accepts a URL, and there is no Tauri
command that accepts one either. This preserves what `playback-source.ts` already states: a `src` a
page can set to anything turns the player into an open proxy for arbitrary media and quietly
relocates invariant 1 into whatever code sets the attribute. The transport backstop
(`checkPlaybackSource`: absolute, `https:`, loopback carve-out only) applies to the native path for
the same reason it applies to the web path — it is a backstop, not a rights check, because an
`https:` URL is not a licensed one.

**mpv is handed a URL through `loadfile` over the in-process API, never on a command line.** Windows
command lines are world-readable through WMI and Process Explorer, and our URLs are capability-bearing
— they arrive from an authorized session, frequently signed. The same rule applies to the sidecar's
bearer token: environment variable, not `argv`, for exactly this reason.

**Stream candidate ranking stays in `@liberty/media-engine`.** Nothing in the shell, the adapter or
the router ranks, re-ranks or reorders. The session publishes a preference order; the machine walks
it without re-sorting; `scheduleAttempts` schedules without reordering. Routing chooses an engine,
never a candidate.

**Provider-specific logic stays in `@liberty/provider-sdk`.** The shell adds no provider knowledge and
the adapters contain none. Note the specific hazard the desktop target introduces: `provider-sdk` is
**not** reachable from client components today and must not become so. A Tauri command or a native
adapter that reached for a provider adapter would put provider behaviour — and eventually provider
credentials — on the user's machine, which is the exposure §8's ruling exists to prevent, arriving
through a side door.

**Nothing bypasses DRM, authentication, subscriptions, geographic restrictions, paywalls or content
rights.** The DRM refusal in §4 is the sharpest instance: the native adapter has no path that could
be mistaken for an attempt on protected content. `docs/CONTENT_RIGHTS.md` applies to this target
unchanged, including the prohibition on fallback logic whose purpose is to evade provider
enforcement — and "fall back to mpv when EME fails" would be exactly that, which is why the refusal
is a refusal and not a preference.

**The loopback listener's controls, stated as requirements rather than intentions.** Bind
`127.0.0.1` explicitly and never `0.0.0.0` (Next reads `HOSTNAME`; getting it wrong exposes the port
to the LAN, and it is a one-word mistake with a large blast radius — make it a test assertion). A
**256-bit CSPRNG bearer token** generated per launch, passed to the sidecar through the environment,
injected into the webview by an initialisation script, and required on every request.
**Hostname-exact `Host` header validation**, which mechanically defeats DNS rebinding because a
rebound request arrives with `Host: evil.com`. `Origin`/`Sec-Fetch-Site` checks on
state-changing requests. A random port is **obscurity only** — a local process enumerates listeners
in milliseconds — and must not be counted as a control. Chrome 142's Local Network Access permission
gating is defence in depth we get for free and is not a substitute for `Host` validation.

**And what makes that set sufficient rather than merely acceptable is §8's ruling**: because
provider resolution is proxied and the desktop build ships no provider credential, the sidecar holds
no provider secret for these controls to be the last line in front of. They keep other local
processes out of the user's own session, which is what they are good at. They were never strong
enough to be the only thing protecting a provider relationship, and under the ruling they do not
have to be.

### What `Host` validation compares, precisely (amended in round 95, PW-0105)

This paragraph used to say "the exact expected literal", and the code implemented it literally:
`LIBERTY_SIDECAR_HOST` was compared to the whole incoming `Host` value, port included. **That rule
could not be satisfied by any shell that also honoured the port contract above.** The kernel
chooses the port after the shell has finished building the child's environment, so no value the
shell can compute before spawning contains it. In practice the shell sent `127.0.0.1`, every
request arrived as `127.0.0.1:<chosen-port>`, and the listener refused all of them.

gpt-architect's ruling resolves it by amending the contract rather than the port design:
`LIBERTY_SIDECAR_HOST` **"should represent the expected HOSTNAME / loopback identity, not a
precomputed `<host>:<unknown-port>` authority"**. So:

- `LIBERTY_SIDECAR_HOST` is a **literal loopback address** — `127.0.0.1` or `::1`. A name is
  refused at startup, because a name is exactly what a rebinding attacker supplies, and the value
  is the entire rebinding defence. This is narrower than the set of addresses the sidecar may
  *bind*, where `localhost` is still a loopback bind.
- The incoming `Host` is **parsed**, not pattern-matched, and every ambiguous shape is refused
  rather than normalised: userinfo, URL delimiters, whitespace, control characters, an unbracketed
  authority with more than one colon, a non-decimal or out-of-range or zero-padded port, a trailing
  dot, a zone-scoped IP-literal. See `parseHostHeader` in `apps/web/src/lib/sidecar/policy.ts`.
- The parsed hostname must **equal** the configured literal. Not a suffix match, not
  `includes("127.0.0.1")` — `127.0.0.1.evil.test` contains it and is refused.
- The parsed port must equal **the port the process is really listening on**, obtained from the
  live server at startup. When that cannot be established the hostname match plus the per-launch
  token is the enforced minimum, and the guard does not fall open.

**Known open defect, not fixed by PW-0105 and not to be assumed fixed:** Next's generated
standalone entry reads the port as `parseInt(process.env.PORT, 10) || 3000`, so `PORT=0` is falsy
after parsing and the server binds **3000** with `allowRetry: false` rather than letting the kernel
choose. The handshake still reports the truth, because it reads the listener rather than the
environment — but the kernel-chosen-port half of the contract above is currently not in effect, and
a machine already using 3000 will fail to launch. Tracked separately; see `control/tasks.json`.

---

## 8. Where provider resolution runs in the desktop build — ruled

**This section used to publish an open question.** It was published as open through round 42 and
**closed by the commander on 2026-09-16**, and it is recorded here as a ruling rather than as a
recommendation that happened to win. A reader who needs to tell the two apart can: the reasoning
below is the ruling's, the alternatives are kept because the decision is only legible next to what
was rejected, and nothing in this section is any longer awaiting anyone.

### The ruling

> **Provider resolution and any credential-bearing provider calls must not rely on the
> user-administered local sidecar as the trust boundary. The desktop build proxies those specific
> routes to an authenticated backend service while preserving the same application-facing route
> contract.**

### What it applies to, and how the split is made

The affected surface is the **provider-resolution and playback-session routes — `/api/v1/playback/*`**,
including `/api/v1/playback/session`. Everything else the application serves continues to run in the
sidecar exactly as §2 describes; this is a rule about a handful of routes, not about the sidecar.

**The split is by build target, not by runtime configuration.** There is no environment variable, no
config key and no feature flag that can put resolution back on-device in a shipped desktop build.
That is not fastidiousness about configuration hygiene: **a runtime flag that can flip resolution
back on-device is the same exposure with an extra step**, because the flag lives on the machine the
user administers, next to the code it would re-enable. A build that contains the on-device resolver
at all is a build from which the on-device resolver can be reached. The desktop target therefore does
not compile it in, and that is the property to test for — an assertion that the desktop bundle
contains no provider-resolution implementation is worth more than any amount of configuration
discipline.

### The contract is preserved exactly

Same route path. Same URL. Same request shape, same response shape, same status codes, same error
bodies, same reason-trail semantics — the behaviour `docs/API_CONTRACTS.md` specifies, unchanged, and
invariant 5 applies to this target like any other. **The desktop implementation differs behind the
boundary and nowhere in front of it**, so nothing in `apps/web` client code can tell which build it
is running in, and no client code may branch on it. A component that needed to know would be evidence
that the contract had not in fact been preserved.

### What the proxy carries, and what it must never carry

- It **forwards an authenticated caller identity** to the backend — the session or profile identity
  the request already carries — and the backend performs resolution, rights evaluation, ranking and
  URL signing.
- It **never receives a provider credential**, and the desktop build never ships one. No provider
  API key, no provider OAuth client secret, no signing key reaches the user's machine in any form,
  including in a build artifact, an environment variable, a config file or a cached response.
- **The sidecar therefore holds no provider secret at all.** That is the property that makes §7's
  loopback analysis *sufficient* rather than merely *acceptable*: an attacker who reads the sidecar's
  process environment, attaches a debugger to it, or replaces `server.js` outright obtains an
  authenticated path to the same backend the legitimate user already has, and nothing else. There is
  no credential in that process worth extracting, and no resolution logic in it worth patching out,
  because neither is there. The bearer token, the `Host` validation and the loopback bind in §7 are
  still required — they keep other local processes out of the user's own session — but they are no
  longer the only thing standing between a local attacker and a provider relationship.

### Why: the invariants stay enforceable on a machine the user administers

**Invariant 1** (only licensed, user-owned or public-domain content may enter playback resolution)
and **invariant 2** (no bypass of DRM, paywalls, authentication, geographic restrictions or content
rights) are enforced by the resolution boundary. Code that runs on a machine its user administers is
code that user can read, patch and replace. Under this ruling the enforcement executes on
infrastructure we operate, and what runs on the desktop is a forwarder that cannot decide anything an
attacker would want decided differently. The invariants are therefore **enforceable** there rather
than merely asserted there, which is the same standard `docs/CONTENT_RIGHTS.md` already sets for
provider adapters: authorization is established, not assumed.

### The alternatives, and why each was not taken

They stay in the document because the ruling's reasoning is unreadable without them.

| | What it is | Disposition |
| --- | --- | --- |
| **(a)** static export, every `/api/v1` route moved to the backend | Cleanest engineering; smallest bundle; instant cold start; no sidecar | **Not needed.** Moving the whole API layer off Next is the rewrite the preservation constraint forbids, and the ruling obtains the same trust-boundary benefit without it — by relocating the implementation of a handful of routes rather than the architecture of all of them |
| **(b)** sidecar, app fully intact including on-device resolution | Maximum literal compliance; zero changes; fastest to stand up | **Refused.** The boundary enforcing invariants 1 and 2 would execute from files the user can read and replace, with provider credentials in its environment. That is a rights and credential exposure **discovered during a provider audit, not during testing** — it passes every functional check right up until it ends a provider relationship |
| **(c)** sidecar, resolution routes proxied to an authenticated backend | Same route, same URL, same contract; implementation selected by build target | **Ruled.** This is the decision above |

Note that (b)'s refusal rests on a **stronger** objection than the open-TCP-port argument the first
research report led with, and unlike that one it survives scrutiny. §0 carries the retraction of the
port argument; this is what replaced it.

### The cost, accepted rather than argued away

The ruling is (c), and (c) is (b) plus a constraint, so it inherits every one of (b)'s costs: the
Node runtime in the bundle, the thin precedent, the unmeasured cold start, the CSP regression and the
supervision code (§2). It adds two of its own. **A network round trip enters the resolution path**
that an on-device resolver would not have had, so desktop session latency is bounded below by the
backend's, and an offline or degraded-network desktop cannot resolve at all — the failure has to be
surfaced as an honest unavailable outcome rather than as an empty candidate list. And **the desktop
build now has a route implementation that the web build does not exercise**, which is a second code
path needing its own tests; the mitigation is that it is a forwarder with no policy in it, and that
the contract it must satisfy is already written down.

### PL-0501: settled, not merely informed

This was a design input to PL-0501 while it was open. It is now **settled**, and PL-0501 builds
`/api/v1/playback/session` with a **target-selected implementation from the start**: one
implementation that resolves, one that forwards, chosen by build target, behind one contract. That is
ordinary adapter work of exactly the kind `PlayerAdapter` itself is, and it is cheaper as a first
design than as a later seam — which was the argument for closing the question before PL-0501 began
rather than after.

---

## 9. Licensing

> **Nothing in this section is legal advice.** It is a precise statement of the technical facts
> counsel will need. **Counsel review is a precondition of shipping**, named as such rather than
> assumed, and it is not a precondition of prototyping. The work should start now because it is the
> longest pole and the one most likely to surprise us late.

### The two sentences that decide it

From mpv's `Copyright` file, verbatim:

> mpv as a whole is licensed under the GNU General Public License GPL version 2 or later … **by
> default**. The mpv program is licensed the GNU Lesser General Public License LGPL version 2 or
> later (LGPLv2.1+ …) **if built without using any GPL only files**. The `-Dgpl=false` configure
> switch is provided as a convenience for excluding the GPL only files…

And immediately after it:

> …do note that the build system is provided "as is" and **using the `-Dgpl=false` configure switch
> does not in itself create a LGPLv2.1+ license grant.**

So `-Dgpl=false` excludes the GPL-only files. **It does not grant a licence**, and it says nothing
about what mpv is linked against.

### What LGPL mode costs us on Windows: nothing we need

The GPL-only files it disables are `vo_x11.c`, `vo_xv.c`, `vo_vdpau.c`, `vo_vaapi.c`,
`vo_direct3d.c`, `stream/dvb*`, `stream_dvdnav.c`, `ao_jack.c`, `ao_oss.c`, and `DOCS/man/`
(GPLv2+) — Linux X11, BSD OSS, NVIDIA vdpau, and minor features including jack, DVD, CDDA, DVB and
the **legacy** direct3d VO. `vo_direct3d.c` is the D3D9 VO; it is **not** `gpu`/`gpu-next` on
`gpu-context=d3d11`, which is what §1 and §5 actually use. Every disabled feature is Linux, BSD or
legacy. The `Copyright` file says outright: *"The intended use for LGPL mode is with libmpv."* That
is precisely our use.

### The two traps

1. **libmpv is only half the licence.** *"Linked libraries still can affect the final license (for
   example if FFmpeg was built as GPL)."* FFmpeg built with `--enable-gpl` pulls in GPL components
   (x264, x265, postproc); `--enable-nonfree` makes the result **undistributable**. **A stock
   prebuilt libmpv is a GPL build.**
   [shinchiro/mpv-winbuild-cmake#12](https://github.com/shinchiro/mpv-winbuild-cmake/issues/12) asks
   for exactly this and closed with no maintainer commitment. Assume the SourceForge `mpv-dev-*.7z`
   artifacts are GPL and must not ship in a closed-source product.
2. **The one LGPL variant on offer carries LGPLv3 and a disclaimer.** From
   [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild)'s README:
   *"`mpv-dev-lgpl-xxxx.7z` is libmpv under LGPLv2.1+ license, which disables LGPLv2.1+ incompatible
   packages and **statically links to ffmpeg under LGPLv3**. … **I'm not a lawyer and can't
   guarantee that I've disabled all LGPL-incompatible packages, use at your own risk.**"
   So it is LGPLv3-encumbered through a **statically linked** FFmpeg, and it arrives with its
   builder's own no-warranty disclaimer. That is not a foundation for a shipping product's
   compliance story.

There is an operational reason on top of the legal one: **zhongfly retains builds for 30 days.** A
release URL is not a durable dependency.

### What shipping an LGPL libmpv in a closed-source Windows app requires, in outline

- **Dynamic linking.** Ship `libmpv-2.dll` as a separate DLL the user can replace with a modified or
  newer build. Do not statically link libmpv into our executable. Runtime `libloading`-style loading
  satisfies this naturally, and so does ordinary import-library linking.
- **Relinking and replaceability.** LGPLv2.1 §6 and **LGPLv3 §4** require that a user can substitute
  a modified library and still run the application. A drop-in DLL in the install directory is the
  standard way this is met. LGPLv3 raises the bar — it incorporates GPLv3's Installation Information
  concept — which is the main reason the FFmpeg-LGPLv3 detail matters.
- **Source availability.** Complete corresponding source for libmpv, FFmpeg and every LGPL dependency
  actually linked, at the exact revisions shipped, plus the build scripts. A written offer valid
  three years, or accompanying source.
- **Licence texts and notices.** LGPLv2.1, LGPLv3 and the licence of every bundled dependency, plus
  attribution, surfaced in an in-app "Third-party licences" view.
- **Reverse-engineering permission.** The LGPL requires permitting modification and reverse
  engineering **for debugging such modifications**. **Our EULA must not forbid it.** This is an easy
  clause to get wrong by inheriting boilerplate, it conflicts with the licence when wrong, and it is
  worth flagging to counsel specifically rather than leaving in a list.
- **No anti-tivoization violation** on the LGPLv3 path: do not signature-check the DLL in a way that
  prevents substitution. Note this interacts directly with any future tamper-resistance work, and
  the interaction should be raised before that work is designed rather than after.

### The recommendation

**Build libmpv ourselves, in CI, with `-Dgpl=false` and an explicitly LGPL FFmpeg** (no
`--enable-gpl`, no `--enable-nonfree`), forking shinchiro's CMake toolchain, producing **an auditable
SBOM of every linked library and its licence**, and vendoring the exact `libmpv-2.dll` we ship into
our own artifact store with its sha256 and provenance recorded.

This is perhaps a week of build engineering and it converts an **open-ended exposure** — a
third-party binary whose licence posture rests on its builder's disclaimer — into a **reviewable
artifact** that counsel can actually review. It also solves the 30-day retention problem.

**It gates shipping, not prototyping.** Experiment 1a should run against whatever `libmpv-2.dll` is
convenient, because compositing is a graphics question and not a licensing one. But the build track
runs in parallel from now (§10), because if counsel rejects LGPL libmpv distribution the answer is
not a patch — it is that mpv is out entirely and the fallbacks are Media Foundation (native, no
licence issue, far weaker format support) or a commercially licensed SDK.

Note also, for the same reason, `docs/RESEARCH_PLAYBACK.md`'s finding 2 is a warning about the same
class of mistake in a different place: **every prebuilt `ffprobe` on npm is a GPL-3.0 binary and
several declare otherwise in their package metadata**, so an SBOM scanner reading a top-level
`license` field reports the wrong thing. The SBOM this build pipeline produces has to be built from
what was actually linked, not from what a manifest claims.

---

## 10. The first experiments, as pass/fail

### Experiment 1a — the compositing proof. Nothing else.

Throwaway Tauri 2.11.5 app. Target under 300 lines of Rust, 2–4 days. **No Next.js, no adapter, no
product code, no DRM routing, no packaging, no LGPL build.**

1. Bare Tauri window; a static HTML page with a semi-transparent gradient panel, a large HTML button
   and a CSS-animated spinner.
2. Verify the webview reaches `SetDefaultBackgroundColor(0,0,0,0)` — through Tauri's
   `transparent: true`, and if the top-level-window translucency that brings is wrong, by calling
   `ICoreWebView2Controller2` directly through the underlying controller.
3. Create a sibling child HWND under the top-level window, below the webview in z-order.
4. `libmpv2` 6.0.0: `mpv_create` → `wid`, `vo=gpu-next,gpu`, `gpu-context=d3d11`, `hwdec=auto`,
   `terminal=no`, `osc=no`, `input-default-bindings=no`, `config=no` → `mpv_initialize` →
   `loadfile` a **local 4K60 HEVC or AV1 file** (local, so no network variable and no rights
   question).
5. Observe `time-pos`, `pause`, `paused-for-cache`, `cache-buffering-state`, `avsync` and
   `track-list`; forward to JS; render them live in the overlay.
6. Wire the HTML button to a command that toggles `pause`.

**Pass criteria — all must hold. RESULT RECORDED 2026-10-10: Experiment 1a is NOT PASS.**

| | criterion | result | on what evidence |
| --- | --- | --- | --- |
| 1 | Video plays **hardware-decoded** — Task Manager GPU "Video Decode" above zero **and** `hwdec-current` ≠ `"no"` | **PASS** | `hwdec-current` = `d3d11va`; D3D11 up on an RTX 3050; `gpu-next` at 1280x720; mpv reported the first frame shown |
| 2 | HTML UI is **visibly composited over** the video with real alpha — the gradient tints the video rather than hiding it | **FAIL** | the commander saw the WebView UI and **no video at all**, with `put_DefaultBackgroundColor(0,0,0,0)` accepted and reported successful |
| 3 | The HTML button **receives clicks** and pauses playback — hit-testing is not eaten by the child HWND | **PASS** | the Pause button reached mpv and toggled `pause` |
| 4 | **Resize and drag keep video and UI locked together** | **UNOBSERVED** | behind criterion 2 — there was nothing visible to keep locked |
| 5 | **Per-monitor DPI change** breaks neither layout nor video geometry | **UNOBSERVED** | behind criterion 2 |
| 6 | `avsync` and `time-pos` stream to the JS layer at a usable rate | **UNOBSERVED** | the overlay rendered the property table, but a telemetry rate was never measured against visible playback |
| 7 | All of the above on the matrix below | **UNMET** | one machine, one GPU, one DPI setting. See below |

**The matrix is unmet and nothing above may be read as covering it.** The run was a single Windows
machine with a single NVIDIA dGPU at a single scaling. Windows 10 22H2, an Intel or AMD iGPU, a
hybrid-graphics laptop and a drag between differently-scaled monitors were all untested. Criterion 1
passing on one NVIDIA dGPU is one cell of that table, not the row.

**The scope of the failure, stated precisely.** Criterion 2 failed for *the arrangement this harness
built* — a sibling child HWND at `HWND_BOTTOM` beneath a **windowed** WebView2 controller. It is not
a finding that WebView2 cannot composite, nor that Tauri is the wrong shell, nor that
DirectComposition will work. §1's "What happened when we built it" carries the full evidence and the
unexplained divergence from Stremio's shipping result.

**The replacement is Experiment 1c (PL-0752)**, specified in that task rather than here: one host
window, one DirectComposition device and target, one visual tree with mpv's **composition**
swapchain below and WebView2's composition visual above, so that neither layer owns a window and
neither can occlude the other by window z-order. Decision D1 itself has been referred back to
gpt-architect (PL-0751) and is **not** changed by this recording.

### Experiment 1c — RESULT RECORDED 2026-10-10: three criteria observed, five not

Observed by the commander on his own Windows machine against `b407c78`. Recorded at the width of
what he reported and no wider.

| # | criterion | result | on what evidence |
| --- | --- | --- | --- |
| 1 | Video visibly playing underneath the HTML overlay | **PASS** | commander: native video visible and playing, DirectComposition rendering it beneath WebView2 |
| 2 | Real transparency — the gradient tints the video | **PASS** | commander: the transparent magenta-to-cyan overlay works and the controls render above the video |
| 3 | Clickable HTML controls that pause and resume | **PASS** | commander: the Pause/Resume button pauses and resumes playback |
| 4 | Active GPU hardware decoding | **carried, not re-observed** | `hwdec-current` = `d3d11va` on the RTX 3050, from the EARLIER diagnostic log of a previous run of the same binary family. Not reported for this run |
| 5 | Correct resizing and window movement | **UNOBSERVED** | not reported |
| 6 | Correct DPI behaviour | **UNOBSERVED** | not reported |
| 7 | Live telemetry including `time-pos` and `avsync` | **UNOBSERVED** | the panel renders the property table, but no rate was reported |
| 8 | No orphaned processes, acceptable shutdown | **UNOBSERVED** | not reported |

**So Experiment 1c is NOT PASS**, and the distance is not a formality: five of eight criteria have
no observation behind them, and the matrix below is still one machine, one NVIDIA dGPU, one scaling.
What *is* settled — and it is the thing D1 rested on and had never had — is that **the compositing
arrangement works at all**: a libmpv composition swapchain and a composition-hosted WebView2 share
one visual tree, composite with real alpha, and take input.

**It is also not yet reachable from the product.** §1's *"The integration blocker"* has the
versions and the three routes; the short form is that no released or upstream wry can create a
composition controller, so `apps/desktop` still carries the arrangement that failed. Choosing a
route is D1's and D1 is with gpt-architect.

**The matrix, and it is the part most likely to be skipped:**

| Axis | Values | Why |
| --- | --- | --- |
| OS | Windows 10 22H2, Windows 11 24H2+ | WebView2 behaviour and DWM differ |
| GPU | Intel/AMD iGPU, NVIDIA dGPU, **and a hybrid-graphics laptop running both** | Hybrid graphics is the classic failure case for child-HWND composition and it is the configuration most of our users have |
| DPI | 100%, 150%, **and a drag between two monitors at different scalings** | Per-monitor DPI transitions are where geometry breaks |

**If 1a fails**, we have spent under a week, and the pivot is wry/tao or `webview2` plus
`native-windows-gui` directly, Stremio-style — still Rust, still not Electron, because the Electron
path fails for reasons 1a would not even get to test.

> **1a did fail, and this paragraph is now live rather than hypothetical.** Two things about it have
> to be said carefully. First, the pivot it names is *not* the only option on the table: Experiment
> 1c tests whether the compositing approach can be fixed without changing the shell library at all,
> and it is cheaper than a pivot, so it goes first. Second, the result does **not** establish the
> condition the reversal table in §11 attaches to this pivot — "Tauri's window lifecycle cannot host
> a sibling child HWND beneath the webview" — because nothing in the three runs isolated Tauri's
> window lifecycle as the cause. A child HWND *was* created, *was* sized correctly and *did* receive
> mpv's frames; what did not happen is that anyone saw them. Choosing between 1c and the pivot is
> gpt-architect's call under PL-0751, not this document's.

### Experiment 1b — the sidecar. After 1a passes, not before. ~2 days.

> **Still not started, and the precondition has not moved.** 1a did not pass. 1b's step 6 —
> "confirm transparency and mpv `wid` still composite with the http-origin page loaded" — is written
> against an arrangement that does not composite even without the sidecar, so running 1b now would
> test nothing. If Experiment 1c succeeds, 1b's step 6 has to be rewritten against the composition
> arrangement before 1b is worth starting; its other six steps are unaffected by any of this and
> remain valid as written.

1. `output: 'standalone'` build of the existing app; `node.exe` plus the tree as Tauri resources.
2. `portpicker` → spawn → **sidecar reports its actually-bound port on stdout** → mutate
   `frontendDist` → build the window with `.transparent(true)` and `WebviewUrl::External`.
3. Confirm `invoke()` reaches a Tauri command from the http origin **without** an
   `add_capability(...).remote(...)` grant — i.e. that the `frontendDist` mutation makes
   `is_local_url()` true.
4. **Measure cold start**: process spawn to first paint.
5. Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
6. Confirm transparency and mpv `wid` still composite with the http-origin page loaded — the one
   place 1a and 1b can interact.
7. Confirm the Next server emits our CSP header and refuses a wrong `Host` or a missing bearer token.

**Pass criteria:**

- [ ] The app loads the real Next application from the sidecar and renders
- [ ] `invoke()` works **without** a remote capability grant — or, if it does not, the `.remote()`
      fallback is used **and the widened IPC surface is recorded in the ADR**
- [ ] Cold start measured and written down. **This number decides whether a splash window is optional
      or mandatory** — it is not a pass/fail threshold, it is a measurement that must exist
- [ ] **`TerminateProcess` on the shell leaves no orphan `node.exe`.** Test the force-kill path, not
      the graceful one; graceful always works
- [ ] Compositing still passes 1a's criteria with the http-origin page loaded
- [ ] A request with a wrong `Host` is refused; a request with no bearer token is refused; the
      listener is bound to `127.0.0.1` and **is not reachable from another machine on the LAN**
- [ ] The page's CSP comes from the Next server and is the one we intended

### The parallel track — start now, independent of both

**The LGPL libmpv CI build (§9).** It gates shipping rather than prototyping, it is the longest pole,
and it is the item most likely to surprise us late. A clean `-Dgpl=false` plus LGPL-FFmpeg
`libmpv-2.dll` out of our own CI, with an SBOM, is the second-highest-value thing after the
compositing proof. Counsel review is queued behind the SBOM, not behind the prototype.

---

## 11. Verification status

The reviewer's standing complaint on this project is documents that claim more than their evidence.
Both research reports carry this section; it is carried forward here rather than dropped.

### The largest claim in this document was tested on 2026-10-10 and FAILED

The entry below under *"Not verified, and flagged where it is used"* called the Tauri-hosted child
HWND beneath the webview **"the single largest unverified claim in this document."** It has now been
tested on real hardware, three times, and the arrangement did not composite visibly. **Experiment 1a
is NOT PASS.** §1's *"What happened when we built it"* carries the evidence per criterion; §10
carries the result against the pass criteria; the entry below records what is and is not now settled.

Two things follow for this section specifically. **§1's core argument is no longer fully supported by
its own evidence** — the Stremio citation stands, our reproduction of it does not, and the divergence
is unexplained. And **decision D1 has been referred back to gpt-architect** (PL-0751) rather than
changed here, because recording that an experiment failed and choosing a new architecture are two
different acts and product invariant 6 puts the second with the reviewer.

### Verified on real hardware 2026-10-06 to 2026-10-10 (commander's machine, Windows, RTX 3050)

That mpv 6.0.0 via `libmpv2`, configured with `wid`, `vo=gpu-next,gpu`, `gpu-context=d3d11`,
`hwdec=auto`, opens a local HEVC file, initialises D3D11 on an NVIDIA RTX 3050, reports
`hwdec-current` = `d3d11va`, brings up `gpu-next` at the child window's real size, and reports the
first video frame shown. That an HTML button in a Tauri webview reaches a Rust command and toggles
mpv's `pause`. That `ICoreWebView2Controller2::put_DefaultBackgroundColor(0,0,0,0)`, reached through
Tauri's `with_webview` and a cast of the controller it returns, is accepted and returns success.
**And that none of that is sufficient to make the video visible beneath a windowed WebView2
controller.**

### Verified on real hardware 2026-10-10 (commander's machine, Windows, RTX 3050) — EXPERIMENT 1c

That a libmpv **composition** swapchain and a **composition-hosted** WebView2 composite in one
`IDCompositionTarget`'s visual tree with real per-pixel alpha, that the HTML renders above the video
and the gradient composites over it, and that an HTML button in that overlay pauses and resumes
mpv. Three of §10's eight criteria, on one machine. **Five are unobserved** and the matrix is
unmet; the §10 table records which is which.

### Verified against the product's own manifests on 2026-10-10 — THE INTEGRATION BLOCKER

That `apps/desktop/src-tauri/Cargo.toml` pins `tauri = "=2.12.0"`; that
`apps/desktop/src-tauri/Cargo.lock` resolves `wry 0.57.0`; and that wry's `dev`-branch `src/lib.rs`
contains **no** occurrence of `composition`, `with_composition_visual_target` or
`register_composition_visual_target` — so `tauri-apps/wry#1762` is unmerged, and the PR itself
forks wry **0.55.1**. Therefore no released or upstream wry can create a composition controller.

### Also verified against this repository on 2026-10-10 — A SEPARATE, EARLIER BLOCKER

**The desktop shell cannot load its own user interface.** This is not about the player and it is
upstream of it:

- `apps/web/src/proxy.ts:74-93` calls `authorizeRequest(...)` and returns **403 with no body** when
  it refuses.
- `apps/web/src/lib/sidecar/policy.ts:361-362` refuses when `presentedToken === null`, and
  `isSidecarMode` (`policy.ts:109-111`) is true exactly when the shell supplied a token — which it
  always does.
- `apps/web/src/proxy.ts:136-138`'s matcher excludes only `_next/static` and `favicon.ico`, so the
  **document request is matched**.
- `apps/desktop/src-tauri/src/windows_host.rs:332` loads the page with `window.navigate(url)`, a
  plain top-level navigation that carries **no custom headers**.

So the first page load presents no token and is refused. Nothing in the repository sets
`x-liberty-sidecar-token` on a webview request — the only non-test producer is
`apps/desktop/sidecar-bootstrap/acceptance.mjs:169`, which is a manual harness. This was never
caught because installed-application qualification on real hardware (PW-0504) is BLOCKED and the
shell has never been run end-to-end against a live sidecar. PL-0753 fixes it.

### Verified against primary sources on 2026-10-10

That `--d3d11-output-mode=composition`, `--d3d11-composition-size=<WxH>` and the `display-swapchain`
property all exist at the exact mpv commit this project pins, `c152964208`, by reading
`video/out/d3d11/context.c` (the `d3d11-output-mode` option and
`.window = ctx->opts.composition ? NULL : vo_w32_hwnd(ctx->vo)`), `options/options.c`
(`d3d11-composition-size`) and `player/command.c` (`{"display-swapchain", …}` returning the pointer
as an `int64`) **at that ref**, not at master. That
`ICoreWebView2Environment3::CreateCoreWebView2CompositionController` and
`ICoreWebView2CompositionController`'s `SetRootVisualTarget`, `SendMouseInput`, `SendPointerInput`
and `add_CursorChanged` exist in the locked `webview2-com-sys` 0.39.1 bindings, and that
`webview2-com` 0.39.1 ships the matching completion-handler and `CursorChanged` closure wrappers.
That `DCompositionCreateDevice`, `IDCompositionDevice::CreateTargetForHwnd`/`CreateVisual`/`Commit`,
`IDCompositionTarget::SetRoot` and `IDCompositionVisual::SetContent`/`AddVisual` exist in the locked
`windows` 0.62.2 behind `Win32_Graphics_DirectComposition`. That `tauri-apps/wry#1762` adds
composition hosting *inside* wry by creating the controller through
`CreateCoreWebView2CompositionController`, that it is a fork of wry 0.55.1, and that it describes
itself as unverified by CI with best-effort touch/pen and untested OLE drag-drop.

### Verified against primary sources on 2026-09-15

All npm and crates version numbers and publish dates; Electron's release schedule and EOL table;
Tauri's 3.0 milestone state; Next.js 16 static-export and self-hosting supported/unsupported lists;
mpv `client.h` API version and event enums; `render.h`'s backend list; the `--wid` and
`--input-ipc-server` option text; every property semantic quoted in §5, from `DOCS/man/input.rst`;
mpv's `Copyright` GPL/LGPL text and GPL-only file list; zhongfly's README LGPL note; WebView2's
`put_DefaultBackgroundColor` alpha restriction; wry's `SetDefaultBackgroundColor` call site;
Stremio's `stremio-shell-ng` `Cargo.toml`, `stremio_player/player.rs` and
`stremio_wevbiew/wevbiew.rs`; `tauri-plugin-libmpv`'s `Cargo.toml` and `src/desktop.rs`;
`Manager::add_capability` and the `dynamic-acl` default feature; `Webview::is_local_url`;
GHSA-7gmj-67g7-phm9's affected range; Tauri's CSP injection call site.

Verified against this repository on 2026-09-15: the audit for an existing shell (a repository-wide
search for `electron`, `tauri`, `mpv`, `libmpv`, `webview2`, `neutralino`, `nw.js` across every
`.ts`, `.tsx`, `.json`, `.md`, `.mjs` and `.yml` outside `node_modules` returned **nothing**, so
neither shell was favoured by inertia); `shaka-player ~5.2.6`, `xstate ^5.32.5` and
`custom-media-element` in `apps/web`; the machine's state and event vocabulary in §6; the absence of
any DRM field in `packages/contracts/src/domains/playback.ts`; `EngineUnavailableReason` and
`PlaybackErrorOrigin` as quoted in §6.

### Not verified, and flagged where it is used

- ~~**Whether Tauri's window lifecycle** — as opposed to raw wry or a direct `webview2` host —
  cleanly permits a sibling child HWND beneath the webview.~~ **TESTED 2026-10-10: the arrangement
  does not composite visibly.** But read the result at its real width, because the distinction
  matters for what happens next. What was settled: a child HWND created under a Tauri window, sized
  correctly, at `HWND_BOTTOM`, receiving hardware-decoded mpv frames, beneath a **windowed** WebView2
  controller whose `DefaultBackgroundColor` was successfully set to `A=0`, **is not visible**. What
  was **not** settled: *why*. Nothing in the three runs isolated Tauri's window lifecycle as the
  cause — the child HWND was created and did everything asked of it. `tauri-plugin-libmpv` still
  claims Windows is "fully tested" and that claim is now in tension with this result; **Stremio
  deliberately does not use Tauri** and Stremio's arrangement demonstrably works. That divergence is
  the live unknown and it is now the single largest unexplained fact in this document.
- **Whether the `frontendDist` mutation makes `is_local_url()` true in practice.** It is public API
  that mechanically produces the right result, not a documented pattern. Experiment 1b step 3.
- **Tauri plus Next.js 16 App Router in practice.** The official guide is still Next 14-era.
- **Next standalone cold start on a desktop-class machine.** No credible published benchmark was
  found and none is invented. Experiment 1b step 4.
- **The exact uncompressed footprint of `node.exe` on Windows** (~90–120 MB estimated from the 35 MB
  compressed archive) and of an LGPL libmpv build (25–35 MB estimated from `.7z` archive sizes).
- **Whether `http://127.0.0.1` is treated as a secure context by WebView2 specifically.** The
  Fetch/W3C secure-contexts rules say yes for loopback generally; not independently confirmed for
  WebView2. A two-minute check in the spike.
- **Whether a `mpv-dev-lgpl-*` asset is present in zhongfly's current release.** The README documents
  it; the assets list lazy-loads and could not be enumerated. Moot if §9's recommendation is taken.
- **The `mpv_error` enum values** behind `END_FILE`'s `error` field, and therefore the mapping from
  them onto `PlaybackFailureKind`. Report 01 verified that the field exists and did not enumerate
  the enum. Must be built against `client.h` when the adapter is written.
- **Whether mpv's libcurl network backend with HTTP/2 and HTTP/3 support is in released 0.41.0 or
  only on master.** The option docs read were from master. It matters only to how well the native
  adapter handles HLS, which is a secondary use for it.

### The specific facts that would reverse each decision

| If this turns out to be true | Then | Which decision |
| --- | --- | --- |
| ~~Experiment 1a shows **Tauri's window lifecycle cannot host a sibling child HWND beneath the webview**~~ **1a FAILED 2026-10-10, but on the compositing approach rather than demonstrably on the window lifecycle — so this row's condition is NOT established** | The named pivot stays on the table and is **not** triggered yet. Experiment 1c (PL-0752) tests whether the compositing approach can be fixed with the shell library unchanged, and is cheaper, so it goes first | D1 — **referred back to gpt-architect** under PL-0751, not changed |
| ~~**Experiment 1c shows mpv's composition swapchain and WebView2's composition visual DO composite in one DComp tree**~~ **OBSERVED 2026-10-10 on one machine: they do** | D1's compositing approach survives and §1's diagram is replaced: no child HWND, no `wid`, one visual tree. **The shell-library question is now the live one** and it has a measured answer: no released or upstream wry can create a composition controller | D1 — **the compositing approach is answered; the shell library is not** |
| **A patched wry is vendored under `[patch.crates-io]`** | `apps/desktop` keeps Tauri and gains composition hosting. We own a fork of a core dependency and rebase it on every wry release. #1762's `register_composition_visual_target` is designed so `tauri-runtime-wry` needs no changes, so the patch is narrow | D1 (shell library — a supply-chain commitment, not a code change) |
| **Experiment 1c's host grows into the shell instead** | Tauri goes: its IPC, capability ACL, bundler, updater and config all have to be replaced. The 3,319 tested lines under `apps/desktop/src-tauri/src/` are written against the `ShellHost` trait rather than against Tauri and survive; the window, event loop and IPC do not | D1 (shell library), and D2's `frontendDist` plan is reopened with it |
| **Experiment 1c also fails** | Two layers in one DWM surface has then failed twice by two different mechanisms, and the pivot named above becomes the live option rather than a contingency. At that point the honest reading is that the remaining paths are raw wry/tao with the wry#1762 approach vendored and maintained, or a direct `webview2` + `native-windows-gui` host, Stremio-style | D1 |
| **A maintained Electron↔libmpv compositing solution ships** — a supported API to place a native surface beneath web content, or demonstrated DirectComposition interop with Chromium's visual tree | Electron becomes viable, the Next-preservation argument dominates, and Electron probably wins | D1 |
| **DRM turns out to be required for the majority of the first-party catalogue**, not a minority | mpv is disqualified as the *primary* adapter. Shaka/EME becomes the default path, native playback becomes secondary for owned and local media — which weakens the whole reason to leave the browser engine | D4 |
| **Counsel rejects LGPL libmpv distribution**, or the statically-linked LGPLv3 FFmpeg proves unacceptable | mpv is out entirely. Reconsider **Media Foundation** (native, no licence issue, far weaker format support) or a commercially licensed SDK. **This is why §9 starts now** | D4, D5 |
| **Measured cold start for the sidecar is bad enough to be a user-visible regression** and no splash mitigates it | Reopen (a) — static export with the API on the backend — on performance grounds rather than on architecture grounds | D2 |
| **`frontendDist` mutation does not produce a local origin** and `.remote()` is required | D2 stands, but the widened IPC surface is recorded as an accepted risk and the GHSA-7gmj-67g7-phm9 class of bug becomes materially more relevant to us | D2 |
| The backend cannot serve resolution at desktop-acceptable latency, or the offline case turns out to be a product requirement rather than an honest unavailable outcome | D6 is not reversed — the credential exposure it exists to prevent does not become acceptable because resolution got slow — but the remedy has to be found inside it: caching an already-resolved session, pre-resolution, or a backend closer to the user. **A local resolver is not on the table** | D6 (remedy, not reversal) |
| The commander reopens D6 and rules that **on-device provider resolution is acceptable after all** | §8 resolves to (b); PL-0501 builds a local resolver and the credential-handling question moves to whatever protects it on disk. Recorded here because a superseded ruling must be visibly superseded rather than quietly replaced | D6 |
| The commander rules that **"do not rewrite" permits moving the whole API layer** | §8 resolves to (a), and D2 itself is reopened — the sidecar's whole justification is preservation | D2, D6 |
| **`next-electron-rsc` or an equivalent ships a verified Next 16 integration with an active maintainer** | Materially strengthens Electron, but **does not by itself flip the decision**, because §1 is unaffected | D1 (no change expected) |
| **Tauri 3.0 acquires a date and includes Windows-affecting breakage** | Does not flip the shell choice; changes the pinning strategy | D1 (pinning only) |

---

## 12. What this task did not do

No shell, no adapter, no dependency, no `package.json` change, no Rust, no `src-tauri`. The two files
written are `docs/DESKTOP_PLAYBACK.md` and a cross-linked section in `docs/ARCHITECTURE.md`. The
TypeScript in §3 is a **specification of a boundary**, not a file that exists; when it is
implemented, the implementing task owns its path and this document is what it is reviewed against.

### The three follow-up contract tasks

The gaps this document found in the existing contracts are not left floating as findings in a report.
The commander ordered them as tasks, and this document points at them:

| Task | What it changes | Why it exists |
| --- | --- | --- |
| **PL-0902** | DRM capability and requirements on the stream-candidate or playback-session contract | Today `packages/contracts/src` contains **no `drm` at all**. **This gates the capability routing in §4**: `canPlay` cannot make a reasoned DRM decision from a contract that carries no DRM field, so until it lands, §4 specifies a decision with nothing to read |
| **PL-0903** | A generic engine-unavailable reason that can represent libmpv failing to load | `EngineUnavailableReason` was Shaka-shaped — the member then called `browser_unsupported` was a misnomer on desktop and "libmpv could not be loaded" had no member at all (§6). Closed: PL-0903 generalised `engine_load_failed` and moved the union to `engine.ts`; PL-0502 renamed that member to `host_unsupported` |
| **PL-0904** | A playback error origin and type for native failures | So mpv errors are not forced into Shaka 5.2.x numeric codes in `shaka-error.ts`, producing a trail that reads as a Shaka error category and is not one (§6) |

### Still open, and explicitly so

**The ADR-register pointer in `docs/DECISIONS.md`**, which lands once PL-0405 clears review (see the
header). That is the only thing this document defers.

**§8 is no longer among them.** It was handed up rather than on, and it came back: the commander
ruled on 2026-09-16, and §8 now records the ruling, its reasoning, its cost, and the alternatives it
rejected.
