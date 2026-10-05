/**
 * Stremio addon adapter (PL-0301).
 *
 * The Stremio addon protocol is an open HTTP+JSON protocol: a `manifest.json`
 * describing what an addon serves, and `/catalog/...` and `/stream/...`
 * endpoints returning JSON. Project Liberty speaks it in order to consume
 * LICENSED and PUBLIC-DOMAIN sources, and the operator declares which is which.
 *
 * Read `source.ts` first. The rest of this directory only makes sense once the
 * rights model is clear: rights are declared per configured source and copied
 * onto every candidate, never inferred from anything an addon returns, and a
 * source that fails the declaration gate produces no candidates at all.
 *
 * `add-by-url.ts` (PL-0743) is the thin path from a URL a person pasted to a
 * PREVIEW of what the addon claims to be. It adds no protocol code and no
 * second transport. A preview is not an authorization and cannot become one:
 * only `defineStremioSource` produces something playback may use, and it still
 * requires an explicit operator declaration with an auditable basis.
 *
 * The catalog half of the protocol is deliberately NOT implemented yet. Mapping
 * a Stremio meta object onto `CatalogItem` means supplying `genre`,
 * `releaseYear` and the kind-specific runtime/episode invariants the contract
 * requires, and the protocol supplies none of them reliably -- so the mapping
 * would be guesswork of exactly the kind `mapping.ts` refuses to do for
 * resolution. It is a follow-up, with the contract question settled first.
 */

export {
  createStremioProvider,
  declaredStreamTypes,
  parseStremioItemId,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MANIFEST_TTL_MS,
  DEFAULT_USER_AGENT
} from "./client";
export type { ResolutionReason, StremioProvider, StremioProviderOptions, StremioResolution } from "./client";

export {
  defineStremioSource,
  defineStremioSources,
  describeRightsBasis,
  RIGHTS_BASES_FOR_RIGHTS,
  RIGHTS_BASIS_KINDS,
  RIGHTS_BASIS_MEANING
} from "./source";
export type {
  AuthorizedStremioSource,
  DefineStremioSourceResult,
  DeploymentContext,
  RightsBasis,
  RightsBasisKind,
  SourceRejectionReason,
  StremioSourceInput
} from "./source";

export {
  deriveProtocol,
  mapStremioStream,
  mapStremioStreams,
  observedHealthScore,
  observeStreamMedia,
  resolveStreamMedia,
  stableStreamKey,
  streamLabel,
  streamRef,
  streamTarget
} from "./mapping";
export type {
  KnownMedia,
  MappedStream,
  ObservedMedia,
  RejectedStream,
  StreamMappingBatch,
  StreamMappingContext,
  StreamMappingResult,
  StreamMedia,
  StreamRejectionReason
} from "./mapping";

export { compareCodePoint } from "./order";

export {
  formatIssues,
  manifestServes,
  parseStremioManifest,
  parseStremioStreamResponse,
  stremioManifestSchema,
  stremioStreamResponseSchema,
  stremioStreamSchema
} from "./protocol";
export type {
  ProtocolParseResult,
  StremioManifest,
  StremioStream,
  StremioStreamResponse
} from "./protocol";

export { normalizeAddonUrl, previewStremioAddon } from "./add-by-url";
export type {
  AddByUrlRejectionReason,
  AddByUrlResult,
  NormalizeResult,
  StremioAddonPreview
} from "./add-by-url";

export { checkUrl, classifyHost } from "./url-policy";
export type { HostClass, UrlCheckResult, UrlPolicyOptions, UrlRejectionReason } from "./url-policy";

export { fetchJson } from "./http";
export type { HttpFailureReason, HttpJsonResult, HttpOptions, PinnedFetch } from "./http";
