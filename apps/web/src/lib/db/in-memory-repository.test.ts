import {
  authorizeProfileSelection,
  type AccountIdentity,
  type LibertySession,
  type ProfileScope
} from "@liberty/auth";
import {
  MAX_PROFILES_PER_ACCOUNT,
  type ListLimitRejection,
  type PlaybackProgressRow,
  type ProgressRepositoryFailure,
  type WatchlistEntryRow
} from "@liberty/persistence";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../app/api/deployment-environment";
import {
  IN_MEMORY_STORE_GLOBAL_KEY,
  createInMemoryRepository,
  createInMemoryStore,
  processInMemoryStore,
  resetProcessInMemoryStore
} from "./in-memory-repository";
import type { LibertyRepository } from "./repository";

/*
 * What is pinned here is that the development adapter behaves the way the
 * PACKAGE says storage behaves -- not the way a `Map` happens to behave. Every
 * assertion below is about a rule owned by `@liberty/persistence`: the ceiling,
 * name normalisation and uniqueness, the writer epoch, the watchlist's four
 * outcomes, and profile scoping.
 *
 * WHAT THESE TESTS DO NOT SHOW. They say nothing about the PostgreSQL adapter,
 * which has never executed a statement in this environment. A rule that agrees
 * here and diverges in SQL would pass this file. That is the gap the
 * `integration` gate on PL-0402/0403/0404 covers and this lane cannot close.
 */

const HOUSEHOLD_A: AccountIdentity = { userId: "household-a", sessionId: "session-a" };
const HOUSEHOLD_B: AccountIdentity = { userId: "household-b", sessionId: "session-b" };
const INSTANT = new Date("2026-09-04T10:00:00.000Z");

/**
 * THIS process's own classification, and the repository admitted by it.
 *
 * `classify` takes no argument -- it reads the process rather than a name its
 * caller supplied, which is the corrective that removed the way a hosted caller
 * could ask to be treated as a test one. This suite gets a real witness because
 * the process running it really is a test process: vitest sets `NODE_ENV=test`,
 * which `NON_DEPLOYMENT_ENVIRONMENTS` admits. Nothing in this file rewrites
 * `NODE_ENV`, so classifying at the call site is the same answer as classifying
 * at import.
 *
 * The witness is reachable on its own because the forgery cases below need a
 * GENUINE one to copy: a spread of a real classification is the forgery a brand
 * cannot stop, and it cannot be written without something real to spread.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  /*
   * Not a `!`. The whole point of the witness is that the `null` is handled, and
   * a test that reached for a non-null assertion would be demonstrating the
   * opposite of what the type is for. The throw names the only condition that
   * leaves this file without one.
   */
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

function repository(): LibertyRepository {
  return createInMemoryRepository(classifiedProcess(), createInMemoryStore());
}

function sessionFor(account: AccountIdentity, activeProfileId: string | null): LibertySession {
  return { account, activeProfileId };
}

/**
 * Guards for the two results that are told apart by SHAPE rather than by a
 * shared discriminant.
 *
 * The handlers under test use the same device for the same reason: `in`
 * narrowing on its true branch yields an intersection rather than the failure
 * type, and `Array.isArray` narrows a `readonly T[]` to `any[]` and loses the
 * element type. A predicate states the answer once, where the claim is
 * checkable -- `PlaybackProgressRow` is derived from the table and has no `ok`
 * column.
 */
function isProgressFailure(
  value: PlaybackProgressRow | ProgressRepositoryFailure
): value is ProgressRepositoryFailure {
  return "ok" in value;
}

/**
 * Generic over the row, because two list methods now share the refusal shape.
 *
 * It was typed to `WatchlistEntryRow` until PW-0305 added `listContinueWatching`,
 * whose rows are `PlaybackProgressRow`. A second copy of this predicate would
 * have been the easy edit and the wrong one: the thing being narrowed is the
 * REFUSAL, which is one type, and the row is the part that varies.
 */
function isLimitRejection<Row>(
  value: readonly Row[] | ListLimitRejection
): value is ListLimitRejection {
  return !Array.isArray(value);
}

/**
 * A scope, obtained the only way a scope can be obtained.
 *
 * `authorizeProfileSelection` is one of the two mints in `@liberty/auth`; the
 * brand is a non-exported `unique symbol`, so even a test cannot fabricate one
 * without an explicit cast. That is the property under test as much as anything
 * below it.
 */
async function scopeFor(
  store: LibertyRepository,
  session: LibertySession,
  profileId: string
): Promise<ProfileScope> {
  const ownership = await store.loadProfileOwnership(profileId);
  const decision = authorizeProfileSelection({ session, ownership });
  if (!decision.allowed) throw new Error(`expected a grant, got ${decision.reason}`);
  return decision.scope;
}

async function createProfile(
  store: LibertyRepository,
  account: AccountIdentity,
  displayName: string
): Promise<string> {
  const created = await store.createProfile({
    session: sessionFor(account, null),
    displayName,
    avatarKey: null,
    maxRating: null,
    instant: INSTANT
  });
  if (!created.ok) throw new Error(`expected a profile, got ${created.reason}`);
  return created.profile.id;
}

/*
 * The gate on the constructor itself, which is the runtime half of a control
 * whose other half is a type.
 *
 * `createInMemoryRepository` is re-exported from `./index.ts` and can be called
 * without going through `selectRepository`, so it asks the contracts registry as
 * its own first statement. Both forgeries a compile-time brand cannot stop are
 * exercised, matching `packages/provider-sdk/src/fixture/provider.test.ts`: the
 * cast is the blunt one, and the SPREAD is the subtle one -- it copies the brand,
 * needs no cast, and only object identity tells it from the real thing.
 *
 * NEITHER CASE THROWS WITHOUT THAT CHECK. A forgery satisfies the parameter's
 * type, carries a `nodeEnv` the adapter is happy to report as `admittedBy`, and
 * would have produced a working volatile store.
 */
describe("a classification the contracts module never issued", () => {
  it("cannot build the development adapter", () => {
    const cast = { nodeEnv: "test" } as unknown as NonDeploymentEnvironment;
    const copied: NonDeploymentEnvironment = { ...classifiedProcess() };

    for (const forged of [cast, copied]) {
      /*
       * A throw rather than a returned reason, because this function's contract
       * is total -- it has no result union to put one in, and the composition
       * root above it publishes `storage_not_configured` properly for the caller
       * that came through it. Matched on the phrase that names the fault rather
       * than on the whole message, so rewording the remedy does not break this.
       */
      expect(() => createInMemoryRepository(forged, createInMemoryStore())).toThrow(
        /was not issued by/
      );
    }
  });

});

describe("profiles", () => {
  it("mints an id the read side recognises, and never takes one from the caller", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");

    /* `loadProfileOwnership` refuses a shape `newProfileId` could not produce
     * before it looks anything up, so a minted id round-tripping is evidence the
     * two agree. */
    const ownership = await store.loadProfileOwnership(id);
    expect(ownership?.profileId).toBe(id);
    expect(ownership?.ownerUserId).toBe(HOUSEHOLD_A.userId);
    expect(ownership?.archivedAt).toBeNull();

    expect(await store.loadProfileOwnership("1")).toBeNull();
  });

  it("normalises the display name and refuses a second profile with the same one", async () => {
    const store = repository();
    await createProfile(store, HOUSEHOLD_A, "  Dad  ");

    /* Normalisation is what makes the uniqueness rule mean anything: without it
     * "Dad " is a second row that renders identically on the picker. */
    const clash = await store.createProfile({
      session: sessionFor(HOUSEHOLD_A, null),
      displayName: "Dad",
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });

    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.reason).toBe("display_name_already_used");
    expect(clash.detail.length).toBeGreaterThan(0);
  });

  it("scopes the uniqueness rule to the account, not to the product", async () => {
    const store = repository();
    await createProfile(store, HOUSEHOLD_A, "Dad");
    /* Two households may both have a "Dad"; the constraint is on
     * (user_id, display_name). This would fail if the scan dropped its owner
     * predicate. */
    await expect(createProfile(store, HOUSEHOLD_B, "Dad")).resolves.toMatch(/[0-9a-f-]{36}/);
  });

  it("refuses a name with no visible characters", async () => {
    const store = repository();
    const blank = await store.createProfile({
      session: sessionFor(HOUSEHOLD_A, null),
      displayName: "   ",
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.reason).toBe("display_name_is_blank");
  });

  it("applies the per-account ceiling", async () => {
    const store = repository();
    for (let index = 0; index < MAX_PROFILES_PER_ACCOUNT; index += 1) {
      await createProfile(store, HOUSEHOLD_A, `Viewer ${String(index)}`);
    }

    const overflow = await store.createProfile({
      session: sessionFor(HOUSEHOLD_A, null),
      displayName: "One too many",
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.reason).toBe("profile_limit_reached");
  });

  it("carries the selection alongside the session rather than on the account", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Kids");
    const session = sessionFor(HOUSEHOLD_A, null);

    const selected = await store.selectActiveProfile({
      session,
      scope: await scopeFor(store, session, id),
      instant: INSTANT
    });
    expect(selected.ok).toBe(true);

    /* The SAME account on a DIFFERENT session sees no selection. Selecting on
     * the television must not move the phone. */
    const television = await store.resolveSession(HOUSEHOLD_A);
    const phone = await store.resolveSession({ userId: HOUSEHOLD_A.userId, sessionId: "phone" });
    expect(television.activeProfileId).toBe(id);
    expect(phone.activeProfileId).toBeNull();
  });

  it("refuses a scope granted to another session's account", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const sessionA = sessionFor(HOUSEHOLD_A, null);
    const scope = await scopeFor(store, sessionA, id);

    /* The brand proves SOME session was authorized; `grantedFor` is what proves
     * it was this one. A scope captured in a closure or a cache must not work
     * under another account. */
    const leaked = await store.selectActiveProfile({
      session: sessionFor(HOUSEHOLD_B, null),
      scope,
      instant: INSTANT
    });
    expect(leaked.ok).toBe(false);
    if (leaked.ok) return;
    expect(leaked.reason).toBe("scope_not_granted_to_this_session");
  });
});

describe("progress", () => {
  it("creates a row with no position when a lease is issued", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    const lease = await store.issueWriterLease({
      scope,
      contentId: "aurora-fall",
      writerId: "television",
      instant: INSTANT
    });
    expect(lease.ok && lease.epoch).toBe(1);

    const row = await store.readProgress({ scope, contentId: "aurora-fall" });
    if (row === null || isProgressFailure(row)) throw new Error("expected a leased row");
    /* NULL, NOT ZERO: a lease is a claim on the right to write, not a write. A 0
     * here would put the title at the top of "continue watching" at 0:00. */
    expect(row.positionSeconds).toBeNull();
    expect(row.runtimeSeconds).toBeNull();
  });

  it("lets the current writer rewind, and refuses a superseded one at any position", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    const television = await store.issueWriterLease({
      scope,
      contentId: "aurora-fall",
      writerId: "television",
      instant: INSTANT
    });
    if (!television.ok) throw new Error(television.reason);

    const first = await store.writeProgress({
      scope,
      contentId: "aurora-fall",
      write: {
        lease: { epoch: television.epoch, writerId: "television" },
        writeSeq: 1,
        positionSeconds: 600,
        runtimeSeconds: 7200
      },
      instant: INSTANT
    });
    if ("ok" in first) throw new Error(first.reason);
    expect(first.accepted).toBe(true);

    /* A REWIND IS NOT A CONFLICT. The rejected "position must increase" rule
     * would refuse this, which is why it was rejected. */
    const rewind = await store.writeProgress({
      scope,
      contentId: "aurora-fall",
      write: {
        lease: { epoch: television.epoch, writerId: "television" },
        writeSeq: 2,
        positionSeconds: 570,
        runtimeSeconds: null
      },
      instant: INSTANT
    });
    if ("ok" in rewind) throw new Error(rewind.reason);
    expect(rewind.accepted).toBe(true);
    if (!rewind.accepted) return;
    expect(rewind.notes).toContain("position_moved_backwards");
    /* An unknown runtime must not overwrite a known one. */
    expect(rewind.notes).toContain("retained_known_runtime");
    expect(rewind.next.runtimeSeconds).toBe(7200);

    /* The phone takes over. The television is now stale whatever it says. */
    const phone = await store.issueWriterLease({
      scope,
      contentId: "aurora-fall",
      writerId: "phone",
      instant: INSTANT
    });
    if (!phone.ok) throw new Error(phone.reason);
    expect(phone.epoch).toBe(television.epoch + 1);

    const superseded = await store.writeProgress({
      scope,
      contentId: "aurora-fall",
      write: {
        lease: { epoch: television.epoch, writerId: "television" },
        writeSeq: 3,
        positionSeconds: 900,
        runtimeSeconds: null
      },
      instant: INSTANT
    });
    if ("ok" in superseded) throw new Error(superseded.reason);
    expect(superseded.accepted).toBe(false);
    if (superseded.accepted) return;
    expect(superseded.reason).toBe("superseded_by_newer_writer");

    /* Taking the lease did not move the resume point. */
    const row = await store.readProgress({ scope, contentId: "aurora-fall" });
    if (row === null || isProgressFailure(row)) throw new Error("expected a stored row");
    expect(row.positionSeconds).toBe(570);
  });

  it("refuses a content id the contracts schema rejects, without touching storage", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    const result = await store.readProgress({ scope, contentId: "../etc/passwd" });
    if (result === null || !isProgressFailure(result)) {
      throw new Error("expected a boundary refusal");
    }
    expect(result.reason).toBe("not_a_normalized_content_id");
  });

  it("keeps one profile's progress invisible to another", async () => {
    const store = repository();
    const dad = await createProfile(store, HOUSEHOLD_A, "Dad");
    const kids = await createProfile(store, HOUSEHOLD_A, "Kids");
    const session = sessionFor(HOUSEHOLD_A, null);
    const dadScope = await scopeFor(store, session, dad);
    const kidsScope = await scopeFor(store, session, kids);

    const lease = await store.issueWriterLease({
      scope: dadScope,
      contentId: "aurora-fall",
      writerId: "television",
      instant: INSTANT
    });
    expect(lease.ok).toBe(true);

    /* Same household, same title, different profile: a shared list is a
     * different and worse product, and this is the row-level half of that. */
    expect(await store.readProgress({ scope: kidsScope, contentId: "aurora-fall" })).toBeNull();
  });
});

describe("continue watching (PW-0305)", () => {
  /**
   * Written because the port's own header says why it must be: a port method
   * whose in-memory implementation is never executed is a guess about
   * behaviour rather than a statement of it, and this is the implementation
   * `next dev`, vitest and CI actually run. The PostgreSQL one is a delegation
   * nothing in this environment can exercise.
   */
  async function watched(
    store: LibertyRepository,
    scope: Awaited<ReturnType<typeof scopeFor>>,
    contentId: string,
    positionSeconds: number,
    instant: Date
  ): Promise<void> {
    const lease = await store.issueWriterLease({ scope, contentId, writerId: "tv", instant });
    if (!lease.ok) throw new Error(lease.reason);
    const written = await store.writeProgress({
      scope,
      contentId,
      write: {
        lease: { epoch: lease.epoch, writerId: "tv" },
        writeSeq: 1,
        positionSeconds,
        runtimeSeconds: 7200
      },
      instant
    });
    if ("ok" in written) throw new Error(written.reason);
  }

  it("excludes a leased row, because a lease is a claim and not progress", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    /*
     * THE DEFECT THIS EXCLUDES IS A REAL ONE THAT SHIPPED ONCE. When a lease
     * wrote `positionSeconds: 0`, opening a title put it at the top of
     * "continue watching" at 0:00 with nothing to resume from. `null` is what
     * makes the two states distinguishable, and this filter is what spends the
     * distinction.
     */
    await store.issueWriterLease({
      scope,
      contentId: "aurora-fall",
      writerId: "tv",
      instant: INSTANT
    });

    const listed = await store.listContinueWatching({ scope, limit: 10 });
    if (isLimitRejection(listed)) throw new Error(listed.reason);
    expect(listed).toEqual([]);
  });

  it("orders most recently updated first, with a total order", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    /* `alpha` and `beta` are written in the SAME instant. Without the
     * content-id tie-break their order depends on insertion order, which is how
     * a paginated list drops and repeats rows. */
    await watched(store, scope, "alpha", 100, INSTANT);
    await watched(store, scope, "beta", 200, INSTANT);
    await watched(store, scope, "gamma", 300, new Date("2026-09-05T10:00:00.000Z"));

    const listed = await store.listContinueWatching({ scope, limit: 10 });
    if (isLimitRejection(listed)) throw new Error(listed.reason);
    expect(listed.map((row) => row.contentId)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("is scoped to one profile and does not leak a sibling's viewing", async () => {
    /*
     * The property the whole ProfileScope apparatus exists for, asserted on
     * this method rather than assumed from the others. A continue-watching rail
     * that showed another household member's titles is a privacy failure that
     * looks exactly like a working feature.
     */
    const store = repository();
    const dad = await createProfile(store, HOUSEHOLD_A, "Dad");
    const kid = await createProfile(store, HOUSEHOLD_A, "Kid");
    const dadScope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), dad);
    const kidScope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), kid);

    await watched(store, dadScope, "aurora-fall", 600, INSTANT);
    await watched(store, kidScope, "northstar", 300, INSTANT);

    const dadList = await store.listContinueWatching({ scope: dadScope, limit: 10 });
    if (isLimitRejection(dadList)) throw new Error(dadList.reason);
    expect(dadList.map((row) => row.contentId)).toEqual(["aurora-fall"]);

    const kidList = await store.listContinueWatching({ scope: kidScope, limit: 10 });
    if (isLimitRejection(kidList)) throw new Error(kidList.reason);
    expect(kidList.map((row) => row.contentId)).toEqual(["northstar"]);
  });

  it("honours the limit rather than returning everything", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    await watched(store, scope, "alpha", 100, new Date("2026-09-05T10:00:00.000Z"));
    await watched(store, scope, "beta", 200, new Date("2026-09-05T11:00:00.000Z"));
    await watched(store, scope, "gamma", 300, new Date("2026-09-05T12:00:00.000Z"));

    const listed = await store.listContinueWatching({ scope, limit: 2 });
    if (isLimitRejection(listed)) throw new Error(listed.reason);
    expect(listed.map((row) => row.contentId)).toEqual(["gamma", "beta"]);
  });

  it("refuses a limit that is not a representable page size", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    const rejected = await store.listContinueWatching({ scope, limit: Number.NaN });
    if (!isLimitRejection(rejected)) throw new Error("expected a limit refusal");
    expect(rejected.reason).toBe("limit_not_representable");
  });
});

describe("watchlist", () => {
  it("is idempotent in both directions and reports which of the four happened", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    const added = await store.addToWatchlist({ scope, contentId: "northstar", instant: INSTANT });
    if ("ok" in added) throw new Error(added.reason);
    expect(added.accepted && added.reason).toBe("added");
    expect(added.accepted && added.changed).toBe(true);

    const later = new Date("2026-09-05T10:00:00.000Z");
    const again = await store.addToWatchlist({ scope, contentId: "northstar", instant: later });
    if ("ok" in again) throw new Error(again.reason);
    expect(again.accepted && again.reason).toBe("already_present");
    expect(again.accepted && again.changed).toBe(false);

    /* THE FIRST ADD WINS THE SORT KEY. Re-adding must not move an entry the
     * viewer never touched to the top of the list. */
    const listed = await store.listWatchlist({ scope, limit: 10 });
    if (isLimitRejection(listed)) throw new Error(listed.reason);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.addedAt.toISOString()).toBe(INSTANT.toISOString());

    const removed = await store.removeFromWatchlist({ scope, contentId: "northstar" });
    if ("ok" in removed) throw new Error(removed.reason);
    expect(removed.accepted && removed.reason).toBe("removed");

    /* Removing something absent is a success: the caller is a button on a remote
     * control behind an unreliable network, and a retry must converge. */
    const absent = await store.removeFromWatchlist({ scope, contentId: "northstar" });
    if ("ok" in absent) throw new Error(absent.reason);
    expect(absent.accepted && absent.reason).toBe("not_present");
    expect(absent.accepted && absent.changed).toBe(false);
  });

  it("orders most recently added first with a total order", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    /* Two entries added in the SAME instant. Without the content-id tie-break the
     * order would depend on insertion order, which is what makes a paginated list
     * drop and repeat rows. */
    await store.addToWatchlist({ scope, contentId: "alpha", instant: INSTANT });
    await store.addToWatchlist({ scope, contentId: "beta", instant: INSTANT });
    await store.addToWatchlist({
      scope,
      contentId: "gamma",
      instant: new Date("2026-09-05T10:00:00.000Z")
    });

    const listed = await store.listWatchlist({ scope, limit: 10 });
    if (isLimitRejection(listed)) throw new Error(listed.reason);
    expect(listed.map((entry) => entry.contentId)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("refuses a limit that is not a representable page size", async () => {
    const store = repository();
    const id = await createProfile(store, HOUSEHOLD_A, "Dad");
    const scope = await scopeFor(store, sessionFor(HOUSEHOLD_A, null), id);

    const rejected = await store.listWatchlist({ scope, limit: Number.NaN });
    if (!isLimitRejection(rejected)) throw new Error("expected a limit refusal");
    expect(rejected.reason).toBe("limit_not_representable");
  });
});

/* -------------------------------------------------------------------------
 * One store per PROCESS, not one per module graph (PW-0313)
 *
 * WHAT THIS SUITE IS ABOUT. Next's app router compiles the React Server
 * Components graph and the route-handler graph separately, so a module-level
 * binding is per-graph and this module was evaluated twice in one Node
 * process. A profile selected through the API was invisible to every server
 * component; PW-0305's continue-watching rail therefore rendered nothing on
 * every in-memory deployment, silently, from the day it was marked DONE.
 *
 * WHAT A UNIT SUITE CAN AND CANNOT SHOW. It cannot build two Next module
 * graphs, so it cannot reproduce the original defect. What it CAN pin is the
 * three properties the fix rests on, and each is asserted against the real
 * exported functions rather than against a description of them:
 *
 *   1. two independent asks inside one realm get the same store;
 *   2. a DIFFERENT realm -- a real second `node` process -- gets nothing,
 *      which is what keeps "in-memory" honest;
 *   3. the sharing is opt-in at the composition root, so every direct
 *      construction stays isolated and no existing suite becomes
 *      order-dependent.
 *
 * The end-to-end proof that the two graphs now agree is the e2e layer's, and
 * it is the only layer that can give one.
 * ---------------------------------------------------------------------- */

describe("the process store (PW-0313)", () => {
  /*
   * THE RESET IS IN `beforeEach` AND NOT ONLY IN THE TESTS THAT DIRTY IT.
   * gpt-architect's round-101 evidence item 7: "test reset/isolation must be
   * explicit so one test cannot inherit another test's process-global
   * repository accidentally." A process-global is shared state, and shared
   * state between tests is the order-dependence this repository has been
   * bitten by six times.
   */
  beforeEach(() => {
    resetProcessInMemoryStore();
  });

  afterEach(() => {
    /* And again afterwards, so a test in ANOTHER file that reaches
     * `selectRepository`'s in-memory branch does not inherit this suite's
     * rows. The two hooks are not redundant: the first protects this suite
     * from the world, the second protects the world from this suite. */
    resetProcessInMemoryStore();
  });

  it("hands the same store to every caller in one realm", () => {
    /* The property the whole fix is: two module graphs are two callers, and
     * what they must get is one object. */
    expect(processInMemoryStore()).toBe(processInMemoryStore());
  });

  it("SHARES WRITES between two repositories built the way the two graphs build them", async () => {
    /*
     * The closest a unit test can get to the real defect. Each repository is
     * constructed separately -- as the two graphs construct theirs -- over the
     * store the composition root hands out. A write through one is a read
     * through the other.
     */
    const writer = createInMemoryRepository(classifiedProcess(), processInMemoryStore());
    const reader = createInMemoryRepository(classifiedProcess(), processInMemoryStore());

    await createProfile(writer, HOUSEHOLD_A, "Shared");

    const seen = await reader.listProfilesForAccount(sessionFor(HOUSEHOLD_A, null));
    expect(seen.map((row) => row.displayName)).toEqual(["Shared"]);
  });

  it("shares in BOTH directions, not only from the route handler to the page", async () => {
    /*
     * Evidence item 3. The defect was symmetrical and the fix must be: a
     * server component that writes -- which nothing does today, and which
     * nothing should be prevented from doing by the storage layer -- must be
     * visible to a route handler too.
     */
    const first = createInMemoryRepository(classifiedProcess(), processInMemoryStore());
    const second = createInMemoryRepository(classifiedProcess(), processInMemoryStore());

    await createProfile(second, HOUSEHOLD_B, "Other way");

    expect(
      (await first.listProfilesForAccount(sessionFor(HOUSEHOLD_B, null))).map((r) => r.displayName)
    ).toEqual(["Other way"]);
  });

  it("is NOT what `createInMemoryRepository` defaults to, so every other suite stays isolated", async () => {
    /*
     * The decision that keeps this fix from making the whole app's test suite
     * order-dependent in one commit. Sharing is a property of the COMPOSITION
     * ROOT -- `selectRepository` asks for the process store -- and not of the
     * constructor. Every direct construction in this repository, including
     * `repository()` at the top of this file, still gets a fresh store.
     */
    const isolated = createInMemoryRepository(classifiedProcess());
    await createProfile(isolated, HOUSEHOLD_A, "Private");

    const shared = createInMemoryRepository(classifiedProcess(), processInMemoryStore());
    expect(await shared.listProfilesForAccount(sessionFor(HOUSEHOLD_A, null))).toEqual([]);
  });

  it("is thrown away by the reset, and the next ask builds a new one", async () => {
    const before = processInMemoryStore();
    const repo = createInMemoryRepository(classifiedProcess(), before);
    await createProfile(repo, HOUSEHOLD_A, "Transient");
    expect(before.profiles.size).toBe(1);

    resetProcessInMemoryStore();

    const after = processInMemoryStore();
    expect(after).not.toBe(before);
    expect(after.profiles.size).toBe(0);
    /* The old object is left COHERENT rather than emptied, so anything still
     * holding it sees a consistent store instead of one that vanished under
     * it. That is why the reset deletes the slot and does not call `.clear()`. */
    expect(before.profiles.size).toBe(1);
  });

  it("DOES NOT CROSS PROCESSES -- asserted in a real second node, not from the manual", () => {
    /*
     * Evidence item 6: "separate processes must NOT accidentally share
     * memory." The honest way to show it is to start another process and look,
     * because the alternative -- reasoning that `globalThis` is per-realm -- is
     * a claim about Node rather than about this module.
     *
     * The child uses `IN_MEMORY_STORE_GLOBAL_KEY`, THE REAL EXPORTED CONSTANT,
     * interpolated from this import. A copied string literal would keep
     * passing after the key was renamed, which is the one way this test could
     * rot into a check on nothing.
     *
     * It also writes to the slot before reading, so the second child cannot
     * pass merely because the first one never wrote anything.
     */
    const program = [
      `const slot = Symbol.for(${JSON.stringify(IN_MEMORY_STORE_GLOBAL_KEY)});`,
      `const inherited = globalThis[slot] === undefined ? "absent" : "present";`,
      `globalThis[slot] = { written: true };`,
      `process.stdout.write(inherited);`
    ].join("");

    const first = execFileSync(process.execPath, ["-e", program], { encoding: "utf8" });
    const second = execFileSync(process.execPath, ["-e", program], { encoding: "utf8" });

    expect(first).toBe("absent");
    expect(second).toBe("absent");

    /* And this process is unaffected by either of them, which is the same
     * property from the other side. */
    expect(processInMemoryStore().profiles.size).toBe(0);
  });

  it("writes nothing outside the realm's global object", async () => {
    /*
     * The ruling is explicit: "do not persist this data to disk merely to
     * solve module identity." A source rule rather than a behavioural one,
     * because the absence of a write is not observable by calling anything --
     * and with a non-vacuity check, since a rule whose own file does not
     * contain the thing it forbids is a rule that cannot fail.
     */
    const source = (await readFile(new URL("./in-memory-repository.ts", import.meta.url), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    for (const forbidden of ["node:fs", "node:path", "localStorage", "writeFile"]) {
      expect(source, `${forbidden} has no business in a volatile store`).not.toContain(forbidden);
    }
    expect(source, "the global anchor is what this rule is about").toContain("Symbol.for");
  });
});
