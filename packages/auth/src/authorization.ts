import type { LibertySession, ProfileOwnership, ProfileScope } from "./session";

/* -------------------------------------------------------------------------
 * Profile authorization (PL-0402)
 *
 * The single gate between "this request is authenticated" and "this request may
 * touch this profile's viewing history". Every progress and watchlist row is
 * scoped to a `profileId`, so this is the function that decides whether a
 * `profileId` may be used at all -- and it is the ONLY producer of the
 * `ProfileScope` those repositories require.
 *
 * PURE. No clock, no I/O, no ambient state. The caller loads the ownership
 * record and hands it in. That is what makes an authorization test possible
 * without a database, and it is the same discipline `@liberty/media-engine`
 * applies to ranking: the decision is a function of stated facts.
 *
 * A REASON IS PRODUCED ON BOTH BRANCHES. A denial with no reason and a grant
 * with no reason are the same defect -- an unexplainable decision surface. A
 * support engineer asking "why did the kids profile stop resuming" needs
 * `requested_profile_is_not_active` and `profile_archived` to be different
 * answers, because the remedies are different and only one of them is a bug.
 * ---------------------------------------------------------------------- */

/**
 * The only place in the repository that produces a `ProfileScope`.
 *
 * NOT exported, and deliberately not defined in `session.ts`: `index.ts`
 * re-exports everything `session.ts` exports, so a mint function living there
 * would escape the package and the brand would protect nothing. Kept
 * module-private here, the single `as ProfileScope` cast in the codebase sits
 * next to the decision that justifies it.
 */
function mintProfileScope(profileId: string, grantedFor: string): ProfileScope {
  return { profileId, grantedFor } as ProfileScope;
}

/**
 * Every conclusion this function can reach, granting or denying.
 *
 * Flat rather than nested so that a reason code can be logged, counted and
 * alerted on as a single dimension.
 */
export type ProfileAccessReason =
  /** GRANT. The requested profile is the one selected for this session, and this account owns it. */
  | "active_profile_of_session"
  /** Signed in, but no profile chosen yet. Not an error -- this is the profile picker's state. */
  | "no_active_profile_selected"
  /** The ownership record was not supplied. Either the id is invented or the profile was deleted. */
  | "profile_not_found"
  /**
   * The profile exists and belongs to a DIFFERENT account. The sharpest denial
   * here, and the one worth alerting on: an authenticated user naming another
   * household's profile id is not a mistake the UI can make.
   */
  | "profile_not_owned_by_account"
  /** Owned, but archived. Kept distinct from `profile_not_found` because the data still exists. */
  | "profile_archived"
  /**
   * Owned and live, but not the profile this session selected. Distinct from
   * `profile_not_owned_by_account` because this one IS reachable through the UI
   * -- a stale tab after a profile switch -- and the remedy is re-selection,
   * not a security investigation.
   */
  | "requested_profile_is_not_active";

/** One check that ran, and what it concluded. Ordered; see `PROFILE_ACCESS_CHECK_ORDER`. */
export interface ProfileAccessCheck {
  readonly check: ProfileAccessReason;
  readonly passed: boolean;
}

export type ProfileAccessDecision =
  | {
      readonly allowed: true;
      readonly reason: "active_profile_of_session";
      readonly scope: ProfileScope;
      readonly trail: readonly ProfileAccessCheck[];
    }
  | {
      readonly allowed: false;
      readonly reason: Exclude<ProfileAccessReason, "active_profile_of_session">;
      readonly trail: readonly ProfileAccessCheck[];
    };

/**
 * The order the checks run in, which is also their PRECEDENCE.
 *
 * Exported because it is a tested guarantee, not an implementation detail. Two
 * failures can be true at once -- an archived profile belonging to somebody else
 * -- and which one is reported must not depend on how the function happens to be
 * written. Ownership is checked before liveness deliberately: "not yours" is the
 * more serious finding and must not be masked by "also archived".
 */
export const PROFILE_ACCESS_CHECK_ORDER = [
  "no_active_profile_selected",
  "profile_not_found",
  "profile_not_owned_by_account",
  "profile_archived",
  "requested_profile_is_not_active"
] as const satisfies readonly Exclude<ProfileAccessReason, "active_profile_of_session">[];

export interface ProfileAccessRequest {
  readonly session: LibertySession;
  /**
   * The profile the caller wants to act as.
   *
   * Explicit rather than defaulted to `session.activeProfileId`, because a
   * request that names a profile is exactly the request worth authorizing. A
   * default would turn every mismatch into a silent success against whichever
   * profile happened to be active.
   */
  readonly requestedProfileId: string;
  /**
   * The stored ownership record for `requestedProfileId`, or `null` if there is
   * none. The caller performs this lookup; this function does no I/O.
   */
  readonly ownership: ProfileOwnership | null;
}

/**
 * Decide whether a session may act as a profile, and if so mint the scope that
 * unlocks the profile-scoped repositories.
 */
export function authorizeProfileAccess(request: ProfileAccessRequest): ProfileAccessDecision {
  const { session, requestedProfileId, ownership } = request;
  const trail: ProfileAccessCheck[] = [];

  const deny = (
    reason: Exclude<ProfileAccessReason, "active_profile_of_session">
  ): ProfileAccessDecision => {
    trail.push({ check: reason, passed: false });
    return { allowed: false, reason, trail };
  };
  const pass = (check: Exclude<ProfileAccessReason, "active_profile_of_session">): void => {
    trail.push({ check, passed: true });
  };

  if (session.activeProfileId === null) return deny("no_active_profile_selected");
  pass("no_active_profile_selected");

  if (ownership === null) return deny("profile_not_found");
  pass("profile_not_found");

  if (ownership.ownerUserId !== session.account.userId) return deny("profile_not_owned_by_account");
  pass("profile_not_owned_by_account");

  if (ownership.archivedAt !== null) return deny("profile_archived");
  pass("profile_archived");

  // Checked last because it is the weakest claim: by this point the profile is
  // known to exist, to be ours and to be live, so the only remaining objection
  // is that this session is pointed somewhere else.
  if (ownership.profileId !== session.activeProfileId) return deny("requested_profile_is_not_active");
  if (requestedProfileId !== session.activeProfileId) return deny("requested_profile_is_not_active");
  pass("requested_profile_is_not_active");

  return {
    allowed: true,
    reason: "active_profile_of_session",
    scope: mintProfileScope(requestedProfileId, session.account.userId),
    trail
  };
}

/**
 * Whether a profile may be SELECTED by this session -- the profile-picker
 * decision, which necessarily runs before any profile is active.
 *
 * Separate from `authorizeProfileAccess` rather than a flag on it, because the
 * two differ on the one check that matters: selection cannot require the
 * profile to already be active without making selection impossible.
 */
export function authorizeProfileSelection(input: {
  readonly session: LibertySession;
  readonly ownership: ProfileOwnership | null;
}): ProfileAccessDecision {
  const trail: ProfileAccessCheck[] = [];

  if (input.ownership === null) {
    trail.push({ check: "profile_not_found", passed: false });
    return { allowed: false, reason: "profile_not_found", trail };
  }
  trail.push({ check: "profile_not_found", passed: true });

  if (input.ownership.ownerUserId !== input.session.account.userId) {
    trail.push({ check: "profile_not_owned_by_account", passed: false });
    return { allowed: false, reason: "profile_not_owned_by_account", trail };
  }
  trail.push({ check: "profile_not_owned_by_account", passed: true });

  if (input.ownership.archivedAt !== null) {
    trail.push({ check: "profile_archived", passed: false });
    return { allowed: false, reason: "profile_archived", trail };
  }
  trail.push({ check: "profile_archived", passed: true });

  return {
    allowed: true,
    reason: "active_profile_of_session",
    scope: mintProfileScope(input.ownership.profileId, input.session.account.userId),
    trail
  };
}
