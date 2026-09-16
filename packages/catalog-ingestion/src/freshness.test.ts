import { describe, expect, it } from "vitest";
import {
  assessFreshness,
  planNextPassAt,
  validateStalenessPolicy,
  type StalenessPolicy
} from "./freshness";

const MINUTE = 60_000;
const POLICY: StalenessPolicy = { freshForMs: 15 * MINUTE, staleAfterMs: 6 * 60 * MINUTE };
const OBSERVED = "2026-09-16T00:00:00.000Z";
const OBSERVED_MS = Date.parse(OBSERVED);

describe("validateStalenessPolicy", () => {
  it("accepts a policy whose two bounds are ordered", () => {
    expect(validateStalenessPolicy(POLICY)).toEqual({ ok: true });
    expect(validateStalenessPolicy({ freshForMs: MINUTE, staleAfterMs: MINUTE })).toEqual({
      ok: true
    });
  });

  /*
   * WHAT THIS CATCHES: the two numbers being configured the wrong way round. A
   * transposed policy makes `assessFreshness` answer `expired` for literally
   * everything, which surfaces as "the provider is down" and sends whoever is
   * debugging it to the network layer. Refusing at configuration time puts the
   * error where the mistake is.
   */
  it("refuses a policy whose bounds are transposed", () => {
    expect(validateStalenessPolicy({ freshForMs: 10 * MINUTE, staleAfterMs: MINUTE })).toEqual({
      ok: false,
      reason: "policy_not_ordered"
    });
  });

  it("refuses a non-positive or non-finite bound", () => {
    expect(validateStalenessPolicy({ freshForMs: 0, staleAfterMs: MINUTE }).ok).toBe(false);
    expect(validateStalenessPolicy({ freshForMs: -1, staleAfterMs: MINUTE }).ok).toBe(false);
    expect(
      validateStalenessPolicy({ freshForMs: MINUTE, staleAfterMs: Number.POSITIVE_INFINITY }).ok
    ).toBe(false);
    expect(validateStalenessPolicy({ freshForMs: Number.NaN, staleAfterMs: MINUTE }).ok).toBe(false);
  });
});

describe("assessFreshness", () => {
  it("reports the age and the state the policy assigns it", () => {
    const fresh = assessFreshness(OBSERVED, OBSERVED_MS + MINUTE, POLICY);
    expect(fresh).toEqual({
      ok: true,
      verdict: { freshness: "fresh", ageMs: MINUTE, observedAt: OBSERVED, policy: POLICY }
    });

    const stale = assessFreshness(OBSERVED, OBSERVED_MS + 60 * MINUTE, POLICY);
    expect(stale.ok && stale.verdict.freshness).toBe("stale");

    const expired = assessFreshness(OBSERVED, OBSERVED_MS + 24 * 60 * MINUTE, POLICY);
    expect(expired.ok && expired.verdict.freshness).toBe("expired");
  });

  /*
   * WHAT THIS CATCHES: the boundaries being inclusive on the wrong side. Both
   * are half-open -- age below `freshForMs` is fresh, age at or above
   * `staleAfterMs` is expired -- and an off-by-one here is invisible in ordinary
   * use and decisive exactly at the instant a test or an alert chooses.
   */
  it("treats both boundaries as half-open", () => {
    const atFreshBound = assessFreshness(OBSERVED, OBSERVED_MS + POLICY.freshForMs, POLICY);
    expect(atFreshBound.ok && atFreshBound.verdict.freshness).toBe("stale");

    const justInside = assessFreshness(OBSERVED, OBSERVED_MS + POLICY.freshForMs - 1, POLICY);
    expect(justInside.ok && justInside.verdict.freshness).toBe("fresh");

    const atStaleBound = assessFreshness(OBSERVED, OBSERVED_MS + POLICY.staleAfterMs, POLICY);
    expect(atStaleBound.ok && atStaleBound.verdict.freshness).toBe("expired");
  });

  /*
   * WHAT THIS CATCHES: a future timestamp being clamped to zero age. Clamping
   * rewards the least trustworthy input -- a provider with a wrong clock, or one
   * choosing its own timestamps -- with permanent freshness, and the record
   * would never be refreshed again. There is no grace window, deliberately.
   */
  it("refuses a record observed in the future rather than calling it maximally fresh", () => {
    expect(assessFreshness(OBSERVED, OBSERVED_MS - 1, POLICY)).toEqual({
      ok: false,
      reason: "observed_in_the_future"
    });
  });

  it("refuses an unparseable timestamp", () => {
    expect(assessFreshness("yesterday", OBSERVED_MS, POLICY)).toEqual({
      ok: false,
      reason: "observed_at_unparseable"
    });
  });

  it("refuses before it reads the clock when the policy itself is invalid", () => {
    expect(
      assessFreshness(OBSERVED, OBSERVED_MS, { freshForMs: 10 * MINUTE, staleAfterMs: MINUTE })
    ).toEqual({ ok: false, reason: "policy_not_ordered" });
  });
});

describe("planNextPassAt", () => {
  const cadence = { intervalMs: MINUTE, maxBackoffMs: 60 * MINUTE };

  it("uses the plain interval after a successful pass", () => {
    expect(planNextPassAt(1_000, 0, cadence)).toBe(1_000 + MINUTE);
  });

  it("backs off exponentially on consecutive failures", () => {
    expect(planNextPassAt(0, 1, cadence)).toBe(2 * MINUTE);
    expect(planNextPassAt(0, 3, cadence)).toBe(8 * MINUTE);
  });

  /*
   * WHAT THIS CATCHES: an uncapped exponential. Without the cap, a morning of
   * failures schedules the next attempt days out, so a provider that recovers at
   * noon is not asked again that day -- an outage that outlives its own cause.
   * The 200th attempt must still be exactly one cap away.
   */
  it("never schedules further out than the cap, however many failures there have been", () => {
    expect(planNextPassAt(0, 20, cadence)).toBe(cadence.maxBackoffMs);
    expect(planNextPassAt(0, 200, cadence)).toBe(cadence.maxBackoffMs);
    expect(Number.isFinite(planNextPassAt(0, 1_000_000, cadence))).toBe(true);
  });

  it("treats a negative or fractional attempt count as the nearest sane one", () => {
    expect(planNextPassAt(0, -5, cadence)).toBe(MINUTE);
    expect(planNextPassAt(0, 1.9, cadence)).toBe(2 * MINUTE);
  });
});
