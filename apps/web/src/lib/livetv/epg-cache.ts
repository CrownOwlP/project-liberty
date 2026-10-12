/* -------------------------------------------------------------------------
 * OFFLINE EPG CACHING, AS A PURE MODEL OVER AN INJECTED STORE (Wave 132, Worker E).
 *
 * WHAT THIS IS: the decision layer. Given what a store holds, what the clock
 * says, and a freshness policy, it answers whether a cached schedule may be
 * served, whether it must be labelled stale, and whether a refresh is due.
 *
 * WHAT THIS IS NOT: a storage implementation. There is no IndexedDB here, no
 * SQLite, no `localStorage`, no file path, and NO NEW DEPENDENCY — the wave's
 * rules forbid one and the design does not want one. `EpgCacheStore` is a
 * four-method port, and the two places this would really persist are already in
 * the repository and already own their own schemas:
 *
 *   - the desktop sidecar's SQLite, via `@liberty/persistence` (see
 *     `docs/DATABASE.md`), which is where a profile-scoped, survives-restart
 *     cache belongs for the shipped desktop application;
 *   - the browser, via IndexedDB behind the same port, for a web deployment —
 *     and `localStorage` is explicitly the wrong choice there, because it is
 *     synchronous, string-only and small enough that one day of one channel's
 *     grid can exhaust it.
 *
 * Neither is wired, because wiring one means writing a migration into a schema
 * this task does not own. The port is the deliverable; `inMemoryEpgCacheStore`
 * below is a real implementation of it that the tests drive, and it is honestly
 * labelled as process-lifetime only.
 *
 * LOCAL-FIRST, WHICH IS A SPECIFIC CLAIM AND NOT A SLOGAN. A stale schedule is
 * SERVED, labelled, alongside a statement that a refresh is due. The reflexive
 * alternative — evict on expiry — is worse for exactly the situation a cache
 * exists for: the viewer is offline, the stored grid is four hours old, and
 * eviction replaces four-hour-old listings with an empty screen. Yesterday's
 * grid labelled "last updated 4 hours ago" is useful and honest; nothing is
 * neither. `docs/LIVE_TV.md`'s freshness note points the same way: the request
 * path reads normalized state, and refresh is asynchronous.
 *
 * THE DEFECT CLASS REMOVED: THE CACHE THAT LIES ABOUT ITS AGE. A cache whose
 * entries carry no `storedAt`, or whose freshness is computed from an ambient
 * clock, cannot distinguish "fresh" from "stored before the process restarted".
 * Every record here carries the instant it was stored, every decision takes a
 * `LiveClock`, and `cacheState` is a function of (record, clock, policy) and
 * nothing else.
 * ---------------------------------------------------------------------- */
import type { EpgInstant, EpgSchedule } from "@liberty/contracts/domains/live";

import type { LiveClock } from "./schedule";

/** What one cache entry holds. The schedule, plus when WE stored it. */
export interface CachedEpgSchedule {
  readonly schedule: EpgSchedule;
  /**
   * When this process stored the record. NOT the feed's `generatedAt`, which is
   * when the PROVIDER generated it — the two differ by the fetch, and a cache
   * that used the feed's value would report a schedule as fresh forever if a
   * provider ever stamped a future `generatedAt`.
   */
  readonly storedAt: EpgInstant;
  /** The provider the schedule came from, so one provider's cache cannot answer for another's. */
  readonly providerId: string;
}

/**
 * The storage port. Synchronous on purpose.
 *
 * A synchronous port keeps every decision in this module pure and testable; an
 * asynchronous store (IndexedDB, SQLite) is adapted by the CALLER, which reads
 * first and then asks these functions what to do. Putting `await` in the
 * decision layer would make the policy untestable without a fake promise
 * scheduler, and the policy is the part worth testing.
 */
export interface EpgCacheStore {
  read(key: string): CachedEpgSchedule | null;
  write(key: string, record: CachedEpgSchedule): void;
  remove(key: string): void;
  /** Every key present, for eviction planning. Order is not guaranteed by the port. */
  keys(): readonly string[];
}

export interface EpgCachePolicy {
  /** Younger than this, a record is served without a staleness label. */
  readonly freshForMinutes: number;
  /**
   * Older than this, a record is served ONLY when nothing better is reachable,
   * and `cacheState` says `expired` so a surface can choose.
   *
   * Larger than `freshForMinutes` by construction; a policy that inverted them
   * is reported by `cacheState` as `policy_inverted` rather than silently
   * treated as one or the other.
   */
  readonly serveStaleForMinutes: number;
  /** Entries to keep. Beyond it, `planEviction` names the oldest for removal. */
  readonly maxEntries: number;
}

/** A defensible default, stated once. Not a secret, not an environment read. */
export const DEFAULT_EPG_CACHE_POLICY: EpgCachePolicy = Object.freeze({
  freshForMinutes: 30,
  serveStaleForMinutes: 24 * 60,
  maxEntries: 64
});

/** The cache key for a channel's grid. Deterministic, and it names the provider. */
export function epgCacheKey(providerId: string, channelId: string, windowStartsAt: EpgInstant): string {
  /*
   * THE PROVIDER IS PART OF THE KEY. `docs/LIVE_TV.md`: the same channel from two
   * providers is two records with two independently established rights bases. A
   * key without the provider would let one provider's cached grid be served for
   * the other's channel, which is a rights boundary crossed by a cache hit.
   */
  return `${providerId}\u0000${channelId}\u0000${windowStartsAt}`;
}

export const EPG_CACHE_STATES = [
  "missing",
  "fresh",
  /** Past `freshForMinutes`, within `serveStaleForMinutes`. Serve it, label it. */
  "stale",
  /** Past `serveStaleForMinutes`. Serve only as a last resort; refresh is overdue. */
  "expired",
  /** `storedAt` is in the future relative to the clock. Never trusted as fresh. */
  "stored_in_future",
  "policy_inverted"
] as const;
export type EpgCacheState = (typeof EPG_CACHE_STATES)[number];

export interface EpgCacheReading {
  readonly state: EpgCacheState;
  /** The record, when there is one — including for `stale` and `expired`. */
  readonly record: CachedEpgSchedule | null;
  /** Minutes since `storedAt`, or `null` when there is no record. Negative is impossible. */
  readonly ageMinutes: number | null;
  /** Whether the caller should start a refresh. True for everything but `fresh`. */
  readonly refreshDue: boolean;
}

/**
 * What the cache has to say about a key. Pure; the store read is the caller's.
 *
 * `stored_in_future` exists because clock skew is real and the failure mode is
 * nasty: a record stamped an hour ahead would otherwise read as fresh for an
 * hour no matter what, which is a cache that cannot be invalidated. It is
 * reported rather than corrected, and `refreshDue` is true for it.
 */
export function readEpgCache(
  store: EpgCacheStore,
  key: string,
  clock: LiveClock,
  policy: EpgCachePolicy = DEFAULT_EPG_CACHE_POLICY
): EpgCacheReading {
  if (policy.serveStaleForMinutes < policy.freshForMinutes) {
    return { state: "policy_inverted", record: store.read(key), ageMinutes: null, refreshDue: true };
  }

  const record = store.read(key);
  if (record === null) return { state: "missing", record: null, ageMinutes: null, refreshDue: true };

  const storedAt = Date.parse(record.storedAt);
  const now = Date.parse(clock.now());
  if (!Number.isFinite(storedAt) || !Number.isFinite(now)) {
    return { state: "expired", record, ageMinutes: null, refreshDue: true };
  }
  if (storedAt > now) {
    return { state: "stored_in_future", record, ageMinutes: 0, refreshDue: true };
  }

  const ageMinutes = Math.floor((now - storedAt) / 60_000);
  if (ageMinutes < policy.freshForMinutes) {
    return { state: "fresh", record, ageMinutes, refreshDue: false };
  }
  if (ageMinutes < policy.serveStaleForMinutes) {
    return { state: "stale", record, ageMinutes, refreshDue: true };
  }
  return { state: "expired", record, ageMinutes, refreshDue: true };
}

/** The record a write would produce. Separated so a caller can inspect before storing. */
export function planEpgCacheWrite(
  schedule: EpgSchedule,
  providerId: string,
  clock: LiveClock
): CachedEpgSchedule {
  return { schedule, storedAt: clock.now(), providerId };
}

/**
 * Keys to evict so the store holds at most `maxEntries`.
 *
 * OLDEST FIRST, with the KEY as the tie-break — not insertion order, which the
 * port does not promise, and not "whatever `keys()` returned", which would make
 * eviction a function of a store implementation's iteration order. Same store
 * contents in, same eviction list out, on every implementation.
 */
export function planEpgCacheEviction(
  store: EpgCacheStore,
  policy: EpgCachePolicy = DEFAULT_EPG_CACHE_POLICY
): readonly string[] {
  const keys = [...store.keys()];
  if (keys.length <= policy.maxEntries) return [];
  const aged = keys.map((key) => {
    const record = store.read(key);
    const storedAt = record === null ? Number.NEGATIVE_INFINITY : Date.parse(record.storedAt);
    return { key, storedAt: Number.isFinite(storedAt) ? storedAt : Number.NEGATIVE_INFINITY };
  });
  aged.sort((left, right) => {
    if (left.storedAt !== right.storedAt) return left.storedAt - right.storedAt;
    return left.key === right.key ? 0 : left.key < right.key ? -1 : 1;
  });
  return aged.slice(0, keys.length - policy.maxEntries).map((entry) => entry.key);
}

/**
 * A store that lives as long as the process does.
 *
 * A REAL implementation of the port, not a stub — the tests drive this one, and
 * a development server gets a working cache from it. Labelled for what it is:
 * nothing here survives a restart, which is exactly why the header names the two
 * durable homes this port is waiting for.
 */
export function inMemoryEpgCacheStore(): EpgCacheStore {
  const records = new Map<string, CachedEpgSchedule>();
  return {
    read: (key) => records.get(key) ?? null,
    write: (key, record) => {
      records.set(key, record);
    },
    remove: (key) => {
      records.delete(key);
    },
    keys: () => [...records.keys()]
  };
}
