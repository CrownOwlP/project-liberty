# LAST-MILE queue

Work that cannot be completed from the cloud engineering session because it needs
credentials, a privileged machine change, physical interaction, billing, external
authorization, or an owner-only consequential decision. Everything here has been
taken as far as it can go without the gate; nothing here is waiting on engineering.

Maintained by the lead. An item leaves this file when the gate is satisfied, not
when it is worked around.

---

## 1. Pushing to `origin` — BLOCKED, owner action names the fix

This container cannot push. The refusal is explicit and is an access-control
setting rather than an obstacle:

```
remote: access denied by the git proxy: CrownOwlP/project-liberty is not in this
session's authorized repository set, so the proxy will not inject a credential for
it. To fix, add the repository to the session's sources.
```

Checked rather than assumed: no `gh` CLI is installed, and the proxy reports
`gitConfigInjection: true` with this repository outside the authorized set. There is
no second path, and looking for one would be working around an access control rather
than around a bug.

**Owner action:** add `CrownOwlP/project-liberty` to this session's sources. Until
then every round ships as a signed git bundle plus an `APPLY-ROUND-NN.cmd` written
into `D:\project-liberty\_liberty-sync\`, and the operator runs it with `--push`.

**Cost of the workaround, stated so it is not mistaken for free:** rounds 53 and 54
both sat unapplied, so `origin` was two rounds behind while the reviewer was reading
a stale control plane. That was only caught because the round-54 apply script would
have refused on its own `EXPECTED` check. A combined bundle fixed it, but the failure
mode — a reviewer confidently reviewing a tree nobody had shipped — is the one this
gate keeps recreating.

## 2. Windows Session Fabric driver / reboot — PENDING OPERATOR APPROVAL

Standing gate. **Not touched and will not be:** no display driver install, no change
to certificate stores, Secure Boot, test-signing or GPU drivers, no privileged
display configuration, no reboot.

No Project Liberty task currently depends on it. Recorded here so that it is visible
rather than remembered.

## 3. A licensed production provider — PL-0302, blocked on an owner decision

`PL-0302` (first production provider) is BLOCKED and the blocker is not engineering:
it requires a confirmed licensed API or provider, and credentials for it. The
security prerequisite is now met — `PL-0710` landed resolve-and-pin and `PL-0302`
depends on it — so what remains is a commercial and legal decision plus credentials.

Same shape for `PL-0602` (live provider integration): licensed live feed access.

## 4. An operator rights register — no task, and correctly so

`PL-0305` wired a real metadata source behind the application's port, and a
configured deployment still publishes **nothing**, by name, per record, because no
operator rights basis is established for any work. That is the system working: a
source knowing a work exists is not authorization to surface it.

Establishing the register is an operator and legal act, not a coding task, which is
why none exists. `docs/CATALOG_SOURCE.md` carries the detail.

## 5. EU/UK sui generis database right — counsel, unanswered since round 45

Raised when the Wikidata source landed and still open. CC0 on the records does not
answer it; the right subsists in the compilation. Nobody has asked counsel.

This is not blocking any current task. It is recorded because "a real source is
wired" and "a catalog may lawfully be served" remain different statements, and the
gap between them is a legal question rather than an engineering one.

## 6. Windows code-signing certificate — PW-0502 depends on it

An Authenticode certificate is owner-held and cannot be provisioned from an
engineering session. Two consequences, both stated so neither is worked around:

- **The installer will warn.** An unsigned installer trips SmartScreen and
  Defender. PW-0501 ships it anyway, because an unsigned build the commander can
  install is worth more than no build.
- **Auto-update stays OFF until a certificate exists.** PW-0502's acceptance
  requires signature verification on update payloads, and an updater that fetches
  and runs an unverified binary is a remote-code-execution feature. If signing is
  unavailable the update path is disabled and says so, rather than shipping an
  unverified one.

**Owner action:** obtain an Authenticode certificate (EV or standard) and decide
where the private key lives — a hardware token the commander holds, or a CI
secret. That second choice is itself an owner decision, not an engineering one.

## 7. The real-device Windows certification run — PW-0603 produces the sheet

Nothing in the cloud session can observe a Windows machine. The linked computer
exposes an isolated **Linux** VM, and this container's Rust toolchain targets
`x86_64-unknown-linux-gnu` only — so **no Windows binary can be built or run from
the engineering session at all.** A `windows-latest` CI runner substitutes for a
build machine (PW-0501), and the rest is the commander's.

Owner-run and not delegable, because each needs the actual hardware:

- **Experiment 1a** (PW-0103) — whether a child HWND composites beneath the
  WebView2. **The whole choice of Tauri rests on this and it has never been run.**
  A failure reverses D1 rather than being worked around.
- Real playback: 1080p, 4K, **HDR where the display supports it**, hardware
  decoding, multichannel audio.
- Lip-sync / A/V offset, which needs the external flash-and-blip rig
  `docs/AV_SYNC_MEASUREMENT.md` specifies. The browser cannot measure it; that is
  settled, not pending.
- Sleep/wake, long sessions, memory/CPU/GPU behaviour, clean install, upgrade,
  uninstall/reinstall.

**Owner action:** run the sheet PW-0603 delivers, on a recorded environment
(Windows build, GPU, driver, display, audio device), and hand back the results.
A pass on unrecorded hardware is not reproducible evidence, and **no row of that
matrix may be marked passed from this session.**

## 8. Push access is now a build blocker, not an inconvenience

Item 1 above changes character in this phase. While the product was a web
application, an unapplied round cost a stale review. Now that the only way to
build a Windows artifact is a `windows-latest` CI job, **an unpushed round means
no Windows build exists at all** — the engineering session cannot compile one and
the runner never sees the commit. Every Windows build/packaging/certification
task is downstream of item 1.
