import type { ContentRights } from "@liberty/contracts/shared/rights";
import { MAX_LIST_LENGTH } from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import type { ResolvedEligibility } from "../eligibility";
import type { CatalogFactsInput, ProgressInput } from "../view";

/* -------------------------------------------------------------------------
 * Fixtures and arbitraries for the PL-0801 suites.
 *
 * Importing `@liberty/contracts/testing/arbitraries` is not incidental: that
 * module's import side effect is `fc.configureGlobal`, which pins the seed. An
 * unpinned property suite fails on one CI run in forty with a counterexample
 * nobody can reproduce, and an irreproducible failure gets retried until it
 * passes. Reaching for the shared module rather than configuring fast-check
 * again here keeps one seed for the repository.
 * ---------------------------------------------------------------------- */

/**
 * A small, fixed id pool.
 *
 * Small ON PURPOSE. The properties that matter here are about collisions —
 * the same work on the watchlist AND in progress, produced by two generators,
 * carrying two verdicts — and a wide id space generates disjoint sets that
 * exercise none of that.
 */
export const ID_POOL: readonly string[] = ["alpha", "beta-two", "gamma", "delta-4", "epsilon", "zeta-9"];

export const idArb = fc.constantFrom(...ID_POOL);

export const AT = "2026-08-21T09:00:00.000Z";

export function eligibleVerdict(contentId: string, rightsBasis: ContentRights = "licensed"): ResolvedEligibility {
  return { contentId, verdict: "eligible", rightsBasis };
}

export function ineligibleVerdict(contentId: string, reason = "no licence on file"): ResolvedEligibility {
  return { contentId, verdict: "not-eligible", rightsBasis: null, reason };
}

export function facts(contentId: string, overrides: Partial<CatalogFactsInput> = {}): CatalogFactsInput {
  return {
    contentId,
    kind: "movie",
    title: `Title of ${contentId}`,
    genre: "drama",
    releaseYear: 1994,
    ...overrides
  };
}

export function progress(contentId: string, overrides: Partial<ProgressInput> = {}): ProgressInput {
  return { contentId, positionSeconds: 600, runtimeSeconds: 7200, completed: false, ...overrides };
}

export interface RequestParts {
  readonly at?: string;
  readonly limit?: number;
  readonly eligibility?: readonly ResolvedEligibility[];
  readonly watchlist?: readonly string[];
  readonly progress?: readonly ProgressInput[];
  readonly catalog?: readonly CatalogFactsInput[];
}

/** A request with every field defaulted, so a test states only what it is about. */
export function request(parts: RequestParts = {}): Record<string, unknown> {
  return {
    at: parts.at ?? AT,
    limit: parts.limit ?? 10,
    eligibility: [...(parts.eligibility ?? [])],
    watchlist: [...(parts.watchlist ?? [])],
    progress: [...(parts.progress ?? [])],
    catalog: [...(parts.catalog ?? [])]
  };
}

const verdictArb: fc.Arbitrary<ResolvedEligibility> = fc.oneof(
  idArb.map((contentId) => eligibleVerdict(contentId)),
  idArb.map((contentId) => ineligibleVerdict(contentId))
);

const progressArb: fc.Arbitrary<ProgressInput> = fc
  .record({
    contentId: idArb,
    runtimeSeconds: fc.integer({ min: 1, max: 7200 }),
    completed: fc.boolean(),
    /* Generated as a ratio so `positionSeconds <= runtimeSeconds` holds by construction. */
    positionPercent: fc.integer({ min: 0, max: 100 })
  })
  .map(({ contentId, runtimeSeconds, completed, positionPercent }) => ({
    contentId,
    runtimeSeconds,
    completed,
    positionSeconds: Math.floor((runtimeSeconds * positionPercent) / 100)
  }));

const catalogArb: fc.Arbitrary<CatalogFactsInput> = fc
  .record({ contentId: idArb, releaseYear: fc.integer({ min: 1888, max: 2030 }) })
  .map(({ contentId, releaseYear }) => facts(contentId, { releaseYear }));

/**
 * Whole requests, including the contradictory ones.
 *
 * Verdicts are NOT deduplicated: conflicting verdicts for one id are exactly the
 * input that decides whether the seal fails closed, and generating only
 * well-formed eligibility would make the rights properties vacuous. Progress and
 * catalog ARE unique per id, because the request schema rejects duplicates there
 * and a generator that produced them would only be testing the validator.
 */
export const requestArb = fc.record({
  at: fc.constant(AT),
  limit: fc.integer({ min: 0, max: 10 }),
  eligibility: fc.array(verdictArb, { maxLength: MAX_LIST_LENGTH * 2 }),
  watchlist: fc.uniqueArray(idArb, { maxLength: MAX_LIST_LENGTH }),
  progress: fc.uniqueArray(progressArb, {
    selector: (entry) => entry.contentId,
    maxLength: MAX_LIST_LENGTH
  }),
  catalog: fc.uniqueArray(catalogArb, {
    selector: (entry) => entry.contentId,
    maxLength: MAX_LIST_LENGTH
  })
});

export interface GeneratedRequest {
  readonly at: string;
  readonly limit: number;
  readonly eligibility: ResolvedEligibility[];
  readonly watchlist: string[];
  readonly progress: ProgressInput[];
  readonly catalog: CatalogFactsInput[];
}
