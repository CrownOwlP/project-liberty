/* -------------------------------------------------------------------------
 * @liberty/recommendations (PL-0801)
 *
 * A package and information boundary, not a recommender.
 *
 * The barrel is part of the boundary. It exports the pipeline, the layer types
 * and the placeholder generators, and it deliberately exports no way to
 * construct an `EligibleContentId` from a string — `sealEligibility` is the only
 * mint, and it only admits ids upstream already resolved as eligible. Adding a
 * brand constructor here would undo the guarantee the rest of the package is
 * built on, which is why the type is exported and the constructor is not.
 *
 * The zod schemas below are LOCAL to this package because `packages/contracts`
 * is locked for this task. They describe shapes that cross a package boundary —
 * an eligibility verdict, a recommendation request — and belong in
 * `@liberty/contracts/domains/recommendations` once the lock lifts.
 * ---------------------------------------------------------------------- */

export type { EligibleContentId, EligibilityExclusion, EligibilitySeal, ResolvedEligibility } from "./eligibility";
export { resolvedEligibilitySchema, sealEligibility } from "./eligibility";

export type {
  BuiltView,
  CatalogFacts,
  CatalogFactsInput,
  ProfileProgress,
  ProgressInput,
  RecommendationInput,
  RecommendationView,
  ViewExclusion,
  ViewExclusionReason
} from "./view";
export { PERMITTED_VIEW_MEMBERS, buildView, recommendationInputSchema } from "./view";

export type {
  CandidateGenerator,
  GeneratedCandidate,
  GeneratorReason,
  GeneratorReasonCode
} from "./generator";
export { generatorReasonCodeSchema, generatorReasonSchema, reason } from "./generator";

export {
  CONTINUE_WATCHING_GENERATOR_ID,
  PLACEHOLDER_GENERATORS,
  WATCHLIST_GENERATOR_ID,
  continueWatchingGenerator,
  watchlistGenerator
} from "./generators";

export type { RankedRecommendation } from "./ranking";
export { rankCandidates } from "./ranking";

export type { PresentedRecommendation, RecommendationSlate } from "./presentation";
export { presentSlate } from "./presentation";

export type { RecommendationRequest } from "./recommend";
export { recommend, recommendationRequestSchema } from "./recommend";
