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
-- The four Better Auth tables are transcribed from
-- https://www.better-auth.com/docs/concepts/database (core schema, read
-- 2026-08-21 against Better Auth 1.7.1) and MUST be reconciled against
-- `npx @better-auth/cli generate` before this is applied to any database that
-- matters. Nothing in this file has been executed; see `docs/DATA_MODEL.md`.
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

--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "issuer" text NOT NULL,
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
  -- Better Auth's own constraint. It is what stops two provider identities
  -- collapsing into one local account.
  CONSTRAINT "account_issuer_account_id_key" UNIQUE ("issuer", "account_id"),
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
