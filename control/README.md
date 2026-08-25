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

- To make a review range smaller because the diff is inconvenient. Widening is
  always safe; narrowing hides work, and that is the failure this exists to
  prevent, not to enable.
- On work that is not committed yet. That is an ordinary `start`.
- To revise a base that already exists, or to re-open a task in `REVIEW`. Both
  are refused.
- As a routine alternative to `start`. If HEAD really is where the work begins,
  `--base` is a lie with extra steps.

### What is enforced

All three of `--reconcile-existing`, `--base` and `--reason` are required
together, and each is **refused outright** on an ordinary `start` rather than
ignored — an accepted-and-ignored `--base` would produce exactly the false field
the mechanism exists to prevent. The supplied base is then verified, not trusted:

| check | why |
| --- | --- |
| full 40-hex sha | `HEAD~3` resolves differently later; the field is read months on |
| git present, HEAD resolves | fail closed — "cannot check" must not read as "checked" |
| commit exists, ≠ HEAD, ancestor of HEAD | a range that is real and non-empty |
| something under the reviewed surface changed in `base..HEAD` | a base at or after the implementation is the central falsehood |
| the base commit does not itself modify files the window also changes | a commit editing the same files as the window that follows it is *inside* an implementation, not before one |
| task is `CLAIMED`, with no base, no review record and no gate results | reconciliation establishes a base once, at the moment a task opens |

`LIBERTY_COMMIT_SHA` is deliberately **not** consulted: the whole value of the
operation is that the claim is checkable against real history.

**What cannot be proven, stated plainly:** git does not attribute commits to
tasks. No check here can prove a supplied base is *the* commit immediately before
this task's implementation, because nothing records which commits were this
task's. So the operation also *publishes* what it verified — the commit window,
its oldest commit, the changed-file count and the operator's `--reason` — into
`events.jsonl` and onto the task, so a reviewer can interrogate the remaining
question ("is there an earlier commit that also belongs to this implementation?")
instead of taking it on trust.

### What a reader sees

- `events.jsonl` records **`task.started_reconciled`**, never `task.started`, so a
  reader scanning for the ordinary type cannot mistake one for the other by
  overlooking a field. The record carries the base, the head it was reconciled
  against, the window, the reason, and a note saying this was reconciliation of a
  pre-existing pushed implementation and not a new implementation start.
- The task gains `implementationBaseProvenance` beside `implementationBaseSha`.
  Absence of that record is what marks a base as *captured*; presence marks it as
  *asserted*. `validate` refuses a provenance record whose `baseSha` does not
  match the field it claims to explain, so the marker cannot be hand-edited onto a
  HEAD-captured sha.
- `review-status` reports both, and `handoff --base auto` tells the reviewer that
  the range opens before the claim and why.

`--implementation-agent` exists because the subagent that produced pre-existing
code is not necessarily the one claiming now. Like `gate --agent` it is an
assertion, not authentication — nothing in a local CLI can authenticate anything —
but it is explicit and audited rather than a silent side effect of who claimed.
Naming the task's own `reviewAgent` is refused, because it would make the task
permanently unapprovable under the self-approval rule.

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
