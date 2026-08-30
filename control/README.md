# AI Engineering Control Plane

This directory is the machine-readable operating system for the engineering team. It is intentionally model-agnostic and can be copied into future repositories.

## Source of truth

- `project.json` - project identity and operating principles.
- `tasks.json` - dependency graph, ownership, status, allowed write paths, reviewers, and quality gates.
- `agents.json` - available agent roles and capabilities.
- `quality-gates.json` - named validation gates.
- `policies.json` - status machine, completion rules, parallelism, and escalation policy.
- `adapters.json` - how local Claude, OpenAI/shared-repo workflows, and human approvals connect.
- `events.jsonl` - append-only audit trail.
- `queues/` - generated per-agent queues; do not treat these as source of truth.

## Commands

Run from repository root:

```bash
npm run ai:validate
npm run ai:status
npm run ai:ready
npm run ai:dispatch
npm run ai:dispatch -- --apply
npm run ai:queue -- claude-media
npm run ai:claim -- PL-0201 claude-media
npm run ai:start -- PL-0201 claude-media
npm run ai:start -- PL-0201 claude-media --reconcile-existing --base <sha> --reason "..."
npm run ai:review -- PL-0201 claude-media
npm run ai:gate -- PL-0201 unit pass "vitest green"
npm run ai:gate -- PL-0201 unit pass --agent claude-media "vitest green"
npm run ai:done -- PL-0201
npm run ai:block -- PL-0302 "Awaiting licensed provider credentials"
npm run ai:release -- PL-0201 claude-media
npm run ai:sync
```

`ai:dispatch` recommends a conflict-free wave. `--apply` claims the recommended tasks but does not invoke external models by itself.

## Gate results

A gate result is evidence about work performed against a task, so the control
plane only accepts one while the task is `IN_PROGRESS` or `REVIEW` and has an
owner. `READY`, `BACKLOG`, `CLAIMED`, `BLOCKED`, `DONE` and `CANCELED` are all
refused.

- `IN_PROGRESS` is the normal case: claim, start, then record.
- `REVIEW` is permitted because a reviewer re-runs checks, and because the
  deterministic completion path (`scripts/cloud/advance-completable.mjs`) records
  every gate for an approved task that is still in `REVIEW`.
- `CLAIMED` is refused: a claim reserves a task, it does not open it. `ai:dispatch
  --apply` claims whole waves at once, and a claimed-but-unstarted task has no
  `implementationBaseSha` to bind evidence to.
- `DONE` is refused: gate results are the completion evidence, and editing them
  afterwards would leave no transition in `events.jsonl` to notice.

Each result records `by` (the owner the control plane granted) and the `commitSha`
it was recorded at. `commitSha` is provenance, not yet an enforced staleness
check.

## The review base, and reconciling one that predates the claim

`start` records `implementationBaseSha`: the commit implementation began from.
It is **not descriptive metadata**. `expectedReviewBase()` uses it as the exact
lower bound of the first review range, and `validateReviewRange()` refuses a base
that is either wider or narrower than it — a narrower one hides corrective work
from the reviewer, a wider one is reviewed and then rejected by the control plane,
stranding the task after the model has already run.

That makes one situation genuinely dangerous: an implementation written and pushed
**before** the task was claimed. Letting an ordinary `start` capture HEAD there
writes a field that is *false* — it opens the first review after the code it was
meant to cover. Putting the real range in gate evidence instead does not repair
it; it creates two competing truths and leaves the machine-readable one broken,
and every automated consumer reads the field, not the prose.

```bash
npm run ai:start -- PL-0201 claude-media \
  --reconcile-existing \
  --base 8a6dec901569c1b2ada8e1b5da351e370125cb81 \
  --reason "git log --oneline packages/media shows the implementation begins at 4f21ac9; 8a6dec9 is its parent" \
  --implementation-agent claude-media
```

### When it is legitimate

Exactly one case: **the implementation already exists in pushed commits that
predate the claim**, and the task is being moved through its lifecycle honestly
afterwards. Typical shape: preflight work committed before the control plane had
a task open for it.

### When it is not

- To make a review range smaller because the diff is inconvenient. Narrowing
  hides work from the first review, and that is the failure this exists to
  prevent, not to enable.
- To make it *wider* than the truth either. The two are not symmetric in harm — a
  wider range only ever shows a reviewer more — but they are symmetric in
  honesty, and this field is not "a range that is safe to review". It is where
  implementation began. A padded base is a false structural fact that reads as a
  true one, and the control plane once actively advised producing them; see the
  removed heuristic below.
- On work that is not committed yet. That is an ordinary `start`, and it is now
  enforced rather than merely asked for: uncommitted changes under the task's
  `allowedPaths` refuse the operation.
- To revise a base that already exists, or to re-open a task in `REVIEW`. Both
  are refused.
- As a routine alternative to `start`. If HEAD really is where the work begins,
  `--base` is a lie with extra steps.

### What is enforced

All three of `--reconcile-existing`, `--base` and `--reason` are required
together, and each is **refused outright** on an ordinary `start` rather than
ignored — an accepted-and-ignored `--base` would produce exactly the false field
the mechanism exists to prevent. The supplied base is then verified, not trusted:

A value flag that is present but empty — `--base` with its sha lost to quoting
or an empty variable — is refused too, on both paths. Returning "absent" for it
would resurrect the accepted-and-ignored `--base` in the one case where the
operator most believes they supplied one.

| check | why |
| --- | --- |
| full 40-hex sha | `HEAD~3` resolves differently later; the field is read months on |
| git present, HEAD resolves | fail closed — "cannot check" must not read as "checked" |
| commit exists, ≠ HEAD, ancestor of HEAD | a range that is real and non-empty |
| **no uncommitted changes under `allowedPaths`** | reconciliation asserts the implementation is already in pushed commits; a dirty tree contradicts that on its face, and on a wide surface the check below is satisfied by other lanes' commits |
| something under the reviewed surface changed in `base..HEAD` | a base at or after the implementation is the central falsehood |
| the window (`git log`) is computable | fail closed; a window that could not be listed must not be published as an empty one |
| what the base commit itself changed under the reviewed surface is computable | same reason. This one is **published, not judged** — see below |
| task is `CLAIMED`, with no base, no review record and no gate results | reconciliation establishes a base once, at the moment a task opens |

Every row is a **mechanical fact**. None of them is an inference about which
commits were this task's work.

### The heuristic that was removed, and why it must not return

There used to be one more row: the base was refused if it *itself* modified files
that the window goes on to change, on the theory that "a commit editing the same
files as the window that follows it is inside an implementation, not before one".
The error advised naming an earlier commit, with `<sha>^` as the usual answer. It
was scoped first to the reviewed surface, then narrowed to `allowedPaths` after it
refused every candidate base for tasks with churning `reviewDependencies`. It was
then removed entirely on review, and the removal is the point rather than the
scoping.

Two reasons, and the first is the one that generalises:

- **Its remedy corrupted the field it writes.** The refusal could only ever be
  satisfied by walking backwards until the overlap stopped, so what it produced
  was not "the commit this implementation began from" but *an earlier commit that
  passed a file test*. `implementationBaseSha` is the exact lower bound of the
  first review range and means exactly one thing; a deliberately widened base
  validates, publishes, and reads to every later consumer as a structural fact it
  is not. A tool whose advice makes its own field false is worse than no tool.
- **The inference was never sound.** Git does not attribute commits to tasks. The
  same overlap is equally the signature of two lanes co-tenanted in a directory, a
  revert, a formatting pass, a dependency bump, or a rebase. Narrowing the paths
  it consulted made it wrong less often; it did not turn a guess about intent into
  a fact.

The computation stays; its verdict is gone. The base commit's own surface touches
are published as `baseCommitSurfaceTouches`, and the reviewer — who can read a
commit message, ask the implementer, and knows what the task was — judges what
they mean. Nothing on this path now advises a wider base, and a refusal that
reintroduced that advice would reintroduce the defect.

The evidence is measured on the **reviewed surface**, like every other published
field, so the record does not describe two surfaces at once. It is deliberately
*not* published pre-intersected with the changed files: an "overlapping files"
field would be the removed verdict wearing a data costume, and the next reader
would restore the refusal from it.

Three mechanical details that a reviewer should know are pinned rather than left
to configuration:

- a **merge** commit as base is compared against *every* parent, not just the
  first. A merge that resolved the reviewed files toward the mainline is TREESAME
  to its first parent while differing from its second, so first-parent inspection
  reported a conflict resolution inside an implementation stream as having touched
  nothing. Under-reporting here is not a missing answer, it is the *reassuring*
  answer.
- a base with **no parent** (the repository's root commit) is an ordinary,
  acceptable base. It is also the case the removed heuristic could never accept:
  its only remedy was "go back further", and there was no further to go.
- the published window uses `git log --full-history`, because history
  simplification prunes commits that really touched the surface and would
  understate `oldestSurfaceCommit` — the one field the reviewer is sent to
  interrogate. Both diff helpers pin `--no-renames`: their counts are published
  and re-derived by `validate`, and porcelain/plumbing disagree about renames by
  default, so an honest record written on one machine would otherwise draw a
  mismatch warning on another.

`LIBERTY_COMMIT_SHA` is deliberately **not** consulted anywhere on this path —
including by the dirty-tree check, which calls the raw helper rather than the
env-aware one. The whole value of the operation is that the claim is checkable
against real history.

**What cannot be proven, stated plainly:** git does not attribute commits to
tasks. No check here can prove a supplied base is *the* commit immediately before
this task's implementation, because nothing records which commits were this
task's. So the operation also *publishes* what it verified — the commit window,
both of its endpoints, the changed-file count, the files the base commit itself
changed under the reviewed surface, and the operator's `--reason` — into
`events.jsonl` and onto the task, so a reviewer can interrogate the remaining
question ("is there an earlier commit that also belongs to this implementation?")
instead of taking it on trust. The published window is capped at 20 commits and is
kept from the **oldest** end, with `surfaceCommitsTruncated` saying so, because
the newest end is not what that question is about; the touch list is capped the
same way, with its own truncation flag, since file order carries no end worth
preferring.

### A stronger machine-checkable contract, not implemented

The reviewer who removed the overlap heuristic named the shape a defensible
successor would have: an optional explicit `--first-implementation <sha>` — the
operator states which commit *is* the first commit of this implementation — plus a
check that the asserted base is its appropriate predecessor. That moves the
unprovable fact from an inference to a declaration, which is the right direction:
the operator asserts it, the audit trail records it, and the control plane checks
only the relationship between two stated commits.

It is deliberately **not implemented**, and the caveat the reviewer attached is
the reason to be careful rather than quick: *merge semantics*. "Predecessor" is
not single-valued once merges are involved — a first-implementation commit may
have two parents, only one of which is on the line the review should open at, and
picking the first parent by default reintroduces exactly the class of silent
first-parent error this file already documents twice. Anyone implementing it
should settle what "appropriate predecessor" means across a merge *before* writing
the check, not after.

### What a reader sees

- `events.jsonl` records **`task.started_reconciled`**, never `task.started`, so a
  reader scanning for the ordinary type cannot mistake one for the other by
  overlooking a field. The record carries the base, the head it was reconciled
  against, the window, the reason, and a note saying this was reconciliation of a
  pre-existing pushed implementation and not a new implementation start.
- The task gains `implementationBaseProvenance` beside `implementationBaseSha`.
  Absence of that record is what marks a base as *captured*; presence marks it as
  *asserted*.
- `review-status` reports both, emitting the provenance record whole rather than
  summarised, so `baseCommitSurfaceTouches` reaches the reviewer with everything
  else.
- `handoff --base auto` tells the reviewer that the range opens before the claim,
  why, and what the base commit itself changed under the reviewed surface —
  stated where the range is announced rather than left in a field the reviewer
  would have to know to go and read. It is labelled as evidence for their
  judgement, not as a control-plane finding.
- `start` prints the same evidence at the moment the operator can still act on
  it, as a report rather than a warning: a base that touches the surface is
  entirely ordinary when the previous commit belonged to another lane.

### How far the provenance record can be trusted

Nothing in a local CLI can prevent a hand-edit of `control/tasks.json`. The goal
is therefore **detectability, not impossibility**, and the honest statement of
where the line falls is:

`validate` checks the record three ways.

| | |
| --- | --- |
| shape | every field the CLI writes, typed and cross-consistent: `kind`, a `baseSha` matching the field it explains, `headAtReconciliation` (a different commit), a non-empty `reason`, an ISO `reconciledAt`, known agent ids in `reconciledBy` and `implementationAgent`, a legal `reviewSurface` label, integer counts, a published window whose endpoints really are its endpoints and whose truncation flag matches its length, and a `baseCommitSurfaceTouches` list whose count and truncation flag agree with it |
| history | the base is an ancestor of the head it names, and both published endpoints lie inside that window. Errors, because these are facts no later legitimate edit changes |
| corroboration | `events.jsonl` must carry the `task.started_reconciled` event this record implies. Append-only and separately written, so a forgery needs two consistent edits in two files |

Re-derived **counts** (`surfaceCommitCount`, `changedFileCount`,
`baseCommitSurfaceTouchCount`) are reported as warnings, not errors:
`allowedPaths` and `reviewDependencies` may legitimately be redeclared
afterwards, and a recomputation over the new surface then disagrees with a record
that was honest when written. Making that an error would strand a correct task.
Likewise a shallow clone that cannot resolve the window warns rather than fails —
a checkout depth is not evidence of anything.

The evidence field is worth forging in one specific direction — **emptying it**,
so a base reads as untouched by the surface it precedes — and that is exactly what
the re-derivation contradicts whenever the declared surface has not moved. A
warning is the strongest verdict that is honestly available. An *absent*
`baseCommitSurfaceTouches` also warns rather than errors: a record written before
the field existed is old, not fabricated.

**What is still open.** A forger who supplies a real base, a real head that the
base is an ancestor of, a coherent window, and a matching line in `events.jsonl`
passes all of it. That is not a gap that can be closed here, because the
underlying fact — which commits were *this task's* work — is not recorded
anywhere. What has changed is that the cheap forgery (a five-line marker pasted
onto a HEAD-captured base, which used to pass) no longer does, and every
remaining one leaves an inconsistency somewhere a reviewer can look.

`--implementation-agent` exists because the subagent that produced pre-existing
code is not necessarily the one claiming now. Like `gate --agent` it is an
assertion, not authentication — nothing in a local CLI can authenticate anything —
but it is explicit and audited rather than a silent side effect of who claimed.
It can only **add** an implementation-side identity: the self-approval rule
compares a reviewer against the set `{implementationAgent, owner}`, so asserting a
third party never removes the owner from that comparison. It did once, and the
result was an incentive pointing exactly the wrong way — on a task with no
designated `reviewAgent`, declaring an implementer honestly was what let the
owner approve their own work, while saying nothing left them correctly blocked.
Naming the task's own `reviewAgent` is still refused, because it would make the
task permanently unapprovable under that rule.

`release` and `unblock` discard gate results but deliberately keep the base and
its provenance: the implementation they point at survives the round that was
abandoned, and the next `start` reuses it rather than recapturing HEAD.

## Path declarations, and why the root is refused

Two path surfaces exist and are deliberately not one:

| surface | field | decides |
| --- | --- | --- |
| write / collision / staging | `allowedPaths` | what an implementer may edit |
| reviewed / fingerprinted | `allowedPaths` + `reviewDependencies` | what an approval binds to |

`reviewDependencies` is read-only. It reserves nothing, so two tasks with
disjoint `allowedPaths` and the same declared dependency stay concurrently
claimable — the bottleneck the field exists to remove.

Both fields are reduced to their longest literal prefix, and an entry that
reduces to the repository root is an **error**, not a warning. `"**"`, `"*"`,
`"/"` and `"/**"` reduce to the empty string and used to be dropped; `"."` and
`"./"` reduce to `"."` and used to be hashed as the whole tree while every path
still classified as outside the review surface. Either way the declaration and
the enforced surface disagreed, and the operator was told only that the entry
"protects nothing".

The rule is: **a declared path may never make the enforced surface narrower than
what was declared.** A declaration that cannot be turned into a usable prefix is
refused rather than dropped. `validate` reports it against the field, and
`scripts/review-surface.mjs` throws at the point of use for anything that reached
a fingerprint without being validated first.

Breadth is not the offence. `packages/**` reduces to `packages` and is an
ordinary, legal, wide declaration.

## Ownership assertions

`start`, `review`, `release` and `gate --agent` all take an optional agent id.
None of them authenticate — nothing in a local CLI can. They exist so a caller
that is wrong about who owns a task is refused loudly rather than silently
mutating another agent's lane.

## Returning a task to a queue

`ai:release` and `ai:unblock` null the owner and put the task back in
`READY`/`BACKLOG`. Both discard `gateResults`, because evidence is bound to one
implementation round under one owner; leaving it behind would let the next
claimant inherit passes for work that no longer exists. `ai:done` also nulls the
owner but keeps the results — there they are the completion record.

## Reuse in a new project

From this repository:

```bash
node scripts/bootstrap-ai-project.mjs --target ../new-project --name "New Project" --prefix NP
```

This installs a fresh control-plane skeleton and CLI into another repository. The new project then defines its own tasks, agents, gates, and policies.
