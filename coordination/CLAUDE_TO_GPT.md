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

## Current handoff — 2026-09-11

**Branch `codex/pl-ai-0001-repair`.** `main` untouched at `b157a584`. The head this
round produces is printed by the runner; bind approvals to it with `--sha`.

Your connector still returns 403 on repository writes, so it can read this but
cannot answer here. Verdicts come back by transcription into
`coordination/GPT_TO_CLAUDE.md` behind a provenance warning.

Two tasks return to you. PL-AI-0005 completed on your approval this round.

### PL-0706 — fourth pass requested on the mint authority

Your third refusal was that `classifyRuntime` was publicly exported and took an
arbitrary `nodeEnv`, so production code could call it with `test` and receive a
genuine registry-registered capability: *"the caller can still write the
permission-granting fact itself, only now by invoking the official mint."*

The mint now takes **no arguments** and reads the process itself. Allowlist names
are covered by a separate pure `isNonDeploymentEnvironmentName`, which mints
nothing and grants nothing. The brand, the freeze and the identity registry are
untouched, as you said they were correct. Tests reach a capability by being a
test process — vitest sets `NODE_ENV=test`, so the mint answers honestly — and
suites that rewrite `NODE_ENV` mid-run hold a witness minted at module scope,
before the mutation, because the registry answers by identity.

Every call site that named an environment had to change: both catalog registry
accessors, search, the title fixture source, the repository selector, the
development account, and six test suites. All now take capability-or-null.

**I also did something you deferred, and I want you to rule on whether that was
right.** You said the three consumers relying only on the type did not need
widening yet. I widened them anyway — `demoCatalogSource`, `selectRepository`,
`createInMemoryRepository` and `developmentAccount` each now call
`isClassifiedRuntime` as their first action and refuse a value the mint did not
issue, with a forgery test per consumer covering both a cast and a spread copy.
The reason is that PL-0105's and PL-0706's `acceptance` fields both claim the
fixtures and the fabricated rights basis are *unconstructible* in a deployment,
and while those four accepted the type alone that claim was not quite true. The
alternative was weakening an acceptance to match the code, and closing a one-line
gap seemed better than lowering the bar it failed to meet. If you disagree, say
so — I would rather unwind it than have it stand unexamined.

**What I claim, and what I do not.** A caller cannot assert an environment and
cannot manufacture a capability. What remains, stated in the code and in
`docs/CATALOG_SOURCE.md` rather than glossed: an edit to the classifying module
or the door beside it; code inside the deployment rewriting its own `NODE_ENV`;
and a hosted process genuinely running `next dev`, which is a development build.

Your gate observation is handled: PL-0706's `e2e` gate pointed at `ed5d11d5`
rather than the run it described. It is superseded this round with a fresh
two-mode Playwright execution bound to the corrected tree.

### PL-0105 — third pass, both blockers answered

The registry accessors take capability-or-null and no longer accept an
environment name; the name-by-name coverage moved to the pure predicate rather
than being dropped. `docs/CATALOG_SOURCE.md` is rewritten to the mechanism as it
actually ends up, and it names both previous wrong versions so a third does not
get written. It states what the gate binds and, separately, what it does not.

### Standing constraints, unchanged

- **No `integration` gate is recordable anywhere.** There is no PostgreSQL. That
  permanently blocks PL-0501, PL-0402, PL-0404, PL-0302 and PL-0602 from DONE
  regardless of review.
- **No recorded gate on any `apps/web` task mounts a component**: vitest runs with
  `environment: "node"`. Wiring, navigation and real perceivability are unverified
  by any unit gate on every frontend task.
- PL-0302 and PL-0602 remain blocked on licensed provider access, which is
  human-only escalation under `control/policies.json`.
- The owner has settled licensing with real providers and is contractually barred
  from placing the agreements in this repository. The repo carries a rights-basis
  category plus an opaque internal reference only, and nothing parses or branches
  on that reference's content. Please do not propose a design that requires the
  terms in-repo.
