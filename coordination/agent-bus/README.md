# Agent Handoff Bus

GitHub is the transport between the GPT lane and the Claude lane. **No human relays messages.**
Diego is commander and approver, not the wire.

## Layout

```
coordination/agent-bus/
  gpt-to-claude/<messageId>.json      messages authored by the OpenAI lane
  claude-to-gpt/<messageId>.json      messages authored by the Anthropic lane
  acknowledgements/<messageId>.json   exactly one per SUCCESSFULLY processed message
  rejections/<messageId>.json         durable quarantine record; shared/committed
  journal/<messageId>.json            local crash-recovery state; gitignored
```

An acknowledgement and a rejection are mutually exclusive verdicts. `ack` refuses to run on a
quarantined message, so the audit trail can never report a rejected message as processed.

Messages are **immutable**. A message file is written once with `wx` and never edited. Status is
not stored back into the message — it is derived from whether an acknowledgement file exists.
That is what keeps two agents from ever editing the same file and turning coordination into a
merge-conflict queue.

## Message format

```json
{
  "id": "MSG-20260815T101500000Z-review_approved-1a2b3c4d",
  "fromAgent": "gpt-architect",
  "toAgent": "claude-lead",
  "taskId": "PL-AI-0001",
  "type": "review_approved",
  "commitSha": "80bef048d88b526aa4ae3179afdeb6d768812701",
  "summary": "Independent review of the control plane against the pushed commit.",
  "evidence": ["https://github.com/CrownOwlP/project-liberty/commit/80bef04"],
  "createdAt": "2026-08-15T10:15:00.000Z",
  "status": "open"
}
```

| Type | Direction | Effect on the control plane |
| --- | --- | --- |
| `task_instruction` | either | informational; acknowledged, no state change |
| `architecture_decision` | either | informational; acknowledged, no state change |
| `implementation_ready` | claude → gpt | informational to the reviewer |
| `review_request` | either | informational to the reviewer |
| `review_approved` | reviewer → implementer | records an APPROVED review through the enforced path |
| `changes_requested` | reviewer → implementer | records CHANGES_REQUESTED, returns task to IN_PROGRESS |
| `blocker` | either | marks the referenced task BLOCKED with a reason |

`taskId` and `commitSha` are **required** for `implementation_ready`, `review_request`,
`review_approved` and `changes_requested`. A decision that does not name the commit it was made
against is rejected at publish time.

## Commands

Invoked directly, not through npm aliases: `package.json` is owned by PL-0001, and the bus is
PL-AI-0001 work. Aliases can be added later through a properly scoped control-plane change.

```bash
node scripts/agent-bus.mjs inbox   claude-lead     # unacknowledged messages (--all for history)
node scripts/agent-bus.mjs process claude-lead     # recover, then apply + acknowledge, once each
node scripts/agent-bus.mjs recover claude-lead     # recovery pass only
node scripts/agent-bus.mjs ack     <messageId>     # acknowledge without applying
node scripts/agent-bus.mjs handoff --from claude-lead --to gpt-architect \
     --type review_request --task PL-0101 --sha auto \
     --summary "PL-0101 ready for review" --evidence "npm run check green"
```

`--sha auto` resolves the current HEAD, so a review request can never quote a commit that was
retyped by hand.

## Claude session loop

1. `git pull`
2. `node scripts/agent-bus.mjs inbox claude-lead`
3. `node scripts/agent-bus.mjs process claude-lead`
4. do the assigned work
5. commit and `git push` — the tree must be **clean** before a decision can be applied
6. `node scripts/agent-bus.mjs handoff --from claude-lead --to gpt-architect --type review_request --task <ID> --sha auto --summary "..." --evidence "..."`
7. `git push` again so the request is visible to GPT

## GPT session loop

1. `git pull`
2. read `coordination/agent-bus/claude-to-gpt/` for messages where `toAgent` is `gpt-architect`
   and no file of the same id exists in **either** `acknowledgements/` or `rejections/`
3. review **at the exact `commitSha` named in the message** — not at `main`, not at latest
4. publish the decision:
   `node scripts/agent-bus.mjs handoff --from gpt-architect --to claude-lead --type review_approved --task <ID> --sha <the reviewed sha> --summary "..." --evidence "..."`
5. `node scripts/agent-bus.mjs ack <the review_request id> --agent gpt-architect`
6. `git push`

## What the bus enforces

The bus **transports** decisions. The control plane still **enforces** them. Every one of these is
re-checked when a message is applied:

- the decision must name the task's designated `reviewAgent` as `fromAgent`
- the named reviewer may not be the recorded implementation agent
- `commitSha` must be a full 40-hex sha, must be an **ancestor of HEAD**, and **no file under the
  task's `allowedPaths` may have changed** between it and HEAD — otherwise the decision is stale
  and refused, because applying it would stamp unreviewed code as approved.
  HEAD moving is normal and not by itself stale: publishing a handoff is a commit, so every round
  trip advances it. What must hold is that nothing the reviewer actually looked at has changed.
- if HEAD cannot be resolved, the decision is refused (**fail closed**)
- the working tree must be clean; matching HEAD is not the same as matching the reviewed tree, and
  an uncommitted edit would otherwise be fingerprinted as reviewed
- the recorded `reviewedCommitSha` is the **reviewed** commit, never HEAD-at-apply-time
- the implementation fingerprint is bound at approval and re-checked at `done`
- all required quality gates must still be recorded with real evidence
- a review decision only applies to a task actually in `REVIEW`

A message that cannot be applied is never acknowledged. **Transient** failures stay in the inbox
and are retried; **permanent** defects are quarantined and hidden from the default inbox. See
"Rejection and quarantine" below.

## Trust model: `cooperative-github-writers`

Declared machine-readably at `control/project.json` → `agentBus.trustModel`.

**The bus does not authenticate anything.** `fromAgent` is a self-asserted string in a file. The
control plane checks that the *claimed* reviewer is the designated one and is not the implementer,
but it cannot check that the message was really written by that lane.

This mode removes Diego as the human relay. It explicitly does **not** provide:

- cryptographic agent identity
- protection against a malicious peer holding the same GitHub credential
- resistance to identity spoofing

Concretely: anyone who can write to this repository can publish a message claiming
`--from gpt-architect` and approve their own work. Every mechanical check above passes, because
they all reason about the claimed identity.

**The real trust boundary is push access to GitHub.** For the bus to mean anything, that boundary
has to be enforced on the GitHub side, not in this repository:

1. Each lane pushes with its **own** credentials — a separate account, deploy key, or GitHub App
   installation. They must not share one identity.
2. `CODEOWNERS` restricts `coordination/agent-bus/gpt-to-claude/**` to the GPT lane's identity and
   `coordination/agent-bus/claude-to-gpt/**` to the Claude lane's.
3. Branch protection on `main` requires review for changes to those paths, so a message cannot be
   force-pushed in by the other lane.
4. Optionally require signed commits and record each lane's signing identity in
   `control/agents.json`, then verify the authoring commit of a message file before applying it.

Until at least (1) and (2) are in place, treat the bus as a **convenience transport between two
cooperating lanes**, not as a security control. It removes the human relay; it does not remove the
need for the human to hold push credentials responsibly.

Known residual gaps, deliberately not papered over:

- **No provenance check.** A message is applied based on its contents, whether or not it was ever
  committed. `process` reads the working tree.
- **`control/tasks.json` is fingerprint-excluded**, so an implementer can set
  `requiresIndependentReview: false` on their own task and reach `done` without any review record.
  That predates the bus but is reachable the same way.
- **Idempotency is per working copy.** The `wx` claim is atomic on one filesystem. Two clones can
  each process the same message before they sync.

## Transactional processing and crash recovery

Processing a message is a six-step transaction with a durable journal at
`coordination/agent-bus/journal/<messageId>.json`. The journal is **local** state — it is
`.gitignore`d in place, because a crash is a property of one machine, not of the shared repo.

```
1. VALIDATE   every precondition; no mutation, no claim consumed on rejection
2. CLAIM      journal -> CLAIMED, written with O_CREAT|O_EXCL (atomic, once-only)
3. STAGE      journal -> APPLYING, transition applied in memory only
4. PERSIST    tasks.json written (write-then-rename), then journal -> APPLIED
              carrying the audit records the run intends to emit
              (derived views are regenerated best-effort after this point)
5. ACK        acknowledgement file written, journal -> ACKNOWLEDGED
6. AUDIT      events appended, then journal -> ACKNOWLEDGED/eventsEmitted
```

The audit event is **last**, so `control/events.jsonl` can never claim a review that task state
does not show. A rejected message produces no event at all.

Nothing that can fail runs between the `tasks.json` write and the `APPLIED` marker — otherwise a
crash there would look like "redo" when the state is already on disk. Derived views
(`PROJECT_STATUS.md`, `TASKS.md`, `queues/`) are regenerated *after* the commit point and are
allowed to fail, because they are reproducible from `tasks.json` with `sync`.

Audit records are persisted into the journal as **data**, not as callbacks, so recovery emits
exactly the records the interrupted run would have emitted — no more, no fewer.

Recovery runs automatically at the start of every `process`, and can be run alone with
`recover <agentId>`. It reads the journal and branches on which side of step 4 the crash landed:

| Journal state at startup | Meaning | Recovery |
| --- | --- | --- |
| `CLAIMED` / `APPLYING` | task state was **not** saved | release the claim; message is reprocessed from scratch |
| `APPLIED` | task state **was** saved | finish only: write the acknowledgement and replay the journalled audit records. Never re-apply. |
| `ACKNOWLEDGED`, `eventsEmitted: false` | acknowledged, audit incomplete | replay the journalled audit records only |
| `ACKNOWLEDGED`, `eventsEmitted: true` | complete | skip |
| `FAILED` | transient failure, retryable | release the claim |
| unparseable / unknown | treated as an incomplete claim | release the claim |

Both branches are idempotent, so recovery can run any number of times. Nothing is duplicated:
not reviews, not task transitions, not gates, not acknowledgements, not events.

## Idempotency

The journal claim is the once-only guard. It is created with `wx` (`O_CREAT|O_EXCL`), so the
filesystem guarantees a single writer. Re-running `process` cannot re-apply a transition, duplicate
a review, or republish a handoff — already-acknowledged messages are not even listed.

## Rejection and quarantine

A message that cannot be applied is never acknowledged — `acknowledged` means *successfully
processed*, and conflating the two would make the audit trail lie. Failures split in two:

**Permanent** — a defect in the message itself: malformed, wrong recipient, unknown type, unknown
task or agent, or a reviewer who is not the task's designated `reviewAgent` (or is the
implementer). Messages are immutable, so these can never become valid. The message is
**quarantined**: a durable record is written to `coordination/agent-bus/rejections/<id>.json` with
the reason and timestamp. The run that discovers it exits non-zero; later runs skip it silently.

Rejections are **committed and shared**, unlike the local journal — a defect in an immutable
message is a fact about the message, not about one machine, so another checkout must not
rediscover it and fail all over again.

**Transient** — the message is well-formed but the repository is not ready: a stale `commitSha`,
HEAD that cannot be resolved, a dirty working tree, or a task not yet in `REVIEW`. These are fixable
without changing the message, so they are **not** quarantined. They stay in the inbox and keep the
run non-zero until the underlying condition is resolved. Quarantining them would silently discard a
decision that was merely early.

```
REJECT  <id>: <reason>     new permanent rejection -- run exits non-zero
RETRY   <id>: <reason>     transient -- will be attempted again, run exits non-zero
SKIP    <id>: previously rejected
```

`SKIP` normally never appears: an already-quarantined message is filtered out of the inbox before
validation. It is the safety net for the case where another process writes the rejection between
this run listing the inbox and validating the message.

The order of checks matters. A task that is not yet in `REVIEW` has no owner and no implementation
agent, so the reviewer-identity checks would fail for a purely situational reason. Task status is
therefore checked **first**, and classified transient — otherwise an approval that merely arrived
early would be quarantined permanently, and that verdict would be committed and shared to every
other checkout.

Rejected messages are hidden from `inbox` and visible with `inbox <agent> --all`.

## Recovery scope

**Current scope: a persistent local worker** — the Claude Desktop checkout, or any long-lived
working copy. The journal lives on that machine's disk and recovers a crash on that same checkout.

**This is not sufficient for an ephemeral runner.** A GitHub Actions job gets a fresh filesystem
every run, so a crash mid-transaction would leave the journal behind with the container and the
next run would have no idea a transaction was in flight. Before GitHub Actions becomes the
autonomous processor, transaction state has to move to shared durable storage — a committed journal
with proper locking, an external KV store, or a workflow-level idempotency key.

Not a blocker for the current bridge; a prerequisite for the orchestrator that replaces it.

Handoff traffic is excluded from implementation fingerprints. Publishing a review request does not
change the fingerprint of the task being reviewed, so it cannot invalidate the approval that comes
back.
