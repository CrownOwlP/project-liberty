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

export { defineStremioSource, defineStremioSources, MIN_RIGHTS_BASIS_LENGTH } from "./source";
export type {
  AuthorizedStremioSource,
  DefineStremioSourceResult,
  SourceRejectionReason,
  StremioSourceInput
} from "./source";

export {
  deriveProtocol,
  mapStremioStream,
  mapStremioStreams,
  observedHealthScore,
  stableStreamKey,
  streamLabel,
  UNKNOWN_AUDIO_CODEC,
  UNKNOWN_BITRATE_KBPS,
  UNKNOWN_HEIGHT,
  UNKNOWN_VIDEO_CODEC
} from "./mapping";
export type {
  MappedStream,
  RejectedStream,
  StreamMappingBatch,
  StreamMappingContext,
  StreamMappingResult,
  StreamRejectionReason,
  UnknownField
} from "./mapping";

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

export { checkUrl, classifyHost } from "./url-policy";
export type { HostClass, UrlCheckResult, UrlPolicyOptions, UrlRejectionReason } from "./url-policy";

export { fetchJson } from "./http";
export type { FetchLike, HttpFailureReason, HttpJsonResult, HttpOptions } from "./http";
