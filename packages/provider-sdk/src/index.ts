export { assertAuthorizedRights } from "./provider";
export type { AuthorizedMediaProvider, CatalogItemRef, ProviderContext } from "./provider";

export type { CatalogItemRegistry } from "./registry";

/*
 * The fixture adapter. `NonProductionRuntime` and `fixtureRightsBasis` are
 * absent on purpose and must stay absent -- see `./fixture/index.ts`.
 * `createFixtureProvider` is the only way to reach a fixture rights basis, and
 * it requires a `ClassifiedRuntime` issued by
 * `@liberty/contracts/shared/runtime` to get there. That type is deliberately
 * NOT re-exported from this root: it belongs to the contracts package, this
 * package adds nothing to it, and the structural interface that used to stand
 * in its place here was the defect PL-0706 removed.
 */
export {
  DEFAULT_FIXTURE_PROVIDER_ID,
  FIXTURE_RIGHTS_REFERENCE,
  FIXTURE_VARIANTS,
  MAX_RIGHTS_REFERENCE_LENGTH,
  OPAQUE_RIGHTS_REFERENCE_PATTERN,
  createFixtureProvider,
  fixtureCatalogItemRegistry,
  isOpaqueRightsReference
} from "./fixture";
export type {
  CreateFixtureProviderResult,
  FixtureCandidate,
  FixtureProvider,
  FixtureProviderOptions,
  FixtureProviderRejectionReason,
  FixtureResolution,
  FixtureResolutionReason,
  FixtureRightsBasis,
  FixtureVariant
} from "./fixture";

export {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  HEALTH_POLICY_VERSIONS,
  PROVIDER_HEALTH_STATUSES,
  evaluateProviderHealth,
  healthPriorScore,
  healthRankingScore,
  providerHealthFromObservations,
  smoothedSuccessRate,
  summariseHealthObservations
} from "./health";
export type {
  HealthObservation,
  HealthObservationSummary,
  HealthOutcome,
  HealthPolicyVersion,
  ObservedHealthReport,
  ProviderHealthPolicy,
  ProviderHealthReason,
  ProviderHealthReasonCode,
  ProviderHealthReport,
  ProviderHealthStatus,
  UnobservedHealthReport
} from "./health";

export * from "./stremio";
