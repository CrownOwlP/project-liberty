/*
 * THE SHIM THAT USED TO BE NAMED HERE NOW TRAVELS WITH THE FILE THAT NEEDS IT.
 *
 * This file began with a triple-slash reference to
 * `../../media-inspection/src/m3u8-parser.d.ts`, and the reasoning was sound at
 * the time: `@liberty/media-inspection` published ONE entry point, that barrel
 * re-exports `./hls`, whose first line imports `m3u8-parser` -- a package that
 * ships no types -- and the ambient declaration supplying them lived where only
 * media-inspection's own tsconfig included it. Any program reaching this
 * package's public API therefore failed TS7016 on a file it never calls, and
 * `apps/web` became such a program. A reference travels with the source, so
 * naming it here was the only mechanism available from inside this package.
 *
 * PL-0710 removed the need for it, twice over. `@liberty/media-inspection` now
 * publishes `./egress`, `./http`, `./pin` and `./node/*`, so a consumer that
 * wants the bounded fetch need not pull the HLS parser into its program at all.
 * And the reference itself moved to `media-inspection/src/hls.ts`, which is the
 * file that actually imports the untyped package: it now travels with that
 * import to every program that includes it, rather than being restated by each
 * downstream barrel that happens to re-export through it.
 *
 * DO NOT REINTRODUCE A REFERENCE HERE. If a consumer sees TS7016 on
 * `m3u8-parser` again, the declaration has come loose from `hls.ts`, and that is
 * where it belongs -- one reference next to one import, rather than one per
 * consumer who discovers the problem.
 */
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
 * =============================================================
 * THERE IS A CONFIGURED PROVIDER, AND apps/web NOW STANDS ON IT
 * =============================================================
 *
 * This header said the opposite until round 51, and both halves of the change
 * are worth stating rather than quietly deleting.
 *
 * `resolveCatalogMetadataProvider(runtime)` returns a WIKIDATA provider for the
 * one licensed source name, on the human-commander Licensing decision of
 * 2026-09-17, recorded as an INITIAL SOURCE CHOICE AND NOT AN EXCLUSIVE OR
 * PERMANENT MANDATE. A source name that is not licensed is still refused by
 * name with `no_catalog_provider_licensed`, and that refusal is the one a keyed
 * source gets: attaching a credential to a catalog is a separate CREDENTIALS
 * escalation and it has not been taken. Nothing in this package reads an
 * environment variable, and no placeholder credential exists anywhere in it --
 * a stub that looks like a real key makes an unconfigured build look
 * configured, which is worse than an absence.
 *
 * AND THE APPLICATION CONSUMES IT NOW. `apps/web/src/lib/catalog-ingestion-
 * source.ts` projects this package's PUBLIC API into the application's
 * `CatalogMetadataSource` port, and `resolveCatalogMetadataSource` in
 * `apps/web/src/lib/catalog-source-registry.ts` returns that source when a
 * deployment supplies a runtime. `apps/web` imports THIS MODULE and no other
 * file of this package -- in particular it names no Wikidata module -- so the
 * source seam stays where it is. The transport and egress types below are
 * re-exported for exactly that reason: a composition root has to be able to
 * SPELL a runtime without taking a second dependency on
 * `@liberty/media-inspection`.
 *
 * WHAT A WIRED SOURCE STILL IS NOT: a servable catalog. This adapter states no
 * rights basis and no availability window, so an operator with no rights
 * register publishes nothing, by name, per record. That is the fail-closed
 * outcome and not a defect. See `docs/CATALOG_SOURCE.md`.
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

/*
 * THE TRANSPORT AND EGRESS TYPES, RE-EXPORTED RATHER THAN RE-DECLARED.
 *
 * A composition root has to name a `CatalogProviderRuntime`, and two of its
 * fields are `@liberty/media-inspection` types: the egress policy inside
 * `CatalogDocumentOptions` and the injected transport. Re-exporting them here
 * is what lets `apps/web` depend on THIS package alone rather than also taking
 * a dependency on the inspection package in order to spell a type.
 *
 * TYPE-ONLY, DELIBERATELY. `export type` is erased, so this adds nothing to any
 * consumer's RUNTIME graph and cannot drag `node:https` anywhere -- the reason
 * the inspection package keeps its Node pinned-fetch behind a separate subpath
 * in the first place. A consumer that needs the Node TRANSPORT still imports
 * that subpath itself, which is what keeps "which runtime am I composing for" a
 * statement the composition root makes.
 *
 * IT DOES NOT MAKE THE TYPECHECK CHEAPER, and that is worth saying because the
 * sentence above could be read as claiming it does. `provider.ts` and
 * `transport.ts` already import from `@liberty/media-inspection`, so that
 * package's source is in the program of anything that reaches this module
 * whether or not these names are re-exported -- which is exactly why the
 * triple-slash reference above exists. What the re-export buys is that a
 * composition root does not need a SECOND declared dependency in order to spell
 * a type it is already compiling.
 */
export type {
  EgressPolicy,
  HostClass,
  HostClassifier,
  HostResolver,
  PinnedTarget
} from "@liberty/media-inspection/egress";
export type {
  ManifestFetchDependencies,
  ManifestFetchFailure
} from "@liberty/media-inspection/http";
export type { PinnedFetch, PinnedRequestInit } from "@liberty/media-inspection/pin";
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
  assessStoredFreshness,
  catalogRefreshCadence,
  planCatalogRefresh,
  refreshCatalogIfDue,
  validateCatalogRefreshSchedule,
  type CatalogRefreshDependencies,
  type CatalogRefreshPassOptions,
  type CatalogRefreshPlan,
  type CatalogRefreshReason,
  type CatalogRefreshRun,
  type CatalogRefreshSchedule,
  type CatalogScheduleRefusal
} from "./schedule";
export {
  applyPassToSnapshot,
  createInMemoryCatalogStore,
  emptyCatalogSnapshot,
  hasStoredCatalogState,
  knownContentIdsOf,
  partitionCatalogWorks,
  type CatalogPassCommit,
  type CatalogRefreshFailure,
  type CatalogRefreshRecord,
  type CatalogRefreshStatus,
  type CatalogStore,
  type CatalogStoreSnapshot,
  type CatalogWorkPartition,
  type TombstonedWork
} from "./store";
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
