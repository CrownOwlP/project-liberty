import {
  assessFreshness,
  planNextPassAt,
  validateStalenessPolicy,
  type FreshnessRefusal,
  type FreshnessVerdict,
  type RefreshCadence,
  type StalenessPolicy
} from "./freshness";
import { runIngestionPass, type IngestionPassResult } from "./ingest";
import type { CatalogMetadataProvider } from "./provider";
import {
  knownContentIdsOf,
  type CatalogStore,
  type CatalogStoreSnapshot
} from "./store";

/* -------------------------------------------------------------------------
 * When the next pass runs, decided by the freshness rules that already exist
 *
 * `docs/CATALOG_SOURCE.md` has said "`planNextPassAt` says when the next pass is
 * due; no process calls it" since PL-0305. This is the caller. It is NOT a
 * worker: there is no timer in this file, no `setInterval`, no `setTimeout` and
 * nothing that runs while a process is idle. What it provides is the decision --
 * given stored state, an operator's policy and an instant, may a pass run now --
 * and one function that acts on that decision. A read-triggered caller asks it
 * per read; a real background worker, when one is built, asks it on a tick. The
 * decision is the same either way, which is the point of separating it from
 * whatever drives it.
 *
 * ==========================================================================
 * THE FRESHNESS POLICY DRIVES THE SCHEDULE. IT IS NOT A SECOND SET OF NUMBERS
 * ==========================================================================
 *
 * A `RefreshCadence` has an `intervalMs` and a `StalenessPolicy` has a
 * `freshForMs`, and the obvious thing to do is let an operator state both. That
 * is refused here, and `catalogRefreshCadence` derives the interval FROM the
 * policy instead, because two numbers that mean "how long an answer may be
 * trusted" can be configured out of step -- and the failure is silent and
 * total. Set the interval to an hour and the fresh bound to five minutes, and
 * every answer the deployment ever serves is stale by its own stated policy,
 * while the schedule reports itself as working perfectly. Set them the other way
 * and the source is hammered for answers that are still fresh.
 *
 * So there is ONE number: an answer stops being fresh and a pass becomes due at
 * the same bound, by construction. What an operator states on top of it is the
 * backoff cap, which is about a provider that is DOWN and has nothing to do with
 * how old an answer may be.
 *
 * BACKOFF IS NOT REIMPLEMENTED. `planNextPassAt` owns exponential backoff and
 * its cap, including the overflow reasoning; this file calls it and does no
 * arithmetic on an interval of its own. The consecutive-failure count it takes
 * comes off the stored snapshot rather than out of a variable in here -- see
 * `CatalogRefreshRecord` in `store.ts` for why the count belongs beside the
 * state it describes.
 *
 * WHY THE DUE TIME IS THE ONLY GATE, and the freshness verdict does not get a
 * vote of its own. `planNextPassAt(endedAt, 0, cadence)` is `endedAt +
 * freshForMs`, and a pass ends at or after the instant it observed the source,
 * so the due time is never EARLIER than the instant the state stops being fresh.
 * Checking both would therefore change no outcome and would add a second place
 * where the rule is written. The verdict is computed all the same -- once, here
 * -- and carried on the plan, so the answer's stated age and the schedule come
 * out of the same assessment rather than being worked out twice from the same
 * inputs.
 *
 * NO JITTER IS ADDED, AND `freshness.ts` NAMES THIS FILE AS WHERE IT WOULD GO.
 * That note is about a fleet of instances whose TIMERS drift into lockstep and
 * then all fire together. Nothing here has a timer: a pass happens when a read
 * arrives and finds the state due, so the spread of passes across a fleet is
 * already the spread of that fleet's traffic. Adding a random offset would make
 * the due time unpredictable without dispersing a herd that does not exist. The
 * one real herd on this path is a fleet cold-starting together at a deploy, and
 * jitter would not help there either -- those instances have no state and must
 * each fetch before they can answer anything. When a timer-driven worker is
 * built, jitter belongs in it, with the randomness injected as `freshness.ts`
 * says.
 * ---------------------------------------------------------------------- */

/**
 * The operator's refresh configuration, and all of it.
 *
 * `policy` is the one an answer is described against AND the one the schedule is
 * derived from. `maxBackoffMs` is the cap `planNextPassAt` requires -- required
 * rather than optional there for a stated reason: an uncapped exponential
 * reaches "next Tuesday" after a morning of failures, so a provider that came
 * back at noon is not asked again that day.
 */
export interface CatalogRefreshSchedule {
  readonly policy: StalenessPolicy;
  readonly maxBackoffMs: number;
}

export type CatalogScheduleRefusal = FreshnessRefusal | "backoff_cap_not_positive";

/**
 * Checks a schedule at configuration time rather than once per read.
 *
 * Separate from the planning below for the reason `validateStalenessPolicy` is
 * separate from `assessFreshness`: a transposed policy would otherwise mark
 * everything expired at runtime and present as a provider outage, and a
 * composition root can answer this before it serves a request.
 */
export function validateCatalogRefreshSchedule(
  schedule: CatalogRefreshSchedule
): { readonly ok: true } | { readonly ok: false; readonly reason: CatalogScheduleRefusal } {
  const policy = validateStalenessPolicy(schedule.policy);
  if (!policy.ok) return policy;
  if (!Number.isFinite(schedule.maxBackoffMs) || schedule.maxBackoffMs <= 0) {
    return { ok: false, reason: "backoff_cap_not_positive" };
  }
  return { ok: true };
}

/**
 * The cadence, derived rather than stated. See the header.
 *
 * Exported because the derivation is the claim: a reader who wants to check that
 * the schedule really is the freshness policy and not a second opinion should be
 * able to call this and compare, and a test should be able to assert the
 * identity rather than trust a comment.
 */
export function catalogRefreshCadence(schedule: CatalogRefreshSchedule): RefreshCadence {
  return { intervalMs: schedule.policy.freshForMs, maxBackoffMs: schedule.maxBackoffMs };
}

/**
 * Why a refresh is or is not due.
 *
 * `policy_not_stated` -- no schedule was configured, so nothing may be described
 * as fresh and nothing may be reused; every read refreshes. This is the
 * behaviour that predates scheduling, kept reachable BY NAME rather than by a
 * default policy invented on an operator's behalf.
 * `no_stored_state` -- nothing is stored and nothing has been attempted.
 * `state_not_fresh` -- the stored state reached the policy's fresh bound.
 * `state_fresh` -- served from store; the state is inside the fresh bound.
 * `backing_off` -- the last attempt failed and the capped backoff has not
 * elapsed. Distinct from `state_fresh` because the state being served may be
 * arbitrarily old: what is holding the pass back is the provider, not the age.
 */
export type CatalogRefreshReason =
  | "policy_not_stated"
  | "no_stored_state"
  | "state_not_fresh"
  | "state_fresh"
  | "backing_off";

export interface CatalogRefreshPlan {
  readonly due: boolean;
  /** When a pass may next run. `null` when nothing has been attempted, so: now. */
  readonly dueAtMs: number | null;
  readonly reason: CatalogRefreshReason;
  /**
   * How old the state THIS DECISION WAS TAKEN AGAINST is.
   *
   * Not necessarily the age of the answer that follows: when the plan says a
   * pass is due and the pass succeeds, the state being served afterwards is
   * newer than the one assessed here. `CatalogRefreshRun.verdict` is the one an
   * answer publishes, and both come out of `assessStoredFreshness` so the two
   * readings cannot be computed by two different rules.
   *
   * `null` when there is no policy, when nothing is stored, or when
   * `assessFreshness` refused the stored timestamp -- which happens when a
   * provider's clock put an observation in the future, and is a refusal rather
   * than a clamp for the reason `freshness.ts` gives.
   */
  readonly verdict: FreshnessVerdict | null;
}

/**
 * The age of stored state under an operator's policy, or no claim at all.
 *
 * ONE FUNCTION, TWO CALLERS, WHICH IS THE POINT. The scheduler's reason and the
 * age an answer publishes are the same assessment of the same field against the
 * same policy, so they are made here and nowhere else. A second `assessFreshness`
 * call site with its own argument order is how an answer ends up describing
 * itself as fresh while the schedule treats it as due.
 *
 * `null` IS "NO AGE IS CLAIMED", NOT "AGE ZERO". An operator who stated no
 * policy gets no verdict, because a verdict is a judgement against a bound
 * nobody wrote; a state nothing has ever observed gets none either.
 */
export function assessStoredFreshness(
  snapshot: CatalogStoreSnapshot | null,
  schedule: CatalogRefreshSchedule | null,
  nowMs: number
): FreshnessVerdict | null {
  if (schedule === null || snapshot === null || snapshot.observedAt === null) return null;
  const assessment = assessFreshness(snapshot.observedAt, nowMs, schedule.policy);
  return assessment.ok ? assessment.verdict : null;
}

/**
 * Whether a pass may run now, and what the stored state's age is.
 *
 * PURE, AND TAKES THE INSTANT. No clock is read here; `nowMs` is a parameter for
 * the same reason it is one throughout `freshness.ts`, so that a scheduling test
 * states the time it means instead of passing at different rates on different
 * days.
 */
export function planCatalogRefresh(
  snapshot: CatalogStoreSnapshot | null,
  schedule: CatalogRefreshSchedule | null,
  nowMs: number
): CatalogRefreshPlan {
  if (schedule === null) {
    return { due: true, dueAtMs: nowMs, reason: "policy_not_stated", verdict: null };
  }

  const lastRefresh = snapshot?.lastRefresh ?? null;
  if (snapshot === null || lastRefresh === null || lastRefresh.endedAtMs === null) {
    return { due: true, dueAtMs: null, reason: "no_stored_state", verdict: null };
  }

  const dueAtMs = planNextPassAt(
    lastRefresh.endedAtMs,
    lastRefresh.consecutiveFailures,
    catalogRefreshCadence(schedule)
  );
  const due = nowMs >= dueAtMs;

  const verdict = assessStoredFreshness(snapshot, schedule, nowMs);

  const reason: CatalogRefreshReason = due
    ? snapshot.observedAt === null
      ? "no_stored_state"
      : "state_not_fresh"
    : lastRefresh.consecutiveFailures > 0
      ? "backing_off"
      : "state_fresh";

  return { due, dueAtMs, reason, verdict };
}

/** How much of the source one pass reads. */
export interface CatalogRefreshPassOptions {
  readonly pageSize: number;
  readonly maxPages: number;
}

export interface CatalogRefreshDependencies {
  readonly provider: CatalogMetadataProvider;
  readonly store: CatalogStore;
  /** `null` means no policy was stated: every call refreshes. */
  readonly schedule: CatalogRefreshSchedule | null;
  readonly pass: CatalogRefreshPassOptions;
  readonly now: () => number;
}

export interface CatalogRefreshRun {
  /** The state to answer from. `null` only when nothing was stored and no pass ran. */
  readonly snapshot: CatalogStoreSnapshot | null;
  readonly plan: CatalogRefreshPlan;
  /** Whether a pass actually ran on this call. */
  readonly refreshed: boolean;
  readonly result: IngestionPassResult | null;
  /**
   * The age of the state being returned, which is the age an answer publishes.
   *
   * Distinct from `plan.verdict`, which is the age the DECISION was taken
   * against: a read that refreshed successfully is answering from state the plan
   * never saw, and reporting the pre-refresh age there would describe a
   * just-fetched catalog as stale. Both come from `assessStoredFreshness`.
   */
  readonly verdict: FreshnessVerdict | null;
}

/**
 * Run a pass if the schedule says one is due, and commit whatever it produced.
 *
 * THE FUNCTION A WORKER WOULD CALL, WHICH IS WHY IT IS HERE AND NOT IN THE
 * `apps/web` ADAPTER. The adapter's job is projecting stored state into the
 * application's port for one reader; deciding whether to go out to a third party
 * is an ingestion concern and belongs beside the pass. Putting it here also
 * means the day a background worker exists it calls this, on a tick, with the
 * same store -- and the read path and the worker cannot then disagree about when
 * a pass is due or about what a pass does to state.
 *
 * `resumeCursor` IS ALWAYS `null`, AND THAT IS NOT AN OVERSIGHT. Resuming a
 * bounded pass from the cursor the last one returned is the obvious way to
 * backfill a source too large for `maxPages`, and it is unsafe against
 * `ingest.ts` as it stands: `complete` there means the enumeration REACHED THE
 * END, not that it read the whole source, so a resumed pass that starts at a
 * cursor and runs off the end reports `complete: true` while having seen only a
 * tail segment -- and `reconcileTombstones` would then tombstone every known id
 * from the pages it skipped. That is a mass deletion reachable from an ordinary
 * configuration. Starting every pass at the beginning costs re-reading the
 * prefix and is safe; fixing the hazard is a change to `ingest.ts`'s completeness
 * rule with its own review, and is recorded in `docs/CATALOG_SOURCE.md`.
 *
 * `changedSince` IS ALWAYS `null` for the reason the adapter already gave: an
 * incremental pass asks for a SUBSET, and a subset merged into stored state
 * cannot mint a tombstone, so a deployment that only ever synced incrementally
 * would never learn that anything was deleted. Incremental sync is worth having
 * and needs its own design for how a full reconciliation is interleaved with it.
 *
 * `knownContentIds` IS THE LIVE STORED SET, which is what finally makes
 * tombstones reachable at all: the adapter used to pass an empty list because it
 * had no store, and an empty known set makes `reconcileTombstones` mint nothing.
 * Already-tombstoned ids are excluded, so a complete pass does not re-report
 * them and the union in `applyPassToSnapshot` keeps them.
 */
export async function refreshCatalogIfDue(
  deps: CatalogRefreshDependencies
): Promise<CatalogRefreshRun> {
  const before = await deps.store.read();
  const plan = planCatalogRefresh(before, deps.schedule, deps.now());
  if (!plan.due) {
    return { snapshot: before, plan, refreshed: false, result: null, verdict: plan.verdict };
  }

  const result = await runIngestionPass(
    deps.provider,
    {
      pageSize: deps.pass.pageSize,
      maxPages: deps.pass.maxPages,
      resumeCursor: null,
      changedSince: null,
      knownContentIds: knownContentIdsOf(before)
    },
    { now: deps.now }
  );

  const snapshot = await deps.store.commit({ result, endedAtMs: deps.now() });
  return {
    snapshot,
    plan,
    refreshed: true,
    result,
    /*
     * ASSESSED AFTER THE COMMIT, against the state a caller is about to serve.
     * A failed pass leaves the previous state in place, so this correctly
     * reports the old age; a successful one replaces it, so this reports the new
     * one. Reusing `plan.verdict` here would publish the age of a state that no
     * longer exists.
     */
    verdict: assessStoredFreshness(snapshot, deps.schedule, deps.now())
  };
}
