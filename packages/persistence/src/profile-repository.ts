import type { LibertySession, ProfileOwnership, ProfileScope } from "@liberty/auth";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { LibertyDatabase } from "./client";
import type { ProfileRow } from "./contracts";
import { activeProfileSelection, profile } from "./schema";

/* -------------------------------------------------------------------------
 * Profiles: create, list, select (PL-0402)
 *
 * Everything here that reads or writes a profile takes either a `LibertySession`
 * -- for the account-level operations, which is what "list MY profiles" is -- or
 * a `ProfileScope`, for the operations that act AS one profile.
 *
 * There is no function that takes a bare `profileId: string`. That is the
 * enforcement: `ProfileScope` is minted only by `authorizeProfileAccess` in
 * `@liberty/auth`, its brand is a non-exported `unique symbol`, and so a caller
 * cannot reach a profile's data without having passed the authorization
 * decision. Forging one requires an explicit `as ProfileScope` cast, which a
 * reviewer can grep for and which is not something anybody writes by accident.
 * ---------------------------------------------------------------------- */

/** Reduce a stored row to the three facts authorization is allowed to see. */
function toOwnership(row: ProfileRow): ProfileOwnership {
  return {
    profileId: row.id,
    ownerUserId: row.userId,
    // ISO strings across the boundary, so the pure decision never handles a
    // `Date` and can never be tempted to compare one to `Date.now()`.
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString()
  };
}

/**
 * Load the ownership record `authorizeProfileAccess` needs.
 *
 * Takes a raw id, and is the ONE function here that does, because it is the
 * lookup that happens BEFORE authorization -- it is what produces the input to
 * the decision. It returns ownership facts only: no display name, no avatar, no
 * rating ceiling. A lookup that returned the whole row would make it easy to
 * render a profile the caller has not been authorized for.
 */
export async function loadProfileOwnership(
  db: LibertyDatabase,
  profileId: string
): Promise<ProfileOwnership | null> {
  const rows = await db.select().from(profile).where(eq(profile.id, profileId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toOwnership(row);
}

/**
 * The profiles an account may choose between.
 *
 * Scoped by `session.account.userId` in the WHERE clause -- not filtered in
 * application code after a broader read. A filter applied after the query is a
 * filter that a future `.map` can drop.
 */
export async function listProfilesForAccount(
  db: LibertyDatabase,
  session: LibertySession
): Promise<readonly ProfileRow[]> {
  return db
    .select()
    .from(profile)
    .where(and(eq(profile.userId, session.account.userId), isNull(profile.archivedAt)))
    // Ordered by creation then id: `createdAt` alone is not unique enough to be
    // a total order, and a picker whose tiles reshuffle between renders is a
    // determinism defect the user can actually see.
    .orderBy(asc(profile.createdAt), asc(profile.id));
}

export interface CreateProfileInput {
  readonly session: LibertySession;
  readonly profileId: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly maxRating: string | null;
  /** Explicit instant. Nothing in this package calls `new Date()` on its own behalf. */
  readonly instant: Date;
}

/**
 * Create a profile owned by the session's account.
 *
 * `userId` comes from the SESSION, never from the request body. A caller-
 * supplied owner is how one account creates a profile inside another's
 * household, and no amount of downstream checking recovers from having written
 * that row.
 */
export async function createProfile(
  db: LibertyDatabase,
  input: CreateProfileInput
): Promise<ProfileRow> {
  const rows = await db
    .insert(profile)
    .values({
      id: input.profileId,
      userId: input.session.account.userId,
      displayName: input.displayName,
      avatarKey: input.avatarKey,
      maxRating: input.maxRating,
      createdAt: input.instant,
      archivedAt: null
    })
    .returning();

  const row = rows[0];
  // `.returning()` on a successful single-row insert always yields one row; the
  // throw exists so the impossible case is loud rather than becoming an
  // `undefined` that travels.
  if (row === undefined) throw new Error("profile insert returned no row");
  return row;
}

/**
 * Record which profile this session is acting as.
 *
 * Writes to `active_profile_selection`, keyed by session -- the table that makes
 * "alongside the session, not inside the identity record" true rather than
 * aspirational. Selecting on the television does not move the phone, and
 * revoking the session deletes the selection by cascade.
 *
 * Takes a `ProfileScope`, so it can only be called after
 * `authorizeProfileSelection` has agreed.
 */
export async function selectActiveProfile(
  db: LibertyDatabase,
  input: {
    readonly session: LibertySession;
    readonly scope: ProfileScope;
    readonly instant: Date;
  }
): Promise<void> {
  await db
    .insert(activeProfileSelection)
    .values({
      sessionId: input.session.account.sessionId,
      profileId: input.scope.profileId,
      userId: input.session.account.userId,
      selectedAt: input.instant
    })
    .onConflictDoUpdate({
      target: activeProfileSelection.sessionId,
      set: { profileId: input.scope.profileId, selectedAt: input.instant }
    });
}

/**
 * Which profile, if any, this session selected.
 *
 * Returns `null` for "signed in, nothing chosen", which is a legitimate state
 * and the reason `LibertySession.activeProfileId` is nullable rather than
 * optional.
 */
export async function loadActiveProfileId(
  db: LibertyDatabase,
  sessionId: string
): Promise<string | null> {
  const rows = await db
    .select({ profileId: activeProfileSelection.profileId })
    .from(activeProfileSelection)
    .where(eq(activeProfileSelection.sessionId, sessionId))
    .limit(1);
  return rows[0]?.profileId ?? null;
}

/**
 * Archive a profile.
 *
 * Not a delete. Progress and watchlist rows cascade from `profile`, so deleting
 * would erase a household's history the moment somebody tidied up the picker,
 * and there is no undo for that. The WHERE clause re-asserts ownership even
 * though the scope already proved it -- defence in depth costs one predicate
 * and covers the case where a scope was obtained for a different purpose.
 */
export async function archiveProfile(
  db: LibertyDatabase,
  input: {
    readonly session: LibertySession;
    readonly scope: ProfileScope;
    readonly instant: Date;
  }
): Promise<void> {
  await db
    .update(profile)
    .set({ archivedAt: input.instant })
    .where(
      and(eq(profile.id, input.scope.profileId), eq(profile.userId, input.session.account.userId))
    );
}
