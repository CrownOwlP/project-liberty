/* -------------------------------------------------------------------------
 * The session, and the profile that is carried NEXT TO it
 *
 * `docs/RESEARCH_IDENTITY.md` (PL-0402) rules that profiles live ABOVE auth.
 * Auth answers exactly one question -- "which account is this" -- and a viewer
 * profile is a product concept layered on top of that answer. This module is
 * where the two are held together without either one absorbing the other.
 *
 * WHY `activeProfileId` IS NOT A FIELD ON THE USER. A profile selection is a
 * property of THIS browser on THIS device, not of the account. Modelled as a
 * column on the identity record, selecting "Kids" on the television would
 * silently reselect it on the phone mid-episode, and revoking a session would
 * leave the selection behind as state nobody owns. Carried alongside the
 * session, it is created when a profile is chosen and destroyed when the
 * session is, which is both the correct lifetime and the smaller amount of
 * retained personal data.
 *
 * WHY NOT INSIDE BETTER AUTH AS AN ADDITIONAL SESSION FIELD. That would work
 * mechanically, and it is the reason this comment exists: the cost is that the
 * profile concept becomes a thing the vendor library owns, and swapping the
 * library -- the entire justification for the `packages/auth` seam -- would then
 * mean migrating product data rather than replacing an adapter.
 * ---------------------------------------------------------------------- */

/**
 * A brand nobody outside this module can produce.
 *
 * `unique symbol` is deliberately NOT exported: TypeScript will not let a caller
 * name it, so `{ profileId: "..." } as ProfileScope` is the only forgery
 * available and it requires an explicit cast that a reviewer can grep for. The
 * point is that every profile-scoped repository takes a `ProfileScope` rather
 * than a `string`, so "did anyone check this profile belongs to this account"
 * is answered by the type system at every call site instead of by discipline.
 */
declare const profileScopeBrand: unique symbol;

/**
 * Proof that an authorization decision granted access to one specific profile.
 *
 * Minted only by `authorizeProfileAccess`. Carrying `grantedFor` -- the account
 * the grant was made for -- means a scope that leaked across a request boundary
 * can still be checked against the session it is being used under, rather than
 * being an unattributable bearer token inside the process.
 */
export interface ProfileScope {
  readonly profileId: string;
  readonly grantedFor: string;
  readonly [profileScopeBrand]: true;
}

/** Who the account is. This, and nothing else, is what authentication produces. */
export interface AccountIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * An authenticated request's full identity context.
 *
 * `activeProfileId` is `null` rather than absent when no profile has been
 * chosen, because "signed in, no profile selected yet" is a real and common
 * state -- it is the profile picker -- and an optional property invites callers
 * to forget it exists.
 */
export interface LibertySession {
  readonly account: AccountIdentity;
  readonly activeProfileId: string | null;
}

/**
 * A profile as the authorization decision needs to see it.
 *
 * Deliberately NOT the profile row. Authorization needs ownership and liveness
 * and nothing else, so the display name, avatar and preferences never reach
 * this package -- which is both data minimisation and the reason
 * `@liberty/auth` has no dependency on `@liberty/persistence`.
 */
export interface ProfileOwnership {
  readonly profileId: string;
  readonly ownerUserId: string;
  /** Set when the profile has been archived. Archived profiles are readable history, not usable identities. */
  readonly archivedAt: string | null;
}

/**
 * Whether a scope was granted for the account making this request.
 *
 * Cheap, and worth calling in any layer that receives a scope it did not itself
 * obtain. A scope is not a capability that should survive a change of session.
 */
export function scopeBelongsToSession(scope: ProfileScope, session: LibertySession): boolean {
  return scope.grantedFor === session.account.userId;
}
