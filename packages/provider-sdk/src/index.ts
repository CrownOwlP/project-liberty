export { assertAuthorizedRights } from "./provider";
export type { AuthorizedMediaProvider, CatalogItemRef, ProviderContext } from "./provider";

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
