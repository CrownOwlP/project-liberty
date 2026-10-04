import {
  boolean,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique
} from "drizzle-orm/pg-core";
import { session, user } from "./auth";

/* -------------------------------------------------------------------------
 * Profiles, and the selection that sits NEXT TO a session (PL-0402)
 *
 * Two tables, and the split between them is the ruling:
 *
 *   `profile`                  -- a viewer. Owned by an account. Long-lived.
 *   `active_profile_selection` -- which viewer THIS session is currently
 *                                 acting as. Dies with the session.
 *
 * The second table is the literal implementation of "the active profile is
 * carried alongside the session rather than inside the identity record". A
 * column on `user` would have made the selection an account-wide fact, so
 * choosing "Kids" on the television would reselect it on the phone; a column on
 * `session` would have meant editing Better Auth's own table, which is the
 * vendor coupling `packages/auth` exists to avoid.
 *
 * DATA MINIMISATION. A profile stores a display name and an avatar key. No date
 * of birth, no email, no free-text notes. An age RATING CEILING is stored
 * rather than an age, because the purpose is "which certificates may this
 * profile see", and a rating ceiling answers that exactly while a birth date
 * answers considerably more than was asked.
 * ---------------------------------------------------------------------- */

/**
 * The NAME of the display-name uniqueness constraint, written down once.
 *
 * `createProfile` has to recognise a violation of THIS constraint specifically,
 * because the same `INSERT` also touches `profile_id_user_id_key` and the
 * primary key on `id` -- and a unique violation on either of those is a UUID
 * collision, not a name a household has already used. Reporting either of those
 * as "that name is taken" would send somebody to rename a profile in response to
 * a bug in the id generator.
 *
 * Exported rather than repeated as a string literal in `profile-repository.ts`,
 * because the repository's match is only correct while the two spellings agree
 * and nothing would fail if they stopped: the catch would simply never fire
 * again, and the refusal it produces would silently go back to being a driver
 * exception. One definition means that cannot happen.
 *
 * THE VALUE IS IN APPLIED DDL. `migrations/0000_profile_scoped_identity.sql`
 * names it, so changing the string is a migration rather than a rename -- the
 * identifier of this constant is free to change, its value is not.
 */
export const PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT = "profile_user_id_display_name_key";

export const profile = pgTable(
  "profile",
  {
    id: text("id").primaryKey(),
    /**
     * The owning ACCOUNT. `onDelete: "cascade"` because a profile has no
     * meaning without the account that owns it, and an orphaned profile row is
     * personal data with no controller and no way to reach the person it
     * describes.
     */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /**
     * An opaque key into avatar storage, not a URL. A URL in this column would
     * be a caller-supplied string rendered into an `<img src>`, which is an
     * open redirect and a tracking pixel waiting for somebody to paste one in.
     */
    avatarKey: text("avatar_key"),
    /**
     * The highest content rating this profile may be shown, as an opaque
     * certificate label. Nullable means "unrestricted"; it is NOT a default of
     * "adult", because a null that silently means the most permissive value is
     * how a kids profile ends up unrestricted after a failed migration.
     */
    maxRating: text("max_rating"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    /**
     * Archival rather than deletion, so that progress rows keep a valid
     * `profileId` and household history is not silently rewritten when somebody
     * removes a profile. `authorizeProfileAccess` refuses archived profiles, so
     * an archived profile is history and not a usable identity.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" })
  },
  (table) => [
    index("profile_user_id_idx").on(table.userId),
    /**
     * Two profiles named "Dad" in one household are indistinguishable on the
     * picker, and the picker is the only place a profile is chosen. The
     * constraint spans the ARCHIVED ones too, deliberately: reusing an archived
     * profile's name would make the two impossible to tell apart in history.
     *
     * `createProfile` translates a violation of it into a reasoned refusal; see
     * `PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT` above for why the name is a
     * constant rather than a literal in two files.
     */
    unique(PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT).on(table.userId, table.displayName),
    /**
     * Redundant against the primary key on `id` alone, and it exists anyway so
     * that other tables can carry a COMPOSITE foreign key to `(id, user_id)`.
     * That is what lets PostgreSQL refuse a row whose denormalised owner
     * disagrees with the profile's real owner -- an invariant that is otherwise
     * only as strong as the application code that last touched it.
     */
    unique("profile_id_user_id_key").on(table.id, table.userId)
  ]
);

export const activeProfileSelection = pgTable(
  "active_profile_selection",
  {
    /**
     * PRIMARY KEY on `sessionId` alone: a session acts as exactly one profile
     * at a time. Modelled as a many-to-many, "which profile is this request
     * for" would stop having a single answer, and every progress write would
     * need the client to tell us -- which is precisely the class of
     * client-asserted fact the writer epoch exists to stop trusting.
     */
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    profileId: text("profile_id").notNull(),
    /**
     * Denormalised owner, carried so that the ownership check can be made in
     * the same read as the selection. It is also a CONSTRAINT surface: the
     * migration adds a composite foreign key to `(profile.id, profile.user_id)`
     * so the database itself refuses a selection whose owner disagrees with the
     * profile's, rather than trusting application code to have checked.
     */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    selectedAt: timestamp("selected_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [
    /*
     * THE CONSTRAINT IS NAMED, AND THE NAME IS THE DATABASE'S (PL-0407).
     *
     * Drizzle synthesises `<table>_<columns>_pk` when no name is given. The
     * reviewed hand-written migration does not use that convention -- it
     * writes an inline `PRIMARY KEY` on the column -- so PostgreSQL creates
     * `active_profile_selection_pkey`, and the generated snapshot claimed a
     * constraint that does not exist. Nothing was wrong at runtime; the
     * first generated migration that touched this key would have emitted
     * `DROP CONSTRAINT "<the name that is not there>"` and failed against
     * every real database at once.
     *
     * This is a METADATA ALIGNMENT, not a semantic change: the key, its
     * columns and its behaviour are identical either way. gpt-architect's
     * round-99 ruling chose it over renaming live constraints to suit a
     * tool, and over hand-editing generated output, which would be lost the
     * next time anyone regenerates.
     */
    primaryKey({ name: "active_profile_selection_pkey", columns: [table.sessionId] }),
    /**
     * The composite foreign key described on `userId` above. With it, a
     * selection row naming profile P and owner A can only exist if P really is
     * owned by A -- so the cross-account case that `authorizeProfileAccess`
     * denies in application code is ALSO unrepresentable in the database. Two
     * independent enforcements of one rule, because this is the rule whose
     * failure leaks one household's viewing history to another.
     */
    foreignKey({
      columns: [table.profileId, table.userId],
      foreignColumns: [profile.id, profile.userId],
      name: "active_profile_selection_profile_owner_fk"
    }).onDelete("cascade"),
    index("active_profile_selection_profile_id_idx").on(table.profileId)
  ]
);

/* -------------------------------------------------------------------------
 * What a viewer has chosen, kept apart from who they are (PL-0723)
 *
 * ==========================================================================
 * A TABLE RATHER THAN FOUR MORE COLUMNS ON `profile`
 * ==========================================================================
 *
 * THE DECIDING REASON IS NOT TIDINESS. PL-0723's acceptance requires that
 * "nothing chosen" is representable and is DIFFERENT from "an empty list
 * chosen" -- a profile that has never opened the settings screen has
 * expressed no opinion, and one whose viewer deliberately cleared the list
 * has expressed a strong one. With a row, that distinction is free and
 * unambiguous: no row means nobody has chosen, and a row holding `{}` means
 * somebody chose nothing. With nullable columns it is carried by the
 * difference between NULL and '{}', which is the sort of distinction that
 * survives exactly as long as the first person who writes `COALESCE`.
 *
 * It is also the honest modelling. `profile` answers "who is watching" and
 * its own comments defend keeping it minimal; a preference is not identity,
 * it is a setting that happens to be keyed by one.
 *
 * ==========================================================================
 * AND IT IS NOT A PLACE FOR CAPABILITIES
 * ==========================================================================
 *
 * Every column here is a statement of TASTE. Nothing in this table may widen
 * what a viewer is allowed to play, reach or decode, because every value in
 * it arrives from a client: a capability-shaped column here would be an
 * attacker-supplied capability. `maxRating` stays on `profile`, written
 * through the profile API, for exactly that reason and is deliberately not
 * mirrored here.
 * ---------------------------------------------------------------------- */
export const profileMediaPreference = pgTable(
  "profile_media_preference",
  {
    /**
     * ONE ROW PER PROFILE, enforced by making the foreign key the primary key
     * rather than by a separate unique index. A profile with two preference
     * rows has no defined answer, and the cheapest way to make that
     * unrepresentable is to leave no column for a second one.
     *
     * `onDelete: "cascade"` for the reason the profile's own `userId` gives:
     * a preference with no profile is personal data with no controller.
     */
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
  /**
   * Ordered, most-preferred first. A Postgres array rather than a delimited
   * string or a jsonb blob: the ordering is the only information these lists
   * carry, an array preserves it natively, and a delimiter is a bug waiting
   * for a tag that contains one.
   *
   * NOT NULL with an empty default would destroy the distinction this table
   * exists for, so these are plain NOT NULL and the distinction is the row.
   */
    preferredAudioLanguages: text("preferred_audio_languages").array().notNull(),
    preferredSubtitleLanguages: text("preferred_subtitle_languages").array().notNull(),
  /**
   * `auto` or `off`, as `subtitleModeSchema` in `@liberty/contracts` defines
   * them. Stored as text rather than as a Postgres enum: the contract owns
   * the value set, and a database enum would mean a migration every time that
   * contract grew a mode, with the two definitions free to disagree in
   * between.
   */
    subtitleMode: text("subtitle_mode").notNull(),
    hearingImpaired: boolean("hearing_impaired").notNull(),
  /**
   * Whether this viewer allows playback diagnostics to be reported
   * (PL-0724).
   *
   * NOT NULL WITH A `true` DEFAULT, and the default is here rather than only
   * in the contract for one reason: migration 0002 adds this column to rows
   * that already exist, and those rows belong to viewers who configured
   * languages before diagnostics was a setting. Without a default the
   * migration could not add a NOT NULL column at all; with `false` it would
   * silently opt those viewers out of something they never declined. `true`
   * is what the product did for them yesterday.
   *
   * The DEFAULT is for the backfill. Every write from the application
   * supplies the value explicitly, so nothing depends on it at runtime.
   */
    playbackDiagnostics: boolean("playback_diagnostics").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [
    /*
     * DECLARED AS A TABLE-LEVEL KEY WITH AN EXPLICIT NAME, not as
     * `.primaryKey()` on the column, and both halves are deliberate.
     *
     * TABLE-LEVEL because `profile-scoping.test.ts` reads
     * `getTableConfig(table).primaryKeys` and asserts the key leads with
     * `profile_id`; a column-level primary key does not appear there at all,
     * so the automatic scoping check would have passed this table without
     * examining it. The test found that on the first run.
     *
     * EXPLICITLY NAMED because of PL-0407. Drizzle's default name for a
     * single-column table-level key is `<table>_<column>_pk`, while
     * PostgreSQL names an unnamed one `<table>_pkey` -- and when the snapshot
     * and the database disagreed about a key's NAME for three tables, nothing
     * was wrong at runtime and the first generated migration touching one of
     * them would have emitted `DROP CONSTRAINT` against a name no database
     * has. Naming it here means the generated SQL, the snapshot and the
     * database all say the same word.
     */
    primaryKey({ columns: [table.profileId], name: "profile_media_preference_pkey" })
  ]
);
