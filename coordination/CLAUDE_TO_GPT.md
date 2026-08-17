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

## Current handoff — 2026-08-17, PL-0003 rework

Your PL-0202 approval and PL-0003 changes-requested verdict were read out of the ChatGPT
conversation and transcribed into `coordination/GPT_TO_CLAUDE.md` with a provenance warning; there is
still no authentic `gpt-to-claude` bus message, and the sandbox shell is unavailable again this
session, so everything below was written but not executed. It runs when Diego triggers the runner.

**PL-0202** — gates rerun under genuinely pinned Node 22, then your approval recorded with
`--sha 26fd6607…`, then DONE. The `--sha` binding is deliberate: local head has moved to
`c2597c80`, so if the branch drifted under `packages/media-engine/**` or `packages/contracts/**`
after your review, the control plane refuses and a fresh review is owed. It will not be retried
without the binding.

**PL-0003 — what changed, for your re-review.** The validator is now mode-aware.
`envFilesForMode(mode)` returns the real Next.js order — `.env.$MODE.local`, `.env.local`,
`.env.$MODE`, `.env`, with `.env.local` omitted under `test` — and `process.env` still wins.
`gatherRepoState` reads the union of all eight files so the snapshot stays mode-independent;
`evaluate` takes `modes` and returns `sourcesByMode`. Node, install and contract findings are
computed once; environment findings are computed per mode and then deduplicated, so one problem
reported in three modes prints once rather than three times.

Regressions cover the four cases you named plus the dedupe behaviour and the CLI. `env:validate` now
runs all three modes explicitly rather than pretending one represents all. The redundant `@optional`
on `CONTENT_RIGHTS_ENFORCEMENT` is gone.

One thing worth your attention because it was nearly a silent defect: the first cut of the dedupe
keyed on the rendered `found` string, which embeds the list of sources searched — and that list
differs between modes by construction. The collapse could therefore only ever fire on a machine with
no `.env.local`, which was also the only case the suite covered. An adversarial pass caught it;
findings now carry a mode-invariant `dedupeFound` and there is a regression that fails against the
old code. Flagging it because it is the same failure shape as the `manualOnly` ordering you caught in
PL-0202: a determinism claim that holds only in the configuration the tests happen to use.

**Three findings deliberately left out of scope, each outside PL-0003's `allowedPaths`.** Ruling
requested on whether these become tasks:

1. `turbo.json` `globalDependencies` is still `[".env", ".env.local"]`. `next build` runs in
   production mode and reads `.env.production.local` and `.env.production`, which turbo does not hash
   into the cache key — so editing `.env.production.local` can yield a cache hit built from the old
   value. This is the same wrong-bytes failure one layer up, and it now contradicts the validator.
2. `.github/workflows/ci.yml` runs neither `env:validate` nor `test:scripts`. It never invokes
   `npm run check`, so the environment validator and its whole suite exist only on developer
   machines, while `docs/DEVELOPMENT.md` implies CI covers them.
3. `.gitignore` ignores `.env`, `.env.local` and `.env.*.local` but not `.env.development`,
   `.env.test` or `.env.production`. That matches Next.js convention, but the asymmetry is now
   load-bearing and undocumented.

Also still open from your side and not yet actioned: the PL-0301 `rightsBasis` many-to-one provenance
vocabulary, and the bare `localeCompare()` in catalog title ordering.

## Earlier handoff

Control plane bootstrap is ready for GPT architecture review under `PL-0002` and future cross-agent automation work under `PL-AI-0002`/`PL-AI-0003`.

### PL-AI-0001 — control-plane defects corrected (awaiting GPT architecture review)

Two defects were found and fixed in `scripts/ai-control-plane.mjs`. Gates are **not** yet
recorded: the local sandbox could not execute `node`, so nothing has been run.

**1. Dispatcher starved executable lanes.** The old `recommendWave()` scanned READY tasks in
priority order and greedily claimed the first fit. `PL-0002` (`docs/**`, `control/**`,
`coordination/**`) sorted early, so it consumed path ownership from five other tasks — and it
routes to `gpt-architect`, which has no local adapter, so the wave shrank to 3 tasks of which
only 2 were runnable.

Now tasks are classified `READY_AND_EXECUTABLE` / `READY_BUT_EXTERNAL` / `BLOCKED` / `BACKLOG`.
Executability is derived from `control/adapters.json` (`canExecuteCommands && canEditLocalFiles`),
not hardcoded. External lanes stay reserved for their agent and no longer participate in local
wave planning. Wave selection is a branch-and-bound search for a maximum feasible set under
dependencies, `allowedPaths` disjointness, capability and `maxParallel`, replacing the greedy
scan. Result: 4 executable tasks instead of 3, with `PL-0002` still reserved for `gpt-architect`.

**2. `done` accepted unreviewed work.** It only checked status, dependencies and gate presence —
never that a review happened. `ai:approve` / `ai:request-changes` now write a review record
(`taskId`, `implementationAgent`, `reviewerAgent`, `reviewerClass`, `reviewerProvider`,
`reviewedCommitSha`, `reviewedTreeHash`, `outcome`, `reviewedAt`, `evidence`) and `done` refuses
unless it is `APPROVED`, from exactly the task's `reviewAgent`, by an agent other than the
implementer, bound to the current implementation fingerprint. Automatic Claude-for-GPT
substitution is rejected by design.

The fingerprint is a SHA-256 over file contents under the task's `allowedPaths`, excluding
generated control-plane bookkeeping. Editing implementation files after approval invalidates it,
so stale approvals cannot complete a task.

**Review requested:** is deriving executability from `adapters.json` the right seam, or should
agents carry an explicit `executionAvailable` flag (currently supported as an override)? And
should `reviewedCommitSha` be authoritative over `reviewedTreeHash` once GitHub review exists?

### Reviewer deadlock in PL-AI-0002 — needs an architecture decision

`PL-AI-0002` has `preferredAgent: gpt-architect` and `reviewAgent: claude-lead`. Establishing the
git remote is inherently local execution that GPT cannot perform, and `claude-lead` is the only
registered agent advertising the `Coordination` lane. So `claude-lead` must implement it — but
`claude-lead` is also its reviewer, which the new self-approval rule correctly refuses.

`PL-AI-0002` therefore cannot reach DONE as currently specified. Recommended fix: swap the
routing to `preferredAgent: claude-lead`, `reviewAgent: gpt-architect`. This is coherent — the
bridge is local work, and once it exists GPT can finally see the repository to review it. This is
a task-definition change, so it is being escalated rather than applied silently.
