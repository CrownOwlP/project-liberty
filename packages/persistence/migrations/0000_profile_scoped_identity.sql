-- ---------------------------------------------------------------------------
-- Liberty first migration: identity, profiles, and profile-scoped viewer state
--
-- PL-0401 / PL-0402 / PL-0403 / PL-0404.
--
-- WHY THIS IS ONE MIGRATION AND NOT FOUR. `docs/RESEARCH_IDENTITY.md` rules that
-- profile scoping "belongs in the schema from the first migration rather than
-- being retrofitted", because it is the decision that is expensive to reverse.
-- The expensive part is not the ALTER TABLE -- adding a column is easy. It is
-- the BACKFILL: once a household has months of progress rows keyed by account,
-- nothing anywhere records which of the four people in that household watched
-- which episode, and the data cannot be recovered, only discarded. So the auth
-- tables and the profile-scoped tables are created together, and there is no
-- window in which a progress row can exist without a profile id.
--
-- REVIEW STATUS. Hand-written so the first migration could be read as a whole.
-- The four Better Auth tables are reconciled against BETTER AUTH 1.7.5 -- the
-- exact version pinned in `packages/auth/package.json` and asserted by
-- `REVIEWED_BETTER_AUTH_VERSION`. The reconciliation was done against the
-- INSTALLED PACKAGE rather than the documentation site: `buildAuthTables` in
-- `node_modules/@better-auth/core/dist/db/get-tables.mjs` is the function the
-- library itself uses to decide what columns it writes, and
-- `getAuthTablesWithResolvedIndexes({})` was evaluated to enumerate the default
-- (no-plugin) field set and index set this migration must satisfy.
--
-- THE `issuer` COLUMN WAS REMOVED HERE; see the `account` table below for the
-- full reasoning and the upstream citation.
--
-- APPLIED, AND VERIFIED AGAINST THE GENERATOR (2026-09-15, PL-0405 round 43).
-- This file used to end its header by saying nothing in it had ever been
-- executed, because no PostgreSQL existed in the working environment. One does
-- now. The file was applied to an empty PostgreSQL 16.15 database as a
-- non-superuser role and exits 0 -- eight CREATE TABLE, seven CREATE INDEX --
-- and applies cleanly a second time to a second empty database.
--
-- The generator was also run, and it is NOT the one the comment below used to
-- name. `@better-auth/cli` is deprecated on npm and its newest release is
-- 1.4.21, which takes `better-auth@1.4.21` as a direct dependency; running it
-- would have described a version this repository does not use. The CLI now
-- ships as the npm package `auth`, and `auth@1.7.5` pins `better-auth@1.7.5`
-- and `@better-auth/core@1.7.5` exactly. `npx auth@1.7.5 generate`, run against
-- a module that constructs the real `createLibertyAuth` option object, produced
-- a Drizzle schema whose `account` table has NO `issuer` column and declares NO
-- unique index on `account` -- confirming both removals below, and confirming
-- that the `(provider_id, account_id)` unique is OURS.
--
-- A field-by-field diff of `getAuthTablesWithResolvedIndexes(auth.options)`
-- against `information_schema` on the applied database found no missing column,
-- no extra column, no type mismatch and no nullability mismatch. A live 1.7.5
-- sign-up and sign-in wrote rows to `user`, `account` and `session` without the
-- library's default-on schema validation objecting, and a deliberate duplicate
-- `(provider_id, account_id)` was refused with SQLSTATE 23505. NOTHING IN THIS
-- FILE NEEDED TO CHANGE AS A RESULT. The reproduction recipe and the two
-- deliberate differences from the generated file -- `timestamptz` rather than
-- `timestamp`, and this repository's index naming -- are in
-- `docs/DATA_MODEL.md`.
--
-- WHAT IS STILL NOT EXECUTED: drizzle-kit, so `migrations/meta/` has no journal
-- or snapshot; and the guarded UPDATE under concurrent writers, which is the
-- `integration` gate's question rather than this one's.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "user_email_unique" UNIQUE ("email")
);

--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "session_token_unique" UNIQUE ("token"),
  CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");

-- ---------------------------------------------------------------------------
-- THE ACCOUNT TABLE, AND WHY IT NO LONGER HAS AN `issuer` COLUMN (PL-0405)
--
-- This table used to carry `"issuer" text NOT NULL` and
-- `UNIQUE ("issuer", "account_id")`. Both were transcribed from the 1.7.0-1.7.2
-- account schema. Better Auth ABANDONED that schema in 1.7.3 and the repository
-- was left pinned at 1.7.1, so the migration described a shape no supported
-- version of the library uses.
--
-- UPSTREAM, VERBATIM (better-auth CHANGELOG 1.7.3, PR #11153): "Restore sign-in
-- compatibility with 1.6 databases by identifying accounts with
-- `(providerId, accountId)` and removing the `issuer` requirement introduced in
-- 1.7.0. ... If you applied the 1.7.0 through 1.7.2 account schema, remove its
-- issuer unique index before upgrading. For SQL databases, also make `issuer`
-- nullable or remove the column so sign-ups and account linking can succeed.
-- `auth migrate` does not perform this cleanup."
--
-- REMOVED RATHER THAN MADE NULLABLE, which is the stronger of the two remedies
-- upstream offers. Nullable is the remedy for a DEPLOYED 1.7.0-1.7.2 database
-- that already holds rows; this is the FIRST migration and has never been
-- applied anywhere, so there is no data to preserve and a nullable column
-- nothing writes is just a column the next reader has to ask about.
--
-- IT WOULD ALSO BREAK AUTHENTICATION OUTRIGHT IF LEFT NOT NULL. 1.7.3 added
-- start-up and per-request schema validation (PR #11178), enabled by default
-- including in production. `diffSchema` in
-- `node_modules/@better-auth/core/dist/db/schema-diff.mjs` reports any column
-- that is `NOT NULL`, has no default, and is not one the library writes as
-- `unexpected-required-column` -- and `formatSchemaFinding` special-cases the
-- name `issuer` with a link to the 1.7 upgrade guide. Its own words: "every
-- insert into `account` fails".
--
-- THE REPLACEMENT UNIQUENESS RULE IS OURS, NOT THE LIBRARY'S, AND IS STATED AS
-- SUCH. `getAuthTablesWithResolvedIndexes({})` on 1.7.5 reports no unique index
-- on `account` at all: the library enforces account identity in code, in
-- `findAccountByKey` (`node_modules/better-auth/dist/db/internal-adapter.mjs`),
-- which selects on `(providerId, accountId)` with `limit: 2` and throws
-- "Multiple accounts match the same accountId for provider ..." when it finds
-- two. A duplicate pair is therefore an unrecoverable state for the library, and
-- the database is the only place that can make it unrepresentable. The
-- constraint is defence in depth rather than a transcription, and it is safe:
-- credential accounts key on ("credential", user id) and social accounts on
-- (provider, subject), both unique by construction. `diffSchema` inspects
-- columns only, so an additional constraint is not schema drift to the library.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "id_token" text,
  "password" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "account_provider_id_account_id_key" UNIQUE ("provider_id", "account_id"),
  CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");

--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- ---------------------------------------------------------------------------
-- Profiles live ABOVE auth. Nothing below this line is a Better Auth table.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
CREATE TABLE "profile" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "display_name" text NOT NULL,
  "avatar_key" text,
  "max_rating" text,
  "created_at" timestamp with time zone NOT NULL,
  "archived_at" timestamp with time zone,
  CONSTRAINT "profile_user_id_display_name_key" UNIQUE ("user_id", "display_name"),
  -- Redundant against the primary key, and present so other tables can carry a
  -- COMPOSITE foreign key to (id, user_id) -- see active_profile_selection.
  CONSTRAINT "profile_id_user_id_key" UNIQUE ("id", "user_id"),
  CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX "profile_user_id_idx" ON "profile" ("user_id");

--> statement-breakpoint
CREATE TABLE "active_profile_selection" (
  -- PRIMARY KEY on session_id: a session acts as exactly one profile at a time,
  -- and the row dies with the session by cascade. This table is the whole of
  -- "the active profile is carried alongside the session rather than inside the
  -- identity record".
  "session_id" text PRIMARY KEY NOT NULL,
  "profile_id" text NOT NULL,
  "user_id" text NOT NULL,
  "selected_at" timestamp with time zone NOT NULL,
  CONSTRAINT "active_profile_selection_session_id_session_id_fk" FOREIGN KEY ("session_id")
    REFERENCES "session" ("id") ON DELETE cascade,
  CONSTRAINT "active_profile_selection_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user" ("id") ON DELETE cascade,
  -- The database refuses a selection whose owner disagrees with the profile's
  -- real owner. `authorizeProfileAccess` denies the same case in application
  -- code; this is the second, independent enforcement of the rule whose failure
  -- would leak one household's viewing history to another.
  CONSTRAINT "active_profile_selection_profile_owner_fk" FOREIGN KEY ("profile_id", "user_id")
    REFERENCES "profile" ("id", "user_id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX "active_profile_selection_profile_id_idx"
  ON "active_profile_selection" ("profile_id");

-- ---------------------------------------------------------------------------
-- Viewer state. Scoped to profile_id, in the first migration, on purpose.
-- ---------------------------------------------------------------------------

--> statement-breakpoint
CREATE TABLE "playback_progress" (
  "profile_id" text NOT NULL,
  "content_id" text NOT NULL,
  -- NULL means "leased, but no position has ever been reported". It never means
  -- zero. A lease is a claim on the right to write, not a write, and a 0 written
  -- at lease time would make "never watched" indistinguishable from "stopped one
  -- second in" -- which puts a title nobody watched at the top of "continue
  -- watching". listContinueWatching excludes NULL positions for that reason.
  "position_seconds" integer,
  -- NULL means the source never stated a runtime. It never means zero: a zero
  -- here would make every title read as fully watched.
  "runtime_seconds" integer,
  -- The server-issued writer epoch. Incremented by the server when a device
  -- takes over playback; never supplied by a client. This is what decides which
  -- of two devices is current, and it works precisely because its value does
  -- not come from the client.
  "writer_epoch" bigint NOT NULL,
  "writer_id" text NOT NULL,
  -- Monotonic WITHIN one epoch, to order two packets from the same device that
  -- reordered in flight. Not a position rule: a rewind carries a higher
  -- sequence number and is still accepted.
  "write_seq" bigint NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "playback_progress_pkey" PRIMARY KEY ("profile_id", "content_id"),
  CONSTRAINT "playback_progress_profile_id_profile_id_fk" FOREIGN KEY ("profile_id")
    REFERENCES "profile" ("id") ON DELETE cascade,
  -- A NULL position satisfies this: `NULL >= 0` is NULL, and a CHECK only fails
  -- on FALSE. "No position reported" is the absence of a position, not a
  -- negative one.
  CONSTRAINT "playback_progress_position_non_negative" CHECK ("position_seconds" >= 0),
  CONSTRAINT "playback_progress_runtime_positive"
    CHECK ("runtime_seconds" IS NULL OR "runtime_seconds" > 0),
  CONSTRAINT "playback_progress_position_within_runtime"
    CHECK ("runtime_seconds" IS NULL OR "position_seconds" <= "runtime_seconds"),
  CONSTRAINT "playback_progress_epoch_positive" CHECK ("writer_epoch" >= 1),
  CONSTRAINT "playback_progress_seq_non_negative" CHECK ("write_seq" >= 0)
);

--> statement-breakpoint
CREATE INDEX "playback_progress_profile_updated_idx"
  ON "playback_progress" ("profile_id", "updated_at");

--> statement-breakpoint
CREATE TABLE "watchlist_entry" (
  "profile_id" text NOT NULL,
  "content_id" text NOT NULL,
  "added_at" timestamp with time zone NOT NULL,
  -- (profile_id, content_id) makes "add" idempotent at the database level: a
  -- double tap, a retried request and a replayed offline queue all converge on
  -- one row.
  CONSTRAINT "watchlist_entry_pkey" PRIMARY KEY ("profile_id", "content_id"),
  CONSTRAINT "watchlist_entry_profile_id_profile_id_fk" FOREIGN KEY ("profile_id")
    REFERENCES "profile" ("id") ON DELETE cascade
);

--> statement-breakpoint
CREATE INDEX "watchlist_entry_profile_added_idx"
  ON "watchlist_entry" ("profile_id", "added_at");
