import { normalizedContentIdSchema, type NormalizedContentId } from "@liberty/contracts/shared/ids";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { playbackProgress, profile, watchlistEntry } from "./schema";

/* -------------------------------------------------------------------------
 * One definition per shape: the Drizzle table, and zod DERIVED from it
 *
 * The house rule is that where a Drizzle schema and a zod schema describe the
 * same thing, one is derived from the other. The direction chosen here is
 * table -> zod, via `drizzle-zod`, because the table is what the migration and
 * the query builder both read: a zod schema that disagreed with the table would
 * be wrong about the database, whereas a table that disagrees with a derived
 * schema is impossible by construction.
 *
 * A VERSION BOUNDARY WORTH KNOWING ABOUT. `drizzle-zod@0.8.3` emits **zod v4**
 * schemas -- its type surface imports from `zod/v4`, which is why its peer range
 * is `^3.25.0 || ^4.0.0` rather than `^3.0.0`. `@liberty/contracts` is written
 * against classic zod v3 (`import { z } from "zod"`). Both live in one install
 * because zod 3.25+ ships the v4 core at the `zod/v4` subpath, but they are NOT
 * interchangeable objects: a v3 schema cannot be handed to `drizzle-zod` as a
 * column refinement.
 *
 * So the two are kept in their own lanes rather than spliced:
 *
 *   - ROW SHAPE (which columns, which types, which are nullable) is derived
 *     from the table by `drizzle-zod`.
 *   - DOMAIN RULES (what a content id is allowed to look like) stay owned by
 *     `@liberty/contracts` and are applied at the boundary by
 *     `parseContentId` below.
 *
 * Nothing is written twice under that arrangement -- in particular the
 * normalized-id pattern is not copied here -- and `contracts.test.ts` asserts
 * that a value the contracts schema rejects cannot reach a repository.
 * ---------------------------------------------------------------------- */

/** Row shapes, derived. Adding a column to a table changes these with no edit here. */
export const profileRowSchema = createSelectSchema(profile);
export const playbackProgressRowSchema = createSelectSchema(playbackProgress);
export const watchlistEntryRowSchema = createSelectSchema(watchlistEntry);

/** Insert shapes, derived. Used to validate what we are about to write, not what we read. */
export const profileInsertSchema = createInsertSchema(profile);
export const playbackProgressInsertSchema = createInsertSchema(playbackProgress);
export const watchlistEntryInsertSchema = createInsertSchema(watchlistEntry);

/**
 * Row TYPES come from Drizzle's own inference, not from the zod schemas.
 *
 * `$inferSelect` is the type the query builder actually returns, so a mismatch
 * between it and a repository signature is a compile error rather than a
 * runtime surprise. Inferring from the zod schema instead would put one more
 * translation between the database and the type.
 */
export type ProfileRow = typeof profile.$inferSelect;
export type PlaybackProgressRow = typeof playbackProgress.$inferSelect;
export type WatchlistEntryRow = typeof watchlistEntry.$inferSelect;

export type ContentIdRejection = {
  readonly ok: false;
  readonly reason: "not_a_normalized_content_id";
  readonly detail: string;
};

export type ContentIdParse = { readonly ok: true; readonly contentId: NormalizedContentId } | ContentIdRejection;

/**
 * The one gate a content id passes through before it is used as part of a
 * primary key.
 *
 * `content_id` is `text` in PostgreSQL, so the database will accept
 * `"The Northstar Affair"` and `"the-northstar-affair"` as two different works.
 * The contracts schema is the authority on which spelling is real, and it is
 * called rather than re-implemented -- the regex appears exactly once in this
 * repository, in `@liberty/contracts/shared/ids`.
 *
 * Returns a result rather than throwing, so the caller can put the rejection
 * into its own reason trail instead of turning a data problem into a 500.
 */
export function parseContentId(value: unknown): ContentIdParse {
  const parsed = normalizedContentIdSchema.safeParse(value);
  if (parsed.success) return { ok: true, contentId: parsed.data };
  return {
    ok: false,
    reason: "not_a_normalized_content_id",
    detail: parsed.error.issues.map((issue) => issue.message).join("; ")
  };
}
