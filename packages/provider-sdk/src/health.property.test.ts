import { PLAYABLE_CONTENT_RIGHTS } from "@liberty/contracts/shared/rights";
import {
  healthScoreArb,
  MAX_LIST_LENGTH,
  permutationKeysArb,
  permute,
  unvettedRightsArb
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  evaluateProviderHealth,
  healthRankingScore,
  providerHealthFromObservations,
  summariseHealthObservations,
  type HealthObservation,
  type HealthObservationSummary,
  type HealthOutcome,
  type ProviderHealthPolicy
} from "./health";
import { mapStremioStream, observedHealthScore, type StreamMappingContext } from "./stremio/mapping";
import type { StremioStream } from "./stremio/protocol";

/**
 * Provider health properties (fast-check).
 *
 * WHY THESE EXIST, and why they compare whole objects. Six order-dependence
 * defects have been found in this repository by hand and every one of them
 * passed a green example suite first; two of them were in a SECONDARY field of a
 * result whose primary field was already deterministic. So every invariance
 * property below asserts on the entire returned report -- status, score, sample
 * counts, policy version and the full reason trail -- because a defect in the
 * wording of a reason is exactly the defect that got through last time.
 *
 * The permutation properties are the load-bearing ones. The evaluator consumes
 * COUNTS, so it has no ordering to depend on and the property is trivially true
 * of it today; that is the point of the design and the property is what stops it
 * quietly stopping being true when somebody adds a "most recent outcome" field.
 */

/**
 * Spread from a typed array rather than passed as literals, matching how the
 * shared arbitraries read their vocabularies off the schemas: it keeps the
 * generator's element type tied to `HealthOutcome` instead of to whatever
 * `constantFrom` infers from two string literals.
 */
const HEALTH_OUTCOMES: readonly HealthOutcome[] = ["success", "failure"];

const observationArb: Arbitrary<HealthObservation> = fc.record(
  {
    outcome: fc.constantFrom(...HEALTH_OUTCOMES),
    observedAtMs: fc.integer({ min: 0, max: 20_000 })
  },
  // `noNullPrototype` on every record in this file, for the reporting reason
  // given in the shared arbitraries: a null-prototype object stringifies as
  // `{__proto__:null,...}` in every counterexample a human has to read.
  { noNullPrototype: true }
);

/**
 * Longer than `MAX_LIST_LENGTH` on purpose.
 *
 * Six observations cannot reach the pass band under this prior (five clean
 * successes are the minimum), so a suite capped at the shared length would
 * exercise `unknown`, `fail` and `warn` and never once generate a healthy
 * provider -- and "the healthy branch is the one that stopped carrying reasons"
 * is a live failure mode, not a hypothetical.
 */
const observationsArb: Arbitrary<HealthObservation[]> = fc.array(observationArb, {
  maxLength: MAX_LIST_LENGTH * 2
});

/** Counts as they reach the evaluator, including values no sane caller sends. */
const summaryArb: Arbitrary<HealthObservationSummary> = fc.record(
  {
    successes: fc.integer({ min: -20, max: 500 }),
    failures: fc.integer({ min: -20, max: 500 }),
    excludedByWindow: fc.integer({ min: -20, max: 50 })
  },
  { noNullPrototype: true }
);

/**
 * A policy that is coherent but not the shipped one.
 *
 * The thresholds are generated as a pair and then ordered, so `failBelow` never
 * exceeds `passAtOrAbove` -- an incoherent policy has defined behaviour (the
 * bands are evaluated fail-first) but asserting the band invariants against one
 * would be asserting the degradation rather than the contract. Hundredths keep a
 * shrunk counterexample readable, the same reasoning as `healthScoreArb`.
 */
const policyArb: Arbitrary<ProviderHealthPolicy> = fc
  .record(
    {
      priorSuccesses: fc.integer({ min: 1, max: 4 }),
      priorFailures: fc.integer({ min: 1, max: 4 }),
      thresholds: fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 })),
      windowMs: fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
      precision: fc.integer({ min: 2, max: 6 })
    },
    { noNullPrototype: true }
  )
  .map(({ priorSuccesses, priorFailures, thresholds, windowMs, precision }): ProviderHealthPolicy => {
    const [left, right] = thresholds;
    return {
      version: DEFAULT_PROVIDER_HEALTH_POLICY.version,
      priorSuccesses,
      priorFailures,
      failBelow: Math.min(left, right) / 100,
      passAtOrAbove: Math.max(left, right) / 100,
      windowMs,
      precision
    };
  });

const referenceInstantArb: Arbitrary<number> = fc.integer({ min: 0, max: 20_000 });

/**
 * Counts that no sane caller sends and that a boundary will eventually be sent
 * anyway: negatives, a fraction, a signed zero, and the three non-finite values.
 *
 * NaN is the one worth generating rather than assuming. It used to propagate
 * through the score onto every candidate, where `streamCandidateSchema` refused
 * the whole candidate -- so a counter that went wrong made the SOURCE disappear,
 * with a contract error as the only clue about where to look.
 */
const unusableCountArb: Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1_000, max: 0 }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5, -0)
);

describe("the whole report is a function of the SET of observations", () => {
  it("is identical under every permutation of the observation list", () => {
    fc.assert(
      fc.property(
        observationsArb,
        policyArb,
        referenceInstantArb,
        permutationKeysArb,
        (observations, policy, referenceInstantMs, keys) => {
          const canonical = providerHealthFromObservations(
            "archive",
            observations,
            policy,
            referenceInstantMs
          );
          const shuffled = providerHealthFromObservations(
            "archive",
            permute(observations, keys),
            policy,
            referenceInstantMs
          );
          expect(shuffled).toEqual(canonical);
        }
      )
    );
  });

  it("is identical under reversal, which no generated permutation is needed for", () => {
    // Identity IS a permutation and the property above must hold for it
    // trivially, so this sits beside it: the suite must not depend on the
    // generator happening to produce a non-trivial reordering.
    fc.assert(
      fc.property(observationsArb, policyArb, referenceInstantArb, (observations, policy, at) => {
        expect(providerHealthFromObservations("archive", [...observations].reverse(), policy, at)).toEqual(
          providerHealthFromObservations("archive", observations, policy, at)
        );
      })
    );
  });

  it("summarises to the same counts however the observations are ordered", () => {
    fc.assert(
      fc.property(
        observationsArb,
        policyArb,
        referenceInstantArb,
        permutationKeysArb,
        (observations, policy, at, keys) => {
          const summary = summariseHealthObservations(observations, policy, at);
          expect(summariseHealthObservations(permute(observations, keys), policy, at)).toEqual(summary);
          // Nothing is silently dropped: every observation is either counted or
          // recorded as excluded.
          expect(summary.successes + summary.failures + summary.excludedByWindow).toBe(
            observations.length
          );
        }
      )
    );
  });
});

describe("zero observations is unknown, under every policy", () => {
  it("never reports a pass, a warn, a fail or a number for an unmeasured provider", () => {
    fc.assert(
      fc.property(policyArb, fc.integer({ min: -20, max: 50 }), (policy, excludedByWindow) => {
        const verdict = evaluateProviderHealth(
          "archive",
          { successes: 0, failures: 0, excludedByWindow },
          policy
        );

        expect(verdict.status).toBe("unknown");
        expect(verdict.scoreBasis).toBe("prior");
        expect(verdict.observedSuccessRate).toBeNull();
        expect(verdict.sampleCount).toBe(0);
        /*
         * Ranked, but on a number labelled as the prior it is. The two halves of
         * the ruling: an unobserved provider is orderable, and the number that
         * orders it is not availability.
         *
         * Re-derived here from the policy's own pseudo-counts rather than read
         * back out of `healthPriorScore`, which would be asserting that a
         * function equals itself. The `toFixed` is not decoration: the published
         * score is rounded to the policy's precision, so an unrounded
         * expectation fails on any prior that is not exactly representable.
         */
        expect(healthRankingScore(verdict)).toBe(
          Number(
            (policy.priorSuccesses / (policy.priorSuccesses + policy.priorFailures)).toFixed(
              policy.precision
            )
          )
        );
        expect(verdict.reasons.map((reason) => reason.code)).toContain("prior_not_measurement");
      })
    );
  });

  it("reports unknown whenever the counts normalise away, however they arrived", () => {
    // Negative and fractional counts normalise to zero, so "we were handed
    // nonsense" and "we have nothing" report the same honest answer rather than
    // a NaN travelling as a score.
    fc.assert(
      fc.property(
        unusableCountArb,
        unusableCountArb,
        policyArb,
        (successes, failures, policy) => {
          const verdict = evaluateProviderHealth(
            "archive",
            { successes, failures, excludedByWindow: 0 },
            policy
          );
          expect(verdict.status).toBe("unknown");
          expect(Number.isFinite(healthRankingScore(verdict))).toBe(true);
        }
      )
    );
  });
});

describe("the score model's actual guarantees", () => {
  it("never lowers the score for a success, nor raises it for a failure", () => {
    /*
     * MONOTONICITY, and it is a real claim of the model rather than a
     * coincidence: Laplace's rule is strictly increasing in successes and
     * strictly decreasing in failures whenever the prior has a non-zero failure
     * pseudo-count, which `policyArb` guarantees. Asserted as `>=` and not `>`
     * because the published value is rounded, and rounding a monotone function
     * is monotone but not strictly so.
     *
     * The boundary is included deliberately: `min: 0` means the (0,0) -> (1,0)
     * and (0,0) -> (0,1) steps are generated, which is where the prior branch
     * meets the measured one. That crossing is only monotone because the prior
     * IS the smoothed value at zero observations -- pick any other prior and the
     * ranking jumps discontinuously the first time a provider is observed.
     *
     * WHERE THIS STOPS. Monotone in each count separately is all it says. It
     * does NOT say the ordering is confidence-adjusted: one success and a
     * hundred-observation record can score identically, and the score alone
     * cannot tell them apart. `sampleCount` is the field that can, and nothing
     * in the ranking currently reads it.
     */
    fc.assert(
      fc.property(
        fc.nat({ max: 500 }),
        fc.nat({ max: 500 }),
        policyArb,
        (successes, failures, policy) => {
          const at = (s: number, f: number): number =>
            healthRankingScore(
              evaluateProviderHealth("archive", { successes: s, failures: f, excludedByWindow: 0 }, policy)
            );

          const base = at(successes, failures);
          expect(at(successes + 1, failures)).toBeGreaterThanOrEqual(base);
          expect(at(successes, failures + 1)).toBeLessThanOrEqual(base);
          expect(base).toBeGreaterThanOrEqual(0);
          expect(base).toBeLessThanOrEqual(1);
        }
      )
    );
  });

  it("agrees with the mapper's observedHealthScore on every count", () => {
    // The reconciliation, as a property rather than a table. PL-0303 adds a
    // contract; it does not move a candidate.
    fc.assert(
      fc.property(fc.nat({ max: 500 }), fc.nat({ max: 500 }), (successes, failures) => {
        expect(
          healthRankingScore(
            evaluateProviderHealth(
              "archive",
              { successes, failures, excludedByWindow: 0 },
              DEFAULT_PROVIDER_HEALTH_POLICY
            )
          )
        ).toBe(observedHealthScore(successes, failures));
      })
    );
  });

  it("puts the status in the band the score is actually in, and always explains it", () => {
    fc.assert(
      fc.property(summaryArb, policyArb, (summary, policy) => {
        const verdict = evaluateProviderHealth("archive", summary, policy);

        // A verdict with no reasons is not a verdict. Asserted for every branch,
        // because the healthy one is the branch that stops explaining itself.
        expect(verdict.reasons.length).toBeGreaterThan(0);
        expect(verdict.policyVersion).toBe(policy.version);

        if (verdict.scoreBasis === "prior") {
          expect(verdict.status).toBe("unknown");
          return;
        }

        const score = verdict.measuredScore;
        if (verdict.status === "fail") expect(score).toBeLessThan(policy.failBelow);
        if (verdict.status === "pass") expect(score).toBeGreaterThanOrEqual(policy.passAtOrAbove);
        if (verdict.status === "warn") {
          // Degraded but usable: at or above the floor the media engine excludes
          // at, below the threshold that would call it healthy.
          expect(score).toBeGreaterThanOrEqual(policy.failBelow);
          expect(score).toBeLessThan(policy.passAtOrAbove);
        }
      })
    );
  });
});

describe("purity", () => {
  it("returns an identical whole report for identical inputs", () => {
    fc.assert(
      fc.property(summaryArb, policyArb, (summary, policy) => {
        expect(evaluateProviderHealth("archive", summary, policy)).toEqual(
          evaluateProviderHealth("archive", summary, policy)
        );
      })
    );
  });

  it("does not read the wall clock, whatever it is asked", () => {
    /*
     * The clock is broken across the CALL and nothing else -- not across
     * `fc.assert`, and not across the assertion that follows. A `Date.now()`
     * inside a scoring function returns a plausible number and is invisible to
     * every other property here; it only shows up months later as a verdict
     * nobody can reproduce from a bug report. Breaking the clock is the only way
     * to see it, and scoping the breakage to one expression is what stops this
     * test failing for reasons that have nothing to do with the code under test.
     */
    fc.assert(
      fc.property(observationsArb, policyArb, referenceInstantArb, (observations, policy, at) => {
        const realNow = Date.now;
        Date.now = (): number => {
          throw new Error("provider health must not read the wall clock");
        };
        try {
          providerHealthFromObservations("archive", observations, policy, at);
        } finally {
          Date.now = realNow;
        }
      })
    );
  });

  it("cannot be moved by the reference instant while the policy has no window", () => {
    // v1 ships `windowMs: null`. Time is an input to the signature and not to
    // the answer, and those are different claims -- only the first is true today.
    const unwindowed: ProviderHealthPolicy = { ...DEFAULT_PROVIDER_HEALTH_POLICY, windowMs: null };
    fc.assert(
      fc.property(
        observationsArb,
        referenceInstantArb,
        referenceInstantArb,
        (observations, left, right) => {
          expect(providerHealthFromObservations("archive", observations, unwindowed, left)).toEqual(
            providerHealthFromObservations("archive", observations, unwindowed, right)
          );
        }
      )
    );
  });
});

describe("health never affects entitlement", () => {
  const stream: StremioStream = { url: "https://cdn.example.com/film.mp4" };

  const context = (rights: StreamMappingContext["rights"], healthScore: number): StreamMappingContext => ({
    sourceId: "archive",
    rights,
    allowLoopback: false,
    localDeployment: false,
    acceptNotWebReady: false,
    observedLatencyMs: 120,
    healthScore
  });

  it("decides eligibility identically at every health score", () => {
    /*
     * The acceptance clause as a property. `unvettedRightsArb` reaches rights
     * values OUTSIDE the vocabulary -- the value somebody adds to the enum next
     * quarter without touching the allowlist -- because every current member is
     * playable and a well-typed generator could never reach the refusal branch
     * at all.
     *
     * The assertion is invariance, not just refusal: whatever the rights are,
     * the decision and its reason are the same at 0 as at 1. That is stronger
     * than "an unauthorised candidate is refused at perfect health", because it
     * also fails if health ever starts admitting something it used to refuse.
     */
    fc.assert(
      fc.property(unvettedRightsArb, healthScoreArb, healthScoreArb, (rights, low, high) => {
        const atLow = mapStremioStream(stream, context(rights, low));
        const atHigh = mapStremioStream(stream, context(rights, high));

        expect(atHigh.ok).toBe(atLow.ok);
        if (!atLow.ok && !atHigh.ok) {
          expect(atHigh.reason).toBe(atLow.reason);
          expect(atHigh.detail).toBe(atLow.detail);
        }
        if (!PLAYABLE_CONTENT_RIGHTS.includes(rights)) {
          expect(atHigh.ok).toBe(false);
          expect(!atHigh.ok && atHigh.reason).toBe("rights_not_playable");
        }
      })
    );
  });

  it("changes only the ranking signal when the candidate is authorized", () => {
    // Health moves where a candidate sits in the list, never whether it is
    // allowed to be in it: the mapped candidates differ in `healthScore` and in
    // nothing else.
    fc.assert(
      fc.property(healthScoreArb, healthScoreArb, (low, high) => {
        const atLow = mapStremioStream(stream, context("public-domain", low));
        const atHigh = mapStremioStream(stream, context("public-domain", high));
        expect(atLow.ok).toBe(true);
        expect(atHigh.ok).toBe(true);
        if (!atLow.ok || !atHigh.ok) return;
        expect({ ...atHigh.mapped.candidate, healthScore: low }).toEqual(atLow.mapped.candidate);
      })
    );
  });
});
