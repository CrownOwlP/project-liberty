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
import { describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../app/api/deployment-environment";
import { createInMemoryRepository, createInMemoryStore } from "./in-memory-repository";
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
 * A repository admitted by the `test` environment.
 *
 * `classify` is called with an explicit value rather than being left to read
 * `process.env`, so the suite does not depend on -- or race -- whatever another
 * suite in the same worker has done to it.
 */
function repository(): LibertyRepository {
  const environment = NonDeploymentEnvironment.classify("test");
  /*
   * Not a `!`. The whole point of the witness is that the `null` is handled, and
   * a test that reached for a non-null assertion would be demonstrating the
   * opposite of what the type is for. `"test"` is on the allowlist, so this
   * never fires.
   */
  if (environment === null) throw new Error('NonDeploymentEnvironment.classify rejected "test"');
  return createInMemoryRepository(environment, createInMemoryStore());
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

function isLimitRejection(
  value: readonly WatchlistEntryRow[] | ListLimitRejection
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
