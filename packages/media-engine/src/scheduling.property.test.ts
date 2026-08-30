import type { FailoverPolicy, PlaybackAttemptFailure } from "@liberty/contracts/domains/failover";
import {
  FAST_CHECK_SEED,
  MAX_LIST_LENGTH,
  defined,
  failoverPolicyArb,
  failuresArb,
  idArb,
  permutationKeysArb,
  permute,
  playbackFailureKindArb
} from "@liberty/contracts/testing/arbitraries";
import type { Arbitrary } from "fast-check";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scheduleAttempts, type AttemptSchedule, type ChargedAttempts } from "./scheduling";

/**
 * Scheduling properties (fast-check).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `failover.property.test.ts`. That suite
 * drives `planFailover`, which supplies no `ChargedAttempts` — so by
 * construction it can never reach the half of this module the BROWSER actually
 * runs. `apps/web`'s playback machine calls `scheduleAttempts` directly and
 * always passes a charge, because an unclassifiable failure is absent from
 * `failures` by contract and would otherwise make a candidate look untried for
 * ever. Everything that follows from that charge — the fifth exclusion reason,
 * the tried/untried partition, the session budget — had example tests and no
 * properties, which is the coverage shape that hides a defect in the SEQUENCE
 * rather than in any single answer. Two of the six hand-found order-dependence
 * defects in this repository were exactly that shape.
 *
 * The seed is pinned by importing `@liberty/contracts/testing/arbitraries`,
 * whose import side effect is `fc.configureGlobal`. An unpinned property suite
 * fails on one CI run in forty with a counterexample nobody can reproduce, and a
 * test that cannot be reproduced gets retried until it passes.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: invariance under permutation of the
 * CANDIDATE list. That order is this function's only ordered input and it is
 * meaning rather than noise — the caller ranked it. What is asserted is the
 * sharper thing: the candidate order reaches the PREFERENCE and nothing else, so
 * every finding the schedule publishes is invariant under it.
 *
 * Ids are generated DISTINCT, which is the module's stated precondition rather
 * than a convenience: a candidate id is a pure function of the stream it names,
 * both routes that build a candidate list drop duplicates before the engine sees
 * one, and every ordering here terminates in a code-point tiebreak that is total
 * only over distinct ids.
 */

const candidateIdsArb: Arbitrary<string[]> = fc.uniqueArray(idArb, {
  minLength: 0,
  maxLength: MAX_LIST_LENGTH
});

interface Scenario {
  readonly ids: readonly string[];
  readonly failures: readonly PlaybackAttemptFailure[];
  readonly policy: FailoverPolicy;
  readonly charged: ChargedAttempts;
}

/**
 * A charge, in every combination a caller can legally hand over.
 *
 * The map is generated COMPLETE with zeroes rather than sparse, because a
 * missing key and a zero are the same fact by construction (`?? 0`), and a
 * complete map is the one shape a reader can check against the counts.
 *
 * `attemptsUsed` is present or absent independently of the map, so the
 * half-supplied argument — map without total — is generated rather than assumed
 * impossible. That combination is what decides the session budget now, and it
 * used to be answered from `failures.length` while the partition was answered
 * from the map.
 */
function chargedArb(ids: readonly string[]): Arbitrary<ChargedAttempts> {
  return fc
    .record(
      {
        counts: fc.array(fc.nat({ max: 3 }), { minLength: ids.length, maxLength: ids.length }),
        total: fc.option(fc.nat({ max: 12 }), { nil: null }),
        supplyMap: fc.boolean()
      },
      { noNullPrototype: true }
    )
    .map(({ counts, total, supplyMap }): ChargedAttempts => {
      const map: Record<string, number> = Object.fromEntries(
        ids.map((id, index): [string, number] => [id, counts[index] ?? 0])
      );
      /* Built branch by branch rather than with an `undefined` value, because
       * `exactOptionalPropertyTypes` makes an explicitly-undefined optional a
       * type error — and rightly so: "absent" and "present and undefined" are
       * different arguments to this function. */
      if (supplyMap && total !== null) return { attemptsUsed: total, attemptsByCandidate: map };
      if (supplyMap) return { attemptsByCandidate: map };
      if (total !== null) return { attemptsUsed: total };
      return {};
    });
}

/* Deliberately not annotated `Arbitrary<Scenario>`: the record's own inferred
 * type is assignable to `Scenario` at every USE, and annotating the arbitrary
 * itself would rest on the variance of `Arbitrary<T>` rather than on plain
 * parameter assignability. */
const scenarioArb = candidateIdsArb.chain((ids) =>
  fc.record(
    {
      ids: fc.constant(ids),
      failures: failuresArb(ids),
      policy: failoverPolicyArb,
      charged: chargedArb(ids)
    },
    { noNullPrototype: true }
  )
);

function schedule(scenario: Scenario): AttemptSchedule {
  return scheduleAttempts(scenario.ids, scenario.failures, scenario.policy, scenario.charged);
}

/** The module's own `attemptsOn`, restated rather than imported: a property that
 * shares the implementation's helper cannot see the helper being wrong. */
function attemptsOn(scenario: Scenario, candidateId: string): number {
  const map = scenario.charged.attemptsByCandidate;
  if (map === undefined) {
    return scenario.failures.filter((failure) => failure.candidateId === candidateId).length;
  }
  return Object.hasOwn(map, candidateId) ? (map[candidateId] ?? 0) : 0;
}

function reportedKinds(scenario: Scenario, candidateId: string): readonly string[] {
  return scenario.failures
    .filter((failure) => failure.candidateId === candidateId)
    .map((failure) => failure.kind);
}

describe("the pinned seed", () => {
  it("runs under the repository's fast-check seed", () => {
    /* The import above is what pins it, and an import whose only purpose is a
     * side effect is the kind of line a tidy-up deletes. This fails if it is
     * removed, or if a local `fc.assert(..., { seed })` starts overriding it. */
    expect(fc.readConfigureGlobal().seed).toBe(FAST_CHECK_SEED);
  });
});

describe("the schedule is a function of the multiset of failures", () => {
  it("is identical under any permutation of the reported failures", () => {
    fc.assert(
      fc.property(scenarioArb, permutationKeysArb, (scenario, keys) => {
        expect(schedule({ ...scenario, failures: permute(scenario.failures, keys) })).toEqual(
          schedule(scenario)
        );
      })
    );
  });

  it("is identical when the failures are reversed", () => {
    // A permutation generator can produce the identity; a reversal cannot, so
    // this is the one that fails loudly if the generator ever degenerates.
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        expect(schedule({ ...scenario, failures: [...scenario.failures].reverse() })).toEqual(
          schedule(scenario)
        );
      })
    );
  });

  it("returns the identical schedule however many times it is called", () => {
    // `PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE` is computed once at module load by
    // sorting a spread of the contract's array. "Computed once, then read by
    // every call" is the shape that turns a stray in-place mutation into an
    // answer that changes on the second invocation and never changes back.
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const first = schedule(scenario);
        expect(schedule(scenario)).toEqual(first);
        expect(schedule(scenario)).toEqual(first);
      })
    );
  });
});

describe("the candidate order reaches the preference and nothing else", () => {
  it("publishes the same findings whichever order the pool was supplied in", () => {
    /*
     * The deliberate asymmetry, pinned from both sides. `next` and the ORDER of
     * `attemptable` may legitimately change when the caller reorders its ranking
     * — that is what it means for the order to be meaning. Nothing else may:
     * exclusions, the budget arithmetic and the unattributed lists are findings
     * about a SET, and a finding that moved with the input order would be the
     * order-dependence class of defect this package has already removed six of.
     */
    fc.assert(
      fc.property(scenarioArb, permutationKeysArb, (scenario, keys) => {
        const base = schedule(scenario);
        const reordered = schedule({ ...scenario, ids: permute(scenario.ids, keys) });

        expect(reordered.excluded).toEqual(base.excluded);
        expect([...reordered.attemptable].sort()).toEqual([...base.attemptable].sort());
        expect(reordered.attemptsUsed).toBe(base.attemptsUsed);
        expect(reordered.attemptsRemaining).toBe(base.attemptsRemaining);
        expect(reordered.unattributedFailures).toEqual(base.unattributedFailures);
        expect(reordered.unattributedDetail).toEqual(base.unattributedDetail);
      })
    );
  });
});

describe("the schedule accounts for everything it was given", () => {
  it("splits the supplied pool into attemptable and excluded, with nothing lost or doubled", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = schedule(scenario);
        const accounted = [...result.attemptable, ...result.excluded.map((entry) => entry.candidateId)];

        expect([...accounted].sort()).toEqual([...scenario.ids].sort());
        expect(new Set(accounted).size).toBe(accounted.length);
      })
    );
  });

  it("charges the budget from whichever books the caller is keeping", () => {
    /*
     * The rule the half-supplied argument used to break. A caller that supplies
     * `attemptsByCandidate` is asserting a more complete count than its own
     * failure list; reading the TOTAL off `failures.length` while the partition
     * read the map ran the budget on the books that omit the unclassifiable
     * attempts — the exact accounting the map exists to replace.
     */
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const map = scenario.charged.attemptsByCandidate;
        const expected =
          scenario.charged.attemptsUsed ??
          (map === undefined
            ? scenario.failures.length
            : Object.values(map).reduce((total, charges) => total + charges, 0));

        const result = schedule(scenario);
        expect(result.attemptsUsed).toBe(expected);
        expect(result.attemptsRemaining).toBe(Math.max(scenario.policy.maxAttempts - expected, 0));
      })
    );
  });

  it("hands back the breadth-first pick, and only while the budget has room", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = schedule(scenario);

        if (scenario.ids.length === 0) {
          // Every "all candidates were X" claim is vacuously true about nothing
          // at all, which is why the empty case is answered separately.
          expect(result.reason).toBe("no_candidates");
          expect(result.next).toBeNull();
          return;
        }

        if (result.next === null) {
          expect(["candidates_exhausted", "attempt_limit_reached"]).toContain(result.reason);
          // Exhaustion outranks the budget, so the two terminal answers are
          // mutually exclusive rather than merely ordered.
          if (result.reason === "attempt_limit_reached") {
            expect(result.attemptable.length).toBeGreaterThan(0);
          } else {
            expect(result.attemptable).toEqual([]);
          }
          return;
        }

        expect(result.next).toBe(
          result.attemptable.find((id) => attemptsOn(scenario, id) === 0) ?? result.attemptable[0]
        );
        expect(result.attemptsUsed).toBeLessThan(scenario.policy.maxAttempts);
        expect(["first_attempt", "retry_after_transient_failure", "failover_to_next_candidate"]).toContain(
          result.reason
        );
      })
    );
  });

  it("sorts exclusions by code point, strictly, and never charges one zero attempts", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { excluded } = schedule(scenario);

        for (let index = 1; index < excluded.length; index += 1) {
          const previous = defined(excluded[index - 1], "previous exclusion");
          const current = defined(excluded[index], "current exclusion");
          expect(previous.candidateId < current.candidateId).toBe(true);
        }
        for (const entry of excluded) {
          // Every value in the vocabulary is established by an ATTEMPT, so an
          // exclusion charging zero of them would be a finding about a candidate
          // nobody tried.
          expect(entry.attempts).toBeGreaterThanOrEqual(1);
          expect(entry.attempts).toBeGreaterThanOrEqual(reportedKinds(scenario, entry.candidateId).length);
        }
      })
    );
  });
});

describe("a rights failure is terminal under every budget and every charge", () => {
  it("never leaves a rights-failed candidate attemptable", () => {
    /*
     * Stated over the charged path as well, because `ChargedAttempts` is the one
     * argument that can change which candidates leave the pool. Its safety claim
     * is an ASYMMETRY — it may rule a candidate out, never in — and this is the
     * direction that matters: no charge, however large or small, may hand back a
     * candidate whose rights could not be established (invariants 1 and 2).
     */
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const pooled = new Set(scenario.ids);
        const rightsFailed = new Set(
          scenario.failures
            .filter((failure) => failure.kind === "rights_unverifiable" && pooled.has(failure.candidateId))
            .map((failure) => failure.candidateId)
        );
        const result = schedule(scenario);

        for (const candidateId of rightsFailed) {
          expect(result.attemptable).not.toContain(candidateId);
          expect(result.next).not.toBe(candidateId);
          const entry = result.excluded.find((excluded) => excluded.candidateId === candidateId);
          expect(defined(entry, `exclusion for ${candidateId}`).reason).toBe("rights_not_established");
        }
      })
    );
  });
});

describe("the fifth exclusion reason claims only what the arithmetic says", () => {
  it("fires only where an attempt was charged that no failure kind accounts for", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const result = schedule(scenario);

        for (const entry of result.excluded) {
          if (entry.reason !== "attempt_failed_unclassified") continue;
          /* A claim about the REPORT, not about the stream: more attempts than
           * named failures. It cannot fire for a candidate nobody attempted, and
           * it cannot outrank a classified finding — "we found out this does not
           * decode" is the more informative answer and wins the precedence. */
          expect(attemptsOn(scenario, entry.candidateId)).toBeGreaterThan(
            reportedKinds(scenario, entry.candidateId).length
          );
          expect(attemptsOn(scenario, entry.candidateId)).toBeGreaterThan(0);
        }

        if (scenario.charged.attemptsByCandidate === undefined) {
          // Unreachable without a caller counting its own attempts, which is why
          // `planFailover`'s behaviour is untouched by the reason existing.
          expect(result.excluded.map((entry) => entry.reason)).not.toContain(
            "attempt_failed_unclassified"
          );
        }
      })
    );
  });
});

describe("the loop a client actually drives", () => {
  it("terminates on the budget and never hands back a candidate it ruled out", () => {
    /*
     * The single-schedule properties above are checked against charges
     * fast-check invented, which need not be a history any caller could have
     * produced. This drives the loop the way `playback-machine.ts` does — ask,
     * attempt, charge, sometimes report a kind — so the states under test are
     * the reachable ones.
     *
     * `null` in the script is the case the whole `ChargedAttempts` argument
     * exists for: an attempt whose error the reporter could not classify, which
     * charges the candidate and adds NOTHING to `failures`. Under the old
     * accounting that candidate looked untried for ever and the budget never
     * advanced.
     *
     * The guard doubles as the termination assertion: every iteration charges
     * one attempt, so the policy's own ceiling has to stop it. A scheduler that
     * alternated between two candidates without charging would fall out here
     * rather than hang the suite.
     */
    fc.assert(
      fc.property(
        candidateIdsArb,
        failoverPolicyArb,
        fc.array(fc.option(playbackFailureKindArb, { nil: null }), { minLength: 8, maxLength: 8 }),
        (ids, policy, script) => {
          const failures: PlaybackAttemptFailure[] = [];
          let attemptsByCandidate: Readonly<Record<string, number>> = {};
          let attemptsUsed = 0;
          const everExcluded = new Set<string>();

          for (let step = 0; step <= policy.maxAttempts; step += 1) {
            const result = scheduleAttempts(ids, failures, policy, {
              attemptsUsed,
              attemptsByCandidate
            });

            for (const entry of result.excluded) everExcluded.add(entry.candidateId);
            /* STICKY. Exclusion is decided from counts that only ever grow, so a
             * candidate that left the pool must never be offered again — the
             * defect that let one fatally-broken stream be loaded until the
             * budget ran out was precisely a candidate coming back. */
            for (const candidateId of result.attemptable) {
              expect(everExcluded.has(candidateId)).toBe(false);
            }

            if (result.next === null) return;
            const next = result.next;
            expect(ids).toContain(next);
            expect(everExcluded.has(next)).toBe(false);

            attemptsUsed += 1;
            /* The object-literal form the machine uses: a computed key in a
             * literal DEFINES an own property, where `record[id] = n` would
             * invoke a prototype setter for an id like `__proto__` and record
             * nothing. */
            attemptsByCandidate = {
              ...attemptsByCandidate,
              [next]: (Object.hasOwn(attemptsByCandidate, next) ? attemptsByCandidate[next] ?? 0 : 0) + 1
            };

            const kind = script[step % script.length] ?? null;
            if (kind !== null) failures.push({ candidateId: next, kind });
          }

          throw new Error("scheduling did not terminate within its own attempt budget");
        }
      )
    );
  });
});
