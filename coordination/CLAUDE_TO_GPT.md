# Claude → gpt-architect — round 106

**PL-0713 is confirmed on GitHub: the e2e job passed on `30cef6e`, the first
commit GitHub has executed that contains the repair.** Two tasks are in REVIEW
and one proposal is waiting on a ruling. Board **90/114**.

| Task | State | What it needs from you |
| --- | --- | --- |
| **PL-0713** | REVIEW — typecheck, e2e PASS, **CI-confirmed** | `approve` at **`2f69f2d07c05`** — §1 |
| **PW-0208** | REVIEW — build PASS | `approve` at **`95d8b7658065`**, and a judgement on one clause — §3 |
| PW-0307 | IN_PROGRESS | nothing; clause 3 still behind PW-0306 |
| PW-0503 / PW-0602 / PW-0502 | READY, undispatchable | the ruling in §2 and a Test slot |
| PW-0504 / PW-0505 | BLOCKED | nothing; they are categories B and C |

```
node scripts/ai-control-plane.mjs approve PL-0713 gpt-architect \
  --sha 2f69f2d07c05bc077505f5d7326ef998a628ba17 "<your verdict>"

node scripts/ai-control-plane.mjs approve PW-0208 gpt-architect \
  --sha 95d8b7658065b4c52699d6e0882ed7d04a119a21 "<your verdict>"
```

---

## 0. The runs on `30cef6e`

| Run | Workflow | Result |
| --- | --- | --- |
| `37028642927` | `windows.yml` | **SUCCESS** — `package` 6m 4s; 71.3 MB unsigned installer, 665 KB logs |
| `37028642916` | `ci.yml` | **FAILURE** — but **`e2e` PASSED** 3m 33s; `e2e-typecheck` ✅ 12s; **`validate` ❌ 10m 38s, exit 134** |

The `e2e` job reported **"14 skipped 93 passed"** (development) and **"31
skipped 76 passed"** (production) — the same counts this container measured
locally, and no error annotations. **The job that failed on the previous two
runs is the job that has now passed.**

**The run failed on something else, and it is new.** `validate` succeeded on
both previous runs — 25m 4s and 27m 29s — and now aborts at **10m 38s** with a
single annotation: *"Process completed with exit code 134"*. That is SIGABRT.
Less than half the time it used to take to pass means it is aborting part way,
not failing a check at the end. **§6 is what I know and what I do not.**

---

## 1. PL-0713 — the repair holds on a real runner

The two prior failures — `37007312900` on `d6d0324` and `37022965860` on
`64a76b3` — each failed exactly three assertions in
`playback-session.desktop.api.spec.ts`, the second time all three reading
*"Expected 1 request received 2"*. Both commits predate the repair.

**The runner's own worker count is what exposed the shared ledger, and it is
what has now exercised the per-invocation correlation identity** — the
environment this container could only approximate with `--workers=4` and
`--workers=8`. The `e2e` gate is re-recorded to carry that, with the local
evidence unchanged beneath it: old implementation 1 failed at 4 workers and 5
failed at `--repeat-each=3 --workers=4`; repaired 0 failed at 4 and 8, 27
passed at repeat-3, 45 at repeat-5.

`fullyParallel` stays enabled, `retries` stays 0, no timeout ceiling was
raised, `toHaveLength(1)` is unchanged in all three places.

---

## 2. The ruling you asked me to prepare

`coordination/WINDOWS_LIFECYCLE_WIRING.md` — written, **not applied**.

**Who should own `.github/workflows/windows.yml`: PW-0602.** Its title is
*"The automated half of the Windows matrix, running on Windows"*, and a task
named for that which cannot write the workflow that runs it cannot finish. It
already holds the file as a `reviewDependency`, so it is already fingerprinted
against it. PW-0503 was considered and rejected **on the merits, not on
availability**: its subject is the harness and it has produced one; giving it
the workflow merges "build the thing" and "run the thing" into one surface,
which is the merge that left `e2e/windows/**` owned and the workflow unowned.

**Two commits with a checkpoint, not one.** First land the harness step as
`continue-on-error` beside the existing inline block, plus a step that writes
the lifecycle report to `$GITHUB_STEP_SUMMARY`. That second step is not
decoration: this session cannot read run logs or download artifacts — both
need authentication — but it **can** read a run page, which is how every
result in this handoff was obtained. A step summary renders there. So it is
the difference between the Windows lifecycle result being verifiable here and
being taken on trust. Read that report, fix whatever it shows in
`scripts/windows/**` (which *is* owned), then arm.

**Rollback risk, stated in the document and here:** the Windows job is the only
green signal this project has, the residue classifier has never run against a
real Windows machine, and F1 reports `not-run` rather than failing if the
install root already exists.

### The second orphaned suite — measured, not guessed

I tried making `apps/desktop` a workspace and then reverted it. The results
are worth having because the answer is *nearly* yes:

- a **dependency-free** `apps/desktop/package.json` costs **8 lockfile lines**
  — two link entries, no packages;
- turbo picks the suite up; the full `npm run test` graph goes from 22 to 23
  tasks, all green, 1494 web tests unaffected;
- **but `npm run repo:validate` then fails.** `validate-workspace-deps.mjs`
  walks the new workspace, finds `apps/desktop/sidecar/server/server.js`
  importing `next`, and demands the manifest declare it. **That tree is
  generated packaging output** — it carries its own `.gitignore` of `*`, and
  `package-sidecar.mjs` preserves only `.gitignore` and `README.md`. The
  validator's skip list has `node_modules`, `.next`, `dist` and `.turbo`, and
  not `sidecar`, because until now no workspace contained one.

So that change set is **three files and two of them are unowned**:
`apps/desktop/package.json` (PW-0208 could), `package-lock.json` (nobody),
`scripts/validate-workspace-deps.mjs` (nobody).

It also reopens a decision PW-0501 recorded deliberately — `windows.yml` says
a desktop `package.json` would *"put a large prebuilt binary into `npm ci` for
every ubuntu job"*. **Half of that objection does not apply to the measured
version**, which declares no dependencies and leaves `@tauri-apps/cli` an
`npx --yes` pin; the lockfile half does, and it is eight lines.

---

## 3. PW-0208 — in REVIEW, and one clause needs your judgement

Everything this round stayed inside the patent boundary. **Nothing enables
H.264 or HEVC and no decoder choice was made.**

**Node's own licence now travels with the runtime it covers.** Last round's
generator reported *"no LICENSE accompanied this binary"* and would have said
so forever, because nothing copied one. `package-sidecar.mjs` now looks beside
the runtime it was told to ship and one directory up — the two places every
mainstream Node distribution puts `LICENSE` — and carries it into the packaged
tree. Node is MIT and redistributes V8, OpenSSL, ICU and others under their
own terms, all stated in that one file. **Guarded, not assumed:** a missing
licence warns and continues, and the notices then say so. A packaging step
that died there would trade a missing text file for no installer at all.
Verified both ways against a synthetic tree.

### The clause-by-clause case, and the question

1. *Configure flags stated and reproducible, GPL-only components named and
   excluded* — `docs/LICENSING.md` §2, including the trap that every
   licensing-relevant mpv option defaults to `auto` and so resolves against
   whatever is installed on the builder.
2. *Exact upstream versions pinned* — mpv 0.41.0, FFmpeg 9.0.2 "Lei".
3. *Written-offer and attribution satisfied by something in the installer* —
   **now satisfied.** The notices are generated from the packaged tree and
   written into the directory `tauri.conf.json` already ships.
4. *NOT IN SCOPE: stop and report a required patent licence* — reported in
   round 104 as `escalation.commander_decision_required`.

**The question: does clause 3 close, given that the in-application
"Third-party licences" view does not exist?** That view is listed in
`DESKTOP_PLAYBACK.md` §9's outline, not in PW-0208's acceptance, which asks for
"something in the installer". It lives under `apps/web`, outside this surface.
Whether it belongs to this task or a new one is part of what the review
decides, and I did not widen into `apps/web` to pre-empt it.

**And no build was produced** — the honest reading of the acceptance is that it
asks for a recipe that is stated and reproducible, not for binaries that
cannot be built until the commander's patent decision says what they may
contain.

---

## 3a. The new CI failure — reported, not diagnosed

I could not determine the cause and I am not going to name one.

**Two reproduction attempts, neither successful.**
`scripts/test-ai-control-plane.mjs` — the prime suspect, already filed in
round 104 as a defect that copies the working tree ~69 times and holds every
copy — passes locally in **1261 s** ambient and **1807 s** under a runner-like
`--max-old-space-size=4096`. 73 scenarios, exit 0 both times.

**One real confounder came out of trying, and it outlives this failure:** this
container sets `NODE_OPTIONS=--max-old-space-size=8192` and a GitHub runner
does not. **Every local measurement of that suite, round 104's included, was
taken with an 8 GB heap CI never has.** The capped run controlled for it and
still passed, so the heap hypothesis is not supported — but the confounder was
real and nobody had noticed it.

**What the timing suggests and does not establish:** if the runner is ~2.5×
faster than this 2-core container, 1807 s here is ≈11m40 there, so an abort at
10m38 lands near the *end* of that suite rather than early — possibly in its
final `rmSync` of ~69 held copies. That is arithmetic, not evidence.

**Why I am stuck:** the annotation names an exit code and no step, and the log
needs authentication. §9 of the wiring proposal is the smallest fix — a
failure-only step that writes core count, memory, free disk and `NODE_OPTIONS`
to `$GITHUB_STEP_SUMMARY`, which renders on the run page. Those are the four
facts that would have decided this. It does not replace reading the log; it
replaces guessing when the log cannot be read.

**It is not from this round's work.** The delta from the last passing
`validate` is one e2e spec, three `apps/desktop/scripts` files, a doc and the
control-plane state.

---

## 4. The player chain, and why nothing else moved

`PW-0206` is **not** dependency-clear. Unchanged:

```
PW-0307 clause 3 → PW-0306 → PW-0206 → PW-0205 → PW-0204 → PW-0103 (BLOCKED)
```

`ai:dispatch` reports **no conflict-free executable task**. PW-0502 overlaps
PW-0208 on `apps/desktop/**`; PW-0503 and PW-0602 have no Test-lane capacity,
because `claude-test`'s single slot is held by PL-0713 in REVIEW. Everything
outstanding is behind a reviewer, a ruling, or the commander's hardware.

PW-0307 is untouched and preserved as you asked: Northstar's second season, the
`episodeCount` invariant that throws at import, the browser coverage of
selection and the keyboard, per-episode progress, and the pure next-episode
rule.

---

## 5. Bundle

| | |
| --- | --- |
| Base | `30cef6e88a0bac82bf60fd4c9500c5ce4003da8f` (the published head, fetched) |
| Target | the commit carrying this document |
| Content tip before it | `95d8b7658065b4c52699d6e0882ed7d04a119a21` (PW-0208) |

Filename, target sha and sha256 are in the delivery message — an archive cannot
contain the hash of itself. Verified with `git bundle verify`, `list-heads` and
a fast-forward rehearsal from the published head in a fresh garbage-collected
clone; the sha256 reported is read back from the commander's disk after the
write.
