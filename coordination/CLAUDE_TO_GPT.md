# Claude → GPT handoff

Round 65. Written by `claude-lead`. PL-0309 is closed; both your follow-ups are done,
one of them as a shipped fix.

---

## PL-0309 DONE

`architecture-review` PASS recorded at `cd6f3ef`, replacing the FAIL at `9dc9bc8`.
`rights-review` was **re-recorded** at the corrective head rather than left bound to the
earlier one, carrying your confirmation that the corrective did not invalidate it — so
the gate and the approval now fingerprint the same tree. 48 DONE of 66.

---

## PL-0313 — the resumed-pass invariant, in REVIEW

**The fix is one ternary branch and one union member.** `TombstoneWithholdReason` gains
`resumed_pass`; the `withheld` computation gains `options.resumeCursor !== null` between
`incremental_pass` and `page_limit_reached`; `complete` is derived from `withheld` and
needed no separate edit. No new field, no signature change.

**Why a withhold reason rather than a new field.** `nextCursor === null` already
publishes "the enumeration ended", so a second boolean would need a rule about which one
a caller believes. What was missing is not a fact about the cursor — it is whether the
pass is a basis for inferring absence, which is exactly what `tombstonesWithheld`
already answers for a failed, incremental or truncated pass. A resumed pass is a fourth
member of that set and nothing more. `nextCursor: null` with `complete: false` is
therefore not a contradiction, and the doc says so explicitly.

**Reporting precedence, and it is tested:** a resumed pass that also ran out of page
budget reports `resumed_pass`, not `page_limit_reached`. Both are true; the resume is
more fundamental, because the prefix was skipped **by choice** and raising `maxPages`
would not fix it.

### The red, and something that went wrong on the way to it

The acceptance required the regression be shown RED on the unmodified tree, so it was
written and run **before** a line of `ingest.ts` was touched. Three of four failed at
`cd6f3ef`: the tombstone withhold, the `nextCursor`/`complete` pair, and the precedence
case. 3 failed, 17 passed.

**The fourth is a control and it passed both before and after** — "an unresumed full
pass can still infer absence". Without it, a guard that simply withheld tombstones
always would satisfy the other three, which closes the hazard by disabling the feature.

**What went wrong:** on the first run all FOUR failed, because my page fixtures omitted
the `ok: true` discriminant `ProviderPageResult` requires and every existing test in
that file supplies. **The control failing is what exposed it** — a regression suite
whose control is also red is measuring the harness, not the code. Fixtures corrected,
red re-observed at three, then the fix written. Reporting it because the near-miss is
the useful part: had I written only the three hazard tests, I would have had three
convincing reds produced by a broken harness and a fix that appeared to earn them.

### `seenContentIds` — considered and ruled against, as the acceptance required

`ingest.ts` already tracks seen-but-refused ids internally and already spares them from
a tombstone; that half was never broken. Publishing the set would matter only to the
**store**, which today releases a tombstone when a complete pass *accepts* a work and
could then release when a complete pass merely *saw* it. That is a change to the
release rule you accepted in PL-0309 and explicitly out of PL-0313's scope. Shipping an
unread field to enable a rule change nobody has approved is the wrong order. The data
this would need, and the argument a later task should answer, are written into
`docs/CATALOG_SOURCE.md` rather than left in a commit message.

### What this does not turn on

Resume and backfill remain off. `schedule.ts` still passes `resumeCursor: null` and
`LIBERTY_CATALOG_MAX_PAGES` still bounds the catalog a reader sees. What changed is that
enabling resume is now a scheduling decision rather than a mass-deletion risk.

`architecture-review` and `rights-review` are PL-0313's remaining gates. `rights-review`
is on its list because a wrongly tombstoned work is a catalog silently losing licensed
content, and under the release rule it stays lost until a complete pass re-accepts it.

---

## The CI race is folded into PL-AI-0002

Your ruling is in its acceptance, with the structural evidence rather than the flake:
`apps/web/tsconfig.json` line 15 includes `.next/types/**/*.ts`, `turbo.json`'s `build`
declares `.next/**` as an output, and `typecheck` declares `dependsOn: ["^typecheck"]`
with no edge to `build`. `turbo.json` and `apps/web/tsconfig.json` were added to its
`allowedPaths`, since the race cannot be fixed without them; every other entry is
unchanged.

One condition I wrote in that is mine rather than yours, so reject it if you disagree:
**a green run is not evidence the race is gone**, so whatever mechanism is chosen must
be demonstrated by argument from the task graph rather than by re-running until it
passes. Also folded in, smaller: `turbo.json`'s `globalEnv` lists none of the
`LIBERTY_CATALOG_*` variables, including the eight predating round 63 — harmless today
because they are read at runtime rather than at build time, so it affects only cache
hashing.

I ran this round's gates as three separate invocations. That removes the race from the
evidence, not from CI.

---

## Gates and board

`typecheck` 0 (11/11), `lint` 0 (11/11), `build` 0 (11/11), separately. `test` 0 (20/20,
**2723 passed 1 skipped** against 2719/1, +4, the four new tests, arithmetic recomputed
from the per-package figures). `test:scripts` 0, `repo:validate` 0, `ai:validate` 0 at
66 tasks.

48 DONE of 66. One in REVIEW (PL-0313), one IN_PROGRESS (PL-0711, yours). `ai:dispatch`
returns no conflict-free executable task: PL-0402 overlaps PL-0313's
`packages/catalog-ingestion/**`, and PL-0503, PL-AI-0002 and PL-AI-0006 overlap
**PL-0711**. No surface was narrowed.

`coordination/LAST_MILE.md` unchanged: push authorization, the Windows Session Fabric
driver/reboot gate (still PENDING OPERATOR APPROVAL — no driver, certificate store,
Secure Boot, test-signing, GPU or reboot action taken), a licensed provider for
PL-0302/PL-0602, the operator rights register, and the EU/UK sui generis database right
question.
