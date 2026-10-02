# Why this directory holds no specs (PW-0503)

`e2e/windows/` is declared in PW-0503's write surface and is deliberately
empty of tests. That is a decision, not an oversight, and this file is here so
the next person does not have to infer it from an absence.

## The lifecycle is not a browser problem

Everything PW-0503 is accountable for happens to an **installation**, not to a
page: `msiexec /i`, the tree the MSI left under `%ProgramFiles%`, an upgrade
over a previous version, `msiexec /x`, and what survives it. Playwright drives
a browser. Putting those steps behind `@playwright/test` would buy a test
runner and pay for it with a browser nothing here needs, a second config to
keep in step with `e2e/playwright.config.ts`, and a `webServer` block starting
an application the uninstall case exists to remove.

So the harness lives in **`scripts/windows/`** and runs under `node --test`:

| File | What it is |
| --- | --- |
| `lifecycle-cases.mjs` | the matrix, **read out of** `docs/WINDOWS_CERTIFICATION.md` section F rather than retyped |
| `installed-identity.mjs` | product name, identifier, executable and sidecar paths, all derived from `tauri.conf.json`, `Cargo.toml` and `sidecar.rs` |
| `residue.mjs` | what an uninstall is allowed to leave behind — pure, so the reasoning is testable without a Windows machine |
| `lifecycle.mjs` | the runner. Refuses to execute anywhere but `win32`, with exit 2 and a reason |
| `test-lifecycle.mjs` | 30 cases over all of the above, including one that runs the real script here and asserts it refuses |

## What would belong here

A Windows-specific **browser** assertion — something about the WebView2 the
shell hosts, driven through a page rather than through the installer. Nothing
like that exists yet, and `e2e/playwright.config.ts` is outside PW-0503's
write surface, so a spec placed here this round would be a file no
configuration runs. An empty directory with a note is more honest than a spec
nothing executes.

## The two gaps this round could not close, named rather than left

1. **No CI step runs the harness.** `.github/workflows/windows.yml` is a
   *review dependency* of PW-0503 — read-only — and PW-0602 owns the automated
   Windows matrix. The harness is ready for a runner to call; nothing calls it
   yet.
2. **`scripts/windows/test-lifecycle.mjs` runs locally but not in CI.** The
   `npm run test:scripts` alias names it as of this round. CI mirrors that
   alias as separate named steps instead of invoking it, and
   `.github/workflows/ci.yml` is in no active task's surface here, so the
   suite still has no named CI step. The comment block in that workflow states
   the rule being violated in terms: *"a FIFTH script added to it must be
   added here too."*
