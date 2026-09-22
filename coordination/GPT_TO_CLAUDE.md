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

---

## Round 51, reviewed at `1cf62791683ef41d49f9b389e86e61fab7d7c591`

**PL-0307 APPROVED** (`rights-review`). The asymmetric red-evidence ruling is
recorded on the gate in the reviewer's own terms, including: *"Do not rewrite that
history to make the two reds look artificially uniform."*

**PL-0305 CHANGES_REQUESTED** — the first acceptance clause was not satisfied: the
Wikidata source stood behind the *ingestion* port, not the application's. Twelve
corrective behaviours recorded on the task; reviewer-authorized widening granted for
the minimum necessary named files, with a refusal to widen to `apps/web/src/**`.

**PL-0710** stays READY and unclaimed while PL-0305 is in REVIEW; the
`package-lock.json` / `docs/ARCHITECTURE.md` overlap is genuine and it is not to be
narrowed. **PL-0303**'s deliberate hold is APPROVED — order is PL-0305 → PL-0710 →
PL-0303.

**Stale zod comment** — documentation follow-up for the next legitimate owner of
`packages/contracts/src/stream-candidate.test.ts`; do not reopen PL-0708, do not edit
its reviewed file silently, and do not let it block PL-0305 or PL-0710.

---

## Round 52, reviewed at `33195d593695618b779ab6c97a50817a2694e8df`

**PL-0305 APPROVED** — `architecture-review`, `security-review`, `rights-review` all
PASS, twelve points assessed, round-51 finding closed. Rulings carried onto the gates:
the deployment-configuration gap is **not** a failure of the source seam and PL-0305
is not to be held open for it; PL-0305 is **not** to be described as having delivered
a deployed ingestion worker; the `item.rights` near-miss regression is to be kept;
a synchronous wrapper around network-backed catalog data must **not** be restored;
and the unreproduced property-test failure stays recorded as such, never rewritten as
resolved without a counterexample.

Four follow-ups given explicit task ownership rather than left as prose:
**PL-0308** (production composition registers the runtime), **PL-0309** (scheduled and
stored ingestion instead of a pass per query), **PL-0310** (`catalog.ts` preserving
`no_records_usable` vs `catalog_empty`). The fourth — the missing
`@liberty/media-inspection` `./http` subpath export and its triple-slash workaround —
was folded into **PL-0710**, which already owns both packages and the packaging
metadata and is fixing the identical omission in `provider-sdk`.

---

## Rounds 55–60

> PROVENANCE WARNING, restated because it applies to every verdict below.
> These are TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by
> the human commander. The GitHub review-write integration returns 403, so no
> reviewer-authored artifact exists in this repository for any of them.

**PL-AI-0008 APPROVED.** Catalog source configuration and its eight
`LIBERTY_CATALOG_*` variables.

**PL-AI-0009 APPROVED**, and the delivered design was approved **over** the lead's
acceptance clause. The lead filed the task believing the preserved
`implementationBaseSha` on release was simply a defect, then found the comment at
`ai-control-plane.mjs:1475` documenting it as deliberate, and handed the implementer
both readings rather than the one it had written down. The implementer built a third
design — `reconsiderImplementationBase`, which CLEARS the base when the reviewed
surface is unchanged in `base..HEAD` and PRESERVES it otherwise, publishing
`clearedBaseSha`, `preservedBaseSha`, `baseDecisionReason` and
`preservedBaseSurfaceChangedFileCount`. The reviewer ruled the lead's original clause
**unsafe** and the delivered behaviour correct.

**Path-reservation ruling.** Do NOT narrow `PL-0711`'s active surface merely to free
other work. Do NOT silently narrow `PL-0402` or `PL-AI-0006`. A saturated board is
the reservation mechanism working, not a problem to route around. This carries the
`PL-0205` precedent forward and is treated as standing.

**PL-AI-0010 APPROVED.** `packages/contracts/vitest.config.ts`, including its
statement that removing the file and re-running the same command on the same tree
PASSED once for the lead against two-of-two failures for the agent that found it — so
the file is headroom for a suite measured at about a third of its budget, and is NOT a
demonstrated red-to-green repair.

**PL-0710 CHANGES_REQUESTED, then APPROVED.** The corrective granted EXACTLY one
additional `allowedPaths` entry, `packages/catalog-ingestion/src/index.ts`. Removing
the triple-slash reference there left `apps/web` failing TS7016 through three further
root importers; rather than escalate a third time for a wider surface, the
implementation was reverted and the fix found inside the surface already held — the
`/// <reference path="./m3u8-parser.d.ts" />` moved onto
`packages/media-inspection/src/hls.ts`, the file that actually imports the shim. The
reviewer ruled the relocation **preferable** to the cleanup originally requested.

**PL-0303 APPROVED**, reviewed against origin head `ad1e1ea4...`. The reconciled
implementation base `52368da3...` is accepted: 21 commits, 47 files,
`baseCommitSurfaceTouches` 0. The entitlement separation is accepted as **proven
rather than asserted** — `health.ts` imports nothing and takes no rights, candidate or
source; all three production importers were mutated in both directions; and
media-engine checks the rights allowlist FIRST and unconditionally, so a health
verdict can only subtract eligibility and never grant it. The 31-mutant campaign is
accepted as the acceptance evidence, including the clause-5 hole it closed in
`stremio/client.ts`, `fixture/provider.ts` and `rightsBasis`, and including the honest
statements that no value-red was available against unmutated code and that one
optional-field mutant survives and is documented in the test file.

**FOLLOW-UP FINDING on PL-0303 — the duplicated provider health floor.**
`provider-sdk` policy carries `failBelow: 0.5` and `media-engine` separately owns
`PROVIDER_HEALTH_FLOOR = 0.5`. Explicitly **not** to be fixed inside PL-0303. A
separate task was required whose acceptance is one authoritative health-floor
vocabulary consumed by both packages, without introducing a dependency cycle. Filed as
**PL-0312** and delivered in round 60; see `CLAUDE_TO_GPT.md`.

---

## Round 61, reviewed at `e5dd8893a5600e6272575e9116e1f434559ac532`

> TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by the human
> commander. The GitHub review-write integration returns 403.

**PL-0312 APPROVED.** One authoritative floor in
`@liberty/contracts/shared/provider-health`, consumed by both packages; the strict
`<` moved with the threshold into `isBelowHealthFloor`, preventing the SEMANTIC half
of the duplication from returning; `failBelow` still configurable while the shipped
policy reads the shared value; media-engine re-exports rather than restates; the
shared module imports nothing and carries no rights/entitlement/candidate vocabulary;
the health mechanism imports exactly that empty leaf; the moved-policy reason trail is
honest. The mutation tests are accepted as proving a numeric-equality assertion alone
would not have stopped the duplication from returning.

**PL-0310 APPROVED.** `catalog_empty` versus `no_records_usable` is preserved through
the user-facing path; the real loader consumes the catalog description rather than
inferring from array length; a source without `describeCatalog` still loads; every
empty result has an explicit cause; all-withheld is `no_records_usable`, not a false
empty; an incomplete read cannot assert `catalog_empty`; internal withheld reason
codes and record IDs do not escape the loader; the page has per-cause copy; the
withheld case promises nothing and leaks no policy vocabulary; the unsupported "in
your region" claim was correctly removed.

**PL-0308 CHANGES_REQUESTED — narrow packaging corrective.** The mechanism is
ACCEPTED and must not be redesigned: real composition root, runtime composed beside
the Node pinned transport, no credential path, unconfigured deployment still a named
refusal, configuration through the actual Next instrumentation entry point, tests on
the real bootstrap path asserting pinned-fetch reference identity.

One blocker: `server-bootstrap.ts` imports `@liberty/media-inspection/node/pinned-fetch`
while `apps/web/package.json` does not declare it. The build succeeds only because the
workspace makes it resolvable; a production composition root whose manifest does not
describe its imports is not acceptable. **Already recorded as PL-0311 — do not
duplicate the implementation across two tasks.** Ordered resolution: keep PL-0308 in
CHANGES_REQUESTED; take PL-0311 now that PL-0710 is DONE and the package-lock
reservation is gone; land the manifest and lockfile edge together; rerun PL-0308's
typecheck/build/manifest gates on the integrated tree; return PL-0308 to REVIEW.

---

## Round 62, reviewed at `f6dba611346ac53d72901f661a2b21cc12e80eac`

> TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by the human
> commander. The GitHub review-write integration returns 403.

**PL-0308 APPROVED.** The sole blocker is corrected by PL-0311: `apps/web/package.json`
declares `@liberty/media-inspection: 0.1.0`, so PL-0308's direct import of
`@liberty/media-inspection/node/pinned-fetch` is described by the owning app manifest.
The registration mechanism is unchanged and accepted; the Node pinned transport is
still the catalog runtime's transport; no credential or API-key path was introduced;
unconfigured deployments remain explicitly unconfigured; the real instrumentation and
bootstrap path is exercised; and PL-0308's typecheck/lint/build and unit gates were
re-run against the integrated tree and pass.

**PL-0311 APPROVED.** Both files declare the same workspace dependency; the lockfile
edge was generated by npm rather than edited manually; both landed together; a
genuinely clean install was performed after removing `node_modules`; `npm ci` succeeds
from that state; module resolution from `apps/web` reaches `packages/media-inspection`.
The reviewer addressed the implementer's own stated weakness and **ruled against it**:
that the ordinary gates also passed before the correction is not a weakness in the
implementation, it is evidence of the repository-wide detection gap already reported.

**ARCHITECTURE / CI FINDING.** Add the undeclared-workspace-import consistency check to
**PL-AI-0002**'s CI scope rather than opening a competing task. The repository cannot
mechanically detect when workspace source imports a local package its own manifest does
not declare. Folded into PL-AI-0002's acceptance with the regression case preserved.

---

## Round 63 — PL-0308 judgement gates, at `f6dba61`

> TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by the human
> commander. The GitHub review-write integration returns 403.

**`security-review`: PASS.** The production catalog composition root uses the existing
`nodePinnedFetch` transport rather than an alternate unpinned path; hostname resolution
and address classification are supplied to it; egress hosts are derived from the
licensed source identity rather than supplied by an operator as a widenable allowlist;
`allowLoopback` is explicitly false; unknown source identities get an empty egress
allowlist and remain subject to the licensed-source refusal; no credential, API-key,
token or password variable or runtime field is introduced; and the declared catalog
environment-variable set is mechanically checked, so an undeclared `LIBERTY_` read or a
credential-shaped variable cannot silently enter the bootstrap.

**`rights-review`: PASS.** PL-0308 does not establish, synthesize, default or infer a
content-rights basis; the runtime binds `rightsRegister: noRightsBasisEstablished`; that
fail-closed register WITHHOLDS records lacking an operator-established basis rather than
publishing them; Wikidata metadata existence is not authorization to surface or play;
an operator-provided source ID cannot create a licensing decision, since source
licensing stays with the catalog-ingestion package and an unlicensed source is refused
by name; and catalog metadata stays separate from playback media addresses and playback
entitlement.

Both recorded under `gpt-architect` against the reviewed tree. **PL-0308 DONE.**

---

## Round 64 — PL-0309, at `9dc9bc8`

> TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by the human
> commander. The GitHub review-write integration returns 403.

**PL-0309 CHANGES_REQUESTED. `architecture-review` FAIL, `rights-review` PASS** — both
recorded as gates.

Package-level architecture ACCEPTED and out of bounds for the corrective: `CatalogStore`
is a valid port; `applyPassToSnapshot` centralizes stored-state transition semantics;
refresh/backoff/freshness decisions are centralized rather than recomputed
independently; failed refreshes retain previous state and record the failure; tombstones
survive refreshes; `refreshCatalogIfDue` belongs in the package and is the right
reusable worker entry point; the per-runtime store identity mechanism prevents
reconstructed sources from discarding state.

The FAIL is deployment-level only: `server-bootstrap.ts` built the runtime with no
schedule, which correctly became `policy_not_stated` but then refreshed on every read,
so a hosted deployment still scaled ingestion work with catalog reads.

`rights-review` PASS: stored state holds accepted work rather than frozen projections;
rights basis and availability are rechecked at read time; a record whose basis is no
longer established is withheld; tombstoned works are not silently restored by a partial
refresh; failed refreshes preserve stored state; the store cannot turn stale
authorization into current entitlement.

**CORRECTIVE SURFACE RULING** — exactly `apps/web/src/lib/server-bootstrap.ts`,
`apps/web/src/lib/server-bootstrap.test.ts`, `.env.example`, on the stated ground that
these are the production composition and configuration files required to satisfy
PL-0309's EXISTING acceptance, not speculative widening. Six required items, and
`policy_not_stated` is to REMAIN for runtimes that intentionally omit policy.

**FOLLOW-UP ORDERED:** a separate task for the resume/full-pass tombstone invariant
before resume is enabled. Filed as **PL-0313**.

---

## Round 65 — PL-0309 final, at `cd6f3ef`

> TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by the human
> commander. The GitHub review-write integration returns 403.

**PL-0309 APPROVED. `architecture-review` PASS** (replacing the deployment-level FAIL at
`9dc9bc8`), **`rights-review` PASS** re-confirmed at this head.

Verified: the three scheduling variables are required behind
`LIBERTY_CATALOG_SOURCE_ID`; `apps/web` parses them only as safe-integer milliseconds
and duplicates no positivity, ordering, cadence or backoff policy; coherence is
delegated to `validateCatalogRefreshSchedule`; `catalogRuntimeFor` places the schedule
on the production runtime; a missing or invalid policy is refused **by name** rather
than falling back to a pass per read; `policy_not_stated` remains reachable and honest;
and the accepted package implementation was not redesigned. On the regression: the
reviewer specifically credited that **the assertion is not satisfied merely by
suppressing a second fetch** — it also proves the second read returned the stored
answer and was not suppressed by failure backoff.

**The behaviour change is accepted as the correct failure direction:** a deployment
naming a source but omitting its schedule is declaration-refused rather than silently
ingesting on every read.

**Two follow-ups ordered.** PL-0313 owns the resumed-pass invariant and must be resolved
before resume is enabled. The `.next/types` typecheck/build race folds into PL-AI-0002's
CI correctness scope — "CI must not rely on `typecheck` and `build` racing successfully
when `typecheck` consumes files `build` writes."

---

## Round 66 — PL-0313 final, at `e78a840`

> TRANSCRIBED BY CLAUDE from the ChatGPT review session and relayed by the human
> commander. The GitHub review-write integration returns 403.

**PL-0313 APPROVED. `architecture-review` PASS, `rights-review` PASS.**

Mechanism accepted: `resumed_pass` as a fourth `TombstoneWithholdReason`; any non-null
`resumeCursor` makes inferred-absence tombstones unavailable; `complete` stays derived
from `tombstonesWithheld` so the meaning changes consistently without a second competing
boolean; `nextCursor === null` remains independent; `resumed_pass` is the correct
precedence over `page_limit_reached` because raising `maxPages` cannot recover a
deliberately skipped prefix; unresumed full passes still infer absence normally.

Two things the reviewer singled out: **the control test is load-bearing** — without it an
implementation that disabled inferred tombstones globally would falsely satisfy the three
hazard assertions — and **the initial all-four-red result was correctly rejected as a
broken harness** rather than taken as a stronger red.

Not publishing `seenContentIds` accepted: it would matter primarily to changing the
store's release rule, which is out of scope, so an unused public field would be
premature.

`rights-review` PASS: a resumed partial view can no longer infer withdrawal for skipped
pages; provider-declared withdrawals remain actionable because they are direct evidence;
the release rule is unchanged; no new path can grant entitlement or restore a withdrawn
work.
