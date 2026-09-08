export { assertAuthorizedRights } from "./provider";
export type { AuthorizedMediaProvider, CatalogItemRef, ProviderContext } from "./provider";

export type { CatalogItemRegistry } from "./registry";

/*
 * The fixture adapter. `NonProductionRuntime` and `fixtureRightsBasis` are
 * absent on purpose and must stay absent -- see `./fixture/index.ts`.
 * `createFixtureProvider` is the only way to reach a fixture rights basis, and
 * it requires the deployment's own `RuntimeClassification` to get there.
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
  FixtureVariant,
  RuntimeClassification
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
