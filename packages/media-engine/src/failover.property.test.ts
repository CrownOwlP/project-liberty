import {
  PLAYBACK_FAILURE_KINDS,
  type FailoverPolicy,
  type PlaybackAttemptFailure
} from "@liberty/contracts/domains/failover";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import {
  defined,
  failoverPolicyArb,
  failuresArb,
  permutationKeysArb,
  permute,
  playbackCapabilitiesArb,
  playbackFailureKindArb,
  streamCandidatesArb,
  unvettedRightsCandidatesArb
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PLAYABLE_RIGHTS,
  type PlaybackDecision
} from "./ranking";
import {
  PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE,
  PLAYBACK_FAILURE_POLICY,
  planFailover,
  type FailoverPlan
} from "./failover";

/**
 * Failover properties (fast-check).
 *
 * `planFailover` is documented as "a pure function of the MULTISET of failures:
 * it counts kinds per candidate and never reads the array's order, so a plan is
 * reproducible from a bug report by pasting the list back in any order". Two
 * inputs, two orderings, and the claim is about both — so both are permuted
 * here, independently and together.
 *
 * The fifth hand-found defect in this repository lived in this module's
 * neighbourhood and is worth naming precisely, because a permutation property
 * would NOT have caught it: failure precedence used to be decided by scanning
 * the CONTRACT'S ZOD ENUM and taking the first hit, so alphabetising that enum
 * would have moved `decode_failed` ahead of `rights_unverifiable` and let a
 * decode failure report for a candidate whose rights could not be established.
 * That code was already invariant to the order the CALLER reported failures in;
 * what it was not invariant to was a refactor of a vocabulary. The properties
 * that catch it are the precedence-table laws below — uniqueness, and the
 * derivation of the scan order from `precedence` rather than from membership —
 * plus the absolute-rights property, which fixes the outcome instead of the
 * mechanism.
 */

const decisionIds = (decision: PlaybackDecision): string[] =>
  decision.ranked.map((entry) => entry.candidate.id);

interface Scenario {
  readonly candidates: readonly StreamCandidate[];
  readonly capabilities: PlaybackCapabilities;
  readonly failures: readonly PlaybackAttemptFailure[];
  readonly policy: FailoverPolicy;
}

const scenarioArb = streamCandidatesArb.chain((candidates) =>
  fc.record(
    {
      candidates: fc.constant(candidates),
      capabilities: playbackCapabilitiesArb,
      failures: failuresArb(candidates.map((candidate) => candidate.id)),
      policy: failoverPolicyArb
    },
    { noNullPrototype: true }
  )
);

const unvettedScenarioArb = unvettedRightsCandidatesArb.chain((candidates) =>
  fc.record(
    {
      candidates: fc.constant(candidates),
      capabilities: playbackCapabilitiesArb,
      failures: failuresArb(candidates.map((candidate) => candidate.id)),
      policy: failoverPolicyArb
    },
    { noNullPrototype: true }
  )
);

function plan(scenario: Scenario): FailoverPlan {
  return planFailover(scenario.candidates, scenario.capabilities, scenario.failures, scenario.policy);
}

describe("the WHOLE plan is invariant under both input orders", () => {
  it("is identical under any permutation of the candidates", () => {
    fc.assert(
      fc.property(scenarioArb, permutationKeysArb, (scenario, keys) => {
        expect(plan({ ...scenario, candidates: permute(scenario.candidates, keys) })).toEqual(plan(scenario));
      })
    );
  });

  it("is identical under any permutation of the reported failures", () => {
    /*
     * The published plan reads failures only by COUNT and by membership, so the
     * sequence a caller recorded them in must not survive into the result. This
     * is also what makes a bug report replayable: paste the failures back in any
     * order and get the same plan.
     */
    fc.assert(
      fc.property(scenarioArb, permutationKeysArb, (scenario, keys) => {
        expect(plan({ ...scenario, failures: permute(scenario.failures, keys) })).toEqual(plan(scenario));
      })
    );
  });

  it("is identical when both inputs are reversed at once", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        expect(
          plan({
            ...scenario,
            candidates: [...scenario.candidates].reverse(),
            failures: [...scenario.failures].reverse()
          })
        ).toEqual(plan(scenario));
      })
    );
  });
});

describe("the plan is stable across repeats and is its own fixed point", () => {
  /*
   * A permutation property fixes the relation between two calls made inside one
   * test body. It cannot see ambient state that only affects a LATER call -- a
   * memo keyed on something incidental, a lazily-initialised constant -- and this
   * module has a lazily-initialised constant in plain sight:
   * `PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE` is computed once at module load by
   * SORTING a spread of the contract's array. It is correct today, but "computed
   * once, then read by every call" is the shape that turns a stray in-place
   * mutation into a plan that changes on the second invocation and never changes
   * back.
   *
   * Mutation of the caller's arrays is not checked: both parameters are
   * `readonly`, so the compiler already forbids the in-place sort that
   * `ranking.property.test.ts` guards against on its mutable one.
   */
  it("returns the identical FailoverPlan however many times it is called", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const first = plan(scenario);
        expect(plan(scenario)).toEqual(first);
        expect(plan(scenario)).toEqual(first);
      })
    );
  });

  it("is a fixed point of the candidate order its own ranking publishes", () => {
    // Feeding the ranking's output order back in changes nothing: sorting an
    // already-sorted list is a no-op. A corollary of permutation invariance, but
    // the one a reviewer checks by hand, and the one that fails legibly.
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const first = plan(scenario);
        const byId = new Map(scenario.candidates.map((candidate) => [candidate.id, candidate]));
        const asRanked = [
          ...first.decision.ranked.map((entry) => entry.candidate),
          ...first.decision.rejected.map((entry) => defined(byId.get(entry.candidateId), entry.candidateId))
        ];

        expect(plan({ ...scenario, candidates: asRanked })).toEqual(first);
      })
    );
  });
});

describe("the precedence table is a total order over failure kinds", () => {
  it("assigns a unique precedence to every kind the contract can report", () => {
    /*
     * Two kinds sharing a number would put the tie back in the hands of
     * iteration order, which IS the defect. Stated as a property over the
     * contract's membership list rather than as four hand-written assertions, so
     * a fifth kind is covered the moment it exists.
     */
    const precedences = PLAYBACK_FAILURE_KINDS.map((kind) => PLAYBACK_FAILURE_POLICY[kind].precedence);
    expect(new Set(precedences).size).toBe(PLAYBACK_FAILURE_KINDS.length);
  });

  it("derives the scan order from precedence, not from the enum's declaration order", () => {
    const byPrecedence = [...PLAYBACK_FAILURE_KINDS].sort(
      (a, b) => PLAYBACK_FAILURE_POLICY[a].precedence - PLAYBACK_FAILURE_POLICY[b].precedence
    );
    expect([...PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE]).toEqual(byPrecedence);

    // Membership is a schema fact; order is a product decision. Neither list may
    // omit a kind the other has.
    expect(new Set(PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE)).toEqual(new Set(PLAYBACK_FAILURE_KINDS));
    expect(PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE).toHaveLength(PLAYBACK_FAILURE_KINDS.length);
  });

  it("keeps rights strictly the most fundamental kind, and never retryable", () => {
    /*
     * `rights_unverifiable` is 0 under every budget, ordering and combination
     * because invariants 1 and 2 depend on it. Asserted against every OTHER kind
     * rather than against the literal 0, so adding a kind at precedence -1 fails
     * here instead of silently outranking rights.
     */
    expect(PLAYBACK_FAILURE_POLICY.rights_unverifiable.retryable).toBe(false);
    for (const kind of PLAYBACK_FAILURE_KINDS) {
      if (kind === "rights_unverifiable") continue;
      expect(PLAYBACK_FAILURE_POLICY.rights_unverifiable.precedence).toBeLessThan(
        PLAYBACK_FAILURE_POLICY[kind].precedence
      );
    }

    // Exactly one retryable kind, and it is a product decision rather than an
    // oversight: a decode failure has already answered its own question and a
    // removed asset does not come back within a session.
    const retryable = PLAYBACK_FAILURE_KINDS.filter((kind) => PLAYBACK_FAILURE_POLICY[kind].retryable);
    expect(retryable).toEqual(["network_transient"]);
  });
});

describe("a rights failure is terminal under every budget and every ordering", () => {
  it("never leaves a rights-failed candidate attemptable", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const rightsFailed = new Set(
          scenario.failures
            .filter((failure) => failure.kind === "rights_unverifiable")
            .map((failure) => failure.candidateId)
        );
        const result = plan(scenario);

        for (const candidateId of rightsFailed) {
          // Retrying is not robustness; it is a second attempt to play something
          // we are not entitled to play (invariants 1 and 2).
          expect(result.attemptable).not.toContain(candidateId);
          if (result.next !== null) expect(result.next.candidate.id).not.toBe(candidateId);
        }

        for (const entry of result.excluded) {
          if (rightsFailed.has(entry.candidateId)) {
            expect(entry.reason).toBe("rights_not_established");
          }
        }
      })
    );
  });

  it("never plans an attempt against a candidate outside the rights allowlist", () => {
    fc.assert(
      fc.property(unvettedScenarioArb, (scenario) => {
        const result = plan(scenario);
        if (result.next !== null) {
          expect(PLAYABLE_RIGHTS.includes(result.next.candidate.rights)).toBe(true);
        }
        const rankedRights = result.decision.ranked.map((entry) => entry.candidate.rights);
        for (const rights of rankedRights) expect(PLAYABLE_RIGHTS.includes(rights)).toBe(true);
      })
    );
  });
});

describe("the plan accounts for everything it was given", () => {
  it("splits the eligible pool into attemptable and excluded, with nothing lost or doubled", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = plan(scenario);
        const accounted = [...result.attemptable, ...result.excluded.map((entry) => entry.candidateId)];
        expect([...accounted].sort()).toEqual([...decisionIds(result.decision)].sort());
        expect(new Set(accounted).size).toBe(accounted.length);
      })
    );
  });

  it("hands back the breadth-first pick from the attemptable list, and only under budget", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = plan(scenario);
        expect(result.attemptsUsed).toBe(scenario.failures.length);
        expect(result.attemptsRemaining).toBe(
          Math.max(scenario.policy.maxAttempts - scenario.failures.length, 0)
        );

        if (result.next === null) {
          expect(
            [
              "no_candidates",
              "no_eligible_candidates",
              "all_candidates_rights_blocked",
              "all_eligible_candidates_incompatible",
              "candidates_exhausted",
              "attempt_limit_reached"
            ]
          ).toContain(result.reason);
          return;
        }

        /*
         * `next` is drawn from the pool but is NOT its head in general: an
         * untried candidate is taken ahead of a better-ranked one carrying a
         * transient failure. Restated as the exact selection rule rather than
         * relaxed to "is somewhere in the pool", so it still pins one answer.
         */
        const attemptsOn = (candidateId: string): number =>
          scenario.failures.filter((failure) => failure.candidateId === candidateId).length;

        expect(result.next.candidate.id).toBe(
          result.attemptable.find((id) => attemptsOn(id) === 0) ?? result.attemptable[0]
        );
        // Exhaustion outranks the budget, so a non-null `next` implies both that
        // something was attemptable AND that the budget had room.
        expect(result.attemptsUsed).toBeLessThan(scenario.policy.maxAttempts);
        expect(["first_attempt", "retry_after_transient_failure", "failover_to_next_candidate"]).toContain(
          result.reason
        );
      })
    );
  });

  it("surfaces every failure it could not attribute, deduped, sorted and with its kinds", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = plan(scenario);
        const pooled = new Set(decisionIds(result.decision));
        const expectedIds = [
          ...new Set(
            scenario.failures
              .filter((failure) => !pooled.has(failure.candidateId))
              .map((failure) => failure.candidateId)
          )
        ].sort();

        expect([...result.unattributedFailures]).toEqual(expectedIds);
        expect(result.unattributedDetail.map((entry) => entry.candidateId)).toEqual(expectedIds);

        for (const entry of result.unattributedDetail) {
          const reported = new Set(
            scenario.failures
              .filter((failure) => failure.candidateId === entry.candidateId)
              .map((failure) => failure.kind)
          );
          // A SET in precedence order, never a tally in reporting order:
          // multiplicity would buy nothing `attemptsUsed` does not already
          // charge for, and would reintroduce the dependence on report sequence.
          expect(new Set(entry.kinds)).toEqual(reported);
          expect(entry.kinds).toHaveLength(reported.size);
          expect([...entry.kinds]).toEqual(
            PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE.filter((kind) => reported.has(kind))
          );
        }
      })
    );
  });

  it("sorts exclusions by code-point candidate id, strictly", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { excluded } = plan(scenario);
        for (let index = 1; index < excluded.length; index++) {
          const previous = defined(excluded[index - 1], "previous exclusion");
          const current = defined(excluded[index], "current exclusion");
          expect(previous.candidateId < current.candidateId).toBe(true);
        }
      })
    );
  });
});

/**
 * Breadth before depth.
 *
 * The sixth hand-found defect, and the first one in this module that no
 * permutation, determinism or precedence property could have caught: every plan
 * the old scheduler produced was individually correct, order-invariant and
 * reproducible. What was wrong was the SEQUENCE of plans. Picking `attemptable[0]`
 * unconditionally meant a candidate carrying a transient failure outranked a
 * candidate nobody had tried, so with `maxAttempts: 4` and one retry each, two
 * candidates took two attempts apiece and a third authorized source was reported
 * as still attemptable at the moment the budget ran out.
 *
 * The invariant below is stated over the pool rather than over the ranking,
 * because that is what makes it survive exclusions: a candidate that leaves the
 * pool (decode failure, spent retry budget) is no longer owed a first attempt,
 * and a rule phrased over `decision.ranked` would demand one forever.
 */
describe("a retry never spends the budget another candidate's first attempt needs", () => {
  it("never returns a candidate for a second attempt while an attemptable one is untried", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = plan(scenario);
        if (result.next === null) return;

        const attemptsOn = (candidateId: string): number =>
          scenario.failures.filter((failure) => failure.candidateId === candidateId).length;

        // Nothing to prove about a first attempt; the rule constrains repeats.
        if (attemptsOn(result.next.candidate.id) === 0) return;

        for (const candidateId of result.attemptable) {
          expect(attemptsOn(candidateId)).toBeGreaterThan(0);
        }
      })
    );
  });

  it("holds at every step of a real failover loop, which still terminates on the budget", () => {
    /*
     * The single-plan property above is checked against failures fast-check
     * invented, which need not be a history any caller could actually have
     * produced. This drives the loop the way the caller does -- plan, attempt,
     * report, repeat -- so the states under test are exactly the reachable ones,
     * and the guard doubles as the termination assertion: every iteration
     * records one failure, so `attemptsUsed` strictly increases and the policy's
     * own ceiling has to stop it. A scheduler that alternated between two
     * candidates without charging the budget would fall out of the loop here
     * rather than hang the suite.
     */
    fc.assert(
      fc.property(
        streamCandidatesArb,
        playbackCapabilitiesArb,
        failoverPolicyArb,
        playbackFailureKindArb,
        (candidates, capabilities, policy, kind) => {
          const failures: PlaybackAttemptFailure[] = [];
          const attempts = new Map<string, number>();

          for (let guard = 0; guard <= policy.maxAttempts; guard++) {
            const step = planFailover(candidates, capabilities, failures, policy);
            if (step.next === null) return;

            const candidateId = step.next.candidate.id;
            const soFar = attempts.get(candidateId) ?? 0;

            if (soFar > 0) {
              // A repeat is legitimate only once the pool holds nothing untried.
              for (const pooled of step.attemptable) {
                expect(attempts.get(pooled) ?? 0).toBeGreaterThan(0);
              }
            }

            attempts.set(candidateId, soFar + 1);
            failures.push({ candidateId, kind });
          }

          throw new Error("failover did not terminate within its own attempt budget");
        }
      )
    );
  });
});
