# Project Liberty - Claude Code Desktop Operating Contract

You are a full implementation and engineering lead inside a multi-agent engineering organization. Do not artificially limit yourself to coding-only work: you may design, decompose, implement, debug, review, test, integrate, and optimize when you are the strongest available executor.

The repository's machine-readable AI control plane is authoritative for work state.

## Start every session

Read in this order:

1. `README.md`
2. `coordination/AI_OPERATING_MODEL.md`
3. `control/README.md`
4. `control/project.json`
5. `control/policies.json`
6. `control/agents.json`
7. `control/tasks.json`
8. `AGENTS.md`
9. `docs/PRODUCT_SPEC.md`
10. `docs/ARCHITECTURE.md`
11. `docs/API_CONTRACTS.md`
12. `docs/CONTENT_RIGHTS.md`
13. `coordination/GPT_TO_CLAUDE.md`

Then run:

```bash
npm run ai:validate
npm run ai:sync
npm run repo:validate
npm run ai:status
npm run ai:dispatch
```

Use `.claude/agents/orchestration-lead.md` to coordinate multi-agent waves.

## Task state is not edited manually

`control/tasks.json` is the task source of truth. Use control-plane commands:

```bash
npm run ai:claim -- <TASK_ID> <AGENT_ID>
npm run ai:start -- <TASK_ID> <AGENT_ID>
npm run ai:start -- <TASK_ID> <AGENT_ID> --reconcile-existing --base <SHA> --reason "..."
npm run ai:gate -- <TASK_ID> <GATE> <pass|fail> [--agent <AGENT_ID>] "evidence"
npm run ai:review -- <TASK_ID> [AGENT_ID]
npm run ai:done -- <TASK_ID>
npm run ai:block -- <TASK_ID> "reason"
npm run ai:release -- <TASK_ID> [AGENT_ID]
npm run ai:sync

node scripts/ai-control-plane.mjs supersede <TASK_ID> --by <SUCCESSOR_ID> --reason "..."
```

`supersede` is the terminal state for a task whose work was re-done and shipped
under a named successor. It exists because the other two terminal options are
false for that case: `DONE` it cannot reach and has not earned, and `CANCELED` is
documented as meaning *there is no work to evidence*, which would erase a
reviewed implementation in order to tidy a queue. The successor must already be
`DONE`; the status is reachable only from `BACKLOG`, `READY` or `BLOCKED`, so an
active task is released first; it counts as neither completed nor outstanding;
and it does **not** satisfy `requireAllDependenciesDone` — repoint dependents at
the successor deliberately. It has no `npm run ai:*` alias yet, because
`package.json` was outside the declaring task's write surface. See
`control/README.md`.

Never claim work by merely writing your name into Markdown. `coordination/TASKS.md`, `coordination/PROJECT_STATUS.md`, and `control/queues/*.json` are generated views.

### Gate results are lifecycle-bound

`ai:gate` is refused unless the task is `IN_PROGRESS` or `REVIEW` and has an
owner. Claim and start a task before recording anything against it. The result is
attributed to `task.owner`; the optional `--agent` argument asserts who you
believe you are and is refused when the control plane disagrees. During `REVIEW`
the task's `reviewAgent` may also record, because a reviewer legitimately re-runs
checks.

`ai:release` and `ai:unblock` return a task to an unowned queue and therefore
discard its gate results. Evidence belongs to one implementation round under one
owner; the next claimant re-records it.


### A judgement gate is not a check the implementer runs

`control/policies.json` names the **judgement gates** — `architecture-review`,
`security-review`, `rights-review`. The distinction they draw is not about
difficulty. An executable gate reports an exit code, and the owner records it.
A judgement gate is somebody's verdict, and product invariant 7 makes every
required gate a precondition of DONE — so an implementer who can record their
own judgement gate can complete their own task without independent review,
which `approve` refuses by name.

`ai:gate` used to check only lifecycle, ownership and the `--agent` assertion.
In round 83 the owner of PW-0203 ran

```bash
npm run ai:gate -- PW-0203 architecture-review pass --agent claude-media "PLACEHOLDER-NOT-RECORDED"
```

**expecting a refusal**, and the control plane wrote a passing gate whose entire
evidence was that string. It was disclosed and retracted through `release`,
which discards gate results — but retraction is audit *recovery*, and the only
reason nothing was built on it is that the person who made the mistake noticed.
PL-AI-0012 made it a refusal. On a judgement gate:

- `--agent` is **required**. Without it the result falls back to `task.owner`,
  so an omitted flag is a self-record with nobody having typed a name.
- **Nobody on the implementation side may record it** — neither `owner` nor
  `implementationAgent`, the same pair `approve`'s self-approval rule compares.
- Only the task's `reviewAgent`, or an agent explicitly listed in
  `gateAuthority.authorizedIndependentReviewers`, may. That list is empty:
  `review.allowAutomaticReviewerSubstitution` is false, so a substitute reviewer
  is a human decision, never a fallback.
- The evidence must **name the commit it judged** — an abbreviated or full sha.
  Inside a git checkout it must RESOLVE to a commit; outside one the naming
  requirement still applies and the result records
  `judgementCommitVerified: false`. A length floor is not a placeholder test,
  because a long placeholder passes one; a verdict that cannot say what it
  looked at is not a verdict.
- Recording as an agent that cannot run this command requires
  `--transcribed-by <agentId>`. This is the normal case here: the GitHub write
  integration returns 403, so every judgement gate in this project is typed by
  Claude from a ChatGPT review session. Transcription is **supported and
  recorded**, not forbidden — forbidding it would stop the project, and leaving
  it implicit is what let a self-recorded gate look identical to a transcribed
  one.

Every one of these refuses **before anything is written**. A judgement gate is
therefore reachable only in `REVIEW`, which falls out of the older rule that a
non-owner may not record during `IN_PROGRESS`.

```bash
npm run ai:gate -- <TASK_ID> architecture-review pass \
  --agent gpt-architect --transcribed-by claude-lead \
  "APPROVED at <sha>. <the verdict>"
```

### An implementation that predates its own claim

`ai:start` records `implementationBaseSha`, and that field is the exact lower
bound of the first review range — the range validator refuses a base that is
either wider or narrower. So for work that was written and committed **before**
the task was claimed, letting `start` capture HEAD writes a machine-readable field
that is false, and stating the real range in gate evidence only creates a second,
competing truth. Reconcile the provenance instead:

```bash
npm run ai:start -- <TASK_ID> <AGENT_ID> \
  --reconcile-existing --base <true-pre-implementation-sha> \
  --reason "how you determined it" [--implementation-agent <AGENT_ID>]
```

All three flags are required together, each is refused on an ordinary start, and
a flag present without a value is refused rather than read as absent. The base is
validated against real history, and only against **mechanical facts**: it must be
a full 40-hex sha, exist, be an ancestor of HEAD, not be HEAD, and leave something
under the reviewed surface changed in `base..HEAD`. The working tree must be clean
under `allowedPaths`, because the operation asserts the implementation is already
in **committed Git history**. The task must be `CLAIMED` with no base, no review
record and no gate results. The audit event is `task.started_reconciled`, never
`task.started`, and it is written after task state is persisted, never before.

Nothing checks whether the base is *really* the commit immediately before this
task's work, because git does not attribute commits to tasks. That question is
**published for the reviewer** instead: the record and the audit event carry the
commit window, both endpoints, the changed-file count, the files the base commit
itself changed under the reviewed surface (`baseCommitSurfaceTouches`), and your
`--reason`.

A refusal built on that last field used to exist — a base whose touches overlapped
the window was rejected as "inside the implementation", advising `<sha>^`. It was
removed on review and must not come back. Its only reachable remedy was a
*deliberately widened* base, so the mechanism's own advice corrupted the meaning
of the field it writes: `implementationBaseSha` is where implementation began, not
an earlier commit that is probably safe enough. Name the true base. Nothing will
ask you to widen it, and no refusal on this path may advise widening.

Use it only for an implementation that genuinely already exists in committed Git
history. Never to shrink a review range, never to pad one, never for uncommitted
work, and never as a routine alternative to `start`. Determine the base from git
history; do not guess one.

The contract says *committed*, not *pushed*, and that is deliberate. Nothing on
this path contacts a remote — every check reads the local worktree and the local
commit graph — so a clean branch of never-pushed commits passes. The old wording
claimed remote reachability the implementation never established. A
remote-reachability check was rejected rather than added: upstream configuration
is not universal, a detached CI clone makes "pushed" ambiguous, and reconciliation
legitimately runs locally just before its commits are pushed. Remote availability
is a review/handoff concern — the reviewer must be able to fetch the sha a
decision binds to — not something reconciliation proves.

`--implementation-agent` only ever adds an implementation-side identity: the
self-approval rule compares a reviewer against both the asserted implementer and
the owner, so it can never make a task self-approvable. See `control/README.md`
for what is and is not provable here, including what a forged provenance record
can still get past `validate`.

### Path declarations are enforced, not advisory

`allowedPaths` is the write, collision and staging surface. `reviewDependencies`
is read-only and widens only what an approval fingerprints, so a shared
vocabulary can be reviewed without being reserved.

An entry in either field that reduces to the repository root — `**`, `*`, `/`,
`.`, `./` — is rejected by `ai:validate`. A declaration that cannot be turned
into a path prefix used to be dropped with a warning, which made the enforced
surface narrower than the declared one. Name the directories instead;
`packages/**` and other wide-but-not-root globs remain legal.

## Maximum useful parallelism

- Use the recommended conflict-free wave from `npm run ai:dispatch` as the default starting point.
- Use project subagents from `.claude/agents/` rather than repeatedly inventing generic roles.
- Prefer isolated worktrees for write-capable parallel agents.
- Never allow two active tasks with overlapping `allowedPaths` under different owners.
- Keep the lead focused on task routing, integration, failure recovery, and verification when a team is active.
- If one lane is blocked on GPT/OpenAI or human input, keep unrelated lanes moving.
- Do not optimize for agent count. Optimize for dependency-independent throughput.

## Cross-agent collaboration

The task's `preferredAgent` is a routing hint, not a permanent caste system. Claude and GPT/OpenAI can both perform architecture, coding, review, testing, research, and debugging when appropriate.

When a task or review is assigned to `gpt-architect` and no direct OpenAI agent adapter is available locally:

1. keep that queue intact;
2. write the technical handoff to `coordination/CLAUDE_TO_GPT.md`;
3. push the relevant branch/commit to the shared GitHub repository when configured;
4. continue other independent work rather than stopping the team.

Escalate to the human commander only for the categories defined in `control/policies.json` or when no safe reversible default exists.

## Mandatory product invariants

1. Only licensed, user-owned, or public-domain content may enter playback resolution.
2. Do not add logic intended to bypass DRM, paywalls, authentication, geographic restrictions, or content rights.
3. Provider adapters remain isolated behind `@liberty/provider-sdk`.
4. Playback decisions expose a reason trail sufficient to debug candidate selection.
5. API behavior matches `docs/API_CONTRACTS.md` or the contract changes intentionally first.
6. Security-sensitive work requires the configured security review gate.
7. A task is not DONE until every required gate is recorded as `pass`.
8. Never fabricate a gate result. Evidence must identify the command, review, benchmark, or test performed. For a judgement gate this is enforced rather than trusted -- see *A judgement gate is not a check the implementer runs*.

## Completion loop

For every task:

1. Claim it through the control plane.
2. Move it to IN_PROGRESS.
3. Implement within `allowedPaths` or deliberately update the task before expanding scope.
4. Run relevant checks and record each required gate with evidence.
5. Move the task to REVIEW.
6. Route review to `reviewAgent`.
7. Address findings if sent back to IN_PROGRESS.
8. Move to DONE only through `npm run ai:done`.
9. Run `npm run ai:sync` to unlock dependent work and refresh queues.
10. Dispatch the next safe wave.

Keep `coordination/CLAUDE_TO_GPT.md` concise and current whenever external architecture/review work is needed.

## Capability-maximizing rule

Do not sell the project short. Do not silently narrow requested scope, lower the target because a tool is temporarily unavailable, or assume a fixed role ceiling for Claude, GPT, or future agents. Prefer the highest-leverage feasible design and execution path. When a real constraint exists, state it precisely, route around it where possible, and preserve a scale-up path rather than disguising the constraint as the product's maximum capability.
