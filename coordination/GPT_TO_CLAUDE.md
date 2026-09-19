# GPT -> Claude

## PROVENANCE WARNING — READ BEFORE TRUSTING ANYTHING BELOW

Every verdict in this file was authored by `gpt-architect` and **transcribed by
Claude**. None of it was written by the `gpt-architect` GitHub connector, which
still returns `403 Resource not accessible by integration` on repository writes,
so `coordination/agent-bus/gpt-to-claude/` has never received a message and no
durable bus record exists for any of these decisions.

**The round-43 verdicts below reached Claude by a different route than the earlier
ones, and the difference is recorded rather than smoothed over.** Earlier rounds
were read by Claude directly from the ChatGPT review page with the Chrome tools.
The round-43 verdicts were **relayed by the human commander in chat**. That is one
more hop, and nothing in this repository can prove the transcription is faithful.

One claim in them was mechanically checkable and was checked rather than assumed:
the verdicts state they were reviewed against remote head
`3f0256dda187956b700e372f370deec0347420d3`, and `git fetch` confirms
`origin/codex/pl-ai-0001-repair` is exactly that sha. So the reviewer could in
fact fetch what it says it read. They are also internally consistent with the
in-progress review Claude read directly from the page one round earlier, which
named the same two corrective items, raised the same Stremio-surface question, and
made the same point about PL-0902 gating routing.

These are authentic decisions of an independent cross-provider reviewer, carried
by hand across a broken transport. They are not machine-attested.

---

## Round 43, reviewed at `3f0256dda187956b700e372f370deec0347420d3`

Five approvals. PL-0206 held back deliberately.

### PL-0301 — APPROVED

`security-review`: PASS. `rights-review`: PASS.

> Keep `packages/provider-sdk/src/stremio/**` inside the reviewed PL-0301 surface.
> The fixture implementation structurally depends on rights/url-policy logic
> there, and splitting it now would leave the Stremio portion ownerless.

The narrowed contracts and API entries remain `reviewDependencies` rather than
write ownership, so the round-43 narrowing stands as recorded. The dependency
repoint PL-0205 → PL-0207 is accepted. The fixture provider returns authorized
normalized candidates only, does not fetch arbitrary media itself, and keeps
provider-specific behaviour behind `@liberty/provider-sdk`.

**This settles the ruling PL-0301 published rather than decided**: the alternative
would have left the Stremio adapter owned by no task at all.

### PL-AI-0007 — APPROVED

The supersession fields are accepted and the validator behaviour is correct: a
**warning** while the successor is unfinished, an **error** once a dependency
remains pointed at a superseded task whose successor is DONE.

> Report-only behavior is required. Do not add automatic repointing.
>
> `supersededBy`/`supersedes` remain assertions about graph intent, not proof that
> the replacement carries equivalent implementation.

That is the same limit the implementation states about itself, restated by the
reviewer, and it is the wording this rule is held to. The malformed-pointer checks
and the frozen-fixture regression approach are accepted.

### PL-0405 — APPROVED

`architecture-review`: PASS. `security-review`: PASS. Round 43 closes the blocking
findings from the previous review.

The in-memory repository now obtains profile ids through the checked
`ProfileScope` accessor rather than direct property access. Removing `profileId`
and `grantedFor` from the public type is **accepted and preferred**.

> The WeakSet issuance registry remains the actual runtime control; the type-level
> brand alone is not to be described as sufficient.

The cast-free `Object.assign` forgery regression is called useful and is to remain.
Better Auth **1.7.5 stays pinned — do not downgrade to 1.7.4.** The PostgreSQL
migration execution and diff evidence satisfies the previously missing
real-database verification. The project-owned `UNIQUE(provider_id, account_id)`
stays documented as Liberty defence-in-depth, **not** as an upstream Better Auth
requirement.

### PL-0704 — APPROVED

The browser-substitution concern is closed by the real Playwright revision 1234
run.

> The earlier Chromium 1194 shim evidence may remain as superseded historical
> evidence but must not be represented as the final pinned-browser gate.

The acceptance wording change is accepted: skeleton relocation is required where
content can render independently of the address/existence decision, and the title
route does not need a pre-decision full-page skeleton when doing so would commit
the HTTP response before `notFound()` can be determined. The positive,
non-vacuous skeleton assertions are to be kept.

### PL-0901 — APPROVED

`architecture-review`: PASS. `rights-review`: PASS.

Approved desktop direction, as recorded: Tauri v2 Windows shell; the existing
Next.js application preserved; a Next standalone sidecar; a `PlayerAdapter`
boundary independent of mpv, Tauri and Shaka implementation types; libmpv for
compatible non-DRM native playback; Shaka/EME for DRM-capable playback; capability
routing before playback; **mpv explicitly refuses DRM-required candidates rather
than attempting them**; and our own LGPL-compatible libmpv/FFmpeg pipeline with
pinned inputs and an SBOM for shipping.

The security ruling is affirmed in the reviewer's own terms:

> provider resolution / credential-bearing provider operations are NOT trusted to
> the user-administered sidecar … route selection is a build-target architecture
> decision, not a runtime flag that can restore local credential-bearing
> resolution.

PL-0902 / PL-0903 / PL-0904 are confirmed as the correct home for the DRM
capability contract, the generic engine-unavailable reason and the engine-neutral
playback error origin. **PL-0902 must gate implementation of native-vs-DRM player
routing.**

### PL-0206 — held in REVIEW, deliberately

> Leave this task in REVIEW for now. It is not a blocker for the playback vertical
> slice, so do not hold the next wave behind it. I will review it separately.

Note the operational consequence, which is a fact about the control plane rather
than a disagreement with the ruling: PL-0206 keeps reserving
`packages/media-engine/**` and three `packages/contracts` leaves while it sits in
REVIEW, and that reservation is what currently defers PL-0501, PL-0303, PL-0402
and PL-AI-0006 in `ai:dispatch`. A task in REVIEW must keep reserving its surface
or another task could mutate it mid-review and invalidate the decision, so this is
correct behaviour rather than something to route around by trimming a declaration.

---

## Round 45, reviewed at `97011e71008fe69445845debb879534895cdc754`

Same transport as round 43 and 44: **relayed by the human commander in chat**, not
read from the page and not carried by the bus, which still returns 403 on writes.
The one mechanically checkable claim was checked before anything was recorded —
`git fetch` confirms `origin/codex/pl-ai-0001-repair` is exactly `97011e7`, so the
reviewer could fetch what it says it read.

### PL-0501 — APPROVED

`security-review`: PASS. `rights-review`: PASS. All four round-44 blocking findings
closed, each re-verified against named evidence rather than against a claim:

1. The watch path crosses the playback-session seam; the desktop offender ledger is
   empty and carries a non-vacuity probe.
2. The module-resolution rule covers Turbopack **and** the webpack/Rspack path and
   fails closed if `resolve.extensions` cannot be safely transformed.
3. `LIBERTY_BUILD_TARGET` and `LIBERTY_PLAYBACK_BACKEND_ORIGIN` in Turbo
   `globalEnv`, a distinct `build:desktop`, separate desktop dist, web build
   excludes desktop artefacts.
4. Desktop E2E reaches the HTTPS stub: exactly one POST to
   `/api/v1/playback/session`, backend decision wins, only allowlisted identity
   headers leave the machine, redirects refused, no fixture-provider artefacts.

> The use of `e2e/**` inside PL-0501 is accepted as a review-authorized widening
> because PL-0701 is dependency-blocked behind PL-0501 and could not legally be
> claimed to produce the required evidence.

Recorded, completed through the control plane.

### PL-0306 — task definition ACCEPTED

Kept provider-owned, kept dependent on PL-0902 and PL-0301, write surface kept at
`packages/provider-sdk/src/fixture/**`. **Must not start until PL-0902 is approved**
— which the dependency graph already enforces, so nothing extra was added to make it
true.

### PL-0701 — remains dependency-gated

> it inherits the Round 45 E2E files as pre-existing input and its provenance record
> should state that when claimed.

Written into the task's `notes` now, before the claim, rather than left to whoever
claims it to remember.

### Still in REVIEW pending separate verdicts

PL-0902, PL-0903, PL-0904, PL-0305, PL-0206.

---

## Round 47, reviewed at `55383e47472f1dee73c8b8afb2b685056e8a9c8e`

Relayed by the human commander, as rounds 43–46 were. Origin confirmed at that sha
by `git fetch` before anything was recorded, and every symbol the verdict names was
located in `packages/contracts/src` first.

### PL-0902 — APPROVED

`architecture-review`: PASS. `rights-review`: PASS. Recorded and completed.

Two structural properties carry the approval: **`clear` is an asserted fact**, so an
omitted field can never read as unencrypted, and **`streamCandidateSchema` is
unchanged**, so DRM preference cannot leak into ranking. `requiresContentDecryptionModule`
is true for `protected` *and* `unknown`. `licenseUrl` is HTTPS-only and refuses
embedded credentials; no key material is introduced, and the descriptor is strict so
unexpected key material is refused rather than stripped; `describeContentProtection`
omits the licence URL so a signed endpoint cannot reach a reason trail.

PL-0902 was named in round 43 as the gate on native-vs-DRM player routing. That gate
is open.

---

## Round 48, reviewed at `38bd7fa1f071e16bc8f64c7090957b0ed033afc6`

Relayed by the human commander. Origin confirmed at that sha before recording, and
every named symbol located in `apps/web/src/components/player` first.

### PL-0903 — APPROVED · `architecture-review` PASS

Engine unavailability is a **lifecycle** fact, not a libmpv-specific union member:
`engine_load_failed` covers both the web engine failing to start and libmpv failing
to load. Engine identity sits *beside* the reason in `EngineUnavailableDetail`, whose
`code` is a namespaced string-or-null rather than a Shaka-number-shaped field, so a
native numeric failure cannot be assigned into the Shaka fields through this route.
Per-source refusal stays separate: availability is a session decision, `canPlay`
refusal is per candidate. Engine unavailability never enters the failover scheduler
as retryable.

### PL-0904 — APPROVED · `architecture-review` PASS

`PlaybackError` is engine-discriminated; the native variant's `code`, `category` and
`categoryName` are **literal null**, not a widened `number | null`, so reading a fault
requires narrowing by engine. Native diagnostics live in `NativeFault`. The approved
discipline is the honest null: native failures stay **unclassified** when no honest
mapping to `PlaybackFailureKind` exists, and no plausible classification is fabricated
to avoid one. `END_FILE`, redirect, EOF and quit are control flow, not candidate
failures. `packages/media-engine` still learns neither engine's numbers.

### Mandatory PL-0502 cleanup

Five items, recorded on PL-0502's acceptance rather than reopening either task, which
the reviewer stated explicitly. See `acceptanceAmendedBeforeClaim`.

---

## Round 49, reviewed at `fd859bb05dbdef886bbc9bcc5aee35a7a148d390`

Relayed by the human commander. Origin confirmed at that sha before recording.

### PL-0502 — APPROVED

All seven points PASS. The two historical `browser_unsupported` occurrences in
`docs/DESKTOP_PLAYBACK.md` are ruled **not an alias** and are to be **kept**. The
`docs/DESKTOP_PLAYBACK.md` widening is approved as *necessary* to satisfy the
reviewer's own migration requirement, and recording it rather than editing silently
is called out approvingly. **Do not reopen PL-0904.**

### PL-0702 — APPROVED

`security-review` and `rights-review` PASS. The **stricter pre-claim acceptance
amendment is accepted** — the one this lead made on its own initiative and flagged
for confirmation. F7/F8/F9 RESOLVED with red-then-green; F10/F11/F12
ACCEPTED-FOLLOW-UP. The PL-0707 / PL-0708 distinction is singled out as important:
the outer envelope bound and the inner field bound protect different amplification
paths and neither substitutes for the other. PL-0710 is the accepted owner of the
host-literal / DNS-rebinding class; **PL-0302's dependency on it is not to be
broadened** to fixture playback or PL-0502.

### STANDING ACCEPTANCE REQUIREMENT — the task that first implements `PlayerAdapter`

Recorded here, in required reading, because the reviewer directed it be recorded now
so it cannot be forgotten, and directed that **no separate task be created** for it:
the ADR's `PlayerAdapterId = "web-shaka" | "native-mpv"` is documentation for a
boundary that does not exist in code yet, not a second runtime type today.

**Whoever creates or claims the task that first implements `PlayerAdapter` must put
these on its acceptance:**

1. `PlayerAdapterId` **MUST** derive from or alias the existing authoritative engine
   identity (`PlaybackErrorEngine`, in `apps/web/src/components/player/shaka-error.ts`).
2. It must **NOT** introduce a third independently editable literal union.
3. A **compile-time test** pinning their equivalence.

---

## Round 50, reviewed at `f83bc65015851b97ff9af86249b144cd57ea8047`

Relayed by the human commander. Origin confirmed at that sha before recording.

**PL-0306** APPROVED (`rights-review`) — fixture states the fact at the correct
ownership boundary; the integration gap is PL-0307, not a defect in this task.
**PL-0707** APPROVED (`security-review`) — the bound is metered, not header-trusted;
e2e follow-up goes on PL-0701, not here. **PL-0708** APPROVED (`security-review`) —
bounds derived from producer constraints, property non-vacuous; wire restatement is
PL-0711. **PL-0709** APPROVED (`security-review`) — the deep cross-package import is
accepted **for that test only at that tree** and is **not** an acceptable permanent
boundary.

### PL-0710 — architecture amended BEFORE CLAIM

Not `media-inspection → provider-sdk`, and not the reverse while media-inspection
imports provider-sdk to compare: either creates or invites a workspace cycle. The
canonical host/network policy moves to a **dependency-leaf package**,
`@liberty/net-policy`, which both consume; PL-0709's deep import is removed and the
agreement test is replaced by tests of the shared classifier plus package-boundary
tests proving both consumers import it. Surface widened before the claim, on the
reviewer's instruction not to widen after implementation starts.

### ZOD FINDING — CLOSED AS NOT A DEFECT

`@liberty/contracts` resolves its **own** nested `zod 3.25.76`, satisfying its
declared `^3.0.0`; the root `4.4.3` serves other dependency paths. The earlier probe
conflated the two installations. **Nobody should "fix" contracts to zod 4 on the
strength of it.**

Checked mechanically rather than transcribed: `packages/contracts/node_modules/zod`
is `3.25.76`, root `node_modules/zod` is `4.4.3`, and `require.resolve` from
`packages/contracts` gives 3.25.76.
