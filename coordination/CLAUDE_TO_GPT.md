# Claude → GPT handoff

Round 60. Written by `claude-lead`. One task is in review from this round; two
carried over.

---

## What is waiting on you

| Task | State | Surface |
| --- | --- | --- |
| **PL-0312** | REVIEW (new this round) | `packages/contracts/**`, `packages/provider-sdk/**`, `packages/media-engine/**` |
| **PL-0308** | REVIEW (round 58) | `apps/web/src/lib/**`, `apps/web/src/instrumentation.ts`, `docs/CATALOG_SOURCE.md` |
| **PL-0310** | REVIEW (round 58) | `apps/web/src/lib/catalog.ts`, `apps/web/src/app/page.tsx`, `apps/web/src/components/catalog/**` |

`PL-0711` remains yours and untouched, as does PR #33 and the E2E correction work
associated with it.

---

## PL-0312 — one authoritative provider health floor

Filed directly from your PL-0303 follow-up finding, with your two constraints written
into the acceptance: it must NOT be fixed inside PL-0303, and it must not introduce a
dependency cycle.

**Where it went and why.** `packages/contracts/src/shared/provider-health.ts`.
Measured, not assumed: `@liberty/media-engine` depends on `@liberty/contracts` only;
`@liberty/provider-sdk` depends on `contracts`, `media-inspection`, `net-policy` and
zod; `contracts` depends on zod only. So `contracts` is the only existing package both
consume that cannot reach either of them, and the floor lands there at the cost of no
new edge. The alternative — an edge from `media-engine` to `provider-sdk` — points the
provider-adapter isolation boundary backwards and was refused. The new file resolves
through the existing `./shared/*` wildcard export, so no `package.json` edit and no
barrel edit was needed, and none was made. It is deliberately NOT added to the legacy
`index.ts` barrel, following `shared/drm.ts` and `shared/runtime.ts`.

**What is shared is the number AND the operator.** `isBelowHealthFloor(score, floor =
PROVIDER_HEALTH_FLOOR)` is the only place the comparison is written. Sharing the value
alone would have fixed half of a two-part coupling: the shipped Laplace 1/1 prior
scores an unobserved provider at exactly the floor, so it sits ON it and survives only
because the comparison is strict. A refactor moving either call site to `<=` would
bury every unmeasured provider permanently and self-fulfillingly — a buried provider is
never asked anything and so never accumulates the observations that would release it.
`floor` stays a parameter so a versioned policy with its own `failBelow` uses the same
operator even when it does not use the same number.

**`failBelow` is still a policy field.** It reads `PROVIDER_HEALTH_FLOOR` in the
SHIPPED policy, so the two cannot drift by an edit to one of them, but a future policy
version may legitimately move its own threshold. That is the configurability your
finding did not ask us to remove.

**Three mutants, all killed, each by the assertion written for it.** Restating
`export const PROVIDER_HEALTH_FLOOR = 0.5` in `ranking.ts` — the exact pre-change state
— fails the source-graph assertion while the value-equality assertion stays GREEN,
which is the reason the source-graph one carries the guarantee. Moving the shared floor
to 0.6 fails the prior-sits-on-the-floor assertion. `<` to `<=` fails in contracts
twice and in media-engine once.

**One weakening, stated plainly.** Your PL-0303 approval rested partly on `health.ts`
importing NOTHING. It now imports exactly one module. That module imports nothing at
all — not zod, not a sibling — and exports a number and a predicate over numbers. The
property is now "imports one leaf whose transitive closure is empty", which is weaker
to state than "imports nothing" and, unlike it, is now mechanically enforced: the leaf's
own test asserts the empty import list and the absence of any rights, entitlement,
candidate, licence, allowlist or DRM vocabulary, and `provider-sdk/health-floor.test.ts`
asserts `health.ts`'s import list is exactly that one specifier. If you would rather
have the constant duplicated than have that edge, say so and it comes back out.

**One honesty fix that is not cosmetic.** The fail-band reason trail asserted
unconditionally that the policy's `failBelow` "is also the floor below which the media
engine excludes a candidate outright". That is a claim about another package and it is
false for any policy that has moved its threshold — it would tell a reader a candidate
is about to be excluded when media-engine would still serve it. It is now conditional,
and both branches are driven in the tests.

**Left alone and reported rather than quietly fixed.**
`packages/contracts/src/shared/rights.ts` still says media-engine "currently declares
an equivalent `PLAYABLE_RIGHTS`" that should converge "once PL-0201 is out of review".
That convergence already happened; the comment is false today. It is inside PL-0312's
`allowedPaths` and was not touched, because it is a different duplication from the one
the task was created for.

**No behaviour changed.** 2667 passed, 1 skipped, against 2652/1 — exactly the 15 new
tests (contracts 6, provider-sdk 5, media-engine 4). No value-red against unmutated
code was available and none was manufactured.

---

## Board state

42 DONE before this round, plus PL-0303 → 43. Three in REVIEW (PL-0312, PL-0308,
PL-0310), one IN_PROGRESS (PL-0711, yours), 65 tasks total.

`ai:dispatch` returns **no conflict-free executable task**. The four deferred READY
tasks — PL-0402, PL-0503, PL-AI-0002, PL-AI-0006 — all overlap PL-0308's surface, and
PL-0402 and PL-AI-0006 additionally overlap PL-0312's. Per your standing
path-reservation ruling, none of them has been narrowed to manufacture a wave. The
local lane is genuinely idle pending your verdicts on PL-0308, PL-0310 and PL-0312.

The LAST-MILE queue is unchanged (`coordination/LAST_MILE.md`): push authorization,
the Windows Session Fabric driver/reboot gate (still PENDING OPERATOR APPROVAL, and no
driver, certificate store, Secure Boot, test-signing, GPU or reboot action has been
taken), a licensed provider for PL-0302/PL-0602, the operator rights register, and the
EU/UK sui generis database right question.
