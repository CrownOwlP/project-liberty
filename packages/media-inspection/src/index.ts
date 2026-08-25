/**
 * `@liberty/media-inspection` -- what a publisher DECLARED, and who said so.
 *
 * WHY THIS IS A PACKAGE AND NOT A FOLDER IN `@liberty/provider-sdk`. Inspection
 * is cross-provider I/O against arbitrary publisher infrastructure, and the path
 * it is the front half of ends in an external binary with a security and
 * licensing profile nothing else in this repository shares. A provider adapter
 * talks to one configured source; this talks to whatever a rights decision
 * authorised. Those are different blast radii and they get different boundaries.
 *
 * WHAT SHIPS NOW: the manifest path, which has no FFmpeg dependency at all. One
 * small GET, one parse, the whole declared ladder, and no media segment opened.
 * That takes the slowest legal question -- how to ship a GPL-3.0 binary we did
 * not intend to ship -- off the critical path entirely.
 *
 * WHAT DOES NOT SHIP: any probing. `FactSource` already names `probe` and
 * `FACT_SOURCE_STRENGTH` already ranks it, so the day that lands it is an
 * addition rather than a redefinition, and no consumer's handling of the two
 * existing sources changes meaning underneath it.
 *
 * THE FOUR THINGS A CONSUMER MUST NOT GET WRONG:
 *
 *   1. A `null` fact is UNKNOWN. Not zero, not a default, not "probably h264".
 *      Every parser here refuses to infer, so a `null` reaching a consumer is
 *      load-bearing information about the publisher.
 *   2. A `manifest_declared` fact is a CLAIM, not a measurement. It outranks
 *      what a provider said and it does not outrank bytes.
 *   3. An `allowed: true` verdict on a variant URI is not a clearance to fetch
 *      it. See `UriVerdict`.
 *   4. `fetchImpl` IS NOT `fetch`. It takes the `PinnedTarget` an authorisation
 *      produced, and the addresses in it are the only ones a socket may be
 *      opened to. Supplying an adapter that ignores them and calls `fetch` on
 *      `target.url` reinstates the DNS rebinding window this package was built
 *      to close -- silently, because every other check still passes.
 */

export { readDeclaredCodecs, NO_DECLARED_CODECS, type DeclaredCodecs } from "./codecs";
export { parseDashLadder } from "./dash";
export { detectManifestFormat } from "./detect";
export {
  ALLOWED_PROTOCOLS,
  authoriseFetchTarget,
  checkUrlStatically,
  hostOnAllowlist,
  type EgressDependencies,
  type EgressPolicy,
  type EgressRejectionReason,
  type FetchTargetVerdict,
  type HostClass,
  type HostClassifier,
  type HostResolver,
  type StaticUrlVerdict
} from "./egress";
export { parseHlsLadder } from "./hls";
export {
  fetchManifestText,
  type ManifestFetchDependencies,
  type ManifestFetchFailure,
  type ManifestFetchOptions,
  type ManifestFetchResult
} from "./http";
/*
 * The pinning TYPES are here; the Node implementation is not, and importing this
 * barrel must not load `node:https`. It is reached at
 * `@liberty/media-inspection/node/pinned-fetch` instead, so the runtime-agnostic
 * surface stays runtime agnostic and a composition root states which runtime it
 * is composing for.
 */
export {
  bareAddress,
  createPinnedLookup,
  type PinnedFetch,
  type PinnedLookup,
  type PinnedLookupAddress,
  type PinnedLookupCallback,
  type PinnedLookupOptions,
  type PinnedRequestInit,
  type PinnedTarget
} from "./pin";
export {
  DEFAULT_INSPECTION_LIMITS,
  inspectManifest,
  parseManifestLadder,
  type InspectionAuthorization,
  type InspectionDependencies,
  type InspectionOptions
} from "./inspect";
export { canonicaliseRenditions, compareRenditions } from "./order";
export {
  FACT_SOURCE_STRENGTH,
  observationsFromRendition,
  reconcileFact,
  type FactAgreement,
  type FactObservation,
  type ReconciledFact
} from "./provenance";
export {
  buildRendition,
  readFrameRate,
  readPositiveInteger,
  type FactReading,
  type RawDeclaration,
  type RenditionDraft
} from "./rendition";
export {
  INSPECTED_FACTS,
  type DeclaredRendition,
  type FactEvidence,
  type FactSource,
  type InspectedFact,
  type InspectionReason,
  type InspectionReasonCode,
  type InspectionResult,
  type ManifestFormat,
  type ManifestParseContext,
  type ParsedLadder,
  type RenditionEvidence,
  type RenditionKind,
  type RenditionLocation,
  type UriVerdict
} from "./types";
