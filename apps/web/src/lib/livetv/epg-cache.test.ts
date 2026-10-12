/* -------------------------------------------------------------------------
 * The cache policy, which is the part worth testing (Wave 132, Worker E).
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import type { EpgSchedule } from "@liberty/contracts/domains/live";

import {
  DEFAULT_EPG_CACHE_POLICY,
  epgCacheKey,
  inMemoryEpgCacheStore,
  planEpgCacheEviction,
  planEpgCacheWrite,
  readEpgCache
} from "./epg-cache";
import { fixedClock } from "./schedule";
import { sourceWithoutComments } from "./testing/fixtures";

const schedule: EpgSchedule = {
  channelId: "aurora-news",
  window: { startsAt: "2026-10-12T18:00:00.000Z", endsAt: "2026-10-13T06:00:00.000Z" },
  listings: [],
  generatedAt: "2026-10-12T18:00:00.000Z"
};

const at = (iso: string) => fixedClock(iso);

describe("the port, not a storage dependency", () => {
  it("names no storage API and imports nothing that is one", () => {
    const source = sourceWithoutComments(new URL("./epg-cache.ts", import.meta.url));
    for (const forbidden of ["localStorage", "indexedDB", "IDBFactory", "node:fs", "sqlite", "require("]) {
      expect(source, `must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the key", () => {
  it("names the provider, so one provider's grid cannot be served for another's channel", () => {
    const a = epgCacheKey("provider-a", "aurora-news", "2026-10-12T18:00:00.000Z");
    const b = epgCacheKey("provider-b", "aurora-news", "2026-10-12T18:00:00.000Z");
    expect(a).not.toBe(b);
  });

  it("is deterministic", () => {
    expect(epgCacheKey("p", "c", "2026-10-12T18:00:00.000Z")).toBe(
      epgCacheKey("p", "c", "2026-10-12T18:00:00.000Z")
    );
  });
});

describe("freshness", () => {
  const key = epgCacheKey("p", "aurora-news", "2026-10-12T18:00:00.000Z");

  function storedAt(iso: string) {
    const store = inMemoryEpgCacheStore();
    store.write(key, planEpgCacheWrite(schedule, "p", at(iso)));
    return store;
  }

  it("reports missing for an absent key, and a refresh is due", () => {
    const reading = readEpgCache(inMemoryEpgCacheStore(), key, at("2026-10-12T18:00:00.000Z"));
    expect(reading.state).toBe("missing");
    expect(reading.record).toBeNull();
    expect(reading.refreshDue).toBe(true);
  });

  it("reports fresh inside the freshness window", () => {
    const reading = readEpgCache(storedAt("2026-10-12T18:00:00.000Z"), key, at("2026-10-12T18:20:00.000Z"));
    expect(reading.state).toBe("fresh");
    expect(reading.ageMinutes).toBe(20);
    expect(reading.refreshDue).toBe(false);
  });

  it("SERVES a stale record rather than evicting it, and says a refresh is due", () => {
    /*
     * THE LOCAL-FIRST CLAIM. Yesterday's grid labelled "4 hours old" is useful;
     * an empty screen is not, and the viewer may be offline.
     */
    const reading = readEpgCache(storedAt("2026-10-12T18:00:00.000Z"), key, at("2026-10-12T22:00:00.000Z"));
    expect(reading.state).toBe("stale");
    expect(reading.record?.schedule.channelId).toBe("aurora-news");
    expect(reading.refreshDue).toBe(true);
  });

  it("reports expired past the stale window and still hands the record over", () => {
    const reading = readEpgCache(storedAt("2026-10-12T18:00:00.000Z"), key, at("2026-10-14T18:00:00.000Z"));
    expect(reading.state).toBe("expired");
    expect(reading.record).not.toBeNull();
  });

  it("is exact at both boundaries", () => {
    const store = storedAt("2026-10-12T18:00:00.000Z");
    const justFresh = readEpgCache(store, key, at("2026-10-12T18:29:59.000Z"));
    expect(justFresh.state).toBe("fresh");
    const justStale = readEpgCache(store, key, at("2026-10-12T18:30:00.000Z"));
    expect(justStale.state).toBe("stale");
    const justExpired = readEpgCache(store, key, at("2026-10-13T18:00:00.000Z"));
    expect(justExpired.state).toBe("expired");
  });

  it("never reports a record stamped in the future as fresh", () => {
    /* Clock skew would otherwise produce a cache that cannot be invalidated. */
    const reading = readEpgCache(storedAt("2026-10-12T19:00:00.000Z"), key, at("2026-10-12T18:00:00.000Z"));
    expect(reading.state).toBe("stored_in_future");
    expect(reading.refreshDue).toBe(true);
  });

  it("reports an inverted policy rather than silently picking a side", () => {
    const reading = readEpgCache(storedAt("2026-10-12T18:00:00.000Z"), key, at("2026-10-12T18:10:00.000Z"), {
      freshForMinutes: 600,
      serveStaleForMinutes: 10,
      maxEntries: 4
    });
    expect(reading.state).toBe("policy_inverted");
    expect(reading.refreshDue).toBe(true);
  });

  it("uses the clock, not the feed's generatedAt, to decide age", () => {
    const store = inMemoryEpgCacheStore();
    /* A provider stamping a future `generatedAt` must not make this fresh forever. */
    const futureGenerated: EpgSchedule = { ...schedule, generatedAt: "2099-01-01T00:00:00.000Z" };
    store.write(key, planEpgCacheWrite(futureGenerated, "p", at("2026-10-12T18:00:00.000Z")));
    expect(readEpgCache(store, key, at("2026-10-13T18:00:00.000Z")).state).toBe("expired");
  });
});

describe("eviction", () => {
  it("evicts nothing below the cap", () => {
    const store = inMemoryEpgCacheStore();
    store.write("a", planEpgCacheWrite(schedule, "p", at("2026-10-12T18:00:00.000Z")));
    expect(planEpgCacheEviction(store)).toEqual([]);
  });

  it("evicts the oldest first, deterministically, with the key as tie-break", () => {
    const store = inMemoryEpgCacheStore();
    store.write("newest", planEpgCacheWrite(schedule, "p", at("2026-10-12T20:00:00.000Z")));
    store.write("older-b", planEpgCacheWrite(schedule, "p", at("2026-10-12T18:00:00.000Z")));
    store.write("older-a", planEpgCacheWrite(schedule, "p", at("2026-10-12T18:00:00.000Z")));
    const policy = { ...DEFAULT_EPG_CACHE_POLICY, maxEntries: 1 };
    expect(planEpgCacheEviction(store, policy)).toEqual(["older-a", "older-b"]);
  });

  it("gives the same answer whatever order the store lists its keys in", () => {
    const records = new Map<string, ReturnType<typeof planEpgCacheWrite>>();
    records.set("x", planEpgCacheWrite(schedule, "p", at("2026-10-12T19:00:00.000Z")));
    records.set("y", planEpgCacheWrite(schedule, "p", at("2026-10-12T18:00:00.000Z")));
    const forwards = {
      read: (key: string) => records.get(key) ?? null,
      write: () => undefined,
      remove: () => undefined,
      keys: () => ["x", "y"]
    };
    const backwards = { ...forwards, keys: () => ["y", "x"] };
    const policy = { ...DEFAULT_EPG_CACHE_POLICY, maxEntries: 1 };
    expect(planEpgCacheEviction(forwards, policy)).toEqual(planEpgCacheEviction(backwards, policy));
  });
});

describe("the in-memory store is a real implementation of the port", () => {
  it("round-trips, removes and lists", () => {
    const store = inMemoryEpgCacheStore();
    const record = planEpgCacheWrite(schedule, "p", at("2026-10-12T18:00:00.000Z"));
    store.write("k", record);
    expect(store.read("k")).toEqual(record);
    expect(store.keys()).toEqual(["k"]);
    store.remove("k");
    expect(store.read("k")).toBeNull();
    expect(store.keys()).toEqual([]);
  });
});
