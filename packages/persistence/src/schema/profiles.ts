import {
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
     */
    unique("profile_user_id_display_name_key").on(table.userId, table.displayName),
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
    primaryKey({ columns: [table.sessionId] }),
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
