import {
  ForgedProfileScopeError,
  authorizeProfileAccess,
  type LibertySession,
  type ProfileScope
} from "@liberty/auth";
import { describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../app/api/deployment-environment";
import {
  createInMemoryRepository,
  type InMemoryRepository,
  type InMemoryStore
} from "./in-memory-repository";

/* -------------------------------------------------------------------------
 * The development adapter ASKS TOO (PL-0405, round 43)
 *
 * WHAT THIS FILE IS FOR. `packages/auth/src/profile-scope.test.ts` proves the
 * mechanism -- a forged scope is not in the issuance registry.
 * `packages/persistence/src/scope-forgery.test.ts` proves that the PostgreSQL
 * repositories consult it. Neither says anything about this adapter, and until
 * round 43 this adapter read `input.scope.profileId` off the object in fourteen
 * places. A registry that only half the repositories ask is a capability that
 * READS as unforgeable and is not, which is worse than one that never claimed
 * to be: the first round of this corrective named the hole here rather than
 * closing it, because `apps/web/**` was outside the write surface then.
 *
 * THE BOUND, STATED THE SAME WAY BOTH ROUNDS. `createInMemoryRepository`
 * refuses to construct without an issued `ClassifiedRuntime`, so this adapter
 * cannot exist in a deployment: what follows is a development- and test-process
 * bypass, not a production one. It is still a CROSS-PROFILE bypass -- a
 * household member copying a scope they legitimately hold and reading another
 * profile's rows -- and that is the thing being closed.
 *
 * THE FORGERY IS THE ONE THAT MATTERED, IN THE SPELLING ROUND 43 LEAVES OPEN.
 * `Object.assign({}, realScope, { profileId: victim })` needs no cast: its type
 * is `ProfileScope & { profileId: string }`, which is assignable to
 * `ProfileScope`. It keeps a GENUINE `grantedFor`, so the account comparison
 * `selectActiveProfile` performs would pass it. Only object identity separates
 * it from a scope an authorization decision actually issued.
 *
 * The shorter spelling `{ ...realScope, profileId: victim }` no longer
 * compiles, because round 43 took `profileId` off the public `ProfileScope` and
 * excess-property checking rejects a literal naming a property the target type
 * does not declare. That is worth having and it is NOT a control: the line
 * above compiles, so the registry is still the only thing that rejects the
 * value.
 *
 * EXHAUSTIVE RATHER THAN REPRESENTATIVE, and the exhaustiveness is MACHINE
 * CHECKED rather than asserted in a comment. The defect this guards against is
 * not "the check is wrong", it is "somebody added a twelfth method and read the
 * field directly". So every member of the adapter is classified below into one
 * of three lists -- scope-taking, scope-free, not-a-method -- and one test
 * asserts the three lists together are exactly the adapter's own keys. A new
 * member fails that test until it is classified, and classifying it as
 * scope-taking requires writing the forgery case for it.
 *
 * NO USABLE STORE IS SUPPLIED, AND THAT IS THE SECOND ASSERTION. `refusingStore`
 * throws on any property access at all, so a method that reaches its maps fails
 * with `reached the store` instead of with `ForgedProfileScopeError`, and the
 * test says which happened. "It refused" and "it refused before touching
 * storage" are different guarantees and only the second is worth having.
 * ---------------------------------------------------------------------- */

const HOUSEHOLD = "user_household";
const OWN_PROFILE = "5f0a1d2e-3c4b-4a5d-8e9f-0a1b2c3d4e5f";
const VICTIM_PROFILE = "9b8a7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d";
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
 * `profileId` and `grantedFor` live on a module-private type inside
 * `@liberty/auth`, so no consumer can read either without a checked accessor.
 * The fixture assertions below are about the OBJECT -- that the forgery really
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
 * A store that cannot be used.
 *
 * Every property access throws, so there is no way for a method to reach
 * `store.profiles`, `store.progress`, `store.watchlist` or `store.selections`
 * without failing loudly and differently from the refusal being tested. The
 * constructor never touches the store -- `liveProfilesOf` is a hoisted
 * declaration, not an execution -- so handing it one of these is only a
 * statement about the METHODS.
 */
const refusingStore = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `reached the store with a forged scope: store.${String(property)} was accessed`
      );
    }
  }
) as InMemoryStore;

/**
 * This process's own classification.
 *
 * Not a `!`: the whole point of the witness is that the `null` is handled, and
 * a test reaching for a non-null assertion would demonstrate the opposite of
 * what the type is for.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

function adapter(): InMemoryRepository {
  return createInMemoryRepository(classifiedProcess(), refusingStore);
}

/**
 * Every method that takes a `ProfileScope`, with the call that reaches it.
 *
 * The VALUES are what make this exhaustive rather than a list: a name here
 * without an invocation does not type-check, so a method cannot be declared
 * covered without actually being called with the forged scope.
 */
const SCOPE_TAKING = {
  selectActiveProfile: (repository: InMemoryRepository) =>
    repository.selectActiveProfile({ session, scope: forgedScope, instant: INSTANT }),
  issueWriterLease: (repository: InMemoryRepository) =>
    repository.issueWriterLease({
      scope: forgedScope,
      contentId: "the-northstar-affair",
      writerId: "writer_television",
      instant: INSTANT
    }),
  writeProgress: (repository: InMemoryRepository) =>
    repository.writeProgress({
      scope: forgedScope,
      contentId: "the-northstar-affair",
      write: {
        lease: { epoch: 1, writerId: "writer_television" },
        writeSeq: 1,
        positionSeconds: 600,
        runtimeSeconds: 5400
      },
      instant: INSTANT
    }),
  readProgress: (repository: InMemoryRepository) =>
    repository.readProgress({ scope: forgedScope, contentId: "the-northstar-affair" }),
  addToWatchlist: (repository: InMemoryRepository) =>
    repository.addToWatchlist({
      scope: forgedScope,
      contentId: "the-northstar-affair",
      instant: INSTANT
    }),
  removeFromWatchlist: (repository: InMemoryRepository) =>
    repository.removeFromWatchlist({
      scope: forgedScope,
      contentId: "the-northstar-affair"
    }),
  listWatchlist: (repository: InMemoryRepository) =>
    repository.listWatchlist({ scope: forgedScope, limit: 20 })
} satisfies Record<string, (repository: InMemoryRepository) => Promise<unknown>>;

/**
 * The methods that take no scope, and therefore have nothing to forge.
 *
 * Listed rather than omitted so the completeness test below can account for
 * every key. `loadProfileOwnership` takes a raw profile id ON PURPOSE -- it is
 * the lookup that runs BEFORE authorization and produces the input to it -- and
 * the other three take a session or an account, which is not a capability this
 * module issues.
 */
const SCOPE_FREE = [
  "loadProfileOwnership",
  "listProfilesForAccount",
  "createProfile",
  "resolveSession"
] as const;

/** The two published facts that are not functions. */
const NOT_A_METHOD = ["adapterId", "admittedBy"] as const;

describe("the classification is complete, so a new method cannot slip past this file", () => {
  it("every member of the adapter is either scope-taking, scope-free, or not a method", () => {
    const classified = [...Object.keys(SCOPE_TAKING), ...SCOPE_FREE, ...NOT_A_METHOD].sort();

    /*
     * THIS IS THE ASSERTION THAT MAKES THE SUITE EXHAUSTIVE. A twelfth member
     * added to `createInMemoryRepository` fails here until somebody decides
     * which list it belongs in, and putting it in `SCOPE_TAKING` means writing
     * the forgery call for it, because the list is a map of invocations.
     */
    expect(Object.keys(adapter()).sort()).toStrictEqual(classified);
  });

  it("the scope-taking list is not silently empty", () => {
    expect(Object.keys(SCOPE_TAKING)).toHaveLength(7);
  });
});

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

describe("the in-memory adapter refuses a forged scope before touching the store", () => {
  /*
   * Six of the seven throw. `selectActiveProfile` is the exception and is
   * asserted separately below, because it has a reason channel the routes
   * already map and a reason is the better refusal wherever one exists.
   */
  const throwing = Object.entries(SCOPE_TAKING).filter(
    ([name]) => name !== "selectActiveProfile"
  );

  it.each(throwing)("%s", async (_name, invoke) => {
    await expect(invoke(adapter())).rejects.toThrow(ForgedProfileScopeError);
  });

  it("selectActiveProfile refuses with a reason, names no profile id, and touches no store", async () => {
    const result = await SCOPE_TAKING.selectActiveProfile(adapter());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_not_granted_to_this_session");
    // The id on a forged scope is a string the caller wrote. Echoing it would
    // put an attacker-chosen value into a reason trail where every other
    // profile id is one the system minted.
    expect(result.detail).not.toContain(VICTIM_PROFILE);
    expect(result.detail).toContain("not issued");
  });
});

describe("the check runs before argument validation, so it is not an oracle", () => {
  /**
   * `profileIdFromScope` is the FIRST statement of every method above, ahead of
   * `parseContentId` and `parseListLimit`. That ordering is load-bearing rather
   * than tidy: if validation ran first, a forged scope would receive
   * `content_id_invalid` for a malformed id and `ForgedProfileScopeError` for a
   * well-formed one, and the difference is a yes/no answer to "would this
   * content id have been queryable" for a caller with no legitimate scope at
   * all.
   */
  it("a forged scope with an invalid content id still fails on the scope", async () => {
    await expect(
      adapter().readProgress({ scope: forgedScope, contentId: "  not a content id  " })
    ).rejects.toThrow(ForgedProfileScopeError);
  });

  it("a forged scope with an unusable limit still fails on the scope", async () => {
    await expect(
      adapter().listWatchlist({ scope: forgedScope, limit: Number.NaN })
    ).rejects.toThrow(ForgedProfileScopeError);
  });
});

describe("a genuine scope still reaches the store", () => {
  /**
   * THE MIRROR-IMAGE DEFECT. A refusal suite passes just as happily against a
   * repository that refuses EVERYTHING, so one case establishes that the
   * accessor is a gate rather than a wall: the same method, with an issued
   * scope, gets past the check and fails on the deliberately-broken store
   * instead.
   */
  it("and fails on the refusing store rather than on the scope", async () => {
    await expect(
      adapter().readProgress({ scope: realScope, contentId: "the-northstar-affair" })
    ).rejects.toThrow(/reached the store/);
  });
});
