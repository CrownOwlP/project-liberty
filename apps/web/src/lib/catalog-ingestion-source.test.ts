import { describe, expect, it } from "vitest";
import {
  LICENSED_CATALOG_SOURCE_IDS,
  WIKIDATA_CC0_HOSTS,
  createInMemoryCatalogStore,
  noRightsBasisEstablished,
  type AcceptedWork,
  type CatalogMetadataProvider,
  type CatalogProviderRuntime,
  type CatalogRefreshSchedule,
  type CatalogStoreSnapshot,
  type EgressPolicy,
  type HostClass,
  type IngestedWork,
  type ManifestFetchDependencies,
  type PinnedFetch,
  type ProviderPageResult,
  type RawProviderRecord
} from "@liberty/catalog-ingestion";
import {
  CatalogMetadataSourceUnavailableError,
  catalogSourceOverProvider,
  createCatalogIngestionSource,
  requireCatalogDescription,
  type CatalogIngestionReadOptions,
  type CatalogIngestionRuntime,
  type CatalogIngestionScheduling
} from "./catalog-ingestion-source";

/* -------------------------------------------------------------------------
 * The adapter that stands @liberty/catalog-ingestion behind the app's port
 *
 * WHAT IS FAKED HERE AND WHAT IS NOT. The PROVIDER is a hand-written object
 * satisfying the package's published `CatalogMetadataProvider`, and nothing
 * else is: `runIngestionPass`, `deriveNormalizedContentId`,
 * `ingestedWorkSchema`, `findMediaAddresses`, `checkRightsBasis` and
 * `projectToCatalogRecord` are the real ones, so a rights refusal in these
 * tests is the package's refusal and not a restatement of it.
 *
 * WHY A HAND-WRITTEN PROVIDER RATHER THAN A RECORDED WIKIDATA RESPONSE. Two
 * reasons, and the second is the one that matters. The rules under test --
 * rights fail closed, availability is not invented, four states stay apart --
 * are source-independent, and a test written against one source's response
 * shape tests that fixture as much as the rule. And `apps/web` must not grow
 * knowledge of a specific source: building a SPARQL response in this directory
 * would be exactly the Wikidata-shaped thing that is supposed to live behind
 * the package boundary. The one test that DOES name the licensed source is the
 * composition test at the foot of this file, and it reaches it only through the
 * package's public API.
 * ---------------------------------------------------------------------- */

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
const SOURCE_ID = "test-source";

const READ: CatalogIngestionReadOptions = {
  locales: ["en"],
  territory: "GB",
  unstatedAvailability: "refuse",
  pageSize: 10,
  maxPages: 3
};

/**
 * A work exactly as a source would state it, with every field a caller can vary.
 *
 * `contentId` IS DERIVED THE WAY THE PASS DERIVES IT -- `<sourceId>-<nativeId>`
 * -- rather than written out, because `runIngestionPass` refuses a record whose
 * stated id does not match its own derivation, and a test that hardcoded the
 * string would be one rename away from asserting that refusal by accident.
 */
const work = (nativeId: string, over: Partial<IngestedWork> = {}): IngestedWork => ({
  contentId: `${SOURCE_ID}-${nativeId}`,
  kind: "movie",
  titles: [{ locale: "en", value: `Work ${nativeId}` }],
  synopses: [],
  genres: [{ locale: "en", value: "Drama" }],
  releaseYear: 2001,
  runtimeMinutes: 101,
  episodeCount: null,
  availability: [{ territory: "WW", startsAt: null, endsAt: null }],
  artwork: [],
  rights: { category: "owned", reference: "rights-register-0001" },
  ...over
});

const raw = (nativeId: string, over: Partial<IngestedWork> = {}): RawProviderRecord => ({
  nativeId,
  sourceRevision: null,
  crossRefs: [],
  raw: work(nativeId, over)
});

/** A provider that answers one page and then ends. */
const providerOf = (records: readonly RawProviderRecord[]): CatalogMetadataProvider => ({
  sourceId: SOURCE_ID,
  capabilities: {
    providerSideSearch: false,
    incrementalSince: false,
    reportsDeletions: false,
    maxPageSize: 50
  },
  fetchPage: () =>
    Promise.resolve({ ok: true, records, nextCursor: null, withdrawn: [] } satisfies ProviderPageResult)
});

/** A provider that cannot answer. */
const failingProvider = (): CatalogMetadataProvider => ({
  sourceId: SOURCE_ID,
  capabilities: {
    providerSideSearch: false,
    incrementalSince: false,
    reportsDeletions: false,
    maxPageSize: 50
  },
  fetchPage: () =>
    Promise.resolve({
      ok: false,
      reason: "provider_unreachable",
      detail: "the name did not resolve"
    } satisfies ProviderPageResult)
});

/**
 * A source with a store and no stated staleness policy.
 *
 * `schedule: null` IS WHAT THE EXISTING SUITE BELOW ASSUMES AND IS NOT A
 * SHORTCUT. It is the package's `policy_not_stated`: with no policy, nothing may
 * be described as fresh, so every read refreshes, which is exactly the
 * behaviour these tests were written against. The scheduled behaviour is
 * exercised by the suites at the foot of this file, which state a policy the way
 * an operator would.
 */
const sourceOver = (
  provider: CatalogMetadataProvider,
  read: CatalogIngestionReadOptions = READ,
  scheduling: CatalogIngestionScheduling = {
    schedule: null,
    store: createInMemoryCatalogStore()
  },
  now: () => number = () => NOW_MS
) => catalogSourceOverProvider(provider, read, now, scheduling);

/* ---------------------------------------------------------------------- */

describe("rights fail closed", () => {
  /*
   * THE CLAUSE THAT MATTERS MOST, and the one a working provider makes easy to
   * get wrong: a source that can enumerate a catalogue is not a source that has
   * authorized anything. Wikidata knowing that a film exists says nothing about
   * this operator's right to surface it, and the record below is exactly that
   * case -- complete, valid, well-formed, and with no basis anybody established.
   *
   * IT IS NOT SURFACED AND IT IS NOT SILENT. The record is withheld with the
   * package's own `rights_basis_not_declared`, so an empty rail comes with a
   * per-record reason rather than looking like an empty catalog.
   */
  it("withholds a well-formed record whose rights basis nobody established", async () => {
    const source = sourceOver(providerOf([raw("q1", { rights: null })]));
    const answer = await source.describeCatalog();

    expect(answer.records).toEqual([]);
    expect(answer.state).toBe("no_records_usable");
    expect(answer.withheld).toEqual([{ recordId: "q1", reason: "rights_basis_not_declared" }]);
  });

  /*
   * THE NEAR MISS THAT WOULD HAVE POPULATED THE RAIL. `CatalogItem.rights` is
   * REQUIRED by the published contract to hold one of three values whether or
   * not anybody established a basis, and `projectToCatalogRecord` fills it with
   * the most restrictive value in the vocabulary precisely so an undeclared work
   * can still be parsed and then refused BY NAME. An adapter that read that
   * field as evidence would turn "we have not checked" into "licensed" for every
   * work the source is quiet about.
   *
   * Asserted as an absence of items rather than as a property of one, because
   * the failure mode is a record appearing, not a record appearing wrong.
   */
  it("does not read the item's own rights field as a substitute for a basis", async () => {
    const source = sourceOver(providerOf([raw("q1", { rights: null }), raw("q2")]));
    const answer = await source.describeCatalog();

    expect(answer.records.map((record) => record.item.id)).toEqual([`${SOURCE_ID}-q2`]);
    expect(answer.records.every((record) => record.rights !== null)).toBe(true);
    expect(answer.state).toBe("records_available");
  });

  /*
   * The default position of an operator who holds no register, end to end. It is
   * the state a Wikidata-backed deployment is in until somebody does the rights
   * work, and the honest outcome is a rail that is empty for a stated reason.
   */
  it("publishes nothing at all when no record has a basis", async () => {
    const source = sourceOver(
      providerOf([raw("q1", { rights: null }), raw("q2", { rights: null })])
    );

    expect(await source.listRecords()).toEqual([]);
    expect(await source.findRecord(`${SOURCE_ID}-q1`)).toBeNull();
    expect((await source.describeCatalog()).withheld).toHaveLength(2);
  });
});

describe("availability stays honest", () => {
  /*
   * A source that names no territory has told us nothing, and under the
   * fail-closed reading the work is withheld rather than shown. What this test
   * is really guarding is the absence of the shortcut: nothing in the adapter
   * synthesises a window to make the record pass.
   */
  it("withholds a work whose availability the source never stated", async () => {
    const source = sourceOver(providerOf([raw("q1", { availability: [] })]));
    const answer = await source.describeCatalog();

    expect(answer.state).toBe("no_records_usable");
    expect(answer.withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "availability_not_stated" }
    ]);
  });

  /*
   * A window that exists and does not cover the reader. Distinct from the above
   * -- one is "nobody said", the other is "somebody said no" -- and the package
   * names them differently, which this carries through unchanged.
   */
  it("withholds a work whose window does not cover the requested territory", async () => {
    const source = sourceOver(
      providerOf([raw("q1", { availability: [{ territory: "FR", startsAt: null, endsAt: null }] })])
    );

    expect((await source.describeCatalog()).withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "not_available_in_territory" }
    ]);
  });

  /*
   * `treat_as_worldwide` IS AN OPERATOR ASSERTION AND STILL NOT A FABRICATED
   * WINDOW. The record goes through, and the thing asserted here is that no
   * window appeared anywhere as a result: the work is published because an
   * operator stated a reading of unstated availability, not because the adapter
   * invented an availability claim on their behalf. `CatalogItem` has no
   * availability field, which is what makes that structural rather than
   * conventional.
   */
  it("carries an operator's stated reading of unstated availability without inventing a window", async () => {
    const source = sourceOver(providerOf([raw("q1", { availability: [] })]), {
      ...READ,
      unstatedAvailability: "treat_as_worldwide"
    });
    const answer = await source.describeCatalog();

    expect(answer.state).toBe("records_available");
    expect(answer.records).toHaveLength(1);
    expect(Object.keys(answer.records[0]?.item ?? {})).not.toContain("availability");
  });
});

describe("four states, four answers", () => {
  /*
   * STATE 2 AND STATE 4, WHICH ARE THE PAIR THAT IS ACTUALLY HARD. Both answer
   * `[]` from `listRecords()` and both really do have no records, so the
   * distinction was never going to live in the array. It lives in
   * `describeCatalog`, and the assertion is written as a whole-value comparison
   * of the two answers so that an implementation which stopped recording
   * withholdings -- and therefore started calling state 2 an empty catalog --
   * fails here rather than passing a length check.
   */
  it("tells 'nothing usable' apart from 'nothing there'", async () => {
    const nothingUsable = await sourceOver(
      providerOf([raw("q1", { rights: null })])
    ).describeCatalog();
    const nothingThere = await sourceOver(providerOf([])).describeCatalog();

    expect(nothingUsable.state).toBe("no_records_usable");
    expect(nothingThere.state).toBe("catalog_empty");

    expect(nothingUsable.records).toEqual([]);
    expect(nothingThere.records).toEqual([]);
    expect(nothingUsable.withheld).toHaveLength(1);
    expect(nothingThere.withheld).toEqual([]);
  });

  /*
   * STATE 3. A provider that could not be reached is not a catalog that is
   * empty, and the difference has to survive as far as `loadHomeCatalog`, which
   * converts a throw into `catalog_source_unavailable` and an empty list into
   * `empty`. So the adapter THROWS -- the port's documented contract -- and
   * carries the package's own named failure on the error rather than in its
   * message text.
   *
   * ALL THREE ENTRY POINTS, because a caller that reached the source through
   * `findRecord` must not be told `null`, which means "no such title".
   */
  it("throws a named failure rather than answering an empty catalog", async () => {
    const source = sourceOver(failingProvider());

    await expect(source.describeCatalog()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
    await expect(source.listRecords()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
    await expect(source.findRecord("anything")).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );

    await source.describeCatalog().catch((error: unknown) => {
      expect(error).toBeInstanceOf(CatalogMetadataSourceUnavailableError);
      if (!(error instanceof CatalogMetadataSourceUnavailableError)) return;
      expect(error.reason).toBe("provider_unreachable");
      expect(error.detail).toBe("the name did not resolve");
    });
  });

  /*
   * An answer states when it was read and whether it was read in full, so
   * "nothing there" is never claimed on the strength of a truncated pass.
   */
  it("dates its answer and says whether the source was read in full", async () => {
    const answer = await sourceOver(providerOf([raw("q1")])).describeCatalog();

    expect(answer.observedAt).toBe(new Date(NOW_MS).toISOString());
    expect(answer.complete).toBe(true);
  });
});

describe("requireCatalogDescription", () => {
  /*
   * Returns the METHOD rather than a boolean, for the reason
   * `requireProviderSideSearch` gives about the provider port's optional search:
   * a boolean leaves a `?.` call written somewhere, and the `?.` answers
   * `undefined` on the day the check and the call disagree.
   */
  it("hands back a callable bound to its source", async () => {
    const source = sourceOver(providerOf([raw("q1")]));
    const describe = requireCatalogDescription(source);

    expect(describe).not.toBeNull();
    expect((await describe?.())?.state).toBe("records_available");
  });

  /*
   * A source that cannot tell state 2 from state 4 says so by not implementing
   * the method, and gets `null` rather than a guessed answer.
   */
  it("answers null for a source that cannot describe itself", () => {
    expect(
      requireCatalogDescription({
        sourceId: "no-description",
        listRecords: () => [],
        findRecord: () => null
      })
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Stored state, a schedule, and what a read re-decides
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, as above: the provider is hand-written and
 * everything else -- the pass, the store, the scheduler, `checkRightsBasis`,
 * `projectToCatalogRecord` -- is the package's own. The clock is a variable
 * these tests move, which is the only way to state "fifteen minutes later"
 * without waiting fifteen minutes or faking a timer that does not exist.
 * ---------------------------------------------------------------------- */

const MINUTE = 60_000;

/** A policy an operator might state: current for a quarter of an hour. */
const SCHEDULE: CatalogRefreshSchedule = {
  policy: { freshForMs: 15 * MINUTE, staleAfterMs: 6 * 60 * MINUTE },
  maxBackoffMs: 60 * MINUTE
};

/**
 * A provider that answers a different page per call, and counts the calls.
 *
 * THE CALL COUNT IS THE ASSERTION for most of what follows. "This read did not
 * cost a pass" is a claim about whether a socket was opened, and a count of
 * `fetchPage` calls is the closest this file can get to counting sockets without
 * reaching into the transport the adapter cannot see.
 */
const scriptedProvider = (
  pages: readonly ProviderPageResult[]
): { provider: CatalogMetadataProvider; calls: () => number } => {
  let index = 0;
  const provider: CatalogMetadataProvider = {
    sourceId: SOURCE_ID,
    capabilities: {
      providerSideSearch: false,
      incrementalSince: false,
      reportsDeletions: false,
      maxPageSize: 50
    },
    fetchPage: () => {
      const page = pages[index];
      index += 1;
      if (page === undefined) throw new Error("the source asked for more pages than were scripted");
      return Promise.resolve(page);
    }
  };
  return { provider, calls: () => index };
};

const page = (
  records: readonly RawProviderRecord[],
  nextCursor: string | null = null
): ProviderPageResult => ({ ok: true, records, nextCursor, withdrawn: [] });

const UNREACHABLE: ProviderPageResult = {
  ok: false,
  reason: "provider_unreachable",
  detail: "the name did not resolve"
};

/** A clock these tests move by hand. */
const movableClock = (startMs: number) => {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advanceBy: (ms: number) => {
      nowMs += ms;
    }
  };
};

const scheduledSourceOver = (
  provider: CatalogMetadataProvider,
  clock: { now: () => number },
  read: CatalogIngestionReadOptions = READ,
  store = createInMemoryCatalogStore()
) => catalogSourceOverProvider(provider, read, clock.now, { schedule: SCHEDULE, store });

describe("a read no longer costs a pass", () => {
  /*
   * THE DEFECT THIS TASK EXISTS TO CLOSE. Every query used to run a full
   * ingestion pass, which made every page view an outbound crawl and scaled the
   * load on a third party with this product's traffic. Three reads inside the
   * fresh window must now cost exactly one pass, and the second and third must
   * still be real answers rather than a cheaper, emptier version of the first.
   */
  it("serves later reads from stored state without asking the provider again", async () => {
    const clock = movableClock(NOW_MS);
    const { provider, calls } = scriptedProvider([page([raw("q1"), raw("q2")])]);
    const source = scheduledSourceOver(provider, clock);

    const first = await source.describeCatalog();
    clock.advanceBy(MINUTE);
    const second = await source.describeCatalog();
    clock.advanceBy(MINUTE);
    const third = await source.listRecords();

    expect(calls()).toBe(1);
    expect(first.records.map((record) => record.item.id)).toEqual(third.map((r) => r.item.id));
    expect(second.records).toHaveLength(2);
    expect(second.refresh.attempted).toBe(false);
    expect(second.refresh.scheduleReason).toBe("state_fresh");
    expect(second.refresh.servedFromStoredState).toBe(true);
  });

  /*
   * A COLD START STILL AWAITS A PASS, and that is honest rather than hidden. The
   * first read of a process has nothing stored, so it pays a full pass and waits
   * for it -- the price of having no worker and no durable state.
   */
  it("awaits a pass on the first read of a process", async () => {
    const clock = movableClock(NOW_MS);
    const { provider, calls } = scriptedProvider([page([raw("q1")])]);

    const answer = await scheduledSourceOver(provider, clock).describeCatalog();

    expect(calls()).toBe(1);
    expect(answer.refresh.attempted).toBe(true);
    expect(answer.refresh.scheduleReason).toBe("no_stored_state");
    expect(answer.records).toHaveLength(1);
  });

  it("asks again once the state reaches the bound the operator stated", async () => {
    const clock = movableClock(NOW_MS);
    const { provider, calls } = scriptedProvider([page([raw("q1")]), page([raw("q1"), raw("q2")])]);
    const source = scheduledSourceOver(provider, clock);

    await source.describeCatalog();
    clock.advanceBy(SCHEDULE.policy.freshForMs);
    const refreshed = await source.describeCatalog();

    expect(calls()).toBe(2);
    expect(refreshed.refresh.attempted).toBe(true);
    expect(refreshed.records).toHaveLength(2);
  });

  /*
   * WHAT THIS CATCHES: the refusals disappearing with the pass that produced
   * them. This is state 2 -- a source listed works and not one of them may be
   * surfaced -- and it must survive a read that did not refresh. If it did not,
   * the second page view on a deployment with no rights register would report an
   * empty catalog, which is the exact collapse the four-state design exists to
   * stop, arriving through the back door of a cache.
   */
  it("still tells 'nothing usable' apart from 'nothing there' on a read that did not refresh", async () => {
    const clock = movableClock(NOW_MS);
    const { provider, calls } = scriptedProvider([page([raw("q1", { rights: null })])]);
    const source = scheduledSourceOver(provider, clock);

    const first = await source.describeCatalog();
    clock.advanceBy(MINUTE);
    const second = await source.describeCatalog();

    expect(calls()).toBe(1);
    expect(second.state).toBe("no_records_usable");
    expect(second.withheld).toEqual(first.withheld);
    expect(second.withheld).toEqual([{ recordId: "q1", reason: "rights_basis_not_declared" }]);
  });
});

describe("an answer carries its age and the policy it is described against", () => {
  /*
   * NOTHING BECOMES FRESHER BY BEING STORED. The answer served from the store
   * reports the observation instant of the pass that built it and an age that
   * GROWS between reads -- if either were re-stamped at the read, a week-old
   * catalog would present as current and the whole point of storing it with a
   * date would be lost.
   */
  it("reports the stored observation and an age that grows while nothing refreshes", async () => {
    const clock = movableClock(NOW_MS);
    const { provider } = scriptedProvider([page([raw("q1")])]);
    const source = scheduledSourceOver(provider, clock);

    const first = await source.describeCatalog();
    clock.advanceBy(10 * MINUTE);
    const later = await source.describeCatalog();

    expect(first.observedAt).toBe(new Date(NOW_MS).toISOString());
    expect(later.observedAt).toBe(first.observedAt);
    expect(first.freshness?.ageMs).toBe(0);
    expect(later.freshness?.ageMs).toBe(10 * MINUTE);
    expect(later.freshness?.freshness).toBe("fresh");
    expect(later.freshness?.policy).toEqual(SCHEDULE.policy);
  });

  /*
   * WHAT THIS CATCHES: an age asserted against a policy nobody wrote. An
   * operator who has not said how old a catalog may be gets `observedAt`, which
   * is a fact, and no verdict, which would be a judgement made on their behalf.
   */
  it("states no verdict when no staleness policy was configured", async () => {
    const answer = await sourceOver(providerOf([raw("q1")])).describeCatalog();

    expect(answer.freshness).toBeNull();
    expect(answer.refresh.scheduleReason).toBe("policy_not_stated");
    expect(answer.observedAt).toBe(new Date(NOW_MS).toISOString());
  });
});

describe("a failed refresh keeps serving the previous state, and says so", () => {
  /*
   * THE CLAUSE WITH TWO WAYS TO GET IT WRONG, and this asserts against both. A
   * refresh that fails must NOT empty the catalog -- a provider having a bad
   * afternoon is not a catalog becoming empty -- and it must NOT present the
   * state it kept as current. The records survive, the age is the old one, and
   * the answer carries the package's own named failure.
   */
  it("answers from the previous state and names the failure rather than throwing", async () => {
    const clock = movableClock(NOW_MS);
    const { provider } = scriptedProvider([page([raw("q1")]), UNREACHABLE]);
    const source = scheduledSourceOver(provider, clock);

    await source.describeCatalog();
    clock.advanceBy(SCHEDULE.policy.freshForMs);
    const afterFailure = await source.describeCatalog();

    expect(afterFailure.state).toBe("records_available");
    expect(afterFailure.records.map((record) => record.item.id)).toEqual([`${SOURCE_ID}-q1`]);
    expect(afterFailure.observedAt).toBe(new Date(NOW_MS).toISOString());
    expect(afterFailure.refresh).toMatchObject({
      attempted: true,
      status: "failed",
      servedFromStoredState: true,
      consecutiveFailures: 1,
      failure: { reason: "provider_unreachable", detail: "the name did not resolve" }
    });
    expect(afterFailure.freshness?.freshness).toBe("stale");
  });

  /*
   * WHAT THIS CATCHES: a source that answers `[]` when it never managed to read
   * anything. There is no previous state on a cold start, so there is nothing to
   * serve and an empty list would be a lie about the catalog rather than a
   * statement about the provider. The port's contract is a throw.
   */
  it("still throws when the very first pass fails, because there is nothing to serve", async () => {
    const clock = movableClock(NOW_MS);
    const { provider } = scriptedProvider([UNREACHABLE]);
    const source = scheduledSourceOver(provider, clock);

    await expect(source.describeCatalog()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
  });

  /*
   * WHAT THIS CATCHES: a read path that hammers a provider that is down. After a
   * cold-start failure the backoff holds, so the next read throws the REMEMBERED
   * failure without going out again -- which is the same defect this task exists
   * to remove (an outbound request per page view) reached through the failure
   * path instead of the success path.
   */
  it("does not retry a failed cold start on every read", async () => {
    const clock = movableClock(NOW_MS);
    const { provider, calls } = scriptedProvider([UNREACHABLE]);
    const source = scheduledSourceOver(provider, clock);

    await expect(source.describeCatalog()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
    clock.advanceBy(MINUTE);
    await expect(source.describeCatalog()).rejects.toMatchObject({
      reason: "provider_unreachable"
    });

    expect(calls()).toBe(1);
  });
});

describe("rights and availability are re-decided at the read, on the stored record", () => {
  const storedWork = (work: IngestedWork, observedAtMs: number): AcceptedWork => ({
    work,
    ref: { sourceId: SOURCE_ID, nativeId: work.contentId },
    crossRefs: [],
    observedAt: new Date(observedAtMs).toISOString(),
    sourceRevision: null
  });

  /**
   * State this process did not produce.
   *
   * WHY THIS IS THE HONEST WAY TO REACH THE CASE. A pass would never accept a
   * work whose basis is null -- `checkRightsBasis` refuses it -- so a store
   * filled by this process cannot hold one. A DURABLE implementation of the
   * package's `CatalogStore` can: it loads a snapshot written by an older build,
   * by another process, or edited by an operator, and everything downstream of
   * `read()` has to be correct over such a snapshot. Seeding one is how that is
   * testable before a durable store exists.
   */
  const seeded = (works: readonly AcceptedWork[]): CatalogStoreSnapshot => ({
    sourceId: SOURCE_ID,
    works,
    tombstones: [],
    refused: [],
    observedAt: new Date(NOW_MS).toISOString(),
    complete: true,
    lastRefresh: {
      status: "succeeded",
      endedAtMs: NOW_MS,
      failure: null,
      consecutiveFailures: 0
    }
  });

  /** A provider no test in this suite may reach: the state is already stored. */
  const unreachedProvider = (): CatalogMetadataProvider => ({
    sourceId: SOURCE_ID,
    capabilities: {
      providerSideSearch: false,
      incrementalSince: false,
      reportsDeletions: false,
      maxPageSize: 50
    },
    fetchPage: () => {
      throw new Error("a fresh stored state must not cause a fetch");
    }
  });

  /*
   * THE CLAUSE WITH INVARIANT 1 BEHIND IT. A record must never be served because
   * a pass accepted it an hour ago. `checkRightsBasis` runs again, here, on the
   * stored work -- so a stored record with no established basis is withheld by
   * name at the read rather than published on the strength of an old decision.
   *
   * WHAT IT CATCHES CONCRETELY: the read path trusting the store. Without the
   * re-check this record is served -- `projectToCatalogRecord` will happily
   * project it, because the contract forces `item.rights` to hold one of three
   * values whether or not anybody established a basis, and the adapter would
   * then report `records_available` for a work nobody authorised.
   */
  it("withholds a stored work whose rights basis is not established", async () => {
    const clock = movableClock(NOW_MS + MINUTE);
    const source = catalogSourceOverProvider(unreachedProvider(), READ, clock.now, {
      schedule: SCHEDULE,
      store: createInMemoryCatalogStore(seeded([storedWork(work("q1", { rights: null }), NOW_MS)]))
    });

    const answer = await source.describeCatalog();

    expect(answer.refresh.attempted).toBe(false);
    expect(answer.records).toEqual([]);
    expect(answer.state).toBe("no_records_usable");
    expect(answer.withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "rights_basis_not_declared" }
    ]);
  });

  /*
   * THE SAME CHECK'S OTHER BRANCH. A basis whose reference is not opaque carries
   * something `docs/CONTENT_RIGHTS.md` says this repository may not hold -- a
   * counterparty, a term, a contract address -- and it is refused on the way out
   * of the store as it would be on the way in.
   */
  it("withholds a stored work whose rights reference is not an opaque identifier", async () => {
    const clock = movableClock(NOW_MS + MINUTE);
    const source = catalogSourceOverProvider(unreachedProvider(), READ, clock.now, {
      schedule: SCHEDULE,
      store: createInMemoryCatalogStore(
        seeded([
          storedWork(
            work("q1", {
              rights: { category: "licensed", reference: "see contract with Example Studios" }
            }),
            NOW_MS
          )
        ])
      )
    });

    expect((await source.describeCatalog()).withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "rights_basis_reference_not_opaque" }
    ]);
  });

  /*
   * AN AVAILABILITY WINDOW THAT CLOSED AFTER THE PASS. The work was offered when
   * it was ingested and is not offered now, and the read is what notices,
   * because `projectToCatalogRecord` is given the instant of THIS read.
   *
   * WHAT IT CATCHES: a store of PROJECTED records. Projection answers "may this
   * reader see this, here, now", so storing its output freezes the "now" and
   * this work keeps being served after its window shuts. The store holds
   * `AcceptedWork` precisely so this cannot happen.
   */
  it("withholds a stored work whose availability window has since closed", async () => {
    const clock = movableClock(NOW_MS);
    const closes = new Date(NOW_MS + 5 * MINUTE).toISOString();
    const source = scheduledSourceOver(
      scriptedProvider([
        page([raw("q1", { availability: [{ territory: "WW", startsAt: null, endsAt: closes }] })])
      ]).provider,
      clock
    );

    const whileOpen = await source.describeCatalog();
    expect(whileOpen.records.map((record) => record.item.id)).toEqual([`${SOURCE_ID}-q1`]);

    clock.advanceBy(10 * MINUTE);
    const afterClose = await source.describeCatalog();

    expect(afterClose.refresh.attempted).toBe(false);
    expect(afterClose.records).toEqual([]);
    expect(afterClose.withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "not_available_in_territory" }
    ]);
  });
});

describe("a tombstone survives into stored state", () => {
  /*
   * THE CLAUSE ABOUT A WITHDRAWN WORK NOT REAPPEARING. Three reads:
   *
   *   1. a complete pass lists two works, and both are served;
   *   2. a complete pass lists one, so the other is proved gone and is dropped;
   *   3. a PARTIAL pass lists both again -- and the work stays withheld, by the
   *      source's own reason, because only a complete pass that observes a work
   *      may release a tombstone over it.
   *
   * WHAT THE THIRD STEP CATCHES: a store that lets any pass undo a deletion. A
   * provider serving a truncated or lagging page would otherwise put a withdrawn
   * work straight back on a rail, and the reason a work is withdrawn upstream
   * may be exactly that somebody lost the right to it.
   */
  it("keeps a work a complete pass proved gone out of a later partial pass's answer", async () => {
    const clock = movableClock(NOW_MS);
    const readOnePage: CatalogIngestionReadOptions = { ...READ, maxPages: 1 };
    const { provider } = scriptedProvider([
      page([raw("q1"), raw("q2")]),
      page([raw("q1")]),
      page([raw("q1"), raw("q2")], "more")
    ]);
    const source = scheduledSourceOver(provider, clock, readOnePage);

    const both = await source.describeCatalog();
    expect(both.records.map((record) => record.item.id)).toEqual([
      `${SOURCE_ID}-q1`,
      `${SOURCE_ID}-q2`
    ]);

    clock.advanceBy(SCHEDULE.policy.freshForMs);
    const afterWithdrawal = await source.describeCatalog();
    expect(afterWithdrawal.records.map((record) => record.item.id)).toEqual([`${SOURCE_ID}-q1`]);

    clock.advanceBy(SCHEDULE.policy.freshForMs);
    const afterPartial = await source.describeCatalog();

    expect(afterPartial.refresh.attempted).toBe(true);
    expect(afterPartial.complete).toBe(false);
    expect(afterPartial.records.map((record) => record.item.id)).toEqual([`${SOURCE_ID}-q1`]);
    expect(afterPartial.withheld).toContainEqual({
      recordId: `${SOURCE_ID}-q2`,
      reason: "absent_from_complete_sync"
    });
  });
});

/* -------------------------------------------------------------------------
 * The composition, over the real licensed source
 * ---------------------------------------------------------------------- */

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.")) return "loopback";
  if (host.startsWith("10.") || host.startsWith("192.168.")) return "private";
  return "public";
};

/**
 * A transport that would answer if anything asked it.
 *
 * NOTHING IN THIS FILE LETS IT BE ASKED. The composition tests below assert what
 * `createCatalogIngestionSource` DECIDES -- whether a provider exists for this
 * runtime -- and a decision is made at construction, before a page is fetched.
 * `fetchImpl` throwing is therefore the assertion that no test here opened a
 * socket, not a stub for one.
 */
const unusedTransport = (): ManifestFetchDependencies => {
  const fetchImpl: PinnedFetch = () => {
    throw new Error("no test in this file may reach the network");
  };
  return {
    fetchImpl,
    classifyHost,
    resolveHost: () => Promise.resolve(["198.51.100.10"]),
    now: () => NOW_MS
  };
};

const licensedEgress: EgressPolicy = {
  allowedHosts: [...WIKIDATA_CC0_HOSTS],
  allowLoopback: false,
  localDeployment: false
};

/**
 * A runtime for the one licensed source.
 *
 * THE SOURCE NAME IS READ OUT OF THE PACKAGE'S FROZEN LIST rather than written
 * as a literal. The licensing decision is an INITIAL SOURCE CHOICE AND NOT AN
 * EXCLUSIVE MANDATE, and a test that hardcoded `"wikidata"` would have to be
 * edited the day a second source is licensed -- which is the day this test
 * should keep passing unchanged.
 *
 * `noRightsBasisEstablished` IS PASSED BY NAME. It is the honest register for an
 * operator who holds none, and the package requires it to be stated rather than
 * inherited, so this composition publishes nothing. That is the correct outcome
 * for a test that is about whether the source can be STOOD UP, not about what it
 * would serve.
 */
const licensedRuntime = (over: Partial<CatalogProviderRuntime> = {}): CatalogProviderRuntime => ({
  sourceId: LICENSED_CATALOG_SOURCE_IDS[0] ?? "",
  selection: { classQid: "Q11424", kind: "movie", locales: ["en"] },
  document: {
    egress: licensedEgress,
    timeoutMs: 10_000,
    maxResponseBytes: 4_000_000,
    maxRedirects: 3,
    userAgent: "LibertyCatalog/0.1 (https://liberty.example.test; ops@example.test)"
  },
  transport: unusedTransport(),
  rightsRegister: noRightsBasisEstablished,
  ...over
});

describe("createCatalogIngestionSource", () => {
  /*
   * THE WIRING, ASSERTED. This is the statement round 51 exists to make true:
   * the application can stand the package's real, licensed, network-backed
   * source behind its own port. The source that comes back reports the
   * PROVIDER'S id, so a diagnostic naming a wrong rail names the provider that
   * supplied it.
   */
  it("stands the real licensed source behind the application's port", () => {
    const created = createCatalogIngestionSource({
      provider: licensedRuntime(),
      read: READ,
      now: () => NOW_MS
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.sourceId).toBe(LICENSED_CATALOG_SOURCE_IDS[0]);
    expect(typeof created.source.describeCatalog).toBe("function");
  });

  /*
   * NO HIDDEN CREDENTIALED SOURCE. A name nobody licensed gets no provider and
   * gets told so in those words, which is the refusal that keeps a keyed source
   * out: attaching an API key to a catalog is a separate Credentials escalation
   * that has not been taken.
   */
  it("refuses a source name no licensing decision covers", () => {
    const created = createCatalogIngestionSource({
      provider: licensedRuntime({ sourceId: "tmdb" }),
      read: READ,
      now: () => NOW_MS
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("no_catalog_provider_licensed");
  });

  /*
   * A LICENSED SOURCE AND A RUNTIME THAT CANNOT BE COMPOSED OVER IT. Separate
   * from the refusal above because the remedies are opposite: one needs a human
   * licensing decision, the other needs a corrected deployment. An egress policy
   * reaching outside the licensed namespaces is the case with a rights
   * consequence, which is why it is the one asserted.
   */
  /*
   * THE STORE'S LIFETIME IS THE RUNTIME'S, AND THAT IS NOT A PREFERENCE.
   * `resolveCatalogMetadataSource` calls this function on EVERY request rather
   * than holding a source, so a store created per call would be discarded before
   * anything could read it -- every read would find an empty store, every read
   * would be due, and this task would have changed nothing about the one pass
   * per query it exists to remove. Two sources built from the SAME runtime must
   * therefore share state.
   *
   * ASSERTED THROUGH THE TRANSPORT, because that is the only thing in this file
   * that can count outbound attempts through the real composition. The transport
   * rejects, so the first source's pass fails and is remembered; the second
   * source, built separately over the same runtime, finds that failure in the
   * store, is inside the backoff, and must throw WITHOUT going out again.
   */
  it("gives one runtime one store, so a second source does not re-crawl", async () => {
    const attempts = { count: 0 };
    const failing: PinnedFetch = () => {
      attempts.count += 1;
      return Promise.reject(new Error("the socket was refused"));
    };
    const runtime: CatalogIngestionRuntime = {
      provider: licensedRuntime({
        transport: { ...unusedTransport(), fetchImpl: failing }
      }),
      read: READ,
      now: () => NOW_MS,
      schedule: SCHEDULE
    };

    const first = createCatalogIngestionSource(runtime);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await expect(first.source.describeCatalog()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
    const afterFirst = attempts.count;
    expect(afterFirst).toBeGreaterThan(0);

    const second = createCatalogIngestionSource(runtime);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await expect(second.source.describeCatalog()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );

    expect(attempts.count).toBe(afterFirst);
  });

  it("refuses a runtime whose egress reaches outside the licensed namespaces", () => {
    const created = createCatalogIngestionSource({
      provider: licensedRuntime({
        document: {
          ...licensedRuntime().document,
          egress: {
            allowedHosts: [...WIKIDATA_CC0_HOSTS, "en.wikipedia.org"],
            allowLoopback: false,
            localDeployment: false
          }
        }
      }),
      read: READ,
      now: () => NOW_MS
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("catalog_provider_configuration_refused");
    expect(created.detail).toContain("egress policy");
  });
});
