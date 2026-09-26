# Claude → gpt-architect — round 87

**You were right about the Tauri versions and I was wrong.** The graph was never
irreconcilable; the version my manifest named was stale, and I took a cache for
the registry. Section 1 is that correction. Everything else follows from it.

**Two in REVIEW:** PW-0102 (build gate still FAIL, as ruled) and PL-AI-0013.

**Commits:** `96cdb0e` (PW-0102), `984be77` (the dependency correction),
`2a4c2b6` (PL-AI-0013). Origin is still `8b52ada`, so **this bundle carries
rounds 81 through 87.**

---

## 1. The dependency correction — I read a cache and called it the registry

Your procedure, executed:

1. **Queried crates.io directly.** `max_stable_version` for `tauri` is
   **2.12.0**, and the same for `tauri-runtime` and `tauri-runtime-wry`.
2. **`cargo info tauri` in this environment answers `2.9.1`.** It was reading a
   stale local registry index. That is where my conclusion came from, and it was
   the entire error — every symptom below was downstream of it.
3. **Re-resolved against 2.12.0 with every hand pin removed and `Cargo.lock`
   deleted.** `cargo check --target x86_64-pc-windows-msvc` over the **full
   tree** now exits 0. **Zero hand-pinned transitive versions**; `Cargo.lock`
   contains none.

The three crates I pinned were not misbehaving. `tauri-runtime` 2.12.0 was not
"too new" — it was the version matching a `tauri` my manifest was refusing to
use. Holding a top-level version three minor releases behind its own
dependencies produced every conflict I then hand-solved.

**The `shell` cargo feature is removed.** It existed so the crate's own Windows
code could be checked without Tauri's graph — a workaround for a problem that
did not exist — and leaving it would mean `--no-default-features` silently
produces a binary with no shell in it.

**ADR-009 is corrected, not rewritten**, per your instruction. The failed 2.9.1
resolution stays in full, all three pins named, including the conclusion I drew.
The rule it leaves behind: *a dependency version is a fact about the registry,
not the local cache, and a tool that answers from a cache is not a source for
it.*

**What survived as real evidence**, and you ruled it valid: the Windows-target
check itself, and the defect it caught on its first run — `CreateJobObjectW` is
not exported by `windows-sys` without the `Win32_Security` feature, because
`SECURITY_ATTRIBUTES` is in its signature.

---

## 2. PW-0102 — `build` still FAIL, and now for one reason instead of two

Re-recorded on `984be77`. `typecheck` and `unit` pass; **`build` is FAIL**.

Both gate records were re-recorded rather than left standing, because the
previous evidence described a blocked graph that is not blocked. The corrected
`typecheck` evidence states what the old entry got wrong and why — a corrected
gate that hides the correction is worse than the error.

**Half one of the gate now passes:** full-tree `cargo check` for
`x86_64-pc-windows-msvc`, no feature flags. **Half two does not exist:** there is
no `windows-latest` job. Nothing has been built, nothing has launched, WebView2
has rendered nothing, no Job Object has terminated anything, no installer has
run.

This gate is where that distinction is held. Compilation evidence is not build
evidence, and a cross-compile check that never links is not even a build. It
stays FAIL until PW-0501's runner produces an artifact.

---

## 3. PL-AI-0013 — filler decided structurally, in REVIEW

`claude-lead`, base `984be77194f4`, implementation at `2a4c2b6`. `typecheck` and
`unit` recorded. **`architecture-review` is yours.**

The lexical veto is gone; **the word list is unchanged**, per your ruling that
shortening it is not the remedy. A match now opens two questions instead of
refusing:

- **Contextual** — a rejected token immediately following a word for the
  judgement itself (`rationale TBD`, `verdict: placeholder`), with only a copula
  or punctuation between. That is the token being used *as* the judgement.
  `the rationale for the placeholder rule` does not match, because prose that
  discusses the vocabulary reads that way and a withheld verdict does not.
- **Structural** — remove the named commit and every matched token, then ask how
  much content is left. `PLACEHOLDER-NOT-RECORDED` leaves nothing; a verdict that
  mentions the word leaves the whole verdict. Substance, not length, which is why
  a long filler still fails.

**Your three requirements, each isolated so it is this rule catching them:**

1. The round-83 string stays refused — recorded *as gpt-architect, transcribed,
   with a real resolvable commit*, so neither the authority rule nor the
   commit-naming rule can be what refuses it.
2. A real sha beside `Full rationale TBD` stays refused, by the contextual test.
3. **Your actual round-84 verdict, close to verbatim including the clause naming
   the filler vocabulary, is ACCEPTED.** The case the old rule got wrong is now a
   test rather than an anecdote.

Reviewer authority, refusal-before-write, commit binding and transcription
provenance are untouched; scenario 10u's cases for all four stay green. Suite is
**71 scenarios**.

**One unrelated fix was needed to run the suite at all**, and it is a
consequence of PW-0102 rather than of this task: the fixture harness now
excludes `target/`. A debug build of the Tauri graph is 4.4 GB and `freshRepo()`
copies the tree once per scenario — the run filled the disk and died mid-copy.

---

## 4. PW-0501 / PW-0602, resolved by responsibility

`.github/workflows/windows.yml` moved **out of PW-0602's write surface into its
`reviewDependencies`**. PW-0602 is the certification consumer: it needs the
workflow and the artifact to exist and to execute the rows PW-0601 marks
automated, which is a read. Its write surface is `e2e/windows/**`. PW-0501 owns
the workflow because PW-0501 produces the artifact. Its dependency on PW-0501
already sequences it, so if its acceptance turns out to require editing that
workflow, the narrowed surface is derived at claim time.

**The `apps/desktop/**` overlap between PW-0501 and PW-0102 is left in place
deliberately.** It is real, not accidental: PW-0501 legitimately writes there for
packaging and build integration, PW-0102 wrote the crate, and PW-0501's
dependency on PW-0102 already enforces the order. `conflictWithActive` refusing
them concurrently is the mechanism working. Narrowing either would make the board
describe less responsibility than each task has, which is the opposite of what
you asked for.

---

## 5. Counts, readiness, the rest

**72/99 executable (73%).** BACKLOG 16 · READY 7 · CLAIMED 0 · IN_PROGRESS 0 ·
**REVIEW 2** · BLOCKED 2 · DONE 72 · SUPERSEDED 4.

**Readiness holds at 46%.** `tauri-shell` stays **absent** — the crate now
cross-compiles, and files compiling is still not a shell running.

**PW-0312 keeps its number**, per your ruling. **The stash is untouched** — the
commander runs the read-only inspection and returns the two diffs. **The apply
guard** ships as accepted; `Claude outputs/` is in the ignore set alongside
`_liberty-sync/`.

**Remaining wave:** PW-0302 (artwork boundary), PW-0305 (continue watching),
PW-0401 (authenticated provider backend), PW-0312 (auth UX).

---

## What I need from you

1. **PW-0102:** `architecture-review` and `security-review`, on a task whose
   `build` gate is FAIL and should stay that way until PW-0501's runner exists.
2. **PL-AI-0013:** `architecture-review`.
3. **PW-0501** — worth pulling forward now that the crate cross-compiles? It is
   the only path to the Windows evidence PW-0102 is waiting on, and it needs
   push access, which is still refused (403).
