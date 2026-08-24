import type { EligibleContentId } from "./eligibility";
import type { CandidateGenerator, GeneratorReason } from "./generator";
import { compareCodePoint, nonEmpty } from "./ordering";
import type { RecommendationView } from "./view";

/* -------------------------------------------------------------------------
 * The deterministic ranking layer (PL-0801)
 *
 * ORDERING, NOT SCORING. There is no number in this module that means "how good
 * a recommendation this is". The order is a lexicographic comparison over facts
 * that are already true of the candidate — which generator produced it, and
 * where in that generator's output it fell — and every one of those facts is a
 * deterministic function of the view. A relevance score would be the ML
 * recommender PL-0801 explicitly does not build, and it would arrive here
 * disguised as a tiebreak.
 * ---------------------------------------------------------------------- */

export interface RankedRecommendation {
  readonly contentId: EligibleContentId;
  /** Every reason from every generator that produced this candidate. Never empty. */
  readonly reasons: readonly [GeneratorReason, ...GeneratorReason[]];
  /** 1-based position in the slate. */
  readonly rank: number;
}

interface MergedCandidate {
  readonly contentId: EligibleContentId;
  /** Index in the generator array of the FIRST generator that produced it. */
  readonly generatorIndex: number;
  /** Position within that generator's own output. */
  readonly emissionIndex: number;
  readonly reasons: GeneratorReason[];
}

function sameReason(a: GeneratorReason, b: GeneratorReason): boolean {
  return a.generatorId === b.generatorId && a.code === b.code && a.detail === b.detail;
}

/**
 * The published order, as a total comparator.
 *
 * 1. the highest-precedence generator that produced the candidate;
 * 2. that generator's own emission position;
 * 3. content id by code point.
 *
 * (1) and (2) are already jointly unique — a candidate is merged under one
 * generator index and one emission index, and a generator's emissions are
 * deduplicated below — so (3) is unreachable today. It is written anyway,
 * because "already unique" is a property of the current merge and not of the
 * comparator, and the failure mode when that stops being true is silent: a
 * comparator returning 0 for two distinct entries hands their order to
 * `Array.prototype.sort` stability, which hands it to input order. That is the
 * defect this repository has now found six times. A terminal tiebreak on a field
 * that is unique by construction is the cheapest way to make the comparator
 * total regardless of what happens above it.
 *
 * Deliberately NOT a tiebreak: reason count. "More generators agreed" is a
 * plausible-sounding quality signal, which is exactly why it does not belong in
 * a boundary task — it is a scoring model with one feature, and it would make
 * adding a generator silently reorder existing rails.
 */
function compareMerged(a: MergedCandidate, b: MergedCandidate): number {
  if (a.generatorIndex !== b.generatorIndex) return a.generatorIndex - b.generatorIndex;
  if (a.emissionIndex !== b.emissionIndex) return a.emissionIndex - b.emissionIndex;
  return compareCodePoint(a.contentId, b.contentId);
}

/**
 * Runs the generators and merges their output into one ordered slate.
 *
 * MERGE KEEPS EVERY REASON. When two generators produce the same work, the
 * candidate is ranked under the first one but carries both reasons, in generator
 * order then emission order. Dropping the later reason would be invisible in the
 * slate and would mean the trail explains the ordering rather than the
 * selection, which is the weaker of the two things it is for.
 *
 * DUPLICATE EMISSIONS WITHIN ONE GENERATOR ARE COLLAPSED at their first
 * position. A generator that emits the same id twice is buggy, but the failure
 * must not be an order-dependent slate — and `emissionIndex` has to stay a
 * function of the deduplicated sequence or the comparator's uniqueness argument
 * stops holding.
 *
 * Generators are called once each, in array order, with the view and nothing
 * else.
 */
export function rankCandidates(
  view: RecommendationView,
  generators: readonly CandidateGenerator[]
): readonly RankedRecommendation[] {
  const merged = new Map<string, MergedCandidate>();

  generators.forEach((generator, generatorIndex) => {
    const seen = new Set<string>();
    let emissionIndex = 0;

    for (const candidate of generator.generate(view)) {
      if (seen.has(candidate.contentId)) continue;
      seen.add(candidate.contentId);
      const position = emissionIndex;
      emissionIndex += 1;

      const existing = merged.get(candidate.contentId);
      if (existing === undefined) {
        merged.set(candidate.contentId, {
          contentId: candidate.contentId,
          generatorIndex,
          emissionIndex: position,
          reasons: [...candidate.reasons]
        });
        continue;
      }
      for (const incoming of candidate.reasons) {
        if (!existing.reasons.some((held) => sameReason(held, incoming))) existing.reasons.push(incoming);
      }
    }
  });

  return [...merged.values()].sort(compareMerged).map((entry, index) => ({
    contentId: entry.contentId,
    reasons: nonEmpty(entry.reasons, `reasons for ${entry.contentId}`),
    rank: index + 1
  }));
}
