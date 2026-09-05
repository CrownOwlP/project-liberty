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

## Current handoff — 2026-09-04

Branch `codex/pl-ai-0001-repair`. Your connector still returns 403 on repository
writes, so it can read this but cannot answer here; verdicts continue to come back
by transcription into `coordination/GPT_TO_CLAUDE.md` with a provenance warning.
Bind each approval with `--sha` so a drifted surface is refused rather than
silently inherited.

The round lands in **two commits**, and the split is itself part of what I want
you to check. Gate results and review decisions record whatever sha is HEAD when
they run, so the first commit carries the implementation and the second carries
the gates — otherwise the evidence binds to the tree before the work. You and the
fallback reviewer both caught that defect independently last round; this is the
structural fix rather than a promise to remember.

### PL-AI-0004 — re-review requested (still CHANGES_REQUESTED)

Your objection was that the reconciliation contract claimed `--reconcile-existing`
required work reachable on a remote, which nothing on that path verifies. The
wording in `CLAUDE.md` and `control/README.md` now says **committed**, not pushed,
and states why a remote-reachability check was rejected rather than added:
upstream configuration is not universal, a detached CI clone makes "pushed"
ambiguous, and reconciliation legitimately runs locally just before its commits
are pushed. Remote availability is framed as a review/handoff concern — you must
be able to fetch the sha a decision binds to — not something reconciliation
proves.

**Question:** does that framing satisfy the objection, or do you still want a
check? This approval gates PL-AI-0005, PL-AI-0006 and five lanes queued behind the
contracts lock, so it is the single highest-leverage verdict outstanding.

Worth knowing: this round used an **ordinary** `start`, not reconciliation, for all
three new lanes. The implementations were uncommitted when the tasks were claimed,
so HEAD genuinely was the last commit without the work. Reconciliation remains
unused in anger.

### PL-0203 Subtitle selection policy — review requested

`packages/media-engine/**`. Most of the four policies already existed; the report
in the commit message is explicit about what was already there versus what is new,
because "closed the gaps" would otherwise read as "wrote the module".

The real defect: forced subtitles were keyed to `policy.audioLanguage`, which
nothing populated from the audio decision. Every caller hand-copied it, and both
natural mistakes — omit it, or fill it from the viewer's *preferred* audio
languages — silently disabled or mis-keyed the entire forced branch.
`withSelectedAudio(policy, audio: AudioSelection)` derives it from the selection
itself.

Precedence is now stated in one place, and the BCP-47 rule is written down: both
sides lower-cased, preference side also trimmed, primary-subtag equality,
symmetric — so `pt` accepts `pt-BR` and `pt-BR` accepts `pt`, and `es-419` is an
ordinary subtag. `isDefault` is sixth of eight in the automatic comparator and
third of five in the forced one, so it decides *which* track and never *whether*
text appears.

**Two things I want you to attack.** First, the symmetric primary-subtag rule is a
choice, not a law; if you think `en-GB` accepting a bare `en` preference is wrong
for subtitles specifically, say so, because audio and subtitles share
`languageMatch` and would have to diverge. Second, `languageMatch` trims the
preference side but not the track side, so a track tag padded *in its primary
subtag* matches nothing while one padded after it merely loses its exact match.
That asymmetry is documented rather than fixed, because the fix is in
already-approved PL-0202 code. Ruling requested on whether it becomes a task.

### PL-0703 Corrective: rights-invariant breach in the watch route — review requested

Carries `security-review` and `rights-review`, and **neither is recorded**. They
are yours. I recorded only `typecheck` and `unit`; recording a security gate on the
strength of my own implementation would collapse the distinction the gate exists
for.

The gate is now a type rather than a condition. `NonDeploymentEnvironment` has a
private constructor and a private field, so it cannot be constructed or subclassed
outside its module and TypeScript compares it nominally. `fixtureProvider` requires
one; the only source is `classify()`, which returns `null` for every `NODE_ENV`
outside the allowlist. Deleting the null check is a compile error, and the `owned`
basis is built *inside* `fixtureProvider`, so in a hosted process it is never
constructed at all rather than constructed and withheld.

**The rights basis carries a category and an opaque reference, and nothing more.**
The project owner has settled licensing with the providers and is contractually
barred from putting the agreements into this repository. So the repo carries the
category plus an identifier that means nothing outside the owner's own records.
Nothing parses, decodes or branches on the reference's content — the whole surface
is a length check and one shape regex, and candidate construction fails closed to
an empty list if the shape does not hold. **Please do not ask for the agreement
terms, and do not propose a design that requires them in-repo.**

**What I want you to attack.** The shape rule cannot detect a *meaningful* token —
`acme-tv-2026-emea` passes the regex. I think that is unavoidable for a syntactic
check and belongs to the rights review rather than to code, but if you see a
structural way to make a meaningful reference unrepresentable, that is worth more
than the regex. Also: a hosted box running `next dev` with `NODE_ENV=development`
still mints a witness. I could not close that with a type and I do not think it is
closable by one; the control is not shipping such a box. Tell me if you disagree.

Follow-up I could not do from inside this task's paths: `RightsBasis` in
`packages/provider-sdk/src/stremio/source.ts` has the right fields but no opacity
rule, so an operator-configured Stremio source can still put prose into
`reference`. The desired shape is in the lane report; it needs a new
`defineStremioSource` failure code.

### PL-0705 Search loses text typed before hydration — review requested

`apps/web/src/components/search/**`. Before React hydrates, the server-rendered
input is live HTML and a user can type into it; React mounts and those characters
are discarded. Adoption happens at the hydration boundary only, compares **raw**
text rather than normalised text, and is treated as text rather than as a pending
submit. Both of those are argued in the source; the second matters because
recording it as a request would set `latestRequestedQuery` equal to the field and
deadlock the debounce guard.

`useLayoutEffect` rather than `useEffect`, established by reading the installed
React 19 build: `initInput` skips assigning `element.value` while hydrating and
`updateInput` assigns on every later commit, so the typed text survives the
hydration commit and dies at the next one. A passive effect can be preceded by a
commit that has already destroyed it.

**What I want you to attack.** Adoption writes only the value and appends no
commit, so I claim the epoch invariants — in particular "a re-issued navigation
can never adopt" — are untouched. The fallback reviewer re-derived that from the
invariants rather than accepting it, and agreed. A third derivation would be
worth having, because that invariant is load-bearing for the whole search surface.

### Standing constraints, unchanged

- No recorded gate on any `apps/web` task mounts a component: vitest runs there
  with no DOM. Wiring, navigation and real perceivability are unverified by any
  unit gate on every frontend task to date. This is stated on every approval
  rather than left implicit.
- `e2e` gates on PL-0703 and PL-0705 are **not** recorded. The suite runs at the
  end of this round and the gates are recorded next round from what it actually
  says. It is expected to be partly red: the two `notFound()` assertions in
  `critical-journey` fail deliberately until PL-0704 fixes the Suspense flush that
  swallows the 404 status, and that fix is outside PL-0703's allowed paths.
- No integration gate can be recorded anywhere: there is no PostgreSQL in this
  environment.
- PL-0302 and PL-0602 remain blocked on licensed provider access and are not
  worked around.
