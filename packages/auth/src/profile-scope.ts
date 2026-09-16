/* -------------------------------------------------------------------------
 * `ProfileScope`: proof that an authorization decision ISSUED this exact value
 * (PL-0405, correcting PL-0401)
 *
 * WHAT WAS WRONG, STATED PLAINLY. The scope used to be a `declare const
 * profileScopeBrand: unique symbol` -- a brand that exists in the type system
 * and nowhere at runtime -- and `mintProfileScope` returned an ordinary object
 * literal through `as ProfileScope`. `session.ts` claimed that
 * `{ profileId: "..." } as ProfileScope` was "the only forgery available and it
 * requires an explicit cast that a reviewer can grep for". That claim was false.
 * A holder of a genuine scope could write
 *
 *     const forged = { ...realScope, profileId: someoneElsesProfileId };
 *
 * and TypeScript carried the branded structural type straight through with NO
 * cast at all, because a spread copies every property the type declares --
 * including a brand the runtime never wrote. `@liberty/persistence` then read
 * `scope.profileId` into its `WHERE profile_id = $1` predicates. That is not a
 * typing nicety. It is a cross-profile data-access bypass: one household member
 * holding a legitimate scope could read and write another profile's viewing
 * history.
 *
 * It is also the PL-0706 defect in a second place, and the correction is the
 * same one `ClassifiedRuntime` in `packages/contracts/src/shared/runtime.ts` and
 * `PinnedTarget` in `packages/media-inspection` already carry.
 *
 * THE TYPE SYSTEM CANNOT FIX THIS, AND THAT IS WHY THE REGISTRY IS NOT OPTIONAL.
 * The reviewer's minimum was "make the scope genuinely nominal so a spread copy
 * cannot remain assignable". There is no such construction. A spread copies a
 * branded property along with everything else and type-checks; a `private`
 * class field is compared nominally at compile time and is an ordinary property
 * at runtime, so a spread of a real instance passes every check the class can
 * perform on itself. Only OBJECT IDENTITY distinguishes a copy from the value
 * that was issued, and object identity is a runtime fact. So the registry below
 * is the only mechanism that works, not an upper tier above a cheaper one.
 *
 * FOUR MECHANISMS:
 *
 *   1. A BRAND THAT CANNOT BE WRITTEN DOWN. `profileScopeBrand` is a
 *      module-private `unique symbol` -- a real `Symbol()`, not a `declare`d
 *      phantom. It is never exported, so no other module can NAME the key, and
 *      an object literal that omits it is not a `ProfileScope`. This is the
 *      compile-time half, and on its own it stops exactly one thing: a literal
 *      written from nothing without a cast.
 *
 *   2. A REGISTRY OF THE VALUES THIS MODULE ACTUALLY ISSUED. Every scope
 *      `issueProfileScope` produces is recorded in a `WeakSet` only this module
 *      can add to. `isIssuedProfileScope` answers from it. The key is object
 *      IDENTITY, which is precisely the thing a spread copy, a cast literal and
 *      a hand-built look-alike all lack. Weak so that a registry of scopes never
 *      keeps a scope alive.
 *
 *   3. EVERY ISSUED SCOPE IS FROZEN. `readonly` is erased at runtime, so without
 *      this a holder of a genuine, registered scope could simply assign
 *      `scope.profileId = someoneElsesId` and keep the object's identity --
 *      defeating the registry without copying anything. In a module (always
 *      strict) the attempted write throws rather than failing silently.
 *
 *   5. THE PAYLOAD IS NOT ON THE PUBLIC TYPE AT ALL (round 43). `profileId`
 *      and `grantedFor` are declared on a MODULE-PRIVATE `IssuedProfileScope`,
 *      not on the exported `ProfileScope`, so `scope.profileId` outside this
 *      module is a COMPILE ERROR rather than a deprecation warning. This is
 *      strictly stronger than the accessor alone, and it was not available in
 *      round 42: `apps/web/src/lib/db/in-memory-repository.ts` was then reading
 *      the field in fourteen places and outside the write surface, so removing
 *      the property would have failed `typecheck`. That adapter now asks, so
 *      the property came off.
 *
 *      WHAT IT DOES AND DOES NOT BUY, because the difference matters and the
 *      honest version is smaller than the tempting one. It makes an UNCHECKED
 *      READ impossible to write. It does NOT make the spread forgery
 *      impossible: the object literal form `{ ...real, profileId: victim }` is
 *      now rejected by excess-property checking, but
 *      `Object.assign({}, real, { profileId: victim })` produces
 *      `ProfileScope & { profileId: string }` and is assignable to
 *      `ProfileScope` WITH NO CAST ANYWHERE. `profile-scope.test.ts` uses that
 *      second form deliberately, so the suite keeps attempting a cast-free
 *      forgery. The registry is still the only thing that rejects it, and this
 *      mechanism is about what an honest consumer can accidentally write, not
 *      about what a forger can construct.
 *
 *   4. THE IDENTITY CHECK IS THE CONSUMER'S FIRST ACTION, and it is not
 *      optional-looking. `profileIdFromScope` is the supported way to obtain the
 *      id a data predicate is built from: it consults the registry BEFORE it
 *      reads `profileId`, and throws `ForgedProfileScopeError` when the value
 *      was not issued here. A consumer that calls it cannot accidentally skip
 *      the check, because the check and the read are the same expression.
 *
 * EVERY CONSUMER ASKS, AND THAT IS NOW TRUE OF ALL THREE (round 43).
 * `@liberty/persistence` was converted in round 42 after its write surface was
 * widened: every exported function in `progress-repository.ts`,
 * `watchlist-repository.ts` and `profile-repository.ts` obtains the id through
 * `profileIdFromScope` as its first statement, ahead of argument validation and
 * ahead of any I/O. `apps/web/src/lib/db/in-memory-repository.ts` -- the second,
 * complete repository implementation, the volatile store used for local
 * development -- was named here in round 42 as the remaining hole and read
 * `input.scope.profileId` in fourteen places; it was converted in round 43 in
 * the same shape, its seven scope-taking methods binding the id as their first
 * statement.
 *
 * TWO FORGERY SUITES ATTEMPT THE ATTACK AGAINST THOSE CONSUMERS rather than
 * describing it: `packages/persistence/src/scope-forgery.test.ts` and
 * `apps/web/src/lib/db/scope-forgery.test.ts`. Both are exhaustive over their
 * repository's exported surface rather than representative, because the defect
 * they guard is an extra function reading the field directly, and both assert
 * the refusal happens BEFORE any storage access. Those files are what make this
 * module's guarantee real, because a registry closes nothing unless the
 * consumer consults it.
 *
 * WHAT THIS STILL DOES NOT CLOSE -- READ THIS BEFORE TREATING THE DEFECT AS
 * WHOLLY FIXED.
 *
 *   A FORGERY CAN STILL BE CONSTRUCTED WITHOUT A CAST. Removing `profileId`
 *   from the public type rejects `{ ...real, profileId: victim }`, but
 *   `Object.assign({}, real, { profileId: victim })` type-checks as
 *   `ProfileScope` with no cast at all. Only the registry rejects it, which is
 *   why mechanism 5 is an ergonomic guarantee about unchecked reads and not a
 *   second control.
 *
 *   AN EDIT TO THIS FILE defeats it, and nothing in TypeScript can prevent that.
 *   What it prevents is how the defect actually recurs: a caller that copies a
 *   scope it legitimately holds and changes the one field that decides whose
 *   data it names.
 *
 *   PATCHING A BUILT-IN before this module is evaluated -- replacing
 *   `Object.freeze`, or `WeakSet.prototype.has` -- is named rather than defended
 *   against, for the same reason `runtime.ts` names it: any defence would be
 *   built out of the built-ins being patched. It is a statement executing inside
 *   the process, as visible in a diff as an edit to this file, and not something
 *   reachable THROUGH this module's surface.
 * ---------------------------------------------------------------------- */

/**
 * The brand.
 *
 * A REAL `Symbol()`, not a `declare const`. The previous declaration existed
 * only in the type system, so "the object carries the brand" was a claim no
 * runtime check could ever test -- which is why a spread copy looked exactly
 * like a genuine scope to everything downstream. Module-private and never
 * exported, on the same reasoning as `classifiedRuntime` in
 * `packages/contracts/src/shared/runtime.ts` and `authorisedByEgress` in
 * `packages/media-inspection`.
 */
const profileScopeBrand: unique symbol = Symbol("liberty.auth.profile-scope");

/**
 * Proof that an authorization decision granted access to one specific profile.
 *
 * Issued only by `authorizeProfileAccess` and `authorizeProfileSelection`, the
 * two grants in `authorization.ts` -- and they are two because a session may act
 * as its active profile and may CHOOSE one, which are different decisions with
 * different preconditions. Carrying `grantedFor` -- the account the grant was
 * made for -- means a scope that leaked across a request boundary can still be
 * checked against the session it is being used under, rather than being an
 * unattributable bearer token inside the process.
 *
 * HOLDING A VALUE OF THIS TYPE PROVES NOTHING ON ITS OWN. The type is the
 * compile-time half; `isIssuedProfileScope` is the other half, and a permission
 * built on a scope must consult it. See mechanism 4 in the header.
 */
export interface ProfileScope {
  /**
   * The brand, and the ONLY member of the public type.
   *
   * There is deliberately nothing else here. The profile id and the granting
   * account live on `IssuedProfileScope` below, which is module-private, so the
   * only way to obtain either outside `@liberty/auth` is through an accessor
   * that consults the registry first. See mechanism 5.
   */
  readonly [profileScopeBrand]: true;
}

/**
 * What an issued scope actually holds. MODULE-PRIVATE, AND THAT IS THE POINT.
 *
 * The runtime object is unchanged -- `profileId` and `grantedFor` are ordinary
 * own enumerable properties, exactly as before -- so nothing about the value's
 * behaviour, its freezing or its `Object.keys` moved. What moved is the TYPE
 * the rest of the repository sees: `ProfileScope` no longer declares them, so
 * `scope.profileId` outside this file does not compile.
 *
 * Round 42 left the property public with a `@deprecated` tag and said why: the
 * in-memory adapter in `apps/web` read it fourteen times and was outside the
 * write surface, so removing it would have failed `typecheck`. That was the
 * only thing keeping it public, the adapter was converted in round 43, and the
 * property came off in the same round.
 */
interface IssuedProfileScope extends ProfileScope {
  /** The profile this grant names. Read it with `profileIdFromScope`. */
  readonly profileId: string;
  /** The account the grant was made for. Read it with `grantedAccountFromScope`. */
  readonly grantedFor: string;
}

/**
 * The scopes this module has issued, by identity.
 *
 * Nothing removes an entry and nothing re-validates one: a scope records the
 * decision that was made when it was minted, which is the fact its holders were
 * granted access on. An expiry here would be a new failure mode for no gain --
 * scope lifetime is the request's, and `scopeBelongsToSession` is what catches a
 * scope used under the wrong session.
 */
const issuedScopes = new WeakSet<ProfileScope>();

/**
 * Raised when a value typed `ProfileScope` was not issued by this module.
 *
 * A DISTINCT ERROR TYPE, not a generic `Error`, because the two things a caller
 * might do about it are different: a `ForgedProfileScopeError` reaching a
 * request handler is a security event to alert on, while an ordinary failure is
 * a 500. It carries no `profileId` -- the id on a forged scope is the attacker's
 * chosen value, and copying it into a log line would put an unvalidated string
 * where a genuine profile id is expected.
 */
export class ForgedProfileScopeError extends Error {
  constructor() {
    super(
      "this ProfileScope was not issued by @liberty/auth: it is a copy, a cast or a hand-built object, and no authorization decision stands behind it"
    );
    this.name = "ForgedProfileScopeError";
  }
}

/**
 * Issue a scope. The ONLY producer of a `ProfileScope` in the repository.
 *
 * NOT re-exported from `index.ts`, and the package's `exports` map publishes
 * only `.` and `./server`, so no consumer outside `@liberty/auth` can reach it.
 * Within the package it is called from exactly two places, both of them grant
 * branches in `authorization.ts`. `enabled-surface.test.ts`-style enforcement of
 * that boundary lives in `profile-scope.test.ts`.
 *
 * FROZEN BEFORE IT IS REGISTERED, so there is no window in which a registered
 * scope is still writable.
 */
export function issueProfileScope(profileId: string, grantedFor: string): ProfileScope {
  const scope: IssuedProfileScope = Object.freeze({
    [profileScopeBrand]: true as const,
    profileId,
    grantedFor
  });
  issuedScopes.add(scope);
  return scope;
}

/**
 * Whether this exact object came out of `issueProfileScope`.
 *
 * The parameter is typed `ProfileScope` rather than `unknown` on purpose: a
 * caller that has not at least satisfied the brand cannot get this far, so the
 * only inputs worth asking about are the ones that got past the compiler -- a
 * cast, or a copy of a real scope. Both answer `false`.
 *
 * Prefer `profileIdFromScope` where the caller needs the id anyway: a predicate
 * that is returned and then ignored is the failure mode this whole module
 * exists to remove.
 */
export function isIssuedProfileScope(scope: ProfileScope): boolean {
  return issuedScopes.has(scope);
}

/**
 * The profile id a data predicate may be built from, or a throw.
 *
 * THE CHECK AND THE READ ARE ONE EXPRESSION, which is the point. A repository
 * writing `eq(playbackProgress.profileId, profileIdFromScope(input.scope))`
 * cannot leave the check out and still compile to something that reads the id;
 * a repository writing `eq(..., input.scope.profileId)` has the type and none of
 * the proof.
 *
 * THROWS RATHER THAN RETURNING `null`. A forged scope is not a business outcome
 * with a reason code -- it is an attack or a bug, and there is no correct row
 * set to return for it. Returning `null` would invite `?? ""`, which matches
 * nothing and so turns an attack into a silently empty result page: safe, and
 * invisible to everyone who needed to know it happened.
 */
export function profileIdFromScope(scope: ProfileScope): string {
  if (!issuedScopes.has(scope)) throw new ForgedProfileScopeError();
  /*
   * THE ONE CAST IN THIS MODULE, AND IT IS GUARDED BY THE LINE ABOVE. The
   * registry answered yes, which means this exact object came out of
   * `issueProfileScope`, which means it really does carry the payload -- so the
   * assertion is backed by a runtime proof rather than by a hope. It is the
   * price of mechanism 5: the property cannot be on the public type and also be
   * readable from it. Every other read in the repository goes through this
   * function, so the cast exists once, here, where the proof is.
   */
  return (scope as IssuedProfileScope).profileId;
}

/**
 * The account a scope was granted for, or a throw.
 *
 * The same discipline as `profileIdFromScope`, for the other field. A caller
 * that attributes an action to an account on the strength of a scope is making
 * a security decision with it and must establish issuance first.
 */
export function grantedAccountFromScope(scope: ProfileScope): string {
  if (!issuedScopes.has(scope)) throw new ForgedProfileScopeError();
  // Guarded by the line above, exactly as in `profileIdFromScope`.
  return (scope as IssuedProfileScope).grantedFor;
}
