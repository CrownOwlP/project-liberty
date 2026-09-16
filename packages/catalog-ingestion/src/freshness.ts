/* -------------------------------------------------------------------------
 * Refresh, staleness, and how old an answer is
 *
 * `docs/CATALOG_SOURCE.md` records the gap this closes: "No TTL, no cache, no
 * invalidation, no `updatedAt`. `listRecords` is asked and answers; how old the
 * answer is, nobody records." The acceptance criterion is narrower and sharper
 * than a cache -- "an answer carries its age and a stated staleness policy, so
 * nobody has to guess how old a rail is" -- and that is what this module is.
 *
 * IT IS NOT A CACHE, and deliberately so. Nothing here stores anything, evicts
 * anything or decides to refetch. It answers ONE question -- given when a record
 * was observed, when it is being read, and what the operator's policy says, how
 * should this answer be described -- and it answers it as data the caller can
 * publish. A cache that decided by itself would put the staleness rule in a
 * place a reader of a rail cannot see; a verdict attached to the answer travels
 * with it.
 *
 * THREE STATES RATHER THAN TWO. `fresh` and `expired` alone would force a
 * choice between serving nothing and serving something misdescribed the moment a
 * TTL lapses. Real catalogs are large, providers go down, and an hour-old rail
 * is overwhelmingly better than an error page -- but only if the reader is told.
 * `stale` is the servable-with-a-caveat state, and `expired` is the one where
 * the operator has said the answer is too old to present as current.
 *
 * TIME IS INJECTED, NEVER READ. `nowMs` is a parameter on every function here
 * and no module-scope clock exists, because a staleness rule tested against the
 * real clock is a test that passes at different rates on different days.
 * ---------------------------------------------------------------------- */

export type Freshness = "fresh" | "stale" | "expired";

/**
 * The operator's stated policy, in milliseconds.
 *
 * `freshForMs` -- below this age an answer is current. `staleAfterMs` -- at or
 * beyond this age it is too old to present as current. Between them is `stale`.
 *
 * TWO NUMBERS RATHER THAN ONE TTL, because one number cannot express the
 * degrade-gracefully behaviour above: a single TTL makes every answer either
 * perfect or unusable at the instant it crosses. Setting them equal collapses
 * this back to one TTL, which is a legitimate policy and is why equality is
 * allowed.
 */
export interface StalenessPolicy {
  readonly freshForMs: number;
  readonly staleAfterMs: number;
}

export type FreshnessRefusal =
  | "observed_at_unparseable"
  | "observed_in_the_future"
  | "policy_not_ordered"
  | "policy_not_positive";

export interface FreshnessVerdict {
  readonly freshness: Freshness;
  readonly ageMs: number;
  readonly observedAt: string;
  readonly policy: StalenessPolicy;
}

export type FreshnessAssessment =
  | { readonly ok: true; readonly verdict: FreshnessVerdict }
  | { readonly ok: false; readonly reason: FreshnessRefusal };

/**
 * Checks a policy is one a verdict can be computed against.
 *
 * Separate from `assessFreshness` because an operator wants this answered at
 * configuration time, not once per record: a policy with the two numbers
 * transposed would otherwise mark literally everything `expired` at runtime and
 * present as "the provider is down".
 */
export function validateStalenessPolicy(
  policy: StalenessPolicy
): { readonly ok: true } | { readonly ok: false; readonly reason: FreshnessRefusal } {
  if (
    !Number.isFinite(policy.freshForMs) ||
    !Number.isFinite(policy.staleAfterMs) ||
    policy.freshForMs <= 0 ||
    policy.staleAfterMs <= 0
  ) {
    return { ok: false, reason: "policy_not_positive" };
  }
  if (policy.freshForMs > policy.staleAfterMs) {
    return { ok: false, reason: "policy_not_ordered" };
  }
  return { ok: true };
}

/**
 * How old an answer is, and what the policy says about that.
 *
 * A FUTURE `observedAt` IS REFUSED RATHER THAN CLAMPED TO ZERO. Clamping would
 * report the freshest possible verdict for the least trustworthy possible input:
 * a provider whose clock is wrong, or one asserting a timestamp it chose, would
 * be rewarded with permanent freshness. The only remedies are an operator
 * noticing, or this refusal. Small negative skew is not tolerated either --
 * there is no grace window, because a grace window is a number that would have
 * to be justified and every value of it is arbitrary.
 *
 * The boundaries are half-open: age below `freshForMs` is fresh, age at or above
 * `staleAfterMs` is expired. Stated because "expires after an hour" read as
 * inclusive or exclusive differs by one millisecond a year and by a whole state
 * at exactly the boundary a test will choose.
 */
export function assessFreshness(
  observedAt: string,
  nowMs: number,
  policy: StalenessPolicy
): FreshnessAssessment {
  const valid = validateStalenessPolicy(policy);
  if (!valid.ok) return valid;

  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return { ok: false, reason: "observed_at_unparseable" };

  const ageMs = nowMs - observedMs;
  if (ageMs < 0) return { ok: false, reason: "observed_in_the_future" };

  const freshness: Freshness =
    ageMs < policy.freshForMs ? "fresh" : ageMs < policy.staleAfterMs ? "stale" : "expired";

  return { ok: true, verdict: { freshness, ageMs, observedAt, policy } };
}

/**
 * A value, and how old it is.
 *
 * The shape a source hands a surface when the surface has to be able to say
 * "this rail was built from data N minutes old". Generic because the ageing rule
 * is identical whether the value is one record, a page of them, or a whole rail
 * -- and a per-shape copy is how two of them end up disagreeing.
 */
export interface DatedAnswer<TValue> {
  readonly value: TValue;
  readonly verdict: FreshnessVerdict;
}

/**
 * The next time a source should be asked again.
 *
 * `attempt` is the count of CONSECUTIVE FAILURES, so 0 means the last pass
 * succeeded and the cadence is the plain refresh interval. Backoff is
 * exponential on the interval and capped, and the cap is required rather than
 * optional: an uncapped exponential reaches "next Tuesday" after a morning of
 * failures, at which point a provider that came back at noon is not asked again
 * that day.
 *
 * NO JITTER IS ADDED HERE, and that is a decision rather than an omission. This
 * function is pure and its determinism is what makes it testable; a random
 * offset belongs in the scheduler that CALLS it, where the randomness can be
 * injected. Stated because a fleet of instances all backing off in lockstep is a
 * real thundering-herd problem and somebody has to own it -- it is just not this
 * function.
 */
export interface RefreshCadence {
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
}

export function planNextPassAt(
  lastPassEndedAtMs: number,
  attempt: number,
  cadence: RefreshCadence
): number {
  const clampedAttempt = Math.max(0, Math.floor(attempt));
  // `2 ** clampedAttempt` overflows to Infinity for a large attempt count, and
  // `Math.min` with Infinity answers the cap, which is the intended behaviour --
  // but the exponent is bounded anyway so the intermediate stays finite and a
  // reader does not have to reason about Infinity to believe the result.
  const factor = 2 ** Math.min(clampedAttempt, 30);
  const delay = Math.min(cadence.intervalMs * factor, cadence.maxBackoffMs);
  return lastPassEndedAtMs + delay;
}
