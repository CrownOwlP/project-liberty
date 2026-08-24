import { z } from "zod";
import type { EligibleContentId } from "./eligibility";
import type { RecommendationView } from "./view";

/* -------------------------------------------------------------------------
 * The candidate generation layer (PL-0801)
 *
 * A generator answers one question — "which eligible works are worth putting in
 * front of this profile, and why" — and answers it in ids plus reasons. It does
 * not score, does not order the final slate, and cannot reach anything the view
 * does not contain.
 * ---------------------------------------------------------------------- */

/**
 * The vocabulary of generator reasons.
 *
 * A closed enum rather than free text, because the reason trail has two
 * consumers with opposite needs: a human debugging why a work appeared, and a
 * presentation surface that has to render or localise the explanation. Free text
 * serves the first and silently defeats the second, and the surface then invents
 * its own labels — at which point the trail is decorative.
 *
 * Extending this is expected. Adding a code is a one-line change plus whatever
 * the presentation surface does with it; that visible cost is the intended one.
 */
export const generatorReasonCodeSchema = z.enum(["continue_watching", "on_your_watchlist"]);
export type GeneratorReasonCode = z.infer<typeof generatorReasonCodeSchema>;

export const generatorReasonSchema = z
  .object({
    /** Which generator said this, so a bad rail is traceable to its source. */
    generatorId: z.string().min(1),
    code: generatorReasonCodeSchema,
    /**
     * A short human-readable gloss.
     *
     * DELIBERATELY CARRIES NO NUMBERS. "42% into a 118-minute film" would push a
     * precise behavioural measurement of one profile into a presentation payload
     * that is rendered, logged and cached, in service of a sentence the `code`
     * already conveys. The reason trail exists to make selection debuggable, not
     * to restate the progress record.
     */
    detail: z.string().min(1)
  })
  .strict();
export type GeneratorReason = z.infer<typeof generatorReasonSchema>;

/**
 * A candidate, which is an id and at least one reason — never an id alone.
 *
 * The non-empty tuple is the mechanism that keeps the reason trail alive. The
 * layer most likely to lose it is the one immediately downstream: merging
 * several generators' output into one ordered list is exactly where "we only
 * need the ids here" gets written, and a `GeneratedCandidate[]` collapsed to a
 * `string[]` would be an entirely reasonable-looking refactor. With reasons
 * required and non-empty in the type, that refactor does not compile.
 */
export interface GeneratedCandidate {
  readonly contentId: EligibleContentId;
  readonly reasons: readonly [GeneratorReason, ...GeneratorReason[]];
}

/**
 * A candidate generator.
 *
 * `generate` takes the view and NOTHING ELSE. No profile id, no request object,
 * no clock, no repository handle, no second parameter that a later change could
 * quietly widen. This signature is the data-minimisation guarantee: whatever a
 * generator learns about a person, it learned from `RecommendationView`, and
 * that type is a short reviewable list.
 *
 * The absent clock is the determinism half of the same rule. A generator that
 * called `Date.now()` would return different candidates on two calls with
 * identical inputs, and nothing in the pipeline below could detect it.
 */
export interface CandidateGenerator {
  readonly id: string;
  generate(view: RecommendationView): readonly GeneratedCandidate[];
}

/** Convenience for generators, which always build exactly one reason at a time. */
export function reason(
  generatorId: string,
  code: GeneratorReasonCode,
  detail: string
): readonly [GeneratorReason, ...GeneratorReason[]] {
  return [{ generatorId, code, detail }];
}
