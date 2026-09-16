import { describe, expect, it } from "vitest";
import * as publicSurface from "./index";
import {
  ForgedProfileScopeError,
  grantedAccountFromScope,
  isIssuedProfileScope,
  issueProfileScope,
  profileIdFromScope,
  type ProfileScope
} from "./profile-scope";
import { authorizeProfileAccess, authorizeProfileSelection } from "./authorization";
import { scopeBelongsToSession } from "./session";
import type { LibertySession, ProfileOwnership } from "./session";

/* -------------------------------------------------------------------------
 * The forgery suite (PL-0405)
 *
 * THESE TESTS ATTEMPT THE ATTACK RATHER THAN DESCRIBING IT. The PL-0401 review
 * found that `ProfileScope` was forgeable by a holder of a genuine scope, and
 * the reason the defect survived a round of review is that nothing in the suite
 * ever tried it: every existing test builds a scope through a grant, or through
 * `as unknown as ProfileScope`, and then asserts something about its fields. So
 * each case below constructs a value the way an attacker would and asserts that
 * the consumer boundary REFUSES it.
 *
 * THE THREE FORGERIES, in ascending order of how hard they are to notice:
 *
 *   1. A COPY WITH A REPLACED `profileId`. The one that mattered, and the one
 *      whose SPELLING round 43 changed. It still needs no cast.
 *
 *      Round 42 wrote it as `{ ...realScope, profileId: victim }`, and that
 *      line no longer compiles, because round 43 took `profileId` off the
 *      public `ProfileScope` and excess-property checking rejects a literal
 *      naming a property the target type does not declare. THAT IS NOT THE
 *      FORGERY BEING CLOSED, only one way of writing it:
 *      `Object.assign({}, real, { profileId: victim })` has type
 *      `ProfileScope & { profileId: string }`, is assignable to `ProfileScope`,
 *      and contains NO CAST ANYWHERE. `forge` below uses that form, so this
 *      file still attempts a cast-free forgery and the registry is still the
 *      only thing that rejects it.
 *
 *      `grantedFor` stays genuine, so any check that looks only at the account
 *      passes it too.
 *   2. A HAND-BUILT OBJECT of the right shape, reached with
 *      `as unknown as ProfileScope`. This is the forgery the old comment in
 *      `session.ts` claimed was the only one available.
 *   3. A STRUCTURALLY-CORRECT OBJECT THAT WAS NEVER ISSUED -- one carrying its
 *      own symbol keyed with the same description as the real brand, frozen the
 *      same way, indistinguishable from a genuine scope under `typeof`,
 *      `Object.keys`, `Object.isFrozen` and a `JSON.stringify` round trip.
 *      Only object identity separates it from the real thing.
 * ---------------------------------------------------------------------- */

const ACCOUNT = "user_household";
const OWN_PROFILE = "profile_ada";
const VICTIM_PROFILE = "profile_someone_elses_household";

const session: LibertySession = {
  account: { userId: ACCOUNT, sessionId: "session_1" },
  activeProfileId: OWN_PROFILE
};

/**
 * The runtime shape of a scope, which the public type no longer describes.
 *
 * Round 43 moved `profileId` and `grantedFor` onto a module-private type, so a
 * consumer cannot read either without going through a checked accessor -- which
 * is the property under test in `describe("the type no longer exposes the
 * payload")` below. The OBJECT still carries both, and a few cases here have to
 * assert facts about the object rather than about the type: that a forgery
 * really did replace the id, that a genuine scope cannot be written in place.
 * Those reach in through this alias, deliberately and visibly.
 *
 * `unknown` is in the middle because `ProfileScope` and this type no longer
 * overlap structurally, which is itself the removal working.
 */
function runtimeShape(scope: ProfileScope): { profileId: string; grantedFor: string } {
  return scope as unknown as { profileId: string; grantedFor: string };
}

const ownership: ProfileOwnership = {
  profileId: OWN_PROFILE,
  ownerUserId: ACCOUNT,
  archivedAt: null
};

/** A scope obtained the only legitimate way: through a grant. */
function genuineScope(): ProfileScope {
  const decision = authorizeProfileAccess({
    session,
    requestedProfileId: OWN_PROFILE,
    ownership
  });
  if (!decision.allowed) throw new Error("fixture is wrong: the grant was expected to succeed");
  return decision.scope;
}

describe("a genuine scope", () => {
  it("is issued, frozen, and readable through the checked accessors", () => {
    const scope = genuineScope();

    expect(isIssuedProfileScope(scope)).toBe(true);
    expect(profileIdFromScope(scope)).toBe(OWN_PROFILE);
    expect(grantedAccountFromScope(scope)).toBe(ACCOUNT);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("cannot be edited in place, which is the forgery that keeps the object's identity", () => {
    const scope = genuineScope();

    // `readonly` is erased at runtime, so without `Object.freeze` this
    // assignment would succeed and the registry would still recognise the
    // object -- a forgery that never copies anything. Modules are strict, so
    // the write throws.
    expect(() => {
      runtimeShape(scope).profileId = VICTIM_PROFILE;
    }).toThrow(TypeError);

    expect(profileIdFromScope(scope)).toBe(OWN_PROFILE);
  });
});

describe("forgery 1: a spread copy with a replaced profileId", () => {
  /**
   * NO CAST APPEARS IN THIS FUNCTION, and that is still the finding.
   *
   * `Object.assign({}, real, { profileId })` returns
   * `ProfileScope & { profileId: string }`, which is assignable to the declared
   * return type without an assertion. The object-literal spelling
   * `{ ...real, profileId }` was what round 42 used; round 43's removal of
   * `profileId` from `ProfileScope` makes that spelling a compile error through
   * excess-property checking, and this one shows why that is an ergonomic win
   * rather than a second control -- a forger writes the other spelling and the
   * compiler has nothing to say about it.
   */
  function forge(real: ProfileScope): ProfileScope {
    return Object.assign({}, real, { profileId: VICTIM_PROFILE });
  }

  it("type-checks without a cast, and the registry rejects it anyway", () => {
    const forged = forge(genuineScope());

    expect(runtimeShape(forged).profileId).toBe(VICTIM_PROFILE);
    expect(isIssuedProfileScope(forged)).toBe(false);
  });

  it("throws rather than yielding a profile id a data predicate could be built from", () => {
    const forged = forge(genuineScope());

    expect(() => profileIdFromScope(forged)).toThrow(ForgedProfileScopeError);
    expect(() => grantedAccountFromScope(forged)).toThrow(ForgedProfileScopeError);
  });

  it("does not pass the session check, even though its grantedFor is genuine", () => {
    // The sharpest case. The forger copies a scope granted to their own
    // account and changes only the profile, so `grantedFor` is still correct
    // and the account comparison alone would say yes.
    const forged = forge(genuineScope());

    expect(runtimeShape(forged).grantedFor).toBe(ACCOUNT);
    expect(scopeBelongsToSession(forged, session)).toBe(false);
  });

  it("carries the real brand, which is exactly why the brand alone cannot be the control", () => {
    const real = genuineScope();
    const forged = forge(real);

    // A spread copies own enumerable properties INCLUDING symbol-keyed ones,
    // so the copy really does hold the genuine brand symbol -- the same symbol
    // object, not a look-alike. Asserted rather than assumed, because it is the
    // load-bearing fact: if the brand were sufficient, this expectation would
    // fail and the registry would be unnecessary.
    expect(Object.getOwnPropertySymbols(forged)).toStrictEqual(
      Object.getOwnPropertySymbols(real)
    );
    expect(isIssuedProfileScope(forged)).toBe(false);
  });
});

describe("forgery 2: a hand-built object of the right shape", () => {
  const forged = {
    profileId: VICTIM_PROFILE,
    grantedFor: ACCOUNT
  } as unknown as ProfileScope;

  it("is not issued", () => {
    expect(isIssuedProfileScope(forged)).toBe(false);
  });

  it("throws at the accessor and fails the session check", () => {
    expect(() => profileIdFromScope(forged)).toThrow(ForgedProfileScopeError);
    expect(scopeBelongsToSession(forged, session)).toBe(false);
  });
});

describe("forgery 3: a structurally-correct object that was never issued", () => {
  /**
   * Built to be indistinguishable from a genuine scope by every observation
   * except identity: same fields, a symbol-keyed `true` under the same symbol
   * DESCRIPTION as the real brand, and frozen.
   */
  function counterfeit(): ProfileScope {
    const lookalikeBrand = Symbol("liberty.auth.profile-scope");
    return Object.freeze({
      [lookalikeBrand]: true as const,
      profileId: VICTIM_PROFILE,
      grantedFor: ACCOUNT
    }) as unknown as ProfileScope;
  }

  it("passes every structural observation a consumer might make", () => {
    const forged = counterfeit();
    const real = genuineScope();

    expect(Object.isFrozen(forged)).toBe(Object.isFrozen(real));
    expect(Object.keys(forged).sort()).toStrictEqual(Object.keys(real).sort());
    expect(Object.getOwnPropertySymbols(forged)).toHaveLength(
      Object.getOwnPropertySymbols(real).length
    );
    expect(Object.getOwnPropertySymbols(forged)[0]?.description).toBe(
      Object.getOwnPropertySymbols(real)[0]?.description
    );
  });

  it("is still rejected, because a symbol is not equal to another symbol with the same description", () => {
    const forged = counterfeit();

    expect(isIssuedProfileScope(forged)).toBe(false);
    expect(() => profileIdFromScope(forged)).toThrow(ForgedProfileScopeError);
    expect(scopeBelongsToSession(forged, session)).toBe(false);
  });
});

describe("the type no longer exposes the payload (round 43)", () => {
  /**
   * MECHANISM 5, ASSERTED AS FAR AS A RUNTIME TEST CAN ASSERT IT.
   *
   * The real guarantee is a COMPILE-TIME one and therefore cannot be expressed
   * as an expectation: `scope.profileId` outside `@liberty/auth` does not
   * compile, and the evidence for that is `npm run typecheck`, not this file.
   * What a test CAN pin is the pair of facts the removal rests on, either of
   * which could be broken by a later edit without breaking anything else:
   *
   *   - the object still carries the payload at runtime, so the accessors have
   *     something to return and the cast inside them is sound;
   *   - the accessors are the published way to reach it, and they answer the
   *     same values a direct read would have.
   *
   * If somebody re-adds `readonly profileId: string` to the public interface,
   * these keep passing -- that is the limit of a runtime test here, and the
   * compile errors it would NOT cause are exactly why the removal is worth
   * more than the `@deprecated` tag it replaced.
   */
  it("the accessors return what the runtime object holds", () => {
    const scope = genuineScope();

    expect(runtimeShape(scope).profileId).toBe(OWN_PROFILE);
    expect(runtimeShape(scope).grantedFor).toBe(ACCOUNT);
    expect(profileIdFromScope(scope)).toBe(runtimeShape(scope).profileId);
    expect(grantedAccountFromScope(scope)).toBe(runtimeShape(scope).grantedFor);
  });

  it("the payload is still ordinary own enumerable data, so nothing downstream moved", () => {
    // The removal was a change to the TYPE, not to the value. Stated here so a
    // reviewer does not have to take the header's word for it: `Object.keys`
    // still reports both fields, which is what `profile-scope.test.ts` forgery
    // 3 relies on to build an indistinguishable counterfeit.
    expect(Object.keys(genuineScope()).sort()).toStrictEqual(["grantedFor", "profileId"]);
  });
});

describe("the package surface", () => {
  /**
   * A REGISTRY IS WORTH NOTHING IF ANYONE CAN MINT. The producer must not leave
   * `@liberty/auth`, and the way that breaks is an `export *` added to
   * `index.ts` by somebody who did not know why the re-exports there are
   * written out by name.
   */
  it("publishes no way to produce a ProfileScope", () => {
    const exported = Object.keys(publicSurface);

    expect(exported).not.toContain("issueProfileScope");
    expect(exported).not.toContain("mintProfileScope");
    expect(exported.filter((name) => /mint|issueProfileScope/i.test(name))).toStrictEqual([]);
  });

  it("publishes the checks a consumer needs", () => {
    expect(publicSurface.isIssuedProfileScope).toBeTypeOf("function");
    expect(publicSurface.profileIdFromScope).toBeTypeOf("function");
    expect(publicSurface.grantedAccountFromScope).toBeTypeOf("function");
    expect(publicSurface.ForgedProfileScopeError).toBeTypeOf("function");
  });
});

describe("issuance", () => {
  it("registers each issued scope separately, so two grants are two identities", () => {
    const first = issueProfileScope(OWN_PROFILE, ACCOUNT);
    const second = issueProfileScope(OWN_PROFILE, ACCOUNT);

    expect(first).not.toBe(second);
    expect(isIssuedProfileScope(first)).toBe(true);
    expect(isIssuedProfileScope(second)).toBe(true);
  });

  it("issues from the selection grant as well as the access grant", () => {
    // Both grant branches in `authorization.ts` must go through issuance. A
    // branch that built a scope some other way would produce a value failing
    // every check for no reason -- the mirror-image defect, and one that only
    // shows up on the path a test forgot to exercise. Selection is the path
    // with no active profile, so it is checked against a session that has
    // chosen nothing.
    const decision = authorizeProfileSelection({
      session: { account: session.account, activeProfileId: null },
      ownership
    });
    if (!decision.allowed) throw new Error("fixture is wrong: selection was expected to succeed");
    expect(isIssuedProfileScope(decision.scope)).toBe(true);
    expect(profileIdFromScope(decision.scope)).toBe(OWN_PROFILE);
  });
});
