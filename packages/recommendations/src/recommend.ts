import { z } from "zod";
import { resolvedEligibilitySchema, sealEligibility } from "./eligibility";
import type { CandidateGenerator } from "./generator";
import { PLACEHOLDER_GENERATORS } from "./generators";
import { rankCandidates } from "./ranking";
import { presentSlate, type RecommendationSlate } from "./presentation";
import { buildView, recommendationInputSchema } from "./view";

/* -------------------------------------------------------------------------
 * The pipeline (PL-0801)
 *
 *     RIGHTS / ELIGIBILITY  ->  CANDIDATE GENERATION  ->  RANKING  ->  PRESENTATION
 *
 * Four steps in that order, in one function, so the order is a fact about the
 * code rather than a diagram in a doc. Each arrow narrows: eligibility decides
 * what may be seen, generation decides what is worth surfacing, ranking decides
 * the order, presentation decides the shape. No arrow points back, and nothing
 * downstream of the first can re-open it.
 * ---------------------------------------------------------------------- */

export const recommendationRequestSchema = recommendationInputSchema
  .extend({
    /**
     * The instant, supplied explicitly.
     *
     * There is no `Date.now()` anywhere in this package. A pipeline that reads a
     * clock cannot be tested for determinism, cannot be replayed from a bug
     * report, and produces a different slate for the same profile depending on
     * when it happened to run — and every property below that permutes the input
     * would be asserting over a moving target.
     */
    at: z.string().datetime(),
    /**
     * How many items the slate may carry.
     *
     * Truncation happens AFTER ranking, so the limit selects a prefix of a fixed
     * order rather than influencing what is ranked. Applying it earlier would
     * make the slate depend on how many candidates each generator happened to
     * emit first, which is a different result for a different limit — and the
     * shorter slate would not be a prefix of the longer one, which is what
     * callers assume when they page.
     */
    limit: z.number().int().min(0).max(100),
    /** Verdicts from upstream. This package carries them; it does not compute them. */
    eligibility: z.array(resolvedEligibilitySchema)
  })
  .strict();
export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;

/**
 * Produces a slate for one profile.
 *
 * `generators` is a parameter so a surface can run a different set, and so the
 * tests can substitute a probe that records what it was handed. The default is
 * the placeholder set; see `generators.ts` for why it is deliberately trivial.
 *
 * The request is PARSED, not merely typed. `recommendationRequestSchema` is
 * strict at every level, so a caller that starts sending a profile id, an email
 * or an age bracket alongside the watchlist gets a validation failure instead of
 * an unnoticed widening of what this package processes. A `RecommendationRequest`
 * that arrived over the wire is unvalidated data until it goes through here.
 */
export function recommend(
  request: unknown,
  generators: readonly CandidateGenerator[] = PLACEHOLDER_GENERATORS
): RecommendationSlate {
  const parsed = recommendationRequestSchema.parse(request);

  const seal = sealEligibility(parsed.eligibility);
  const { view, excluded } = buildView(
    { watchlist: parsed.watchlist, progress: parsed.progress, catalog: parsed.catalog },
    seal
  );

  const ranked = rankCandidates(view, generators);

  /*
   * A runtime backstop for a guarantee the types already give.
   *
   * `EligibleContentId` makes an ineligible recommendation impossible to write
   * in TypeScript, which covers every caller that compiles. It does not cover a
   * generator that reached this package as plain JavaScript, or one that used a
   * cast to fabricate the brand. Those are the two ways the compile-time proof
   * can be defeated, and the cost of catching them here is one set lookup per
   * candidate.
   *
   * It THROWS rather than filtering. A filtered slate is a slate that silently
   * shrank, and product invariant 1 is not the place to recover quietly: a
   * generator emitting ids it cannot have obtained legitimately is a defect or
   * an attack, and either one should stop the response.
   */
  const admitted = new Set<string>(view.eligibleIds);
  for (const entry of ranked) {
    if (!admitted.has(entry.contentId)) {
      throw new Error(
        `generator produced ${entry.contentId}, which is not in the eligible view; eligibility is resolved upstream and cannot be widened here`
      );
    }
  }

  return presentSlate(view, ranked.slice(0, parsed.limit), excluded, parsed.at);
}
