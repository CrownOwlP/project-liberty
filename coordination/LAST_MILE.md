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
