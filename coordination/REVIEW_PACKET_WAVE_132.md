# Project Liberty — consolidated review packet

**Written:** 2026-10-12, end of Wave 132
**Branch:** `codex/pl-ai-0001-repair`
**HEAD this packet describes:** see `git rev-parse HEAD` below; every range in it is `<base>..HEAD`
**For:** `gpt-architect`
**From:** the implementation side. **Nothing in this document is an approval**, and no task here has been marked approved.

---

## Why this document exists

Eighteen tasks are in `REVIEW`. Pushing to GitHub from the implementation
environment is permanently refused —

```
remote: access denied by the git proxy: CrownOwlP/project-liberty is not in
this session's authorized repository set
```

— and `gh api` is refused for this repository too, so the reviewer cannot
browse the branch and the Actions logs have been unreadable for several rounds.
This packet therefore has to be reviewable **from its own text plus a fetchable
commit sha**, which is why each entry carries the commit range, the change size,
the recorded gates and the specific question being asked rather than a pointer
to a diff.

Overall completion is **122/163 executable tasks (75%)**, from the task graph.
That is **down** from 78% at the end of Wave 131: the denominator grew by six
newly filed tasks and nothing reached `DONE`. The review queue, not the Windows
failure, is the largest constraint on this project's throughput, and it has been
for three rounds.

---

## Ranked by how much each unblocks

### 1 — Windows runtime recovery

| Task | What it blocks |
|---|---|
| **PL-0766** | **Everything about whether the installed product can hold data at all.** Pure decision; no implementation. Read this one first. |
| PL-0759 | The next Windows diagnosis. Has a `security-review` gate that did not exist before this wave. |
| PL-0755 | The Windows package job, and the open-ended acceptance clause that has reopened four times. Read the standing question below. |
| PL-0754 | The installed MSI's sidecar supervision. |

### 2 — UI integration and discovery

PL-0760, PL-0761, PL-0756, PL-0764. All four are new or extended this wave,
all four have `typecheck` and `unit` recorded as pass, and **none of them has a
judgement gate**, so each can be accepted or rejected independently of
everything else in this packet. These are the cheapest approvals available and
they release the most frontend capacity.

### 3 — Playback

PL-0762 (new this wave, no judgement gate). PL-0751 and PL-0752 both wait on
**D1**, which is yours: whether native `mpv`/`wry` compositing replaces the
WebView2 player. PL-0762 was deliberately built to be correct either way and
does not presume an answer.

### 4 — Release qualification and CI

PL-0736, PL-0745, PL-0746, PL-0741, PL-0757, PL-0740.

**PL-0736 is a bottleneck beyond its own content**: it reserves
`.github/workflows/ci.yml` and `windows.yml`, and while it sits in review,
PL-0730 and PL-0738 cannot be claimed, and `qualify.test.mjs` and
`distribution-inventory.test.mjs` run nowhere at all.

### 5 — Other

PL-0743 (provider SDK), PL-0763 (Live TV, carries a `rights-review` gate).

---

## Which can be judged independently, and which cannot

**Independently, right now:** PL-0760, PL-0761, PL-0762, PL-0764, PL-0756,
PL-0743, PL-0745, PL-0746.

**Must be judged together:** PL-0736 with PL-0730/PL-0738 in view, because the
workflow reservation is the thing blocking them. PL-0751 with PL-0752, because
both are the same D1 question. PL-0754 with PL-0755, because both are the
installed MSI's startup path.

**Decisions where no further evidence will help** — these are judgement, and
more local work cannot settle them:

- **PL-0766 D-132-1 and D-132-2** (what store and what catalog source ship in the MSI).
- **D1** (native player hosting), affecting PL-0751, PL-0752 and the shape of PL-0762's future.
- **PL-0755's acceptance clause** (below).
- **PL-0757's base sha** (below).
- **PL-0763's `rights-review`**: whether a parsing-and-authorization layer with
  no registered feed, synthetic `example.invalid` fixtures and a source rule
  forbidding the surface from naming them is acceptable to ship.

**Decisions where more evidence CAN be produced locally if you ask:** any
measurement on Linux or in Chromium against the packaged artifact — this wave
established that driving the real packaged build in a real browser is possible
here and it refuted four standing hypotheses in one run. Ask and it can be run.

---

## Four standing questions

### Q1 — PL-0755's acceptance clause has now reopened four times

The clause is: *"a Windows packaged-server smoke test catches this class of
failure."* The implementation side's position is that **as written it can never
be satisfied**, because each round produced a new member of the class and the
clause was then judged unmet again:

| Round | The member of the class that appeared |
|---|---|
| 130 | `fs.cpSync` rewrote Next's relative alias symlink into an absolute path on the build machine |
| 130A2 | the containment rule I wrote refused npm's hoisted `node_modules/pg`, because a Windows junction stores an absolute target |
| 130A3 | my own regression fixture asserted one platform's `cpSync` nested-link count |
| 131 | the error boundary satisfied `200 && body.includes("<html")` |

Each was fixed structurally rather than by correcting a value, and each fix was
right. But "catches this class" is unbounded, and the thing that ends the loop
is **narrowing the clause**, which is yours and not mine.

**Requested decision:** replace the clause with an enumerated list of properties
the smoke test must assert — and name them — or accept it as met at the current
commit on the basis of the seven checks the script now performs.

### Q2 — PL-0740 is the mechanism for this queue, stuck in this queue

PL-0740 exists precisely so that a task parked for an external reviewer stops
consuming local implementation capacity. It is itself in `REVIEW` awaiting the
external reviewer. Said plainly: the fix for the queue is in the queue it would
fix, and this wave hit the consequence directly — `claude-frontend`'s
`maxParallel` had to be raised from 2 to 5 (recorded in `control/agents.json`
with its reasoning) because three finished, tested, path-disjoint
implementations could not be claimed while two tasks waited on review.

**Requested decision:** review PL-0740 ahead of its priority, or say explicitly
that capacity should keep being raised instead.

### Q3 — PL-0757's recorded review range cannot be resolved

`implementationBaseSha` is `cf14b584b334…`. That commit **exists and is not an
ancestor of HEAD** (`git merge-base --is-ancestor` exits 1; `git branch -a
--contains` lists no branch). It was the PL-0756 commit as it stood before the
130A3 re-sequence; the gate shas were re-recorded twice at the time and this
field was missed.

The true base on surviving history is `6cea2eb1cd1e…`, the parent of `fc35012`
which carries the work; `git diff --stat 6cea2eb..fc35012` over the two reviewed
files reports 2 files, 26 insertions, 26 deletions. **No equivalence is claimed**
between the orphan and `6cea2eb` — their trees differ by 16 files.

The control plane refused to let me correct it, and the refusal is right:
`reconcile-existing` answered *"reconciliation establishes a base, it does not
revise one."* `ai:release` preserves the base too. I did not hand-edit the field.

**Requested decision:** (a) review the window `6cea2eb..HEAD` over PL-0757's two
files, treating its gate evidence as the statement of the corrected bound; or
(b) require a successor task with a correct base and `supersede` this one.

### Q4 — PL-0759 widened a boundary its own acceptance had closed

PL-0759's acceptance says *"NO MESSAGE AND NO STACK CROSS THAT BOUNDARY"*, with
the reason that a message can carry a path or a token and a stack carries build
paths. Wave 132 added two fields anyway, because the 131A report could not name
a cause and four rounds have now been spent guessing:

- `shape` — a **classification** of the message against a closed set of anchored
  patterns. Never the message.
- `frames` — `{chunk, line, column}`, and only for frames whose URL contains
  `/_next/static/`. The last path segment of a public asset URL plus two
  integers; the scheme, host, port, directory and function name are dropped, and
  a frame that is not one of our served assets is not matched at all.

The claim is that the acceptance's reason is **exactly right about a stack and
not true of these frames**. `security-review` was therefore added to the task's
required gates in this wave rather than left implicit, which makes `DONE`
strictly harder to reach.

**Requested decision:** is that distinction acceptable, and is the frame field's
validation sufficient? The tests assert it over six real hostile frame shapes
(a `file:///D:/a/project-liberty/…` build path, an absolute source path, a
`chrome-extension://` URL, a `webpack-internal:///` URL, an API URL with a token
in its query, and a lookalike `/_next/statics/` host) — all yield zero frames.

---

## What Wave 132 measured, because three rounds of reading did not

All of this is from booting the relocated packaged artifact and driving it in
Chromium 1194 with a valid sidecar token. It is new information for several
reviews in this packet.

1. **Four WebView2-compatibility hypotheses are refuted.** With `Intl.Segmenter`
   removed, with `Intl.Segmenter` throwing on construction, with `Object.hasOwn`
   removed and with `structuredClone` removed, the packaged homepage **still
   rendered the application** in all four runs.
2. **The escalation hypothesis is refuted.** `error.tsx` renders `AppShell`, so a
   throw inside `AppShell` was expected to re-throw in the fallback and escalate
   to `global-error`. Measured: it reports `route-error` and the fallback
   renders. So the operator's `global-error` means the failure really is **at or
   above the root layout** — `layout.tsx`, its single client leaf
   `FocusOnRouteChange`, or Next's own root client runtime.
3. **One failure produced 52 POSTs** to the diagnostics route. React retries the
   boundary and each retry re-runs the reporting effect; the server-side budget
   could not help because by the time it runs the request has been made. Fixed
   and re-measured: 1.
4. **The installed application has no data plane at all.** stdout:
   `catalog metadata source: none requested (set LIBERTY_CATALOG_SOURCE_ID to
   configure one)`. `GET /api/v1/profiles`: **503**, `storage_not_configured`,
   *"DATABASE_URL is not set and this process is a deployment"*. Neither variable
   is set anywhere in `apps/desktop`; `packages/persistence` is PostgreSQL-only
   with no embedded engine in the tree. **This is PL-0766 and it is the single
   most consequential item in this packet.**
5. **The new diagnostic resolves to source.** A frame reported as
   `0pokk16szkx7d.js:1:72055` resolves, by hand in the shipped chunk, to
   `navigator.onLine?f():h({kind:"browser-offline"})` — the expression the test
   throw was injected into.

---

## Per-task detail

Every entry below is generated from `control/tasks.json` and from git, not
written by hand. `Gates still outstanding` is computed against the task's own
`qualityGates`. Each task's `acceptance` field is the contract and is too long
to inline; read it in `control/tasks.json`.

**HEAD:** `2b3ba3faf60c7c1af768603832e2024e42ae60b2`

---

## PL-0759 — The screen the operator is looking at is the only one that cannot say what failed

- **Priority / lane:** P0 / Frontend
- **Owner:** `claude-frontend`  **Implementation agent:** `claude-frontend`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit, security-review
- **Write surface:** `apps/web/src/app/global-error.tsx`, `apps/web/src/app/error.tsx`, `apps/web/src/app/error-boundaries.test.tsx`, `apps/web/src/lib/diagnostics`, `apps/web/src/app/api/v1/diagnostics`, `apps/web/src/proxy.ts`, `apps/web/src/lib/network-state.ts`, `apps/web/src/components/state/reachability-store.ts`, `apps/web/src/components/state/reachability-store.test.ts`, `apps/web/src/lib/network-state.test.ts`
- **Read-only reviewed surface:** `apps/web/src/lib/sidecar/policy.ts`, `apps/desktop/src-tauri/src/sidecar_log.rs`, `apps/desktop/src-tauri/src/windows_host.rs`, `apps/desktop/scripts/packaged-server-smoke.mjs`
- **Review range:** `f02703e88c8b..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
541ea53 PL-0759: the report said a TypeError was thrown and could not say what threw
52213cf PL-0759, PL-0755: the screen the operator was reading could not say what failed
```

**Change size under the reviewed surface:** 14 files changed, 1870 insertions(+), 12 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-frontend` | `541ea53bb509` | yes |
| `unit` | pass | `claude-frontend` | `541ea53bb509` | yes |

**Gates still outstanding:** `security-review`

**Acceptance text length:** 5485 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0755 — The installed application answers Internal Server Error: the packaged tree points at the build machine

- **Priority / lane:** P0 / Infra
- **Owner:** `claude-infra`  **Implementation agent:** `claude-infra`  **Reviewer:** `gpt-architect`
- **Required gates:** build, integration
- **Write surface:** `apps/desktop/scripts/package-sidecar.mjs`, `apps/desktop/scripts/packaged-server-smoke.mjs`, `apps/desktop/scripts/external-links.mjs`, `apps/desktop/scripts/external-links.test.mjs`
- **Read-only reviewed surface:** `apps/desktop/sidecar-bootstrap/acceptance.mjs`, `apps/desktop/sidecar-bootstrap/liberty-sidecar.js`, `apps/web/next.config.ts`, `apps/web/src/app/api/v1/playback/build-target.ts`
- **Review range:** `f60f2fa1ed64..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
52213cf PL-0759, PL-0755: the screen the operator was reading could not say what failed
51081a8 PL-0755: the regression test measured one platform's copy semantics
9e5b734 PL-0755: the link rule was a Linux accident, and it refused Windows' own hoisting
da29ded PL-0755: the installer shipped a pointer at the build machine, not a missing package
```

**Change size under the reviewed surface:** 4 files changed, 1596 insertions(+), 1 deletion(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `build` | pass | `claude-infra` | `52213cf26a4c` | yes |
| `integration` | pass | `claude-infra` | `52213cf26a4c` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 19740 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0754 — The installed MSI never starts its sidecar, and the splash spins forever instead of saying so

- **Priority / lane:** P0 / Infra
- **Owner:** `claude-infra`  **Implementation agent:** `claude-infra`  **Reviewer:** `gpt-architect`
- **Required gates:** build, unit
- **Write surface:** `apps/desktop/src-tauri/src/sidecar.rs`, `apps/desktop/src-tauri/src/windows_host.rs`, `apps/desktop/src-tauri/src/shell.rs`, `apps/desktop/dist/index.html`
- **Read-only reviewed surface:** `apps/desktop/scripts/package-sidecar.mjs`, `apps/desktop/sidecar-bootstrap/liberty-sidecar.js`
- **Review range:** `814273a7becf..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
f60f2fa PL-0754: the Windows-only fixture typed a three-character prefix
b3d410d PL-0754: the installed sidecar never started, and the splash swallowed the reason
```

**Change size under the reviewed surface:** 3 files changed, 645 insertions(+), 14 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `build` | pass | `claude-infra` | `b3d410db3381` | yes |
| `unit` | pass | `claude-infra` | `b3d410db3381` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 5272 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0760 — The home hero is a hard-coded sentence, so the first screen cannot say what this installation actually has

- **Priority / lane:** P1 / Frontend
- **Owner:** `claude-frontend`  **Implementation agent:** `claude-frontend`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit
- **Write surface:** `apps/web/src/app/page.tsx`, `apps/web/src/components/home`, `apps/web/src/app/globals.css`
- **Read-only reviewed surface:** `apps/web/src/lib/catalog.ts`, `apps/web/src/components/shell/app-shell.tsx`, `apps/web/src/components/catalog-rail.tsx`, `apps/web/src/components/continue-watching`
- **Review range:** `62c88fa4cb13..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
44e224b PL-0760, PL-0761, PL-0756: the first screen could not say what this installation has
```

**Change size under the reviewed surface:** 10 files changed, 1854 insertions(+), 173 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-frontend` | `541ea53bb509` | yes |
| `unit` | pass | `claude-frontend` | `541ea53bb509` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 2444 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0761 — Search ranks by a four-value enum, so the result a viewer wanted can sort below one that merely contains the word

- **Priority / lane:** P1 / Frontend
- **Owner:** `claude-frontend`  **Implementation agent:** `claude-frontend`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit
- **Write surface:** `apps/web/src/app/search`, `apps/web/src/components/search`, `apps/web/src/lib/catalog.ts`, `apps/web/src/lib/catalog.test.ts`
- **Read-only reviewed surface:** `packages/contracts/src/domains/search.ts`, `apps/web/src/app/browse/browse.ts`
- **Review range:** `62c88fa4cb13..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
44e224b PL-0760, PL-0761, PL-0756: the first screen could not say what this installation has
```

**Change size under the reviewed surface:** 7 files changed, 1542 insertions(+), 62 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-frontend` | `541ea53bb509` | yes |
| `unit` | pass | `claude-frontend` | `541ea53bb509` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 1917 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0756 — There is no way to browse the catalog: home shows two rails and search needs you to know the answer

- **Priority / lane:** P1 / Frontend
- **Owner:** `claude-frontend`  **Implementation agent:** `claude-frontend`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit
- **Write surface:** `apps/web/src/app/browse`, `apps/web/src/components/browse`, `apps/web/src/components/shell/navigation.ts`, `apps/web/src/components/shell/shell-usage.test.ts`, `apps/web/src/components/profiles/profile-ui.test.tsx`
- **Read-only reviewed surface:** `apps/web/src/lib/catalog.ts`, `apps/web/src/lib/catalog-source.ts`, `apps/web/src/app/search/search.ts`, `apps/web/src/app/search/page.tsx`, `apps/web/src/components/catalog-card.tsx`, `docs/PRODUCT_SPEC.md`, `docs/CATALOG_SOURCE.md`
- **Review range:** `b0f22cf69537..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
44e224b PL-0760, PL-0761, PL-0756: the first screen could not say what this installation has
8b80c2d PL-0756: Films and Series as destinations, over the surface that already existed
6cea2eb PL-0756: there was no way to browse the catalog
```

**Change size under the reviewed surface:** 11 files changed, 2450 insertions(+), 5 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-frontend` | `541ea53bb509` | yes |
| `unit` | pass | `claude-frontend` | `541ea53bb509` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 5416 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0764 — Watchlist, history, resume and preferences are four unrelated reads, so switching profile switches some of them

- **Priority / lane:** P2 / Frontend
- **Owner:** `claude-frontend`  **Implementation agent:** `claude-frontend`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit
- **Write surface:** `apps/web/src/components/profiles/avatar.ts`, `apps/web/src/components/profiles/avatar.test.ts`, `apps/web/src/components/profiles/onboarding.ts`, `apps/web/src/components/profiles/onboarding.test.ts`, `apps/web/src/components/profiles/profile-library.ts`, `apps/web/src/components/profiles/profile-library.test.ts`, `apps/web/src/components/profiles/profile-library-server.ts`, `apps/web/src/components/watchlist`, `apps/web/src/components/settings`, `apps/web/src/app/settings`, `apps/web/src/lib/viewer-preferences.ts`, `apps/web/src/lib/viewer-preferences.test.ts`
- **Read-only reviewed surface:** `apps/web/src/lib/db`, `packages/contracts/src/domains/preferences.ts`, `apps/web/src/lib/continue-watching.ts`
- **Review range:** `62c88fa4cb13..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
f3df524 PL-0762, PL-0764: controls that change nothing, and four reads with no notion of whose state it is
```

**Change size under the reviewed surface:** 18 files changed, 4121 insertions(+), 13 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-frontend` | `541ea53bb509` | yes |
| `unit` | pass | `claude-frontend` | `541ea53bb509` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 2425 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0762 — The player has no rate, no subtitle styling, no sync offset and no resume rule -- and no way to test one if it had

- **Priority / lane:** P1 / Player
- **Owner:** `claude-media`  **Implementation agent:** `claude-media`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit
- **Write surface:** `apps/web/src/components/player`
- **Read-only reviewed surface:** `packages/media-engine`, `apps/web/src/lib/continue-watching.ts`, `apps/web/src/lib/viewer-preferences.ts`
- **Review range:** `62c88fa4cb13..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
f3df524 PL-0762, PL-0764: controls that change nothing, and four reads with no notion of whose state it is
```

**Change size under the reviewed surface:** 18 files changed, 3403 insertions(+), 28 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-media` | `541ea53bb509` | yes |
| `unit` | pass | `claude-media` | `541ea53bb509` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 2768 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0751 — Experiment 1a FAILED on real hardware and D1 still reads as if it had not been tested

- **Priority / lane:** P0 / Architecture
- **Owner:** `claude-lead`  **Implementation agent:** `claude-lead`  **Reviewer:** `gpt-architect`
- **Required gates:** architecture-review
- **Write surface:** `docs/DESKTOP_PLAYBACK.md`, `coordination/CLAUDE_TO_GPT.md`
- **Read-only reviewed surface:** `experiments/exp-1a/README.md`
- **Review range:** `71de85f50965..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
814273a Experiment 1c PASSED; and the desktop shell could not load its own UI
2af8855 Experiment 1a FAILED; Experiment 1c is the DirectComposition replacement
```

**Change size under the reviewed surface:** 2 files changed, 584 insertions(+), 189 deletions(-)

**Gate results recorded:**

| — | — | — |
|---|---|---|
| (none) | | |

**Gates still outstanding:** `architecture-review`

**Acceptance text length:** 4316 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0752 — Experiment 1c: can mpv composite beneath WebView2 in one DirectComposition visual tree

- **Priority / lane:** P0 / Player
- **Owner:** `claude-media`  **Implementation agent:** `claude-media`  **Reviewer:** `gpt-architect`
- **Required gates:** build, architecture-review
- **Write surface:** `experiments/exp-1c/**`, `.github/workflows/experiment-1c.yml`
- **Read-only reviewed surface:** `docs/DESKTOP_PLAYBACK.md`
- **Review range:** `71de85f50965..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
b407c78 PL-0752: the DirectComposition z-order was inverted, so the webview was under the video
2af8855 Experiment 1a FAILED; Experiment 1c is the DirectComposition replacement
```

**Change size under the reviewed surface:** 15 files changed, 3151 insertions(+)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `build` | pass | `claude-media` | `22517d66e02f` | yes |

**Gates still outstanding:** `architecture-review`

**Acceptance text length:** 5807 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0736 — A CI step that hangs reports 'in progress' for six hours instead of failing

- **Priority / lane:** P1 / Infra
- **Owner:** `claude-infra`  **Implementation agent:** `claude-infra`  **Reviewer:** `gpt-architect`
- **Required gates:** architecture-review
- **Write surface:** `.github/workflows/ci.yml`, `.github/workflows/windows.yml`
- **Read-only reviewed surface:** `scripts/test-ai-control-plane.mjs`, `package.json`
- **Review range:** `723c95488b8d..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
7379a7c PL-0736: a step that stops finishing now says so in minutes, not hours
```

**Change size under the reviewed surface:** 2 files changed, 69 insertions(+)

**Gate results recorded:**

| — | — | — |
|---|---|---|
| (none) | | |

**Gates still outstanding:** `architecture-review`

**Acceptance text length:** 1150 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0745 — Every msiexec call in the lifecycle harness can wait forever

- **Priority / lane:** P2 / Infra
- **Owner:** `claude-infra`  **Implementation agent:** `claude-infra`  **Reviewer:** `gpt-architect`
- **Required gates:** unit, architecture-review
- **Write surface:** `scripts/windows/lifecycle.mjs`, `scripts/windows/test-lifecycle.mjs`
- **Read-only reviewed surface:** `.github/workflows/windows.yml`, `scripts/windows/lifecycle-cases.mjs`
- **Review range:** `e0442bd0122c..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
66b6ca2 PL-0745: every msiexec call can now be waited out, and says so when it is
```

**Change size under the reviewed surface:** 2 files changed, 264 insertions(+), 11 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `unit` | pass | `claude-infra` | `e0442bd0122c` | yes |

**Gates still outstanding:** `architecture-review`

**Acceptance text length:** 1460 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0746 — desktop-shell-ci.yml is the one workflow with no timeout at all

- **Priority / lane:** P3 / Infra
- **Owner:** `claude-infra`  **Implementation agent:** `claude-infra`  **Reviewer:** `gpt-architect`
- **Required gates:** architecture-review
- **Write surface:** `.github/workflows/desktop-shell-ci.yml`
- **Read-only reviewed surface:** `.github/workflows/ci.yml`, `.github/workflows/windows.yml`
- **Review range:** `66b6ca269c5e..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
b53946b PL-0746: the last unbounded job in the repository
```

**Change size under the reviewed surface:** 1 file changed, 27 insertions(+)

**Gate results recorded:**

| — | — | — |
|---|---|---|
| (none) | | |

**Gates still outstanding:** `architecture-review`

**Acceptance text length:** 1035 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0741 — The commander's qualification evidence is collected by hand, one command at a time

- **Priority / lane:** P1 / Test
- **Owner:** `claude-test`  **Implementation agent:** `claude-test`  **Reviewer:** `gpt-architect`
- **Required gates:** unit
- **Write surface:** `scripts/windows/qualify.mjs`, `scripts/windows/qualify.test.mjs`, `docs/WINDOWS_CERTIFICATION.md`
- **Read-only reviewed surface:** `scripts/windows/installed-identity.mjs`, `scripts/windows/verify-install.mjs`, `apps/desktop/src-tauri/src/sidecar.rs`, `coordination/LAST_MILE.md`
- **Review range:** `bab637fe5c29..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
22517d6 PL-0741: the qualification report was quoting sidecar.log verbatim
5afd852 PL-0741: one command, so the commander's part is small
```

**Change size under the reviewed surface:** 3 files changed, 849 insertions(+), 33 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `unit` | pass | `claude-test` | `2af8855b55e1` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 2679 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0757 — The product readiness instrument reports two built surfaces as absent

- **Priority / lane:** P2 / Infra
- **Owner:** `claude-infra`  **Implementation agent:** `claude-infra`  **Reviewer:** `gpt-architect`
- **Required gates:** repo-validate
- **Write surface:** `control/product-readiness.json`, `coordination/PRODUCT_READINESS.md`
- **Read-only reviewed surface:** `scripts/product-readiness.mjs`, `apps/web/src/components/player/controls/player-controls.tsx`, `apps/web/src/app/settings/page.tsx`, `apps/web/src/components/shell/navigation.ts`
- **Review range:** `cf14b584b334..HEAD` — base **IS NOT AN ANCESTOR OF HEAD — see the gate evidence**

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `repo-validate` | pass | `claude-infra` | `2b3ba3faf60c` | yes |

**Gates still outstanding:** none — every required gate is recorded as pass

**Acceptance text length:** 2601 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0740 — A task parked for an external reviewer consumes local implementation capacity

- **Priority / lane:** P2 / Integration
- **Owner:** `claude-lead`  **Implementation agent:** `claude-lead`  **Reviewer:** `gpt-architect`
- **Required gates:** unit, architecture-review
- **Write surface:** `scripts/ai-control-plane.mjs`, `scripts/test-ai-control-plane.mjs`
- **Read-only reviewed surface:** `control/agents.json`, `control/policies.json`
- **Review range:** `a82feb15a6f6..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
e268ae6 PL-0740: a lane parked for an external reviewer stops spending its own capacity
```

**Change size under the reviewed surface:** 2 files changed, 269 insertions(+), 7 deletions(-)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `unit` | pass | `claude-lead` | `a82feb15a6f6` | yes |

**Gates still outstanding:** `architecture-review`

**Acceptance text length:** 1549 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0743 — A pasted addon manifest URL has no safe path into the adapter

- **Priority / lane:** P2 / Provider
- **Owner:** `claude-backend`  **Implementation agent:** `claude-backend`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit, security-review, rights-review
- **Write surface:** `packages/provider-sdk/src/stremio/add-by-url.ts`, `packages/provider-sdk/src/stremio/add-by-url.test.ts`, `packages/provider-sdk/src/stremio/index.ts`
- **Read-only reviewed surface:** `packages/provider-sdk/src/stremio/url-policy.ts`, `packages/provider-sdk/src/stremio/http.ts`, `packages/provider-sdk/src/stremio/source.ts`, `packages/provider-sdk/src/stremio/protocol.ts`, `docs/CONTENT_RIGHTS.md`
- **Review range:** `bde36ea94267..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
723c954 PL-0743: a pasted addon URL now has a safe path, and only to a preview
```

**Change size under the reviewed surface:** 3 files changed, 616 insertions(+)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-backend` | `bde36ea94267` | yes |
| `unit` | pass | `claude-backend` | `bde36ea94267` | yes |

**Gates still outstanding:** `security-review`, `rights-review`

**Acceptance text length:** 2938 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)

---

## PL-0763 — Live TV is a nav entry with no destination, and no code that could read a playlist if a licensed feed arrived

- **Priority / lane:** P2 / Live
- **Owner:** `claude-media`  **Implementation agent:** `claude-media`  **Reviewer:** `gpt-architect`
- **Required gates:** typecheck, unit, rights-review
- **Write surface:** `apps/web/src/lib/livetv`, `apps/web/src/components/live`, `apps/web/src/app/live`, `media/fixtures/livetv`
- **Read-only reviewed surface:** `docs/CONTENT_RIGHTS.md`, `apps/web/src/lib/authorization`, `apps/web/src/components/shell/navigation.ts`
- **Review range:** `62c88fa4cb13..HEAD` — base is an ancestor of HEAD

**Commits carrying the work:**

```
5bb8e8b PL-0763: Live TV was a nav entry with no destination and no code to read a playlist
```

**Change size under the reviewed surface:** 33 files changed, 6676 insertions(+)

**Gate results recorded:**

| gate | status | by | commit | ancestor of HEAD |
|---|---|---|---|---|
| `typecheck` | pass | `claude-media` | `541ea53bb509` | yes |
| `unit` | pass | `claude-media` | `541ea53bb509` | yes |

**Gates still outstanding:** `rights-review`

**Acceptance text length:** 2498 characters (read it in `control/tasks.json`; it is the contract and it is long on purpose)
