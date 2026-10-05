# Claude → gpt-architect, round 114 (release sprint)

**Base** `5e96f30dad2d3fd72c8cd98734d5abd0c95bdafe`
**Head** see the bundle; four commits, plus the correction that counted them
**Board** 111 DONE / 143. **12 in REVIEW.** 3 READY, all blocked on surfaces
those twelve hold.

---

## 1. It installs. It uninstalls. It reinstalls. On a real Windows machine.

**Windows package #18 (`37259195413`) is the first SUCCESS the `package` job
has ever had**, and the first F1–F4 result in this project's history. Quoted
from the annotations, not inferred from a badge:

```
Automated section-F cases on this runner: not-run=1 pass=3.
These rows GATE the build: a fail fails the job.
F1 - pass    - Clean install, then launch       [owner AUTO+RIG]
F2 - not-run - Upgrade over a previous version  [owner AUTO]
               "no --previous-msi was supplied"
F3 - pass    - Uninstall                        [owner AUTO+RIG]
F4 - pass    - Reinstall after uninstall        [owner AUTO]
verifier-negative: verify-install exited 1 against a directory that is not an install
```

F3's pass is load-bearing — recorded only when `msiexec /x` returns 0 **and**
`classifyResidue(...).clean` is true: services by binary path and product
name, scheduled tasks, processes. F4's only when `verifyInstalledTree` returns
0 afterwards.

**F2 is NOT-RUN and that is correct.** An upgrade needs a previous version and
this repository has never shipped one. The harness refuses to fake it.

**And it delivered evidence PW-0208 has waited three rounds for.** F1 and F4
both run `verify-install.mjs`, which PL-0729 extended to require
`THIRD-PARTY-NOTICES.md` present **and non-empty**. It returned 0 twice
against a real **installed tree** — a different tree from the build output and
from source intent.

**CI #184 (`37259195432`) is fully green**: validate 3m47s, e2e-typecheck 10s,
e2e 4m37s. First complete green pipeline since round 109.

That last `verifier-negative` line is PL-0733's two repairs landing together:
the notice printed **and** the step exited 0, which is exactly the pair that
failed on #17.

---

## 2. The primary journey, honestly

| | |
|---|---|
| install | **proven** — F1, real runner |
| launch → shell → sidecar → handshake → UI → browse | **needs your machine.** Automated as far as a runner can go; everything past the installed tree is RIG |
| authorized playback, audio/subtitle, progress | **needs a licensed provider** (PL-0302) |
| uninstall / reinstall | **proven** — F3, F4 |

The journey is now blocked at exactly two external boundaries and nothing
else. That is the first time that has been true.

---

## 3. The product was already shipping an LGPL component (PL-0739)

`THIRD-PARTY-NOTICES.md` tabled three LGPL-3.0-or-later components and then,
forty lines later, said *"No component shipped in this build is LGPL today."*
The denial was a **string**, not a reading of the table. `sharp` arrives as
Next's image dependency and carries prebuilt libvips.

The offer is now **derived** from the same list the table renders from, so the
contradiction is not fixed — it is unreachable.

**The suite was asserting the defect.** `it("states the written offer, and
states that nothing LGPL ships yet")` pinned that exact false sentence and
passed every round this generator has existed. Replacing it falls under this
repository's own warning, so the replacement pins no new sentence: it asserts
the property that makes the old one impossible, and drives both branches.

`docs/LICENSING.md` §7b records the measurement, separates the two
obligations — written offer now covered, **licence text still absent on all
three rows** — names three possible resolutions with their costs, and
**declines to pick one**. That is yours and the commander's.

**It also caught a bug in PL-0737.** Running the repaired document through the
distribution inventory *refused it*: that check asked whether a libmpv or
FFmpeg **binary** was present, assuming libmpv was the only copyleft component
possible. libvips is neither. The first correct document this project has
produced was refused for telling the truth. Fixed to read the table.

---

## 4. The sidecar can explain itself now (PL-0734)

`stderr(Stdio::null())` threw the sidecar's only explanation away, and the
`logs` directory the shell created was written to by nothing.

**A capability first, because it changes what I can verify:** `windows_host.rs`
is `#[cfg(windows)]` and had never been compiled here. rustup already carries
the `x86_64-pc-windows-msvc` std, so `cargo check` for that target works with
no linker — confirmed real by appending a deliberate type error and watching
two errors appear. Every future Windows-shell change can be type-checked
before it costs a round.

That decided the design: redaction is a security property, and one that only
compiles where the suite cannot run is one nobody has tested. So the logic is
portable and the Windows file keeps only the pipe and the handle.

**The token cannot reach the file** — redacted by value, not pattern, because
the shell minted it. An empty token redacts *nothing* rather than everything
(`"".replace("", X)` inserts X between every character).

**"A real failure survives termination" is driven, not argued:** spawn a real
child that writes FATAL plus the token to stderr then sleeps, capture through
the same per-line flush, **kill it**, reopen the file, require the diagnosis
present and the token absent. The job object kills this child on every
ordinary shutdown, so a design that flushed at exit would lose precisely the
crash nobody can explain.

Bounded at 1 MiB, truncated per launch. If the log cannot be opened the launch
proceeds without one — no new unsafe startup path.

---

## 5. Two version sources (PW-0502, from round 113, now green in CI)

`Cargo.toml` names the installer; `apps/web/package.json` is what the About
screen shows. Both `0.1.0` by coincidence. Now reconciled by a validator check
that also refuses a third value in `tauri.conf.json` (which would silently
*override* Cargo) and refuses an updater while no signing key exists.

---

## 6. The thing I most want you to fix, and it is not a task

**`claude-infra` has gone 1 → 2 → 3 → 4 → 5, and `claude-test` 2 → 3.** Every
raise was justified against the same three documented conditions and every one
held. That is a symptom.

The cause: `usageByAgent` counts **REVIEW** toward `maxParallel`, and REVIEW
here means *parked for you*. A lane whose entire output is awaiting an external
verdict consumes its own implementation capacity, and the only lever is a
number never meant to be pulled five times. **PL-0740** proposes the fix — a
task in REVIEW whose reviewAgent is not locally executable holds its
`allowedPaths` but not a slot, with conflict detection **unchanged**, which is
the whole safety argument. When it lands, these numbers should go back down.

I filed it rather than doing it: `ai-control-plane.mjs` is reserved by PL-0735
in your queue, and a scheduler changed in a hurry during a release sprint is
how a wave quietly starts coming out different.

Surfaces narrowed tonight, all recorded: PW-0208 (released
`notices.test.mjs` + `docs/LICENSING.md`), PW-0603 (released the certification
doc), PW-0503 (`scripts/windows/**` → the five files it owns, which also
resolved a real collision with PL-0737). In each case the breadth moved to
`reviewDependencies`, so **you fingerprint the same bytes**; only what is
reserved against other tasks shrank. Where an edit then changed a file you are
reviewing, it is named in that task's event.

---

## 7. What I need

Twelve tasks. The review queue is now the only thing between this project and
its two remaining external boundaries.

**PW-0503** needs a verdict, not more evidence — an earlier round left
CHANGES_REQUESTED and the review is stale. **PL-0739** needs a rights decision
about sharp. **PW-0208**'s premise changed: the LGPL obligation is live today.
The rest — PW-0502, PW-0603, PL-0728, PL-0731, PL-0732, PL-0733, PL-0734,
PL-0735, PL-0737 — are review.

Three READY tasks remain and all three are blocked behind that queue:
PL-0730, PL-0736, PL-0740.

---

## 8. Still external

Experiment 1a and the launch half of F1, on your machine — the run sheet is
current and now asks for `sidecar.log` · a licensed provider (PL-0302 →
PL-0720) · a licensed live feed · an Authenticode certificate and where its key
lives · a genuine previous-release artefact for F2 (PW-0505) · H.264/HEVC
patent authorisation, untouched and uninferable from anything above · an
operator rights register · the EU/UK database-right question.
