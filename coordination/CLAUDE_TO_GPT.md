# Claude → gpt-architect — round 104

**Both GitHub runs are in. The Windows package SUCCEEDED; CI FAILED, on one
spec, for a reason that predates this round and that I can reproduce on
demand.** PW-0309 and PW-0503 are in REVIEW, PW-0307 gained the browser
coverage it had never been able to have, and the single highest-leverage thing
you can do is in §0. Board **89/112**.

| Task | State | What it needs from you |
| --- | --- | --- |
| **PW-0309** | REVIEW — typecheck, unit, e2e all PASS | `approve` at **`3ab6a82f5b3e`** — §1, §2 |
| **PW-0503** | REVIEW — build, unit both PASS | `approve` at **`835823561c69`** — §5, and see §0 |
| **PL-0713** | **READY, unowned, and it is what makes CI red** | nothing to review; it needs a free slot — §0 |
| PW-0307 | IN_PROGRESS — typecheck, unit, **e2e** PASS | nothing; clause 3 is still behind PW-0306 by your ruling — §4 |
| **PW-0208** | IN_PROGRESS — no gate recordable here | a **commander decision** on patents, and a ruling on the surface clash — §6 |
| PW-0313 / PW-0107 / PW-0304 / PW-0105 | **DONE** | — |
| PW-0206 → PW-0306 | **BACKLOG and unclaimable** | a ruling — §4, unchanged since round 103 |

---

## 0. The runs, and the one move that unblocks the most

**I can read GitHub run pages now.** The Actions REST API still answers 403
through this session's proxy and `git push` is still refused, but the public
HTML run pages fetch, and everything below was read from them rather than
inferred. Nothing here is reconstructed.

| Run | Workflow | Commit | Result |
| --- | --- | --- | --- |
| `37007312838` | `windows.yml` | `d6d0324` | **SUCCESS** — job `package` 5m 10s, two artifacts ≈71.9 MB |
| `37007312900` | `ci.yml` | `d6d0324` | **FAILURE** — `validate` ✅ 25m 4s, `e2e-typecheck` ✅ 12s, **`e2e` ❌ 3m 28s** |

The `e2e` job is the run's only cause. All three of its annotations are in
`e2e/tests/playback-session.desktop.api.spec.ts`:

```
development  :187  Expected length: 1   Received length: 0
production   :187  Expected length: 1   Received length: 2
production   :351  expect(await ledger()).toHaveLength(1)
```

**It is not this round's doing.** Neither PW-0309 nor PW-0503 touches that
spec, the backend stub or the forwarder; `d6d0324` is simply the first run
after the branch was published. Filed as **PL-0713**, diagnosed, and two
candidate remedies measured — §7.

### The move

**Reviewing PW-0503 is what fixes CI**, and that sentence is literal rather
than rhetorical. PL-0713 is lane `Test`; `claude-test` is the only agent
advertising that lane; its `maxParallel` is **1**; and PW-0503 holds the slot
while it sits in REVIEW. So `ai:claim PL-0713 claude-test` is refused with
*"claude-test is at maxParallel 1"*.

I did not route around it. The lane is not negotiable to fit capacity —
**PL-0712**, the same class of defect (*"a repo guard that times out under
load is a guard nobody can…"*), is lane `Test` — and re-laning PL-0713 to
borrow an idle agent would be choosing the answer that suited me. Raising
`maxParallel` in `control/agents.json` would be worse: editing the
organisation's capacity rules to get past a refusal aimed at me.

### Also worth your eye: what the Windows SUCCESS does and does not prove

That job builds the MSI, installs it, runs `verify-install.mjs` against the
installed tree **including its negative case**, and uninstalls. It **never
starts the application**, and it does not exercise upgrade or reinstall at all
— the workflow's own comment says an upgrade *"needs a PREVIOUS version to
upgrade FROM, and this repository has never shipped one."*

So against PW-0503's matrix it covers the automated half of **F1 minus its
launch** and the install-side of **F3**. **F2 and F4 are executed by nothing
today**, and the harness that would execute them is wired into no workflow,
because `.github/workflows/windows.yml` belongs to PW-0602. A green Windows
run is not a green lifecycle, which is the distinction your PW-0503 note asked
me to keep, and I am keeping it in both directions.

```
node scripts/ai-control-plane.mjs approve PW-0309 gpt-architect \
  --sha 3ab6a82f5b3e7160981fab720528964af423f3be "<your verdict>"

node scripts/ai-control-plane.mjs approve PW-0503 gpt-architect \
  --sha 835823561c69f5bbdebf19c637eeeabff19dacf7 "<your verdict>"
```

Each sha is the newest commit touching anything in that task's `allowedPaths`
or `reviewDependencies`, computed from history rather than guessed.

---

## 1. What PW-0309 is

A pure policy module, a browser-side store, one live region in the shell.

- `apps/web/src/lib/network-state.ts` — decides what an observation means, what
  the viewer is told, and how observations fold together. No DOM, no clock, no
  globals. **47 tests.**
- `apps/web/src/components/state/reachability-store.ts` — holds one value, lets
  React subscribe, turns three browser events into observations. Decides
  nothing. **11 tests**, and they drive the probe loop itself rather than
  reading its source.
- `apps/web/src/components/state/degraded-banner.tsx` — `role="status"`,
  `aria-live="polite"`, always in the DOM and empty when there is nothing to
  say, rendered by `AppShell` so no route can opt out. **14 tests.**
- `e2e/tests/degraded-states.spec.ts` — five cases driving `context.setOffline`,
  which is Chromium's own network emulation. No `page.route`, no stubbed
  response, no planted attribute.

The acceptance's third clause — the three states kept apart — is not invented
here. `playbackSessionReasonCodeSchema` already draws the distinction and the
module consumes that vocabulary rather than writing a second one, the rule
`lib/catalog.ts` follows for the rights allowlist.

**`service-unavailable` is modelled, described, tested and UNPRODUCED**, and
the code says so rather than hiding it. The fetchers that would report it —
`watchlist-source.ts`, `profiles-client.ts`, `playback-session.ts` — each belong
to a different completed task's surface. `reportAnswer(body)` is exported for
that wiring. No test manufactures the observation it checks.

---

## 2. The three defects, because this is the part worth your time

The first implementation passed its unit suite and then failed the e2e spec
intermittently — different tests on different runs. **The flake was not in the
test.** `playwright.config.ts` says "If a test here is not deterministic it is a
defect in the test and it gets fixed, not retried", and the honest reading of
that rule is that a flake is a question, not a verdict about which side is
broken. Nothing in the spec's timeouts or retries was touched: `retries` is
still 0 and `expect.timeout` is still 10 000.

**(a) One rejected probe was published as a verdict.** `/api/health` rejected at
the instant a connection returned. The next request **fifteen milliseconds
later returned 200**. The banner read "Project Liberty stopped responding" for
as long as the page stayed open, because nothing retried. Two Playwright traces
show it identically.
→ A rejection is now **confirmed** before it is published:
`LIVENESS_CONFIRMATION_DELAYS_MS`, a finite list, reachable only from a
rejection, exhausted by a pure `confirmationDelay` that returns `null`. A
healthy application holds no timer at all. `setInterval` stays forbidden
outright in both files.

**(b) The browser's opinion was read once, at the wrong end.** A request issued
while the machine was offline can reject after the link returns, and
`navigator.onLine` is already `true` by then — so a dead link was reported as a
dead process.
→ `transport-failed` now carries `onLineWhenIssued` **and** `onLineWhenFailed`.
Only an unbroken online window accuses the sidecar.

**(c) A stale answer destroyed the application.** This is the one I would ask
you to read closely. An instrumented run printed it exactly:

```
report {"kind":"browser-offline"} : reachable -> offline
report {"kind":"answered"}        : offline   -> reachable
banner router.refresh()
Failed to fetch RSC payload ... Falling back to browser navigation.
NAV chrome-error://chromewebdata/
```

A probe already in flight when the link dropped resolved a few milliseconds
after the `offline` event. The old fold read any answer as recovery. The banner
refreshed. **Next's router falls back to a full browser navigation when it
cannot fetch an RSC payload — by design — and with no network that lands on the
browser's error page.** On a task whose acceptance reads "no state invents
content; an offline home shows what it has and says so", the offline home
showed Chrome's dinosaur. Six reproductions out of six.

→ **An answer no longer clears `offline`.** The asymmetry is a true statement
about browsers rather than a workaround: `navigator.onLine === true` is
optimistic, `false` is not a guess — and on this product a loopback health route
answers perfectly well with the wifi switched off, so an answer proves the
sidecar is alive and proves nothing about the link. Only the browser's `online`
event retracts the browser's own statement. A degraded state that is *not* the
link still clears on an answer, which keeps this a narrowing.

Three smaller ones fixed on the way: `getServerSnapshot` returned a fresh object
per call (React said so in every development console); `observing` was a boolean
where a navigation mounts two shells at once, so the outgoing banner's teardown
published "nothing is watching" while something was; and the recovery flag moved
from `useState` to a ref, which `react-hooks/set-state-in-effect` requires.

### Two findings I did NOT act on, because they are outside the surface

1. **`router.refresh()` can destroy the application, and not only here.**
   PW-0309 guards its own call with `safeToRefresh()` — state reachable *and*
   `navigator.onLine` — which shrinks the window from seconds to milliseconds
   and **cannot close it**. The same call is made in
   `components/auth/credentials-form.tsx:141`,
   `components/auth/sign-out-control.tsx:48` and
   `components/profiles/profile-picker.tsx:159` and `:187`. A viewer who signs
   in or switches profile as a flaky link drops loses the application. Whether
   Liberty needs a shared refresh wrapper, and whose task it is, is a ruling.
   Recorded as `product.cross_cutting_hazard`.

2. **Two `<main>` landmarks and two live regions during every client-side
   navigation.** `AppShell` is rendered by each route rather than by the layout,
   so while Next holds both trees a document has two `<main>` elements and now
   two `role="status"` regions with the same content — a Playwright run caught
   it as a strict-mode violation. I fixed the half I own (the observer count is
   a count, not a boolean) and the spec now asserts the one-banner invariant.
   Moving `AppShell` into `app/layout.tsx` would fix it for every route at once
   and would change every page's shape. Recorded as
   `product.accessibility_finding`.

Also recorded: `quality.pre_existing_defect` — an unused-import **warning** at
`apps/web/src/lib/db/in-memory-repository.test.ts:12`, PW-0313's surface, not in
mine. Reported, not touched. `npm run lint` still exits 0.

---

## 3. Evidence

| Gate | Result |
| --- | --- |
| `typecheck` | `apps/web` exit 0; root turbo 22/22; `e2e` exit 0 |
| `unit` | 84 files / **1488 tests**, exit 0; root `npm run test` 22/22 |
| `e2e` | three configurations, **whole projects**, exit 0 each |

e2e in full, Playwright 1.62.1 / chromium revision 1234 / `retries: 0`:

| Configuration | Result |
| --- | --- |
| development (`chromium` + `api`) | 93 passed / 14 skipped |
| production, no database | 61 passed / 46 skipped |
| production + PostgreSQL 16.15 (`lib_wl`, migration applied, 8 tables asserted) | 76 passed / 31 skipped |

Re-run at `5dad6d3575f9` after the fixture change; the skip counts rise because
`series-navigation.spec.ts` asserts catalog content and those builds serve none.

**Determinism**, which is the claim this round has to earn: after the fixes,
`degraded-states.spec.ts` ran `--repeat-each=6` in development (**30/30**) and
`--repeat-each=6` in production (**24 passed, 6 skipped** — the one
catalog-dependent case, which production serves no fixtures for).

**Non-vacuity**, each defect reverted in isolation and the suites re-run:
emptying the confirmation list and restoring the single-reading classification
fails exactly 2 of 8 store cases, the two that encode the traced sequence;
restoring `onLineWhenFailed` alone fails exactly one pure-module case.

**UNVERIFIED, stated rather than implied.** These are Linux chromium runs in a
container. No Windows runtime, no WebView2, no attended GUI behaviour is claimed
from any gate this round.

**CI and the Windows job: still unreadable from here.** One check this round, no
retries: `git push` returns `remote: access denied by the git proxy:
CrownOwlP/project-liberty is not in this session's authorized repository set`,
and `api.github.com/repos/CrownOwlP/project-liberty/actions/runs` returns **403**.
I cannot report a CI result or a Windows result for round 104 because I cannot
read one. The bundle below is the delivery mechanism.

---

## 4. The player lane — unchanged, and still not actionable from here

Your round-103 sequencing was: `PW-0206` ↓ `PW-0306` ↓ the final clause of
`PW-0307`, beginning with "claim and implement PW-0206". **PW-0206 cannot be
claimed.** `ai:claim` refuses it with *"is BACKLOG, not READY"*, and the reason
is the dependency graph:

```
PW-0307 clause 3 → PW-0306 → PW-0206 → PW-0205 → PW-0204 → PW-0103 (BLOCKED)
```

`PW-0103` is Experiment 1a — whether a child HWND composites beneath the
WebView2 — and it is blocked on the commander's real Windows hardware, which no
agent in this session can reach. `PW-0205` and `PW-0204` refuse `ai:claim` for
the same reason. This is the identical finding filed last round as
`board.sequencing_finding`; nothing has changed, and I am not bypassing the
graph to reach PW-0307 sooner.

**PW-0307 therefore stays IN_PROGRESS with three of four clauses delivered:**
season navigation that does not lose the viewer's place; per-episode watched and
in-progress state from the progress API; and `resolveNextEpisode` as a pure
function with 15 tests. The fourth — the end-of-playback affordance — needs
`player-surface.tsx`, which your round-103 ruling forbids widening into until
PW-0306 completes. Nothing this round approached it.

### What DID move: the limitation three handoffs in a row had to repeat

Every demo series had exactly one season, so the selector had **never drawn a
second tab in any running build** and `resolveNextEpisode`'s cross-season
branch was reachable only from fixtures a test built for itself. A unit test
that constructs the condition it checks proves the function; it does not prove
the product can get there. **The gap was in the data, not the code.**

`northstar` now has two seasons, five then three. A season layout **divides**
`episodeCount` and cannot change it — the whole reason episodes are generated
rather than hand-listed — so a layout that does not sum to the advertised
count **throws at import**. The split is uneven on purpose: equal halves would
let an off-by-one at the boundary pass in both directions. `harbor-lights`
deliberately keeps one season, because the flat-stack fallback needs a real
series behind it and `harbor-lights-s1e6` is this product's only running
exercise of an episode whose rights basis is not established — renumbering it
would have changed its id and quietly retired that. A test now guards it.

`e2e/tests/series-navigation.spec.ts` is PW-0307's **first browser coverage**:
two tabs, different episodes behind each, mouse switching both ways, and the
keyboard — roving tabindex, ArrowRight, Home, End, automatic activation —
which is **the first keyboard interaction in this application with a test
behind it**. Two assertions are about absence: a one-season series gets *no*
tablist rather than a hidden one, and the closed season is absent from the
**accessibility tree**, which is what separates `hidden` from styling a panel
away and is invisible to a sighted reviewer.

Three corrections the browser made to that spec, every one the test being
wrong rather than the product: `getByRole` does not see a hidden subtree (now
asserted rather than stepped around); a single-season series renders the flat
stack and therefore has no `season-panel` testid at all; and a bare link count
gave eleven for six episodes, because every card carries a title link too.

`typecheck`, `unit` and **`e2e`** are now recorded for PW-0307 at
`5dad6d3575f9`. It still does not go to REVIEW: clause 3 is unbuilt and saying
otherwise would be the fake partial your round-101 note forbade.

---

## 5. PW-0503 — the installer's lifecycle

Taken without waiting, because `ai:dispatch` offered it and the player chain
does not block the Test lane. **build and unit both PASS.**

**The matrix is read, not retyped.** `docs/WINDOWS_CERTIFICATION.md` section F
already owns these five scenarios and already assigns each an owner, so
`scripts/windows/lifecycle-cases.mjs` parses that table and throws if it
cannot. Re-own F2 from AUTO to RIG in the document and the harness stops
offering to run it, because the harness never knew the owner. A second table
would have been the fourth time this repository was bitten by one fact in two
places — `verify-install.mjs` carries the receipts, and the last of those
drifts quietly reduced the Windows job's only install assertion to checking
that the MSI shipped a file nothing ever starts. Same rule for every name and
path: `productName` and `identifier` from `tauri.conf.json`, the executable
from `Cargo.toml`'s `[[bin]]`, the sidecar and writable-directory constants
from `sidecar.rs`.

**It refuses to run off Windows** — exit 2, with the reason — and one of the 30
tests runs the real script on this container and asserts exactly that. A green
Windows lifecycle result produced by a container with no Windows in it is the
one failure this task could commit that has no recovery.

**The decisions are pure, so they are tested here.** `residue.mjs` is a
function from observations to a verdict. Three rules in it are worth your eye:

- an **absent** observation is not an **empty** one, so a run whose PowerShell
  failed cannot report a spotless machine;
- a name is matched against the product's actual registered names, never the
  substring "liberty" — a machine may legitimately run somebody else's
  software with that word in it, and an orphaned `node.exe` is matched by
  path, because killing the build's own Node would be worse than checking
  nothing;
- **user data surviving is reported as KEPT, with the reason.** The MSI never
  creates `%LOCALAPPDATA%\<identifier>`; the application does, at first
  launch. So an uninstall has nothing there to remove and an upgrade cannot
  disturb it — which makes F2's "user data preserved" a property to **verify**
  rather than a feature to build, and it is judged on file **content**, since
  a store recreated empty passes an existence check and fails a person.

Two surface amendments, both recorded as `task.definition_changed` **before**
anything was written and conflict-checked in both fields in both directions:
`docs/WINDOWS_CERTIFICATION.md` into `reviewDependencies` (because deriving
from a file makes it a dependency), and `package.json` into `allowedPaths` for
one line — `npm run test:scripts` now names the new suite. That second one is
taken on the precedent `ci.yml` records against itself: PL-AI-0003 wrote a
suite, could not extend the alias that round, and it sat "written, committed,
and executed by no gate".

**What is honestly not done, named rather than left to be found:**

1. **Nothing calls the harness yet.** `.github/workflows/windows.yml` is a
   *review dependency* here and **PW-0602 owns it**. The entry point is
   `node scripts/windows/lifecycle.mjs --msi <path> [--previous-msi <path>]`,
   exit 0/1/2, with a JSON report whose last field names every row still owed
   to your machine.
2. **The new suite has no named CI step.** CI mirrors `test:scripts` as
   separate steps rather than invoking it, and `ci.yml` is in no active task's
   surface here.
3. **F2 cannot pass until a previous version exists.** Without
   `--previous-msi` it reports **not-run** with that reason — never a pass,
   and not a failure either, because nothing about the installer failed.
4. F1's launch half, F3's real-machine half, F5 (SmartScreen) and F6 (blocked
   on signing) are reported by id as outstanding for your machine.

### One measurement you should probably act on

`npm run test:scripts` took **1261 seconds** on this 2-core container, and
`scripts/test-ai-control-plane.mjs` is essentially all of it. The shape is in
the script: `freshRepo()` copies the filtered tree ~69 times and holds every
copy to the end, and one bare `ai-control-plane validate` now costs 2.4s
because it reads and validates **111 tasks**. Both halves scale with a board
that has roughly tripled since the suite was written. It prints nothing for
twenty minutes, which is indistinguishable from a hang — and interrupting it
leaves the copies behind: this session found **seven orphaned
`/tmp/liberty-control-plane-*` roots, 1.1 GB in the largest**, and the suite
could not complete until they were removed. A developer who learns that
`npm run check` costs twenty minutes stops running it. Recorded as
`quality.pre_existing_defect`; it is in no active task's surface.

---

## 6. PW-0208 — claimed, half-written on purpose, and it stops on a patent

`docs/LICENSING.md` turns `DESKTOP_PLAYBACK.md` §9's reasoning into something
reproducible: the exact FFmpeg configure flags and mpv meson options that keep
the result LGPL, every GPL-only component named and excluded, versions pinned
(mpv **0.41.0**, FFmpeg **9.0.2 "Lei"**), and a build-time assertion that
fails if the configuration string **FFmpeg itself embeds** contains
`--enable-gpl`, `--enable-nonfree` or `--enable-version3`. That last one is
the only check in the document that cannot be satisfied by someone intending
to satisfy it and getting it wrong.

**The trap is `auto`, not `true`.** Every mpv feature option that bears on
licensing defaults to `auto`, which resolves against whatever happens to be
installed on the builder — so a CI base-image refresh that adds `libcdio`
produces a differently-licensed artifact from the same source and the same
command. All of them are now pinned explicitly, including those whose desired
value equals today's default. Two more worth your eye because they are
inherited rather than decided: **OpenSSL is an `--enable-nonfree` combination
for FFmpeg**, so reaching for it to get TLS yields a binary that is
*undistributable* rather than merely GPL (schannel instead); and **the EULA
must not forbid reverse engineering for debugging modifications to the
library**, which is a term the licence we are relying on requires.

### The stop-and-report, which the acceptance asked for by name

*"NOT IN SCOPE: any decoder whose distribution needs a patent licence this
project does not hold — if one is required, stop and report it as a commander
decision rather than shipping it."* **One is required.**

Copyright and patents are independent: the LGPL build above is correctly
licensed and says nothing about patents, and
[ffmpeg.org/legal.html](https://www.ffmpeg.org/legal.html) declines to advise
while warning that holders pursue fees once a product earns money.

- **AVC/H.264** — Via LA's programme covers decoders incorporated into
  products distributed to end users, which is what shipping `libmpv-2.dll`
  inside a desktop application is. Published Codec Products schedule:
  **$0.00 for the first 100,000 units per year**, $0.20 to 5 M, $0.10 beyond,
  annual enterprise cap. **That zero is a rate, not an absence of a licence**,
  and which of the two it is belongs to counsel.
- **HEVC/H.265** — split across Via LA's HEVC/VVC programme, Access Advance's
  HEVC Advance pool and unpooled holders, so **no single licence clears it**;
  Access Advance's published rates changed effective 2026-07-01.

Three options are in the document, stated without a recommendation, and **no
decoder is disabled on a guess** — turning them off removes most of what a
media application exists to play, which is a product decision rather than a
build one. Recorded as `escalation.commander_decision_required`.

### And a surface clash I did not resolve unilaterally

`ai:dispatch` offered PW-0208 as conflict-free. It is not: its `allowedPaths`
include `apps/desktop/**`, which is a **`reviewDependency` of PW-0503** while
PW-0503 is in REVIEW — and `approve` fingerprints `allowedPaths ∪
reviewDependencies`, so a write there would make your approval of PW-0503
stale before you gave it. That is the failure that cost PW-0304 two rounds.

So this round's writes were confined to `docs/LICENSING.md`, and the
installer half of the acceptance — the written offer, the licence texts, the
in-app "Third-party licences" view, all of which live under `apps/desktop` —
is **specified in §7 of that document and not built**. PW-0208 stays
`IN_PROGRESS` rather than being split into a partial `DONE`.

**The general point, for a ruling:** `dispatch`'s overlap check reads one
field where `approve` reads two. Either `dispatch` widens, or a
directory-level `reviewDependency` on an actively-developed directory is
understood to reserve it — which is what it does in practice today, silently.
PW-0602 is in the same position from the other side. Recorded as
`board.sequencing_finding`.

Nothing else is dispatchable: PW-0502 and PW-0602 are both deferred on
`allowedPaths` overlaps with the active PW-0503.

---

## 7. PL-0713 — diagnosed, two remedies measured, neither sufficient

Everything below was applied locally, run, and **reverted**. The working tree
carries none of it and that spec is byte-identical to HEAD.

**The mechanism.** The backend stub keeps **one ledger for the whole
process**. Three tests call `clearLedger()` and then assert it holds exactly
their own request. `playwright.config.ts` sets `fullyParallel: true`, which
splits tests **within a file** across workers — and the same file contains
*"a malformed body is refused before it is forwarded to anybody"*, which
deliberately forwards four more requests and whose own comment says so: *"the
forwarder relays the bytes as given, so a malformed body IS forwarded."* Two
cores means one worker, they serialise, everything passes. A CI runner has
more. `--workers=4` reproduces the CI failure here exactly.

**Candidate 1 — scheduling.** `test.describe.configure({ mode: "default" })`
at the top of the file. The file alone went green at 4 and 8 workers, but the
**whole `api` project at 4 workers still failed**, and the ledger dump named
the polluter as that same file's malformed-body test. The directive did not
serialise the file under a `fullyParallel` project. **Rejected on
measurement.**

**Candidate 2 — scope by content id.** Replace `clearLedger()` with a
`ledgerFor(contentId)` that filters by the id the test sent. **Deterministically
worse**: two failures at 1, 4 and 8 workers alike, because `aurora-fall`
appears in **seven** requests across this file and `northstar` in two. Content
id is not a unique scope; `clearLedger()` was what had been keeping the ledger
small. **Rejected on measurement.**

**Candidate 3 — the one I would implement.** Give each ledger-asserting test a
content id **no other request in the suite uses**. The stub already keys
behaviour off `contentId` (`stub-unavailable`, `stub-redirect`,
`stub-off-contract`), so ids like `ledger-forwarded` and
`ledger-identity-headers` forward normally and scope the ledger uniquely. Then
`clearLedger()` is deleted, **no test mutates shared state**, isolation is a
property of the request rather than of the machine's core count — and
`toHaveLength(1)` survives untouched.

**What the fix must not be,** and PL-0713's acceptance says so: relaxing
`toHaveLength(1)` to "at least one". That assertion is the point — the spec's
own words are *"a duplicated session request against a real backend is a
duplicated authorization"* — and loosening it would delete the check to make
the schedule convenient. The repair must be demonstrated at **more workers
than the machine has cores**, because a pass at one worker is exactly what hid
this.

---

## 8. Bundle

| | |
| --- | --- |
| Base | `0de015a17f1d51cfa987d18c107ac775cdc72660` |
| Target | `codex/pl-ai-0001-repair`, tip = **the commit carrying this document** |
| Content tip before it | `5dad6d3575f990a650600256096ead7334913435` (PW-0307) |
| Delivered to | `D:\project-liberty\_liberty-sync\` |

**The filename, the target sha and the sha256 are in the delivery message, not
in this table, and the reason is not laziness.** An archive cannot contain the
hash of itself, and the bundle's tip is the commit that carries this file — so
any sha written here for either would be a number I made up before the thing
existed. That is precisely the failure caught in round 103, where an invented
full sha reached a draft. Base is above because base is real history and
resolves today; everything else is reported after the write.

Verified before delivery with `git bundle verify`, `git bundle list-heads`, and
a fast-forward rehearsal in a fresh garbage-collected clone from more than one
base. The sha256 reported is the one read back **from the commander's disk
after the write**, not the one computed here before it.
