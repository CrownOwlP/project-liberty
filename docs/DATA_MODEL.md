# Data model — identity, profiles, and profile-scoped viewer state

Covers PL-0401 (auth boundary), PL-0402 (profile model), PL-0403 (progress persistence) and
PL-0404 (watchlist). The specification is `docs/RESEARCH_IDENTITY.md`; this document records how
those rulings were implemented and, equally, what has **not** been verified.

> **Nothing in this lane has been executed.** No `npm install`, no `tsc`, no `vitest`, no
> `drizzle-kit`, no PostgreSQL. Every claim below is a claim about source that was written, not
> about software that was run. See "Unverified" at the end.

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

Checked against the live npm registry and upstream documentation on 2026-08-21.

| Package | Version | Licence | Source |
| --- | --- | --- | --- |
| `better-auth` | **1.7.1** (exact pin) | MIT | <https://registry.npmjs.org/better-auth/latest> |
| `@better-auth/drizzle-adapter` | **1.7.1** (exact pin) | MIT | <https://unpkg.com/@better-auth/drizzle-adapter@1.7.1/package.json> |
| `drizzle-orm` | 0.45.2 (`^0.45.2`) | Apache-2.0 | <https://registry.npmjs.org/-/package/drizzle-orm/dist-tags>, <https://unpkg.com/drizzle-orm@0.45.2/package.json> |
| `drizzle-kit` | 0.31.10 (`^0.31.10`, dev) | Apache-2.0 | <https://registry.npmjs.org/-/package/drizzle-kit/dist-tags> |
| `drizzle-zod` | 0.8.3 (`^0.8.3`) | Apache-2.0 | <https://unpkg.com/drizzle-zod@0.8.3/package.json> |
| `pg` | 8.23.0 (`^8.23.0`) | MIT | <https://unpkg.com/pg@8.23.0/package.json> |
| `@types/pg` | 8.23.1 (dev) | MIT | <https://registry.npmjs.org/-/package/@types%2fpg/dist-tags> |

Corroborating facts read from the same sources:

- Better Auth 1.7.1 declares `drizzle-orm: ^0.45.2 || >=1.0.0-rc.1 <2.0.0` and
  `drizzle-kit: >=0.31.4 || >=1.0.0-beta.1` as optional peers, so the **stable** Drizzle line
  satisfies it — `drizzle-orm@1.0.0` is still an `rc` and was not chosen.
- Better Auth 1.7.1 declares `next: ^14.0.0 || ^15.0.0 || ^16.0.0` as an optional peer and ships a
  `better-auth/next-js` export, so App Router support is current. The repository is on
  `eslint-config-next@^16`.
- The Drizzle adapter is documented at
  <https://www.better-auth.com/docs/adapters/drizzle> and the current guidance is to install
  `@better-auth/drizzle-adapter` and import `drizzleAdapter` from it. `better-auth@1.7.1` depends on
  exactly `@better-auth/drizzle-adapter@1.7.1`, so both are pinned to the same version.
- Better Auth's security policy states: *"We only support the latest version of Better Auth. Older
  versions are not supported."* (<https://github.com/better-auth/better-auth/blob/main/SECURITY.md>).
  Hence the **exact pin** rather than a caret range, `REVIEWED_BETTER_AUTH_VERSION` in
  `packages/auth/src/enabled-surface.ts`, and the rule that bumping it is security-review work.

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

`user`, `session`, `account` and `verification` are Better Auth's core schema, transcribed from
<https://www.better-auth.com/docs/concepts/database>. Everything below `profile` is Liberty's.

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

1. **The type.** Every profile-scoped repository function takes a `ProfileScope`, never a
   `profileId: string`. `ProfileScope` carries a non-exported `unique symbol` brand and is minted
   only by `authorizeProfileAccess` / `authorizeProfileSelection` in `@liberty/auth`. Forging one
   requires an explicit `as ProfileScope` cast that a reviewer can grep for.
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
2. **Reconcile the Better Auth tables.** Run `npx @better-auth/cli@1.7.1 generate` against
   `createLibertyAuth`'s configuration and diff its output against
   `packages/persistence/src/schema/auth.ts`. The hand-written version exists so the first migration
   could be *reviewed as a whole*, not to replace the generator.
3. **`npm run db:generate -w @liberty/persistence`.** `migrations/0000_profile_scoped_identity.sql`
   is hand-written and reviewed, but drizzle-kit also needs its `migrations/meta/` journal and
   snapshot, which cannot be produced without running the tool. Diff the generated SQL against the
   hand-written file before trusting either.
4. **`npm run db:migrate -w @liberty/persistence`** with `DATABASE_URL` set. There is no development
   default for that variable, deliberately.

---

## Unverified

Nothing was executed. In particular:

- **No test has been run.** The vitest files were written to the repository's conventions but their
  pass/fail state is unknown.
- **No typecheck has been run.** The most likely places to break: the derived types
  `Parameters<typeof drizzleAdapter>[0]` and `…[1]["schema"]` in `packages/auth/src/better-auth.ts`,
  which depend on the adapter's exported signature; and drizzle-zod's `.shape` surface in
  `contracts.test.ts`, which is a zod v4 object.
- **The hand-written Better Auth schema is transcribed from documentation**, not generated. Field
  names, nullability and the `(issuer, account_id)` unique index came from the docs page dated to
  the 1.7.1 line; the CLI is authoritative and has not been run.
- **The first migration SQL has never been applied to a PostgreSQL instance.** Syntax, constraint
  names and the composite foreign key to `profile (id, user_id)` are unexecuted.
- **`drizzle-orm@0.45.2`'s array-returning table-config callback and `check()` helper** are used
  throughout the schema. Both are believed current for the 0.45 line; neither was compiled.
- **The `COALESCE` in `writeProgress`** and the pure resolver's runtime-retention rule are asserted
  to agree by reading, not by an integration test.
- **The exact-pinned Better Auth version was read from the registry on 2026-08-21** and will be
  stale the moment upstream publishes. Because upstream supports only the latest version, that
  staleness is a security item, not a housekeeping one.
- **Anything requiring a database is untested by construction:** the SQL guard's atomicity under
  concurrent writes, the `ON CONFLICT` upsert paths, cascade behaviour, the CHECK constraints, and
  the composite foreign key. These need an integration suite against a real PostgreSQL instance
  before the `integration` gate on PL-0402/0403/0404 can honestly be recorded as `pass`.
