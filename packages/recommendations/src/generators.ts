import type { CandidateGenerator, GeneratedCandidate } from "./generator";
import { reason } from "./generator";
import type { RecommendationView } from "./view";

/* -------------------------------------------------------------------------
 * PLACEHOLDER GENERATORS (PL-0801)
 *
 * READ THIS BEFORE BUILDING ON THEM. These are not a recommender and are not the
 * beginning of one. They exist to prove the boundary holds end to end with
 * something real flowing through it, and they were chosen for being obviously,
 * unmistakably trivial: two `filter`s over the view. There is no score, no
 * weight, no model, no embedding and no similarity anywhere in this file, and
 * that absence is the deliverable.
 *
 * PL-0801 is a package and information boundary. The architect's ruling was that
 * the boundary is not premature but the recommendation ENGINE is: recommender
 * profiling processes behavioural and personal data to infer preferences, and
 * data minimisation means that processing must be justified before it is built,
 * not after. So the shape is fixed first and the substance arrives through its
 * own task and its own review.
 *
 * Anything that looks like ranking quality belongs in a future generator plus a
 * future ranking signal, both of which reach the profile only through
 * `RecommendationView`. If a change here needs a field the view does not have,
 * that is the review conversation, not a workaround.
 * ---------------------------------------------------------------------- */

export const CONTINUE_WATCHING_GENERATOR_ID = "placeholder:continue-watching";
export const WATCHLIST_GENERATOR_ID = "placeholder:watchlist";

/**
 * Works this profile started and did not finish.
 *
 * `positionSeconds > 0` rather than `>= 0`, because a record at position zero is
 * a work that was opened and not watched; calling that "continue watching"
 * would build a rail out of accidental clicks.
 *
 * Emits in view order, which is code-point order by id. The view is already
 * canonical, so this is a pure function of the input SET and not of the order
 * the caller supplied it in.
 */
export const continueWatchingGenerator: CandidateGenerator = {
  id: CONTINUE_WATCHING_GENERATOR_ID,
  generate(view: RecommendationView): readonly GeneratedCandidate[] {
    return view.progress
      .filter((entry) => !entry.completed && entry.positionSeconds > 0)
      .map((entry) => ({
        contentId: entry.contentId,
        reasons: reason(CONTINUE_WATCHING_GENERATOR_ID, "continue_watching", "started on this profile and not finished")
      }));
  }
};

/**
 * Works this profile put on its watchlist and has not finished.
 *
 * The explicit watchlist is the only preference signal in this package that the
 * profile actually asked for, which is why the placeholder set includes it: a
 * boundary that only ever carried inferred signals would not exercise the
 * distinction the rest of the design rests on.
 *
 * Completed works are dropped so the two placeholder rails do not both surface
 * something already watched. `completed` is read from the progress entry when
 * there is one; a watchlist item with no progress record has not been watched.
 */
export const watchlistGenerator: CandidateGenerator = {
  id: WATCHLIST_GENERATOR_ID,
  generate(view: RecommendationView): readonly GeneratedCandidate[] {
    const completed = new Set(view.progress.filter((entry) => entry.completed).map((entry) => entry.contentId));
    return view.watchlist
      .filter((contentId) => !completed.has(contentId))
      .map((contentId) => ({
        contentId,
        reasons: reason(WATCHLIST_GENERATOR_ID, "on_your_watchlist", "this profile added it to its watchlist")
      }));
  }
};

/**
 * The default generator set, in PRECEDENCE ORDER.
 *
 * This array's order is a ranking input — see `ranking.ts` — so it is a
 * deliberate product statement and not an import-order accident: something the
 * profile is part-way through outranks something it has only bookmarked.
 */
export const PLACEHOLDER_GENERATORS: readonly CandidateGenerator[] = [
  continueWatchingGenerator,
  watchlistGenerator
];
