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
owner. `READY`, `BACKLOG`, `CLAIMED`, `BLOCKED`, `DONE`, `CANCELED` and
`SUPERSEDED` are all refused.

- `IN_PROGRESS` is the normal case: claim, start, then record.
- `REVIEW` is permitted because a reviewer re-runs checks, and because the
  deterministic completion path (`scripts/cloud/advance-completable.mjs`) records
  every gate for an approved task that is still in `REVIEW`.
- `CLAIMED` is refused: a claim reserves a task, it does not open it. `ai:dispatch
  --apply` claims whole waves at once, and a claimed-but-unstarted task has no
  `implementationBaseSha` to bind evidence to.
- `DONE` is refused: gate results are the completion evidence, and editing them
  afterwards would leave no transition in `events.jsonl` to notice.

Each result records `by` (the agent the control plane holds accountable) and the
`commitSha` it was recorded at. `commitSha` is provenance, not yet an enforced
staleness check.

### Executable gates and judgement gates (PL-AI-0012)

`policies.json → gateAuthority.judgementGates` names the gates that are a
**verdict** rather than an exit code: `architecture-review`, `security-review`,
`rights-review`. The list is configuration rather than a predicate over
`quality-gates.json`, so a gate added later is classified deliberately —
inferring judgement from `command: "agent-review"` would make an authority rule a
side effect of an evidence-format field, and a new gate would default to
self-recordable, which is the wrong default for a safety rule.

Product invariant 7 makes every required gate a precondition of `DONE`. So an
implementer who can record their own judgement gate can complete their own task
without independent review — which `approve` refuses by name. Until PL-AI-0012
`ai:gate` did not, and on 2026-09-23 the owner of PW-0203 recorded a passing
`architecture-review` whose entire evidence was the string
`PLACEHOLDER-NOT-RECORDED`, having run the command expecting a refusal. It was
disclosed and retracted through `release`; **retraction is audit recovery, not
enforcement**, and the incident history is preserved rather than tidied away.

On a judgement gate the command now requires, and refuses **before writing
anything**:

| rule | why |
| --- | --- |
| `--agent` is mandatory | without it the result is attributed to `task.owner`, so an omitted flag is a self-record with nobody having typed a name |
| nobody on the implementation side may record it — neither `owner` nor `implementationAgent` | the same pair `assertReviewAllowed` compares, for the same reason: asserting a third-party implementer must only ever *add* an identity |
| only `reviewAgent`, or an agent in `authorizedIndependentReviewers` | that list is empty, and `review.allowAutomaticReviewerSubstitution` is `false`, so substitution is a human decision |
| the evidence must name the commit it judged | a verdict that cannot say what it looked at is not a verdict. Inside a git checkout the sha must **resolve** to a commit (`rev-parse --verify` also refuses an ambiguous prefix and a non-commit object); outside one the naming rule still applies and the result records `judgementCommitVerified: false` |
| a rejected-substring list and a length floor | second and third nets only. A length floor alone is not a placeholder test, because a long placeholder passes one |
| `--transcribed-by` when the reviewer cannot run the CLI | see below |

A judgement gate is therefore reachable only in `REVIEW`. That is not a separate
rule: the pre-existing ownership check refuses a non-owner during `IN_PROGRESS`,
and this one refuses the owner, so the two together leave one window.

**Transcription is supported, required and recorded.** `gpt-architect` is an
external-reasoning lane with no local execution adapter, and the GitHub write
integration returns 403, so every judgement gate in this repository is physically
typed by another agent on the reviewer's behalf. The honest options were to
forbid that — which would stop the project — or to record it. `--transcribed-by`
records it, and is mandatory whenever the recording agent is not locally
executable. Leaving it implicit is precisely what let a self-recorded gate look
byte-identical to a transcribed one.

Two coupled facts worth knowing before changing any of this:

- `advance-completable.mjs` used to record review-backed gates with no `--agent`,
  so the deterministic completion path was self-recording judgement gates under
  the implementer's name on **every** task it completed. It now records them as
  the reviewer with `--transcribed-by` naming the owner the job acts for. The
  defect was not only reachable by hand.
- populating `authorizedIndependentReviewers` also requires widening the
  ownership check in `ai:gate`, which restricts recording to
  `{owner, reviewAgent}` and answers first. Otherwise the new entry is refused by
  a guard that has never heard of it.

## The review base, and reconciling one that predates the claim

`start` records `implementationBaseSha`: the commit implementation began from.
It is **not descriptive metadata**. `expectedReviewBase()` uses it as the exact
lower bound of the first review range, and `validateReviewRange()` refuses a base
that is either wider or narrower than it — a narrower one hides corrective work
from the reviewer, a wider one is reviewed and then rejected by the control plane,
stranding the task after the model has already run.

That makes one situation genuinely dangerous: an implementation written and
committed **before** the task was claimed. Letting an ordinary `start` capture
HEAD there writes a field that is *false* — it opens the first review after the
code it was meant to cover. Putting the real range in gate evidence instead does not repair
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

Exactly one case: **the implementation already exists in committed Git history
that predates the claim**, and the task is being moved through its lifecycle
honestly afterwards. Typical shape: preflight work committed before the control
plane had a task open for it.

#### "Committed", not "pushed", and why the wording matters

This contract used to say *pushed* commits — in the error text, in the audit
note, in the CLI help and here. It was false in the only way that counts: nothing
on this path contacts a remote. Every check reads the local worktree and the local
commit graph, so a clean branch of three commits that have never left the machine
passes all of them. The mechanism asserted remote reachability and established
local committedness, which is the same class of provenance overclaim this whole
section exists to remove — a machine-readable record that reads as stronger than
what produced it.

The repair was to narrow the claim rather than to widen the check. Adding a
remote-reachability test was considered and **rejected**: upstream configuration
is not universal, a detached CI clone makes "pushed" ambiguous to define, and
reconciliation legitimately happens locally in the moments *before* the resulting
commits are pushed — so the check would refuse correct work while still not
proving what the sentence claimed. The invariant that actually matters here is
that the asserted review range contains committed history rather than
working-tree material, and that is exactly what is enforced.

Remote availability is a real requirement, but it belongs one step later: a review
decision binds to a commit sha, and the reviewer has to be able to fetch that sha.
That is the natural point at which "is this commit actually shared?" is both
meaningful and answerable, and it is not this one. Do not restore the "pushed"
wording here without a check that earns it.

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
| **no uncommitted changes under `allowedPaths`** | reconciliation asserts the implementation is already in committed Git history; a dirty tree contradicts that on its face, and on a wide surface the check below is satisfied by other lanes' commits. This proves committedness only — no remote is consulted |
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
  pre-existing implementation already in committed Git history, not a new
  implementation start, and verified against local committed history only with no
  remote consulted.
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

`release` and `unblock` discard gate results, and keep the base and its
provenance **exactly while the implementation they point at survives with them** —
see [Returning a task to a queue](#returning-a-task-to-a-queue). A reconciled base
always does: `assertReconcilableBase` refuses one that changes nothing under the
reviewed surface, so it is never the base that gets dropped, and
`implementationBaseProvenance.implementationAgent` therefore stays legitimately
different from `implementationAgent` after a re-claim. The record describes the
moment the base was established, not who owns the task now.

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

## Supersession, and a dependency nothing can satisfy

A corrective re-run **supersedes** its predecessor, and the predecessor's
provenance record is preserved as audit history rather than repaired, on the rule
PL-0703 established. Such a task can never reach `DONE`, and with
`completion.requireAllDependenciesDone`, every task depending on one is gated
forever.

That is not a hypothetical. `PL-0301` sat dependency-gated behind `PL-0205` —
BLOCKED, terminal, superseded by `PL-0207`, which was already `DONE` — and
through `PL-0301` it held `PL-0302`, `PL-0501`, `PL-0502`, `PL-0701` and
`PL-0702`: the entire M4 playback vertical slice. `validate` reported the graph
as valid the whole time, because the supersession existed only as prose inside
`blockedReason` and `notes`, which no check reads. A human noticed.

So supersession is a field:

```json
{ "id": "PL-0205", "status": "BLOCKED", "supersededBy": "PL-0207" }
{ "id": "PL-0207", "status": "DONE",    "supersedes": "PL-0205" }
```

`validate` then enforces:

- `supersededBy` must name an existing task, must not name itself, and must not
  appear on a task that is `DONE` — a completed task and its replacement are two
  records of the same work.
- If the successor declares `supersedes`, it must name the predecessor. A
  one-way pointer is a typo waiting to be trusted.
- A task depending on a superseded task is an **error** once the successor is
  `DONE`, and a **warning** while it is not. The distinction is deliberate:
  `validate` treats provenance drift as a warning and structural impossibility as
  an error, and an unsatisfiable dependency is structural — no legal sequence of
  transitions resolves it — so it belongs beside "missing dependency", not beside
  drift. While the successor is unfinished the same edge is only a *future*
  deadlock, and a warning that arrives before the stall is the entire point.

**The rule reports and never repairs.** Repointing a dependency is a task
*definition* change: deliberate, reasoned, and recorded as an event — see
`PL-0301`'s notes for what that looks like in practice. An automatic repointer
would make the task graph self-modifying on the strength of a field any writer
can set, which is a larger failure than the one it fixes.

**What it cannot do.** `supersededBy` is self-asserted, exactly like `fromAgent`
on the agent bus. It proves that somebody wrote a pointer, not that the successor
carries the predecessor's work. A wrong pointer produces a wrong error, or hides
a real deadlock. It is a cheap alarm on a failure mode that has already cost this
project a stalled milestone — not a proof of anything.


### `SUPERSEDED` — the terminal state that is true (PL-AI-0011)

For a long time a superseded original had two terminal options and both were
lies.

- `DONE` it cannot reach and has not earned: the range it was reviewed against
  was false, which is why it was superseded in the first place.
- `CANCELED` is documented in `scripts/ai-control-plane.mjs` as meaning **"there
  is no work to evidence"**, and for these tasks the work exists, was reviewed
  and shipped. Taking it would erase a real implementation from the record in
  order to tidy a queue. There is also no `cancel` command, so reaching it at all
  meant hand-editing `control/tasks.json` — the one move the operating contract
  forbids.

So they sat `BLOCKED` forever and `validate` had to keep explaining why. There is
now a third terminal status and a command to reach it:

```bash
node scripts/ai-control-plane.mjs supersede <taskId> \
  --by <successorId> --reason "why that task carries this work"
```

`SUPERSEDED` means: **the work exists, it was reviewed, and it shipped under the
named successor.** Everything about how it behaves follows from that sentence,
and each rule is a way it could have shipped as an audit fiction instead.

- **The successor is required**, and `validate` errors on a `SUPERSEDED` task
  without one. Which task carries the work now is the entire content of the
  claim; a null successor would be a status that says nothing.
- **The successor must already be `DONE`**, checked in the command *and* in
  `validate`, because the command is not the only writer. Retiring an original
  while its replacement is still in flight would leave the work with no completed
  record anywhere if that replacement were later released or blocked.
- **It is reachable only from `BACKLOG`, `READY` and `BLOCKED`** —
  `policies.supersession.reachableFrom`. An active task must be released first,
  deliberately, so that abandoning it is its own recorded event. Otherwise an
  agent in `REVIEW` could declare supersession and leave without a verdict.
- **It does not satisfy a dependency.** `requireAllDependenciesDone` still means
  `DONE`. Making the new status satisfy it was the tempting shortcut and was
  rejected: a dependent of a superseded task is almost certainly meant to depend
  on the **successor**, and silently satisfying the old edge would let that
  dependent complete having never pointed at the work it actually needs. The
  error above still fires and still says to repoint.
- **It counts as neither completed nor outstanding.** It leaves *both* halves of
  the completion ratio, like `CANCELED`. Counting it in the numerator would
  report one body of work twice, since the successor is already there; counting
  it in the denominator alone would make the project permanently incomplete as a
  punishment for recording its own history honestly. It appears in the status
  summary under its own heading, so it is visible rather than merely absent.
- **The back-pointer is written by the command**, not left to a second step: a
  one-way pointer is the state `validate` already distrusts.
- **The audit event `task.superseded` carries both ids, the reason and the status
  the task came from.**

What it still cannot do is unchanged and is stated below: the pointer is
self-asserted. `SUPERSEDED` proves that somebody recorded a supersession and that
the successor is finished. It does not prove the successor carries the
predecessor's work — that is a judgement a reviewer makes by reading both
acceptances, and the four current instances were audited that way in round 73
before this mechanism existed.

**One loose end, stated rather than hidden.** Every other command has an
`npm run ai:*` alias in `package.json`. This one does not, because `package.json`
is outside PL-AI-0011's declared `allowedPaths` and widening a write surface to
add a convenience alias is the kind of quiet scope creep this control plane
exists to prevent. Invoke it directly, or add the alias in a task that owns that
file.

## Returning a task to a queue

`ai:release` and `ai:unblock` null the owner and put the task back in
`READY`/`BACKLOG`. Both discard `gateResults`, because evidence is bound to one
implementation round under one owner; leaving it behind would let the next
claimant inherit passes for work that no longer exists. `ai:done` also nulls the
owner but keeps the results — there they are the completion record.

### The base is reconsidered, not automatically kept or automatically dropped

`implementationBaseSha` is evidence of where a round *began*, so the same question
applies to it — but the answer is not the same in both directions, because the two
ways of being wrong are not symmetric.

PL-0710 is the case that forced this. It was started at `33195d5`, released with
**nothing written** when its implementing agent was terminated, and re-claimed at
HEAD `20edec3` — and `start` reported *"started from 33195d5"*, because the base
had survived and `start` only ever fills an empty field. The second round's
published review window was a commit wider than the work it covered, with nothing
recording that it had been widened. That is an unreconciled reconciliation:
`start --reconcile-existing` exists precisely because declaring a base for
pre-existing work requires a published window, a changed-file count and a written
reason, and preservation reached the same end state with none of them.

Always clearing is not the repair. A release **mid-implementation**, with work
genuinely committed, would hand the next round a base at the new HEAD — a first
review range that begins *after* committed code and never shows it to a reviewer.
A wide base is visible and can be interrogated; a narrow one cannot, and narrow is
the direction that lets unreviewed work reach `DONE`.

So the base is kept exactly while `base..HEAD` still changes something under the
task's **reviewed** surface — the same predicate `assertReconcilableBase` uses to
decide whether a claimed base has any implementation behind it:

| `base..HEAD` under the reviewed surface | what happens |
| --- | --- |
| changes one or more files | base and provenance kept; the release event publishes the count that justified keeping them |
| changes nothing | base **and** its provenance dropped; the next `start` records the head that round actually begins from |
| cannot be determined | base kept, and the event and the console line name the reason |

`implementationBaseProvenance` always travels **with** the base. It explains one
value of `implementationBaseSha`; left behind it would explain nothing, and
`validate` already errors on a record with no base to describe.
`implementationAgent` deliberately does **not** travel with it: `claim` re-sets it
unconditionally, so clearing it here would only open a window in which an
unowned task records no implementer at all.

**"Cannot check" never reads as "checked."** If git is absent, HEAD will not
resolve, the base is not in this checkout, or the diff fails, the base is kept and
`task.released` / `task.unblocked` carry `baseDecisionReason` (`no-git`,
`no-head`, `base-not-in-checkout`, `diff-failed`, `no-review-surface`) alongside
`clearedBaseSha`, `preservedBaseSha` and
`preservedBaseSurfaceChangedFileCount`. The decision reads the real commit graph
rather than `LIBERTY_COMMIT_SHA`, for the same reason reconciliation does: an
environment variable that can redefine HEAD is an environment variable that can
discard a published provenance field.

None of this reaches `start`. An ordinary re-start still only ever fills an
**empty** `implementationBaseSha`, so a task pulled back out of `REVIEW` by
`request-changes` keeps the lower bound its reviewer was given. The base is
reconsidered at the point ownership *ends*, never at the point it resumes — that
separation is what keeps this from becoming the falsification
`--reconcile-existing` exists to prevent. One consequence is deliberate: a task
whose base was dropped has no base, so the round that follows may legitimately
reconcile one, under every check that path already applies.

## The agent instruction surface

`AGENTS.md` and `CLAUDE.md` are read as instruction, not as documentation. That
makes every one of them in the working tree part of the control plane's input,
and it makes *anything that can write one* a way to address the agents. Framework
tooling can: `next dev` calls
`node_modules/next/dist/server/lib/generate-agent-files.js`, which creates or
upserts `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` whenever it detects an AI
coding agent. Nothing malicious happened here — the block Next.js writes is
version guidance — but a dependency's tooling reaching the instruction surface is
a supply-chain path onto the control plane, and "we read it once and it looked
fine" is not a control.

So the surface is enumerated. `scripts/validate-repo.mjs` holds
`INSTRUCTION_FILE_ALLOWLIST`: one entry per legitimate instruction file, each
naming the file's **owner** — the party accountable for its content. Repository
validation **fails** on an instruction file with no entry. It does not warn. A
warning inside a run that exits 0 is a note, and notes do not stop anything;
this check is meant to stop something.

**The allowlist is in code, not in a data file.** A sibling JSON file would be a
second thing deciding which instructions are legitimate, cheaper to edit than the
validator that reads it, and with no provenance of its own — the same problem one
level down. Adding an entry is a change to a gate-bearing script, reviewed as
one.

**The scan skips `node_modules` and `.git`,** plus build outputs (`.next`,
`.turbo`, `.vercel`, `dist`, `build`, `coverage`). Cost is the smaller reason.
The real one: a dependency shipping its own `AGENTS.md` is not a finding, and a
scanner that offered those files for allowlisting would be implying they could
become authoritative. They cannot. The rule, stated in
`coordination/AI_OPERATING_MODEL.md`, is that nothing under `node_modules` is
ever authoritative — so those files are out of scope rather than out of budget.
The scan also does not follow symlinks, so a link cannot redirect it.

**Generated files are allowlisted only after being read, and the entry records
what they say.** Each generated entry carries `generator`, a `summary` of the
actual content written by whoever read it, a `disposition` explaining why it was
kept rather than removed, and `pinnedSha256` — the hash of the exact bytes
reviewed, normalised to LF because the generator emits CRLF on Windows
checkouts. If a future version of the generator writes different text, the pin
stops matching and validation fails until someone reads the new content and
re-pins it. That is the difference between an allowlist and an exemption: the
entry records a review of specific bytes, not a standing permission for a path.
A missing allowlisted file is also an error, so an entry cannot outlive the file
it describes.

**Why `apps/web/AGENTS.md` was kept rather than gitignored and deleted.**
Deleting it does not remove the instruction surface, it relocates it:
`writeAgentFiles()` falls through to `apps/web/CLAUDE.md` when `AGENTS.md` is
absent, and writes the managed block there instead. `next dev` recreates one or
the other on the next run regardless. A tracked file with a pinned hash is
strictly more visible than an ignored file nobody diffs, so both files are
tracked, pinned, and their content is recorded in the allowlist entry.

`scripts/test-validate-repo.mjs` plants an unexpected `AGENTS.md` in the
repository, asserts that validation exits 1 and names the path, removes it, and
asserts the pass returns. A detector nobody has watched fire is not known to
work.

## Reuse in a new project

From this repository:

```bash
node scripts/bootstrap-ai-project.mjs --target ../new-project --name "New Project" --prefix NP
```

This installs a fresh control-plane skeleton and CLI into another repository. The new project then defines its own tasks, agents, gates, and policies.
