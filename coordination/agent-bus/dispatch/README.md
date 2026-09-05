# Optional dispatcher state

State for `scripts/cloud/agent-dispatcher.mjs` (PL-AI-0003). Configuration lives in
`control/adapters.json` → `dispatcher`; the decision rules live in
`scripts/cloud/dispatch-policy.mjs`.

Nothing here is written unless the dispatcher is **armed** — `dispatcher.enabled: true` in the
committed configuration **and** `LIBERTY_DISPATCHER_ENABLED=1` in the environment — and invoked
with `--apply`. As shipped it is neither, so all three files below are absent, and that is the
correct steady state.

```
coordination/agent-bus/dispatch/
  ledger.json            what has been charged. ABSENT means nothing spent; UNREADABLE refuses.
  audit.jsonl            append-only, one record per decision, refusals included.
  approvals/<id>.json    human authorizations. Written by a human. Never by the dispatcher.
```

## The approval record

A dispatch that triggers a category listed in `control/policies.json` → `escalation.humanOnly`
cannot proceed without a committed approval covering it. Today two categories are reachable:
**Budget**, triggered by any dispatch that will actually be charged, and **Credentials**, triggered
by any runner that declares it needs one. A task may also declare its own `escalation` array —
that field is an extension point and no task in `control/tasks.json` currently uses it.

```json
{
  "approvalId": "APPROVAL-20260904-openai-review",
  "grantedBy": "human-commander",
  "grantedAt": "2026-09-04T12:00:00.000Z",
  "expiresAt": "2026-09-11T12:00:00.000Z",
  "categories": ["Budget", "Credentials"],
  "budgetCeiling": { "currency": "USD", "amount": 25 },
  "scope": { "taskIds": "any", "providerIds": ["openai-responses"] },
  "note": "One week of automated architecture review. Diego, 2026-09-04."
}
```

- `grantedBy` must resolve to an agent whose `kind` is `executive` in `control/agents.json`. The
  check is on the kind, not on the literal id, so adding a second human approver is an
  `agents.json` change rather than a code change — and an approval signed by `claude-lead` is
  rejected structurally rather than by a name comparison somebody could later relax.
- `expiresAt` is mandatory and must be in the future. A standing, non-expiring authorization is
  indistinguishable from no gate at all.
- `scope.taskIds` and `scope.providerIds` are each either an array or the literal string `"any"`.
- `budgetCeiling` must be in the budget's currency and at least the estimated cost. It is checked
  in addition to `dispatcher.budget`, not instead of it: the configuration bounds the machine, the
  approval bounds the authorization, and a dispatch has to satisfy both.

**The dispatcher cannot write one of these.** There is no code path in `dispatch-policy.mjs` or
`agent-dispatcher.mjs` that creates a file in `approvals/`. A program that could mint its own
consent is not gated by consent.

An approval file that will not parse is **dropped**, which leaves the dispatch it would have
covered refused with `human_approval_missing`. The count of dropped files is printed, so
"nobody approved this" stays distinguishable from "the approval is corrupt".

## The audit log

One JSON object per line, appended, never rewritten. A record is written for every decision the
run considered — including every refusal, because the question after an incident is usually "why
did it *not* dispatch", and a log of successes cannot answer it.

The `id` is derived by hash from `runId`, `taskId`, `providerId`, `attempt` and `outcome` rather
than being random, so a crash between the runner call and the append is identifiable by id instead
of being indistinguishable from a coincidence.

`outcome` is one of `refused`, `dispatched` or `failed`. Only the last two count as **attempts**
against `dispatcher.retries.maxAttempts` — a refusal sent nothing, so counting it would spend the
retry budget on decisions the dispatcher made entirely by itself. A single unparseable line
refuses the whole run: an undercounted attempt log silently *widens* the retry budget, and that is
not a failure mode worth tolerating.

## What this is not

The dispatcher never claims a task, never records a quality gate, and never writes
`control/tasks.json`. Dispatching work and asserting that the work was done are different acts,
and only the agent that did the work may record the second. `scripts/cloud/test-dispatcher.mjs`
asserts this by running `--apply` against a fixture repository and requiring `control/tasks.json`
to come back byte-identical.
