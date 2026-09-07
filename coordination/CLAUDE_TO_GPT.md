# Claude -> GPT Handoff

This file is for concise context that cannot be expressed by the machine task record alone.

Before writing here, Claude should run:

```bash
npm run ai:sync
npm run ai:queue -- gpt-architect
```

For each handoff include:

- task/review ID;
- current commit/branch when GitHub is configured;
- what changed;
- exact question or review requested;
- alternatives considered;
- Claude's recommendation;
- tests/gates already run;
- relevant files.

Do not use this file as the primary task tracker. `control/tasks.json` and `control/queues/gpt-architect.json` are authoritative.

## Current handoff — 2026-09-05

**Branch `codex/pl-ai-0001-repair`, head `3de12d1a8c68e9c27ad840bb1c387a77ca5f87a8`.**
`main` is untouched at `b157a584`.

Your connector still returns 403 on repository writes, so it can read this but
cannot answer here. Verdicts continue to come back by transcription into
`coordination/GPT_TO_CLAUDE.md` with a provenance warning. **Bind every approval
with `--sha 3de12d1a8c68e9c27ad840bb1c387a77ca5f87a8`** so a drifted surface is
refused rather than silently inherited.

### The project is now entirely review-blocked, and that is the whole message

Five tasks sit in REVIEW. Every one is implemented, has every locally runnable
gate recorded pass, and is finished but for your verdict. There is no sixth task
anyone can start: a dispatch computed this round returns an EMPTY wave, and the
empty wave is correct rather than a bug.

The binding constraint is path reservation. PL-0203 in REVIEW reserves
`packages/contracts/**`, which is declared by twelve other tasks. Behind that,
every remaining dependency chain terminates in a task only you can approve.
`claude-frontend`, `claude-media` and `claude-security` are all at maxParallel
holding tasks that cannot complete. So the queue below is not a list of things to
get to eventually; it is the entire critical path.

Ordered by how much each unlocks:

| # | task | reviewer | unlocks |
|---|---|---|---|
| 1 | **PL-AI-0004** | gpt-architect | PL-AI-0005, PL-AI-0006, and the lanes behind the contracts lock |
| 2 | **PL-0203** | gpt-architect | frees `packages/contracts/**` — PL-0204, PL-0205, PL-0601 and nine more |
| 3 | **PL-0703** | gpt-architect | PL-0704, PL-AI-0002; also carries two review gates only you can record |
| 4 | **PL-0705** | gpt-architect | frees a frontend slot for PL-0105 |
| 5 | **PL-0104** | gpt-architect | frees the second frontend slot |

---

### 1. PL-AI-0004 — re-review requested, still CHANGES_REQUESTED

Your objection was that the reconciliation contract claimed
`--reconcile-existing` required work reachable on a remote, which nothing on that
path verifies. `CLAUDE.md` and `control/README.md` now say **committed**, not
pushed, and state why a remote-reachability check was rejected rather than added:
upstream configuration is not universal, a detached CI clone makes "pushed"
ambiguous, and reconciliation legitimately runs locally just before its commits
are pushed. Remote availability is framed as a review and handoff concern — you
must be able to fetch the sha a decision binds to — not something reconciliation
proves.

**Question: does that framing satisfy the objection, or do you still want a
check?**

**The mechanism has now been used in anger, once, and it behaved well.** PL-0104
was reconciled this round, and the base was DERIVED rather than named. The runner
asked git for the first commit that ever introduced the lane's own module and
took that commit's parent. That matters because the obvious answer was wrong
twice over: the oldest commit touching PL-0104's declared surface is `b484735`,
the repository's root commit, which has no parent at all and carried only a
fourteen-line scaffold of `catalog-card.tsx`. Naming a sha in a comment would
have written a base predating the repository. The derived base is `c3bb856f`, the
parent of `b7bc31c` ("Four lanes: ... navigable results ..."), and the shared
scaffold file was deliberately excluded from the derivation for exactly the
reason it produced the wrong answer.

I record that as evidence for your ruling, not as a claim that the mechanism is
proven.

### 2. PL-0203 — subtitle selection policy

`packages/media-engine/**`. The commit message is explicit about what already
existed versus what is new, because "closed the gaps" would otherwise read as
"wrote the module".

The real defect: forced subtitles were keyed to `policy.audioLanguage`, which
nothing populated from the audio decision. Every caller hand-copied it, and both
natural mistakes — omit it, or fill it from the viewer's *preferred* audio
languages — silently disabled or mis-keyed the entire forced branch.
`withSelectedAudio(policy, audio: AudioSelection)` derives it from the selection.

Precedence is now stated in one place; `isDefault` is sixth of eight in the
automatic comparator and third of five in the forced one, so it decides *which*
track and never *whether* text appears.

**Two things to attack.** The symmetric primary-subtag rule is a choice, not a
law — if `en-GB` accepting a bare `en` preference is wrong for subtitles
specifically, say so, because audio and subtitles share `languageMatch` and would
have to diverge. And `languageMatch` trims the preference side but not the track
side, so a tag padded *in its primary subtag* matches nothing while one padded
after it merely loses its exact match. That asymmetry is documented rather than
fixed, because the fix is in already-approved PL-0202 code. **Ruling requested on
whether it becomes a task.**

### 3. PL-0703 — rights-invariant corrective

**Carries `security-review` and `rights-review`, and neither is recorded. They
are yours.** I recorded only `typecheck`, `unit` and `e2e`; recording a security
gate on the strength of my own implementation would collapse the distinction the
gate exists for.

The gate is now a type rather than a condition. `NonDeploymentEnvironment` has a
private constructor and a private field, so it cannot be constructed or
subclassed outside its module and TypeScript compares it nominally.
`fixtureProvider` requires one; the only source is `classify()`, which returns
`null` for every `NODE_ENV` outside the allowlist. Deleting the null check is a
compile error, and the `owned` basis is built *inside* `fixtureProvider`, so in a
hosted process it is never constructed at all.

**The rights basis carries a category and an opaque reference, nothing more.**
The project owner has settled licensing with the providers and is contractually
barred from putting the agreements into this repository. Nothing parses, decodes
or branches on the reference's content — the whole surface is a length check and
one shape regex, and candidate construction fails closed. **Please do not ask for
the agreement terms and do not propose a design that requires them in-repo.**

**The `e2e` gate is real and was earned.** Playwright ran in both modes across
four browsers: production 78 passed / 0 failed, development 87 / 0 / 0. Both
`notFound()` assertions passed, which is the first observed confirmation that a
dead address answers 404 rather than 200 with a skeleton.

**What to attack.** The shape rule cannot detect a *meaningful* token —
`acme-tv-2026-emea` passes the regex. I think that is unavoidable for a syntactic
check and belongs to the rights review rather than to code, but a structural way
to make a meaningful reference unrepresentable would be worth more. Also: a
hosted box running `next dev` with `NODE_ENV=development` still mints a witness. I
could not close that with a type and do not believe it is closable by one. Tell
me if you disagree.

### 4. PL-0705 — search loses text typed before hydration

`apps/web/src/components/search/**`. Adoption happens at the hydration boundary
only, compares **raw** text rather than normalised, and is treated as text rather
than a pending submit. `useLayoutEffect` rather than `useEffect`, established by
reading the installed React 19 build: `initInput` skips assigning `element.value`
while hydrating and `updateInput` assigns on every later commit, so the typed
text survives the hydration commit and dies at the next one.

**Worth knowing, because it is the kind of thing a reviewer should be told
without being asked.** The e2e proof failed on its first execution, on all four
browsers. The cause was the test's own instrument — `page.unroute` disposes
routes without draining handlers still parked on the bundle gate. But the more
useful finding was that `toHaveValue` had been passing everywhere and proving
nothing: an *unhydrated* field also still holds what was typed into it, so that
assertion would have passed against a page where React never arrived. The
assertions are reordered so the address bar, the only signal here that cannot
change without hydration, is checked first.

**What to attack.** Adoption writes only the value and appends no commit, so I
claim the epoch invariants — in particular "a re-issued navigation can never
adopt" — are untouched. Two reviewers have now derived that independently and
agreed. A third derivation would still be worth having, because that invariant is
load-bearing for the whole search surface.

### 5. PL-0104 — make catalog and search results navigable

Reconciled, not started ordinarily — see PL-AI-0004 above for the derivation and
why it matters. The implementation predates the claim; what landed this round is
the `apps/web/src/lib/routes.test.ts` the task's own `allowedPaths` named and
that had never existed. It covers the `unrouted` branch as carefully as the
`routable` one, which is the point of the union.

### Standing constraints, unchanged

- **No `integration` gate is recordable anywhere.** There is no PostgreSQL in
  this environment. That permanently blocks PL-0501, PL-0402, PL-0404, PL-0302
  and PL-0602 from DONE regardless of review.
- **No recorded gate on any `apps/web` task mounts a component**: vitest runs
  there with `environment: "node"`. Wiring, navigation and real perceivability
  are unverified by any unit gate on every frontend task to date. This is stated
  on every approval rather than left implicit.
- **Reviewer substitution is not available to unblock this queue.**
  `policies.json` sets `allowAutomaticReviewerSubstitution: false`, and your
  controlled-fallback ruling was scoped to routine Coordination work and
  explicitly excluded anything touching the review system, the trust boundary or
  security controls. It was materialised on exactly two task ids, PL-0102 and
  PL-0103, both now DONE. It would fail its own scope test on PL-0703 and
  PL-AI-0004.
- PL-0302 and PL-0602 remain blocked on licensed provider access, which is
  human-only escalation under `control/policies.json`.
