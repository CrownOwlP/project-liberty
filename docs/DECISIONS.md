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

**Status:** Proposed (PL-0401) — **`claude-lead`'s recommendation, not a ratified decision.**

This ADR is written by `claude-lead`. `control/tasks.json` reserves PL-0401 for
`preferredAgent: gpt-architect` and names `reviewAgent: claude-lead`, so the one agent that
cannot ratify this text is its author: self-approval is prohibited by
`control/policies.json` → `review.allowSelfApproval: false`, and an ADR whose author is also
its reviewer would be a decision with no independent judgement behind it. Treat the status as
**Proposed** until `gpt-architect` rules on it through the control plane. Nothing below may be
cited as a settled decision; it is cited as the reasoning the existing implementation already
rests on, written down where a decision is supposed to live.

**What this replaces.** `docs/RESEARCH_IDENTITY.md` was the only record of this reasoning, and
that file disclaims itself: it is a transcription of a ChatGPT session, not an agent-bus
message, explicitly "not a recorded control-plane decision". Research is evidence. It is not an
ADR, and `docs/DECISIONS.md` contained no auth, session or profile entry at all. That gap is
what this closes. The research file remains the fuller account of the option survey and now
points here for the decision.

### The decision

Authenticate with **Better Auth 1.7.1**, exact-pinned, reached only through a `@liberty/auth`
seam; keep **sessions in PostgreSQL** through the official Drizzle adapter; enable a
**deliberately small capability surface** with no plugin stack; and model **viewer profiles
above authentication**, gated by a pure authorization function that mints a branded
`ProfileScope` in exactly one place.

The first four clauses are PL-0401's stated acceptance. The fifth is the one the implementation
added, and it is the load-bearing part: it is what makes "no logic may bypass authentication" a
property of the type system rather than a rule people are asked to remember.

### Alternatives considered

| Option | State as surveyed 2026-08-19 | Verdict |
| --- | --- | --- |
| **Better Auth** | 1.7.1, MIT, Next.js 16 / App Router support, database sessions, Drizzle adapter | **Chosen** |
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
`better-auth` and `@better-auth/drizzle-adapter` to `1.7.1` exactly, not to a caret range,
because Better Auth's published security policy supports only the latest version. Both failure
modes here are real: a caret range admits a version nobody reviewed, and a pin nobody bumps
strands us on a version upstream has stopped patching. The pin is chosen because it is the
**visible** failure. `REVIEWED_BETTER_AUTH_VERSION` in `enabled-surface.ts` records the version
the surface was reviewed against, and `enabled-surface.test.ts` imports `package.json` and asserts
that both `better-auth` and `@better-auth/drizzle-adapter` equal it, with no range operator — so
the bump is mechanically all-or-nothing and cannot drift into a comment that claims a review that
did not happen.

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

`ProfileScope` is a branded type whose brand is a non-exported `unique symbol`, and
`mintProfileScope` in `authorization.ts` is the only producer of one anywhere in the repository.
It is module-private and deliberately not in `session.ts`, because `index.ts` re-exports
everything `session.ts` exports and a mint living there would escape the package and the brand
would protect nothing. Every profile-scoped repository takes a `ProfileScope` rather than a
`profileId: string`, so "did anyone check this profile belongs to this account" is answered by
the compiler at every call site. The single `as ProfileScope` cast in the codebase sits next to
the decision that justifies it, where a reviewer can find it.

**This is how the no-bypass invariant is enforced.** The mandatory product invariant is that no
logic may bypass authentication. A rule stated in prose is enforced by review; a value that
cannot be constructed without passing through `authorizeProfileAccess` or
`authorizeProfileSelection` is enforced by the build. Forging one requires an explicit cast that
is greppable and reviewable, which is a materially different thing from forgetting a check.

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
- **The migration has never been executed.** It is hand-written so the first migration could be
  read as a whole, and its Better Auth tables are transcribed from the vendor's published core
  schema. It must be reconciled against `npx @better-auth/cli generate` before it is applied to
  any database that matters. That reconciliation is outstanding work, not a completed step.
- **`better-auth.ts` is not unit-tested, on purpose.** Every assertion available without a real
  PostgreSQL would be an assertion about a stub of the vendor's behaviour. The one exception —
  `describeConfiguredSurface`, a statement about Liberty's own data — was moved out into
  `enabled-surface.ts` precisely because living in the untested file is how its previous defect
  survived.
- **Upgrading Better Auth requires the `security-review` gate.** Bumping the dependency and
  `REVIEWED_BETTER_AUTH_VERSION` is a single mechanical change by test, and a security-sensitive
  one by policy.
- **PL-0402, PL-0403 and PL-0404 are downstream of this and already assume it.** Their acceptance
  criteria name profile-scoped rows, a `(profileId, contentId)` key and a server-issued writer
  epoch. If `gpt-architect` rules against any clause here, those three are affected, which is the
  cost of recording the decision after the implementation rather than before it.

**Reason:** the auth choice is the decision the whole viewer-state model hangs off, and it was
recorded nowhere a decision is looked for. The seam, the database sessions, the exact pin and the
minted scope are each chosen for revocability and reviewability over convenience — the same
preference ADR-006 makes with its rights allowlist, and for the same reason: the failure that
cannot be undone is the one the design should refuse first.
