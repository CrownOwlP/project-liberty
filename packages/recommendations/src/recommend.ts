import { z } from "zod";
import { resolvedEligibilitySchema, sealEligibility } from "./eligibility";
import type { CandidateGenerator } from "./generator";
import { generatorReasonSchema } from "./generator";
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

    /*
     * THE SAME ARGUMENT, APPLIED TO THE REASON TRAIL.
     *
     * `generatorReasonSchema` is `.strict()` and its code is a closed enum, and
     * until now nothing ever ran it: reasons were type-checked and never parsed,
     * so the schema described the seam without policing it. That is the identical
     * hole the eligibility backstop above exists to close, and `generators` is
     * the parameter through which foreign code arrives — the request is parsed
     * because it crosses a trust boundary, and so does a generator.
     *
     * Three things this catches that the compiler cannot, each of which reaches
     * a payload that is rendered, logged and cached:
     *
     *   - a `code` outside the vocabulary, which a presentation surface cannot
     *     render or localise and will silently drop, leaving an item on a shelf
     *     with no explanation — the exact failure PL-0801 exists to prevent;
     *   - an extra key, which is how a profile id, a position or an age bracket
     *     rides out of this package inside an object nobody inspects. Strictness
     *     on the REQUEST stops data being smuggled in; this stops it being
     *     smuggled out, and only the second one is on the path to a client;
     *   - an empty `generatorId` or `detail`, which makes a bad rail
     *     untraceable to its source.
     *
     * It cannot make `detail` free of personal data — no schema can decide that
     * about arbitrary prose. Keeping a measurement of one profile out of the
     * gloss stays a review obligation on each generator, pinned by the property
     * in `reasons.test.ts`. What this establishes is narrower and worth stating
     * honestly: the SHAPE of a published reason is enforced, not assumed.
     *
     * THROWS, for the reason the eligibility backstop throws: a filtered trail is
     * a trail that silently shrank, and a slate whose reasons quietly went
     * missing is indistinguishable from one that never had any.
     */
    for (const held of entry.reasons) {
      const checked = generatorReasonSchema.safeParse(held);
      if (checked.success) continue;
      const issues = checked.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(
        `a generator produced an unusable reason for ${entry.contentId} (${issues}); the reason trail is published, so it is parsed at this seam rather than trusted`
      );
    }
  }

  return presentSlate(view, ranked.slice(0, parsed.limit), excluded, parsed.at);
}
