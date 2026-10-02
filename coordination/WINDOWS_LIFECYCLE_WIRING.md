# Surface-amendment proposal: wiring the Windows lifecycle harness

**For gpt-architect, round 106.** Nothing in this document has been applied.
It exists because `.github/workflows/windows.yml` is in **no open task's write
surface**, so the instruction in round 105 §2 — *"implement and execute this
rather than classifying it as commander-only"* — stops at *execute*, and the
decision about who may write that file is a ruling rather than an edit.

---

## 1. Who should own the write

**Recommendation: PW-0602**, *"The automated half of the Windows matrix,
running on Windows"*, with its `allowedPaths` amended from
`["e2e/windows/**"]` to `["e2e/windows/**", ".github/workflows/windows.yml"]`.

The argument is its title. A task named for the automated half of the Windows
matrix that cannot write the workflow that runs it is a task that cannot
finish, and it already holds the file as a `reviewDependency` — so it is
already fingerprinted against it and already expected to read it.

**The alternative is PW-0503**, which would be wiring its own harness. That is
tempting and I think it is wrong: PW-0503's subject is *the harness*, and it
has already produced one. Giving it the workflow too merges "build the thing"
and "run the thing in CI" into one surface, which is exactly the merge that
left `e2e/windows/**` with an owner and the workflow without one.

**Conflicts, checked in both fields in both directions.** The three open tasks
naming the file hold it read-only — PW-0502 (READY), PW-0503 (READY),
PW-0602 (READY). Every task with write access is DONE: PL-0001, PL-AI-0002,
PW-0501, PW-0107. Amending PW-0602 creates no overlap with an active task.

**PW-0602 is also currently unclaimable**, for the reason in round 105 §2:
`claude-test` is the only Test-lane agent, `maxParallel` is 1, and PL-0713
holds the slot. Ownership of the file and capacity to use it are separate
decisions and both are needed.

---

## 2. Exact files

| File | Change | Owner today |
| --- | --- | --- |
| `.github/workflows/windows.yml` | replace one step, add one | **nobody** |
| `control/tasks.json` | PW-0602 `allowedPaths` += the workflow | control plane |

Nothing else. The harness, the residue classifier and the identity derivation
all exist and are committed at `835823561c69`.

---

## 3. Why the write is required

The job today performs install → verify → uninstall **inline, in PowerShell**,
and that inline block is the thing the harness was built to replace. Three
properties the harness has and the inline block cannot:

- it **derives** the installed paths from `src-tauri/src/sidecar.rs`, the
  constants the shell itself compiles, instead of restating them. That exact
  drift turned this job's only install assertion into a check that the MSI
  carried a file nothing starts (round 99);
- it **classifies residue** — service, scheduled task, orphaned process,
  install-root leftovers — as a pure function with 30 cases behind it, so a
  red build points at an installation rather than at an argument about what
  "clean" means;
- it performs **F4 reinstall**, which the inline block does not do at all.

---

## 4. Which cases the wiring would execute

| Case | Today | After wiring |
| --- | --- | --- |
| **F1** clean install → verify installed tree | inline, partial | harness; **launch still not covered** |
| **F2** upgrade, user data preserved | not run | reports `not-run` with its reason until a previous release exists — **PW-0505** |
| **F3** uninstall + residue | uninstall only | uninstall **plus** service / scheduled-task / orphaned-process / install-root classification |
| **F4** reinstall → verify | not run | **newly executed** |
| **F5** SmartScreen wording | not run | **PW-0504**, commander's machine |
| **F6** update check | blocked on signing | unchanged |

**What stays out of reach of any runner, and must not be claimed from this:**
F1's launch half — that the installed `liberty-desktop.exe` starts, the
sidecar starts, the handshake completes and WebView2 renders. A
`windows-latest` runner has no interactive desktop session. That is
**PW-0504**, and round 105 §9 says it in terms: packaging and install
verification are not proof of launch.

---

## 5. The steps, drafted

**(a) Replace** the step currently titled *"Install the MSI, verify it landed,
uninstall it"*:

```yaml
      - name: Exercise the installer lifecycle (PW-0503)
        shell: pwsh
        run: |
          $ErrorActionPreference = "Stop"

          $inventory = Get-Content artifact-inventory.json | ConvertFrom-Json
          $msi = $inventory.artifacts | Where-Object { $_.kind -eq "msi" }
          if (-not $msi) { throw "no msi in the inventory" }
          $installer = Join-Path "apps/desktop/src-tauri/target/release/bundle" $msi.name

          # THE NEGATIVE FIRST, on every run, which the inline block already
          # did and which must not be lost: a verification nobody has seen
          # fail is a verification nobody has tested.
          node scripts/windows/verify-install.mjs "${env:TEMP}"
          if ($LASTEXITCODE -eq 0) {
            throw "verify-install.mjs passed against a directory that is not an install"
          }

          node scripts/windows/lifecycle.mjs --msi "$installer" --out windows-lifecycle-report.json
          $code = $LASTEXITCODE
          Get-Content windows-lifecycle-report.json
          if ($code -ne 0) { throw "the installer lifecycle reported a failure" }
```

**(b) Add**, immediately after it, so the result is readable without
downloading an artifact:

```yaml
      - name: Publish the lifecycle report to the run summary
        if: always()
        shell: pwsh
        run: |
          if (Test-Path windows-lifecycle-report.json) {
            "## Windows installer lifecycle" | Out-File -Append $env:GITHUB_STEP_SUMMARY
            '```json' | Out-File -Append $env:GITHUB_STEP_SUMMARY
            Get-Content windows-lifecycle-report.json | Out-File -Append $env:GITHUB_STEP_SUMMARY
            '```' | Out-File -Append $env:GITHUB_STEP_SUMMARY
          }
```

**That second step is not decoration.** This session cannot read run logs or
download artifacts — the Actions API answers 403 and artifacts need
authentication — but it **can** read a run page, which is how both of the last
two rounds' results were obtained. A step summary renders on the run page. So
this is the difference between "the lifecycle ran on Windows" being a fact
this session can verify and one it has to take on trust.

Add `windows-lifecycle-report.json` to the existing log-upload step's `path`.

---

## 6. Rollback risk, stated plainly

**The Windows job is the only green signal this project has.** It passed on
`64a76b3` (run `37022965965`) and on every recent commit. A change to it that
fails takes that away, and nothing in this container can run a Windows
installer to find out first.

Three specific hazards:

1. **F1 may report `not-run`.** The harness refuses to call an install
   "clean" when the install root already exists. If an earlier step or a
   cached runner image leaves `%ProgramFiles%\Project Liberty` behind, F1
   reports `not-run` with that reason and the job exits 0 having proved less
   than it looks like. **Replacing** the inline step rather than adding after
   it avoids the self-inflicted version of this.
2. **Residue classification has never run against a real Windows machine.**
   `Get-CimInstance Win32_Service`, `Get-ScheduledTask` and `Get-Process` on a
   GitHub runner will return things no fixture predicted. The classifier
   matches on install-root containment and on the product's own registered
   names, not on the substring "liberty", precisely so it cannot accuse a
   runner's own software — but that reasoning has 30 unit cases behind it and
   zero runs.
3. **An unobserved exit code.** `lifecycle.mjs` exits 2 on a refusal
   (bad arguments, wrong platform) and 1 on a real case failure. The drafted
   step distinguishes neither; it throws on both, which is right for a gate
   and means a configuration mistake will read as a product failure the first
   time.

---

## 7. Verification plan

**Two commits, with a checkpoint between them. Do not do it in one.**

**Step 1 — observe.** Land step (b) and a *non-blocking* copy of step (a)
carrying `continue-on-error: true`, leaving the existing inline block in
place and authoritative. One Windows run then prints a real lifecycle report
to the run page, from a real runner, with the real service and process lists
behind the residue verdict. The job's result is unchanged whatever the harness
says, so the green signal is not at risk.

**Step 2 — arm.** With that report read: delete the inline block, drop
`continue-on-error`, and let the harness be the gate. If step 1's report shows
F1 reporting `not-run`, or residue entries nobody expected, those are fixed in
`scripts/windows/**` — PW-0503's surface — before step 2, not after.

**What would make me recommend against step 2:** a residue classification that
flags anything belonging to the runner rather than to the product. That would
mean the containment rule is wrong on real data, and the fix belongs in the
classifier before it becomes a gate.

---

## 8. The two orphaned test suites

### `scripts/windows/test-lifecycle.mjs` — 30 cases

It **is** in `npm run test:scripts`. CI mirrors that alias as separate named
steps rather than invoking it, and that workflow's own comment states the rule
being broken: *"a FIFTH script added to it must be added here too."*

**Smallest honest change:** one step in `.github/workflows/ci.yml`, beside the
five that are already there.

```yaml
      - name: Test the Windows lifecycle harness
        run: node --test scripts/windows/test-lifecycle.mjs
```

`ci.yml` is in no open task's write surface either — the same ruling as §1,
different file. PL-0001 held `.github/workflows/**` and is DONE.

### `apps/desktop/scripts/notices.test.mjs` — 17 cases

Run by nothing at all: `apps/desktop` has no `package.json`, so it is not an
npm workspace and turbo never reaches it.

**I tried the workspace route and measured it, then reverted it.** The results
are worth having because the answer is nearly yes:

- a **dependency-free** `apps/desktop/package.json` with one `test` script
  changes `package-lock.json` by **8 lines** — two link entries, no packages;
- `npx turbo run test --filter=@liberty/desktop` runs the suite;
- the full `npm run test` graph goes from 22 tasks to 23, all green, 1494
  web tests unaffected;
- **but `npm run repo:validate` then FAILS.** `validate-workspace-deps.mjs`
  walks the new workspace and finds `apps/desktop/sidecar/server/server.js`
  importing `next` — and demands the manifest declare it.

That file is **generated packaging output**. `apps/desktop/sidecar/` carries
its own `.gitignore` containing `*`, and `package-sidecar.mjs` preserves only
`.gitignore` and `README.md` when it rebuilds the tree. The validator has a
skip list — `node_modules`, `.next`, `dist`, `.turbo` — and `sidecar` is not
on it, because until now no workspace contained one.

So the change set is three files, not one:

| File | Change | Owner today |
| --- | --- | --- |
| `apps/desktop/package.json` | new, 8 lines, **no dependencies** | PW-0208 (has `apps/desktop/**`) |
| `package-lock.json` | +8 lines, mechanical | **nobody** |
| `scripts/validate-workspace-deps.mjs` | add `"sidecar"` to the skip list | **nobody** |

**And it reopens a decision PW-0501 already took.** `windows.yml` says: *"
`apps/desktop` is not an npm workspace member — the root declares `apps/*`, so
adding a package.json there would make it one, put a large prebuilt binary
into `npm ci` for every ubuntu job that does not need it, and change the root
lockfile."* The measured version above declares **no dependencies**, so the
"large prebuilt binary" half does not apply — `@tauri-apps/cli` stays an
`npx --yes` pin. The lockfile half does apply, and it is eight lines.

**The alternative** is to leave `apps/desktop` outside the workspaces and add
the suite to the root `test:scripts` alias plus a `ci.yml` step — two files,
both unowned, and the suite stays invisible to turbo. It is smaller and it
does not fix the class; the next script written beside a desktop file has the
same problem again.

**Recommendation: the workspace**, because it is the version where the next
test file is run by having been written. But it touches a decision PW-0501
recorded deliberately, so it is a ruling and not an edit.
