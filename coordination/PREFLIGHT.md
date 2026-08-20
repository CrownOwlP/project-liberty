# Preflight — what to check before handing a runner over

There is exactly one execution round trip per round: Diego double-clicks a batch file and everything
that was wrong comes back at once. So a defect that a careful read would have caught does not cost
seconds, it costs a round. Three consecutive rounds were burned this way, each on something visible
in a file that had already been read.

This is the checklist those failures produce. It is not general advice — every item below is here
because it actually happened.

## Run an adversarial read before every handoff

Not a self-review. A separate pass whose only job is to find the reason this will fail. If the
change is more than a few lines, that means a subagent with the diff and this checklist, because the
agent that wrote the code is the worst possible reviewer of it.

## The failure modes, in the order they have bitten

**1. A test asserting against live `control/tasks.json` or `.env.example` contents.**
Four instances across two suites: an exact dispatch wave, a milestone rollup `1/4 (25%)`, a
`--base auto` refusal that assumed a task had never been started, and a hardcoded list of expected
warnings. Every one broke because the *project made progress*, not because behaviour changed.

Grep the file being edited for hardcoded `PL-` identifiers and for literal expected-value arrays.
Behaviour scenarios use frozen fixtures; only the designated live-state guards read real project
data. **Never repair one of these by appending the new value to the expectation** — that edit is
byte-for-byte identical to appending one to silence a warning that should not have appeared, and the
diff gives a reviewer no way to tell which happened.

**2. Test files do not typecheck under this repo's strict settings.**
`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` apply
to `*.test.ts` too, and `npm run check` runs `build` (`tsc --noEmit`) after the tests pass — so a
green suite tells you nothing about whether the round will succeed. Specifically: helpers that strip
`undefined` do **not** narrow `null`. Read the helper's signature rather than trusting its name.

**3. `.env.example` prose that begins with an annotation keyword.**
A comment line whose first token is a known annotation **is** an annotation. `@cache-key` takes no
value, so a sentence explaining it is a parse error. Explaining an annotation and declaring one are
the same syntax to that parser. Start such sentences with an ordinary word.

**4. Anything added to `turbo.json` `globalEnv` must be declared in `.env.example`.**
Scenario 24 enforces it and will refuse the whole run. A new env var read by any code path is
usually three edits, not one: the contract, the turbo hash inputs, and the docs table.

**5. `git add` that does not cover every file changed.**
Easy to miss when a fix spills outside the directory the round was nominally about — a test fix that
also touched `.env.example`, `turbo.json` and `docs/`. Diff the staged list against the actual
working tree before committing, not after.

**6. cmd batch traps.**
Multi-line `if (...)` blocks containing `goto` make cmd abandon the whole region — it silently
skipped tests, gates, an approval and a stash pop in one round. Single-line `if ... goto :label`
only. And `npm` is a `.cmd`: invoking it without `call` transfers the batch context and never
returns.

**7. Parking work to land a task must park *every* lane.**
Stashing only the reviewed task's own paths left a different lane in the tree importing the symbols
that had just been stashed. Park `packages` and `apps` together, and make the pop reachable from
every path out of the script.

## The question to ask last

*What in this change assumes something I have not verified in this session?* Version numbers,
helper semantics, parser rules, and whether a path is inside some task's `allowedPaths` are all
things that were true once and are cheap to re-check. The three rounds above were each lost to a
fact that had been true earlier.
