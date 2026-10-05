# Project Liberty - Project Status

> Generated 2026-10-05T14:07:33.841Z from the AI control plane.

**Overall completion:** 121/139 executable tasks (87%)

## Status summary

- **BACKLOG:** 5
- **READY:** 4
- **CLAIMED:** 0
- **IN_PROGRESS:** 0
- **REVIEW:** 0
- **BLOCKED:** 9
- **DONE:** 121
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
- **PW — undefined:** IN_PROGRESS, 26/32 (81%), 2 blocked

## Active work

No tasks are currently claimed, in progress, or in review.

## Dispatch classification

- **READY_AND_EXECUTABLE:** 4
- **READY_BUT_EXTERNAL:** 0
- **BLOCKED:** 9
- **BACKLOG (dependency-gated):** 5

## Recommended executable wave

- **PL-0736** -> claude-infra (P1/Infra) A CI step that hangs reports 'in progress' for six hours instead of failing
- **PL-0740** -> claude-lead (P2/Integration) A task parked for an external reviewer consumes local implementation capacity

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
- **PW-0208** An LGPL-compatible libmpv and FFmpeg the product may actually ship: BLOCKED ON THE COMMANDER/LEGAL CODEC-DISTRIBUTION DECISION, at gpt-architect's round-115 instruction: 'reclassify/BLOCK PW-0208 on the commander/legal codec-distribution decision rather than spending another engineering round pretending the external decision can be solved in code.'

THE PLAIN FACT: Liberty does not ship libmpv or FFmpeg. Not 'not yet verified' -- not present. apps/desktop/scripts/notices.mjs says so in its own header, package-sidecar.mjs copies only the Node runtime and the Next standalone server, and PL-0737's inventory reports libmpv/FFmpeg ABSENT against every tree it has been pointed at. So this task's central claim -- that the exact binaries the installer ships are reproducibly LGPL-compatible, pinned, configured and evidenced -- cannot be true of a binary that is not there, and no amount of further engineering makes it true.

WHAT THE SUCCESSFUL INSTALLER DID PROVE, and it is kept rather than discarded: THIRD-PARTY-NOTICES.md is present and NON-EMPTY in the real INSTALLED TREE on Windows, verified twice by verify-install.mjs inside Windows #19's F1 and F4. That is a real distribution fact about a real tree. It is not a substitute for the native media binaries.

UNBLOCK WHEN: the commander resolves codec distribution authorization. Then the acceptance still requires, in full -- exact pinned libmpv/FFmpeg binaries; reproducible build and configure flags; the GPL exclusions the LGPL strategy requires; SBOM/provenance; and an actual Windows package-tree inventory, which PL-0737 can now produce.

LGPL COMPLIANCE IS NOT PATENT AUTHORIZATION, and nothing in the packaging evidence bears on H.264/HEVC. docs/LICENSING.md section 6 is unchanged and must not be read as softened by any of the above.
- **PW-0504** Installed-application qualification on the commander's Windows machine: reason not recorded
- **PW-0505** Upgrade qualification: user data across a real previous release: reason not recorded
- **PL-0720** No test drives a signed-in viewer through to an operable player on a production build: Blocked at gpt-architect's round-110 instruction, with gate results preserved. The architecture is accepted and the spec is preserved; what is missing is the task's central promise -- a signed-in authorized viewer reaching an OPERABLE PLAYER and operating a control -- which cannot happen because no authorized media provider is configured and the production provider boundary refuses first. PL-0302 ("First production provider", itself BLOCKED on a confirmed licensed API/provider and credentials) is now a declared dependency of this task, so DONE is structurally unreachable until that external authorization lands. The executable evidence recorded in round 109 stands and is about committed, correct work: it proves the journey up to the provider boundary. UNBLOCK WHEN: a licensed media provider is configured, at which point the SAME spec is extended through authorized title, real playback session, real player and at least one real control action. Do not close this by configuring a fake or demo provider in production.
- **PW-0315** The first dialog this product grows must restore focus to its trigger: Its precondition is not expressible as a task dependency, and leaving it READY makes the board advertise work nobody can do. PW-0315 attaches to the FIRST REAL DIALOG this product grows, and apps/web contains none: a search for role="dialog", <dialog and aria-modal returns nothing. ai:sync correctly promoted it out of BACKLOG because it has no unmet task dependencies -- the precondition is the existence of a UI primitive, which the control plane has no way to express -- and ai:dispatch then listed it as dispatchable to claude-frontend alongside PW-0308. A board that says a thing is dispatchable when it is not is worse than one that says it is blocked, which is the same reasoning recorded for PW-0103. Blocking preserves the obligation without pretending it is actionable. UNBLOCK WHEN: a dialog or modal is added to apps/web by any task, at which point this becomes immediately actionable and gpt-architect's round-110 instruction applies -- it must restore focus to its trigger and join the keyboard regression gate. It must NOT be closed by building a dialog for the purpose, and must NOT be marked DONE to tidy the board while no dialog exists.
- **PL-0739** THIRD-PARTY-NOTICES.md contradicts itself: the table declares LGPL components the written offer denies: BLOCKED ON A RIGHTS DECISION THAT IS NOT ENGINEERING, at gpt-architect's round-115 instruction: 'If commander/counsel input is required, BLOCK PL-0739 explicitly on that decision after recording this verdict so it stops consuming implementation capacity.'

WHAT IS DONE AND STAYS DONE: the contradiction repair. The written offer is derived from the same entry list the table is rendered from, so the document cannot deny its own rows; both branches are tested and mutation-tested; the suite case that USED to assert the false sentence is gone. gpt-architect accepted that half explicitly.

WHAT IS NOT DONE, AND WHY NO ENGINEER MAY DECIDE IT: three components already shipping declare a copyleft licence (@img/sharp-libvips-linux-x64 and -linuxmusl-x64 at LGPL-3.0-or-later, @img/sharp-wasm32 at Apache-2.0 AND LGPL-3.0-or-later AND MIT) and all three report **none found** for shipped licence text. The resolution is one of three, and they cost very different amounts: ship the licence text and keep the offer live; exclude sharp from the packaged sidecar IF measurement proves Liberty does not use Next image optimisation; or make the written offer real with corresponding source for the exact libvips revision. That is a licensing decision about what the product distributes, not a code change, and product invariant 6 puts it with the reviewer and the commander.

UNBLOCK WHEN: the commander or counsel selects a resolution. The engineering half of each option is small and specified in docs/LICENSING.md section 7b.

STILL MEASURABLE WITHOUT THAT DECISION, and NOT blocked by it: whether @img/sharp-libvips-win32-x64 actually ships in the WINDOWS package and installed trees, and whether licence text accompanies it. That is clauses 1 and 2 of the correction, it is pure measurement, and it belongs to PL-0738 wiring the distribution inventory into the Windows job -- where the answer arrives automatically rather than by anyone asserting it.

## Agent capacity

- **gpt-architect:** 0/6 active (external lane; not locally executable)
- **claude-lead:** 0/2 active
- **claude-frontend:** 0/2 active
- **claude-backend:** 0/2 active
- **claude-media:** 0/2 active
- **claude-test:** 0/3 active
- **claude-security:** 0/1 active
- **claude-infra:** 0/5 active
- **human-commander:** 0/99 active (external lane; not locally executable)
