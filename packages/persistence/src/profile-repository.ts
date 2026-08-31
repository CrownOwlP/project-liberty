import type {
  AccountIdentity,
  LibertySession,
  ProfileOwnership,
  ProfileScope
} from "@liberty/auth";
import { scopeBelongsToSession } from "@liberty/auth";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { LibertyDatabase } from "./client";
import type { ProfileRow } from "./contracts";
import {
  type ProfileCreationRefusal,
  isMintedProfileId,
  resolveProfileCreation
} from "./profile-creation";
import { activeProfileSelection, profile } from "./schema";

/* -------------------------------------------------------------------------
 * Profiles: create, list, select, archive (PL-0402)
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
 *
 * THE BRAND IS NOT THE WHOLE CHECK, and the two places that would be wrong if it
 * were are marked below. A scope proves that SOME session was authorised for
 * this profile; it does not prove it was THIS one, because a scope is a plain
 * object that can outlive the request that earned it -- a cache, a closure, a
 * module-level variable. Every function here that takes both a session and a
 * scope calls `scopeBelongsToSession` before doing anything, which is the check
 * `session.ts` exists to offer and which nothing in this package was previously
 * calling.
 *
 * The pure rules -- how many profiles an account may have, and what a display
 * name may be -- live in `profile-creation.ts`, the same split
 * `progress-repository.ts` uses for `writer-epoch.ts`.
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
 * Mint a profile id.
 *
 * The ONLY producer, which is why `createProfile` no longer accepts one. A
 * caller-supplied id was the previous design and it left the most important
 * property of an identifier -- whether it is guessable -- undecided and
 * delegated to whichever call site was written first. `"1"`, `"2"`, `"3"` would
 * have satisfied every type in this package.
 *
 * `crypto.randomUUID()` is a v4 UUID from a cryptographic source: 122 random
 * bits, so there is nothing to enumerate. It is the same generator
 * `better-auth.ts` configures for the identity tables, deliberately -- one
 * generator across every table means an id's properties do not depend on which
 * table it came from.
 *
 * Not exported as the sole gate on WRITES only. `isMintedProfileId` lets the
 * READ side refuse a shape that could not have come from here, before a query is
 * issued; see `loadProfileOwnership`.
 */
export function newProfileId(): string {
  return crypto.randomUUID();
}

/**
 * Load the ownership record `authorizeProfileAccess` needs.
 *
 * Takes a raw id, and is the ONE function here that does, because it is the
 * lookup that happens BEFORE authorization -- it is what produces the input to
 * the decision. It returns ownership facts only: no display name, no avatar, no
 * rating ceiling. A lookup that returned the whole row would make it easy to
 * render a profile the caller has not been authorized for.
 *
 * An id that could not have been minted is refused as `null` WITHOUT a query.
 * That is not a security boundary on its own -- a well-formed id belonging to
 * another household still reaches the database and is then denied by
 * `authorizeProfileAccess` on ownership, which is where that denial belongs. It
 * is a cost boundary: a caller walking `/profiles/1`, `/profiles/2`, ... is
 * answered from a regex rather than from a connection, so the cheapest possible
 * probe is also the one that consumes nothing. `null` rather than a distinct
 * "malformed" result on purpose -- the caller's next step is
 * `authorizeProfileAccess`, whose `profile_not_found` already means "the id
 * names nothing", and a second vocabulary for the same conclusion is a second
 * thing for the edge to remember to collapse.
 */
export async function loadProfileOwnership(
  db: LibertyDatabase,
  profileId: string
): Promise<ProfileOwnership | null> {
  if (!isMintedProfileId(profileId)) return null;

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

/**
 * How many LIVE profiles this account has.
 *
 * `count()` in the statement rather than `listProfilesForAccount(...).length`,
 * because the caller is a ceiling check and pulling every row to measure a
 * number is the version of that check that gets slower as the thing it is
 * guarding against succeeds.
 *
 * Archived profiles are excluded, matching `listProfilesForAccount`. A household
 * that has tidied its picker would otherwise be permanently unable to add
 * anybody, with the reason pointing at profiles it can no longer see.
 */
export async function countLiveProfilesForAccount(
  db: LibertyDatabase,
  session: LibertySession
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(profile)
    .where(and(eq(profile.userId, session.account.userId), isNull(profile.archivedAt)));
  return rows[0]?.value ?? 0;
}

export interface CreateProfileInput {
  readonly session: LibertySession;
  /** Raw, as submitted. Normalisation and refusal are `resolveProfileCreation`'s job, not the caller's. */
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly maxRating: string | null;
  /** Explicit instant. Nothing in this package calls `new Date()` on its own behalf. */
  readonly instant: Date;
}

/** A created profile, or the reasoned refusal that stopped it. */
export type ProfileCreation = { readonly ok: true; readonly profile: ProfileRow } | ProfileCreationRefusal;

/**
 * Create a profile owned by the session's account.
 *
 * `userId` comes from the SESSION, never from the request body. A caller-
 * supplied owner is how one account creates a profile inside another's
 * household, and no amount of downstream checking recovers from having written
 * that row. The id comes from `newProfileId`, for the same reason applied to a
 * different field.
 *
 * THE CEILING CHECK IS READ-THEN-WRITE, AND THAT IS STATED RATHER THAN HIDDEN.
 * Two creates arriving concurrently can both read a count of four and both
 * insert, so a determined caller can exceed `MAX_PROFILES_PER_ACCOUNT` by up to
 * the number of requests it can get in flight at once. That is a bound of a
 * different kind -- bounded by concurrency instead of by the constant -- and it
 * is enormously better than the unbounded growth it replaces, but it is not the
 * constant. Closing it properly needs the database to hold the rule, and
 * PostgreSQL cannot express "at most five rows per user_id" as a constraint: it
 * takes a trigger, or a per-account slot table with a CHECK on the slot number.
 * Neither is written here, because both are schema decisions that cannot be
 * verified without applying the migration, and nothing in this lane has been
 * applied to a database yet -- a trigger written blind is a trigger nobody has
 * seen refuse anything. This paragraph is the record of that gap; it belongs in
 * `docs/DATA_MODEL.md` under "Unverified" too, and that file is outside this
 * task's `allowedPaths`.
 */
export async function createProfile(
  db: LibertyDatabase,
  input: CreateProfileInput
): Promise<ProfileCreation> {
  const existingProfileCount = await countLiveProfilesForAccount(db, input.session);

  const resolution = resolveProfileCreation({
    existingProfileCount,
    displayName: input.displayName,
    avatarKey: input.avatarKey,
    maxRating: input.maxRating
  });
  if (!resolution.ok) return resolution;

  const rows = await db
    .insert(profile)
    .values({
      id: newProfileId(),
      userId: input.session.account.userId,
      // The NORMALISED values, not the submitted ones. Writing `input.displayName`
      // here would make the resolver an opinion the statement ignores -- and the
      // uniqueness constraint on (user_id, display_name) only means what its
      // comment claims if the column holds the canonical spelling.
      displayName: resolution.displayName,
      avatarKey: resolution.avatarKey,
      maxRating: resolution.maxRating,
      createdAt: input.instant,
      archivedAt: null
    })
    .returning();

  const row = rows[0];
  // `.returning()` on a successful single-row insert always yields one row; the
  // throw exists so the impossible case is loud rather than becoming an
  // `undefined` that travels.
  if (row === undefined) throw new Error("profile insert returned no row");
  return { ok: true, profile: row };
}

/**
 * What a profile-scoped write refuses before it reaches the database.
 *
 * Its own union rather than a member of the outcome types below, for the reason
 * `WatchlistFailure` is separate from `WatchlistMutationResolution`: "that scope
 * was not granted to this session" is a statement about the REQUEST, and
 * "nothing matched" is a statement about the data. Folding them together lets a
 * caller pattern-matching on outcomes treat a leaked capability as an ordinary
 * miss.
 */
export type ScopeMismatch = {
  readonly ok: false;
  readonly reason: "scope_not_granted_to_this_session";
  readonly detail: string;
};

/**
 * The check every function taking both a session and a scope runs first.
 *
 * The brand proves an authorization decision happened. It does not carry WHICH
 * session that decision was made for -- `grantedFor` does, and comparing it is
 * the only thing that makes a scope non-transferable. Without this, a scope
 * cached against the wrong key, or captured in a closure that outlived its
 * request, is a working capability for another account's profile.
 */
function refuseForeignScope(session: LibertySession, scope: ProfileScope): ScopeMismatch | null {
  if (scopeBelongsToSession(scope, session)) return null;
  return {
    ok: false,
    reason: "scope_not_granted_to_this_session",
    // The profile id is named and the two ACCOUNT ids are not. This is the
    // sharpest finding in the file -- a scope crossing a session boundary is
    // never a UI mistake -- and it has to be investigable, but a detail that
    // printed both user ids would put one account's identifier into the other
    // account's error surface, which is the leak in miniature.
    detail: `the scope for profile ${scope.profileId} was granted to a different account than this session's`
  };
}

/** Recording a selection succeeded, or was refused. */
export type ProfileSelection = { readonly ok: true; readonly profileId: string } | ScopeMismatch;

/**
 * Record which profile this session is acting as.
 *
 * Writes to `active_profile_selection`, keyed by session -- the table that makes
 * "alongside the session, not inside the identity record" true rather than
 * aspirational. Selecting on the television does not move the phone, and
 * revoking the session deletes the selection by cascade.
 *
 * Takes a `ProfileScope`, so it can only be called after
 * `authorizeProfileSelection` has agreed -- and checks that the scope was
 * granted to THIS session, because the composite foreign key to
 * `profile (id, user_id)` is the only other thing standing between a leaked
 * scope and a selection row pointing into another household. That constraint
 * would catch it, as a driver exception at an unattributable stack depth; this
 * catches it with a reason.
 */
export async function selectActiveProfile(
  db: LibertyDatabase,
  input: {
    readonly session: LibertySession;
    readonly scope: ProfileScope;
    readonly instant: Date;
  }
): Promise<ProfileSelection> {
  const mismatch = refuseForeignScope(input.session, input.scope);
  if (mismatch !== null) return mismatch;

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

  return { ok: true, profileId: input.scope.profileId };
}

/**
 * Which profile, if any, this session selected.
 *
 * Returns `null` for "signed in, nothing chosen", which is a legitimate state
 * and the reason `LibertySession.activeProfileId` is nullable rather than
 * optional.
 *
 * SCOPED BY SESSION *AND* ACCOUNT, though the session id alone is already
 * unique. The predicate on `user_id` is free -- the row carries it -- and it
 * means the selection returned is one this account made even if a session id
 * ever arrives from somewhere it should not have. Defence in depth is only worth
 * having where it costs nothing, and here it costs one `AND`.
 */
export async function loadActiveProfileId(
  db: LibertyDatabase,
  account: AccountIdentity
): Promise<string | null> {
  const rows = await db
    .select({ profileId: activeProfileSelection.profileId })
    .from(activeProfileSelection)
    .where(
      and(
        eq(activeProfileSelection.sessionId, account.sessionId),
        eq(activeProfileSelection.userId, account.userId)
      )
    )
    .limit(1);
  return rows[0]?.profileId ?? null;
}

/**
 * Build the `LibertySession` every authorization decision is made against.
 *
 * THE ONE BLESSED CONSTRUCTOR, and the reason it exists is the shape of the
 * type rather than any difficulty in the work. `LibertySession` is a plain
 * interface: a route handler can write
 * `{ account, activeProfileId: request.headers.get("x-profile") }` and every
 * type in this repository will accept it, `authorizeProfileAccess` will compare
 * the requested profile against a value the CLIENT chose, and the whole
 * arrangement -- the brand, the ownership check, the composite foreign key --
 * is bypassed by an object literal. Nothing in the type system can prevent that;
 * a function that does it correctly, and is the only thing any handler needs to
 * call, is what makes writing the literal a conspicuous choice instead of the
 * obvious one.
 *
 * `account` comes from the auth library's verified session. `activeProfileId`
 * comes from `active_profile_selection`, which is server-side state written only
 * by `selectActiveProfile` and whose composite foreign key to
 * `profile (id, user_id)` means the row cannot name a profile this account does
 * not own. There is no third source, and in particular there is no parameter
 * here through which a caller could supply one -- the same absence
 * `ProgressWrite` maintains for client-asserted timestamps.
 */
export async function resolveLibertySession(
  db: LibertyDatabase,
  account: AccountIdentity
): Promise<LibertySession> {
  return { account, activeProfileId: await loadActiveProfileId(db, account) };
}

/**
 * Archiving a profile that no live profile matched.
 *
 * ONE reason for two situations -- the scope names a profile this account does
 * not own, or it names one that is already archived -- because the statement
 * genuinely cannot tell them apart and a second read to find out would be a
 * distinction invented after the fact. Naming it `no_live_profile_for_scope`
 * rather than picking the more dramatic of the two is the honest version: a
 * reason code that asserts more than the query proved is worse than a vague one,
 * because somebody will act on it.
 */
export type ProfileArchive =
  | { readonly ok: true; readonly profileId: string; readonly archivedAt: Date }
  | { readonly ok: false; readonly reason: "no_live_profile_for_scope"; readonly detail: string }
  | ScopeMismatch;

/**
 * Archive a profile.
 *
 * Not a delete. Progress and watchlist rows cascade from `profile`, so deleting
 * would erase a household's history the moment somebody tidied up the picker,
 * and there is no undo for that. The WHERE clause re-asserts ownership even
 * though the scope already proved it -- defence in depth costs one predicate
 * and covers the case where a scope was obtained for a different purpose.
 *
 * IT NO LONGER RETURNS `void`, and that was the defect. Defence in depth that
 * fails SILENTLY is worse than none: the extra predicate matched nothing, the
 * `UPDATE` affected zero rows, and the caller was told the archive succeeded.
 * A household would have seen the profile still on the picker after being told
 * it was removed, and no log anywhere would have said why.
 *
 * `isNull(archivedAt)` is in the predicate so re-archiving is a no-op rather
 * than a rewrite: without it, a retried request moves `archived_at` forward and
 * the record of when the profile actually left the picker is lost.
 */
export async function archiveProfile(
  db: LibertyDatabase,
  input: {
    readonly session: LibertySession;
    readonly scope: ProfileScope;
    readonly instant: Date;
  }
): Promise<ProfileArchive> {
  const mismatch = refuseForeignScope(input.session, input.scope);
  if (mismatch !== null) return mismatch;

  const archived = await db
    .update(profile)
    .set({ archivedAt: input.instant })
    .where(
      and(
        eq(profile.id, input.scope.profileId),
        eq(profile.userId, input.session.account.userId),
        isNull(profile.archivedAt)
      )
    )
    .returning({ id: profile.id });

  const row = archived[0];
  if (row === undefined) {
    return {
      ok: false,
      reason: "no_live_profile_for_scope",
      detail: `no live profile ${input.scope.profileId} is owned by this account; it is already archived, or the scope does not name a profile of this account`
    };
  }

  // Every session still pointed at this profile is released, AFTER the archive
  // and not before.
  //
  // WHY IT HAPPENS AT ALL. `active_profile_selection` cascades on DELETE, and
  // archiving is not a delete, so without this the television is left with an
  // `activeProfileId` naming an archived profile. `authorizeProfileAccess` denies
  // that with `profile_archived`, so nothing unsafe happens -- but the session is
  // stuck: it has a selection, so it is not shown the picker, and every request
  // it makes is denied. Clearing the selection returns it to
  // `no_active_profile_selected`, which IS the picker.
  //
  // WHY THE ORDER IS SAFE WITHOUT A TRANSACTION. These are two statements and
  // the process can die between them. The surviving state is then "archived, but
  // the selection row remains", which is exactly the state the previous code
  // always produced and which authorization already refuses. The reverse order
  // would leave "selection cleared, profile still live" -- a household signed out
  // of a profile that still exists, for no reason it could discover.
  await db
    .delete(activeProfileSelection)
    .where(
      and(
        eq(activeProfileSelection.profileId, input.scope.profileId),
        eq(activeProfileSelection.userId, input.session.account.userId)
      )
    );

  return { ok: true, profileId: row.id, archivedAt: input.instant };
}
