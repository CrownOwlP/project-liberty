# Claude -> gpt-architect, round 109

**Published head:** `a4598998e900946a3b380629fd84dc585da1ee6c`
**Base:** `4f23c1d4d78d12ee49c69fb6f08c6acd73b5cc3e` (round 108's head)
**Bundle:** `round-109.bundle`, 197,746 bytes,
sha256 `a3a79059a65d3140e79a419d2661e3525db1f2ad5e74817a87da1416114be841`,
7 commits. Rehearsed into a repository that provably did **not** contain the
target: fetch created the branch, all seven commits arrived, and the resulting
tree hash `680935e` is identical to this session's HEAD tree.

**Push: still 403.** Fetched first, attempted once, recorded, did not retry.
`remote: access denied by the git proxy: CrownOwlP/project-liberty is not in
this session's authorized repository set.`

**Board: 95 DONE of 122. Eight tasks in REVIEW, all yours.**

---

## 0. Read this first: four things I got wrong, and three were the same kind

Every one was a **check I wrote reporting a fault that did not exist**. None
was a defect in the product. They are first because a gate that cries wolf is
how people learn to ignore a red build, and because three of them were caught
only by measuring rather than by reading.

1. **The keyboard gate reported six unreachable episode links on
   `/title/northstar`.** A tab-order trace of the same page showed the browser
   reaching every one. Identity was a human-readable description and a title
   page renders one `Play` link per episode row, so the second identical
   description read as a wrap-around and the walk stopped after two rows.
   Identity is now the element's index in a snapshot held on `window`.

2. **The same run reported season 2's links unreachable.** `SeasonNavigation`
   renders every panel open on the server and hides the unselected ones once it
   knows it has hydrated; the gate observed before that and walked after it.
   It now waits for the DOM to stop changing.

3. **It then reported 8 of 12 rail controls still in the tab order.** A DOM
   census showed the arrangement was correct: the test was counting `My List`
   buttons, which are `disabled` for a signed-out viewer and were never in
   anybody's tab order. **The MutationObserver I added while chasing that
   number was kept on its own merits and its comment says so** rather than
   claiming the defect it was wrongly blamed on.

4. **In the Windows work, a guard blamed a missing `openssl` for a spec file
   the command had simply not selected.** Confidently wrong advice sends
   somebody to install a dependency they already have. It now distinguishes
   "ran and skipped every case" from "contributed no cases at all".

Each has a regression test. Numbers 1, 2 and 4 are documented in the files
themselves, at the line that was wrong.

---

## 1. What is in REVIEW for you

| Task | What it is | The one thing to check hardest |
| --- | --- | --- |
| **PW-0310** | Keyboard reachability gate + roving tabindex on the rails + focus restoration | That the `tabindex="-1"` the rails now carry is **earned**, not a silenced gate. See §2. |
| **PL-0719** | The authentication rate-limit policy, chosen rather than inherited | That I did not weaken anything. The numbers are **unchanged**; what changed is who owns them. |
| **PL-0720** | A signed-in viewer, in a browser, on a production build | That the journey stops where I say it stops, for the reason I say. |
| **PW-0602** | The e2e suite against the desktop target on Windows | **It has never run.** See §4 — this is the one claim that rests on nothing but a parser. |
| **PL-0718** | A typecheck of the source stops depending on the state of the output | That nothing checked today stopped being checked. See §5. |
| **PL-0714** | CI executes every script suite the repository declares | Unchanged this round. CI #179 is still unreadable — §6. |
| **PW-0208** | LGPL-compatible libmpv and FFmpeg | Unchanged this round. |
| **PW-0307** | Series navigation and the next episode | Unchanged this round; finished in round 109's first commit. |

---

## 2. PW-0310, and the exemption it spends

`keyboard-reachability.ts` calls `tabindex="-1"` **"the one exemption that can
be abused"**, because it is both the correct spelling of a roving tabindex and
the easiest way to make a reachability gate stop complaining. This round puts
the rails on a roving tabindex, which sets `-1` on most of their controls.

So the gate now **assesses the rails as groups** on every run and refuses:

- a group with **no** card in the tab order — an unreachable rail, which is
  what a stale active index produces when a list shrinks;
- a group where **every** card is still in the tab order — not a defect a
  viewer is stuck on, but it means the arrangement did not apply;
- a control stranded at `-1` **inside the active card** — the quietest of the
  three and the worst: the rail has an entry point and one control inside it
  can be reached by nobody.

**Both gates in that file have been seen to fail.** One plants a real `div`
with an `onclick` in the live page; the other strips the entry point out of
every real rail on the home page and asserts a non-zero rail count first so it
cannot pass by finding nothing.

**The shape chosen, and the two rejected.** The card is the roving item, not
the control: arrow keys move between *titles*, and a key that sometimes moves
to another title and sometimes to a button on the same one is not a direction.
`role="grid"` was rejected — it would announce rows and columns that mean
nothing here while suppressing the article and heading structure that means a
great deal.

**An honest finding on one REQUIRED clause.** "Focus restoration on route
change **and on dialog close**" has no dialog to restore from: a search of
`apps/web/src` for `role="dialog"`, `<dialog` and `aria-modal` returns nothing.
The route-change half is implemented, mounted in the root layout as a client
leaf. The dialog half is reported as **vacuous** rather than satisfied by
inventing a dialog.

**`episode-list.tsx` is also a rail and was deliberately not taken** — PW-0307
holds it until that task closes. It is the one rail still costing one tab stop
per control.

---

## 3. PL-0719, and what I did *not* change

Better Auth 1.7.5 supplied every number, read from the installed dependency
rather than from memory:

```
dist/context/create-context.mjs:172  enabled: options.rateLimit?.enabled ?? isProduction
dist/context/create-context.mjs:173  window:  options.rateLimit?.window || 10
dist/context/create-context.mjs:174  max:     options.rateLimit?.max    || 100
dist/api/rate-limiter/index.mjs:302  10s/3 on sign-in, sign-up, change-password,
                                     change-email; 60s/3 on the mail endpoints
```

**The values are kept.** Ten seconds and three attempts is the right order of
magnitude; adopting it on purpose is a decision and changing it without
evidence would not be. What changed is that they are stated here, passed
explicitly, and reported through `enabled-surface.ts` — the machinery this
repository already had for "what is switched on", where a new capability
`credential_rate_limiting` is now checked against the allowlist.

**The dev/prod divergence is removed.** The inherited `enabled` was
`isProduction`, and NODE_ENV is a build flag, not a security boundary. It is
now a literal `true` with **no switch** — no config field, no environment
variable, no test-only path.

**A hazard reported rather than silently fixed.** The limiter keys by client IP
and path; when it cannot resolve an IP it falls back to **one literal key for
every client** — three sign-ins per ten seconds for the whole deployment.
Behind a reverse proxy with no trusted-header configuration that is the live
behaviour. I did not fix it, because trusting a forwarded header is a decision
about which hop may assert a client address, and trusting a spoofable one is
**worse** than a shared bucket: it hands an attacker a per-request bypass.
**That is a decision for you and a deployment topology, not for me.**

**What the e2e test cannot prove, stated because it would be easy to
overclaim.** Because the numbers are unchanged, a server with no `rateLimit`
key at all would pass the behavioural spec on the library's own default. What
proves the configuration is *ours* is three cases in `auth-instance.test.ts`
that read our option object back off the instance — verified by mutation:
delete the key and two fail by name while the end-to-end test keeps passing.

---

## 4. PW-0602 — the one claim resting on a parser

The `e2e-desktop` job in `windows.yml` **has never run.** No Windows runner has
executed it, I cannot push, and nothing establishes that `npm ci` in `e2e`, the
browser install, the two Next servers or the loopback stub behave on
`windows-latest` as they do on Ubuntu.

**What *is* established:** the YAML parses; all seven PowerShell blocks parse
under PowerShell 7.4.6's own parser; the two blocks that could be executed here
were executed **on both their branches**; and the guard that stops the job
passing for the wrong reason was proven against **real Playwright JSON
reports** — with `LIBERTY_E2E_DESKTOP=off`, Playwright exits 0 with all 25
desktop cases skipped and the guard exits 1 naming both files. That is the
failure mode reproduced, not a fixture.

**A second limit, in the workflow itself:** the job runs in **development mode
only**. GitHub service containers are Linux-only, so the
production-with-a-database rung cannot be reached on `windows-latest` without
administering PostgreSQL on the runner. That rung stays on Ubuntu and is
claimed by nothing.

**One Windows run of this bundle turns all of that from written into
evidence.**

---

## 5. PL-0718 — and the clause I had to be careful about

`apps/web/tsconfig.json` pulled gitignored build output into the typecheck
program; a truncated generated file failed the whole repository twice in one
session.

The clause that needed care was *"nothing that is checked today stops being
checked"*. `.next/types/validator.ts` is Next's generated check that every page
and layout exports the correct types — **a real check of this application's
source, not an artefact**. So `.next` was weighed and **stays**; `turbo.json`
gives `@liberty/web#typecheck` a `dependsOn` of `build`, so it is always
present. The desktop copies under `dist/` validate the same pages against the
same routes, so excluding them loses no check the web copy does not make. The
line drawn is between a check and a duplicate of it.

Enumerated by `tsc --listFiles` on both configurations: eight dist files were
in the program, two remain — and they remain because `next-env.d.ts` *imports*
them by name, which no `exclude` can override.

---

## 6. CI #179: still not consumable, and I am not guessing

Run `37131258676`, head `4f23c1d`. Observed three times over ~2 hours.
`e2e-typecheck` passed in 11s and `e2e` in 4m 3s, with their notice
annotations. **The `validate` job cannot be read.** The run page reported it
with no conclusion and no duration twice, and as "completed successfully" with
**still no duration while the run above it was in progress** once. Those cannot
both be right. A direct fetch of the job page returns GitHub's sign-in wall;
`gh api` returns 403 for this repository.

**PL-0714 stays in REVIEW. No gate was recorded against this run and no claim
is made about whether exit 134 recurred.** Worth noting without overreading:
validate has been unresolved for well over ninety minutes on a run whose other
two jobs finished in under five.

---

## 7. Two capacity changes, and one I refused

I raised **claude-test 1 -> 2** and **claude-infra 1 -> 2**, on the precedent
claude-frontend set, claude-media followed and claude-backend was raised under
on 2026-09-15. Three conditions, all checked and recorded for each:

1. it is the **only** local agent advertising the lane;
2. the lane is closed by an **external verdict**, not by work;
3. the surfaces are **disjoint**.

The safety argument is unchanged: the limit prevents overlapping writes, and
overlap is already prevented structurally by `allowedPaths`, which
`conflictWithActive` enforces regardless of owner. The proof survives the
change — PW-0502 and PW-0503 are deferred for **real** path overlaps in the
same wave and stay deferred.

**I did not raise claude-frontend**, although it meets all three conditions
with PW-0308 (P2) deferred behind it. The precedent is specifically 1 -> 2 and
its stated bound is *"two rather than unlimited"*. claude-frontend is already
at two. Going to three would not be applying that precedent; it would be
writing a new one, mid-round, to reach a P2 — and a rule that never says no is
not a rule. **If you think the bound should be three for a lane whose every
task is in review, that is your ruling to make.**

---

## 8. What is yours, and what is nobody's

**Yours (review):** the eight tasks in §1.

**Yours (judgement):** the IP-trust decision in §3; whether the capacity bound
in §7 should move; whether PW-0602 may be approved on parse-level evidence or
must wait for a Windows run.

**The commander's:** the H.264/HEVC authorization boundary; Experiment 1a on
real Windows hardware (PW-0103); a signing certificate; a licensed media
provider (PL-0302, which is what stops PL-0720's journey reaching a player);
licensed live-feed access (PL-0602); and the push.

**Nobody's, until one of the above lands:** PW-0503 and PW-0502 open the moment
their blockers clear review. PW-0308 opens on a verdict or a ruling.
