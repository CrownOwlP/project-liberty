# Implementation recovery inventory

> **This is a READ-ONLY planning document. It reserves nothing and decides nothing.**
> `control/tasks.json` remains the only authority for task state, ownership and
> declared surfaces. Nothing here has been published as a declaration, and nothing
> here should be, until the task it describes is prepared for reconciliation and
> its implementation has actually been read. That sequencing is `gpt-architect`'s
> explicit instruction, quoted in `coordination/GPT_TO_CLAUDE.md`: *one omitted
> helper, migration, test, composition root, or external dependency would create
> twelve opportunities for the same provenance mistake.*

## Why this file exists

The board reads 17 of 43. That number is correct and should stay correct — it
measures what has been **claimed and reviewed**. What it does not measure is what
has been **built**, and the two came apart a long time ago.

Sixteen tasks are implemented in the tree with only their control-plane record
lagging. Two more are partially implemented with the gap stated in their own
source. Two are genuinely unstarted. So the next phase is a **historical
implementation recovery and independent-review campaign**, not a build-out, and
this document exists so that distinction is written down somewhere rather than
rediscovered.

It also corrects an arithmetic error. The first report of this finding said
"thirteen" and then listed sixteen ids. The reviewer caught it and asked for the
count to be corrected in the project record *"before it turns into another source
of status drift."* **The number is sixteen.**

## The provenance rule every recovery must satisfy

The rule, in the reviewer's own words:

> Prove the behaviour was absent before the base and present because of the
> implementation; never substitute the creation date of the file that happens to
> contain it today.

PL-0205 was blocked for violating exactly that, in the most plausible possible
way: its probe file existed only for that task, and had nevertheless been *created*
by a later refactor that moved the behaviour into it.

**An introduction-style proof** must establish all five of: the candidate base is
an ancestor of HEAD; the base lacks the behaviour witness; the first
acceptance-relevant implementation commit introduces it; **that commit's parent is
inspected rather than inferred from a filename**; and the current tree still
contains the behaviour. The negative checks assert an exact exit code rather than
merely non-zero — `git grep` answers 128 on an unreadable object, and a check
written as *reject only on 0* would read that as a clean base — and each is paired
with a positive control, without which a misspelt pattern makes every base look
clean.

**A modification-style proof** cannot use marker absence, because there is no
marker: the behaviour changed inside files that already existed. It needs a
**semantic delta** — ideally a regression that fails at the candidate base and
passes after the implementation, otherwise a concrete old-pattern/new-pattern
invariant in the source. `git log -S` and `-G` help *locate* the candidate commit;
they do not discharge the obligation, because the commit diff and its parent still
have to be inspected. Where no mechanically unique witness exists, the task gets a
manual commit-history proof written out in its `--reason` rather than a weaker
automatic probe dressed up as one.

**Where this rule should permanently live is `CLAUDE.md` and `control/README.md`,
and it is not there yet** — deliberately. Neither file is inside any active task's
declared surface, and writing the operating contract from outside every surface is
the same defect this document exists to clean up. It is stated here, in the
coordination space that is sanctioned for exactly this, until a task owns the
doctrine change. See the open questions at the end.

## Progress

**Recovery packet 1 is in review** at `64b631d5`: PL-0601, PL-0401 and PL-0204,
each reconciled on its own independently proven base.

| Task | Witnesses | Introduction | Proven base | Window |
|---|---|---|---|---|
| PL-0601 | `liveChannelSchema`, `epgListingSchema` | `fc1ea4d5` | `33588cdc` | **1 commit, 3 files** |
| PL-0401 | `ENABLED_AUTH_CAPABILITIES`, `WITHHELD_AUTH_PLUGIN_FAMILIES` | `1dd8e73e` | `fc1ea4d5` | 7 commits, 14 files |
| PL-0204 | `planFailover`, `playbackAttemptFailureSchema` | `4091a2b6` | `cf2a4583` | 9 commits, 12 files |

PL-0601's window is the tightest review range this project has produced, and it is
what a narrowed declaration and a true base look like when both are right.

**Two overlaps in those shas are recorded rather than smoothed over.** PL-0401's
base *is* PL-0601's introduction commit — live TV and auth landed back to back, so
the two windows abut exactly. More seriously, **PL-0204's base and introduction are
identical to PL-0207's**: commit `4091a2b6` introduced `planFailover` *and*
`unknownMediaFacts`, so one commit carried work belonging to two tasks and
PL-0204's window necessarily contains PL-0207's already-approved work. Nothing in
the mechanism can separate them — the base is where the behaviour began and the
upper bound is HEAD — and narrowing PL-0204's declaration to make the overlap
disappear would be reservation inflation in reverse. It is a historical discipline
failure from before any of this was enforced.

**The probe now self-tests before it is trusted, and that was learned the hard
way.** A first attempt at this packet reported all three bases as unprovable and
looked exactly like correct fail-closed behaviour. It was not: `git rev-list`
refuses the pickaxe, and inside a `for /f` backquote that refusal was invisible,
so a command that *refused* and a command that legitimately *found nothing* were
indistinguishable. A probe that cannot tell "never introduced" from "I am not
working" is a machine for producing confident-looking silence. The pickaxe now runs
as a redirected command with stderr captured, and the mechanism is first asked one
question whose answer is already known — where `unknownMediaFacts` was introduced,
which PL-0207 established is `4091a2b6`. If that comes back empty, the real proofs
are skipped rather than reported as refusals.

## Classification

### A. Implemented, unreviewed — sixteen

Each needs: the implementation read; every touched file classified as write
surface or review dependency; the declaration narrowed or widened accordingly;
collisions validated; a base **proven** against that final surface; then
claim → reconcile → gate → review.

| Task | Lane | Nature of the provenance proof | Note |
|---|---|---|---|
| PL-0204 | Media | introduction | Follows PL-0207 through the media lane, per the reviewer. `performance` gate cannot come from `npm run check` — the wall-clock assertion is deselected by name unless vitest runs `--mode bench`. |
| PL-0301 | Provider | introduction | The fixture provider and the Stremio adapter. |
| PL-0303 | Provider | introduction | Gate results are **already recorded as pass**. DONE in everything but status. |
| PL-0401 | Backend | introduction | See the open question below before claiming. |
| PL-0402 | Backend | introduction | Head of the backend chain; PL-0403 and PL-0404 follow it. |
| PL-0403 | Backend | introduction | `integration` gate is unsatisfiable — no PostgreSQL exists here. |
| PL-0404 | Backend | introduction | Same `integration` constraint. |
| PL-0501 | Playback | introduction | |
| PL-0502 | Playback | introduction | Declares `packages/contracts/**` and deliberately writes none of it. |
| PL-0503 | Playback | introduction | |
| PL-0504 | Playback | introduction | |
| PL-0601 | Live | introduction | Record already corrected; not yet claimed. |
| PL-0702 | Security | **modification** | No file exists only for it. Needs a semantic delta or a manual history proof — a phrase in `docs/SECURITY.md` proves when prose appeared, not when the security property became true. |
| PL-0801 | Recommendations | introduction | Declares `packages/**`, `apps/web/src/**`, `docs/**`; wrote only `packages/recommendations/**`. |
| PL-AI-0003 | Coordination | introduction | |
| PL-AI-0006 | Architecture | introduction | Genuinely package-wide; its wildcard may be correct. Sequence last — it prefix-contains most of the contracts work. |

### B. Partially implemented — two

| Task | What is done | What is not |
|---|---|---|
| PL-0701 | The harness, seven specs, the CI jobs | The critical journey does not reach a progress write, and says so in its own spec. CI records the suite as deliberately partly red. |
| PL-0704 | Home and watch relocated their skeletons below the existence decision; the root `loading.tsx` is gone | The title route **deleted** its skeleton, which its acceptance forbids — but the deletion argument is sound, so this is a **contract gap to ratify, not a code gap to repair**, and it is proposed in the task record and left for a ruling rather than rewritten unasked. The production-mode 404 for an unknown title is unprovable until a catalog source exists in a deployment, which is **PL-0305's** to supply. Also needs `--reconcile-existing`: its code landed while it sat unowned. **Mostly a modification task** — its central act was a deletion, which marker absence cannot witness. The witnesses are the two names it introduced where anonymous route-level skeletons used to be: `CatalogSkeleton` and `PlaybackLoading`. Record corrected this round: the dead `app/(home)/**` declaration dropped, `docs/E2E.md` and `.github/workflows/ci.yml` added. |

### C. Genuinely unstarted — two

- **PL-0206** — macrolanguage/extlang equivalence. Its absence is stated in
  `packages/media-engine/src/audio.ts`'s own comment.
- **PL-0305** — a real catalog metadata source. Now READY, since PL-0105 is DONE.
  It is the precondition PL-0704's production-mode 404 waits on.

## Proposed review packets

Three to four tasks each, grouped so shared history and shared files can be read
once. **Proposed only** — no packet is a promise, and a task leaves its packet
rather than bending a dependency to stay in it.

1. **Recovery packet 1 — three lanes, disjoint surfaces.** PL-0601 (Live),
   PL-0401 (Backend), PL-0204 (Media, after PL-0207 completes). Three different
   agents, no shared files, all independently ready.
2. **Backend chain.** PL-0402 → PL-0403 → PL-0404, in dependency order. They share
   `packages/persistence/**` and must serialise anyway.
3. **Playback family.** PL-0501 → PL-0504.
4. **Provider.** PL-0301 and PL-0303 together; PL-0303 needs little more than its
   status moved.
5. **Control, test and architecture.** PL-AI-0003, PL-0702, PL-0701, and
   PL-AI-0006 last, because it prefix-contains most of the contracts surface.

## Open questions, carried rather than answered

- **PL-0401 and the migration.** Its narrative cites
  `packages/persistence/migrations/0000_profile_scoped_identity.sql` as the basis
  for the database-backed-session clause, while that file is not in its surface.
  The reviewer will accept either resolution but not the mixture: add the
  migration as a **reviewDependency**, or stop using it as evidence and let the
  Drizzle adapter and configuration carry the clause alone. **Resolved as: added
  as a reviewDependency**, because the ADR genuinely rests on it.
- **`.github/workflows/ci.yml` was declared by no task at all**, so every CI change
  this project has made landed outside every declared surface. PL-0704 adopts it
  this round, which is a partial fix at best: the file is repository governance
  rather than frontend, and it belongs with whatever task eventually adopts
  `CLAUDE.md` and `control/README.md`.
- **`docs/E2E.md` and `ci.yml` contradict each other** about whether the two 404
  assertions have ever been observed passing. One of them is stale. PL-0704 owns
  settling it.
- **The operating contract has no owner either.** `CLAUDE.md` and
  `control/README.md` are where the provenance rule above belongs permanently, and
  both sit outside every active task's declared surface. The last task that
  declared `CLAUDE.md` was PL-AI-0001, which is DONE. So the documents that define
  how this repository declares ownership are themselves undeclared. That is a
  small, tidy irony and also a real gap: a doctrine change made from outside every
  surface is unreserved against a parallel writer and outside every approval
  fingerprint, which is precisely the argument PL-0105 was created to answer for
  the catalog port. It needs a task — probably the same one that adopts
  `.github/workflows/ci.yml`, since both are repository-governance files rather
  than product files.
