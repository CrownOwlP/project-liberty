import type { ProfileScope } from "@liberty/auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { LibertyDatabase } from "./client";
import {
  type ListLimitRejection,
  type WatchlistEntryRow,
  parseContentId,
  parseListLimit
} from "./contracts";
import { watchlistEntry } from "./schema";
import {
  type WatchlistMutationResolution,
  resolveWatchlistMutation
} from "./watchlist-mutation";

/* -------------------------------------------------------------------------
 * Watchlist: add, remove, list (PL-0404)
 *
 * The same enforcement as progress and for the same reason: a `ProfileScope`
 * argument, a `profile_id` predicate on every statement, and `profile_id` as the
 * leading column of the primary key. What one profile put on its list is not
 * visible to another profile in the same household, and that is a product
 * requirement rather than a security nicety -- a shared list is a different,
 * worse product.
 *
 * ADD AND REMOVE ARE IDEMPOTENT. Adding twice is one row; removing something
 * absent is not an error. Both matter more than they look: the client that calls
 * these is a button on a remote control with an unreliable network behind it,
 * and a retried request must not become a duplicate or a failure.
 *
 * ENFORCEMENT VS EXPLANATION, the same split progress uses. The statements below
 * are each ATOMIC -- `ON CONFLICT DO NOTHING ... RETURNING` and a scoped
 * `DELETE ... RETURNING` -- so two devices are serialised by PostgreSQL and
 * there is no read-modify-write window between them. That is the enforcement.
 * `resolveWatchlistMutation` then names what happened, and it is the only place
 * the outcome vocabulary exists, so this file cannot invent a fifth spelling of
 * "nothing happened". The conflict RULE those statements implement -- server
 * arrival order, and what it knowingly does not cover -- is argued in
 * `watchlist-mutation.ts`.
 * ---------------------------------------------------------------------- */

/**
 * What a mutation refuses before it ever reaches a verdict about the list.
 *
 * A boundary failure, not an outcome: "that is not a content id" is a statement
 * about the request, and `already_present` is a statement about the watchlist.
 * They are kept in separate unions -- rather than folded into one reason enum --
 * so a caller pattern-matching on outcomes cannot treat a malformed request as
 * "the title is already on the list".
 */
export type WatchlistFailure = {
  readonly ok: false;
  readonly reason: "not_a_normalized_content_id";
  readonly detail: string;
};

/** What a mutation returns: a reasoned resolution, or a boundary refusal. */
export type WatchlistMutation = WatchlistMutationResolution | WatchlistFailure;

/**
 * Put a title on this profile's list.
 *
 * `onConflictDoNothing` rather than an upsert: re-adding must not move the
 * entry to the top of the list. `addedAt` is when it was FIRST added, and
 * rewriting it would silently reorder a list the viewer did not touch.
 */
export async function addToWatchlist(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope; readonly contentId: string; readonly instant: Date }
): Promise<WatchlistMutation> {
  const contentId = parseContentId(input.contentId);
  if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

  // Checked BEFORE the statement, and this is the hole that used to be here. An
  // Invalid Date -- which is what `new Date(x)` returns for any `x` it cannot
  // read, including a header and a parsed JSON field -- reached the driver,
  // which failed serialising it into a timestamp literal. The tap on the remote
  // came back as a driver error naming `added_at`, at a stack depth that says
  // nothing about the caller who built the date. `issueWriterLease` already
  // guards its own instant for exactly this reason; this path had no resolver
  // downstream to catch it either.
  //
  // The check is the RESOLVER itself rather than a second copy of the rule, so
  // the pre-flight and the policy cannot disagree about what a moment is. Only
  // the refusal is used; the accepted answer this call would give is about a
  // pre-state we have not read yet and is discarded.
  const preflight = resolveWatchlistMutation({
    stored: null,
    mutation: { kind: "add", instant: input.instant }
  });
  if (!preflight.accepted) return preflight;

  const inserted = await db
    .insert(watchlistEntry)
    .values({
      profileId: input.scope.profileId,
      contentId: contentId.contentId,
      addedAt: input.instant
    })
    .onConflictDoNothing({
      target: [watchlistEntry.profileId, watchlistEntry.contentId]
    })
    .returning({ contentId: watchlistEntry.contentId });

  // The statement proves the pre-state: a returned row means there was none, and
  // no returned row means there was one. `addedAt: null` on that second branch is
  // "a row exists and we did not read when it was added" -- the honest value,
  // where substituting `input.instant` would fabricate a first-added time that
  // is wrong by however long the entry has really been on the list.
  return resolveWatchlistMutation({
    stored: inserted.length > 0 ? null : { addedAt: null },
    mutation: { kind: "add", instant: input.instant }
  });
}

/** Take a title off this profile's list. Removing something absent is a success. */
export async function removeFromWatchlist(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope; readonly contentId: string }
): Promise<WatchlistMutation> {
  const contentId = parseContentId(input.contentId);
  if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

  const removed = await db
    .delete(watchlistEntry)
    .where(
      and(
        eq(watchlistEntry.profileId, input.scope.profileId),
        eq(watchlistEntry.contentId, contentId.contentId)
      )
    )
    .returning({ addedAt: watchlistEntry.addedAt });

  // `DELETE ... RETURNING` hands back the row as it was, so unlike the add path
  // the pre-state here is fully known and `addedAt` is a real value rather than
  // an unknown.
  const deleted = removed[0];
  return resolveWatchlistMutation({
    stored: deleted === undefined ? null : { addedAt: deleted.addedAt.toISOString() },
    mutation: { kind: "remove" }
  });
}

/**
 * This profile's list, most recently added first.
 *
 * `contentId` is the tie-break, for the same reason as in
 * `listContinueWatching`: a bulk import can add many entries in one instant, and
 * without a total order a paginated list drops and repeats rows.
 */
export async function listWatchlist(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope; readonly limit: number }
): Promise<readonly WatchlistEntryRow[] | ListLimitRejection> {
  // `limit` is required so the page size is a decision at the call site, but a
  // required number is still an unvalidated one: `?limit=abc` arrives as NaN and
  // PostgreSQL answers `LIMIT NaN` with a syntax error nobody can attribute.
  const limit = parseListLimit(input.limit);
  if (!limit.ok) return limit;

  return db
    .select()
    .from(watchlistEntry)
    .where(eq(watchlistEntry.profileId, input.scope.profileId))
    .orderBy(desc(watchlistEntry.addedAt), desc(watchlistEntry.contentId))
    .limit(limit.limit);
}

/**
 * Whether specific titles are on this profile's list.
 *
 * Exists so a catalogue page can ask once for the rows it is about to render
 * rather than calling `listWatchlist` and filtering, which would pull an
 * unbounded list to answer a bounded question.
 */
export async function watchlistContains(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope; readonly contentIds: readonly string[] }
): Promise<ReadonlySet<string>> {
  const valid: string[] = [];
  for (const candidate of input.contentIds) {
    const parsed = parseContentId(candidate);
    // An unparseable id cannot be on the list, because it could never have been
    // written. Dropping it is not silent data loss; storing it would have been.
    if (parsed.ok) valid.push(parsed.contentId);
  }
  if (valid.length === 0) return new Set();

  const rows = await db
    .select({ contentId: watchlistEntry.contentId })
    .from(watchlistEntry)
    .where(
      and(
        eq(watchlistEntry.profileId, input.scope.profileId),
        inArray(watchlistEntry.contentId, valid)
      )
    );

  return new Set(rows.map((row) => row.contentId));
}
