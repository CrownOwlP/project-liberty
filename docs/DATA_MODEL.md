# Data model — identity, profiles, and profile-scoped viewer state

Covers PL-0401 (auth boundary), PL-0402 (profile model), PL-0403 (progress persistence) and
PL-0404 (watchlist). The specification is `docs/RESEARCH_IDENTITY.md`; this document records how
those rulings were implemented and, equally, what has **not** been verified.

> **What has been executed, as of 2026-09-15 (PL-0405 round 43).** `npm ci`, `npm run typecheck`
> and `npm run test` all run and pass. PostgreSQL 16.15 now exists in the working environment, and
> `migrations/0000_profile_scoped_identity.sql` **has been applied to it** and exercised with live
> Better Auth 1.7.5 sign-up and sign-in. `drizzle-kit` has still not been run. The original
> blanket caveat on this document — "nothing in this lane has been executed" — is no longer true
> and has been replaced by the itemised list under "Unverified" at the end, which is now a list of
> what specifically remains.

---

## Packages

| Package | Owns |
| --- | --- |
| `@liberty/auth` | The seam. Session and profile *types*, the pure profile-authorization decision, the enabled-surface policy, config validation, and the single module that imports `better-auth`. |
| `@liberty/persistence` | The database. Drizzle schema, the first migration, the pure writer-epoch resolver, the progress-reporting policy, and the profile-scoped repositories. |

The dependency arrow is **one-way: `persistence → auth`**. `@liberty/auth` never imports
`@liberty/persistence`; it receives the Drizzle handle and the Better Auth tables as arguments. That
is what allows one package to own the whole database — and therefore one migration to contain both
the auth tables and the profile-scoped tables, which PL-0402 requires.

## Verified dependencies

Checked against the live npm registry and upstream documentation on 2026-08-21. The two Better
Auth rows were re-checked on **2026-09-15** (PL-0405) and moved from `1.7.1` to `1.7.5`; every
other row is unchanged and still carries its original date.

| Package | Version | Licence | Source |
| --- | --- | --- | --- |
| `better-auth` | **1.7.5** (exact pin) | MIT | `npm view better-auth dist-tags` → `latest: 1.7.5`, published 2026-09-14T22:10:52Z |
| `@better-auth/drizzle-adapter` | **1.7.5** (exact pin) | MIT | `npm view @better-auth/drizzle-adapter dist-tags` → `latest: 1.7.5`, published 2026-09-14T22:12:01Z |
| `drizzle-orm` | 0.45.2 (`^0.45.2`) | Apache-2.0 | <https://registry.npmjs.org/-/package/drizzle-orm/dist-tags>, <https://unpkg.com/drizzle-orm@0.45.2/package.json> |
| `drizzle-kit` | 0.31.10 (`^0.31.10`, dev) | Apache-2.0 | <https://registry.npmjs.org/-/package/drizzle-kit/dist-tags> |
| `drizzle-zod` | 0.8.3 (`^0.8.3`) | Apache-2.0 | <https://unpkg.com/drizzle-zod@0.8.3/package.json> |
| `pg` | 8.23.0 (`^8.23.0`) | MIT | <https://unpkg.com/pg@8.23.0/package.json> |
| `@types/pg` | 8.23.1 (dev) | MIT | <https://registry.npmjs.org/-/package/@types%2fpg/dist-tags> |

Corroborating facts read from the same sources:

- Better Auth 1.7.5 declares `drizzle-orm: ^0.45.2 || >=1.0.0-rc.1 <2.0.0` and
  `drizzle-kit: >=0.31.4 || >=1.0.0-beta.1` as optional peers — unchanged from 1.7.1 — so the
  **stable** Drizzle line still satisfies it; `drizzle-orm@1.0.0` is still an `rc` and was not
  chosen.
- Better Auth 1.7.5 declares `next: ^14.0.0 || ^15.0.0 || ^16.0.0` as an optional peer and ships a
  `better-auth/next-js` export, so App Router support is current. The repository is on
  `eslint-config-next@^16`.
- The Drizzle adapter is documented at
  <https://www.better-auth.com/docs/adapters/drizzle> and the current guidance is to install
  `@better-auth/drizzle-adapter` and import `drizzleAdapter` from it. `better-auth@1.7.5` depends on
  exactly `@better-auth/drizzle-adapter@1.7.5`, so both are pinned to the same version.
- Better Auth's security policy states: *"We only support the latest version of Better Auth. Older
  versions are not supported."* (<https://github.com/better-auth/better-auth/blob/main/SECURITY.md>).
  Hence the **exact pin** rather than a caret range, `REVIEWED_BETTER_AUTH_VERSION` in
  `packages/auth/src/enabled-surface.ts`, and the rule that bumping it is security-review work.
  Upstream also publishes a `release-1.6` dist-tag (`1.6.33`, 2026-09-14); the policy text does
  not extend support to it, so "the latest version" is read as the `latest` tag and nothing else.
- **The pin moved 1.7.1 → 1.7.5 on 2026-09-15, and the migration moved with it.** Better Auth
  `1.7.3` (PR #11153) abandoned the `1.7.0`–`1.7.2` `account` schema, restoring account identity
  by `(providerId, accountId)` and dropping the `issuer` requirement; the same release
  (PR #11178) added default-on schema validation that rejects authentication requests when the
  database holds a required column the library never writes. See the `account` table note below
  and ADR-007.

### The zod version boundary — read this before touching `contracts.ts`

`drizzle-zod@0.8.3` emits **zod v4** schemas: its published typings import from `zod/v4`, and its
peer range is `^3.25.0 || ^4.0.0`. `@liberty/contracts` is written against **classic zod v3**
(`import { z } from "zod"`, `zod: ^3.0.0`).

Both coexist in one install because zod 3.25+ ships the v4 core at the `zod/v4` subpath — but they
are **not interchangeable objects**, so a `@liberty/contracts` schema cannot be passed to
`drizzle-zod` as a column refinement. The two are therefore kept in separate lanes rather than
spliced:

- **Row shape** (which columns, which types, which are nullable) is derived from the Drizzle table
  by `drizzle-zod`. Nothing is written twice.
- **Domain rules** (what a normalized content id may look like) stay owned by
  `@liberty/contracts/shared/ids` and are applied at the repository boundary by `parseContentId`.
  The pattern appears exactly once in the repository.

Both new packages declare `zod: ^3.25.0` rather than `^3.0.0`, because `drizzle-zod` needs the
`zod/v4` subpath that only 3.25+ provides.

---

## Schema

```
user ──┬── session ──── active_profile_selection ──┐
       │                                            │
       ├── account                                  │
       │                                            │
       └── profile ◄────────────────────────────────┘
              │
              ├── playback_progress   (PK: profile_id, content_id)
              └── watchlist_entry     (PK: profile_id, content_id)

verification   (standalone)
```

`user`, `session`, `account` and `verification` are Better Auth's core schema. They were
originally transcribed from <https://www.better-auth.com/docs/concepts/database>; the `account`
table was re-derived on 2026-09-15 from the installed package itself — `buildAuthTables` in
`node_modules/@better-auth/core/dist/db/get-tables.mjs`, evaluated through
`getAuthTablesWithResolvedIndexes({})` — because a documentation page is a second-hand account of
what the library writes and the `issuer` episode below is what that costs. Everything below
`profile` is Liberty's.

### Profiles live above auth

`profile` is a product table with a foreign key to `user`. It is not an extension of the identity
record, and `better-auth.ts` deliberately configures **no** `user.additionalFields`.

The active profile is carried in **`active_profile_selection`**, keyed by `session_id` and cascading
from `session`. That is the literal implementation of "carried alongside the session rather than
inside the identity record":

- A column on `user` would make the selection account-wide, so choosing "Kids" on the television
  would reselect it on the phone mid-episode.
- A column on Better Auth's `session` table would be the vendor coupling `packages/auth` exists to
  avoid.
- Keyed by session, the selection is created when a profile is chosen and destroyed when the session
  is revoked — the correct lifetime, and the smaller amount of retained personal data.

The table also carries a **composite foreign key** to `profile (id, user_id)`, so PostgreSQL itself
refuses a selection whose owner disagrees with the profile's real owner. Application code denies the
same case in `authorizeProfileAccess`. Two independent enforcements, because this is the rule whose
failure leaks one household's viewing history to another.

### Data minimisation

`profile` stores a display name, an opaque avatar **key** (not a URL — a URL in an `<img src>` is an
open redirect and a tracking pixel), and a **rating ceiling** rather than a date of birth. The
purpose is "which certificates may this profile see"; a rating ceiling answers exactly that, a birth
date answers considerably more than was asked.

`session.ip_address` and `session.user_agent` are retained only because "sign out my other devices"
is unusable without something to name a device by, and they expire with the session.

### Profile scoping — where it is enforced

Four places, none of which depends on the others:

1. **The type, and — since PL-0405 — the issuance registry behind it.** Every profile-scoped
   repository function takes a `ProfileScope`, never a `profileId: string`. The scope is
   **issued** only by `authorizeProfileAccess` / `authorizeProfileSelection` in `@liberty/auth`:
   `packages/auth/src/profile-scope.ts` brands it with a module-private real `Symbol`, freezes
   it, and records its identity in a `WeakSet`. This paragraph used to claim that forging one
   "requires an explicit `as ProfileScope` cast that a reviewer can grep for". **That was false**,
   and it was a cross-profile data-access bypass rather than a documentation slip: a holder of a
   genuine scope could write `{ ...scope, profileId: someoneElsesId }` with no cast at all,
   because a spread copies the branded property along with everything else. Only object identity
   separates a copy from an issued value, so `profileIdFromScope(scope)` consults the registry
   before it reads the field and throws otherwise.

   **`@liberty/persistence` asks, and one adapter still does not.** Every exported function in
   `progress-repository.ts`, `watchlist-repository.ts` and `profile-repository.ts` obtains the id
   through `profileIdFromScope(input.scope)` as its first statement — ahead of argument
   validation and ahead of any I/O — and `scope.profileId` is not read directly anywhere in the
   package. `scope-forgery.test.ts` attempts the spread forgery against all ten and asserts each
   refuses without a database round trip.

   Still unconverted: `apps/web/src/lib/db/in-memory-repository.ts`, the volatile development
   store, which reads `input.scope.profileId` in fourteen places. It cannot be constructed
   outside a non-deployment process — `createInMemoryRepository` demands an issued
   `ClassifiedRuntime` — so the bypass is bounded to development and test, and it is still a
   bypass. See ADR-007.
2. **The predicate.** Every statement carries `profile_id = scope.profileId` in its `WHERE` or its
   conflict target — never a post-query filter, which a future `.map` can drop.
3. **The primary key.** `profile_id` is the *leading* column of both viewer-state keys, so the index
   is unusable for a query that forgot to scope.
4. **The schema test.** `profile-scoping.test.ts` reads the real Drizzle table objects and asserts
   that every table in `PROFILE_SCOPED_TABLES` leads with a non-null `profile_id`, cascades from
   `profile`, and has **no `user_id` column at all** — the negative form, because that is what
   catches somebody adding one "for convenience".

---

## Progress: the writer epoch

The problem: a viewer starts an episode on the television, picks it up on a phone, and the
television — still open, still on a heartbeat — keeps writing. Both obvious answers are wrong.

| Rejected | Why it fails |
| --- | --- |
| Latest **client timestamp** wins | A client clock is a value the client controls and routinely gets wrong. A device an hour fast wins every argument forever; a device an hour slow can never write again. Packets also reorder in flight, so even honest clocks arrive out of order. |
| **Monotonically increasing position** | Worse, because it looks conservative and is a product bug: it refuses a legitimate **rewind**. A viewer who skips back thirty seconds has their correct, deliberate, current-device write rejected as stale. |

**The implementation.** When a device begins playing a title it asks for a lease. The server bumps
`writer_epoch` for `(profile_id, content_id)` *inside a single `INSERT … ON CONFLICT DO UPDATE`
statement* — so two devices asking at the same instant are serialised by PostgreSQL and get distinct
epochs — and returns `{ epoch, writerId }`. Every subsequent write echoes that pair.

- **Beats timestamps:** `resolveProgressWrite` is *clock-independent*. It reads no clock — there is
  no `Date.now()` in it — and the `instant` it stamps the row with is supplied by the caller and
  compared against nothing. Ordering comes from a counter the *server* allocated, so skew and
  reordering cannot change the outcome. A late packet from a superseded writer is rejected because of
  *who* sent it, not *when*. The instant has exactly one influence on any outcome: if it names no
  moment — an Invalid Date, or a string that is not the canonical `toISOString()` spelling — the
  write is refused as `instant_not_representable` rather than stamped. That check sits *ahead* of
  authority, which looks like a violation of the authority-before-validity rule and is not: the rule
  orders checks on values the **client** asserted, and the instant is the server's own stamp, so an
  unreadable one is a defect in our process and reporting it as `superseded_by_newer_writer` would
  hide our bug behind a description of a handoff that is working perfectly. There is still no field
  anywhere in `ProgressWrite` through which a client can assert a time, and a test asserts that
  absence.
- **Beats monotonic position:** `positionSeconds` is not a term in the authority decision at all.
  The current writer may move the position backwards to zero. The only thing that loses is a stale
  writer, at any position.
- **A claimed epoch higher than the stored one is rejected** (`epoch_not_issued`). Without that
  check, "send a big number" would be a way to seize authority and the scheme would degenerate into
  trusting a client-supplied counter — the timestamp design under a different name.
- **`write_seq`** is a per-writer counter, monotonic *within* one epoch, resolving two packets from
  the *same* device that reordered. It is not a position rule: a rewind carries a higher sequence
  number and is still accepted, and it is only ever compared against writes from the same writer.

Reason codes: `instant_not_representable`, `no_writer_lease`, `epoch_not_issued`,
`superseded_by_newer_writer`, `writer_id_mismatch`, `stale_write_within_writer`,
`position_not_representable`, `position_beyond_runtime`, and the acceptance `current_writer`.
Precedence is authority before validity — with `instant_not_representable` ahead of both, for the
reason above — and the whole order is exported as `PROGRESS_WRITE_CHECK_ORDER` and asserted by test:
reporting "position beyond runtime" for a superseded television would send an engineer to the media
pipeline instead of to the handoff.

**Enforcement vs explanation.** The guard lives in SQL as a conditional
`UPDATE … WHERE writer_epoch = $ AND writer_id = $ AND write_seq < $`, so there is no
read-then-write window. `resolveProgressWrite` is used to *explain* a guard that did not match. The
same policy is expressed twice on purpose: the SQL half cannot be unit-tested without PostgreSQL,
the pure half can.

**No Redis.** Writes go straight to PostgreSQL. Write-behind waits for a *measured* PostgreSQL
problem, per the research. The cheap lever — client-side coalescing — is `heartbeat.ts`.

### Heartbeat interval: still open, on purpose

`UNDECIDED_PROGRESS_REPORTING_POLICY.heartbeatSeconds` is **`null`**, and `planProgressWrite`
refuses heartbeat events with the reason `heartbeat_interval_not_configured`.

The research leaves the interval open as a product choice and asks that a number be picked
deliberately with its reason recorded. A default of 30 would look like that decision had already
been made and would be quoted back as settled within a month. A null is a state somebody has to
resolve rather than one they can inherit.

The event-driven writes are **not** open: pause, settled seek and playback end are unconditional,
because those are the three moments where a lost position is something the viewer notices. An
undecided interval therefore degrades granularity and nothing else.

To decide it: set `heartbeatSeconds` in a named policy constant, write the reason beside it, and
change it later from telemetry.

---

## Watchlist

Plain profile-scoped PostgreSQL, keyed `(profile_id, content_id)`. There is no interesting
distributed problem here and the schema does not invent one — set membership is idempotent by
nature, so the primary key does all the work `writer_epoch` has to do for progress.

`addToWatchlist` uses `ON CONFLICT DO NOTHING`, not an upsert: re-adding must not move the entry to
the top of the list, because `added_at` is when it was *first* added. Removing something absent is a
success. Both matter because the caller is a button on a remote control with an unreliable network
behind it.

---

## What has to be run

1. **`npm install` at the repository root.** Both packages are new and are picked up by the existing
   `workspaces: ["packages/*"]` glob, but their dependencies — `better-auth`,
   `@better-auth/drizzle-adapter`, `drizzle-orm`, `drizzle-zod`, `pg`, `drizzle-kit`, `@types/pg` —
   are not installed yet. Nothing in either package will typecheck or test until this is done. The
   root `package.json` and `package-lock.json` were deliberately not edited.

   **`package-lock.json` was regenerated against the `1.7.5` pin on 2026-09-15 and verified.**
   `rm -rf node_modules && npm ci` exits 0 and resolves `better-auth@1.7.5` and
   `@better-auth/drizzle-adapter@1.7.5`, so `npm ci` is now a usable install path rather than one
   that refuses on a `package.json`/lockfile mismatch.
2. **Reconcile the Better Auth tables — DONE FOR `account` AGAINST THE INSTALLED PACKAGE, STILL
   NOT DONE AGAINST THE GENERATOR.** On 2026-09-15 both statements of the schema —
   `migrations/0000_profile_scoped_identity.sql` and `packages/persistence/src/schema/auth.ts` —
   were reconciled against **1.7.5** by reading the installed package's own `buildAuthTables`
   rather than the documentation site: the `issuer` column and the `(issuer, account_id)` unique
   rule were removed from both, and `UNIQUE (provider_id, account_id)` put in their place. The SQL
   and the Drizzle definition therefore agree, and `drizzle-kit generate` will not propose
   reinstating the abandoned schema. See ADR-007 for the evidence. **The generator has now been
   run and it agrees** — see "Verifying the schema against the generator" below. The hand-written
   version exists so the first migration could be *reviewed as a whole*, not to replace the
   generator.
3. **`npm run db:generate -w @liberty/persistence`.** `migrations/0000_profile_scoped_identity.sql`
   is hand-written and reviewed, but drizzle-kit also needs its `migrations/meta/` journal and
   snapshot, which cannot be produced without running the tool. Diff the generated SQL against the
   hand-written file before trusting either.
4. **`npm run db:migrate -w @liberty/persistence`** with `DATABASE_URL` set. There is no development
   default for that variable, deliberately — `drizzle.config.ts` falls back to `""` and drizzle-kit
   fails on an empty connection URL rather than guessing at a database.

   "Set" means either exported, or written into the **repository root** `.env.local`. The root file
   is reachable because all three `db:*` scripts run through
   `node ../../scripts/with-root-env.mjs --mode development`; without that wrapper they would not
   be, because these scripts run with cwd `packages/persistence` and drizzle-kit's bundled dotenv
   only ever opens `<cwd>/.env`. See
   [DEVELOPMENT.md](DEVELOPMENT.md#the-persistence-db-scripts) for why the mode is `development` and
   not `production`. An exported value still wins over every file.

---

## Verifying the schema against the generator

Executed on 2026-09-15 against PostgreSQL 16.15 (cluster `16/main`, started with
`pg_ctlcluster 16 main start`). Reproduce it as follows.

1. **A role and a database of your own**, so nothing runs as a superuser:

   ```sql
   CREATE ROLE liberty LOGIN PASSWORD 'liberty';
   CREATE DATABASE liberty_pl0405 OWNER liberty;
   ```

2. **Apply the migration.**
   `psql -h 127.0.0.1 -U liberty -d liberty_pl0405 -v ON_ERROR_STOP=1 -f packages/persistence/migrations/0000_profile_scoped_identity.sql`
   — eight `CREATE TABLE`, seven `CREATE INDEX`, exit 0.

3. **Run the generator.** The CLI is the npm package **`auth`**, not `@better-auth/cli`.
   `@better-auth/cli` is marked deprecated on npm ("Package no longer supported"), its newest
   release is `1.4.21`, and it takes `better-auth@1.4.21` as a *direct* dependency — so it would
   describe a version this repository does not use. `auth@1.7.5` takes `better-auth@1.7.5` and
   `@better-auth/core@1.7.5` exactly, and is the version-matched generator.

   It needs a module that exports a constructed instance, which this repository does not otherwise
   have, because `createLibertyAuth` is a factory taking a database, a schema and a mailer. Write
   a throwaway one that calls `createLibertyAuth` with `resolveAuthConfig(...)`,
   `createDatabase({ connectionString })` and `betterAuthSchema` — using the real factory matters,
   because the generator reads `auth.options` and a hand-written option object would generate a
   schema for a configuration Liberty does not run. Then:

   ```
   npx auth@1.7.5 generate --config <that file> --output <somewhere outside the repo> --yes
   ```

**What it produced, and the diff.** The generated `account` table has **no `issuer` column** and
declares **no unique index on `account`** — only `index("account_userId_idx")` — which confirms
both round-42 removals and confirms that `UNIQUE ("provider_id", "account_id")` is **Liberty's
own** rather than a transcription. A field-by-field comparison of
`getAuthTablesWithResolvedIndexes(auth.options)` against `information_schema` on the applied
database found **no missing column, no extra column, no type mismatch and no nullability
mismatch** across `user`, `session`, `account` and `verification`; every index and unique the
library asks for (`session.userId`, `account.userId`, `verification.identifier`, `user.email`,
`session.token`) exists physically. `indexesByTable` is empty, so the library declares no
composite or unique index of its own at all.

**Two differences from the generated file that are deliberate and are not defects.** The generator
emits `timestamp(...)` — `timestamp without time zone` — where this repository uses
`timestamp with time zone` throughout; the library's own field type is `date`, `diffSchema`
inspects column presence and nullability but not types, and the values round-trip correctly in
the live test below. The generator would also name the two foreign-key indexes
`session_userId_idx` / `account_userId_idx` where this repository names them
`session_user_id_idx` / `account_user_id_idx`; index names are not part of anything the library
inspects. The generated file additionally puts `defaultNow()` on several `created_at`/`updated_at`
columns where this migration has no database default — the library supplies those values on every
insert, which the live test confirms, and a column the library writes is never reported as
`unexpected-required-column`.

**Executed end to end, not only compared.** With that database, a real Better Auth 1.7.5 sign-up
and sign-in wrote rows to `user`, `account` and `session`; the credential account landed as
`provider_id = 'credential'`, `account_id = <user id>`, which is the pairing the safety argument
for the unique constraint rests on; a deliberate duplicate of that pair was refused with SQLSTATE
23505 on `account_provider_id_account_id_key`; and the library's default-on schema validation ran
throughout without raising `SchemaMismatchError`. The profile half was exercised directly in SQL:
`UNIQUE (user_id, display_name)` refuses a repeated name, the composite foreign key
`active_profile_selection_profile_owner_fk` refuses a selection naming another household's
profile, `playback_progress_position_within_runtime` and `playback_progress_epoch_positive` refuse
the rows they are meant to, a lease with a `NULL` position is accepted, and deleting the account
cascades the profile, the selection, the progress row and the watchlist entry away.

**No change to the migration was required.**

---

## Unverified

Down to this, as of 2026-09-15:

- **`drizzle-kit` has still not been run.** `migrations/meta/`'s journal and snapshot do not exist,
  so `npm run db:generate` and `npm run db:migrate` are still untried and the migration is applied
  by `psql` rather than by the tool that is supposed to own it.
- **`user`, `session` and `verification` in `schema/auth.ts` are still transcriptions** from the
  docs page dated to the 1.7.1 line, rather than being derived. They now agree with the 1.7.5
  generator column for column, which is evidence, but the file was not regenerated from it.
- **The `COALESCE` in `writeProgress`** and the pure resolver's runtime-retention rule are asserted
  to agree by reading, not by an integration test.
- **Concurrency is untested.** The guarded `UPDATE ... WHERE writer_epoch = $ AND writer_id = $
  AND write_seq < $` was executed as a statement but never raced against a second writer. That is
  the `integration` gate's question, not a single session's.
- **The exact-pinned Better Auth version was re-read from the registry on 2026-09-15**
  (`latest: 1.7.5`, published 2026-09-14) and will be stale the moment upstream publishes. Because
  upstream supports only the latest version, that staleness is a security item, not a housekeeping
  one — and it has already produced one finding: the 1.7.1 pin was four releases behind by the
  time PL-0401 was reviewed.
- **A single applied migration is not the `integration` gate.** Cascade behaviour, the CHECK
  constraints and the composite foreign key were each exercised once, by hand, in one session
  against a scratch database that no longer needs to exist. The `ON CONFLICT` upsert paths and the
  guarded `UPDATE` under concurrent writers were not. PL-0402/0403/0404 still need a committed
  integration suite against a real PostgreSQL instance before their `integration` gate can
  honestly be recorded as `pass`; what this document now records is that the schema those tests
  would run against is real and correct, not that the tests exist.
