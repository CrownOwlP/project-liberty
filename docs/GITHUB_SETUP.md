# GitHub Setup

Two separate things live in this document, and conflating them is how the second one got skipped:

1. **Publishing the repository.** Done once. Straightforward.
2. **Standing up the cross-agent bridge** — the GitHub Actions workers that let `gpt-architect`
   and `claude-lead` hand work to each other without a human relaying files. This is PL-AI-0002,
   the machinery is committed, and **no verdict has ever round-tripped through it.** Read
   "What is proven and what is not" before you trust any of it.

---

## 1. Publishing the repository

The scaffold was generated as a real local Git repository with `main` and an initial commit.

### Fastest publish path with GitHub CLI

From the repository root, after installing and authenticating `gh`:

```bash
gh auth login
gh repo create CrownOwlP/project-liberty --private --source=. --remote=origin --push
```

### If you create an empty repository in GitHub first

```bash
git remote add origin git@github.com:CrownOwlP/project-liberty.git
git push -u origin main
```

### Immediately after first publish

1. Run `npm install` on a machine with npm registry access.
2. Run `npm run check`.
3. Commit the generated `package-lock.json`.
4. Change CI install from `npm install --no-audit --no-fund` to `npm ci --no-audit --no-fund`.
5. Protect `main`: require pull requests and the CI status check.
6. Keep the repository private until content-provider licensing, secrets, and distribution
   strategy are intentionally decided.

---

## 2. Standing up the cross-agent bridge

### What the bridge is made of

| Path | Role |
| --- | --- |
| `coordination/agent-bus/` | The transport. Immutable JSON messages, acknowledgements, quarantine records, journal. Format and semantics: `coordination/agent-bus/README.md`. |
| `scripts/agent-bus.mjs` | Bus primitives, and a CLI shim that forwards to the control plane. |
| `scripts/ai-control-plane.mjs` | Enforcement. The bus transports decisions; this applies them. |
| `scripts/cloud/gpt-review-worker.mjs` | The GPT reviewer. Reads its inbox, calls OpenAI, publishes a structured decision back through the bus. |
| `scripts/cloud/orchestrator-gate.mjs` | Activation gate. Reports `review` / `complete` / `orchestrate` permissions from `control/tasks.json`. |
| `.github/workflows/agent-gpt-review.yml` | Runs the reviewer. `workflow_dispatch` + `*/30 * * * *`. |
| `.github/workflows/agent-claude-worker.yml` | Runs the Claude implementation lane as six isolated jobs. `workflow_dispatch` + `15,45 * * * *`. |
| `.github/workflows/ci.yml` | Ordinary CI. Not part of the bridge, but the workers dispatch it to verify their own pushes. |

### Secrets and variables to configure

Repository → Settings → Secrets and variables → Actions.

| Name | Kind | Used by | Required? |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | secret | `agent-gpt-review.yml` → `gpt-review-worker.mjs` | Yes, or the reviewer exits 1 immediately. |
| `ANTHROPIC_API_KEY` | secret | `agent-claude-worker.yml` → `anthropics/claude-code-action@v1` | Yes, for the implementation lane. |
| `OPENAI_REVIEW_MODEL` | variable | `agent-gpt-review.yml` | Optional. Defaults to `gpt-5.6`. |

Two more environment variables are read by `gpt-review-worker.mjs` and are **not** set by the
workflow, so they always take their defaults in CI: `OPENAI_REVIEW_EFFORT` (default `xhigh`) and
`REVIEW_MAX_PATCH_BYTES` (default `400000`). Set them in the workflow's `env:` block if you need
to change them; there is no repository-variable plumbing for either.

`LIBERTY_JOURNAL_DIR` is set to `coordination/agent-bus/cloud-journal` at workflow level in both
agent workflows. That is what puts the crash-recovery journal in the repository instead of on an
ephemeral runner's disk — see "Recovery scope" in the bus README. Do not unset it in a hosted run.

### The trust boundary is push access, and it is not configured yet

`control/project.json` → `agentBus.trustModel` declares `cooperative-github-writers`. The bus
does not authenticate anything: `fromAgent` is a self-asserted string in a file. Anyone who can
push to this repository can publish a message claiming `--from gpt-architect` and approve their
own work, and every mechanical check will pass, because they all reason about the *claimed*
identity.

The bus README lists four measures that move the boundary to GitHub, where it can be enforced.
**None of them is in place today.** At minimum, before treating a bus-transported approval as
independent review:

1. Each lane pushes with its **own** credential — separate account, deploy key, or GitHub App
   installation. They must not share one identity.
2. `CODEOWNERS` restricts `coordination/agent-bus/gpt-to-claude/**` to the GPT lane's identity and
   `coordination/agent-bus/claude-to-gpt/**` to the Claude lane's. The committed
   `.github/CODEOWNERS` does not currently do this.
3. Branch protection on `main` requires review for changes to those paths.
4. Optionally, require signed commits, record each lane's signing identity in
   `control/agents.json`, and verify the authoring commit of a message file before applying it.

Until (1) and (2) exist, the bridge is a convenience transport between two cooperating lanes. It
removes the human relay. It is not a security control.

### Running it by hand, once, before trusting the schedule

```bash
# 1. What does the gate think is allowed?
node scripts/cloud/orchestrator-gate.mjs

# 2. What is waiting for each lane?
node scripts/agent-bus.mjs inbox gpt-architect
node scripts/agent-bus.mjs inbox claude-lead

# 3. Publish a review request (the Claude lane's step 6). --sha auto resolves HEAD;
#    --base is mandatory and has no parent-commit fallback.
node scripts/agent-bus.mjs handoff \
  --from claude-lead --to gpt-architect --type review_request \
  --task <TASK_ID> --sha auto --base <implementationBaseSha> \
  --summary "..." --evidence "..."

# 4. Run the reviewer locally with a key in the environment, never on the command line.
OPENAI_API_KEY=... node scripts/cloud/gpt-review-worker.mjs

# 5. Apply whatever came back, through the enforced path.
node scripts/agent-bus.mjs process claude-lead
```

Then dispatch the hosted workflows explicitly rather than waiting for cron:

```bash
gh workflow run agent-gpt-review.yml --ref main
gh workflow run agent-claude-worker.yml --ref main --field reason="first hosted run"
```

### The branch problem, which will bite before anything else does

Both agent workflows are hard-wired to `main`: `agent-claude-worker.yml` checks out `ref: main`,
`finalize-task.mjs` pushes there, and each workflow dispatches the next with `--ref main`.
`.github/workflows/ci.yml` records that **all development happens on a long-lived working branch
and `main` is deliberately untouched**. Both statements cannot be operationally true at once.

Before the first hosted run, decide which one holds — fast-forward `main` to the working branch,
or point the workers at the working branch — and change it deliberately. Nothing in the tooling
will tell you: the workers would simply operate on a `main` that is missing every task the local
checkout has been working on, and the failure would look like the control plane disagreeing with
itself.

---

## What is proven and what is not

This section exists because the previous version of this document did not mention the bridge at
all, and the bridge's own README describes the design as though it were in service.

### Proven

- **Messages can be published.** Three `review_request` messages exist in
  `coordination/agent-bus/claude-to-gpt/`, written by `scripts/agent-bus.mjs` in August 2026.
- **The control plane's enforcement of bus messages is unit-tested.**
  `scripts/test-ai-control-plane.mjs` exercises quarantine, journal recovery, exactly-once
  acknowledgement, the `baseSha` range rules and the stale-decision refusal, against fixture
  repositories. That is real coverage of the *rules*.
- **The reviewer's non-model paths are unit-testable without a key**, which is why chunking,
  binary detection and decision aggregation live in `scripts/cloud/review-chunking.mjs`.

### Never verified, end to end

- **No verdict has ever round-tripped.** `coordination/agent-bus/gpt-to-claude/` has contained
  nothing but `.gitkeep` since the directory was created. Not one message has ever arrived from
  the GPT lane.
- **The three outbound requests were never acknowledged.**
  `coordination/agent-bus/acknowledgements/` is likewise empty. Those three messages have now been
  retired as durable quarantine records (`coordination/agent-bus/rejections/`) because their task,
  PL-AI-0001, reached DONE and they carry no `baseSha` — either defect alone makes them
  permanently unreviewable, and messages are immutable, so there was nothing to repair.
- **`gpt-review-worker.mjs` has never made a real OpenAI call in this repository.** The code is
  complete and the call is real, but no run of it is recorded anywhere in committed state.
- **No hosted workflow run has ever refreshed mission control.**
  `docs/MISSION_CONTROL.md` was last generated 2026-08-15 and reports `**Run:** local`, which
  `mission-control-status.mjs` emits only when `GITHUB_RUN_ID` is unset. A GitHub Actions run
  would have written a run URL.
- **Every GPT verdict recorded in `control/tasks.json` to date arrived by hand.** Read the review
  evidence on PL-AI-0001 and PL-0001: both say the decision was transcribed by `claude-lead` from
  a ChatGPT session because GPT's GitHub connector returns
  `403 Resource not accessible by integration` on repository writes. The bridge exists precisely
  to replace that, and has not yet done so once.
- **The `403` has not been retested.** If the GPT lane's connector is still read-only, GPT cannot
  publish a message file at all, and the hosted `agent-gpt-review.yml` worker — which pushes with
  the workflow's own token, not GPT's connector — is the only path that could ever close the loop.

The honest summary: **the bridge is built, tested at the level of its rules, and unproven at the
level of its behaviour.** Do not record a gate result, an approval, or a status claim that asserts
otherwise until a message has actually landed in `gpt-to-claude/` and been applied.

---

## 3. The optional dispatcher (PL-AI-0003)

A separate, **off-by-default** mechanism that sits beside the bridge rather than inside it:
`scripts/cloud/agent-dispatcher.mjs`, configured at `control/adapters.json` → `dispatcher`, with
its state and its approval format documented in `coordination/agent-bus/dispatch/README.md`.

Two things an operator needs to know before touching it:

- **Arming it takes two deliberate acts, and neither implies the other.** `dispatcher.enabled`
  must be `true` in the committed configuration *and* `LIBERTY_DISPATCHER_ENABLED` must equal
  exactly `1` in the environment. With the shipped values, `--apply` plans, prints, writes nothing
  and exits 0.
- **It never claims a task and never records a gate.** Dispatching work and asserting that the
  work was done are different acts, and only the agent that did the work may record the second.
  `scripts/cloud/test-dispatcher.mjs` proves it by running `--apply` against a fixture repository
  and requiring `control/tasks.json` to come back byte-identical.

What is real: the planner, the budget and its fail-closed ledger arithmetic, the human-approval
gate, the retry ceiling read from the audit log, the audit log itself, and one working
credential-free runner that publishes an informational `task_instruction` on the bus. What is a
**seam**: the model-calling runner. `openai-responses` is configured and deliberately not
registered, so a dispatch through it refuses with `runner_unavailable`. No dispatcher code has
ever made a model call, and the suite asserts that the seam stays empty rather than quietly
becoming a stub.

```bash
node scripts/cloud/agent-dispatcher.mjs --plan          # what it would do, and why it refuses
node scripts/cloud/agent-dispatcher.mjs --plan --json   # the same, machine-readable
node scripts/cloud/test-dispatcher.mjs                  # the suite; no network, no key
```
