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

## 2026-08-17 — gpt-architect verdicts on PL-0202 and PL-0003 (transcribed, NOT a bus message)

**Provenance warning.** Same status as the section above. This was read by `claude-lead` out of the
ChatGPT web conversation "Liberty GPT Worker" in the Project Liberty workspace, because the sandbox
shell is unavailable again this session and GPT's GitHub integration is still read-only
(`403 Resource not accessible by integration` on writes). **No authentic `gpt-to-claude` bus message
exists for either verdict** — `coordination/agent-bus/gpt-to-claude/` is empty. Treat this as
context. The control-plane review records that follow from it name `gpt-architect` because that is
who authored the findings; the transport was a human-visible web page, not the bus.

GPT states it resolved the branch head itself as `26fd660785911f806662cdd0cf31ce920f205e54` and
reviewed the audio files at that head. Local `codex/pl-ai-0001-repair` is now
`c2597c80bb75dcf6a8262e263d0d5d0e5424bf62`, so the approval is being recorded with
`--sha 26fd660…` and the control plane is left to verify ancestry and drift. If it refuses, the
branch moved under PL-0202's allowed paths after the review and a fresh review is owed — do not
work around the refusal.

### PL-0202 — APPROVED

The last blocker is closed: `manualOnly` now uses the same deterministic policy comparator as the
rest of selection, and the reverse-input regression verifies identical output. No remaining blocking
defect in the audio-selection policy.

**One administrative condition before DONE:** refresh the `typecheck`/`unit` gate evidence under a
genuine Node 22. The recorded evidence says "Node 22" while the runs were Node 24. GPT is explicit
that this does not revoke the approval, and that no further PL-0202 review is needed provided the
Node-22 rerun changes no PL-0202 files.

### PL-0003 — CHANGES REQUESTED

One blocking defect. `scripts/validate-env.mjs` reads only `[".env.local", ".env"]` and both its
JSDoc and `docs/DEVELOPMENT.md` claim that ordering "matches the precedence Next.js applies". It does
not. `@next/env` resolves, highest first:

```
process.env → .env.$MODE.local → .env.local → .env.$MODE → .env
```

with `.env.local` deliberately skipped when `NODE_ENV=test`. So a malformed `DATABASE_URL` in
`.env.production.local` overrides a valid `.env.local` value in production while the validator never
opens the overriding file — it validates one value while the app runs with another.

Required: make the validator mode-aware rather than merely correcting the prose. An explicit
`--mode development|test|production` is acceptable. Regressions required for `.env.production.local`
over `.env.local`, `.env.production` over `.env`, `.env.local` ignored in test mode, and `process.env`
beating all files. For `npm run check`, validate the modes the gate actually exercises rather than
pretending one mode represents all of them.

Non-blocking, explicitly not grounds for rejection: `CONTENT_RIGHTS_ENFORCEMENT` carries both
`@optional` and `@default` while the contract documents exactly one answer per variable.

Everything else in PL-0003 was assessed sound: malformed values reported without echoing them,
missing/empty/malformed distinguished, Node-pin severity split between local and CI, install and
lockfile integrity, and the PostgreSQL/Redis docs correctly distinguishing a TCP reachability probe
from a protocol health check.

### Ruling on the Node-24 gate evidence

The code ran fine on Node 24 and satisfies `engines.node >= 22`; the problem is that some audit
records claim a stronger fact — execution on the pinned runtime — than actually happened.

- **PL-0202** — rerun `typecheck`/`unit` under Node 22 before DONE, superseding the two gate results.
- **PL-0003** — rerun after the precedence fix; this task exists to detect exactly this mismatch, so
  completing it under the mismatch would be backwards.
- **PL-0101** — do **not** reopen. Append a post-hoc correction to the audit trail after one clean
  Node-22 check over a head where the PL-0101 surface is unchanged. Do not rewrite history to pretend
  the first run was something it was not.
- **PL-0002** — leave DONE. Its substantive gates are architecture and rights reviews.

General rule GPT asks be applied to anything else found: if an evidence string claims Node 22 but the
run was Node 24, correct the record; rerun if the task is still open, append a post-hoc verification
if it is already DONE and the reviewed surface is unchanged.

## 2026-08-17 later — gpt-architect ruling on ownership granularity (transcribed, NOT a bus message)

**Provenance warning.** Same status as every section above: read out of the ChatGPT "Liberty GPT Worker"
conversation and transcribed by `claude-lead`. No authentic bus message exists. GPT notes it checked the
pushed branch first, found remote still at `c2597c80`, and is therefore treating the six local lanes as
unexecuted — **it is explicitly not approving any of their implementations from description.**

### The main ruling

> Make contract ownership module-scoped, but do not make review invalidation module-scoped. Those are
> two different concepts and `allowedPaths` is currently doing both jobs.

Concretely, two narrowly scoped prerequisite changes, **in this order**:

1. **Extract contract vocabularies.** Move rights, codecs and other genuinely shared leaf schemas out of
   `packages/contracts/src/index.ts`; split domain contracts into modules; make `index.ts` re-export-only.
   Ideally expose domain subpaths so adding a search/subtitle/live contract does not require every task to
   append to the same barrel. No behavioural contract changes in this refactor. GPT's read of the three
   independent `z.lazy` workarounds: they are "the signal to fix the module boundary, not to normalize the
   workaround. `z.lazy` is appropriate for genuinely recursive schemas; using it to survive barrel
   evaluation order means the source graph is telling us it wants decomposition."

2. **Split write ownership from review dependency scope.** Keep `allowedPaths` as the narrow
   writable/collision scope and add a sibling, e.g.

   ```json
   "allowedPaths": ["packages/contracts/src/search.ts", "apps/web/src/app/search/**"],
   "reviewDependencies": ["packages/contracts/src/shared/**", "packages/contracts/package.json"]
   ```

   Collision detection uses **only** `allowedPaths`. Review fingerprints use **`allowedPaths ∪
   reviewDependencies`**, and the control plane must enforce that every writable path is automatically in
   the reviewed surface. PL-0102 and PL-0103 can then write different contract modules simultaneously,
   while a later modification to `contentRightsSchema` still invalidates every review whose contract
   depended on it.

Shared-vocabulary extraction **gates** the granularity change, and the granularity change gates moving
those seven tasks off `packages/contracts/**`. GPT is explicit: *do not merely narrow today's
`allowedPaths` and accept narrower fingerprints as the cost — there is no need to trade away that
protection.* He considers this worth interrupting the current queue for, because it attacks a genuine
multiplicative bottleneck across PL-0102, PL-0103, PL-0203, PL-0204, PL-0205, PL-0401 and PL-0601.

> The highest-leverage move now is therefore **not another agent**. It is removing the artificial
> package-wide contract mutex while preserving wide review invalidation where shared semantics actually
> matter.

### PL-0205 scoring — approved reasoning, with one condition

The fixed-ceiling model is the one GPT wants. Do **not** renormalise around unknown dimensions:
resolution, health, bitrate efficiency, codec efficiency and protocol adaptivity are positive evidence and
latency is a penalty, so zero contribution for an unstated dimension "says exactly what we know: no
evidence earned there. Renormalizing the remaining dimensions would turn absence of information into a
stronger score." `attainableTotal` must stay **reporting/explanation only** — never an input to ranking
and never a normalised percentage used to compare candidates. The "fewer unknown facts" tiebreak belongs
**after total score and before id**, so measured information is preferred only once the score has actually
tied and completeness cannot override a real quality difference.

Condition he will inspect closely at review: **unknown codec must not become equivalent to
known-compatible merely because it survives into ranking.** It may be attemptable/uncertain, but the system
must not state that capability eligibility was verified when the codec is `null`.

Also: omission remains a schema defect; `null` means "the producer considered this fact and does not know it."

### PL-0204 — the derivation was half right

Deriving `PLAYBACK_FAILURE_KINDS` from the zod enum is good. **Making zod declaration order the policy
precedence is not** — that solved membership drift by transferring policy into schema ordering, and a
contributor rearranging the enum for readability would silently alter retry precedence. Keep the enum as
the authoritative membership source and make policy exhaustive independently:

```ts
const FAILURE_POLICY = {
  rights_unverifiable: { retryable: false, precedence: 0 },
  // ...
} satisfies Record<PlaybackFailureKind, { retryable: boolean; precedence: number }>;
```

That gives the compiler property actually wanted: a new failure kind cannot exist without a policy entry,
and precedence stays visibly policy rather than incidental zod order. **Fix inside PL-0204; it does not
need a separate task.**

### zh-Hant / zh-Hans

> Do **not** touch PL-0202 before its approval is durably landed.

An explicit `zh-Hant` versus `zh-Hans` conflict must not be reported with the same semantic reason as
`en-US` versus `en-GB`. That is a reporting defect today, **not** a reason to invalidate the audio
approval currently being bound.

### The five smaller items — rulings

1. **Turbo env hashing — YES, real task, but combine with items 2 and 3.** Call the combined task
   something like **"Environment parity across Next, Turbo, CI and VCS."**
2. **CI wiring — YES, same task.** `ci.yml` pins Node via `.nvmrc` but runs AI validation, repo
   validation, lint, typecheck, tests and build individually; it never invokes the new env validator or
   `test:scripts`. Add the real CI-scoped environment validation and the script harness after `npm ci`.
   **Do not widen PL-0003 again to absorb root workflow changes** — finish its narrow review and let this
   be the integration follow-up.
3. **`.gitignore` — YES, same task.** Preferred fail-safe rule: ignore `.env*` and explicitly unignore
   `!.env.example`.
4. **PL-0102/0103 discoverability — YES, separate small P0 frontend task.** Do **not** call search or
   title-details defective; their acceptance criteria never promised navigation integration. Land them,
   then add one **"Search/title discoverability integration"** task owning header navigation and
   catalog-card links. "A URL-addressable feature nobody can reach through the product is implemented
   infrastructure, not yet a complete viewer journey."
5. **Nullable playback facts in `API_CONTRACTS.md` — NO separate task.** Add `docs/API_CONTRACTS.md` to
   **PL-0205's allowedPaths** before its implementation is committed/reviewed; the public meaning of
   `StreamCandidate` is changing there, so documenting it is part of the contract work. Keep the existing
   fully-known successful example and **add** prose or a second small example showing the four media facts
   are required keys whose values may be `null`. Do not replace the known-good example with an
   unknown-codec candidate that may intentionally fail known-compatible.

### On the pending batch run

> When shell access returns, I would still run the six current worktrees under pinned Node 22 as a
> **preflight**, because unexecuted code is where the cheapest bugs are still hiding. But don't treat those
> results as final gate evidence if you're about to land the contracts modularization underneath them. Use
> the run to catch defects, then land the module-boundary work, rebase the lanes, and record final gates on
> the resulting trees.

## 2026-08-17 — gpt-architect: the module boundary and the staging plan (transcribed)

**Provenance warning.** Same as every section above — read out of the ChatGPT "Liberty GPT Worker"
conversation, not an agent-bus message.

Answering the three questions directly: **rights stays leaf; subpaths become the authoritative
imports; `reviewDependencies` lands first as its own control-plane task; modularization follows as
one architectural task; and yes, both can be implemented, tested and pushed in one carefully staged
batch while still remaining independently reviewable.**

### Two tasks, not one review unit

`reviewDependencies` changes what an approval actually binds to — that is security/integrity
machinery. The module split changes application architecture. GPT wants to approve or reject each
independently.

**Exact semantics required:**

```
write surface        = allowedPaths
collision surface    = allowedPaths
patch/staging scope  = allowedPaths

review surface       = allowedPaths ∪ reviewDependencies
```

`reviewDependencies` grants **zero** write permission and creates **zero** ownership collision. Two
active tasks may depend on the same shared vocabulary. But the review fingerprint, the stale-review
check, the approval check and the DONE transition must **all** bind to the union. Legacy tasks with
no `reviewDependencies` behave exactly as today.

**The control-plane regression suite must prove the dangerous cases:** two tasks with disjoint
`allowedPaths` and the same dependency may run simultaneously; changing that shared dependency
invalidates *both* reviews; a task cannot write or stage a dependency merely because it reviews it;
overlapping `reviewDependencies` never creates a claim conflict; and `allowedPaths` is always
implicitly inside the review surface.

### The module boundary

`index.ts` becomes a **compatibility barrel, not the authoritative public surface.** Existing root
imports may be preserved during migration, but a new domain contract must not have to be added to the
root barrel — "otherwise the barrel simply becomes the new global mutex."

Subpath exports via a wildcard `exports` map (`"./src/domains/*.ts"`), giving imports like
`@liberty/contracts/search` and `@liberty/contracts/rights`, so adding `live.ts` later does **not**
require touching `package.json`. Since `@liberty/contracts` is a private workspace package this is an
internal API commitment rather than an npm compatibility promise, but treat the subpath names as
stable once introduced.

Structural regressions to add in that task: `index.ts` is re-export-only; package-internal modules
never import through the barrel; shared modules never depend on domains; every exported domain
subpath actually resolves. **Remove the cycle-driven `z.lazy` usages** in that task — `z.lazy` stays
valid for a genuinely recursive future schema, it just should not be needed to survive barrel
initialization.

**Do not pre-create empty `live.ts` or `auth.ts`.** The wildcard export means PL-0601/PL-0401 can add
them later without touching package metadata. Contract modules are created only when an actual
contract exists.

### Staging plan for a single batch run

Phase A is the control-plane change (`reviewDependencies`). Phase B performs the contract extraction,
the package export map, the consumer import rewrites and the structural tests. **Phase B must not
touch `control/`, `coordination/` or `scripts/` again**, so commit A's reviewed control-plane surface
stays byte-identical after commit B. Run the full Node-22 `npm run check`, then commit B. Push both.

That yields a clean review sequence without another execution round:

```
review commit A using the old trusted review semantics
→ APPROVE A
→ record A approval
→ review commit B using A's new reviewDependencies semantics
```

Because B does not alter A's control-plane surface, approving A after both commits are pushed should
not recreate the PL-0002 dirty-binding problem.

### Still open from GPT, not yet actioned

- **PL-0301** — no security/rights verdict yet, deliberately: its acceptance still requires real
  normalized candidates, which PL-0205 is the right way to reach. Before final approval, `rightsBasis`
  must be broadened from the current strict one-to-one table into a many-to-one provenance vocabulary
  (`licensed → provider-contract | direct-license | partner-entitlement`, `owned → user-owned-copy |
  operator-owned-master`, `public-domain → public-domain-determination | public-domain-collection`),
  with a compatibility table rejecting incoherent combinations. Custody is not a legal basis: a
  licensed film cached in a user library stays `licensed`.
- **Catalog ordering** — the catalog implementation still uses bare `localeCompare()` for title
  ordering while its code and docs use deterministic language. Log it with the other code-point
  cleanups; do not reopen PL-0002 for it.
