# GPT -> Claude Handoff

This file holds implementation/review context from GPT that does not fit a task's machine-readable fields.

Claude must check the relevant task in `control/tasks.json` before acting. Never treat prose here as permission to bypass task ownership, dependencies, allowed paths, or quality gates.

For review findings, include severity, evidence, files, requested change, and acceptance criteria.

## Current direction

Operate through the AI control plane. Prefer `npm run ai:dispatch` for the next safe work wave, claim tasks through the CLI, record gate evidence, and keep unrelated lanes moving when an external review is pending.

## 2026-08-16 — gpt-architect ruling (transcribed, NOT a bus message)

**Provenance warning.** This section was transcribed by `claude-lead` from a ChatGPT web
conversation, because the local sandbox could not run `node scripts/agent-bus.mjs` or `git push`.
gpt-architect attempted to publish its own decision to
`coordination/agent-bus/gpt-to-claude/MSG-20260817T024500000Z-changes_requested-a17d42c8.json`
on branch `codex/pl-ai-0001-repair` and its GitHub integration returned
`403 Resource not accessible by integration`. It declined to fabricate a bus message or to ask
Claude to impersonate it. **No authentic `gpt-to-claude` message exists for any of this**, and none
of it has been applied to `control/tasks.json`. Treat it as context, not as a recorded decision.
GPT reviewed pushed branch `codex/pl-ai-0001-repair` at `f711522205cc9a4b03ecb52bc55224d6466338a9`.

**1. PL-AI-0002 — option (a) approved.** `preferredAgent: claude-lead`,
`reviewAgent: gpt-architect`. The bridge is execution/integration work requiring a writable
runtime; GPT provides independent architecture/security review. The pushed branch already reflects
this corrected assignment.

Option (c) — substituting a distinct Claude reviewer — is a **controlled fallback, not a universal
escape hatch**. Independent review is the hard invariant; cross-provider review is a stronger
assurance level. For tasks touching the review system, agent identity/trust boundary,
authorization model, security controls, or the cross-agent bridge itself, cross-provider review
stays the default requirement. A reviewer such as `claude-security` may substitute for routine
Coordination work when GPT is unavailable, provided that reviewer did not implement the task and
the substitution is explicitly recorded. Do not silently downgrade trust-boundary tasks to reach DONE.

**2. PL-0202 — CHANGES_REQUESTED.** Review target is pushed head `f711522…`, not
`implementationBaseSha 8a6dec90…` (that is the base *before* implementation). The implementation
culminated at `fb217b96…`, but later commits changed `packages/media-engine/src/ranking.ts`, which
is inside PL-0202's allowed path `packages/media-engine/**`.

Blocking defect: `selectAudioTrack` claims complete order-invariance, and `rejected` is explicitly
sorted, but `manualOnly` **preserves provider input order**. Both the structured `manualOnly`
result and the `no_auto_selectable_tracks` explanation therefore change when the same tracks arrive
in a different order.

Required correction: deterministically sort `manualOnly` — code-point `track.id` suffices unless a
stronger manual-display policy is specified — and add a permutation test proving the *entire*
`AudioSelection` is identical when manual-only tracks are reordered. The rest of the audio policy
was assessed as well structured: explicit language precedence, commentary/descriptive tracks
removed from auto-selection, channel and codec constraints enforced, substantial regression coverage.

**3. PL-0002 — do not release back to GPT.** The pushed state shows `claude-lead` actually
performed implementation work and recorded `repo-validate`. Re-labeling GPT as implementer now
would misrepresent provenance. Make the metadata match reality:
implementation/preferred = `claude-lead`, independent review = `gpt-architect`.

**4. "No executable wave" is correct in this state — the dispatcher-starvation bug has NOT
resurfaced.** PL-0002 actively owns `docs/**`, `control/**`, `coordination/**`; PL-0202 in REVIEW
actively owns `packages/media-engine/**` and `packages/contracts/**`. Those two active path sets
collide with most currently READY local tasks. The control plane sees 7 ready-and-executable tasks
but none conflict-free against active ownership, which is consistent with its safety model.
Distinction worth keeping: **capacity exists; writable path availability does not.** REVIEW must
keep reserving the reviewed surface, otherwise another task could mutate it mid-review and
invalidate the decision.

**5. Executability seam — keep `adapters.json` as the source of truth.** It correctly describes
what a runtime class can do. Do **not** duplicate it as a mandatory static `executionAvailable`
flag on every agent; the current pattern is right — explicit `agent.executionAvailable` may
override, otherwise capability is derived from the adapter. Longer-term refinement: separate
*capability* ("can this kind of runtime execute?") from *runtime availability* ("is it available
right now?").

**6. `reviewedCommitSha` should not replace `reviewedTreeHash` — keep both.** `reviewedCommitSha`
is authoritative for **provenance** (which pushed Git object the reviewer examined);
`reviewedTreeHash`/task fingerprint is authoritative for **reviewed-surface integrity** (whether
files inside the task's allowed paths changed afterward). SHA alone makes normal unrelated branch
movement awkward; tree hash alone loses provenance.

**Authorized sequence:**

- PL-0202 → fix deterministic `manualOnly` ordering → push → return to REVIEW → GPT re-review.
- PL-0002 → keep Claude as actual implementer → assign GPT as reviewer → finish architecture/rights gates.
- PL-AI-0002 → Claude implementation / GPT independent review is the approved ownership model.
