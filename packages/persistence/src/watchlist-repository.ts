import type { ProfileScope } from "@liberty/auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { LibertyDatabase } from "./client";
import { type WatchlistEntryRow, parseContentId } from "./contracts";
import { watchlistEntry } from "./schema";

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
 * ---------------------------------------------------------------------- */

export type WatchlistFailure = {
  readonly ok: false;
  readonly reason: "not_a_normalized_content_id";
  readonly detail: string;
};

export type WatchlistMutation =
  | { readonly ok: true; readonly changed: boolean; readonly reason: "added" | "already_present" }
  | { readonly ok: true; readonly changed: boolean; readonly reason: "removed" | "not_present" }
  | WatchlistFailure;

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

  // `changed` and `reason` are separate because the caller needs both answers:
  // the UI wants "it is on the list now" (unchanged either way) and telemetry
  // wants to know whether this request did anything.
  return inserted.length > 0
    ? { ok: true, changed: true, reason: "added" }
    : { ok: true, changed: false, reason: "already_present" };
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
    .returning({ contentId: watchlistEntry.contentId });

  return removed.length > 0
    ? { ok: true, changed: true, reason: "removed" }
    : { ok: true, changed: false, reason: "not_present" };
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
): Promise<readonly WatchlistEntryRow[]> {
  return db
    .select()
    .from(watchlistEntry)
    .where(eq(watchlistEntry.profileId, input.scope.profileId))
    .orderBy(desc(watchlistEntry.addedAt), desc(watchlistEntry.contentId))
    .limit(input.limit);
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
