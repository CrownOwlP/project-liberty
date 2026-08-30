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

export type ListLimitRejection = {
  readonly ok: false;
  readonly reason: "limit_not_representable";
  readonly detail: string;
};

/**
 * Renders a rejected instant for a reason trail, so the detail is never empty.
 *
 * `String(value)` alone is wrong for the input most likely to arrive from a real
 * caller: an absent or blank header renders as the empty string, so the refusal
 * carried a zero-length detail and explained nothing. A detail that is empty is
 * indistinguishable from one that was never populated, which this project
 * treats as equal to a refusal with no reason at all.
 *
 * Strings go through `JSON.stringify` so that an empty value, a whitespace-only
 * value and one carrying a stray newline are all visibly different in a log;
 * everything else through `String`, because an Invalid Date renders as
 * "Invalid Date" and a number renders as itself.
 *
 * Exported and shared rather than written at each call site. There are two
 * places that refuse an unrepresentable instant -- the watchlist mutation
 * resolver and the writer-lease path -- and this repository has been bitten
 * more than once by one rule with two implementations that agreed only by
 * coincidence.
 */
export function describeUnrepresentableInstant(field: string, value: unknown): string {
  const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
  return `${field} is not a representable instant: ${rendered}`;
}

export type ListLimitParse = { readonly ok: true; readonly limit: number } | ListLimitRejection;

/**
 * The other gate a caller-supplied value passes through before it reaches SQL.
 *
 * `limit` is required on every list query in this package, deliberately, so the
 * page size is a decision at the call site. Required is not the same as
 * VALIDATED: `?limit=abc` becomes `NaN`, `?limit=-1` becomes `-1`, and Drizzle
 * will happily render both into the statement. PostgreSQL answers `LIMIT NaN`
 * with a syntax error and `LIMIT -1` with "LIMIT must not be negative", and both
 * arrive at a request handler as a driver exception naming neither the caller
 * nor the parameter. This turns them into a reason code, the same way
 * `parseContentId` does for an id.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger`: 2^53 is an integer by
 * that test and does not survive the round trip through the driver's numeric
 * encoding, so it would be silently changed rather than refused.
 *
 * ZERO IS ACCEPTED. `LIMIT 0` is legal SQL that returns nothing, and it is the
 * natural result of a paginator that has run out of page. Refusing it would be
 * this module inventing a product rule it was not asked for.
 *
 * NO UPPER BOUND IS IMPOSED, on purpose. Any ceiling written here would be a
 * number nobody chose -- the same defect `heartbeat.ts` refuses to commit with
 * its null interval. The call site owns the page size and `limit` is required so
 * that ownership is visible; a cap belongs there, with a reason, not here.
 */
export function parseListLimit(value: number): ListLimitParse {
  if (!Number.isSafeInteger(value) || value < 0) {
    return {
      ok: false,
      reason: "limit_not_representable",
      detail: `limit must be a non-negative safe integer, received ${String(value)}`
    };
  }
  return { ok: true, limit: value };
}
