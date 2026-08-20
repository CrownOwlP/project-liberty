import {
  unknownMediaFacts,
  type PlaybackCapabilities,
  type StreamCandidate
} from "@liberty/contracts/domains/playback";
import { MEDIA_FACTS, type MediaFact } from "@liberty/contracts/shared/media-facts";
import {
  capabilitiesAdmitting,
  defined,
  playbackCapabilitiesArb,
  statedStreamCandidateArb,
  streamCandidateArb,
  type StatedStreamCandidate
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PROVIDER_HEALTH_FLOOR, rankStreamCandidates } from "./ranking";
import {
  SCORE_PRECISION,
  SCORE_WEIGHTS,
  UNKNOWABLE_DIMENSIONS,
  explainScore,
  scoreCandidate,
  type CandidateScore,
  type ScoreComponent
} from "./scoring";

/**
 * Unknown-vs-known properties (fast-check).
 *
 * The distinction the whole package is built on is authorized !=
 * known-compatible != attemptable, and the arithmetic that keeps it honest is
 * that an UNMEASURED dimension contributes zero against a FIXED ceiling rather
 * than being dropped and renormalised. Renormalising asserts "the facts we do
 * not have are as good as the facts we do", and its consequence is exact and
 * catastrophic: a stream that states nothing at all could reach 100 and outrank a
 * measured 2160p HEVC candidate.
 *
 * The example suite pins that with fixtures. These properties pin it as
 * arithmetic — over generated candidates, generated capabilities, and every
 * subset of facts a provider might fail to state — so the day a weight changes or
 * a dimension is added, the guarantee is re-derived rather than re-assumed.
 */

/** The rounding the score model publishes at. Same expression as the module's. */
function round(value: number): number {
  return Number(value.toFixed(SCORE_PRECISION));
}

const factSubsetArb = fc.uniqueArray(fc.constantFrom(...MEDIA_FACTS), {
  minLength: 1,
  maxLength: MEDIA_FACTS.length
});

/**
 * The same candidate with some facts un-stated.
 *
 * Written out field by field rather than by writing `null` through a
 * `MediaFact`-typed index, because that assignment does not typecheck — and the
 * fact that it does not is the contract working: the four fields are a union of
 * differently-typed slots, and code that wants to blank one has to say which.
 */
function withFactsRemoved(
  candidate: StatedStreamCandidate,
  facts: readonly MediaFact[],
  id: string
): StreamCandidate {
  const removed = new Set(facts);
  return {
    ...candidate,
    id,
    videoCodec: removed.has("videoCodec") ? null : candidate.videoCodec,
    audioCodec: removed.has("audioCodec") ? null : candidate.audioCodec,
    height: removed.has("height") ? null : candidate.height,
    bitrateKbps: removed.has("bitrateKbps") ? null : candidate.bitrateKbps
  };
}

/** A stated candidate, capabilities that admit it, and facts to take away. */
const degradationArb = statedStreamCandidateArb
  // The health floor is a ranking constant, not a contract one, so it is applied
  // here rather than inside the shared generator: eligibility must not be able
  // to make this property vacuous by rejecting the candidate before it is scored.
  .map((candidate): StatedStreamCandidate => ({
    ...candidate,
    healthScore: Math.max(candidate.healthScore, PROVIDER_HEALTH_FLOOR)
  }))
  .chain((candidate) =>
    fc.record(
      {
        candidate: fc.constant(candidate),
        capabilities: capabilitiesAdmitting(candidate),
        removed: factSubsetArb
      },
      { noNullPrototype: true }
    )
  );

describe("an unmeasured dimension earns nothing and says so", () => {
  it("publishes zero, the absent facts, and a positive weight for every unknown dimension", () => {
    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const score = scoreCandidate(candidate, capabilities);

        for (const component of score.components) {
          if (component.known) {
            expect(component.missingFacts).toEqual([]);
            continue;
          }

          expect(component.raw).toBe(0);
          // The literal `0`, not `-0`: `0 * -15` is negative zero in IEEE
          // arithmetic and `Object.is(-0, 0)` is false, so a published breakdown
          // carrying `-0` would fail its own reconstruction under strict equality.
          expect(Object.is(component.weighted, 0)).toBe(true);
          expect(component.missingFacts.length).toBeGreaterThan(0);

          // An unmeasurable dimension contributes zero. Against a positive
          // weight that reads as "earned no credit"; against a PENALTY it would
          // read as "escaped the penalty", and a candidate would be REWARDED for
          // withholding information.
          expect(UNKNOWABLE_DIMENSIONS).toContain(component.dimension);
          expect(SCORE_WEIGHTS[component.dimension]).toBeGreaterThan(0);
        }
      })
    );
  });

  it("names only facts the candidate genuinely did not state", () => {
    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const score = scoreCandidate(candidate, capabilities);
        const unknown = new Set(unknownMediaFacts(candidate));

        expect([...score.unknownFacts]).toEqual(unknownMediaFacts(candidate));
        for (const component of score.components) {
          for (const fact of component.missingFacts) expect(unknown.has(fact)).toBe(true);
        }
      })
    );
  });

  it("keeps the breakdown able to reconstruct the published total", () => {
    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const score = scoreCandidate(candidate, capabilities);

        expect(round(score.components.reduce((sum, item) => sum + item.weighted, 0))).toBe(score.total);

        for (const component of score.components) {
          if (!component.known) continue;
          // `weighted` is derived from the ROUNDED `raw`, so this exact identity
          // holds for every integer weight. It is the reason weights must stay
          // integers, stated as a check rather than as a comment.
          expect(round(component.raw * component.weight)).toBe(component.weighted);
        }
      })
    );
  });

  it("reports a ceiling that reflects what could be established, and never divides by it", () => {
    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const score = scoreCandidate(candidate, capabilities);
        const expectedAttainable = score.components.reduce(
          (sum, item) => (item.known && item.weight > 0 ? sum + item.weight : sum),
          0
        );
        expect(score.attainableTotal).toBe(expectedAttainable);
        expect(score.attainableTotal).toBeLessThanOrEqual(100);
        // Penalties are excluded, because a penalty is not credit.
        expect(score.attainableTotal).toBeGreaterThanOrEqual(0);
      })
    );
  });

  it("caps a candidate that states nothing at the weights the platform observes for itself", () => {
    /*
     * The arithmetic consequence of refusing renormalisation, and the single
     * most important number in this file. `health` and `protocolAdaptivity` read
     * things the platform measures for itself; `resolution`, `bitrateEfficiency`
     * and `codecEfficiency` read claims a provider hands us. A stream that hands
     * us none of them can reach at most the former, minus its latency penalty —
     * NOT 100.
     */
    const observedOnly = SCORE_WEIGHTS.health + SCORE_WEIGHTS.protocolAdaptivity;

    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const blank: StreamCandidate = {
          ...candidate,
          videoCodec: null,
          audioCodec: null,
          height: null,
          bitrateKbps: null
        };
        const score = scoreCandidate(blank, capabilities);

        expect(score.total).toBeLessThanOrEqual(observedOnly);
        expect(score.attainableTotal).toBe(observedOnly);
        expect([...score.unknownFacts]).toEqual([...MEDIA_FACTS]);
      })
    );
  });

  it("sums its positive weights to the stated ceiling of 100", () => {
    const positive = Object.values(SCORE_WEIGHTS)
      .filter((weight) => weight > 0)
      .reduce((sum, weight) => sum + weight, 0);
    expect(positive).toBe(100);
  });
});

describe("a stated fact is never worth less than an unstated one", () => {
  it("never scores a fully-described candidate below the same candidate with facts removed", () => {
    fc.assert(
      fc.property(degradationArb, ({ candidate, capabilities, removed }) => {
        const full = scoreCandidate(candidate, capabilities);
        const degraded = scoreCandidate(
          withFactsRemoved(candidate, removed, `${candidate.id}~degraded`),
          capabilities
        );

        expect(full.total).toBeGreaterThanOrEqual(degraded.total);
        expect(full.attainableTotal).toBeGreaterThanOrEqual(degraded.attainableTotal);
      })
    );
  });

  it("never ranks a measured candidate below an otherwise-identical unmeasured one", () => {
    /*
     * Score alone does not guarantee this and that is why the unknown-facts
     * tiebreak exists: a stated bitrate far enough from target clamps
     * `bitrateEfficiency` to zero exactly like an unstated one, so two
     * candidates can tie on total while only one of them was actually verified.
     * The architecture requires the measured stream to win; this is the check
     * that it does, rather than an arithmetic coincidence a weight change could
     * remove.
     */
    fc.assert(
      fc.property(degradationArb, ({ candidate, capabilities, removed }) => {
        const degraded = withFactsRemoved(candidate, removed, `${candidate.id}~degraded`);
        const decision = rankStreamCandidates([candidate, degraded], capabilities);

        expect(decision.ranked).toHaveLength(2);
        expect(defined(decision.ranked[0], "winner").candidate.id).toBe(candidate.id);
        // ...and it is invariant to which one the provider listed first.
        expect(rankStreamCandidates([degraded, candidate], capabilities)).toEqual(decision);
      })
    );
  });

  it("never labels a candidate verified once a codec has been taken away", () => {
    fc.assert(
      fc.property(degradationArb, ({ candidate, capabilities, removed }) => {
        const degraded = withFactsRemoved(candidate, removed, `${candidate.id}~degraded`);
        const decision = rankStreamCandidates([degraded], capabilities);
        const entry = defined(decision.ranked[0], "ranked degraded candidate");

        const codecRemoved = removed.includes("videoCodec") || removed.includes("audioCodec");
        expect(entry.compatibility).toBe(codecRemoved ? "unverified" : "verified");
        // An unknown height or bitrate means we cannot say how GOOD a stream is;
        // an unknown codec means we cannot say whether it plays at all.
        expect(entry.unknownFacts.length).toBeGreaterThan(0);
      })
    );
  });
});

describe("the readable trail distinguishes measured-and-bad from never-told", () => {
  /** Keyed by the printed name, so a token can be looked up without a cast. */
  function componentsByName(score: CandidateScore): Map<string, ScoreComponent> {
    return new Map<string, ScoreComponent>(
      score.components.map((component) => [component.dimension, component])
    );
  }

  function tokensOf(score: CandidateScore): { dimension: string; value: string }[] {
    return explainScore(score)
      .split(" ")
      .map((token) => {
        const separator = token.indexOf("=");
        return { dimension: token.slice(0, separator), value: token.slice(separator + 1) };
      });
  }

  it("prints =unknown rather than =0 for a dimension nobody measured", () => {
    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const score = scoreCandidate(candidate, capabilities);
        const tokens = tokensOf(score);
        const byDimension = componentsByName(score);

        expect(tokens).toHaveLength(score.components.length);
        expect(new Set(tokens.map((token) => token.dimension))).toEqual(new Set(byDimension.keys()));

        for (const token of tokens) {
          const component = defined(byDimension.get(token.dimension), token.dimension);
          // "Why is codecEfficiency zero?" has two answers that lead to two
          // different investigations, and only one of them is a defect.
          expect(token.value).toBe(component.known ? `${component.weighted}` : "unknown");
        }
      })
    );
  });

  it("orders the trail by absolute contribution, with an explicit tiebreak on the name", () => {
    /*
     * Every unknown dimension sits at exactly zero, so without the name tiebreak
     * their relative order would be whatever order `scoreCandidate` happens to
     * build its array in — stable, but incidental, and it would move the day a
     * dimension is inserted. Determinism in this package is a stated guarantee,
     * not a happy accident, so the tiebreak is checked rather than trusted.
     */
    fc.assert(
      fc.property(streamCandidateArb, playbackCapabilitiesArb, (candidate, capabilities) => {
        const score = scoreCandidate(candidate, capabilities);
        const byDimension = componentsByName(score);
        const tokens = tokensOf(score);

        for (let index = 1; index < tokens.length; index++) {
          const previousName = defined(tokens[index - 1], "previous token").dimension;
          const currentName = defined(tokens[index], "current token").dimension;
          const previous = defined(byDimension.get(previousName), previousName);
          const current = defined(byDimension.get(currentName), currentName);

          const previousMagnitude = Math.abs(previous.weighted);
          const currentMagnitude = Math.abs(current.weighted);
          expect(previousMagnitude).toBeGreaterThanOrEqual(currentMagnitude);
          if (previousMagnitude === currentMagnitude) expect(previousName < currentName).toBe(true);
        }
      })
    );
  });
});

describe("capabilities are never satisfied by a fact that was never stated", () => {
  it("keeps an unstated codec out of the compatibility claim, for any capabilities", () => {
    fc.assert(
      fc.property(
        streamCandidateArb,
        playbackCapabilitiesArb,
        (candidate, capabilities: PlaybackCapabilities) => {
          const decision = rankStreamCandidates([candidate], capabilities);
          const entry = decision.ranked[0];
          if (entry === undefined) return;

          if (entry.candidate.videoCodec === null || entry.candidate.audioCodec === null) {
            // Not compatible and not incompatible: unverified. A device that
            // cannot decode `vp9` rejects a STATED `vp9`; a stream that states
            // nothing has not been shown to decode OR to fail.
            expect(entry.compatibility).toBe("unverified");
            expect(decision.reason).toBe("highest_eligible_score_unverified_compatibility");
          } else {
            expect(capabilities.supportedVideoCodecs).toContain(entry.candidate.videoCodec);
            expect(capabilities.supportedAudioCodecs).toContain(entry.candidate.audioCodec);
          }
        }
      )
    );
  });
});
