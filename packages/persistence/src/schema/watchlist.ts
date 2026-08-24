import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { profile } from "./profiles";

/* -------------------------------------------------------------------------
 * Watchlist (PL-0404)
 *
 * Plain, profile-scoped PostgreSQL. There is no interesting distributed problem
 * here and the schema should not invent one: "on my list" is a set, and a set
 * membership is idempotent by nature, so the primary key does all the work that
 * `writer_epoch` has to do for progress.
 *
 * The one thing this table shares with progress is the thing that matters: it is
 * keyed by `profileId`. A household watchlist is the wrong product -- the whole
 * point of a profile is that one person's list is not everyone's -- and it is
 * also the version that cannot be un-merged later.
 * ---------------------------------------------------------------------- */

export const watchlistEntry = pgTable(
  "watchlist_entry",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    contentId: text("content_id").notNull(),
    /**
     * When it was added, which is also the list's ORDER. Stored rather than
     * derived because "most recently added first" is the only ordering the
     * product has asked for and a row's physical order guarantees nothing.
     */
    addedAt: timestamp("added_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [
    /**
     * `(profileId, contentId)` makes "add" idempotent at the database level:
     * a double tap, a retried request and a replayed offline queue all converge
     * on one row instead of producing duplicates that then need de-duplicating
     * on read.
     */
    primaryKey({ columns: [table.profileId, table.contentId] }),
    index("watchlist_entry_profile_added_idx").on(table.profileId, table.addedAt)
  ]
);
