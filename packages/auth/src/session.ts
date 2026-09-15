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

import type { ProfileScope } from "./profile-scope";
import { isIssuedProfileScope } from "./profile-scope";

/* -------------------------------------------------------------------------
 * `ProfileScope` USED TO BE DEFINED HERE, and the brand it carried was a
 * `declare const ... : unique symbol` -- a phantom that existed in the type
 * system and nowhere at runtime. The comment above it claimed an explicit cast
 * was the only available forgery. It was not: a spread copy with a replaced
 * `profileId` type-checked with no cast at all. PL-0405 moved the type to
 * `./profile-scope`, where the brand is a real `Symbol`, every issued scope is
 * frozen and recorded in a `WeakSet`, and the consumer's first action is an
 * identity check. Read that module's header for the whole argument, including
 * what it does NOT yet close.
 * ---------------------------------------------------------------------- */

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
 *
 * ISSUANCE IS CHECKED FIRST, AND A VALUE THAT WAS NOT ISSUED ANSWERS `false`.
 * This function used to compare `grantedFor` and nothing else, which meant a
 * forged scope -- a spread copy with a replaced `profileId`, whose `grantedFor`
 * is therefore still genuine -- passed it. That is the exact shape of the
 * PL-0405 bypass: the field this function reads is the one field the forger has
 * no reason to change. It returns `false` rather than throwing because its
 * contract is a boolean question asked by callers that already have a denial
 * path; `profileIdFromScope` is the throwing accessor for callers that need the
 * id itself.
 */
export function scopeBelongsToSession(scope: ProfileScope, session: LibertySession): boolean {
  if (!isIssuedProfileScope(scope)) return false;
  return scope.grantedFor === session.account.userId;
}
