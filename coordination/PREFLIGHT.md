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

**8. A phase that reports success on the strength of half its work.**
A multi-phase runner gated each phase on its `git commit` and printed `landed`. In one phase the
commit succeeded while the `claim` before it had been *refused* — the task was dependency-gated and
the control plane was right to say no — so the code shipped, the task state did not move, and the
summary said `landed`. Gate a phase on **every** step whose failure would make the summary a lie, not
just the last one. If a phase does control-plane work and repository work, it has two success
conditions and needs to report both.

**9. Filtering a phase to a package filters the checks too.**
Gating a phase on `turbo run typecheck` and `test` filtered to its own package missed a lint error,
because most packages define `lint` as `tsc --noEmit` — so typecheck appears to cover it — while
`apps/web` runs real eslint. A per-package gate must run every task the full check would run for that
package, or it is not a gate, it is a subset that happens to agree most of the time.

**10. A per-layer check cannot see a composite failure.**
Three rounds went to configurations in which every layer worked and reported truthfully while the
composite was wrong. An unrelated app was holding the port and answering **200 to every path**, so
"the server is up" and "the route exists" were both confirmed by a process that had never heard of
this project. Next read dotenv from `apps/web` while the value was being written to the repo root,
so "the variable is set" and "the app reads the variable" were each true of a different directory.
Neither round had a failing check; each had a set of passing checks about the wrong things.

A gate must assert the **end-to-end fact** — *does the running app resolve the origin* — not the
per-layer fact — *does an origin exist somewhere*. If the checks decompose the question into parts,
at least one of them has to put the parts back together, or the composite is the one thing nobody
verified.

**11. A returned HTTP 200 is not evidence of identity.**
It says something answered. It does not say *what* answered, or that it answered the question you
asked. Check the payload: a byte of the response that only the intended service could have produced.
This is the specific form item 10 took twice, and it is cheap to defend against — `curl` the route
and look at the body, not the status line.

**12. A comment claiming two components are aligned is not alignment.**
`playback-machine.ts` documented its `failures` list as "feedable straight into `planFailover`" while
never calling it, and its own hand-rolled scheduling had drifted from the engine's — it tried a retry
before a fresh candidate, so a four-attempt budget could be spent two-apiece on two candidates while
a third authorized stream was never loaded once. The divergence survived review precisely *because*
both sides were individually well-tested: each suite proved its own half correct, and no suite
existed for the sentence connecting them. Either call the shared thing, or write the test that would
fail when the two disagree. A prose assertion of agreement between two implementations is the
strongest available signal that they will disagree.

**13. Fixing a defect in a module nothing calls changes nothing.**
The breadth-before-depth scheduling fix had already landed in `@liberty/media-engine` and was
correct there. Real playback never read it, so the bug it fixed was still shipping. Before trusting a
fix: grep for the symbol's importers, exclude the test files, and confirm at least one live code path
reaches it. "The test passes" and "the fix is in the product" are different claims, and a fix in dead
code produces the first without the second.

## The question to ask last

*What in this change assumes something I have not verified in this session?* Version numbers,
helper semantics, parser rules, and whether a path is inside some task's `allowedPaths` are all
things that were true once and are cheap to re-check. The three rounds above were each lost to a
fact that had been true earlier.
