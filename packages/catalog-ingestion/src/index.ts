/**
 * `@liberty/catalog-ingestion` -- what a catalog is made of, and where it would
 * come from.
 *
 * WHY THIS IS A PACKAGE AND NOT A FOLDER IN `apps/web`. `docs/ARCHITECTURE.md`
 * lists "metadata ingestion worker" as an extraction candidate, and the reason
 * it is one is the same reason `@liberty/media-inspection` is a package: this is
 * cross-provider I/O against infrastructure nobody here administers, on a
 * schedule, with a blast radius the browse surfaces do not share. A rail renders
 * what it is given; this decides what exists. Keeping the second out of the app
 * is also what lets it import `@liberty/provider-sdk` for the opaque-rights-
 * reference rule -- an import `apps/web` still cannot afford, because the SDK
 * publishes one root entry point and a browse surface would pull the whole of it
 * into the bundle of every page that renders a card.
 *
 * ===========================================================
 * THERE IS NO CONFIGURED PROVIDER, AND THAT IS THE HONEST STATE
 * ===========================================================
 *
 * `resolveCatalogMetadataProvider()` answers `not-configured` with the reason
 * `no_catalog_provider_licensed`, unconditionally. Choosing where a product's
 * catalog comes from is a LICENSING decision and attaching a key to it is a
 * CREDENTIALS decision; `control/policies.json` reserves both to the human
 * commander. `docs/CATALOG_SOURCE.md` carries the evidenced shortlist that
 * decision would be made from. Nothing in this package reads an environment
 * variable, and no placeholder credential exists anywhere in it -- a stub that
 * looks like a real key makes an unconfigured build look configured, which is
 * worse than an absence.
 *
 * WHAT IS BUILT AND TESTED WITHOUT ONE: identity and dedupe (`identity.ts`),
 * refresh and staleness (`freshness.ts`), the provider port with paging,
 * incremental sync and declared search (`provider.ts`), the rights and
 * media-address checks (`safety.ts`), the paging/backfill/tombstone pass
 * (`ingest.ts`), and the projection to the browse contract (`project.ts`).
 *
 * THREE THINGS A CONSUMER MUST NOT GET WRONG:
 *
 *   1. A CATALOG RECORD IS NOT A PLAYBACK RECORD. Nothing in this package's
 *      vocabulary can hold a media address, `findMediaAddresses` refuses a raw
 *      payload that carries one, and `project.ts` emits `CatalogItem`, which has
 *      no url, image or stream field. Catalog metadata and playback resolution
 *      are different boundaries. Do not join them here.
 *   2. `rights: null` IS "NOBODY CHECKED", NEVER "NO RIGHTS NEEDED". It is
 *      refused, never defaulted, and the work's own category field is not read
 *      as a substitute.
 *   3. A TOMBSTONE ONLY EVER COMES FROM A COMPLETE PASS OR AN EXPLICIT
 *      WITHDRAWAL. `runIngestionPass` withholds them by name otherwise. Do not
 *      infer a deletion from an empty page, a failed page, or an incremental
 *      sync.
 */

export {
  assessFreshness,
  planNextPassAt,
  validateStalenessPolicy,
  type DatedAnswer,
  type Freshness,
  type FreshnessAssessment,
  type FreshnessRefusal,
  type FreshnessVerdict,
  type RefreshCadence,
  type StalenessPolicy
} from "./freshness";
export {
  deriveNormalizedContentId,
  normalizeIdSegment,
  resolveWorkIdentities,
  type ExternalRef,
  type IdDerivation,
  type IdDerivationRefusal,
  type IdentityCandidate,
  type IdentityRefusal,
  type IdentityResolution,
  type SourceWorkRef,
  type WorkIdentity
} from "./identity";
export {
  reconcileTombstones,
  runIngestionPass,
  type IngestionPassDependencies,
  type IngestionPassOptions,
  type IngestionPassResult,
  type RecordRefusal,
  type RecordRefusalReason,
  type TombstoneWithholdReason
} from "./ingest";
export {
  isAvailable,
  projectCatalogAnswer,
  projectToCatalogRecord,
  selectLocalized,
  type Projection,
  type ProjectedCatalogRecord,
  type ProjectedRightsBasis,
  type ProjectionOutcome,
  type ProjectionRefusal,
  type ProjectionRequest,
  type UnstatedAvailability
} from "./project";
export {
  LICENSED_CATALOG_SOURCE_IDS,
  isLicensedCatalogSourceId,
  requireProviderSideSearch,
  resolveCatalogMetadataProvider,
  type AcceptedWork,
  type CatalogMetadataProvider,
  type CatalogMetadataProviderResolution,
  type CatalogProviderRuntime,
  type CatalogProviderUnavailableReason,
  type ProviderCapabilities,
  type ProviderFetchFailure,
  type ProviderPageRequest,
  type ProviderPageResult,
  type ProviderSearchRefusal,
  type ProviderSearchResult,
  type RawProviderRecord
} from "./provider";
export {
  artworkRefSchema,
  availabilityWindowSchema,
  ingestedRecordSchema,
  ingestedRightsBasisSchema,
  ingestedWorkKindSchema,
  ingestedWorkSchema,
  languageTagSchema,
  localizedTextSchema,
  localizedTextSetSchema,
  recordProvenanceSchema,
  territorySchema,
  workTombstoneSchema,
  type ArtworkRef,
  type AvailabilityWindow,
  type IngestedRecord,
  type IngestedRightsBasis,
  type IngestedWork,
  type IngestedWorkKind,
  type LanguageTag,
  type LocalizedText,
  type LocalizedTextSet,
  type RecordProvenance,
  type Territory,
  type WorkTombstone
} from "./record";
export {
  checkRightsBasis,
  findMediaAddresses,
  type MediaAddressFinding,
  type RightsCheck,
  type RightsRefusal
} from "./safety";
export {
  CATALOG_DOCUMENT_LIMITS,
  fetchCatalogDocument,
  type CatalogDocumentFailure,
  type CatalogDocumentOptions,
  type CatalogDocumentResult
} from "./transport";
export {
  WIKIDATA_CAPABILITIES,
  createWikidataProvider,
  noRightsBasisEstablished,
  type WikidataConfigRefusal,
  type WikidataProviderConfig,
  type WikidataProviderCreation,
  type WikidataRightsObservation,
  type WikidataRightsRegister,
  type WikidataSelection
} from "./wikidata";
export {
  CC0_ENTITY_ID_PATTERN,
  CC0_ITEM_ID_PATTERN,
  WIKIDATA_ACTION_API_ENDPOINT,
  WIKIDATA_CC0_HOSTS,
  WIKIDATA_PROPERTIES,
  WIKIDATA_SOURCE_ID,
  WIKIDATA_SPARQL_ENDPOINT,
  buildHydrationRequestUrl,
  buildPageQuery,
  buildPageRequestUrl,
  buildSearchRequestUrl,
  checkWikidataUserAgent,
  containsServiceClause,
  isWikidataCc0Host,
  requireCc0EntityId,
  type Cc0EntityIdRefusal,
  type QueryBuild,
  type QueryBuildRefusal,
  type UserAgentRefusal
} from "./wikidata-query";
