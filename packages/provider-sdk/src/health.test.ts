import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  evaluateProviderHealth,
  healthPriorScore,
  healthRankingScore,
  providerHealthFromObservations,
  smoothedSuccessRate,
  summariseHealthObservations,
  type HealthObservation,
  type HealthObservationSummary,
  type ObservedHealthReport,
  type ProviderHealthPolicy,
  type ProviderHealthReasonCode,
  type ProviderHealthReport,
  type UnobservedHealthReport
} from "./health";
import { mapStremioStream, observedHealthScore, type StreamMappingContext } from "./stremio/mapping";
import type { StremioStream } from "./stremio/protocol";

/**
 * Provider health contract (PL-0303).
 *
 * The acceptance clause this file is written against, in its own words: a
 * provider with zero observations reports unknown with a null observed success
 * rate and a zero sample count, never a mid-range score and never a pass; any
 * prior used to rank an unobserved provider is labelled as a prior rather than
 * presented as measured availability; degraded-but-usable is a state distinct
 * from up and down; health output is pure over the observations plus an explicit
 * policy version, with no hidden wall-clock decay; and health never affects
 * entitlement.
 *
 * Each of those gets a `describe` below, in that order.
 */

const POLICY = DEFAULT_PROVIDER_HEALTH_POLICY;

const counts = (successes: number, failures: number): HealthObservationSummary => ({
  successes,
  failures,
  excludedByWindow: 0
});

const report = (successes: number, failures: number): ProviderHealthReport =>
  evaluateProviderHealth("archive", counts(successes, failures), POLICY);

const codes = (verdict: ProviderHealthReport): ProviderHealthReasonCode[] =>
  verdict.reasons.map((reason) => reason.code);

/**
 * Runs `work` with `Date.now` replaced by something that throws.
 *
 * Enforcing "no hidden wall clock" by breaking the clock rather than by reading
 * the source: a `Date.now()` inside a scoring function returns a plausible
 * number and is invisible to every other assertion in this file.
 */
function withoutAWallClock<Result>(work: () => Result): Result {
  const realNow = Date.now;
  Date.now = (): number => {
    throw new Error("provider health must not read the wall clock");
  };
  try {
    return work();
  } finally {
    Date.now = realNow;
  }
}

/* -------------------------------------------------------------------------
 * COMPILE-TIME half of the contract.
 *
 * These are not decoration and they are not duplicating the runtime assertions
 * below. The runtime tests prove that today's code produces `unknown` for zero
 * observations; the types prove that no future edit can produce anything else,
 * because there is no assignment that type-checks. `tsc --noEmit` is the
 * typecheck gate, so a regression here fails the build rather than a test file
 * somebody could delete alongside the change that broke it.
 *
 * Same device as `RefusesNull` in `stremio/mapping.test.ts`, which holds the
 * PL-0205 null-widening fix, and for the same reason: when the guarantee IS the
 * type, a runtime test cannot hold it.
 * ---------------------------------------------------------------------- */

type Refuses<Forbidden, Actual> = [Forbidden] extends [Actual] ? never : true;

const unobservedStatusRefusesPass: Refuses<"pass", UnobservedHealthReport["status"]> = true;
const unobservedStatusRefusesWarn: Refuses<"warn", UnobservedHealthReport["status"]> = true;
const unobservedStatusRefusesFail: Refuses<"fail", UnobservedHealthReport["status"]> = true;
const unobservedRateRefusesANumber: Refuses<number, UnobservedHealthReport["observedSuccessRate"]> = true;
const unobservedSampleCountRefusesNonZero: Refuses<1, UnobservedHealthReport["sampleCount"]> = true;
const observedStatusRefusesUnknown: Refuses<"unknown", ObservedHealthReport["status"]> = true;
const observedRateRefusesNull: Refuses<null, ObservedHealthReport["observedSuccessRate"]> = true;

/**
 * Fields that would let an availability signal reach an entitlement decision.
 *
 * A comment saying "health is not entitlement" is what every system that
 * conflated them had. This is the machine-checkable form: the day someone adds a
 * `rights` or an `eligible` to an observation or a verdict -- which is how the
 * conflation actually arrives, one convenient field at a time -- these stop
 * compiling.
 */
type EntitlementShapedKey =
  | "rights"
  | "rightsBasis"
  | "authorized"
  | "authorised"
  | "eligible"
  | "entitled"
  | "playable";

type CarriesNoEntitlement<T> = [Extract<keyof T, EntitlementShapedKey>] extends [never] ? true : never;

const observationsCarryNoEntitlement: CarriesNoEntitlement<HealthObservation> = true;
const summaryCarriesNoEntitlement: CarriesNoEntitlement<HealthObservationSummary> = true;
const policyCarriesNoEntitlement: CarriesNoEntitlement<ProviderHealthPolicy> = true;
const unobservedCarriesNoEntitlement: CarriesNoEntitlement<UnobservedHealthReport> = true;
const observedCarriesNoEntitlement: CarriesNoEntitlement<ObservedHealthReport> = true;

/**
 * The guard above is not vacuous.
 *
 * `CarriesNoEntitlement<{rights}>` must resolve to `never`, or all five
 * assertions above are `true = true` and prove nothing. A guard that cannot fail
 * is the most expensive kind of test there is.
 */
type GuardIsNotVacuous = CarriesNoEntitlement<{ readonly rights: string }> extends never ? true : false;

const guardDetectsAnEntitlementField: GuardIsNotVacuous = true;

describe("zero observations is not fifty-percent health, and it is not a pass", () => {
  it("reports unknown, a null observed rate and a zero sample count", () => {
    // The whole task, in one assertion. This is the record for a provider
    // nothing has ever been observed about.
    const verdict = report(0, 0);

    expect(verdict).toEqual({
      providerId: "archive",
      policyVersion: POLICY.version,
      excludedByWindow: 0,
      status: "unknown",
      scoreBasis: "prior",
      observedSuccessRate: null,
      sampleCount: 0,
      successes: 0,
      failures: 0,
      priorScore: 0.5,
      reasons: verdict.reasons
    });
    expect(codes(verdict)).toEqual(["no_observations", "prior_not_measurement"]);
  });

  it("still ranks, and ranks on exactly the number it always did", () => {
    /*
     * The reconciliation, stated as an assertion rather than as a claim in a doc
     * comment. `observedHealthScore` has fed `candidate.healthScore` since
     * PL-0301 and is Laplace-smoothed, so it has always returned 0.5 for zero
     * observations. PL-0303 does NOT change that number -- changing it would
     * move every unobserved source across media-engine's health floor, which is
     * a re-ranking wearing the costume of a labelling fix. What changes is that
     * the 0.5 now arrives as `priorScore` on a report that says `unknown`.
     */
    expect(healthRankingScore(report(0, 0))).toBe(observedHealthScore(0, 0));
    expect(healthRankingScore(report(0, 0))).toBe(0.5);
    expect(healthPriorScore(POLICY)).toBe(0.5);
  });

  it("does not call a single success a pass", () => {
    // One response is not a clean record. Laplace gives 0.6667, which is the
    // degraded band, and the reason trail says so.
    const verdict = report(1, 0);
    expect(verdict.status).toBe("warn");
    expect(healthRankingScore(verdict)).toBeCloseTo(0.6667, 4);
  });
});

describe("a prior is labelled as a prior, never as measured availability", () => {
  it("gives the same ranking number two completely different meanings", () => {
    /*
     * THE SHARPEST CASE IN THE CONTRACT. An unobserved provider and one measured
     * at one success and one failure rank on the identical number, 0.5. If the
     * report were a bare score they would be indistinguishable -- which is
     * exactly the confusion the architect's ruling names: a Bayesian prior must
     * not masquerade as measured availability.
     */
    const unobserved = report(0, 0);
    const measured = report(1, 1);

    expect(healthRankingScore(unobserved)).toBe(healthRankingScore(measured));

    expect(unobserved.scoreBasis).toBe("prior");
    expect(unobserved.status).toBe("unknown");
    expect(unobserved.observedSuccessRate).toBeNull();
    expect(unobserved.sampleCount).toBe(0);

    expect(measured.scoreBasis).toBe("measured");
    expect(measured.status).toBe("warn");
    expect(measured.observedSuccessRate).toBe(0.5);
    expect(measured.sampleCount).toBe(2);
  });

  it("says in words that the unobserved number was not measured", () => {
    const verdict = report(0, 0);
    const prior = verdict.reasons.find((reason) => reason.code === "prior_not_measurement");
    expect(prior?.detail).toContain("is the policy prior");
    expect(prior?.detail).toContain("not measured availability");
  });

  it("reports the raw measurement separately from the smoothed ranking signal", () => {
    /*
     * `measuredScore` is smoothed toward the prior, so it is NOT the observed
     * rate and must not be reported as one. Three of four requests succeeded --
     * the measurement is 0.75 -- while the number the candidate ranks on is
     * 0.6667. Both are published, and the reason trail says which is which.
     */
    const verdict = report(3, 1);
    expect(verdict.observedSuccessRate).toBe(0.75);
    expect(healthRankingScore(verdict)).toBeCloseTo(0.6667, 4);
    expect(codes(verdict)).toContain("measured_score_smoothed");
  });
});

describe("degraded-but-usable is a state, not a point on an up/down axis", () => {
  it("separates fail, degraded and pass into three distinct verdicts", () => {
    expect(report(0, 1).status).toBe("fail");
    expect(report(3, 1).status).toBe("warn");
    expect(report(5, 0).status).toBe("pass");
  });

  it("keeps a degraded provider above the floor the media engine excludes at", () => {
    /*
     * The distinction that makes `warn` worth having. A degraded provider is
     * USABLE: it ranks below a healthy one and it is still served. Its score
     * sits at or above `failBelow`, which is media-engine's
     * `PROVIDER_HEALTH_FLOOR` -- so `fail` means "media-engine will drop this"
     * and `warn` means "media-engine will keep it, ranked lower". If those two
     * constants ever disagree, this assertion is the one that stops meaning
     * anything, which is why the disagreement is called out in the policy.
     */
    const degraded = report(3, 1);
    expect(healthRankingScore(degraded)).toBeGreaterThanOrEqual(POLICY.failBelow);
    expect(healthRankingScore(degraded)).toBeLessThan(POLICY.passAtOrAbove);

    const band = degraded.reasons.find((reason) => reason.code === "score_within_degraded_band");
    expect(band?.detail).toContain("DEGRADED BUT USABLE");
  });

  it("costs a short clean run to reach a pass, not one lucky response", () => {
    // Four consecutive successes reach 0.8333 and are still degraded; five reach
    // 0.8571 and pass. That gap is the policy doing its job.
    expect(report(4, 0).status).toBe("warn");
    expect(report(5, 0).status).toBe("pass");
  });

  it("carries reasons on every branch, including the healthy one", () => {
    /*
     * A `pass` with no reasons is the shape of every health check that turned
     * out to be checking nothing. Asserted for all four statuses so the healthy
     * branch cannot be the one that quietly stops explaining itself.
     */
    for (const verdict of [report(0, 0), report(0, 1), report(3, 1), report(5, 0)]) {
      expect(verdict.reasons.length).toBeGreaterThan(0);
      for (const reason of verdict.reasons) expect(reason.detail).not.toBe("");
    }
    expect(codes(report(5, 0))).toEqual([
      "observed_success_rate",
      "measured_score_smoothed",
      "score_at_or_above_pass_threshold"
    ]);
  });
});

describe("purity: observations plus an explicit policy, and nothing else", () => {
  it("never reads the wall clock", () => {
    /*
     * Enforced by breaking the clock rather than by reading the source. A
     * `Date.now()` inside a scoring function is the single most common way a
     * health model stops being reproducible from a bug report, and it is
     * invisible to every other test in this file because it would still return a
     * plausible number.
     */
    // The clock is broken across the CALL and nothing else. Restored before any
    // matcher runs, so a matcher that happened to want the time cannot fail this
    // test for a reason that has nothing to do with the code under test.
    const evaluated = withoutAWallClock(() => report(3, 1));
    const summarised = withoutAWallClock(() =>
      providerHealthFromObservations("archive", [{ outcome: "success", observedAtMs: 10 }], POLICY, 20)
    );

    expect(evaluated.status).toBe("warn");
    expect(summarised.sampleCount).toBe(1);
  });

  it("returns an identical whole report for identical inputs", () => {
    expect(report(3, 1)).toEqual(report(3, 1));
  });

  it("ignores the reference instant entirely when the policy has no window", () => {
    /*
     * v1 ships `windowMs: null`, so time is admitted as a parameter and then not
     * consulted. Asserted because "the instant is an input" and "the instant
     * changes the answer" are different claims, and only the first one is true
     * of the shipped policy.
     */
    const observations: HealthObservation[] = [
      { outcome: "success", observedAtMs: 0 },
      { outcome: "failure", observedAtMs: 5_000_000 }
    ];
    expect(providerHealthFromObservations("archive", observations, POLICY, 0)).toEqual(
      providerHealthFromObservations("archive", observations, POLICY, 9_999_999)
    );
  });

  it("makes time change the answer only through an explicitly windowed policy", () => {
    const windowed: ProviderHealthPolicy = { ...POLICY, windowMs: 1_000 };
    const observations: HealthObservation[] = [
      { outcome: "failure", observedAtMs: 1_000 },
      { outcome: "success", observedAtMs: 9_000 }
    ];

    // Reference instant 9_000: the window is [8_000, 9_000], so the old failure
    // drops out and only the recent success is counted.
    const recent = providerHealthFromObservations("archive", observations, windowed, 9_000);
    expect(recent.sampleCount).toBe(1);
    expect(recent.excludedByWindow).toBe(1);
    expect(codes(recent)).toContain("observations_excluded_by_window");

    // Reference instant 1_500: [500, 1_500] catches the failure and excludes the
    // success, which is in the FUTURE relative to the instant we asked about.
    const earlier = providerHealthFromObservations("archive", observations, windowed, 1_500);
    expect(earlier.sampleCount).toBe(1);
    expect(earlier.status).toBe("fail");
  });

  it("reports unknown rather than a pass when the window excluded everything", () => {
    /*
     * A provider whose entire record fell outside the window has no measurement,
     * so it reports `unknown` -- and `excludedByWindow` is what distinguishes it
     * from one that was never asked. Dropping observations silently would make
     * those two situations produce identical records.
     */
    const windowed: ProviderHealthPolicy = { ...POLICY, windowMs: 100 };
    const verdict = providerHealthFromObservations(
      "archive",
      [
        { outcome: "success", observedAtMs: 0 },
        { outcome: "success", observedAtMs: 10 }
      ],
      windowed,
      1_000_000
    );

    expect(verdict.status).toBe("unknown");
    expect(verdict.observedSuccessRate).toBeNull();
    expect(verdict.sampleCount).toBe(0);
    expect(verdict.excludedByWindow).toBe(2);
    expect(codes(verdict)).toEqual([
      "no_observations",
      "observations_excluded_by_window",
      "prior_not_measurement"
    ]);
  });

  it("carries the policy version on every report", () => {
    // The report is the thing that gets logged and compared across deployments,
    // and two reports only mean the same thing if they were produced under the
    // same policy. A reader cannot tell without being told.
    expect(report(0, 0).policyVersion).toBe("provider-health/2026-08-20.laplace-v1");
    expect(report(5, 0).policyVersion).toBe("provider-health/2026-08-20.laplace-v1");
  });

  it("folds counts that arrived from outside TypeScript's view", () => {
    /*
     * Negative, fractional and non-finite counts. The first two preserve
     * `observedHealthScore`'s long-standing behaviour exactly; NaN is the one
     * that changed, and it changed toward honesty -- it used to propagate into
     * `candidate.healthScore`, where `streamCandidateSchema` rejected the whole
     * candidate and the source vanished with a contract error as the only clue.
     * Zero lands it on the `unknown` branch, which says what happened.
     */
    expect(evaluateProviderHealth("a", counts(-5, -5), POLICY).status).toBe("unknown");
    expect(healthRankingScore(evaluateProviderHealth("a", counts(2.9, 0.9), POLICY))).toBe(
      healthRankingScore(report(2, 0))
    );
    expect(evaluateProviderHealth("a", counts(Number.NaN, 3), POLICY).sampleCount).toBe(3);
  });
});

describe("health never affects entitlement", () => {
  const stream: StremioStream = { url: "https://cdn.example.com/film.mp4" };

  const mappingContext = (rights: string, healthScore: number): StreamMappingContext => ({
    sourceId: "archive",
    // Cast for the same reason `unvettedRightsArb` exists: every member of the
    // rights vocabulary is currently playable, so a well-typed value cannot
    // reach the refusal branch and the allowlist's guarantee is untestable.
    rights: rights as StreamMappingContext["rights"],
    allowLoopback: false,
    localDeployment: false,
    acceptNotWebReady: false,
    observedLatencyMs: 120,
    healthScore
  });

  it("refuses an unauthorized candidate at perfect health exactly as at zero", () => {
    /*
     * The acceptance clause, literally: a provider at perfect health still
     * cannot make an unauthorised candidate eligible. Health is an availability
     * signal; rights are an entitlement one; and the day an operational metric
     * can move a rights decision is the day the rights model stops being one.
     */
    for (const healthScore of [0, 0.5, 0.9999, 1]) {
      const refused = mapStremioStream(stream, mappingContext("unlicensed", healthScore));
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.reason).toBe("rights_not_playable");
    }
  });

  it("does not let health move an authorized candidate out of eligibility either", () => {
    // The mirror case. Health is a RANKING input, so a bad score changes where a
    // candidate sits in the list, never whether it is allowed to be in it.
    const worst = mapStremioStream(stream, mappingContext("public-domain", 0));
    const best = mapStremioStream(stream, mappingContext("public-domain", 1));
    expect(worst.ok).toBe(true);
    expect(best.ok).toBe(true);
    expect(worst.ok && worst.mapped.candidate.healthScore).toBe(0);
    expect(best.ok && best.mapped.candidate.healthScore).toBe(1);
  });

  it("computes a verdict from the observations and nothing else about the provider", () => {
    /*
     * The other half of the separation, and the reason rights CANNOT reach a
     * health verdict: the only thing a verdict knows about a provider beyond its
     * counts is which one it is, and even that is carried rather than consulted.
     * Two providers with the same record produce byte-identical reports once the
     * identity is set aside -- so there is no field for an entitlement to hide
     * in, and no branch for one to influence.
     *
     * The compile-time guard at the top of this file is the enforcing half; this
     * is the observable one.
     */
    const archive = evaluateProviderHealth("archive", counts(3, 1), POLICY);
    const mirror = evaluateProviderHealth("licensed-mirror", counts(3, 1), POLICY);
    expect({ ...mirror, providerId: "archive" }).toEqual(archive);
  });
});

describe("the summariser is a fold, not a scan", () => {
  it("counts outcomes without regard to the order they arrived in", () => {
    const observations: HealthObservation[] = [
      { outcome: "success", observedAtMs: 3 },
      { outcome: "failure", observedAtMs: 1 },
      { outcome: "success", observedAtMs: 2 }
    ];
    expect(summariseHealthObservations(observations, POLICY, 10)).toEqual({
      successes: 2,
      failures: 1,
      excludedByWindow: 0
    });
    expect(summariseHealthObservations([...observations].reverse(), POLICY, 10)).toEqual(
      summariseHealthObservations(observations, POLICY, 10)
    );
  });

  it("shares one arithmetic with the mapper's observedHealthScore", () => {
    // Two implementations of "the health number" would agree today and diverge
    // the first time either was tuned.
    for (const [successes, failures] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [7, 3],
      [500, 1]
    ] as const) {
      expect(smoothedSuccessRate(successes, failures, POLICY)).toBe(
        observedHealthScore(successes, failures)
      );
    }
  });
});
