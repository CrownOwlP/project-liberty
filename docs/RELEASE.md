# Releasing Project Liberty

What a build calls itself, how you can tell which one is installed, and what
this product does **not** do about updates.

> **There is no updater.** Not disabled behind a flag, not configured and
> switched off — absent, deliberately, and asserted absent by
> `scripts/validate-repo.mjs`. §3 says why, and what has to exist before that
> changes.

---

## 1. One version, in two files that must agree

Two files carry it, because two toolchains each require one in their own
manifest and neither reads the other's:

| File | What it decides |
| --- | --- |
| `apps/desktop/src-tauri/Cargo.toml`, `[package] version` | the name Tauri gives the installer — Windows #16 and #17 both produced `Project Liberty_0.1.0_x64_en-US.msi` from it |
| `apps/web/package.json`, `version` | what the **About screen shows a user** (PW-0308 renders it; `settings.test.tsx` asserts it is read and not pasted) |

`apps/desktop/src-tauri/tauri.conf.json` deliberately declares **no** version.
Tauri uses that field when present and falls back to Cargo's when absent, so a
value there would not disagree with Cargo — it would silently **override** it.

**The duplication is not the problem; the silence was.** `checkVersionAuthority`
in `scripts/validate-repo.mjs` fails the build when the two disagree, when
`tauri.conf.json` grows a third value that does not match, or when either is
missing. It runs in CI's `validate` job before `npm ci`, and in
`npm run repo:validate` locally, so a half-done bump is caught on the machine
that made it rather than in a defect report three weeks later.

**To release a new version, change both, in one commit.**

## 2. Telling which build is installed

Three independent answers, which is a feature as long as they agree:

1. **The About screen** — the version the running application claims.
2. **The installer filename** — `Project Liberty_<version>_x64_en-US.msi`.
3. **`artifact-inventory.json`** (PW-0501) — every artifact that build
   produced, with its SHA-256, written by the job that built it.

A defect report needs the first and third: the screen says what is running,
the inventory says which bytes that was. `docs/WINDOWS_CERTIFICATION.md`'s run
sheet asks for both, and for the CI run id, and says *never "latest"*.

**What the inventory is not.** A SHA-256 taken by the job that built the file
proves the bytes are the bytes. It is not a signature, not a provenance
attestation, and not evidence that the installer installs anything.

## 3. Updates: there are none, and that is a decision

PW-0502 separates the update story into parts. Here is the honest state of
each:

| | |
| --- | --- |
| Version authority | **Done.** §1, asserted by the repository validator. |
| Installed-version evidence | **Done.** §2. |
| Update discovery | **None.** No endpoint is configured or contacted. |
| Update download | **None.** |
| Signature verification | **Impossible today.** No Authenticode certificate exists. |
| Application / restart | **None.** |
| Rollback | **None.** §4. |

**Why it is absent rather than built and disabled.** PW-0502's acceptance is
explicit: *"an updater that fetches and executes an unverified binary is a
remote code execution feature"*, and *"if signing is unavailable the update
path must be disabled by default and say so, rather than shipping an unverified
one"*. `docs/SECURITY.md` ranks unauthorized access above convenience. An
auto-updater without signature verification is the single most dangerous
feature this product could grow, because it converts any compromise of one
endpoint into code execution on every installed machine.

So there is nothing to disable. The validator asserts the absence, and the day
somebody adds an updater before the rest of this section is true, the build
goes red with that paragraph quoted at them.

**What has to exist first** — all of it, not some:

1. An Authenticode certificate, and a decision about where the private key
   lives: a hardware token the commander holds, or a CI secret. That second
   choice is itself an owner decision. **LAST_MILE item 6.**
2. Signature verification of the update payload *before* it is executed —
   verification after download and before hand-off, failing closed.
3. A pinned, allowlisted update endpoint, held to the same egress policy as
   every other outbound call in this repository.
4. A rollback story, or §4's stated decision carried forward deliberately.

Until **1** lands, nothing else on that list can be built honestly, and 1 is
not an engineering task.

## 4. Rollback

**There is none, and the alternative is stated rather than implied.**

A user on a bad build uninstalls it and installs the previous MSI. That works
because of a fact `scripts/windows/installed-identity.mjs` records and the
lifecycle harness verifies: the installer never creates
`%LOCALAPPDATA%\app.projectliberty.desktop`, so **an uninstall cannot remove
it and user data survives**. Settings and progress are still there afterwards.

Two honest caveats:

- Keeping the previous MSI is currently the user's problem. CI artifacts
  expire after **14 days**, and no release archive exists.
- Downgrading across a database migration is **not** covered. Migrations move
  forward; an older build meeting a newer schema is untested. Until there is a
  release to downgrade *to*, this is a gap to close with the release process,
  not a bug to fix now.

## 5. Signing, and what the commander sees without it

The installer is unsigned and will stay unsigned until item 6 of
`coordination/LAST_MILE.md` is satisfied. SmartScreen and Defender will warn on
first run. That is **row F5** of the certification matrix — an expected
observation to record, not a defect — and PW-0501 ships the installer anyway,
because an unsigned build the commander can install is worth more than no
build.
