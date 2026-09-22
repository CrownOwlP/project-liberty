import { describe, expect, it } from "vitest";
import { assessFreshness, planNextPassAt, type StalenessPolicy } from "./freshness";
import type {
  CatalogMetadataProvider,
  ProviderCapabilities,
  ProviderPageRequest,
  ProviderPageResult,
  RawProviderRecord
} from "./provider";
import {
  catalogRefreshCadence,
  planCatalogRefresh,
  refreshCatalogIfDue,
  validateCatalogRefreshSchedule,
  type CatalogRefreshSchedule
} from "./schedule";
import { createInMemoryCatalogStore, type CatalogStore, type CatalogStoreSnapshot } from "./store";

/* -------------------------------------------------------------------------
 * When a pass is due
 *
 * NOTHING HERE WAITS FOR ANYTHING. Every instant in this file is a number passed
 * in, and the scheduler contains no timer to fake -- which is the property that
 * makes a backoff assertion a statement about the rule rather than about how
 * long the test runner took.
 * ---------------------------------------------------------------------- */

const SOURCE = "example-source";
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-16T00:00:00.000Z");

const POLICY: StalenessPolicy = { freshForMs: 15 * MINUTE, staleAfterMs: 6 * 60 * MINUTE };
const SCHEDULE: CatalogRefreshSchedule = { policy: POLICY, maxBackoffMs: 60 * MINUTE };

const CAPABILITIES: ProviderCapabilities = {
  providerSideSearch: false,
  incrementalSince: true,
  reportsDeletions: false,
  maxPageSize: 100
};

const record = (nativeId: string): RawProviderRecord => ({
  nativeId,
  sourceRevision: null,
  crossRefs: [],
  raw: {
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
    rights: { category: "public-domain", reference: null }
  }
});

const countingProvider = (
  page: (call: number) => ProviderPageResult
): { provider: CatalogMetadataProvider; requests: ProviderPageRequest[] } => {
  const requests: ProviderPageRequest[] = [];
  const provider: CatalogMetadataProvider = {
    sourceId: SOURCE,
    capabilities: CAPABILITIES,
    fetchPage: (request) => {
      requests.push(request);
      return Promise.resolve(page(requests.length));
    }
  };
  return { provider, requests };
};

const listing = (nativeIds: readonly string[]): ProviderPageResult => ({
  ok: true,
  records: nativeIds.map(record),
  nextCursor: null,
  withdrawn: []
});

const UNREACHABLE: ProviderPageResult = {
  ok: false,
  reason: "provider_unreachable",
  detail: "the name did not resolve"
};

const refreshOver = (
  provider: CatalogMetadataProvider,
  store: CatalogStore,
  nowMs: number,
  schedule: CatalogRefreshSchedule | null = SCHEDULE
) =>
  refreshCatalogIfDue({
    provider,
    store,
    schedule,
    pass: { pageSize: 50, maxPages: 10 },
    now: () => nowMs
  });

/* ---------------------------------------------------------------------- */

describe("the cadence is the freshness policy, not a second set of numbers", () => {
  /*
   * WHAT THIS CATCHES: a refresh interval that an operator can set out of step
   * with the freshness policy. Two numbers meaning "how long an answer may be
   * trusted" fail silently and totally when they disagree -- an hour's interval
   * against a five-minute fresh bound means every answer the deployment ever
   * serves is stale by its own stated policy, while the schedule reports itself
   * as working perfectly.
   */
  it("derives the interval from the policy's fresh bound", () => {
    expect(catalogRefreshCadence(SCHEDULE)).toEqual({
      intervalMs: POLICY.freshForMs,
      maxBackoffMs: SCHEDULE.maxBackoffMs
    });
  });

  it("refuses a transposed policy or a missing backoff cap at configuration time", () => {
    expect(
      validateCatalogRefreshSchedule({
        policy: { freshForMs: 10 * MINUTE, staleAfterMs: MINUTE },
        maxBackoffMs: MINUTE
      })
    ).toEqual({ ok: false, reason: "policy_not_ordered" });

    expect(validateCatalogRefreshSchedule({ policy: POLICY, maxBackoffMs: 0 })).toEqual({
      ok: false,
      reason: "backoff_cap_not_positive"
    });

    expect(validateCatalogRefreshSchedule(SCHEDULE)).toEqual({ ok: true });
  });
});

describe("planCatalogRefresh", () => {
  const stored = (over: Partial<CatalogStoreSnapshot> = {}): CatalogStoreSnapshot => ({
    sourceId: SOURCE,
    works: [],
    tombstones: [],
    refused: [],
    observedAt: new Date(T0).toISOString(),
    complete: true,
    lastRefresh: { status: "succeeded", endedAtMs: T0, failure: null, consecutiveFailures: 0 },
    ...over
  });

  /*
   * WHAT THIS CATCHES: a staleness policy invented on an operator's behalf. With
   * no policy stated there is no bound below which an answer is current, so
   * nothing may be reused and nothing may be described as fresh. The behaviour
   * is the pre-scheduling one, reached by a NAMED absence rather than by a
   * default somebody has to notice.
   */
  it("refreshes on every call and states no age when no policy was configured", () => {
    expect(planCatalogRefresh(stored(), null, T0)).toEqual({
      due: true,
      dueAtMs: T0,
      reason: "policy_not_stated",
      verdict: null
    });
  });

  it("is due immediately when nothing has ever been stored or attempted", () => {
    const plan = planCatalogRefresh(null, SCHEDULE, T0);
    expect(plan.due).toBe(true);
    expect(plan.dueAtMs).toBeNull();
    expect(plan.reason).toBe("no_stored_state");
  });

  it("serves from the store while the state is inside the fresh bound", () => {
    const plan = planCatalogRefresh(stored(), SCHEDULE, T0 + MINUTE);
    expect(plan.due).toBe(false);
    expect(plan.reason).toBe("state_fresh");
    expect(plan.verdict?.freshness).toBe("fresh");
    expect(plan.verdict?.ageMs).toBe(MINUTE);
    expect(plan.verdict?.policy).toEqual(POLICY);
  });

  it("becomes due at the bound the policy states", () => {
    const justBefore = planCatalogRefresh(stored(), SCHEDULE, T0 + POLICY.freshForMs - 1);
    expect(justBefore.due).toBe(false);

    const atBound = planCatalogRefresh(stored(), SCHEDULE, T0 + POLICY.freshForMs);
    expect(atBound.due).toBe(true);
    expect(atBound.reason).toBe("state_not_fresh");
  });

  /*
   * WHAT THIS CATCHES: the schedule and the stated staleness drifting apart. The
   * claim the design rests on is that a pass is never due while the state it
   * would replace is still fresh -- if it were, the deployment would be crawling
   * a third party for answers it has already got and is still willing to serve
   * as current. Asserted over a spread of observation/completion gaps rather
   * than at one instant, because the two clocks are the pass's start and its end
   * and the gap between them is whatever the provider took.
   */
  it("never becomes due while the stored state is still fresh", () => {
    for (const passDurationMs of [0, 1, 1_000, 5 * MINUTE]) {
      const snapshot = stored({
        lastRefresh: {
          status: "succeeded",
          endedAtMs: T0 + passDurationMs,
          failure: null,
          consecutiveFailures: 0
        }
      });
      const plan = planCatalogRefresh(snapshot, SCHEDULE, T0 + POLICY.freshForMs - 1);
      expect(plan.due).toBe(false);

      const atDue = planCatalogRefresh(snapshot, SCHEDULE, plan.dueAtMs ?? 0);
      const freshnessThen = assessFreshness(
        snapshot.observedAt ?? "",
        atDue.dueAtMs ?? 0,
        POLICY
      );
      expect(freshnessThen.ok && freshnessThen.verdict.freshness).not.toBe("fresh");
    }
  });

  /*
   * WHAT THIS CATCHES: a backoff reimplemented here. The due time after a run of
   * failures must be exactly what `planNextPassAt` says, cap and all -- a second
   * exponential written in this file is a second thing to get wrong, and the cap
   * is the part that stops a morning of failures scheduling the next attempt
   * days out.
   */
  it("backs off exactly as planNextPassAt says, from the count on the snapshot", () => {
    const cadence = catalogRefreshCadence(SCHEDULE);
    for (const consecutiveFailures of [1, 2, 5, 40]) {
      const snapshot = stored({
        lastRefresh: {
          status: "failed",
          endedAtMs: T0,
          failure: { reason: "provider_unreachable", detail: "down" },
          consecutiveFailures
        }
      });
      const expected = planNextPassAt(T0, consecutiveFailures, cadence);
      const plan = planCatalogRefresh(snapshot, SCHEDULE, expected - 1);

      expect(plan.dueAtMs).toBe(expected);
      expect(plan.due).toBe(false);
      expect(plan.reason).toBe("backing_off");
      expect(planCatalogRefresh(snapshot, SCHEDULE, expected).due).toBe(true);
    }
  });

  /*
   * WHAT THIS CATCHES: `backing_off` being reported as `state_fresh`. They are
   * both "no pass ran", and collapsing them would tell an operator whose
   * provider has been unreachable for an hour that their catalog is current.
   * The state being served here is well past every bound in the policy.
   */
  it("distinguishes a provider that is down from a state that is current", () => {
    const snapshot = stored({
      observedAt: new Date(T0 - 24 * 60 * MINUTE).toISOString(),
      lastRefresh: {
        status: "failed",
        endedAtMs: T0,
        failure: { reason: "provider_unreachable", detail: "down" },
        consecutiveFailures: 3
      }
    });
    const plan = planCatalogRefresh(snapshot, SCHEDULE, T0 + MINUTE);

    expect(plan.due).toBe(false);
    expect(plan.reason).toBe("backing_off");
    expect(plan.verdict?.freshness).toBe("expired");
  });

  /*
   * WHAT THIS CATCHES: an unusable observation being turned into a verdict.
   * `assessFreshness` refuses a future timestamp rather than clamping it to zero
   * age, and this must carry the refusal through as "no age stated" instead of
   * inventing one -- otherwise a provider with a wrong clock earns a permanently
   * fresh catalog.
   */
  it("states no age when the stored observation cannot be assessed", () => {
    const plan = planCatalogRefresh(
      stored({ observedAt: new Date(T0 + 10 * MINUTE).toISOString() }),
      SCHEDULE,
      T0 + MINUTE
    );
    expect(plan.verdict).toBeNull();
  });
});

describe("refreshCatalogIfDue", () => {
  it("runs a pass and commits it when nothing is stored", async () => {
    const store = createInMemoryCatalogStore();
    const { provider, requests } = countingProvider(() => listing(["a"]));

    const run = await refreshOver(provider, store, T0);

    expect(run.refreshed).toBe(true);
    expect(requests).toHaveLength(1);
    expect(run.snapshot?.works.map((work) => work.work.contentId)).toEqual([`${SOURCE}-a`]);
    expect((await store.read())?.observedAt).toBe(new Date(T0).toISOString());
  });

  /*
   * THE CLAUSE THE WHOLE TASK IS ABOUT. A second read inside the fresh window
   * must not reach the provider at all -- not a cheaper request, not a
   * conditional one, none. `requests` is the assertion because it counts sockets
   * rather than intentions.
   */
  it("does not touch the provider again while the stored state is fresh", async () => {
    const store = createInMemoryCatalogStore();
    const { provider, requests } = countingProvider(() => listing(["a"]));

    await refreshOver(provider, store, T0);
    const second = await refreshOver(provider, store, T0 + MINUTE);

    expect(requests).toHaveLength(1);
    expect(second.refreshed).toBe(false);
    expect(second.result).toBeNull();
    expect(second.plan.reason).toBe("state_fresh");
    expect(second.snapshot?.works).toHaveLength(1);
  });

  it("asks again once the state reaches the policy's fresh bound", async () => {
    const store = createInMemoryCatalogStore();
    const { provider, requests } = countingProvider(() => listing(["a"]));

    await refreshOver(provider, store, T0);
    await refreshOver(provider, store, T0 + POLICY.freshForMs);

    expect(requests).toHaveLength(2);
  });

  /*
   * WHAT THIS CATCHES: a read path that hammers a provider that is down. Without
   * the stored failure count, every read after a failure would find no fresh
   * state and go out again -- which is the same outbound-crawl-per-page-view
   * defect this task exists to remove, arriving through the failure path instead
   * of the success path.
   */
  it("holds off after a failure instead of retrying on every call", async () => {
    const store = createInMemoryCatalogStore();
    const { provider, requests } = countingProvider(() => UNREACHABLE);

    await refreshOver(provider, store, T0);
    await refreshOver(provider, store, T0 + MINUTE);
    await refreshOver(provider, store, T0 + 2 * MINUTE);

    expect(requests).toHaveLength(1);
    const plan = planCatalogRefresh(await store.read(), SCHEDULE, T0 + MINUTE);
    expect(plan.reason).toBe("backing_off");
  });

  /*
   * WHAT THIS CATCHES: an empty known set, which is what the adapter had to pass
   * before a store existed and which makes `reconcileTombstones` mint nothing
   * however complete a pass is. Handing the pass the LIVE stored ids is what
   * makes a deletion detectable at all.
   */
  it("hands the pass the stored ids, so a complete pass can prove a work is gone", async () => {
    const store = createInMemoryCatalogStore();
    const { provider } = countingProvider((call) => (call === 1 ? listing(["a", "b"]) : listing(["a"])));

    await refreshOver(provider, store, T0);
    const second = await refreshOver(provider, store, T0 + POLICY.freshForMs);

    expect(second.result?.tombstones.map((tombstone) => tombstone.contentId)).toEqual([
      `${SOURCE}-b`
    ]);
    expect(second.snapshot?.tombstones).toHaveLength(1);
  });

  /*
   * WHAT THIS CATCHES: the two pass options a scheduler is most tempted to set.
   *
   * `changedSince` asks for a SUBSET, and `ingest.ts` withholds every inferred
   * tombstone from an incremental pass, so a deployment that only ever synced
   * incrementally would never learn that anything had been deleted.
   *
   * `resumeCursor` is the more dangerous one. `complete` in `ingest.ts` means the
   * enumeration REACHED THE END, not that it read the whole source, so a pass
   * resumed from a cursor and run off the end reports itself complete while
   * having seen only a tail segment -- and `reconcileTombstones` would then
   * delete every known id from the pages it skipped. Starting every pass at the
   * beginning is what keeps that unreachable from here.
   */
  it("never resumes a cursor and never asks for an incremental subset", async () => {
    const store = createInMemoryCatalogStore();
    const { provider, requests } = countingProvider(() => listing(["a"]));

    await refreshOver(provider, store, T0);
    await refreshOver(provider, store, T0 + POLICY.freshForMs);

    expect(requests.map((request) => request.cursor)).toEqual([null, null]);
    expect(requests.map((request) => request.changedSince)).toEqual([null, null]);
  });

  /*
   * WHAT THIS CATCHES: an unconfigured deployment silently getting a cadence.
   * With no policy stated every call refreshes, which is exactly what this
   * adapter did before it was scheduled.
   */
  it("refreshes every call when no policy was stated", async () => {
    const store = createInMemoryCatalogStore();
    const { provider, requests } = countingProvider(() => listing(["a"]));

    await refreshOver(provider, store, T0, null);
    await refreshOver(provider, store, T0 + 1, null);

    expect(requests).toHaveLength(2);
  });
});
