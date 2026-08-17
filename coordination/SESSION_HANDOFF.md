# Session handoff — 2026-08-17 (second session)

`control/tasks.json` is the source of truth for task state. This file carries only
what the control plane cannot: decisions, open questions, and traps that cost time.

## Where things are

5 of 30 tasks DONE. `main` untouched at `b157a5846d45568f516240f581d6b317a544aa12`.
All work on `codex/pl-ai-0001-repair`, local head `c2597c80`.

**PL-0202 is APPROVED by gpt-architect but not yet DONE.** The approval is
conditioned on rerunning its `typecheck`/`unit` gates under genuinely pinned
Node 22, and it must be recorded with `--sha 26fd6607…` — the head GPT actually
reviewed, which is confirmed an ancestor of HEAD. **PL-0003 is IN_PROGRESS**
after a changes-requested verdict that has been fixed but not re-reviewed.

**Seven lanes are written, executed once, and green** — typecheck 5/5, tests 9/9,
lint, build, `test:scripts`, and `env:validate` across all three modes, all exit 0
under Node 22. None of them is claimed. They are: the PL-0003 rework, PL-0205,
PL-0203, PL-0204, PL-0102, PL-0103, and a PL-0301 rework.

## The one thing to do next, and why

Landing PL-0202 is the unlock. `ai:dispatch` currently says, in its own words:

```
PL-0102 — allowedPaths overlap active PL-0202
PL-0103 — allowedPaths overlap active PL-0202
PL-0203 — allowedPaths overlap active PL-0202
PL-0204 — allowedPaths overlap active PL-0202
PL-0205 — allowedPaths overlap active PL-0202
```

Five finished green lanes blocked on one task's path lock.

## gpt-architect's standing ruling on throughput — read this before adding agents

> Make contract ownership module-scoped, but do not make review invalidation
> module-scoped. Those are two different concepts and `allowedPaths` is currently
> doing both jobs.
>
> The highest-leverage move now is **not another agent**. It is removing the
> artificial package-wide contract mutex while preserving wide review
> invalidation where shared semantics actually matter.

Two prerequisite changes, in order: (1) extract the shared vocabularies out of
`packages/contracts/src/index.ts` and make it re-export-only; (2) split write
ownership from review scope — keep `allowedPaths` as the narrow collision scope,
add `reviewDependencies`, fingerprint reviews over the union, and have the control
plane enforce that every writable path is automatically in the reviewed surface.
Full ruling, including the five smaller task decisions, is in
`coordination/GPT_TO_CLAUDE.md`.

Do **not** just narrow today's `allowedPaths` and accept weaker fingerprints as the
price. GPT was explicit that the protection does not need trading away.

## Traps that cost real time

**The shell has been unavailable for two sessions.** Everything executes only when
Diego double-clicks `D:\project-liberty-tools\NEXT.cmd`, rewritten each round. That
folder is outside the connected workspace and needs `request_cowork_directory`
before it can be written. One execution round trip per round, so front-load
diagnostics and keep going past non-fatal failures rather than stopping at the
first.

**`npm` is a `.cmd`. Invoking it from a batch file without `call` transfers the
batch context and never returns** — it silently killed every step after the first
npm line for a whole round. Also avoid `>` inside `call :label "…"` arguments;
`%~1` expands before redirection is parsed, so an arrow in a message string becomes
a redirect.

**Parking work to land a task must park *every* lane, not the task's own paths.**
Stashing `packages/media-engine` and `packages/contracts` to give PL-0202 a clean
reviewed tree left the PL-0301 provider-sdk lane in the tree — and that lane imports
the symbols just stashed. 17 tests failed for reasons unrelated to audio selection.
Park `packages` and `apps` together.

**A task owning `control/**` or `coordination/**` cannot be approved casually.**
Nearly every control-plane command regenerates queues and status in those
directories, so anything run between the commit and the `approve` re-dirties the
tree and the approve is refused. Leave *nothing* in the gap. This cost three
attempts on PL-0002. The refusal is the binding working; do not weaken it.

**Pin the runtime.** `.nvmrc` pins Node 22, the machine default is 24. Resolve with
`npx -y node@22 -e "process.stdout.write(process.execPath)"`, prepend its directory
to PATH so `npm.cmd` picks it up, verify `node -v` starts with `v22.`, and abort
rather than fall back — a silent fallback is what produced a session of gate
evidence claiming Node 22 from a Node 24 process.

**GPT's verdicts arrive in ChatGPT, not the agent bus.** Its GitHub connector is
still read-only (403 on writes) and `coordination/agent-bus/gpt-to-claude/` is
empty. Read the "Liberty GPT Worker" conversation in the Project Liberty project
with the Chrome tools and transcribe with an explicit provenance warning. Open the
conversation in a **fresh tab** — reusing an existing one makes the composer refuse
focus and redirects to the project root.

## What works, and should continue

Implement, then run an **adversarial QA pass** before declaring anything done, then
fix what it finds. Every review round this session found defects that a green suite
would not have caught. The recurring shape is worth internalising: **a determinism
or safety claim that holds only in the configuration the tests happen to use.**
Five separate instances so far — `manualOnly` in provider order; `rejected` in
provider order; a dedupe keyed on a string that differs per mode by construction, so
it could only ever collapse on a machine with no `.env.local`, which was also the
only case the suite covered; duplicate collapse that was order-dependent for three
or more duplicates but not two; and a failure-precedence table that silently took
its ordering from a zod enum declaration.

When QA runs concurrently with implementation agents, **its reads can be stale** —
it reported two barrel exports missing that had landed minutes later. Verify a
blocking QA finding against the current file before acting on it.
