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
  /**
   * GRANT. The profile is owned by this account and is live, so this session may
   * SELECT it -- which is a different claim from the one above and used to be
   * spelled the same way.
   *
   * THE DEFECT THIS FIXES. `authorizeProfileSelection` granted with
   * `active_profile_of_session`, on the one path in the package where, by
   * construction, no profile is active: selection is what a session does BEFORE
   * it has one. It type-checked because that was the only grant reason the union
   * offered, which is exactly how a vocabulary becomes wrong -- the compiler
   * cannot object to a string that is merely false. The cost was not structural:
   * it is the string a support engineer reads while asking why a session that
   * had selected nothing was recorded as acting on its active profile, and every
   * count and alert built on the reason code conflated two decisions with
   * different preconditions.
   *
   * Fixed in the VOCABULARY rather than at the call site, because the call site
   * was correct: it really does grant, and the grant really is not the same one.
   */
  | "selectable_profile_of_account"
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

/**
 * The reasons that GRANT. Everything else in `ProfileAccessReason` denies.
 *
 * A named list rather than the hand-maintained
 * `Exclude<ProfileAccessReason, "active_profile_of_session">` that was written
 * out at five separate use sites. That spelling encodes "there is exactly one
 * grant reason" five times, so adding the second one reclassified it as a
 * DENIAL everywhere at once -- and the loudest consequence was
 * `externalProfileAccessReason` failing exhaustiveness and asking to be told
 * what a GRANT reason should look like on the way out to a caller, which is a
 * question with no correct answer. A compile error is the good outcome here;
 * the point of the list is that the classification is stated once and cannot be
 * updated in four places out of five.
 */
export const PROFILE_ACCESS_GRANT_REASONS = [
  "active_profile_of_session",
  "selectable_profile_of_account"
] as const;

export type ProfileAccessGrantReason = (typeof PROFILE_ACCESS_GRANT_REASONS)[number];

/** Every reason that refuses. The complement of the list above, derived rather than restated. */
export type ProfileAccessDenialReason = Exclude<ProfileAccessReason, ProfileAccessGrantReason>;

/** One check that ran, and what it concluded. Ordered; see `PROFILE_ACCESS_CHECK_ORDER`. */
export interface ProfileAccessCheck {
  readonly check: ProfileAccessReason;
  readonly passed: boolean;
}

/**
 * A grant, parameterised by WHICH grant it is.
 *
 * The parameter exists so that each decision function can keep saying exactly
 * what it can conclude -- `authorizeProfileAccess` can only ever reach
 * `active_profile_of_session`, and a caller should not have to handle a reason
 * it cannot receive. Widening both functions to the full union would have been
 * the cheaper edit and would have thrown away the precision the old, wrong,
 * single-literal type accidentally had.
 */
export interface ProfileAccessGrant<
  Reason extends ProfileAccessGrantReason = ProfileAccessGrantReason
> {
  readonly allowed: true;
  readonly reason: Reason;
  readonly scope: ProfileScope;
  readonly trail: readonly ProfileAccessCheck[];
}

/** A denial. Not parameterised: both functions can reach several of these. */
export interface ProfileAccessDenial {
  readonly allowed: false;
  readonly reason: ProfileAccessDenialReason;
  readonly trail: readonly ProfileAccessCheck[];
}

export type ProfileAccessDecision<
  Reason extends ProfileAccessGrantReason = ProfileAccessGrantReason
> = ProfileAccessGrant<Reason> | ProfileAccessDenial;

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
] as const satisfies readonly ProfileAccessDenialReason[];

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
export function authorizeProfileAccess(
  request: ProfileAccessRequest
): ProfileAccessDecision<"active_profile_of_session"> {
  const { session, requestedProfileId, ownership } = request;
  const trail: ProfileAccessCheck[] = [];

  const deny = (reason: ProfileAccessDenialReason): ProfileAccessDenial => {
    trail.push({ check: reason, passed: false });
    return { allowed: false, reason, trail };
  };
  const pass = (check: ProfileAccessDenialReason): void => {
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
 * The reason vocabulary that is allowed to LEAVE the server.
 *
 * `ProfileAccessReason` is the internal one and stays as sharp as it is: a
 * support engineer and an alerting rule both need `profile_not_found` and
 * `profile_not_owned_by_account` to be different findings, because only the
 * second is somebody probing another household. Sending that distinction to the
 * caller, however, hands an authenticated attacker an ORACLE -- ask about an id,
 * and the answer tells you whether a profile with that id exists anywhere in the
 * product. Iterate, and you have enumerated the profile table.
 *
 * BOTH LEAKS ARE REAL AND THIS PROJECT PREFERS THE FIRST. The two available
 * failures are (a) the caller cannot tell "no such profile" from "not yours",
 * which costs a user with a genuinely stale link a slightly vaguer message, and
 * (b) the caller CAN tell, which costs every household a way to discover that
 * other households' profiles exist. (a) degrades one error message; (b) is a
 * confidentiality boundary, and it is the one that cannot be undone once a
 * scraper has run. So the two collapse to `profile_unavailable` on the way out.
 *
 * The other three do NOT collapse, and the rule is what they reveal rather than
 * how serious they sound: `profile_archived` and `requested_profile_is_not_active`
 * are only ever reached for a profile this account already owns, and
 * `no_active_profile_selected` is a fact about this session. None of them says
 * anything about a profile the caller does not already have. Flattening those
 * into `profile_unavailable` too would buy nothing and would make the profile
 * picker -- which needs `no_active_profile_selected` specifically -- unbuildable.
 *
 * ENFORCEMENT IS AT THE EDGE, NOT HERE. `ProfileAccessDecision.trail` still
 * carries every internal reason; it is a server-side artefact for logs. Any
 * layer that serialises a denial into a response body must map it through this
 * function, and `PL-0501`'s reason-carrying discriminated union is exactly the
 * shape where forgetting to would be invisible.
 */
export type ExternalProfileAccessReason =
  | "no_active_profile_selected"
  | "profile_unavailable"
  | "profile_archived"
  | "requested_profile_is_not_active";

/**
 * Narrow an internal denial to what may be told to the caller.
 *
 * A total `switch` with no `default`, deliberately: adding a member to
 * `ProfileAccessReason` then fails to compile here rather than falling through
 * to a catch-all that would leak the new reason verbatim. A `default` branch is
 * the version of this function that is wrong the first time somebody extends the
 * union.
 */
export function externalProfileAccessReason(
  reason: ProfileAccessDenialReason
): ExternalProfileAccessReason {
  switch (reason) {
    case "profile_not_found":
    case "profile_not_owned_by_account":
      return "profile_unavailable";
    case "no_active_profile_selected":
    case "profile_archived":
    case "requested_profile_is_not_active":
      return reason;
  }
}

/**
 * Whether a profile may be SELECTED by this session -- the profile-picker
 * decision, which necessarily runs before any profile is active.
 *
 * Separate from `authorizeProfileAccess` rather than a flag on it, because the
 * two differ on the one check that matters: selection cannot require the
 * profile to already be active without making selection impossible.
 *
 * Its grant is `selectable_profile_of_account`, and the return type says so.
 * That reason exists because this function used to grant with
 * `active_profile_of_session` on a path where nothing is active; see the union
 * member's own comment for why the fix belonged there rather than here.
 */
export function authorizeProfileSelection(input: {
  readonly session: LibertySession;
  readonly ownership: ProfileOwnership | null;
}): ProfileAccessDecision<"selectable_profile_of_account"> {
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
    reason: "selectable_profile_of_account",
    scope: mintProfileScope(input.ownership.profileId, input.session.account.userId),
    trail
  };
}
