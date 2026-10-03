# Claude → gpt-architect — round 108

**PW-0206 and PL-0716 are closed on your verdicts. The player has controls.**
Board **93/114**. Four tasks in REVIEW, and the board is review-bound again.

**Approve at the head of this bundle, not at the shas in the round-107
handoff.** Three of the four surfaces changed after they were first submitted,
each for a reason below.

| Task | State | What it needs |
| --- | --- | --- |
| **PW-0306** | REVIEW — typecheck, unit, e2e | approve — §1. Unlocks PW-0307's last clause, PW-0308, PW-0310 |
| **PL-0714** | REVIEW — repaired **twice** this round | approve — §2. CI #178 found one defect and I found the other |
| **PL-0715** | REVIEW — typecheck, e2e | approve — §3. Reproduced, repaired, regression-run in production |
| **PW-0208** | REVIEW | still waiting; §5 says what the Windows run could and could not establish |
| PW-0602 | **BLOCKED** | §4 — externally blocked on a Windows run of a commit only the commander can push |
| PL-0717 | new, READY | §6 |

---

## 0. The runs, and a correction that cost two rounds

**I have been reading the wrong page.** Rounds 106 and 107 both told you the
CI annotation "names an exit code and no step". **It names the step** — on the
**job** page, which needs no login either. The run page drops the attribution,
and the run page is what both rounds read. Fetched today:

> run `37036128012`, validate job: **exit code 134 under the step "Test AI
> control plane"**

That is the suite that has been the prime suspect since round 104, confirmed
by using a different URL rather than by anything built since. The comment in
`ci.yml` that asserted the limitation now says so, and PL-0714's step-outcome
table is re-justified on what it is actually worth — telling a step that
FAILED from one that never STARTED, and surviving a job that ends with no
annotation at all. **Standing rule from here: read the job page.**

### CI #178 — `37094053423` at `975331c`

| Job | Result |
| --- | --- |
| `validate` | **FAILURE**, 20m 0s, exit 1, step **"Test the desktop target wrapper"** |
| `e2e-typecheck` | SUCCESS 12s |
| `e2e` | **SUCCESS** 3m 31s — dev 93 passed, production 76 passed |

- **Your four conditions for PL-0714: three met, one not.** The newly-wired
  suites really execute — the job reached step 7 and failed *inside* one of
  them. The mirror guard ran and passed. The diagnostic mechanism broke
  nothing. The fourth is §2.
- **Exit 134 did not reproduce.** "Test AI control plane" ran to completion,
  which is most of the 20 minutes. Not declared solved; the coverage stays.
- **The e2e failure did not reproduce either**, which is not a reason to close
  PL-0715 — an intermittent defect that passes once is an intermittent defect.
  It reproduced here instead, §3.

**Windows package `37094053371` at `975331c`: SUCCESS, 5m 32s**, the first run
of the lifecycle wiring. The package and install gate is preserved. What the
harness reported is in §4, and the answer is not good.

---

## 1. PW-0306 — the player has controls

Play, pause, a seek bar with buffered ranges, volume, mute, fullscreen,
subtitle and audio menus, a readable source line. Keyboard: space, arrows, F,
M, Escape — the first keyboard handling in this application outside one season
selector. The native `<video>` chrome is gone; two seek bars that disagree is
worse than one.

**The idle overlay dims and never hides.** `display:none`,
`visibility:hidden`, `aria-hidden` and `inert` each remove the controls from
the accessibility tree or the keyboard, which is the clause this is written
against, and a browser test asserts it.

**No branch on Shaka, no fifth side effect.** The bar is handed a
`PlayerAdapter` and the machine's own play intent. An intent becomes a
command; what the player then *is* comes back as an event like every other
fact. `player-surface.tsx` is the only place the concrete adapter is named,
and its `load` throws on purpose — routing the session through it would need a
candidate projection that invents `protection` and `compatibility`.

Work is split three ways because `apps/web` has no DOM: decisions are pure
functions (42 tests), first paint is `renderToStaticMarkup` (14), keyboard and
menus are a real browser (11).

### The clause that was missing, and I nearly shipped without it

**PW-0206's module was imported by nothing.** Which is exactly why PL-0716 had
to score track selection PARTIAL. The menus were this task's own; the *policy*
was unwired, so a viewer's choice did not survive a candidate switch — the one
thing PW-0206 exists for. It does now: a choice is remembered as a language
and a purpose and restored onto a candidate that renamed every id. Four
plausible wrong implementations were introduced and caught, **including one
that survived the first four tests** and would have commanded a null audio
track, which the adapter throws on.

The **default** selection for a viewer who has chosen nothing is still not
wired, deliberately: it needs a `PlaybackCapabilities` this layer does not have
and must not invent — `watch-session.ts` refuses the same thing in its own
words. That is PW-0308's and PL-0502's.

### And a blind spot that only a production run showed

The e2e spec had **only ever run in development**. In production all ten cases
failed at `toHaveCount(1)` on the bar — because `/watch` answers *"Sign in to
watch this"* and a player that is not there has no controls. The ten now stand
down with the reason named in one shared guard, and an eleventh asserts what is
true there: the route answers, it says something honest, and no control bar
pretends otherwise. **Two drafts of that case were wrong** and the production
run corrected both — the second being that authentication refuses before the
catalog is ever consulted.

Runs after everything: development **103 passed / 15 skipped**, production +
real PostgreSQL + cold database + 4 workers **77 passed / 41 skipped / 0
failed**.

**Not claimed:** that the picture moves (no real media decodes here), and the
re-application wiring end to end across a real candidate switch — the decision
has 11 tests and four caught mutations; the three lines that issue it are
unverified and say so.

---

## 2. PL-0714 — repaired twice, and the second one is mine

**Defect 1, found by CI #178.** `scripts/test-desktop-target.mjs` was in the
pre-install group on the strength of its **imports** — builtins and git. Four
of its nine cases **spawn a real `next dev`**, and `next` is in
`node_modules`. Reproduced in a fresh clone of `975331c` with no
`node_modules`: 5 passed, 4 failed, the suite's own non-vacuity guard naming
the cause. Moved after `Install dependencies`. The file now records the rule I
broke: **the pre-install group is about what a suite RUNS, not what it
imports.**

**Defect 2, found by me after returning the first.** Your clause 4 —
"the run page now exposes actionable diagnostic information" — **was not met,
and the premise it was built on is false.** Round 107 wrote the diagnostics to
`$GITHUB_STEP_SUMMARY` on the claim that a summary renders on the run page.
**It does not.** Two workflows wrote summaries on `975331c`; both runs were
fetched at both the run page and the job page, and the only "Summary" visible
is GitHub's own metadata and artifact list. Not one word either workflow wrote.

So the Windows job went green having published a lifecycle verdict nobody can
read — the exact thing that step existed to prevent.

**Annotations are what is readable**, and every CI fact this project has ever
obtained came from one. Both workflows now emit them. For `validate`: the first
failing step, the machine before and after on one line, and the V8 verdict
through a new `--line` mode on the same allowlist. Few and short, because
annotations are capped and truncated; the tables stay in the summary for a
human in a browser.

Executed under GitHub's own shell flags, three branches, each exit 0.
**The allowlist still holds on the new path, tested as an attack:** a process
aborted with a secret in its environment leaves it once in the raw report and
**zero** times in the emitted annotation.

---

## 3. PL-0715 — confirmed, and the confirmation moved the fix

**The cause, read out of the installed library.** better-auth 1.7.5:
`enabled: options.rateLimit?.enabled ?? isProduction`, and
`getDefaultSpecialRules` applies **3 requests per 10 seconds per IP** to
anything under `/sign-in` or `/sign-up`. `packages/auth` passes no `rateLimit`
option, so that **unexamined default** is what the application runs — and it is
exactly the production-only split CI showed.

**Reproduced in the decisive configuration**: production, real PostgreSQL,
cold database, 4 workers. It failed — **on `e2e-harness-2`, which is
`src/identity.ts`'s account, not the watchlist slot CI happened to name.** The
two files carry the same defect line for line. Repairing only the one in the
annotation would have left the one that actually reproduces. Surface amended,
conflict-checked, recorded first.

Both now **sign in before signing up**, so a database that already has the
account costs one request and the burst never happens; both **read** the
sign-up's answer; both obey a 429 on either endpoint on the budget the sign-in
already had; both carry the attempt log into the failure message.

**Nothing weakened:** no test deleted or skipped, no assertion relaxed, no
project serialised, no timeout raised, `retries` still 0,
`playwright.config.ts` untouched, and the application's rate limiting not
configured, relaxed or disabled.

Regression in that same configuration: **77 passed / 41 skipped / 0 failed.**

**A finding for you, not fixed here:** the application's auth rate limiting is
a library default nobody chose — including that it is *off in development*.
`docs/SECURITY.md` R2 still says "No rate limit on any route". Deciding what
the limit should be is a security task that does not exist.

---

## 4. PW-0602 — blocked, and the blocker is named

The Windows job ran the harness and **its verdict cannot be read.** The job
succeeded, but the harness step carries `continue-on-error`, so a green job
says nothing about what it found. Which rows executed, and whether each passed,
failed or reported `not-run`, is **unknown and is not inferred**.

Repaired this round: per-case outcomes are now emitted as annotations —
`::notice` for pass and `not-run`, `::warning` for fail, a one-line tally, and
an explicit warning when no report was produced at all. Executed against
reports built from the real `scripts/windows/` modules: F3's residue violation
comes through verbatim, truncation works.

**Reading the result now needs a Windows run of the repaired workflow, which
needs a push this session cannot make.** That is not an engineering blocker I
can remove, so the task is BLOCKED with that condition written in, rather than
holding `claude-test`'s only slot — which is what let PL-0715 be worked at all.
Gate evidence is preserved (block keeps it; release would not).

Unchanged and not started: the larger half of its acceptance, the e2e suite
against the **desktop target on Windows**.

---

## 5. PW-0208 — what the Windows run could and could not establish

The package job succeeded, so the installer was built, digested, installed,
verified and uninstalled with the notices generator in the packaging path.
**Everything you asked to verify about the real packaged output needs the
artifact, and artifact download needs authentication.** I cannot open the MSI,
so I cannot confirm from evidence that Node's licence travels beside the
runtime, that `THIRD-PARTY-NOTICES.md` is present in the installed tree, or
that its content matches what was linked. Stated as unverified rather than
inferred from a green job.

The one thing that *is* now fixable from here: the notices generator could emit
its package count and its no-evidence list as **annotations**, the same channel
that just rescued the lifecycle report. That is `apps/desktop/scripts/**`, this
task's own surface — I did not take it while the task is in your hands.

Nothing enabled H.264 or HEVC. The patent question is unchanged and the
commander's.

---

## 6. PL-0717 — three tests that assert a fail-closed path, and nothing runs them

Found by measurement: both suites were run to completion and their **skip lists
intersected**. Five titles are skipped in *both*. Two are media-rig rows that
correctly need the commander's hardware. The other three assert that a
production deployment with **no database** fails closed — a 503 that names the
operator's remedy, and a refusal that publishes nothing only a resolver could
know.

They need the **third** configuration. CI runs two. The tests are not broken:
run here in that configuration, **62 passed / 56 skipped / 0 failed**.

**This is the fourth instance of one pattern** — `test-validate-repo.mjs`,
then `test-desktop-target.mjs` and the Windows lifecycle suite, then
`tracks.ts`, now these. The thing exists, it passes, and no gate asks it. The
task's notes suggest making the check mechanical, since finding it was two
suite runs and a set intersection.

Filed with a dependency on PL-0714 rather than edited now: that task owns
`ci.yml` and is in your hands, and two active tasks must not share a write
surface.

---

## 7. The board, and what your signatures unlock

`ai:dispatch` reports **no conflict-free executable task**. Everything is
behind a reviewer or external:

- **PW-0307**'s last clause needs PW-0306 **DONE** — the affordance lives in
  the player surface, which is PW-0306's active surface.
- **PW-0308, PW-0310** need PW-0306 DONE.
- **PW-0314** needs PW-0208 DONE.
- **PW-0502** overlaps PW-0208; **PW-0503** needs the Test slot, which PL-0715
  holds in REVIEW; **PL-0717** needs PL-0714.
- **PW-0204/0205/0207, PW-0504, PW-0505** — the commander's hardware and a
  first release. **PL-0302, PL-0602, PW-0311** — a licensed provider and feed.

Four approvals turn every one of those back on.

---

## 8. Bundle

| | |
| --- | --- |
| Base | `975331c084ff0be11805dd69341286cf06b0981b` (published head, fetched and confirmed) |
| Target | the commit carrying this document |

Verified with `git bundle verify`, `list-heads`, and a fast-forward rehearsal
from the published head in a fresh garbage-collected clone; the sha256 and byte
count are in the delivery message and are read back from the commander's disk
after the write.

Push attempted once: **403**, `not in this session's authorized repository
set`. Not retried. `gh api` answers the same, naming an `add_repo` tool this
session does not have.
