import { describe, expect, it } from "vitest";
import { runIngestionPass, type IngestionPassOptions, type IngestionPassResult } from "./ingest";
import type {
  CatalogMetadataProvider,
  ProviderCapabilities,
  ProviderPageResult,
  RawProviderRecord
} from "./provider";
import {
  applyPassToSnapshot,
  createInMemoryCatalogStore,
  emptyCatalogSnapshot,
  hasStoredCatalogState,
  knownContentIdsOf,
  partitionCatalogWorks,
  type CatalogStoreSnapshot
} from "./store";

/* -------------------------------------------------------------------------
 * What a pass does to stored state
 *
 * EVERY PASS RESULT IN THIS FILE IS A REAL ONE. `runIngestionPass` is driven
 * against scripted providers rather than hand-building an `IngestionPassResult`,
 * because the rules under test are about the INTERACTION between the pass's own
 * tombstone discipline and the store's -- `complete`, `tombstonesWithheld` and
 * the difference between a declared withdrawal and an inferred absence. A
 * hand-written result would let a test assert a combination the pass can never
 * produce, and the two most dangerous rules here are exactly the ones that would
 * then never be exercised.
 * ---------------------------------------------------------------------- */

const SOURCE = "example-source";
const T0 = Date.parse("2026-09-16T00:00:00.000Z");
const MINUTE = 60_000;

const CAPABILITIES: ProviderCapabilities = {
  providerSideSearch: false,
  incrementalSince: true,
  reportsDeletions: false,
  maxPageSize: 100
};

const rawWork = (nativeId: string, over: Record<string, unknown> = {}): unknown => ({
  contentId: `${SOURCE}-${nativeId}`,
  kind: "movie",
  titles: [{ locale: "en", value: `Work ${nativeId}` }],
  synopses: [],
  genres: [{ locale: "en", value: "Drama" }],
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  availability: [{ territory: "WW", startsAt: null, endsAt: null }],
  artwork: [],
  rights: { category: "public-domain", reference: null },
  ...over
});

const record = (nativeId: string, over: Record<string, unknown> = {}): RawProviderRecord => ({
  nativeId,
  sourceRevision: null,
  crossRefs: [],
  raw: rawWork(nativeId, over)
});

const providerOf = (
  pages: readonly ProviderPageResult[],
  capabilities: ProviderCapabilities = CAPABILITIES,
  sourceId: string = SOURCE
): CatalogMetadataProvider => {
  let index = 0;
  return {
    sourceId,
    capabilities,
    fetchPage: () => {
      const page = pages[index];
      index += 1;
      if (page === undefined) throw new Error("the pass asked for more pages than were scripted");
      return Promise.resolve(page);
    }
  };
};

const options = (over: Partial<IngestionPassOptions> = {}): IngestionPassOptions => ({
  pageSize: 50,
  maxPages: 10,
  resumeCursor: null,
  changedSince: null,
  knownContentIds: [],
  ...over
});

/** One complete pass over the given native ids, observed at `atMs`. */
const completePass = (
  nativeIds: readonly string[],
  atMs: number,
  known: CatalogStoreSnapshot | null = null
): Promise<IngestionPassResult> =>
  runIngestionPass(
    providerOf([
      { ok: true, records: nativeIds.map((id) => record(id)), nextCursor: null, withdrawn: [] }
    ]),
    options({ knownContentIds: knownContentIdsOf(known) }),
    { now: () => atMs }
  );

/** One pass stopped by the page bound: successful, incomplete, deletes nothing. */
const partialPass = (
  nativeIds: readonly string[],
  atMs: number,
  known: CatalogStoreSnapshot | null = null
): Promise<IngestionPassResult> =>
  runIngestionPass(
    providerOf([
      { ok: true, records: nativeIds.map((id) => record(id)), nextCursor: "more", withdrawn: [] }
    ]),
    options({ maxPages: 1, knownContentIds: knownContentIdsOf(known) }),
    { now: () => atMs }
  );

const failedPass = (atMs: number, known: CatalogStoreSnapshot | null = null) =>
  runIngestionPass(
    providerOf([{ ok: false, reason: "provider_unreachable", detail: "the name did not resolve" }]),
    options({ knownContentIds: knownContentIdsOf(known) }),
    { now: () => atMs }
  );

const ids = (snapshot: CatalogStoreSnapshot): readonly string[] =>
  snapshot.works.map((work) => work.work.contentId);

/* ---------------------------------------------------------------------- */

describe("a store starts empty and fills from a pass", () => {
  it("answers null until something is committed", async () => {
    const store = createInMemoryCatalogStore();
    expect(await store.read()).toBeNull();
    expect(hasStoredCatalogState(await store.read())).toBe(false);
  });

  it("stores what a complete pass accepted and dates the state by its records", async () => {
    const store = createInMemoryCatalogStore();
    const snapshot = await store.commit({ result: await completePass(["a", "b"], T0), endedAtMs: T0 + 5 });

    expect(ids(snapshot)).toEqual([`${SOURCE}-a`, `${SOURCE}-b`]);
    expect(snapshot.observedAt).toBe(new Date(T0).toISOString());
    expect(snapshot.complete).toBe(true);
    expect(snapshot.lastRefresh).toEqual({
      status: "succeeded",
      endedAtMs: T0 + 5,
      failure: null,
      consecutiveFailures: 0
    });
    expect(await store.read()).toEqual(snapshot);
  });

  /*
   * WHAT THIS CATCHES: a successful pass over an empty source leaving the state
   * undated. An empty catalog that nobody can date is indistinguishable from a
   * catalog nobody has ever read, and the second must keep throwing while the
   * first is a servable answer.
   */
  it("dates an empty successful pass by the pass's own observation instant", async () => {
    const snapshot = await createInMemoryCatalogStore().commit({
      result: await completePass([], T0),
      endedAtMs: T0
    });

    expect(snapshot.works).toEqual([]);
    expect(snapshot.observedAt).toBe(new Date(T0).toISOString());
    expect(hasStoredCatalogState(snapshot)).toBe(true);
  });

  /*
   * WHAT THIS CATCHES: the age of a merged state being taken from the newest
   * record. `projectCatalogAnswer` dates a set by its OLDEST member because a
   * rail is as current as its stalest row, and a store that dated itself by the
   * freshest row would let one just-refreshed record describe a page of week-old
   * ones as current.
   */
  it("dates a merged state by its oldest record, not its newest", async () => {
    const store = createInMemoryCatalogStore();
    await store.commit({ result: await completePass(["a"], T0), endedAtMs: T0 });
    const snapshot = await store.commit({
      result: await partialPass(["b"], T0 + 30 * MINUTE),
      endedAtMs: T0 + 30 * MINUTE
    });

    expect(ids(snapshot)).toEqual([`${SOURCE}-a`, `${SOURCE}-b`]);
    expect(snapshot.observedAt).toBe(new Date(T0).toISOString());
  });
});

describe("a failed pass leaves the previous state alone", () => {
  /*
   * WHAT THIS CATCHES: the two obvious wrong answers to a failed refresh --
   * emptying the state, which deletes a catalog because a provider had a bad
   * afternoon, and merging the prefix it managed to read, which makes "the
   * previous state" a moving target. Every record-bearing field must be
   * byte-identical afterwards; only the refresh record moves.
   */
  it("changes no records, no refusals and no age", async () => {
    const store = createInMemoryCatalogStore();
    const before = await store.commit({ result: await completePass(["a", "b"], T0), endedAtMs: T0 });
    const after = await store.commit({
      result: await failedPass(T0 + 10 * MINUTE, before),
      endedAtMs: T0 + 10 * MINUTE
    });

    expect(after.works).toEqual(before.works);
    expect(after.refused).toEqual(before.refused);
    expect(after.observedAt).toBe(before.observedAt);
    expect(after.complete).toBe(before.complete);
    expect(after.lastRefresh).toEqual({
      status: "failed",
      endedAtMs: T0 + 10 * MINUTE,
      failure: { reason: "provider_unreachable", detail: "the name did not resolve" },
      consecutiveFailures: 1
    });
  });

  /*
   * WHAT THIS CATCHES: a failure count that does not accumulate, or does not
   * reset. The first makes the backoff flat -- a provider that has been down all
   * morning is asked as often as one that failed once -- and the second leaves a
   * recovered provider permanently backed off.
   */
  it("accumulates consecutive failures and resets them on a success", async () => {
    const store = createInMemoryCatalogStore();
    let snapshot = await store.commit({ result: await failedPass(T0), endedAtMs: T0 });
    expect(snapshot.lastRefresh.consecutiveFailures).toBe(1);
    expect(hasStoredCatalogState(snapshot)).toBe(false);

    snapshot = await store.commit({ result: await failedPass(T0 + MINUTE), endedAtMs: T0 + MINUTE });
    expect(snapshot.lastRefresh.consecutiveFailures).toBe(2);

    snapshot = await store.commit({
      result: await completePass(["a"], T0 + 2 * MINUTE),
      endedAtMs: T0 + 2 * MINUTE
    });
    expect(snapshot.lastRefresh.consecutiveFailures).toBe(0);
    expect(snapshot.lastRefresh.status).toBe("succeeded");
  });

  /*
   * WHAT THIS CATCHES: a failed pass swallowing a deletion the source stated.
   * `ingest.ts` mints `withdrawn_by_source` whatever else it withholds, because
   * it rests on the source's own statement rather than on the pass having seen
   * everything, and dropping it here would keep serving a work the provider said
   * was gone. Applying it is also the fail-closed direction: it publishes less.
   */
  it("still applies a withdrawal the source declared before the pass failed", async () => {
    const store = createInMemoryCatalogStore();
    const before = await store.commit({ result: await completePass(["a", "b"], T0), endedAtMs: T0 });

    const result = await runIngestionPass(
      providerOf(
        [
          { ok: true, records: [], nextCursor: "next", withdrawn: ["a"] },
          { ok: false, reason: "provider_rejected_request", detail: "400" }
        ],
        { ...CAPABILITIES, reportsDeletions: true }
      ),
      options({ knownContentIds: knownContentIdsOf(before) }),
      { now: () => T0 + MINUTE }
    );
    expect(result.failure).not.toBeNull();
    expect(result.tombstonesWithheld).toBe("pass_failed");

    const after = await store.commit({ result, endedAtMs: T0 + MINUTE });
    expect(ids(after)).toEqual([`${SOURCE}-a`, `${SOURCE}-b`]);
    const partition = partitionCatalogWorks(after);
    expect(partition.live.map((work) => work.work.contentId)).toEqual([`${SOURCE}-b`]);
    expect(partition.tombstoned.map((entry) => entry.tombstone.reason)).toEqual([
      "withdrawn_by_source"
    ]);
  });
});

describe("tombstones survive a refresh", () => {
  /*
   * THE RULE THIS WHOLE FILE EXISTS FOR, walked from end to end in one test
   * because each step only means something next to the others.
   *
   * WHAT IT CATCHES: a store that replaces its tombstone list from each pass
   * result. A previously tombstoned id is deliberately NOT in the ids handed to
   * the next pass -- it is not a live work -- so a complete pass never
   * re-reports it, and a wholesale replacement would therefore drop the
   * tombstone and put a withdrawn work straight back on a rail. The union is
   * what makes a tombstone survive.
   */
  it("keeps a tombstone across later passes that do not observe the work completely", async () => {
    const store = createInMemoryCatalogStore();

    let snapshot = await store.commit({ result: await completePass(["a", "b"], T0), endedAtMs: T0 });
    expect(snapshot.tombstones).toEqual([]);

    // A complete pass that no longer lists `b` proves it is gone.
    snapshot = await store.commit({
      result: await completePass(["a"], T0 + MINUTE, snapshot),
      endedAtMs: T0 + MINUTE
    });
    expect(snapshot.tombstones.map((tombstone) => tombstone.contentId)).toEqual([`${SOURCE}-b`]);
    expect(snapshot.tombstones[0]?.reason).toBe("absent_from_complete_sync");
    expect(knownContentIdsOf(snapshot)).toEqual([`${SOURCE}-a`]);

    // Two further complete passes that also do not list it must not lose it,
    // even though it is no longer in the known set they were given.
    snapshot = await store.commit({
      result: await completePass(["a"], T0 + 2 * MINUTE, snapshot),
      endedAtMs: T0 + 2 * MINUTE
    });
    snapshot = await store.commit({
      result: await completePass(["a"], T0 + 3 * MINUTE, snapshot),
      endedAtMs: T0 + 3 * MINUTE
    });
    expect(snapshot.tombstones.map((tombstone) => tombstone.contentId)).toEqual([`${SOURCE}-b`]);
  });

  /*
   * WHAT THIS CATCHES: a partial pass resurrecting a withdrawn work. This is the
   * asymmetry the rule turns on -- a tombstone may only be minted by a pass that
   * enumerated the whole source, so it may only be lifted by one. A provider
   * serving an incremental or truncated page from a lagging replica would
   * otherwise undo a deletion that a complete pass established.
   *
   * The work IS stored again, and is still not served: the store keeps what the
   * source returned so a later complete pass can legitimately release it, and
   * the partition is what decides what a read may see.
   */
  it("does not let a partial pass release a tombstone, even when it returns the work", async () => {
    const store = createInMemoryCatalogStore();
    let snapshot = await store.commit({ result: await completePass(["a", "b"], T0), endedAtMs: T0 });
    snapshot = await store.commit({
      result: await completePass(["a"], T0 + MINUTE, snapshot),
      endedAtMs: T0 + MINUTE
    });

    const resurrecting = await partialPass(["a", "b"], T0 + 2 * MINUTE, snapshot);
    expect(resurrecting.complete).toBe(false);
    expect(resurrecting.accepted.map((work) => work.work.contentId)).toContain(`${SOURCE}-b`);

    snapshot = await store.commit({ result: resurrecting, endedAtMs: T0 + 2 * MINUTE });

    expect(snapshot.tombstones.map((tombstone) => tombstone.contentId)).toEqual([`${SOURCE}-b`]);
    const partition = partitionCatalogWorks(snapshot);
    expect(partition.live.map((work) => work.work.contentId)).toEqual([`${SOURCE}-a`]);
    expect(partition.tombstoned.map((entry) => entry.work.work.contentId)).toEqual([`${SOURCE}-b`]);
  });

  /*
   * WHAT THIS CATCHES: a tombstone that can never be lifted. A work that really
   * does come back -- restored upstream after a mistaken deletion -- must become
   * servable again, or the fail-closed rule above turns into a permanent
   * blocklist that only a redeploy clears.
   */
  it("releases a tombstone when a complete pass accepts the work again", async () => {
    const store = createInMemoryCatalogStore();
    let snapshot = await store.commit({ result: await completePass(["a", "b"], T0), endedAtMs: T0 });
    snapshot = await store.commit({
      result: await completePass(["a"], T0 + MINUTE, snapshot),
      endedAtMs: T0 + MINUTE
    });
    expect(snapshot.tombstones).toHaveLength(1);

    snapshot = await store.commit({
      result: await completePass(["a", "b"], T0 + 2 * MINUTE, snapshot),
      endedAtMs: T0 + 2 * MINUTE
    });

    expect(snapshot.tombstones).toEqual([]);
    expect(partitionCatalogWorks(snapshot).live.map((work) => work.work.contentId)).toEqual([
      `${SOURCE}-a`,
      `${SOURCE}-b`
    ]);
  });
});

describe("what a pass replaces and what it merges", () => {
  it("lets a complete pass replace the record set and marks the state complete", async () => {
    const store = createInMemoryCatalogStore();
    let snapshot = await store.commit({ result: await partialPass(["a"], T0), endedAtMs: T0 });
    expect(snapshot.complete).toBe(false);

    snapshot = await store.commit({
      result: await completePass(["b"], T0 + MINUTE, snapshot),
      endedAtMs: T0 + MINUTE
    });
    expect(ids(snapshot)).toEqual([`${SOURCE}-b`]);
    expect(snapshot.complete).toBe(true);
  });

  /*
   * WHAT THIS CATCHES: per-record refusals being treated as a transient of the
   * pass rather than as state. The refusals are how "a source listed works and
   * none of them may be surfaced" stays distinguishable from "the source listed
   * nothing", and if they evaporated with the pass that produced them, the
   * second read after a refresh would report an empty catalog for a deployment
   * whose every record was refused for want of a rights basis.
   */
  it("stores the refusals a pass produced so a later read can still explain itself", async () => {
    const store = createInMemoryCatalogStore();
    const result = await runIngestionPass(
      providerOf([
        {
          ok: true,
          records: [record("a", { rights: null }), record("b", { rights: null })],
          nextCursor: null,
          withdrawn: []
        }
      ]),
      options(),
      { now: () => T0 }
    );

    const snapshot = await store.commit({ result, endedAtMs: T0 });
    expect(snapshot.works).toEqual([]);
    expect(snapshot.refused.map((refusal) => refusal.reason)).toEqual([
      "rights_basis_not_declared",
      "rights_basis_not_declared"
    ]);
    expect((await store.read())?.refused).toHaveLength(2);
  });
});

describe("a store is scoped to one source", () => {
  /*
   * WHAT THIS CATCHES: a store wired to the wrong provider. A complete pass of
   * provider A committed over provider B's state would replace B's records with
   * A's and tombstone the rest -- the multi-source spelling of the deletion bug
   * `IngestionPassOptions.knownContentIds` is scoped to prevent. There is no
   * correct merge here, so this is a throw rather than a refusal value.
   */
  it("refuses a pass from a different source outright", async () => {
    const previous = emptyCatalogSnapshot(SOURCE);
    const foreign = await runIngestionPass(
      providerOf([{ ok: true, records: [], nextCursor: null, withdrawn: [] }], CAPABILITIES, "other"),
      options(),
      { now: () => T0 }
    );

    expect(() => applyPassToSnapshot(previous, { result: foreign, endedAtMs: T0 })).toThrow(
      /example-source .* other/
    );
  });
});

describe("a seeded snapshot", () => {
  /*
   * WHAT THIS CATCHES: nothing on its own -- it is the mechanism the read path's
   * re-evaluation test needs. A durable implementation of this port loads state
   * this process did not produce, and `initial` is how that case is reachable
   * without one existing yet.
   */
  it("is what a store answers before anything is committed to it", async () => {
    const seeded = emptyCatalogSnapshot(SOURCE);
    const store = createInMemoryCatalogStore(seeded);
    expect(await store.read()).toEqual(seeded);

    const snapshot = await store.commit({ result: await completePass(["a"], T0), endedAtMs: T0 });
    expect(ids(snapshot)).toEqual([`${SOURCE}-a`]);
  });
});
