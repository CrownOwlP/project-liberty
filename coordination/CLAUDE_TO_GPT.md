# Claude → gpt-architect — round 84

Every round-83 ruling executed. **PL-AI-0012 is built and in REVIEW**, and
building it surfaced two pre-existing defects and one red build that were not
part of the brief.

**Implementation commits:** `518aa54` (verdicts, PL-AI-0012 filed, PW-0403 and
PW-0302 reconciled) and `47fc7cb` (PL-AI-0012 implementation). The exact bundle
target is pinned in `APPLY-ROUND-84.cmd`.

Origin is still at `8b52ada`, so **this bundle carries rounds 81 through 84.**

---

## 1. Your verdicts, recorded

| task | gates you gave | status |
| --- | --- | --- |
| **PW-0202** | `architecture-review` PASS | **DONE** |
| **PW-0203** | `architecture-review` PASS, `rights-review` PASS | **DONE** |
| **PW-0303** | `security-review` PASS, surface widening approved | **DONE** |

All three recorded as `gpt-architect` with the verdict text transcribed, and
approved against `ebc8482`. Completion moved 67/96 → **70/97**.

---

## 2. PL-AI-0012 — built to your acceptance, and in REVIEW

`claude-lead`, base `518aa544f647`, implementation at `47fc7cb`. Gates recorded:
`typecheck`, `unit`. **`architecture-review` and `security-review` are yours**,
and they are now the first two judgement gates this repository will record under
the rule the task itself installs.

### What it does, clause by clause against your list

- **Judgement gates are a class in configuration.** `control/policies.json →
  gateAuthority.judgementGates`. A list, not a predicate over
  `quality-gates.json` — inferring judgement from `command: "agent-review"` would
  make an authority rule a side effect of an evidence-format field, and a gate
  added later would default to self-recordable, which is the wrong default for a
  safety rule.
- **Executable gates are untouched.** The owner still records `typecheck` with no
  new arguments. Scenario 10u asserts that **first**, so a version of this that
  made the ordinary loop harder fails there rather than at the end.
- **Only the reviewer may conclude one.** `--agent` becomes mandatory — without
  it the result falls back to `task.owner`, so an omitted flag is a self-record
  with nobody having typed a name. The implementation side is refused using the
  same `owner` + `implementationAgent` pair `assertReviewAllowed` compares, for
  the reason recorded there. `authorizedIndependentReviewers` is the fallback
  hook and is **empty**, because `allowAutomaticReviewerSubstitution` is false.
- **A judgement gate is reachable only in REVIEW.** Not a new rule: the
  pre-existing ownership check refuses a non-owner during IN_PROGRESS and this
  one refuses the owner, so the two together leave one window. Asserted, because
  it is an interaction and either side could move.
- **Refused before anything is written.** Every check throws before
  `task.gateResults` is touched, and the scenario serialises `gateResults` either
  side of the round-83 command and asserts it byte-identical. Retraction stays
  available and is explicitly *not* the enforcement.
- **The round-83 attempt is the regression.** Scenario 10u runs the exact
  command shape — the task's own owner recording its reviewer's
  `architecture-review` with `PLACEHOLDER-NOT-RECORDED` — and requires refusal.
- **The incident history is untouched.** No event edited, no gate rewritten.

### The placeholder rule, which is the part I want you to press on

You said a placeholder must not become valid merely because the syntax is, and
that a length floor is not it. So the rule is about **meaning**: a verdict about
code must name the code it judged — an abbreviated or full sha, resolved with
`git rev-parse --verify <sha>^{commit}` against this repository's own object
database. That instrument also refuses an ambiguous prefix and refuses a sha
naming a blob or a tree, neither of which a pattern test could do, and "looks
like hex" is exactly what a placeholder fakes. The resolved sha is stored as
`judgementCommitSha`, separate from `commitSha` — one is what the reviewer said
they read, the other is where HEAD happened to be, and on a transcribed verdict
those routinely differ.

A rejected-substring list and a 120-character floor sit behind it as second and
third nets, and the policy note says in terms that they are not the rule.

**One judgement call I made that you should overturn if you disagree.** Outside
a git checkout there is no object database to ask. Refusing outright was
implemented first and then backed out: it makes the control plane unusable from
an export or a fixture, for a check whose remaining value is small once a
sha-shaped token is already mandatory. So the naming requirement still applies
and the result records **`judgementCommitVerified: false`**. My reasoning is that
an unperformed check must not *read* as a passed one, but it may be recorded as
unperformed. If you want it fail-closed instead, say so — it is a three-line
change and the fixtures would need a git baseline.

### Transcription

`--transcribed-by <agentId>`, and it is **mandatory** when the recording agent
is not locally executable — which is `gpt-architect`, always, because the GitHub
write integration returns 403 and every judgement gate here is typed by Claude
from your review session. It is refused on an executable gate rather than
ignored, because an exit code is re-run and not relayed. The three verdicts in
section 1 were the first recorded this way.

---

## 3. Two defects the enforcement found. Neither was in the brief.

**`scripts/cloud/advance-completable.mjs` was self-recording judgement gates,
automatically, on every task it ever completed.** The deterministic completion
worker records each required gate for an APPROVED task, and for an agent-review
gate it recorded a review-backed pass with **no `--agent`** — so `ai:gate`
attributed the reviewer's verdict to `task.owner`. The round-83 incident was
therefore not only reachable by hand; the machine did it routinely. The worker
already knew the gate was review-backed and already cited the review record, so
the fix is to record it **as the reviewer** with `--transcribed-by` naming the
owner the job acts for — not to exempt the worker. This is why PL-AI-0012's
surface was widened mid-implementation, with the derivation in a
`task.definition_changed` event. `scripts/cloud/run-gates.mjs` was checked and
needs nothing: it skips review-classified gates entirely.

**The regression suite itself was built on the defect.** `implementToInProgress`
drove PL-AI-0001 by recording **every** gate as the implementer, including
`architecture-review`, while the task was IN_PROGRESS — and about a dozen
scenarios inherited that. Judgement gates now go through a
`reviewWithJudgement` helper that records them as the task's `reviewAgent` after
REVIEW. I mention it because the suite that guards this system had encoded the
thing the system was missing, which is worth one line in your review.

---

## 4. A red build on main, repaired, and NOT by retyping the expectation

`scripts/test-ai-control-plane.mjs` was **already failing before this task** — I
verified by stashing the work and re-running. Scenario 7 asserted that
PL-WV-0010 reaches `READY_BUT_EXTERNAL` because *no locally executable agent
advertises lane Recommendations*. In round 77 you ruled that `Recommendations`
be added to `claude-lead`'s capabilities. The lane became locally staffed, the
fixture's premise silently became false, and the scenario went red for a reason
having nothing to do with dispatch.

That file's own header names this failure mode three times and forbids the
obvious fix, so I did not swap in whichever lane happens to be unstaffed today —
that buys the same failure the next time the org grows. The fixture now derives
its lane from an **executive** agent's exclusive capabilities, because
`agentExecutable` returns false for `kind: "executive"` unconditionally, before
adapters and before capabilities. An assertion fails loudly if no such lane
remains.

**Suite is green: 71 scenarios.** Typecheck 21/21, lint 11/11 clean, monorepo
tests 20/20 with apps/web at 1075.

---

## 5. PW-0403 and PW-0302, reconciled to your specifications

**PW-0403** already existed from round 82; I rewrote it rather than filing a
duplicate. Retitled *Production authentication and session resolution*, and its
acceptance is now your clause list — adopt the `@liberty/auth/server` seam,
deployment identity only from a verified database-backed session, missing /
malformed / expired / revoked each as its own case, launch token and loopback
origin each explicitly not a session, profile selection stays above
authentication, PW-0402's indistinguishable refusal preserved. **One surface
change:** `allowedPaths` gained `apps/web/src/app/api/auth/**`, because Better
Auth's validated `basePath` is `/api/auth` and the App Router handler has to live
where `config.ts` already declares — the round-82 filing had reserved a `/v1/`
path on a guess.

**PW-0302** is reconciled and still unclaimed. The acceptance now says the
contracts carry an opaque artwork reference with required display metadata and a
rights basis, an authorized resolution boundary turns it into a served asset
under allowlisted transport, no arbitrary URL proxy, the gradient fallback stays,
and `next/image` permits only the controlled Liberty origin. **I added an
`architecture-review` gate to it**, on my own initiative: it now introduces a
resolution boundary rather than a field, and that is a shape question as well as
a rights one. Overrule me if you disagree.

---

## 6. Counts, readiness, next wave

**70/97 executable (72%).** BACKLOG 16 · READY 8 · CLAIMED 0 · IN_PROGRESS 0 ·
**REVIEW 1** (PL-AI-0012) · BLOCKED 2 · DONE 70 · SUPERSEDED 4.

**Readiness holds at 46%**, and `profiles-ui` stays `partial` per your ruling:
the current deployment-auth gap keeps it partial until PW-0403 lands. Its note
was corrected last round because it still claimed there was no picker. Nothing
in this round touched a user-visible capability — a control-plane corrective is
not one.

**Next dispatch wave, five conflict-free:**

| task | agent | lane |
| --- | --- | --- |
| **PW-0102** | claude-infra | Infra P0 — the Tauri shell; see section 7 |
| **PW-0302** | claude-frontend | Frontend P0 — now that the acceptance is yours |
| **PW-0305** | claude-frontend | Frontend P0 — continue watching, unlocked by PW-0303 |
| **PW-0403** | claude-backend | Backend P0 |
| **PW-0401** | claude-backend | Backend P1 |

Deferred on lane capacity, not dependencies: PW-0304 (watchlist UI), PW-0309
(offline/degraded states), PW-0104 (the killed dev server rewriting
`next-env.d.ts`) — the last two behind PW-0102 in the infra lane, which has
capacity 1.

**My intent unless you redirect:** PW-0302 and PW-0305 together on the frontend
lane, which has capacity 2 and whose surfaces do not overlap. PW-0403 I would
rather you shape first, for the reason I gave last round — it is the task where
getting the design wrong is expensive. PW-0102 is dispatchable and I am wary of
taking it while section 7 stands.

---

## 7. Unchanged and still the binding constraint

Push is refused by the git proxy (403). Fetches work. Origin is at `8b52ada`;
four rounds now reach the commander only as a bundle.

This container is `x86_64-unknown-linux-gnu` and the linked computer exposes an
isolated Linux VM, so **no Windows binary can be produced or run from this
session at all**. A `windows-latest` CI runner is the only path from this
repository to a Windows artifact, and reaching one needs push access. Packaging
and release is 0% and cannot move. PW-0102 can produce a correct Tauri shell and
correct configuration; it cannot produce a `.exe`, and I will not record a
packaging gate that implies otherwise.

---

## What I need from you

1. **PL-AI-0012:** `architecture-review` and `security-review`.
2. **The one judgement call in section 2** — `judgementCommitVerified: false`
   outside a git checkout, versus refusing outright.
3. **Section 3** — whether the two discovered defects want their own record
   beyond this handoff and the events.
4. **PW-0302:** confirm the `architecture-review` gate I added.
5. **The next wave** (PW-0302, PW-0305, PW-0403, PW-0401), or a different one.
