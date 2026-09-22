import type { NormalizedContentId } from "@liberty/contracts/shared/ids";
import type { IngestionPassResult, RecordRefusal } from "./ingest";
import type { AcceptedWork, ProviderFetchFailure } from "./provider";
import type { WorkTombstone } from "./record";

/* -------------------------------------------------------------------------
 * Where a pass's output lives between passes
 *
 * `docs/CATALOG_SOURCE.md` has carried the same two sentences for several
 * rounds: "Nothing schedules a pass" and "nothing persists `AcceptedWork` or
 * tombstones". `ingest.ts` produces a pass result and hands it back; until this
 * module existed the only thing anybody could do with one was read it
 * immediately and drop it, which is why the `apps/web` adapter ran a full pass
 * per query. This is the state a pass writes to and a read reads from.
 *
 * ==========================================================================
 * IT IS A PORT WITH AN IN-MEMORY IMPLEMENTATION, AND DURABILITY IS NOT
 * DELIVERED
 * ==========================================================================
 *
 * `createInMemoryCatalogStore` keeps the snapshot in a closure variable. That
 * is genuinely all it does: **nothing here survives a process restart**, and a
 * deployment that restarts pays a cold pass on the first read afterwards. This
 * is stated first rather than last because the interesting failure is somebody
 * reading "the catalog is stored now" and planning around a durability this
 * does not have.
 *
 * WHY NOT `@liberty/persistence` IN THIS ROUND. That package is Drizzle over
 * `pg`, every repository in it is profile-scoped, and it carries migrations and
 * a writer-epoch discipline. A catalog snapshot is none of those things: it is
 * not scoped to a profile, it is one row per source rather than per reader, and
 * a durable table for it needs a migration plus an operator decision about
 * where catalog state lives and who is allowed to write it. Inventing that
 * table here would be a schema decision taken as a side effect of a scheduling
 * task. A PORT costs almost nothing and is honest about what it is; when the
 * operator decision is taken, a Postgres implementation of this interface is a
 * new file and nothing above it changes.
 *
 * WHAT A DURABLE IMPLEMENTATION MUST NOT RE-DECIDE. Every rule about what a
 * pass does to stored state lives in `applyPassToSnapshot` below, which is a
 * pure function over a snapshot and a pass result. The in-memory store is a
 * closure around it and a Postgres store would be a transaction around it. That
 * is deliberate: the tombstone-release rule and the failed-pass rule are the two
 * things in this file with consequences, and a per-implementation copy of either
 * is how two stores end up disagreeing about whether a withdrawn work is back.
 *
 * TIME IS INJECTED HERE TOO. Nothing in this module reads a clock. `endedAtMs`
 * is supplied by the caller on every commit, for the reason `ingest.ts` gives
 * about `deps.now()`: a store that timestamped its own writes would make two
 * stores disagree by however long a commit took, and would make a scheduling
 * test depend on the machine it runs on.
 * ---------------------------------------------------------------------- */

export type CatalogRefreshStatus = "never_attempted" | "succeeded" | "failed";

/**
 * Why the most recent refresh could not be completed.
 *
 * The package's own `ProviderFetchFailure` and the pass's own detail string,
 * carried unchanged rather than translated -- an operator debugging a stale
 * catalog needs the string the code produced. Kept on the snapshot rather than
 * only returned from the pass, because the whole point of storing state is that
 * the read which serves it is not the read that failed.
 */
export interface CatalogRefreshFailure {
  readonly reason: ProviderFetchFailure;
  readonly detail: string;
}

/**
 * The outcome of the most recent refresh ATTEMPT, whatever it did to the state.
 *
 * `consecutiveFailures` LIVES HERE AND NOT IN THE SCHEDULER, which is a change
 * from how this was first sketched and the reason is the same one that put
 * `applyPassToSnapshot` here: a scheduler holding a private failure count
 * beside a store holding the pass state is two facts about one pass in two
 * places, and the day they disagree the backoff is computed against a count
 * that does not describe the state being served. Keeping it on the snapshot
 * also means a durable implementation carries the backoff across a restart for
 * free, instead of a restarted process hammering a provider that is still down.
 *
 * `endedAtMs` is when the attempt finished, not when it started, because that is
 * the argument `planNextPassAt` takes.
 */
export interface CatalogRefreshRecord {
  readonly status: CatalogRefreshStatus;
  readonly endedAtMs: number | null;
  readonly failure: CatalogRefreshFailure | null;
  readonly consecutiveFailures: number;
}

/**
 * Everything one source's stored state is.
 *
 * `works` HOLDS `AcceptedWork`, NOT PROJECTED RECORDS, and this is the single
 * most important decision in the file. A `ProjectedCatalogRecord` is the answer
 * to "may this reader see this work, here, now" -- it has already had a locale
 * chosen, a territory checked against a clock, and a rights basis carried
 * through. Storing that would freeze all three at the instant of the pass, so an
 * availability window that closed an hour ago and a rights basis that lapsed an
 * hour ago would both keep being served from state. Storing the INGESTED work
 * means the read re-evaluates both, every time, against the reader asking and
 * the clock now. A record must never be published because a pass accepted it an
 * hour ago.
 *
 * `refused` is the per-record refusal list of the most recent pass that
 * contributed, and it is state rather than a transient because of what it
 * distinguishes: a source that listed works none of which may be surfaced is
 * NOT an empty catalog, and if the refusals evaporated the moment the pass that
 * produced them ended, the second read after a refresh would answer
 * `catalog_empty` for a deployment with no rights register. That is exactly the
 * collapse the four-state design exists to prevent, arriving through the back
 * door of a cache.
 *
 * `observedAt` is the age of the STATE, computed as the oldest `observedAt`
 * among the works in it -- the rule `projectCatalogAnswer` already states, for
 * the reason it states there: a rail is as current as its stalest row. With no
 * works it falls back to the observation instant of the last successful pass,
 * because a successful pass that found nothing has proved the emptiness as of
 * then. `null` means no pass has ever succeeded, and a snapshot in that
 * condition has nothing to serve.
 */
export interface CatalogStoreSnapshot {
  readonly sourceId: string;
  readonly works: readonly AcceptedWork[];
  readonly tombstones: readonly WorkTombstone[];
  readonly refused: readonly RecordRefusal[];
  readonly observedAt: string | null;
  /** Whether the pass that most recently contributed records read the source in full. */
  readonly complete: boolean;
  readonly lastRefresh: CatalogRefreshRecord;
}

export interface CatalogPassCommit {
  readonly result: IngestionPassResult;
  /** When the pass finished, injected. `planNextPassAt` measures from here. */
  readonly endedAtMs: number;
}

/**
 * The port.
 *
 * TWO METHODS AND BOTH RETURN PROMISES. `read` is a promise even though the
 * in-memory implementation answers immediately, for the reason
 * `CatalogMetadataSource` in `apps/web` gives about the same choice: a port that
 * demanded a synchronous answer would exclude every implementation that does
 * I/O, which is every implementation that makes this durable. The ruling that
 * no synchronous wrapper may be put around network-backed catalog data applies
 * to the store in front of it as much as to the provider behind it.
 *
 * THERE IS NO `write(snapshot)`. A caller cannot hand this a state it composed;
 * it hands over a PASS RESULT and the store applies the rules. That is what
 * keeps the tombstone-release rule from being re-decided by each caller, and it
 * is why the rules are testable without any implementation at all.
 */
export interface CatalogStore {
  /** `null` when nothing has ever been committed. */
  read(): Promise<CatalogStoreSnapshot | null>;
  commit(commit: CatalogPassCommit): Promise<CatalogStoreSnapshot>;
}

/** A source with nothing stored and nothing yet attempted. */
export function emptyCatalogSnapshot(sourceId: string): CatalogStoreSnapshot {
  return {
    sourceId,
    works: [],
    tombstones: [],
    refused: [],
    observedAt: null,
    complete: false,
    lastRefresh: {
      status: "never_attempted",
      endedAtMs: null,
      failure: null,
      consecutiveFailures: 0
    }
  };
}

/** Whether this snapshot holds anything a read could be answered from. */
export function hasStoredCatalogState(snapshot: CatalogStoreSnapshot | null): boolean {
  return snapshot !== null && snapshot.observedAt !== null;
}

export interface TombstonedWork {
  readonly work: AcceptedWork;
  readonly tombstone: WorkTombstone;
}

export interface CatalogWorkPartition {
  readonly live: readonly AcceptedWork[];
  readonly tombstoned: readonly TombstonedWork[];
}

/**
 * Stored works, split by whether a tombstone stands over them.
 *
 * A TOMBSTONED WORK IS RETURNED RATHER THAN DROPPED, so the read can withhold it
 * BY NAME instead of it simply not being there. A withdrawn work that silently
 * disappears from a rail is indistinguishable from one that was never ingested,
 * and the two have completely different remedies.
 *
 * Stored state can hold a work that is tombstoned: a partial pass may return a
 * work that a previous complete pass proved absent, and the rule below does not
 * let a partial pass release the tombstone. The work is kept because the next
 * complete pass may legitimately release it; it is not served in the meantime.
 */
export function partitionCatalogWorks(snapshot: CatalogStoreSnapshot): CatalogWorkPartition {
  const index = new Map<string, WorkTombstone>();
  for (const tombstone of snapshot.tombstones) index.set(tombstone.contentId, tombstone);

  const live: AcceptedWork[] = [];
  const tombstoned: TombstonedWork[] = [];
  for (const work of snapshot.works) {
    const tombstone = index.get(work.work.contentId);
    if (tombstone === undefined) live.push(work);
    else tombstoned.push({ work, tombstone });
  }
  return { live, tombstoned };
}

/** Every live work's content id, in the shape `IngestionPassOptions` wants. */
export function knownContentIdsOf(
  snapshot: CatalogStoreSnapshot | null
): readonly NormalizedContentId[] {
  if (snapshot === null) return [];
  return partitionCatalogWorks(snapshot).live.map((accepted) => accepted.work.contentId);
}

const oldestObservedAt = (works: readonly AcceptedWork[]): string | null => {
  let oldest: string | null = null;
  for (const work of works) {
    if (oldest === null || Date.parse(work.observedAt) < Date.parse(oldest)) {
      oldest = work.observedAt;
    }
  }
  return oldest;
};

/**
 * What one pass does to stored state. The whole rule, in one pure function.
 *
 * ==========================================================================
 * 1. A FAILED PASS CHANGES NO RECORDS AT ALL
 * ==========================================================================
 *
 * `works`, `refused`, `observedAt` and `complete` are carried through
 * untouched, and only the refresh record moves. A failed pass read a PREFIX of
 * the source and proved nothing about the rest, so the two available
 * alternatives are both wrong: emptying the state deletes a catalog because a
 * provider had a bad afternoon, and merging the prefix makes "the previous
 * state" a moving target whose age is a blend of two passes. The state that was
 * being served keeps being served, and the failure is recorded so the read can
 * SAY it is being served -- serving stale data silently as current is the defect
 * this whole module would otherwise introduce.
 *
 * THE ONE THING A FAILED PASS MAY STILL APPLY IS A DECLARED WITHDRAWAL.
 * `ingest.ts` mints `withdrawn_by_source` whatever else it withholds, because
 * that rests on the source's own statement rather than on the pass having seen
 * everything. Applying it removes a work, which is the fail-closed direction; a
 * source that said "this is gone" during a pass that later failed still said it.
 * In practice the currently licensed provider declares `reportsDeletions: false`
 * so this list is always empty, but the rule is written for the port and not for
 * the one adapter.
 *
 * ==========================================================================
 * 2. A TOMBSTONE IS RELEASED ONLY BY A COMPLETE PASS THAT ACCEPTS THE WORK
 * ==========================================================================
 *
 * Tombstones are UNIONED across passes and never replaced wholesale. A
 * previously tombstoned id is not in `knownContentIds` -- the caller passes only
 * live works -- so a later complete pass does not re-report it, and a wholesale
 * replacement would therefore DROP the tombstone and resurrect a work the source
 * deleted. That is the bug this paragraph exists to prevent.
 *
 * The release condition is the mirror of `ingest.ts`'s minting condition. A
 * tombstone can only be minted by a pass that enumerated the whole source, or by
 * the source stating a withdrawal; so it may only be lifted by a pass that
 * enumerated the whole source and found the work there again. A partial pass, a
 * failed pass and an incremental pass release nothing.
 *
 * THE ARGUMENT AGAINST THIS RULE, because it is a good one and was considered:
 * seeing a work is DIRECT positive evidence that the source still lists it,
 * whereas not seeing one is only evidence when the read was complete, so the
 * two directions are not symmetric and any pass that returns the work arguably
 * disproves the tombstone. What decides it the other way is the asymmetry of the
 * consequences. Releasing wrongly puts a work that was withdrawn back on a rail,
 * and the reason a work is withdrawn upstream may be exactly that somebody lost
 * the right to it; not releasing wrongly hides a work that came back, until the
 * next complete pass. One of those is a rights exposure and the other is a
 * delay. The trap is also concrete rather than theoretical: a provider serving
 * an incremental page from a lagging replica, or re-listing an entity it has
 * already reported as withdrawn, is ordinary infrastructure behaviour.
 *
 * RELEASE IS ON `accepted`, NOT ON "SEEN", AND THAT IS A NARROWER RULE THAN IT
 * COULD BE. `ingest.ts` spares a work that was SEEN and then refused from being
 * tombstoned, but `IngestionPassResult` does not publish the seen set -- refusals
 * carry a native id, not a derived content id -- so this cannot distinguish "the
 * complete pass saw it and refused it" from "the complete pass never saw it".
 * The conservative reading is taken: no release. Publishing `seenContentIds` on
 * the pass result would let this be exact, and that is a change to `ingest.ts`
 * with its own review rather than something to slip in here.
 *
 * ==========================================================================
 * 3. A COMPLETE PASS REPLACES THE RECORDS; A PARTIAL ONE MERGES THEM
 * ==========================================================================
 *
 * A complete pass read the whole source, so the works it accepted ARE the
 * catalog and anything else is gone -- either tombstoned by `reconcileTombstones`
 * or dropped because the complete pass saw it and refused it, which publishes
 * less and is the right direction. A partial pass read a prefix, so its records
 * are merged over the previous ones by content id and the rest are left alone,
 * and the snapshot is marked `complete: false` so the answer says it was not
 * read in full.
 *
 * `refused` is REPLACED by any non-failed pass rather than merged, and that is
 * coherent only because every pass this package schedules starts from the
 * beginning of the source -- see `schedule.ts` on why no cursor is resumed. A
 * merged refusal list would keep explaining a record that has since become fine.
 * ---------------------------------------------------------------------- */
export function applyPassToSnapshot(
  previous: CatalogStoreSnapshot,
  commit: CatalogPassCommit
): CatalogStoreSnapshot {
  const { result, endedAtMs } = commit;

  if (result.sourceId !== previous.sourceId) {
    /*
     * THROWN, NOT REFUSED AS A VALUE, and the distinction is deliberate. Every
     * other refusal in this package describes something a third party's data
     * did; this describes a caller wiring one source's store to another
     * source's provider, which no input can cause and which has no correct
     * outcome -- merging, ignoring and replacing all produce a wrong catalog.
     * A tombstone rule is scoped to one source for the reason
     * `IngestionPassOptions.knownContentIds` gives: a complete pass of provider
     * A over provider B's ids deletes provider B's catalog.
     */
    throw new Error(
      `a catalog store for ${previous.sourceId} was handed a pass from ${result.sourceId}`
    );
  }

  const failed = result.failure !== null;
  const consecutiveFailures = failed ? previous.lastRefresh.consecutiveFailures + 1 : 0;
  const lastRefresh: CatalogRefreshRecord = {
    status: failed ? "failed" : "succeeded",
    endedAtMs,
    failure: result.failure,
    consecutiveFailures
  };

  const acceptedIds = new Set(result.accepted.map((accepted) => accepted.work.contentId));
  const tombstones = new Map<string, WorkTombstone>();
  for (const tombstone of previous.tombstones) {
    if (result.complete && acceptedIds.has(tombstone.contentId)) continue;
    tombstones.set(tombstone.contentId, tombstone);
  }
  for (const tombstone of result.tombstones) tombstones.set(tombstone.contentId, tombstone);

  if (failed) {
    return {
      sourceId: previous.sourceId,
      works: previous.works,
      tombstones: [...tombstones.values()],
      refused: previous.refused,
      observedAt: previous.observedAt,
      complete: previous.complete,
      lastRefresh
    };
  }

  let works: readonly AcceptedWork[];
  if (result.complete) {
    works = result.accepted;
  } else {
    const merged = new Map(previous.works.map((work) => [work.work.contentId, work]));
    for (const accepted of result.accepted) merged.set(accepted.work.contentId, accepted);
    works = [...merged.values()];
  }

  return {
    sourceId: previous.sourceId,
    works,
    tombstones: [...tombstones.values()],
    refused: result.refused,
    observedAt: oldestObservedAt(works) ?? result.observedAt,
    complete: result.complete,
    lastRefresh
  };
}

/**
 * The state of one source, for as long as this process lives.
 *
 * `initial` EXISTS FOR THE IMPLEMENTATION THAT IS NOT WRITTEN YET, not for
 * convenience. A durable store loads a snapshot it did not produce -- written by
 * an earlier version of this code, or by another process, or edited by an
 * operator -- and everything downstream of `read()` has to be correct over such
 * a snapshot rather than only over one this process just committed. Being able
 * to seed one is what makes that testable at all: it is how the read path's
 * rights re-check can be exercised against a stored work whose basis no pass
 * would have accepted.
 */
export function createInMemoryCatalogStore(
  initial: CatalogStoreSnapshot | null = null
): CatalogStore {
  let snapshot = initial;
  return {
    read: () => Promise.resolve(snapshot),
    commit: (commit: CatalogPassCommit) => {
      const previous = snapshot ?? emptyCatalogSnapshot(commit.result.sourceId);
      snapshot = applyPassToSnapshot(previous, commit);
      return Promise.resolve(snapshot);
    }
  };
}
