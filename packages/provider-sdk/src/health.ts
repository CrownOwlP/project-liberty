/**
 * Provider health contract (PL-0303).
 *
 * THE ONE THING THIS FILE EXISTS TO PREVENT: zero observations reading as
 * fifty-percent health, and fifty-percent health reading as a pass.
 *
 * The adapter has always computed a Laplace-smoothed reliability number --
 * `(successes + 1) / (successes + failures + 2)` -- and handed it to
 * media-engine as `candidate.healthScore`. That number is a perfectly good
 * RANKING signal and it is kept, unchanged, to four decimal places. What it was
 * missing is a way to say where it came from: with no observations at all it is
 * exactly 0.5, and 0.5 sitting in a `healthScore` field is indistinguishable
 * from a source that was measured at fifty percent. One of those is a
 * measurement and the other is a prior, and the architecture ruling on this
 * (docs/RESEARCH_IDENTITY.md, PL-0303) is that *a Bayesian prior must not
 * masquerade as measured availability*.
 *
 * That is the same invariant PL-0205 applied to unknown media facts, arriving
 * independently in a different subsystem, so it is implemented with the same
 * discipline: the honest answer is made REPRESENTABLE, and then made the only
 * representable one.
 *
 * HOW THE TYPES ENFORCE IT, rather than a comment asking nicely.
 * `ProviderHealthReport` is a discriminated union of two shapes, not one shape
 * with four loosely-coupled fields:
 *
 *   - `UnobservedHealthReport` fixes `status: "unknown"`, `scoreBasis: "prior"`,
 *     `observedSuccessRate: null`, `sampleCount: 0`. Its status type does not
 *     admit `"pass"`, so "zero observations is not a pass" is a compile error
 *     rather than a test that could be deleted, and its rate type does not admit
 *     a number, so a prior cannot be written into the measured field at all.
 *   - `ObservedHealthReport` fixes `scoreBasis: "measured"`, excludes
 *     `"unknown"` from its status, and types `observedSuccessRate` as a plain
 *     number.
 *
 * And the number itself is named DIFFERENTLY on each branch -- `priorScore`
 * versus `measuredScore`. That is the load-bearing part. A shared `score` field
 * would let every consumer read the number without ever discriminating on
 * `scoreBasis`, which is precisely the read that turns a prior into an apparent
 * measurement; with two names, TypeScript refuses the read until the caller has
 * narrowed and therefore until the caller has seen which one it is holding.
 * `healthRankingScore` is the single, deliberately-named place that treats both
 * alike, and it is documented as a ranking input and nothing else.
 *
 * `warn` IS A STATE, NOT A POINT ON AN AXIS. Degraded-but-usable is the reason a
 * binary up/down health check was never sufficient here: this project already
 * ranks on a continuous score, so "down" was never the interesting answer. A
 * `warn` provider is ranked below a healthy one and is still served.
 *
 * PURITY. `observations + policy -> score + status + reasons`. No clock, no
 * counters, no I/O, no ambient state. Time is admitted as an input in exactly
 * one function -- `summariseHealthObservations`, whose reference instant is a
 * required parameter -- so a windowed or decayed policy remains reachable
 * without anyone ever reaching for `Date.now()` inside an evaluator. Nothing in
 * this file reads the wall clock, and a test enforces that by making `Date.now`
 * throw.
 *
 * ORDER INDEPENDENCE. The evaluator consumes COUNTS, so there is no ordering for
 * it to depend on; the summariser that produces those counts folds with `+`,
 * which is commutative. Six order-dependence defects have been found in this
 * repository by hand and every one of them passed a green example suite first,
 * so this is asserted over permutations of the whole observation list against
 * the whole returned report, not just the status.
 *
 * HEALTH IS NOT ENTITLEMENT, and the separation is structural. Nothing in this
 * file takes a `ContentRights`, a candidate, or a source; nothing it returns is
 * a boolean, an eligibility, or an authorization. A provider at a perfect score
 * still cannot make an unauthorised candidate eligible, because there is no
 * value here that any rights gate accepts as an argument. `health.test.ts`
 * carries a compile-time assertion that no report or observation type has grown
 * an entitlement-shaped field, and a runtime one that the rights gate refuses at
 * a perfect score exactly as it refuses at the worst one.
 *
 * WHERE THIS MODEL'S GUARANTEES END -- stated because a health number invites
 * more confidence than it has earned:
 *
 *   - It is PROVISIONAL and uncalibrated. The thresholds below were chosen for
 *     their behaviour at small sample sizes, not fitted to how real sources
 *     behave over time.
 *   - The smoothed score is a ranking signal, NOT a predicted probability that
 *     the next request succeeds. Do not surface it to a user as one.
 *   - It is memoryless within the window: a provider that failed a hundred times
 *     and then succeeded a hundred times scores identically to one that
 *     alternated. The model cannot see a trend, a recovery or a current outage,
 *     and the shipped policy sets `windowMs: null`, so it has no decay either.
 *     Fixing that means a persisted, shared, time-decayed estimator -- which is
 *     why the window machinery is here and exercised, and why turning it on is a
 *     deliberate policy change rather than a code change.
 *   - The SAMPLE SCOPE is whatever the caller counted. In the Stremio adapter
 *     today that is one provider object's own requests since construction: it is
 *     per-process, unshared across a multi-instance deployment, and resets on
 *     restart. `sampleCount` is published so a reader can see how little is
 *     behind a number instead of inferring it.
 *   - At around ten thousand consecutive failures the four-decimal rounding
 *     drives the score to exactly 0, so the "never permanently condemned"
 *     property of Laplace's rule stops holding at that scale. Recorded in
 *     `mapping.property.test.ts`; not fixed here.
 */

export const PROVIDER_HEALTH_STATUSES = ["unknown", "pass", "warn", "fail"] as const;

/**
 * `pass`/`warn`/`fail` borrows the control plane's gate vocabulary so an
 * operator reading a provider dashboard is not learning a second one -- plus
 * `unknown`, which that vocabulary does not have and which is the whole point.
 * `unknown` is not a fourth severity between `fail` and `warn`; it is the
 * absence of a severity, and it is what an unobserved provider reports.
 */
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number];

/**
 * Every policy this contract has ever shipped, newest last.
 *
 * A version STRING rather than a number, and carried on every report, because
 * the report is the thing that gets logged and compared across deployments: two
 * reports that disagree are only interesting if they were produced under the
 * same policy, and a reader cannot tell without being told. Adding a policy
 * means adding a member here, never editing one in place -- an edited policy
 * silently rewrites the meaning of every health record already stored under its
 * name.
 */
export const HEALTH_POLICY_VERSIONS = ["provider-health/2026-08-20.laplace-v1"] as const;

export type HealthPolicyVersion = (typeof HEALTH_POLICY_VERSIONS)[number];

/**
 * What a completed request is worth to health: it finished, or it did not.
 *
 * Deliberately two values. "Slow" is not a third: latency is already a scored
 * dimension on the candidate, and folding it in here would make one number mean
 * two things and make a latency regression indistinguishable from an outage.
 */
export type HealthOutcome = "success" | "failure";

export interface HealthObservation {
  readonly outcome: HealthOutcome;
  /**
   * When the request COMPLETED, ms since epoch, supplied by the caller.
   *
   * Supplied rather than read here. The adapter already threads an injectable
   * clock for exactly this reason, and a timestamp taken inside a policy
   * function is a hidden input that no test can pin and no bug report can
   * reproduce.
   */
  readonly observedAtMs: number;
}

/**
 * Observations reduced to what the evaluator actually needs.
 *
 * This shape is the reason the evaluator is order-independent by construction
 * rather than by care: counts have no order to depend on. `excludedByWindow` is
 * carried rather than dropped because an observation that was thrown away is a
 * fact about the verdict -- a provider reporting `unknown` because everything it
 * ever did fell outside the window is a very different situation from one that
 * has never been asked, and a summary that silently discarded the difference
 * would report both identically.
 */
export interface HealthObservationSummary {
  readonly successes: number;
  readonly failures: number;
  readonly excludedByWindow: number;
}

export interface ProviderHealthPolicy {
  readonly version: HealthPolicyVersion;
  /**
   * Laplace pseudo-counts. `1`/`1` is Laplace's rule of succession, which is
   * what the adapter has always used; the prior score is exactly
   * `priorSuccesses / (priorSuccesses + priorFailures)`.
   */
  readonly priorSuccesses: number;
  readonly priorFailures: number;
  /**
   * Below this the provider is `fail`.
   *
   * MUST agree with media-engine's `PROVIDER_HEALTH_FLOOR`, which excludes a
   * candidate outright at `healthScore < 0.5`. They are two constants that have
   * to hold one value, and provider-sdk cannot import media-engine -- so the
   * agreement is asserted in a comment here and reported as a contracts finding
   * rather than pretended away. If they ever diverge, `fail` stops meaning
   * "media-engine will drop this" and starts meaning nothing in particular.
   */
  readonly failBelow: number;
  /**
   * At or above this the provider is `pass`; between the two it is `warn`.
   *
   * 0.85 costs about five consecutive clean requests under this prior (five
   * successes reach 0.8571, four reach 0.8333), which is the intended shape: a
   * single lucky response must not buy a pass, and a provider has to show a
   * short clean run before it is called healthy.
   */
  readonly passAtOrAbove: number;
  /**
   * Observations older than this are not counted. `null` means NO WINDOW, which
   * is what v1 ships, so that adopting this contract changes no ranking number.
   * Turning it on is a policy version bump, not an edit.
   */
  readonly windowMs: number | null;
  /** Decimal places, matching media-engine's score precision. */
  readonly precision: number;
}

/**
 * The shipped policy.
 *
 * Chosen to reproduce the adapter's existing arithmetic EXACTLY -- prior 1/1,
 * four decimal places, no window -- so that PL-0303 adds a contract without
 * moving a single candidate in the ranking. What changes is that the number now
 * arrives labelled.
 */
export const DEFAULT_PROVIDER_HEALTH_POLICY: ProviderHealthPolicy = {
  version: "provider-health/2026-08-20.laplace-v1",
  priorSuccesses: 1,
  priorFailures: 1,
  failBelow: 0.5,
  passAtOrAbove: 0.85,
  windowMs: null,
  precision: 4
};

export type ProviderHealthReasonCode =
  | "no_observations"
  | "prior_not_measurement"
  | "observed_success_rate"
  | "measured_score_smoothed"
  | "observations_excluded_by_window"
  | "score_below_fail_threshold"
  | "score_within_degraded_band"
  | "score_at_or_above_pass_threshold";

/**
 * One line of the trail. Same `{code, detail}` shape every other decision
 * surface in this package uses, so a health verdict can be read beside a
 * playback decision without translating between two idioms.
 */
export interface ProviderHealthReason {
  readonly code: ProviderHealthReasonCode;
  readonly detail: string;
}

interface HealthReportCommon {
  readonly providerId: string;
  readonly policyVersion: HealthPolicyVersion;
  /** Observations the policy's window excluded. `0` under a null window. */
  readonly excludedByWindow: number;
  /**
   * Why this verdict, in a fixed order: sample basis, then window, then score
   * basis, then band.
   *
   * NEVER EMPTY, including on the healthy branch. A `pass` with no reasons is
   * the shape of every health check that turned out to be checking nothing, and
   * "it was fine" is not something a support engineer can act on when it later
   * is not.
   */
  readonly reasons: readonly ProviderHealthReason[];
}

/**
 * A provider nothing has been observed about.
 *
 * Every field that could carry a measurement is typed so that it cannot. There
 * is no assignment of `"pass"` to `status`, no assignment of a number to
 * `observedSuccessRate`, and no nonzero `sampleCount` -- so the acceptance
 * clause is held by `tsc`, not by a runtime branch someone might reorder.
 */
export interface UnobservedHealthReport extends HealthReportCommon {
  readonly status: "unknown";
  readonly scoreBasis: "prior";
  readonly observedSuccessRate: null;
  readonly sampleCount: 0;
  readonly successes: 0;
  readonly failures: 0;
  /**
   * The policy prior, offered ONLY so an unobserved provider can be ordered
   * against an observed one. It is not availability, it was not measured, and
   * the field is named so that no caller can read it while believing otherwise.
   */
  readonly priorScore: number;
}

export interface ObservedHealthReport extends HealthReportCommon {
  readonly status: Exclude<ProviderHealthStatus, "unknown">;
  readonly scoreBasis: "measured";
  /**
   * `successes / sampleCount`. The RAW measurement, unsmoothed: this is the
   * number that is entitled to the word "observed", and it is reported beside
   * `measuredScore` precisely because the two differ.
   */
  readonly observedSuccessRate: number;
  /** At least 1 by construction; the type cannot say so, the constructor does. */
  readonly sampleCount: number;
  readonly successes: number;
  readonly failures: number;
  /**
   * The ranking signal: the observed rate SMOOTHED toward the prior.
   *
   * `scoreBasis: "measured"` answers "is there any observation behind this
   * number", not "is this number free of the prior" -- at small sample sizes the
   * prior still moves it substantially, which is the property that stops one
   * lucky response outranking a long clean record. The
   * `measured_score_smoothed` reason says so on every report, and
   * `observedSuccessRate` above is the unsmoothed value for anyone who needs the
   * measurement rather than the ranking signal.
   */
  readonly measuredScore: number;
}

export type ProviderHealthReport = UnobservedHealthReport | ObservedHealthReport;

/**
 * A count from outside TypeScript's view becomes a count we can do arithmetic
 * with, or zero.
 *
 * NaN is folded to 0 rather than propagated. A NaN reaching the score turns into
 * a NaN `healthScore` on every candidate, which `streamCandidateSchema` then
 * rejects at the adapter boundary -- so the source disappears entirely, with a
 * contract failure as the only clue. Zero is the honest reading of "we cannot
 * count this", and it lands the provider on the `unknown` branch, which says so.
 */
function normaliseCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * `toFixed` throws a RangeError outside 0..100 decimal places, so the precision
 * is clamped rather than trusted. This contract promises to be TOTAL, and a
 * health evaluator that throws while being asked whether something is healthy is
 * the least useful failure available.
 */
function roundTo(value: number, precision: number): number {
  const places = Math.min(100, Math.max(0, Math.trunc(Number.isFinite(precision) ? precision : 0)));
  return Number(value.toFixed(places));
}

/** A prior pseudo-count. Fractional on purpose -- a Jeffreys prior is 0.5/0.5. */
function normalisePrior(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Laplace's rule of succession under this policy's prior.
 *
 * The single arithmetic behind both branches of the report AND behind
 * `observedHealthScore` in the Stremio mapper, which now delegates here. Two
 * implementations of "the health number" would agree today and disagree the
 * first time either was tuned, and the disagreement would surface as an adapter
 * ranking candidates by one number while a health dashboard reported another.
 *
 * Three properties earn it its place, all of them about the small-sample
 * behaviour rather than the asymptotics:
 *
 *   - with no observations it is exactly the prior, so the ranking function is
 *     CONTINUOUS across a provider's first observation and monotonicity holds
 *     across that boundary rather than jumping at it;
 *   - one success gives 0.6667, not 1.0, so a single response cannot make a
 *     brand-new source outrank a provider with a long clean record;
 *   - it never reaches 0 or 1 (within the rounding caveat in the header), so a
 *     source is neither permanently condemned by one failure nor permanently
 *     trusted.
 */
export function smoothedSuccessRate(
  successes: number,
  failures: number,
  policy: ProviderHealthPolicy
): number {
  const s = normaliseCount(successes);
  const f = normaliseCount(failures);
  const priorSuccesses = normalisePrior(policy.priorSuccesses);
  const priorFailures = normalisePrior(policy.priorFailures);
  const denominator = s + f + priorSuccesses + priorFailures;
  /*
   * A policy carrying no prior mass at all has no defined answer for an
   * unobserved provider -- it is 0/0. Zero rather than NaN, because a NaN here
   * reaches `candidate.healthScore`, where `streamCandidateSchema` refuses the
   * candidate and the whole SOURCE disappears with a contract error as the only
   * clue. Zero ranks such a provider last, which is visible and debuggable.
   */
  if (denominator <= 0) return 0;
  return roundTo((s + priorSuccesses) / denominator, policy.precision);
}

/** The score an unobserved provider ranks on. Not availability. See the header. */
export function healthPriorScore(policy: ProviderHealthPolicy): number {
  return smoothedSuccessRate(0, 0, policy);
}

/**
 * Timestamped observations become counts, against an EXPLICIT reference instant.
 *
 * The only function in this contract that time reaches, and it reaches it as a
 * parameter. That placement is the design: a decayed or windowed policy is a
 * real requirement (a source that was broken all week and recovered an hour ago
 * currently still scores as damaged), and the way that requirement usually
 * arrives is a `Date.now()` inside a scoring function, after which the score is
 * no longer reproducible from a bug report. Here the instant is as much an input
 * as the observations, so the same arguments always produce the same summary.
 *
 * The window is CLOSED at both ends: an observation counts when
 * `reference - windowMs <= observedAtMs <= reference`. Observations in the
 * future relative to the reference instant are excluded rather than counted,
 * because a timestamp ahead of the instant we are evaluating at is not evidence
 * about the interval we asked about -- it is a clock disagreement, and guessing
 * which clock is right is the failure mode PL-0403 refuses for the same reason.
 * A non-finite timestamp is excluded on the same footing.
 *
 * Under `windowMs: null` -- what v1 ships -- there is no window, every
 * observation counts, and `referenceInstantMs` is not read at all. It is still a
 * required parameter, so the signature cannot quietly grow a clock the day the
 * window is turned on.
 */
export function summariseHealthObservations(
  observations: readonly HealthObservation[],
  policy: ProviderHealthPolicy,
  referenceInstantMs: number
): HealthObservationSummary {
  let successes = 0;
  let failures = 0;
  let excludedByWindow = 0;

  for (const observation of observations) {
    if (!withinWindow(observation.observedAtMs, policy, referenceInstantMs)) {
      excludedByWindow++;
      continue;
    }
    if (observation.outcome === "success") successes++;
    else failures++;
  }

  // Folded with `+` only, so the summary is a function of the SET of
  // observations and not of the order they were appended in. Nothing downstream
  // sorts them, because there is nothing left to sort.
  return { successes, failures, excludedByWindow };
}

function withinWindow(
  observedAtMs: number,
  policy: ProviderHealthPolicy,
  referenceInstantMs: number
): boolean {
  if (policy.windowMs === null) return true;
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(referenceInstantMs)) return false;
  return observedAtMs >= referenceInstantMs - policy.windowMs && observedAtMs <= referenceInstantMs;
}

/**
 * The contract: observations plus a policy, in; a labelled verdict with a reason
 * trail, out.
 *
 * TOTAL and pure. There is no input it refuses and no input that makes it read
 * anything it was not handed, which is what lets a stored report be replayed
 * years later and produce the same verdict.
 *
 * The bands are evaluated FAIL FIRST, then PASS, then the remainder. That order
 * is not cosmetic: it is what a policy whose thresholds were configured
 * backwards (`failBelow` above `passAtOrAbove`) degrades into, and degrading
 * toward `fail` is the safe direction. Refusing such a policy outright was the
 * alternative and was rejected -- an evaluator that can throw is an evaluator a
 * caller has to guard, and a health check that throws while being asked whether
 * something is healthy is the least useful failure available.
 */
export function evaluateProviderHealth(
  providerId: string,
  summary: HealthObservationSummary,
  policy: ProviderHealthPolicy
): ProviderHealthReport {
  const successes = normaliseCount(summary.successes);
  const failures = normaliseCount(summary.failures);
  const excludedByWindow = normaliseCount(summary.excludedByWindow);
  const sampleCount = successes + failures;

  /*
   * Worded from the policy rather than from a template with a hole in it. Under
   * `windowMs: null` this evaluator excluded nothing, so a detail reading "fell
   * outside the nullms window" would be describing a rule that was not applied
   * -- and a reason trail that misdescribes the rule is worse than no reason,
   * because it sends whoever reads it to look at a window that does not exist.
   */
  const windowReasons: ProviderHealthReason[] =
    excludedByWindow > 0
      ? [
          {
            code: "observations_excluded_by_window",
            detail:
              policy.windowMs === null
                ? `${String(excludedByWindow)} observation(s) were reported as excluded, but this ` +
                  "policy declares no window; whatever dropped them did so before this evaluator " +
                  "saw them"
                : `${String(excludedByWindow)} observation(s) fell outside the ` +
                  `${String(policy.windowMs)}ms window ending at the supplied reference instant ` +
                  "and were not counted"
          }
        ]
      : [];

  if (sampleCount === 0) {
    const priorScore = healthPriorScore(policy);
    return {
      providerId,
      policyVersion: policy.version,
      excludedByWindow,
      status: "unknown",
      scoreBasis: "prior",
      observedSuccessRate: null,
      sampleCount: 0,
      successes: 0,
      failures: 0,
      priorScore,
      reasons: [
        {
          code: "no_observations",
          detail:
            "no completed requests have been counted for this provider, so its availability " +
            "has not been measured; sample count 0, observed success rate null"
        },
        ...windowReasons,
        {
          code: "prior_not_measurement",
          detail:
            `ranking score ${String(priorScore)} is the policy prior ` +
            `(${String(policy.priorSuccesses)} pseudo-successes of ` +
            `${String(policy.priorSuccesses + policy.priorFailures)}), not measured availability; ` +
            "it exists to order an unobserved provider against observed ones and asserts " +
            "nothing about whether this one works"
        }
      ]
    };
  }

  const observedSuccessRate = roundTo(successes / sampleCount, policy.precision);
  const measuredScore = smoothedSuccessRate(successes, failures, policy);

  return {
    providerId,
    policyVersion: policy.version,
    excludedByWindow,
    status: statusFor(measuredScore, policy),
    scoreBasis: "measured",
    observedSuccessRate,
    sampleCount,
    successes,
    failures,
    measuredScore,
    reasons: [
      {
        code: "observed_success_rate",
        detail:
          `${String(successes)} of ${String(sampleCount)} counted request(s) succeeded; ` +
          `observed success rate ${String(observedSuccessRate)}`
      },
      ...windowReasons,
      {
        code: "measured_score_smoothed",
        detail:
          `ranking score ${String(measuredScore)} smooths that rate toward the policy prior ` +
          `(${String(policy.priorSuccesses)}/${String(policy.priorSuccesses + policy.priorFailures)}); ` +
          `at ${String(sampleCount)} observation(s) the prior still moves it, which is what stops ` +
          "a short lucky run outranking a long clean record"
      },
      bandReason(measuredScore, policy)
    ]
  };
}

function statusFor(
  score: number,
  policy: ProviderHealthPolicy
): Exclude<ProviderHealthStatus, "unknown"> {
  if (score < policy.failBelow) return "fail";
  if (score >= policy.passAtOrAbove) return "pass";
  return "warn";
}

/**
 * The band, said out loud.
 *
 * `warn` gets the longest detail on purpose: it is the state most likely to be
 * misread as a soft failure, and it is not one. A degraded provider is USABLE --
 * it ranks below a healthy one and it is still served -- and the day someone
 * turns `warn` into an exclusion, this sentence is what they have to delete
 * first.
 */
function bandReason(score: number, policy: ProviderHealthPolicy): ProviderHealthReason {
  const status = statusFor(score, policy);
  if (status === "fail") {
    return {
      code: "score_below_fail_threshold",
      detail:
        `ranking score ${String(score)} is below the fail threshold ` +
        `${String(policy.failBelow)}, which is also the floor below which the media engine ` +
        "excludes a candidate outright"
    };
  }
  if (status === "pass") {
    return {
      code: "score_at_or_above_pass_threshold",
      detail:
        `ranking score ${String(score)} is at or above the pass threshold ` +
        `${String(policy.passAtOrAbove)}`
    };
  }
  return {
    code: "score_within_degraded_band",
    detail:
      `ranking score ${String(score)} is in the degraded band ` +
      `[${String(policy.failBelow)}, ${String(policy.passAtOrAbove)}): the provider is DEGRADED ` +
      "BUT USABLE, so it is ranked below a healthy one rather than excluded"
  };
}

/** The whole pipeline: timestamped observations to a labelled verdict. */
export function providerHealthFromObservations(
  providerId: string,
  observations: readonly HealthObservation[],
  policy: ProviderHealthPolicy,
  referenceInstantMs: number
): ProviderHealthReport {
  return evaluateProviderHealth(
    providerId,
    summariseHealthObservations(observations, policy, referenceInstantMs),
    policy
  );
}

/**
 * The one place a prior and a measurement are treated alike, and it is a RANKING
 * INPUT ONLY.
 *
 * Everything above exists to stop the two being confused; this function
 * deliberately confuses them, because ordering a list requires one number per
 * entry and an unobserved provider still has to sit somewhere in that list. It
 * is a single named function rather than a `score` field for exactly that
 * reason: the conflation happens in one place that can be found by searching for
 * its name, instead of at every property read.
 *
 * What it must never be used for: deciding whether a provider is healthy (read
 * `status`), reporting availability to a human (read `observedSuccessRate`, and
 * handle `null`), or anything touching entitlement (this number has no bearing
 * on entitlement whatsoever -- see the header).
 */
export function healthRankingScore(report: ProviderHealthReport): number {
  return report.scoreBasis === "prior" ? report.priorScore : report.measuredScore;
}
