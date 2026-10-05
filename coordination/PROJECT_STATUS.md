# Project Liberty - Project Status

> Generated 2026-10-05T02:29:13.635Z from the AI control plane.

**Overall completion:** 111/135 executable tasks (82%)

## Status summary

- **BACKLOG:** 5
- **READY:** 4
- **CLAIMED:** 0
- **IN_PROGRESS:** 0
- **REVIEW:** 7
- **BLOCKED:** 8
- **DONE:** 111
- **CANCELED:** 0
- **SUPERSEDED:** 4

## Milestones / phases

- **M0 — AI Engineering System + Repository Foundation:** COMPLETE, 4/4 (100%)
- **M1 — Core Discovery Experience:** COMPLETE, 3/3 (100%)
- **M2 — Media Resolution + Provider Foundation:** COMPLETE, 6/6 (100%)
- **M3 — Identity + Personal State:** IN_PROGRESS, 3/4 (75%)
- **M4 — Playback Vertical Slice:** COMPLETE, 6/6 (100%)
- **M5 — Live + Intelligence Boundaries:** IN_PROGRESS, 1/2 (50%)
- **M6 — Shared-Agent Automation Bridge:** COMPLETE, 3/3 (100%)
- **EXT — External Licensed Integrations:** BLOCKED, 0/2 (0%), 2 blocked
- **M7 — Windows Desktop Shell + Native Playback:** COMPLETE, 4/4 (100%)
- **PW — undefined:** IN_PROGRESS, 23/32 (72%), 2 blocked

## Active work

- **PW-0208** [REVIEW] An LGPL-compatible libmpv and FFmpeg the product may actually ship — owner: claude-infra
- **PW-0603** [REVIEW] The commander's run sheet, and the evidence it produces — owner: claude-test
- **PL-0728** [REVIEW] A standing check for a test that is skipped in every configuration this repository runs — owner: claude-test
- **PL-0731** [REVIEW] The empty client-key allowlist refusal is asserted by nobody — owner: claude-media
- **PL-0732** [REVIEW] The diagnostics setting is stored, consumed, and reachable by nobody — owner: claude-frontend
- **PL-0733** [REVIEW] Corrective: the Windows negative-verification step fails whether the check passes or not — owner: claude-infra
- **PL-0735** [REVIEW] CI's validate job no longer finishes: the control-plane suite spends its time in one inner loop — owner: claude-lead

## Dispatch classification

- **READY_AND_EXECUTABLE:** 4
- **READY_BUT_EXTERNAL:** 0
- **BLOCKED:** 8
- **BACKLOG (dependency-gated):** 5

## Recommended executable wave

No conflict-free executable tasks can be assigned with current agent capacity.

## Queued for external agents

No READY work is waiting on an external agent lane.

## Blockers

- **PL-0302** First production provider: Requires a confirmed licensed API/provider and credentials
- **PL-0602** Live provider integration: Requires licensed live feed/provider access
- **PW-0103** Experiment 1a: can a child HWND composite beneath the webview: Requires the commander's real Windows hardware, which no agent in this session can reach. This is a RECORDING of a fact already in coordination/LAST_MILE.md item 7, not a new judgement, and it is trivially reversible with unblock if gpt-architect disagrees.

THE FACT. PW-0103 is Experiment 1a: whether a child HWND composites beneath the WebView2. It needs a Windows machine with a GPU and a display. The cloud session has none: the linked computer exposes an isolated LINUX VM, and this container's Rust toolchain targets x86_64-unknown-linux-gnu only, so no Windows binary can be built or run here at all. A windows-latest CI runner substitutes for a BUILD machine (that is PW-0501) and for nothing else -- it has no display to composite onto and no human to look at one. LAST_MILE item 7 has said so since it was written, and it says the harder thing too: the whole choice of Tauri rests on this experiment and it has never been run, so a failure reverses decision D1 rather than being worked around.

WHY IT IS BEING RECORDED NOW RATHER THAN LEFT. While PW-0103 sat in READY, ai-control-plane dispatch listed it as dispatchable-now to claude-media and deferred PW-0501 behind it on an allowedPaths overlap. PW-0501 is the task gpt-architect named as wave item 2 in the round-91 verdict -- 'A Windows build that CI actually produces' -- and it is the one downstream of everything in the Windows phase. So the board was advertising, as this session's next available work, a task this session provably cannot perform, and holding back the task it can. A board that says a thing is dispatchable when it is not is worse than one that says it is blocked.

WHAT IT IS NOT. Not a claim that PW-0103 is unimportant, and not a request to descope it: it is the experiment the architecture rests on. It is a claim about WHO can run it. The owner action is in LAST_MILE item 7 and is unchanged.

UNBLOCK WHEN: the commander runs Experiment 1a on real Windows hardware and hands back the result, or gpt-architect rules that some part of it can be established without the hardware.
- **PW-0503** Install, upgrade, uninstall, reinstall — tested, not assumed: The harness meets all five REQUIRED clauses and is audited (build gate), but its central one -- 'exercised automatically wherever that is possible on a runner' -- has NEVER BEEN EXERCISED. Every observed Windows run reports lifecycle=skipped, because the verifier-negative step before it could not succeed under the runner's PowerShell: diagnosed and repaired this round as PL-0733. F1/F2/F3/F4 have produced no result on any machine. BLOCKED rather than released so the audit's gate results are PRESERVED (ai:release discards them) and so scripts/windows/** is not held against PW-0502. UNBLOCK WHEN: a Windows run reaches the lifecycle step, which needs PL-0733 applied and pushed -- push is 403 from this session, so it needs Diego. The first such run is the whole of the remaining evidence. Do NOT close this from --plan output or from the unit suite: the harness refuses to run off-Windows precisely so no cloud session can manufacture an F1 pass.
- **PW-0504** Installed-application qualification on the commander's Windows machine: reason not recorded
- **PW-0505** Upgrade qualification: user data across a real previous release: reason not recorded
- **PL-0720** No test drives a signed-in viewer through to an operable player on a production build: Blocked at gpt-architect's round-110 instruction, with gate results preserved. The architecture is accepted and the spec is preserved; what is missing is the task's central promise -- a signed-in authorized viewer reaching an OPERABLE PLAYER and operating a control -- which cannot happen because no authorized media provider is configured and the production provider boundary refuses first. PL-0302 ("First production provider", itself BLOCKED on a confirmed licensed API/provider and credentials) is now a declared dependency of this task, so DONE is structurally unreachable until that external authorization lands. The executable evidence recorded in round 109 stands and is about committed, correct work: it proves the journey up to the provider boundary. UNBLOCK WHEN: a licensed media provider is configured, at which point the SAME spec is extended through authorized title, real playback session, real player and at least one real control action. Do not close this by configuring a fake or demo provider in production.
- **PW-0315** The first dialog this product grows must restore focus to its trigger: Its precondition is not expressible as a task dependency, and leaving it READY makes the board advertise work nobody can do. PW-0315 attaches to the FIRST REAL DIALOG this product grows, and apps/web contains none: a search for role="dialog", <dialog and aria-modal returns nothing. ai:sync correctly promoted it out of BACKLOG because it has no unmet task dependencies -- the precondition is the existence of a UI primitive, which the control plane has no way to express -- and ai:dispatch then listed it as dispatchable to claude-frontend alongside PW-0308. A board that says a thing is dispatchable when it is not is worse than one that says it is blocked, which is the same reasoning recorded for PW-0103. Blocking preserves the obligation without pretending it is actionable. UNBLOCK WHEN: a dialog or modal is added to apps/web by any task, at which point this becomes immediately actionable and gpt-architect's round-110 instruction applies -- it must restore focus to its trigger and join the keyboard regression gate. It must NOT be closed by building a dialog for the purpose, and must NOT be marked DONE to tidy the board while no dialog exists.

## Agent capacity

- **gpt-architect:** 0/6 active (external lane; not locally executable)
- **claude-lead:** 1/2 active
- **claude-frontend:** 1/2 active
- **claude-backend:** 0/2 active
- **claude-media:** 1/2 active
- **claude-test:** 2/2 active
- **claude-security:** 0/1 active
- **claude-infra:** 2/2 active
- **human-commander:** 0/99 active (external lane; not locally executable)
