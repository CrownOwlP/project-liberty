import type { LibertySession, ProfileScope } from "@liberty/auth";
import {
  ForgedProfileScopeError,
  authorizeProfileAccess,
  profileIdFromScope
} from "@liberty/auth";
import { describe, expect, it } from "vitest";
import type { LibertyDatabase } from "./client";
import { archiveProfile, selectActiveProfile } from "./profile-repository";
import {
  issueWriterLease,
  listContinueWatching,
  readProgress,
  writeProgress
} from "./progress-repository";
import {
  addToWatchlist,
  listWatchlist,
  removeFromWatchlist,
  watchlistContains
} from "./watchlist-repository";

/* -------------------------------------------------------------------------
 * The consumer half of PL-0405: these repositories ASK
 *
 * `packages/auth/src/profile-scope.test.ts` proves the mechanism -- that a
 * forged scope is not in the issuance registry. It cannot prove the thing that
 * actually matters, which is that the code granting data access consults the
 * registry before it builds a predicate. A registry closes nothing unless the
 * consumer asks, and every consumer that reads `scope.profileId` directly is a
 * consumer that does not.
 *
 * So this file attempts the forgery against the repositories themselves, one
 * exported function at a time. It is deliberately exhaustive rather than
 * representative: the defect it guards against is not "the check is wrong", it
 * is "somebody added a tenth function and read the field directly", and a
 * sample of three would not catch that.
 *
 * THE FORGERY IS THE ONE THAT MATTERED, AND ITS SPELLING CHANGED IN ROUND 43.
 * `Object.assign({}, realScope, { profileId: victim })` needs no cast -- it has
 * type `ProfileScope & { profileId: string }`, which is assignable to
 * `ProfileScope` -- and it keeps a GENUINE `grantedFor`, so the account
 * comparison that `refuseForeignScope` performs would pass it. Before PL-0405
 * every function below would have executed a statement reading or writing
 * another household's rows.
 *
 * Round 42 wrote the same forgery as `{ ...realScope, profileId: victim }`.
 * Round 43 removed `profileId` from the public `ProfileScope`, so that literal
 * is now rejected by excess-property checking -- which is a real improvement in
 * what an honest consumer can accidentally write, and NOT a second control,
 * because the spelling above compiles just as happily. The registry is still
 * the only thing that rejects it.
 *
 * NO DATABASE IS SUPPLIED, AND THAT IS THE SECOND ASSERTION. `refusingDb` throws
 * on any property access at all, so a function that reaches the driver fails
 * with `reached the database` instead of with `ForgedProfileScopeError`, and the
 * test says which happened. "It refused" and "it refused before doing any I/O"
 * are different guarantees and only the second one is worth having: a forged
 * scope that reaches PostgreSQL has already had its chance.
 * ---------------------------------------------------------------------- */

const HOUSEHOLD = "user_household";
const OWN_PROFILE = "profile_ada";
const VICTIM_PROFILE = "profile_someone_elses_household";
const INSTANT = new Date("2026-09-15T20:00:00.000Z");

/** A scope obtained the only legitimate way: through a grant. */
function issuedScope(profileId: string, ownerUserId: string): ProfileScope {
  const decision = authorizeProfileAccess({
    session: {
      account: { userId: ownerUserId, sessionId: "session_tv_lounge" },
      activeProfileId: profileId
    },
    requestedProfileId: profileId,
    ownership: { profileId, ownerUserId, archivedAt: null }
  });
  if (!decision.allowed) {
    throw new Error(`fixture is wrong: expected a grant, got ${decision.reason}`);
  }
  return decision.scope;
}

const realScope = issuedScope(OWN_PROFILE, HOUSEHOLD);

/**
 * The forgery, built with no cast.
 *
 * If a future change to `ProfileScope` makes this line stop compiling, that is
 * a strictly better outcome and this file should be updated to say so -- but
 * nothing in TypeScript can currently reject it, which is the finding that made
 * the runtime registry necessary in the first place.
 */
const forgedScope: ProfileScope = Object.assign({}, realScope, { profileId: VICTIM_PROFILE });

/**
 * The runtime shape the public type no longer describes.
 *
 * Round 43 moved `profileId` and `grantedFor` onto a module-private type inside
 * `@liberty/auth`, so no consumer can read either without a checked accessor.
 * The three assertions below are about the OBJECT -- that the forgery really
 * did replace the id and really did keep the account -- so they reach in
 * through this alias, deliberately and visibly.
 */
function runtimeShape(scope: ProfileScope): { profileId: string; grantedFor: string } {
  return scope as unknown as { profileId: string; grantedFor: string };
}

const session: LibertySession = {
  account: { userId: HOUSEHOLD, sessionId: "session_tv_lounge" },
  activeProfileId: OWN_PROFILE
};

/**
 * A database that cannot be used.
 *
 * Every property access throws, so there is no way for a repository to build a
 * statement, execute one, or even reach for `db.select` without failing loudly
 * and differently from the refusal being tested.
 */
const refusingDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `reached the database with a forged scope: db.${String(property)} was accessed`
      );
    }
  }
) as LibertyDatabase;

describe("a spread forgery carries a genuine grantedFor", () => {
  it("would pass an account comparison, which is why the account comparison is not the control", () => {
    // Stated as a fact of the fixture rather than assumed. The forged scope is
    // a copy of a scope granted to THIS household, so every field except
    // `profileId` is genuine and every check except an identity check agrees
    // with it.
    expect(runtimeShape(forgedScope).grantedFor).toBe(runtimeShape(realScope).grantedFor);
    expect(runtimeShape(forgedScope).grantedFor).toBe(HOUSEHOLD);
    expect(runtimeShape(forgedScope).profileId).toBe(VICTIM_PROFILE);
  });
});

describe("progress-repository refuses a forged scope before any I/O", () => {
  it("issueWriterLease", async () => {
    await expect(
      issueWriterLease(refusingDb, {
        scope: forgedScope,
        contentId: "the-northstar-affair",
        writerId: "writer_television",
        instant: INSTANT
      })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("writeProgress", async () => {
    await expect(
      writeProgress(refusingDb, {
        scope: forgedScope,
        contentId: "the-northstar-affair",
        write: {
          lease: { epoch: 1, writerId: "writer_television" },
          writeSeq: 1,
          positionSeconds: 600,
          runtimeSeconds: 5400
        },
        instant: INSTANT
      })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("readProgress", async () => {
    await expect(
      readProgress(refusingDb, { scope: forgedScope, contentId: "the-northstar-affair" })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("listContinueWatching", async () => {
    await expect(
      listContinueWatching(refusingDb, { scope: forgedScope, limit: 20 })
    ).rejects.toThrow(ForgedProfileScopeError);
  });
});

describe("watchlist-repository refuses a forged scope before any I/O", () => {
  it("addToWatchlist", async () => {
    await expect(
      addToWatchlist(refusingDb, {
        scope: forgedScope,
        contentId: "the-northstar-affair",
        instant: INSTANT
      })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("removeFromWatchlist", async () => {
    await expect(
      removeFromWatchlist(refusingDb, { scope: forgedScope, contentId: "the-northstar-affair" })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("listWatchlist", async () => {
    await expect(listWatchlist(refusingDb, { scope: forgedScope, limit: 20 })).rejects.toThrow(
      ForgedProfileScopeError
    );
  });

  it("watchlistContains", async () => {
    await expect(
      watchlistContains(refusingDb, {
        scope: forgedScope,
        contentIds: ["the-northstar-affair"]
      })
    ).rejects.toThrow(ForgedProfileScopeError);
  });
});

describe("the check runs before argument validation, so it is not an oracle", () => {
  /**
   * `profileIdFromScope` is the FIRST statement of every function in the two
   * repositories above, ahead of `parseContentId` and `parseListLimit`. That
   * ordering is load-bearing rather than tidy: if validation ran first, a
   * forged scope would receive `content_id_invalid` for a malformed id and
   * `ForgedProfileScopeError` for a well-formed one, and the difference is a
   * yes/no answer to "would this content id have been queryable" for a caller
   * that has no legitimate scope at all.
   */
  it("a forged scope with an invalid content id still fails on the scope", async () => {
    await expect(
      readProgress(refusingDb, { scope: forgedScope, contentId: "  not a content id  " })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("a forged scope with an unusable limit still fails on the scope", async () => {
    await expect(
      listContinueWatching(refusingDb, { scope: forgedScope, limit: Number.NaN })
    ).rejects.toThrow(ForgedProfileScopeError);
  });
});

describe("profile-repository refuses a forged scope, with a reason rather than a throw", () => {
  /**
   * THESE TWO REFUSE DIFFERENTLY FROM THE EIGHT ABOVE, AND DELIBERATELY SO.
   * `selectActiveProfile` and `archiveProfile` take a session as well as a
   * scope, so they already began with `refuseForeignScope` -- the check every
   * function taking both runs first. `scopeBelongsToSession` now establishes
   * issuance as well as the account match, so a forged scope is refused there,
   * as a reason code, before `profileIdFromScope` is ever reached.
   *
   * A reason rather than a throw is right for these: the refusal is reportable
   * to the caller through an existing, mapped wire contract, and `ok: false`
   * with a code is what every other failure on these paths already looks like.
   * The eight above have no such channel -- their return types are rows -- and
   * an unforgeable capability that returns an empty list is indistinguishable
   * from an empty list.
   */
  it("selectActiveProfile refuses, names no profile id, and touches no database", async () => {
    const result = await selectActiveProfile(refusingDb, {
      session,
      scope: forgedScope,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_not_granted_to_this_session");
    // The id on a forged scope is a string the caller wrote. Echoing it would
    // put an attacker-chosen value into a reason trail where every other
    // profile id is one the system minted.
    expect(result.detail).not.toContain(VICTIM_PROFILE);
    expect(result.detail).toContain("not issued");
  });

  it("archiveProfile refuses, names no profile id, and touches no database", async () => {
    const result = await archiveProfile(refusingDb, {
      session,
      scope: forgedScope,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_not_granted_to_this_session");
    expect(result.detail).not.toContain(VICTIM_PROFILE);
    expect(result.detail).toContain("not issued");
  });

  it("still names the profile id when the scope was genuinely issued to another account", () => {
    // The two details are not interchangeable, and this is the other branch:
    // an issued scope belonging to another household IS diagnosable, and the
    // existing refusal message is preserved for it.
    const foreign = issuedScope(OWN_PROFILE, "user_someone_else");
    expect(profileIdFromScope(foreign)).toBe(OWN_PROFILE);
  });
});
