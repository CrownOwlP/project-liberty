import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import {
  defined,
  permutationKeysArb,
  permute,
  playbackCapabilitiesArb,
  streamCandidatesArb,
  unvettedRightsCandidatesArb
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PLAYABLE_RIGHTS,
  PROVIDER_HEALTH_FLOOR,
  rankStreamCandidates,
  type PlaybackDecision,
  type RankedCandidate
} from "./ranking";

/**
 * Ranking properties (fast-check).
 *
 * WHY THESE EXIST. Five order-dependence defects have been found in this
 * repository by hand, and every one of them passed a green example suite first.
 * The shape is always the same: a determinism claim that holds only in the
 * configuration the tests happen to use. Two of the five were in THIS function's
 * output — `PlaybackDecision.rejected` was left in provider order while `ranked`
 * and `selected` were sorted, so the decision as a whole was not the function of
 * its inputs the doc comment claimed it was.
 *
 * So the properties below compare the WHOLE returned object, never just the
 * winner. A defect in a secondary field is exactly the defect that got through
 * last time, and `expect(selected).toEqual(selected)` would have shipped it
 * again.
 *
 * KNOWN LIMIT OF THIS SUITE, stated rather than hidden: every list generated
 * here has DISTINCT candidate ids. That is a domain constraint (an id is a pure
 * function of the stream it names, and the adapter collapses duplicates before
 * the engine sees them) but it is also the condition under which this module's
 * comparators are total — `rejected` is sorted by `candidateId` alone, so two
 * DIFFERENT candidates sharing an id and rejected for DIFFERENT reasons tie, and
 * `Array.prototype.sort` stability then hands their relative order to the input
 * ordering. Nothing in `playbackResolveRequestSchema` forbids that input. It is
 * reported as a finding with this suite rather than pinned as a property here,
 * because closing it is either a contract change (require unique ids) or a
 * comparator change (tie-break on the reason), and both need their own review.
 */

const capabilitiesArb = playbackCapabilitiesArb;

/** The published ordering key of `ranked`, as the module documents it. */
function compareRankedSpec(a: RankedCandidate, b: RankedCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.unknownFacts.length !== b.unknownFacts.length) {
    return a.unknownFacts.length - b.unknownFacts.length;
  }
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

function idsOf(decision: PlaybackDecision): string[] {
  return [...decision.ranked.map((entry) => entry.candidate.id), ...decision.rejected.map((entry) => entry.candidateId)];
}

describe("the WHOLE decision is invariant under input order", () => {
  it("produces an identical PlaybackDecision for any permutation of the candidates", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, permutationKeysArb, (candidates, capabilities, keys) => {
        const canonical = rankStreamCandidates([...candidates], capabilities);
        const permuted = rankStreamCandidates(permute(candidates, keys), capabilities);

        // The whole object, not `selected`. `rejected` was the field that broke
        // last time and `selected` was identical throughout.
        expect(permuted).toEqual(canonical);
      })
    );
  });

  it("produces an identical PlaybackDecision for the reversed candidates", () => {
    /*
     * Reversal is called out separately from the general permutation because
     * reversal is what a human reviewer actually tries, and it is the single
     * permutation most likely to expose a stability-dependent sort: it inverts
     * the relative order of every tied pair at once, where a random shuffle of a
     * short list frequently leaves ties untouched.
     */
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        expect(rankStreamCandidates([...candidates].reverse(), capabilities)).toEqual(
          rankStreamCandidates([...candidates], capabilities)
        );
      })
    );
  });
});

describe("the decision is stable, and the caller's array is left alone", () => {
  /*
   * NEITHER of these is implied by the permutation properties above, which is
   * the only reason they are here rather than being redundant restatements.
   *
   * An in-place sort of the caller's array is invisible to a permutation
   * property: both calls would be equally affected and both results would still
   * match. It is nevertheless the same defect class -- a function whose output
   * depends on how many times it has been called with the same array -- and it is
   * one `.sort(...)` away at all times, because `ranked` and `rejected` are both
   * produced by sorting.
   *
   * Repeated-call determinism is not implied either. A permutation property fixes
   * the RELATION between two calls made in one test body; it says nothing about a
   * memo keyed on something incidental, a lazily-initialised module constant, or
   * any of the ambient state a "pure and deterministic" doc comment rules out by
   * assertion rather than by construction. The env-validator defect was a derived
   * value keyed on something incidental, so the class is not hypothetical here.
   */
  it("does not mutate, reorder or reuse the array it was given", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const input = [...candidates];
        const snapshot = candidates.map((candidate) => ({ ...candidate }));

        rankStreamCandidates(input, capabilities);

        // Element order AND every field, so an in-place sort and a field written
        // back onto a candidate are both caught.
        expect(input).toEqual(snapshot);
      })
    );
  });

  it("returns the identical decision however many times it is called", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const first = rankStreamCandidates([...candidates], capabilities);
        expect(rankStreamCandidates([...candidates], capabilities)).toEqual(first);
        expect(rankStreamCandidates([...candidates], capabilities)).toEqual(first);
      })
    );
  });

  it("is a fixed point of the order it publishes", () => {
    /*
     * Sorting an already-sorted list changes nothing. Logically this IS a
     * corollary of the permutation property -- the published order is a
     * permutation of the input -- but it is the corollary a reader checks by
     * hand, and it fails LOUDLY and legibly if the sort is ever made
     * stability-dependent, where the general permutation property fails on some
     * unrelated-looking shuffle.
     */
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const first = rankStreamCandidates([...candidates], capabilities);
        const asPublished = [
          ...first.ranked.map((entry) => entry.candidate),
          ...first.rejected.map((entry) => defined(byId.get(entry.candidateId), entry.candidateId))
        ];

        expect(rankStreamCandidates(asPublished, capabilities)).toEqual(first);
      })
    );
  });
});

describe("both published lists are totally ordered", () => {
  it("ranks by score, then by fewer unknown facts, then by code-point id — strictly", () => {
    /*
     * STRICTLY less than zero, not "less than or equal". A comparator that
     * returns 0 for two distinct entries leaves their order to the engine's sort
     * stability, which is a determinism bug that no example test can see because
     * the example always supplies them in one order. Asserting strictness over
     * generated input is what turns "sorted" into "deterministically sorted".
     */
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const { ranked } = rankStreamCandidates([...candidates], capabilities);
        for (let index = 1; index < ranked.length; index++) {
          const previous = defined(ranked[index - 1], "previous ranked entry");
          const current = defined(ranked[index], "current ranked entry");
          expect(compareRankedSpec(previous, current)).toBeLessThan(0);
        }
      })
    );
  });

  it("sorts rejections by code-point candidate id, strictly", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const { rejected } = rankStreamCandidates([...candidates], capabilities);
        for (let index = 1; index < rejected.length; index++) {
          const previous = defined(rejected[index - 1], "previous rejection");
          const current = defined(rejected[index], "current rejection");
          expect(previous.candidateId < current.candidateId).toBe(true);
        }
      })
    );
  });

  it("accounts for every candidate exactly once, in ranked or in rejected", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const decision = rankStreamCandidates([...candidates], capabilities);
        expect([...idsOf(decision)].sort()).toEqual([...candidates.map((c) => c.id)].sort());
      })
    );
  });
});

describe("the rights boundary holds for arbitrary input", () => {
  it("never ranks, selects or scores a candidate outside the playable allowlist", () => {
    /*
     * Generated with rights values that may be OUTSIDE the vocabulary — see
     * `unvettedRightsArb`. With only well-typed values this property is vacuous,
     * because every member of `contentRightsSchema` is currently on the
     * allowlist, and a vacuous test of product invariant 1 is worse than none.
     */
    fc.assert(
      fc.property(unvettedRightsCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const decision = rankStreamCandidates([...candidates], capabilities);
        const playable = (rights: StreamCandidate["rights"]): boolean => PLAYABLE_RIGHTS.includes(rights);

        for (const entry of decision.ranked) expect(playable(entry.candidate.rights)).toBe(true);
        if (decision.selected !== null) expect(playable(decision.selected.candidate.rights)).toBe(true);

        // And every unplayable candidate is refused for RIGHTS specifically —
        // rights are evaluated first, so a candidate that is also technically
        // unplayable still reports the reason that would matter if the other
        // were fixed.
        const unplayableIds = candidates.filter((c) => !playable(c.rights)).map((c) => c.id);
        const rightsRejectedIds = decision.rejected
          .filter((entry) => entry.reason === "rights_not_playable")
          .map((entry) => entry.candidateId);
        expect([...rightsRejectedIds].sort()).toEqual([...unplayableIds].sort());
      })
    );
  });
});

describe("eligibility never invents a fact", () => {
  it("refuses a candidate only on facts it actually stated", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const decision = rankStreamCandidates([...candidates], capabilities);

        for (const rejection of decision.rejected) {
          const candidate = defined(byId.get(rejection.candidateId), `candidate ${rejection.candidateId}`);
          switch (rejection.reason) {
            case "unsupported_video_codec":
              // Rejecting an UNSTATED codec would report a device limitation
              // nobody has demonstrated. Unknown is neither a pass nor a fail.
              expect(candidate.videoCodec).not.toBeNull();
              break;
            case "unsupported_audio_codec":
              expect(candidate.audioCodec).not.toBeNull();
              break;
            case "resolution_exceeds_capability":
              // Refusing a stream over a measurement that does not exist is the
              // mirror image of defaulting it to h264 and claiming compatibility.
              expect(candidate.height).not.toBeNull();
              break;
            case "provider_health_below_floor":
              expect(candidate.healthScore).toBeLessThan(PROVIDER_HEALTH_FLOOR);
              break;
            case "rights_not_playable":
              expect(PLAYABLE_RIGHTS.includes(candidate.rights)).toBe(false);
              break;
          }
        }
      })
    );
  });
});

describe("the decision reason describes the decision", () => {
  it("keeps selected, ranked and reason mutually consistent", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities) => {
        const decision = rankStreamCandidates([...candidates], capabilities);

        if (decision.ranked.length === 0) {
          expect(decision.selected).toBeNull();
          expect(decision.reason).toBe("no_eligible_candidates");
          return;
        }

        // Narrowed here rather than through `defined`, which strips undefined
        // and not null. `selected` is genuinely nullable, so `defined` returned
        // it unnarrowed and the compiler was right to object. Widening the
        // helper would have been the wrong fix: its other twenty-nine callers
        // pass array indices and Map lookups, where undefined is the only way a
        // value can be absent, and teaching it to swallow null would make it
        // claim a check it had not performed.
        const { selected } = decision;
        expect(selected).not.toBeNull();
        if (selected === null) return;

        expect(selected).toEqual(decision.ranked[0]);

        // A caller pattern-matching on the reason must not be able to handle
        // "we picked something" without noticing that what we picked has not
        // been shown to decode.
        expect(decision.reason).toBe(
          selected.compatibility === "verified"
            ? "highest_eligible_score"
            : "highest_eligible_score_unverified_compatibility"
        );
      })
    );
  });

  it("labels compatibility verified only when both codecs were stated AND checked", () => {
    fc.assert(
      fc.property(streamCandidatesArb, capabilitiesArb, (candidates, capabilities: PlaybackCapabilities) => {
        const decision = rankStreamCandidates([...candidates], capabilities);
        for (const entry of decision.ranked) {
          const { videoCodec, audioCodec } = entry.candidate;
          if (entry.compatibility === "verified") {
            expect(videoCodec).not.toBeNull();
            expect(audioCodec).not.toBeNull();
            if (videoCodec !== null) expect(capabilities.supportedVideoCodecs).toContain(videoCodec);
            if (audioCodec !== null) expect(capabilities.supportedAudioCodecs).toContain(audioCodec);
          } else {
            expect(videoCodec === null || audioCodec === null).toBe(true);
          }
        }
      })
    );
  });
});
