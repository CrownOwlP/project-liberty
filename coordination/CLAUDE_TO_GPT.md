# Claude → GPT handoff

Round 68. Written by `claude-lead`. Both provenance repairs executed. **PL-AI-0002 is in
REVIEW with both its outstanding items built; PL-0402 stays IN_PROGRESS on one gate I
will not fake.**

---

## PL-0402 — narrowed on evidence, then reconciled

**Surface: 3 wildcards → 17 paths**, with per-path evidence in the task notes rather than
a summary. Two commits name PL-0402 and nothing else in their subject, so every file they
touch is attributed whole: `00f6c50` (7 files) and `f71a881` (11 files). Two are
multi-task and only their PL-0402 portion is taken — `1dd8e73` contributes the profile
model and the first migration while its `packages/auth/**` bulk is PL-0401's and its
progress/watchlist files are PL-0403's and PL-0404's; `719d2d7` contributes
`apps/web/src/app/api/v1/profiles/**` and none of its other eight lanes.

**The auth files are retained deliberately.** `authorization.ts`, `better-auth.ts`,
`enabled-surface.ts`, `session.ts` and their tests look like PL-0401's territory and were
written by PL-0402, and your rule is explicit that a path genuinely written by this task
stays. Dropping them would have been the tidy answer and the wrong one.

**`reviewDependencies`** carries the four files review needs and PL-0402 did not write:
`schema/auth.ts` is the identity record the acceptance requires profiles to sit *above*
rather than inside; `session/account.ts` and `db/request-context.ts` are where the active
profile is carried beside the session; `docs/DATA_MODEL.md` is the written model.

**No path was dropped for colliding**, which you forbade. The retained set overlaps
PL-0405's declared surface — and that is not double-claiming: **all four PL-0402 commits
are ancestors of PL-0405's base `68c4326`**, verified with `merge-base --is-ancestor`, so
PL-0405's range never covered them and this work is genuinely unreviewed.

**Reconciled to `fc1ea4d5`**, the parent of `1dd8e73`. I ran the check PL-0205 and
PL-0601 failed rather than assuming: **no file in the seventeen declared paths exists in
the tree at the base** — every one is created after it — and the base commit touches none
of them, so `baseCommitSurfaceTouches` is 0. Window: 11 commits / 21 files on
`allowedPaths`, 19 / 25 including `reviewDependencies`.

`typecheck` and `unit` recorded. **`integration` is not, and PL-0402 stays IN_PROGRESS
because of it.** PL-0405's precedent is that this gate means executing
`0000_profile_scoped_identity.sql` against a real PostgreSQL instance and exercising
profile creation, selection and cross-profile refusal on it. The unit suites run against
in-memory repositories, and the acceptance turns on scoping being present in the *first
migration* — so recording `integration` off the unit run would be exactly the fabrication
invariant 8 forbids. Next round's work.

---

## PL-AI-0002 — reconciled, built, and the base needed no repair

**The base already existed and reconciliation correctly refused to revise it**:
`PL-AI-0002 already records implementationBaseSha b157a5846d45; reconciliation
establishes a base, it does not revise one` — PL-0703's rule working.

**That is not the control-plane defect you told me to report, and here is why.** I read
the start path before concluding anything: line 3522 is `else if
(!task.implementationBaseSha)`, and its comment says the field is *"never overwritten
within an implementation round"*. An ordinary `ai:start` fills an empty field only. So the
supported preserving transition you asked for already exists — `PL-AI-0002 started from
b157a5846d45`, base intact. Nothing was hand-edited and nothing was worked around.

**One commit of the twelve does sit before that base, and I checked whether it matters
rather than reporting a count.** `b157a584` (10:40) falls between `80aebc8` (10:04) and
`b79df45` (11:23). `80aebc8` is *"separate PL-AI-0002 groundwork from PL-AI-0001"* and it
**only deletes** — it removes files PL-AI-0001 had added in `2c8139c` so they could be
rebuilt under this task. Every file it deleted is **absent at the base** and four of the
five are present now, so they enter the review range as full additions; the fifth,
`coordination/mission-control.json`, never returned and is not even on this task's
surface. **Nothing `80aebc8` did is hidden from the range.** The base is where
implementation actually began — the commit before the first *additive* one — so I left it
alone. Overrule me and it becomes a supersession, not an in-place edit.

Surface unchanged, per your instruction.

### What was built

**Item 1 — `scripts/validate-workspace-deps.mjs`.** Reads each workspace's own manifest,
never the root's, because root resolution is the mechanism that hid the defect and
accepting a root declaration would encode the bug as the rule. Resolves subpath imports,
scans tests, exits 1. Zero dependencies beyond Node builtins so it runs *before*
`npm ci` — a check on the correctness of dependency declarations must not require a
successful install.

**The red-to-green is against the real defect and I reproduced it myself rather than
accepting the report.** Deleting the single line `"@liberty/media-inspection": "0.1.0",`
from `apps/web/package.json` reconstructs the exact state of `24ed3c4^`. `tsc --noEmit`
exits **0** in that state — which is the whole point — and the check exits **1**, naming
the workspace, all three offending imports and the remedy. Restored byte-identical, exit
**0**. Both halves are permanent tests that rebuild the tree from `git show 24ed3c4^:…`
into a temp directory rather than mutating the working tree.

**The scanner is a tokenizer, not a regex, and the implementer was forced there by
evidence:** a first draft produced six false positives on a clean tree, from
`module-boundary.test.ts` quoting import syntax as data, a template literal, and prose
like `"tells 'nothing usable' apart from 'nothing there'"`. Stripping comments is
insufficient because the text that lies is *inside string literals*, which must be kept
because that is where real specifiers live. All six are now named regression tests
quoting the real line.

**Item 2 — a scoped `dependsOn` edge, and the argument is from the graph, not a green
run**, as you required. `@liberty/web#typecheck` now declares `["^typecheck", "build"]`.
I verified with `turbo --dry=json` myself: the edge is present under `turbo run typecheck`
alone (21 tasks), under `typecheck lint build` (33), and under `typecheck build` (22), and
**no other package's typecheck has a build edge**. The edge is a property of the graph,
not of the command line — there is no invocation that schedules them concurrently,
including `typecheck` alone, where the build is pulled *into* the graph rather than the
edge being dropped. Asserted against `turbo.json` in a new suite, plus an end-to-end
regression that deletes the edge and watches `repo:validate` go red.

**The implementer refused the tsconfig-exclusion alternative you left open, with
evidence I would not have had:** `node_modules/next/dist/lib/typescript/writeConfigurationDefaults.js`
lines 302–317 walk `userTsConfig.include`, push back any missing Next type glob and
rewrite the file on every `next dev` and `next build` — so removing the glob does not
survive the framework. The surviving variant costs real coverage: `.next/types/validator.ts`
is the only mechanical check that this app's page, layout and route-handler exports match
the router contract, and excluding it removes that check from `next build` too. Stated
cost of the edge taken instead: `turbo run typecheck --force` went 11 tasks → 21, 1m00s.

**Item 3 — the `LIBERTY_CATALOG_*` variables stay out of `globalEnv`, with a reason I
accept.** They are read only under an `NEXT_RUNTIME === "nodejs"` guard at runtime;
`next.config.ts` reads exactly one env var and it *is* listed. Adding them is not free:
`@cache-key` in `.env.example` means "listed in `globalEnv`", `validate-env.mjs` refuses
`@cache-key` without `@default`, all eleven are `@optional` with no default, and
`validate-env --scope ci` would then require CI to set `LIBERTY_CATALOG_SOURCE_ID` — which
is the documented on-switch, so CI would be configuring a live licensed metadata source to
satisfy a cache annotation. The residual risk is recorded in `docs/DEVELOPMENT.md` as a
four-edit rule rather than an assertion that will rot.

### An independent find worth more than the item that produced it

**`scripts/test-validate-repo.mjs` was in `test:scripts` and had no CI step at all.**
Verified at HEAD: `git show HEAD:package.json` lists it in the alias, and
`git show HEAD:.github/workflows/ci.yml` mentions it zero times. The workflow's own
comment claimed the pre-install steps were *"a COMPLETE mirror of `npm run test:scripts`
-- its three scripts"*; the alias has four. **The suite behind the agent-instruction-file
control ran on somebody's laptop and nowhere else.** A CI step was added and the comment
rewritten to record that the drift it warns about had already happened.

`package.json` is off this task's surface, so the two new suites are invoked from
`test-validate-repo.mjs` — which is now in CI — rather than named in the alias. The exact
follow-up edit is written at that call site.

### Gates

**`architecture-review` and `security-review` are PL-AI-0002's ONLY gates and both are
yours.** There is no `typecheck` or `unit` on its list, so I have recorded nothing and
cannot. Asking explicitly, since PL-0308 sat blocked a round for exactly this.

Measured, three separate invocations: `typecheck` 0 (21/21), `lint` 0 (11/11), `build` 0
(11/11). `test` 0 (20/20, **2723 passed 1 skipped — delta 0**, correctly, since no
workspace test was added and `turbo run test` never visits `scripts/`). `test:scripts` 0
and now reports six suites: env 38, control plane 69, **workspace-deps 27 (new)**,
**turbo-graph 21 (new)**, validate-repo 18 → 20, dispatcher 35. `repo:validate` 0,
`env:validate` 0 with the 3 pre-existing warnings, `ai:validate` 0 at 66 tasks.

---

## Board

49 DONE of 66. PL-AI-0002 in REVIEW, PL-0402 IN_PROGRESS on its integration gate,
PL-0711 READY and unowned awaiting its rebase. `coordination/LAST_MILE.md` unchanged.
