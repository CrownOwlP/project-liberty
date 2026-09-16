# Architecture Decisions

## ADR-001 - Modular monorepo first

**Status:** Accepted

Use Next.js plus shared TypeScript packages in one Turborepo. Extract services only when scale or deployment boundaries require it.

**Reason:** Maximum iteration speed, simple local development, and clean parallel ownership for AI agents.

## ADR-002 - Provider adapter boundary

**Status:** Accepted

Provider-specific catalog/playback behavior must live behind `@liberty/provider-sdk`.

**Reason:** Prevent provider quirks and credentials from leaking through the product and media engine.

## ADR-003 - Deterministic playback ranking

**Status:** Accepted

Candidate ranking is a pure deterministic policy with a reason trail.

**Reason:** Reproducible tests and diagnosable playback behavior.

## ADR-005 - Weighted, decomposable candidate score model

**Status:** Accepted (PL-0201)

Candidate scoring is a sum of independently weighted dimensions rather than a single opaque
formula. Each dimension normalizes to `[0, 1]` and contributes `raw * weight`, so the total is
always reconstructible from its parts.

| Dimension | Weight | Meaning |
| --- | ---: | --- |
| `resolution` | 40 | rendition height against the client ceiling |
| `health` | 30 | provider health sample |
| `bitrateEfficiency` | 12 | distance from a target bitrate for that height |
| `codecEfficiency` | 10 | compression efficiency at equal perceptual quality |
| `protocolAdaptivity` | 8 | adaptive (HLS/DASH) vs progressive delivery |
| `latency` | -15 | estimated startup latency penalty |

Positive weights sum to 100; `latency` is the only penalty. Both are asserted in tests, so a
future weight change cannot silently unbalance the model.

**Reason:** A single expression could not answer "why was this stream chosen?" — the reason trail
required by the playback invariants. Decomposition also makes each dimension independently
regression-testable for monotonicity.

**Notes:**

- `bitrateEfficiency` is a *distance* from target, not a maximum. Over-provisioned streams waste
  bandwidth and raise rebuffer risk, so they are penalised like under-provisioned ones.
- Determinism is a hard requirement: no clocks, randomness, I/O, or ambient state. Ties break on
  candidate id so results never depend on input ordering.
- **Stored values must be internally consistent.** `raw` is rounded to `SCORE_PRECISION` (4 dp)
  first and `weighted` is derived from that rounded value, giving the exact invariant
  `round(raw * weight) === weighted` for every component, and `round(Σ weighted) === total`.
  Deriving `weighted` from the unrounded value instead would publish a breakdown that does not add
  up to the published score, making the reason trail untrustworthy for exactly the debugging it
  exists to support.
- The invariant is stated *at* `SCORE_PRECISION` deliberately. Plain floating-point equality
  (`raw * weight === weighted`) is not guaranteed: the product can land a fraction of an ulp away
  from the stored value. Rounding both sides to the declared precision is what makes the guarantee
  exact rather than incidental.
- Weights must stay **integers**, which keeps `raw * weight` at 4 dp so the rounding above is a
  no-op correction rather than a real loss. A fractional weight would reintroduce drift. Asserted
  in tests.

## ADR-006 - Rights checked before scoring, via allowlist

**Status:** Accepted (PL-0201)

`PLAYABLE_RIGHTS` is an explicit allowlist (`licensed`, `owned`, `public-domain`) evaluated as the
first eligibility check, before any technical property. A candidate with unplayable rights is never
scored, ranked, or surfaced.

**Reason:** Enforces the product invariant that only licensed, user-owned, or public-domain content
enters playback resolution. An allowlist fails closed: any rights value added later is non-playable
until explicitly reviewed, whereas a denylist would silently admit it.

## ADR-004 - PostgreSQL source of truth, Redis optional

**Status:** Proposed

Use PostgreSQL for durable state and Redis only for ephemeral/cached workloads. Final ORM choice is deferred to the persistence task.

## ADR-007 - Authentication seam, database sessions, and a minted profile scope

**Status:** Proposed. **`control/tasks.json` is authoritative for who implements this, who
reviews it, and whether it has been ratified. This document does not restate any of that.**

Read the task record — PL-0405, which supersedes PL-0401 — for the routing and for the gate
results. An ADR that names agents in prose goes stale the moment the control plane is corrected,
and this one did: an earlier revision of this paragraph named `gpt-architect` as the preferred
implementer and `claude-lead` as the reviewer, which stopped being true when the review of an
authentication boundary was routed away from the agent that had written the decision. Worse, the
restatement was self-defeating — completing the review would have required editing this file
immediately afterwards, and that edit would have staled the approval fingerprint the review had
just bound to it.

Two rules stand behind the routing rather than being descriptions of it, so they are recorded
here as rules: self-approval is prohibited by `control/policies.json` →
`review.allowSelfApproval: false`, and this ADR carries a `security-review` gate because it is
an authentication boundary. Until every required gate on the governing task is recorded as
`pass`, nothing below may be cited as a settled decision; it is cited as the reasoning the
existing implementation rests on, written down where a decision is supposed to live.

**What this replaces.** `docs/RESEARCH_IDENTITY.md` was the only record of this reasoning, and
that file disclaims itself: it is a transcription of a ChatGPT session, not an agent-bus
message, explicitly "not a recorded control-plane decision". Research is evidence. It is not an
ADR, and `docs/DECISIONS.md` contained no auth, session or profile entry at all. That gap is
what this closes. The research file remains the fuller account of the option survey and now
points here for the decision.

### The decision

Authenticate with **Better Auth 1.7.5**, exact-pinned, reached only through a `@liberty/auth`
seam; keep **sessions in PostgreSQL** through the official Drizzle adapter; enable a
**deliberately small capability surface** with no plugin stack; and model **viewer profiles
above authentication**, gated by a pure authorization function that **issues** a `ProfileScope`
in exactly one place — a frozen value recorded in a module-private registry, so that a consumer
can establish it was issued rather than merely that it type-checks.

The first four clauses are the task's stated acceptance. The fifth is the one the implementation
added, and it is the load-bearing part: it is what makes "no logic may bypass authentication" a
property of the running program rather than a rule people are asked to remember. An earlier
revision of this ADR claimed the type system alone did that. It did not, and the correction is
recorded below rather than quietly applied.

### Alternatives considered

| Option | State as surveyed 2026-08-19 | Verdict |
| --- | --- | --- |
| **Better Auth** | MIT, Next.js 16 / App Router support, database sessions, Drizzle adapter; surveyed at 1.7.1, pinned at 1.7.5 | **Chosen** |
| Clerk | `@clerk/nextjs` 7.7.6, MIT SDK, first-class App Router support | Rejected — the main alternative; see below |
| Auth.js v5 | still `5.0.0-beta.32` on npm's beta tag, ISC; its own README points new projects at Better Auth except for stateless/no-DB sessions | Rejected for greenfield |
| WorkOS AuthKit | 4.3.1, MIT, App-Router SDK, hosted identity | Rejected — enterprise SSO strengths are not this product's requirement |
| iron-session | 8.0.4, MIT, last publish ~2 years ago; explicitly a stateless encrypted-cookie library | Rejected — not an authentication system at all |

**The main rejected alternative is Clerk, and it was rejected on trade rather than on quality.**
Clerk is technically excellent and would have been faster to reach a working sign-in. What it
costs is a hosted identity data-plane: account records, credentials and session state live with
a vendor, and every later question — data residency, deletion, export, what happens to a
household's viewing history when the vendor's terms change — is answered by somebody else's
roadmap. Liberty is a consumer product whose entire premise is that the user's own library and
viewing state stay under the user's control; putting the identity that keys that state outside
the database that holds it contradicts the premise. The cost of the rejection is real and worth
stating: Liberty now owns password storage, verification, reset, rate limiting and revocation,
which is exactly the surface Clerk exists to take away.

**iron-session is the instructive rejection.** It is the option that looks cheapest and is not
an alternative at all: an encrypted cookie is a session transport, not an identity system, and
choosing it would leave Liberty owning credential handling, recovery, account linking and — the
decisive one — revocation, while appearing to have chosen a library.

### The trade-offs actually taken

**A seam, not a direct dependency.** Nothing outside `packages/auth` imports `better-auth`. The
rest of the application depends on `LibertySession`, `AccountIdentity`, `ProfileOwnership` and
`ProfileScope`, which are Liberty's own types. The cost is a translation layer that has to be
maintained and that nobody outside this package benefits from directly. The purchase is that
replacing the vendor is an adapter rewrite rather than a product-wide refactor — and it is what
makes the profile model below expressible at all, since a profile carried inside the vendor's
session record would make swapping the vendor a data migration.

**Database sessions, not stateless encrypted cookies.** A server-side session row can be
**revoked**; a self-contained cookie cannot be, short of rotating a secret and signing everyone
out. For a product where a household shares a screen, revocation is the requirement, not a
refinement. The cost is a database read on the session path and a table to keep clean.

**An exact pin, and upgrades are security-sensitive work.** `packages/auth/package.json` pins
`better-auth` and `@better-auth/drizzle-adapter` to `1.7.5` exactly, not to a caret range,
because Better Auth's published security policy supports only the latest version — `SECURITY.md`
in full: *"We only support the latest version of Better Auth. Older versions are not supported."*
Both failure modes here are real: a caret range admits a version nobody reviewed, and a pin
nobody bumps strands us on a version upstream has stopped patching. The pin is chosen because it
is the **visible** failure. `REVIEWED_BETTER_AUTH_VERSION` in `enabled-surface.ts` records the
version the surface was reviewed against, and `enabled-surface.test.ts` imports `package.json`
and asserts that both `better-auth` and `@better-auth/drizzle-adapter` equal it, with no range
operator — so the bump is mechanically all-or-nothing and cannot drift into a comment that
claims a review that did not happen.

**The pin went stale, and that is the mechanism working.** This ADR shipped at `1.7.1`
(2026-08-18) and the PL-0401 review found it four patch releases behind upstream's supported
version. A caret range would have moved the dependency silently and nobody would have reviewed
what arrived; the pin made the distance legible and forced the upgrade through this gate. The
finding named `1.7.4` (2026-09-10) as current. By the time PL-0405 was implemented,
`npm view better-auth dist-tags` reported `latest: 1.7.5` (2026-09-14), so the pin is `1.7.5`:
the rule is "the version upstream currently supports", not "the version the last review named",
and pinning `1.7.4` would have reproduced the defect one release later. Upstream also publishes
a `release-1.6` line (`1.6.33`, 2026-09-14); `SECURITY.md` does not extend support to it, so it
is noted and not relied on.

**The upgrade carried a schema change with it, and the two moved together.** Better Auth
`1.7.3` (PR #11153) abandoned the `account` schema introduced in `1.7.0` and went back to
identifying accounts by `(providerId, accountId)`, dropping the `issuer` requirement; the same
release (PR #11178) added default-on schema validation that rejects authentication requests when
the database holds a required column the library never writes. Liberty's hand-written first
migration still carried `issuer NOT NULL` and `UNIQUE (issuer, account_id)` — a shape no
supported version uses, and one under which the library's own diff reports that *"every insert
into `account` fails"*. Bumping the pin without reconciling the migration would have produced a
configuration whose first sign-up fails, so the migration was reconciled in the same change; see
the consequence below.

**A small enabled surface, written down as data.** `ENABLED_AUTH_CAPABILITIES` lists exactly
four capabilities — email/password, email verification, password reset, database sessions — and
`WITHHELD_AUTH_PLUGIN_FAMILIES` records why each of SSO, SCIM, organization, device, MCP and
two-factor is off, with a reason per family. `createLibertyAuth` passes no `plugins` array at
all; the denylist is not the boundary, it is the artefact that makes a future addition visible
in review, which a missing line never is. `findSurfaceViolations` treats an unrecognised plugin
as a violation by default, so the check does not go stale the first time a plugin is published
that this file has never heard of.

The trade is stated plainly: **Liberty ships no second factor today.** `two_factor` is recorded
as withheld rather than rejected — it is a plausible requirement whose recovery-code, lockout
and support consequences have to be designed before it is switched on, and switching it on is a
change to the constant plus a security review.

**Profiles above auth, and the scope is minted once.** Authentication answers "which account is
this". A viewer profile is a product concept layered on top, so the active profile is carried
alongside the session — `active_profile_selection`, keyed by `session_id`, cascading with the
session — rather than as a column on the identity record. A column would reselect "Kids" on the
phone because someone chose it on the television, and would leave selection state behind when a
session is revoked.

`ProfileScope` is **issued**, not merely branded. `issueProfileScope` in
`packages/auth/src/profile-scope.ts` is the only producer of one anywhere in the repository; it
is called from exactly two places, the two grant branches in `authorization.ts`, and it is
deliberately absent from `index.ts`, which re-exports that module **by name rather than with
`export *`** so the producer cannot leave the package. Every profile-scoped repository takes a
`ProfileScope` rather than a `profileId: string`, so "did anyone check this profile belongs to
this account" is asked at every call site.

**An earlier revision of this ADR was wrong about how that is enforced, and the error was a
cross-profile data-access bypass rather than a documentation defect.** It said: *"Forging one
requires an explicit cast that is greppable and reviewable."* It did not. The brand was a
`declare const … : unique symbol` — a phantom that existed in the type system and was never
written at runtime — and the producer returned an object literal through `as ProfileScope`. A
holder of a genuine scope could therefore write

```ts
const forged = { ...realScope, profileId: someoneElsesProfileId };
```

with **no cast at all**: a spread copies every property the type declares, including the brand,
so the copy is a `ProfileScope` to the compiler. `@liberty/persistence` reads `scope.profileId`
straight into its `WHERE profile_id = $1` predicates, so one household member holding a
legitimate scope could read and write another profile's viewing history. This is the same defect
PL-0706 found in `ClassifiedRuntime`, in a second place.

**The type system cannot fix it, so the fix is a runtime registry.** There is no TypeScript
construction under which a spread copy stops being assignable — a `private` class field is
compared nominally at compile time and is an ordinary property at runtime, and a branded
property is simply copied. Only **object identity** distinguishes a copy from the value that was
issued, and identity is a runtime fact. So `profile-scope.ts` applies the four mechanisms this
repository already uses for `ClassifiedRuntime` and for `PinnedTarget` in
`@liberty/media-inspection`: a module-private real `Symbol` brand; `Object.freeze` on every
issued scope, so a holder cannot edit one in place and keep its identity; a `WeakSet` of the
values this module actually issued; and an identity check as the consumer's first action.
`profileIdFromScope(scope)` is the supported way to obtain the id a data predicate is built
from — it consults the registry **before** it reads the field and throws
`ForgedProfileScopeError` otherwise, so the check and the read are one expression and cannot be
separated by a later edit. `scopeBelongsToSession` likewise answers `false` for a value that was
not issued; that matters specifically because a spread forgery keeps a **genuine** `grantedFor`,
which is the one field an account comparison looks at.

**The consumers ask, and that is what makes the registry worth having.** A registry closes
nothing unless the code granting access consults it. `@liberty/persistence` was converted in the
same task, after the write surface was widened to `packages/persistence/src/**` — which the task
record had prescribed before the claim. Every exported function in `progress-repository.ts`,
`watchlist-repository.ts` and `profile-repository.ts` now obtains the id through
`profileIdFromScope(input.scope)` **as its first statement**, ahead of argument validation and
ahead of any I/O, and `scope.profileId` is not read directly anywhere in that package.

Three details of that shape are deliberate. **First**, the check is the read: the accessor
returns the string, so there is no boolean guard sitting above a field access that a later edit
could delete while the code still compiles. **Second**, it runs before `parseContentId` and
`parseListLimit`, so a forged scope never reaches a database round trip and cannot use a
validation reason code as an oracle for what the repository would have done. **Third**, the two
functions that take a session as well as a scope refuse earlier still, in `refuseForeignScope`,
because `scopeBelongsToSession` now establishes issuance as well as the account match — those
return a reason code rather than throwing, because they have a mapped wire contract to report it
through and the other eight return rows, where an empty list is indistinguishable from a refusal.

`packages/persistence/src/scope-forgery.test.ts` attempts the spread forgery against all ten
exported functions and asserts each refuses without touching a database. Its `db` is a proxy that
throws on any property access, so "refused" and "refused before doing any I/O" are distinguished
rather than conflated.

**The second repository asks too, since 2026-09-15 (round 43).**
`apps/web/src/lib/db/in-memory-repository.ts` — a complete second implementation, the volatile
store used for local development — read `input.scope.profileId` directly in fourteen places, and
the round that wrote the paragraph above named it as the remaining hole because `apps/web/**` was
outside the write surface. The surface was widened to `apps/web/src/lib/db/**` and the adapter was
converted in the same shape: its seven scope-taking methods bind
`profileIdFromScope(input.scope)` as their first statement, ahead of `parseContentId` and
`parseListLimit`, and `selectActiveProfile` is the one exception for the reason the persistence
package makes the same exception — it takes a session as well, so it begins with
`scopeBelongsToSession`, which establishes issuance first and refuses with a mapped reason code
rather than a throw. `apps/web/src/lib/db/scope-forgery.test.ts` attempts the forgery against
every scope-taking method, with a store proxy that throws on any property access, and asserts the
classification of the adapter's members is **complete** — the three lists it partitions them into
must together equal the adapter's own keys, so a twelfth method fails that test until somebody
decides which list it belongs in.

The bound on the old hole is restated rather than dropped, because it is what the risk assessment
rested on: `createInMemoryRepository` refuses to construct unless handed a `ClassifiedRuntime`
that `@liberty/contracts` actually issued, so it could not exist in a deployment. It was a
development- and test-process bypass, not a production one — and it was still a cross-profile
bypass, which is why it was closed rather than documented.

**`profileId` and `grantedFor` are off the public `ProfileScope` interface (round 43).** They are
declared on a module-private `IssuedProfileScope` inside `profile-scope.ts`, so `scope.profileId`
anywhere outside `@liberty/auth` is now a **compile error** rather than a `@deprecated` tag. The
in-memory adapter was the only thing keeping the property public; once it asked, the property came
off, and `npm run typecheck` is the evidence that nothing still reads it. **What that buys and
what it does not, because the tempting claim is bigger than the true one:** it makes an unchecked
read impossible to write, and it rejects the object-literal spelling of the forgery
(`{ ...real, profileId: victim }`) through excess-property checking. It does **not** make the
forgery impossible — `Object.assign({}, real, { profileId: victim })` is
`ProfileScope & { profileId: string }`, assignable to `ProfileScope`, with no cast anywhere, and
both forgery suites were rewritten to use that spelling so they keep attempting a cast-free
attack. The runtime registry remains the only thing that rejects a forged value. The removal also
costs one cast, inside `profileIdFromScope`, immediately after the registry has answered yes —
the one place in the repository where that assertion is backed by a runtime proof.

**This is how the no-bypass invariant is enforced.** The mandatory product invariant is that no
logic may bypass authentication. A rule stated in prose is enforced by review; a value that
cannot be **produced** outside `authorizeProfileAccess` or `authorizeProfileSelection`, and
cannot be **copied** into a different profile without the copy being detectable, is enforced by
the running program. The residual, named exactly: an edit to `profile-scope.ts` itself defeats
it, and so does patching `Object.freeze` or `WeakSet.prototype.has` before the module loads.
Both are statements executing inside the process and as visible in a diff as any other change;
neither is reachable *through* the module's surface, which is the boundary that moved.

**Authorization is pure, and both branches produce a reason.** `authorizeProfileAccess` performs
no I/O: the caller loads the `ProfileOwnership` record and hands it in. That is what makes
authorization testable without a database, and it is the same discipline `@liberty/media-engine`
applies to ranking. Check precedence is exported as `PROFILE_ACCESS_CHECK_ORDER` and is a tested
guarantee, not an artefact of how the function happens to be written: ownership is checked
before liveness so that "not yours" is never masked by "also archived".

**One confidentiality trade is taken deliberately and it degrades an error message.**
`externalProfileAccessReason` collapses `profile_not_found` and `profile_not_owned_by_account`
into a single `profile_unavailable` on the way out. Both leaks are real. Telling the caller which
one it was hands an authenticated attacker an oracle for enumerating the profile table; not
telling them costs a user with a stale link a vaguer message. The second is recoverable and the
first is not, so the second is chosen. The internal reason survives in the decision `trail` for
logs and alerting. Enforcement is at the serialisation edge, not inside the decision function,
which means forgetting to map a denial is possible — a known cost, and the reason the mapping is
a total `switch` with no `default`, so extending the reason union fails to compile rather than
leaking a new reason verbatim.

### Consequences

- **Profile scoping is in the first migration, not retrofitted.**
  `packages/persistence/migrations/0000_profile_scoped_identity.sql` creates the four Better Auth
  tables and the profile-scoped tables together, so no window exists in which a progress row can
  exist without a profile id. The expensive part of retrofitting is not the `ALTER TABLE`, it is
  the backfill: once a household has months of progress keyed by account, nothing records which
  of four people watched which episode, and that data cannot be recovered, only discarded.
- **The database enforces profile ownership a second time.**
  `active_profile_selection` carries a composite foreign key to `profile (id, user_id)`, so a
  selection whose claimed owner disagrees with the profile's real owner is refused by PostgreSQL
  as well as by `authorizeProfileAccess`. The failure this guards against leaks one household's
  viewing history to another, which is worth two independent enforcements.
- **The migration's `account` table was reconciled against 1.7.5, and the `issuer` column is
  gone.** `packages/persistence/migrations/0000_profile_scoped_identity.sql` previously carried
  `"issuer" text NOT NULL` and `UNIQUE ("issuer", "account_id")`, transcribed from the
  `1.7.0`–`1.7.2` account schema that `1.7.3` abandoned. Both were removed and replaced with
  `UNIQUE ("provider_id", "account_id")`. Upstream offers two remedies — make `issuer` nullable,
  or remove the column; removal is correct here because this is the first migration and has
  never been applied, so there is no data to preserve. The replacement uniqueness rule is
  **Liberty's, not the library's**: `getAuthTablesWithResolvedIndexes({})` on 1.7.5 declares no
  unique index on `account` at all, and the library instead detects duplicates at runtime in
  `findAccountByKey` and throws. A duplicate `(provider_id, account_id)` pair is therefore an
  unrecoverable state for the library, and the database is the only place that can make it
  unrepresentable.
- **The Drizzle table definition agrees with the SQL.** `packages/persistence/src/schema/auth.ts`
  dropped `issuer` and `unique("account_issuer_account_id_key")` and gained
  `unique("account_provider_id_account_id_key").on(table.providerId, table.accountId)`, so
  `drizzle-kit generate` will not propose reinstating the abandoned schema. The two are a single
  schema stated twice and nothing mechanical compares them, which is recorded in that file's
  header.
- **The migration has now been executed, and the generator has now been run (2026-09-15).**
  PostgreSQL 16.15 was installed in the working environment, so the caveat this entry used to
  carry was removed by doing the work rather than by rewording it.
  `0000_profile_scoped_identity.sql` was applied to an empty database as a non-superuser role and
  exits 0 — eight `CREATE TABLE`, seven `CREATE INDEX`, no errors — and applies cleanly a second
  time to a second empty database. **The authoritative generator is `npx auth@1.7.5 generate`,
  not `npx @better-auth/cli generate`:** `@better-auth/cli` is deprecated on npm
  ("Package no longer supported") and its latest release is `1.4.21`, which pins
  `better-auth@1.4.21` as a direct dependency, so running it would have described a version this
  repository does not use. The CLI moved to the npm package named **`auth`**, whose `1.7.5`
  release pins `better-auth@1.7.5` and `@better-auth/core@1.7.5` exactly. It was run against a
  module constructing the real `createLibertyAuth` option object and it generated a Drizzle
  schema. **The generated `account` table has no `issuer` column and declares no unique index on
  `account` — only `index("account_userId_idx")`.** Both round-42 removals are confirmed by the
  generator, and `UNIQUE ("provider_id", "account_id")` is confirmed to be **ours**: the
  generator does not declare it. A field-by-field diff of the library's expected table set against
  the applied database found **no missing column, no extra column, no type mismatch and no
  nullability mismatch** in `user`, `session`, `account` or `verification`. The library's own
  default-on schema validation ran during a live sign-up and sign-in against that database without
  raising `SchemaMismatchError`, real rows were written to all three of `user`, `account` and
  `session`, and the `(provider_id, account_id)` constraint refused a deliberate duplicate with
  SQLSTATE 23505. **No change to the migration was required.** What remains unexecuted is
  `drizzle-kit`'s own journal and snapshot under `migrations/meta/`, and the concurrency
  behaviour of the guarded `UPDATE`, which needs the `integration` gate rather than a single
  session.
- **`better-auth.ts` is not unit-tested, on purpose.** Every assertion available without a real
  PostgreSQL would be an assertion about a stub of the vendor's behaviour. The one exception —
  `describeConfiguredSurface`, a statement about Liberty's own data — was moved out into
  `enabled-surface.ts` precisely because living in the untested file is how its previous defect
  survived.
- **`npm ci` accepts the tree, which is the other half of the pin.** The root `package-lock.json`
  was regenerated against `1.7.5` and verified from a clean slate: `rm -rf node_modules && npm ci`
  exits 0 and resolves `better-auth@1.7.5` and `@better-auth/drizzle-adapter@1.7.5`. A pin that
  `package.json` declares and the lockfile contradicts is not a completed bump — `npm ci` refuses
  the mismatch, which is the fail-safe direction but is still a broken tree.
- **Upgrading Better Auth requires the `security-review` gate.** Bumping the dependency and
  `REVIEWED_BETTER_AUTH_VERSION` is a single mechanical change by test, and a security-sensitive
  one by policy.
- **PL-0402, PL-0403 and PL-0404 are downstream of this and already assume it.** Their acceptance
  criteria name profile-scoped rows, a `(profileId, contentId)` key and a server-issued writer
  epoch. If the review rules against any clause here, those three are affected, which is the
  cost of recording the decision after the implementation rather than before it. They also own
  `packages/persistence`, which this task wrote to in order to convert the scope consumers, so
  which task owns those files afterwards is a control-plane question and is settled in the task
  records, not here.

**Reason:** the auth choice is the decision the whole viewer-state model hangs off, and it was
recorded nowhere a decision is looked for. The seam, the database sessions, the exact pin and the
issued scope are each chosen for revocability and reviewability over convenience — the same
preference ADR-006 makes with its rights allowlist, and for the same reason: the failure that
cannot be undone is the one the design should refuse first.
