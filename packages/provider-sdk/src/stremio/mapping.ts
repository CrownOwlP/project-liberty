import {
  PLAYABLE_CONTENT_RIGHTS,
  streamCandidateSchema,
  type ContentRights,
  type StreamCandidate
} from "@liberty/contracts";
import { formatIssues, type StremioStream } from "./protocol";
import { checkUrl, truncate, type UrlRejectionReason } from "./url-policy";

/**
 * Stremio stream object -> `StreamCandidate` (PL-0301).
 *
 * Pure and deterministic. No clock, no network, no counters: everything that
 * varies between runs -- measured latency, observed source health -- is passed
 * in as context by the client, so the same stream object and the same context
 * always produce the same candidate, and the whole mapping layer is testable
 * without a network or a fake timer. This is the same separation media-engine
 * draws between `scoreCandidate` and the request that produced the candidates.
 *
 * Two things this file refuses to do, and why:
 *
 *   1. It never resolves an indirect source. `infoHash`, `sources` (trackers and
 *      DHT hints), `magnet:` URLs, YouTube ids and `externalUrl` are all
 *      recognised and REFUSED with a reason naming what they were. Refusing with
 *      a reason -- rather than not implementing the code path -- is what makes
 *      the refusal auditable: there is a test that a torrent stream produces
 *      `torrent_source_unsupported`, and that test fails the day someone adds a
 *      resolver.
 *
 *   2. It never reads rights from the stream. The `rights` on every candidate is
 *      the operator's declared value from the source config, copied verbatim.
 *      There is a redundant allowlist check on that value at the top of the
 *      mapper, which the branded `AuthorizedStremioSource` already guarantees;
 *      it is kept because this function is exported and pure, so it will
 *      eventually be called by something that did not come through the
 *      constructor.
 */

export type StreamRejectionReason =
  | "rights_not_playable"
  | "torrent_source_unsupported"
  | "magnet_source_unsupported"
  | "youtube_id_unsupported"
  | "external_url_not_playable"
  | "proxy_headers_unsupported"
  | "no_playable_url"
  | "stream_not_web_ready"
  | "duplicate_stream_url"
  | "candidate_failed_contract"
  | UrlRejectionReason;

/** Contract fields the Stremio protocol simply does not carry a value for. */
export type UnknownField = "height" | "bitrateKbps" | "videoCodec" | "audioCodec";

export interface StreamMappingContext {
  /** Becomes `providerId`, and namespaces the candidate id. */
  readonly sourceId: string;
  /** The operator's declared rights. Copied onto the candidate unchanged. */
  readonly rights: ContentRights;
  readonly allowLoopback: boolean;
  readonly acceptNotWebReady: boolean;
  /** Measured round trip of the request that produced this stream, in ms. */
  readonly observedLatencyMs: number;
  /** Observed health of the source; see `observedHealthScore`. */
  readonly healthScore: number;
}

export interface MappedStream {
  readonly candidate: StreamCandidate;
  /** The validated, directly playable URL the candidate refers to. */
  readonly url: string;
  /**
   * Which of the candidate's fields are placeholders rather than facts.
   *
   * Published rather than buried, because a downstream reader comparing a
   * Stremio candidate against one from a provider that reports real values needs
   * to know that this candidate's `height` is a floor and not a measurement.
   */
  readonly unknownFields: readonly UnknownField[];
  /** The addon's own `notWebReady` flag, preserved for the reason trail. */
  readonly notWebReady: boolean;
  /** The addon's display text, for logs. Never parsed for meaning. */
  readonly label: string;
}

export type StreamMappingResult =
  | { readonly ok: true; readonly mapped: MappedStream }
  | { readonly ok: false; readonly reason: StreamRejectionReason; readonly detail: string };

/**
 * Placeholder height for a stream whose resolution the protocol does not state.
 *
 * The Stremio protocol has no resolution field. Real addons put "1080p" in the
 * free-text `name`/`title`, and parsing it was rejected on purpose: that string
 * is authored by the same party whose stream is being ranked, media-engine
 * rewards `height` with the single largest weight in its score model, and a
 * release-name parser would therefore let any addon promote its own streams by
 * renaming them. Advertising is not measurement.
 *
 * 480 is the SD floor, so an unknown-resolution stream ranks BELOW every stream
 * whose resolution is actually known, and never above one. The cost of being
 * wrong in this direction is that a genuinely-1080p stream is under-ranked,
 * which is a quality regression; the cost of being wrong in the other direction
 * is that a 360p stream outranks a real 1080p one and the viewer watches the
 * worse copy, believing the platform chose it. Under-ranking is recoverable.
 *
 * The honest long-term fix is probing the delivered manifest (HLS/DASH variant
 * lists state their resolutions) and a contract that can express "unknown".
 * Both are follow-ups; until then `unknownFields` says which numbers are real.
 */
export const UNKNOWN_HEIGHT = 480;

/**
 * Bitrate target coefficient, in kbps per line of vertical resolution.
 *
 * DUPLICATED from `@liberty/media-engine`'s `BITRATE_KBPS_PER_LINE`, and
 * deliberately not imported: provider-sdk must not depend on the playback engine
 * (adapters sit below policy, and the dependency would invert the layering that
 * docs/ARCHITECTURE.md draws). The right home for a constant both layers need is
 * `@liberty/contracts`; that package is owned by another task right now, so this
 * is a knowing duplication with a note rather than a silent one. If the engine's
 * value changes and this one does not, the only consequence is that the
 * placeholder pair below stops being neutral -- see `UNKNOWN_BITRATE_KBPS`.
 */
const BITRATE_KBPS_PER_LINE = 7.5;

/**
 * Placeholder bitrate, chosen to be CONSISTENT with `UNKNOWN_HEIGHT`.
 *
 * media-engine scores bitrate as a distance from `height * 7.5`, penalising
 * both under- and over-provisioning. Any bitrate picked independently of the
 * height placeholder would therefore add a second, meaningless penalty (or a
 * meaningless bonus) on top of the resolution one -- the candidate would be
 * marked down for a mismatch between two numbers we invented.
 *
 * Pairing them so the distance is zero keeps the cost of not knowing the
 * resolution in exactly one place: the `resolution` dimension, where it belongs.
 */
export const UNKNOWN_BITRATE_KBPS = UNKNOWN_HEIGHT * BITRATE_KBPS_PER_LINE;

/**
 * Codec placeholders.
 *
 * The protocol states no codec, and the contract's enums have no "unknown"
 * member, so SOMETHING has to be written down. h264/aac is the baseline pair
 * that every device profile in this repo supports.
 *
 * Note which way this errs, because it is not the cautious direction and should
 * not be mistaken for it: claiming h264 for a stream that is really HEVC makes
 * media-engine admit a candidate the device may fail to decode. That failure is
 * visible and recoverable -- the player fails over to the next candidate
 * (PL-0502) -- whereas claiming HEVC for everything would hide every stream from
 * every h264-only device, permanently and silently. A rights value is defaulted
 * conservatively because a wrong one is unrecoverable; a codec value is
 * defaulted usefully because a wrong one is not. `unknownFields` records that
 * neither value was observed.
 */
export const UNKNOWN_VIDEO_CODEC: StreamCandidate["videoCodec"] = "h264";
export const UNKNOWN_AUDIO_CODEC: StreamCandidate["audioCodec"] = "aac";

/** Decimal places health is stored at, matching media-engine's score precision. */
const HEALTH_PRECISION = 4;

/**
 * Health from observed request outcomes, never from a hopeful constant.
 *
 * `(successes + 1) / (successes + failures + 2)` is Laplace's rule of
 * succession. Three properties matter here:
 *
 *   - with no observations it is exactly 0.5, which is media-engine's
 *     `PROVIDER_HEALTH_FLOOR`: a source we know nothing about sits precisely on
 *     the boundary rather than being credited with reliability it has not shown;
 *   - one success gives 0.667, not 1.0, so a single lucky response cannot make a
 *     brand-new source outrank a provider with a long clean record;
 *   - it never reaches 0 or 1, so a source is never permanently condemned by one
 *     failure nor permanently trusted.
 *
 * The alternative -- a fixed `healthScore: 0.9` on every candidate -- is the
 * flattering default this adapter is not allowed to invent, and it would make
 * media-engine's health dimension a constant, i.e. dead weight in the ranking.
 */
export function observedHealthScore(successes: number, failures: number): number {
  const s = Math.max(0, Math.floor(successes));
  const f = Math.max(0, Math.floor(failures));
  return Number(((s + 1) / (s + f + 2)).toFixed(HEALTH_PRECISION));
}

/**
 * FNV-1a, 32-bit. NOT a security primitive -- it is a stable id, nothing more.
 *
 * The candidate id has to be a pure function of the stream so that the same
 * stream from the same source is the same candidate on every request: array
 * position would change whenever the addon reorders its results, and a random id
 * would break both deduplication and the ability to correlate two playback
 * decisions in a bug report. Collisions merge two candidates within one source,
 * which is the same outcome as the deduplication that follows anyway.
 */
export function stableStreamKey(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Delivery protocol from the URL path only.
 *
 * The extension is the one signal in a Stremio stream object that is structural
 * rather than editorial: `.m3u8` and `.mpd` are what the file IS, whereas the
 * title is what the addon calls it. Query strings are ignored so that a signed
 * URL (`...m3u8?token=...`) is still recognised as HLS. Anything else is treated
 * as progressive `https`, which is the pessimistic reading -- media-engine
 * scores progressive delivery lower than adaptive, so a misread costs the
 * candidate rank instead of promising an adaptivity it does not have.
 */
export function deriveProtocol(url: URL): StreamCandidate["protocol"] {
  const path = url.pathname.toLowerCase();
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  return "https";
}

function reject(reason: StreamRejectionReason, detail: string): StreamMappingResult {
  return { ok: false, reason, detail };
}

/** Display text for logs and reason trails. Never interpreted. */
export function streamLabel(stream: StremioStream): string {
  const parts = [stream.name, stream.title].filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? truncate(parts.join(" - "), 80) : "(untitled)";
}

/**
 * Maps ONE stream object.
 *
 * The checks run in a fixed order, most fundamental first, so a stream always
 * reports the single most important reason it was refused -- the same discipline
 * as media-engine's `firstRejectionReason`. Rights lead; a stream that both
 * carries an info hash and fails the rights check is reported as a rights
 * failure, because that is the one that would matter if the other were fixed.
 */
export function mapStremioStream(
  stream: StremioStream,
  context: StreamMappingContext
): StreamMappingResult {
  if (!PLAYABLE_CONTENT_RIGHTS.includes(context.rights)) {
    return reject(
      "rights_not_playable",
      `source ${context.sourceId} carries rights ${JSON.stringify(context.rights)}, which are not playable`
    );
  }

  /*
   * Indirect sources, refused before anything else is considered.
   *
   * `infoHash`/`fileIdx`/`sources` are a torrent. `sources` alone is checked as
   * well as `infoHash`, because tracker and DHT hints only exist to serve one,
   * and a stream carrying them is a torrent whether or not the hash field is
   * populated on this particular response.
   *
   * A stream that carries BOTH a direct url and an info hash is refused too. The
   * permissive reading -- "take the url, ignore the hash" -- is how a torrent
   * resolver gets built by accident, one field at a time.
   */
  if (stream.infoHash !== undefined || stream.fileIdx !== undefined) {
    return reject(
      "torrent_source_unsupported",
      "stream identifies a torrent; Project Liberty does not resolve info hashes"
    );
  }
  if (stream.sources !== undefined && stream.sources.length > 0) {
    return reject(
      "torrent_source_unsupported",
      "stream carries tracker/DHT sources; Project Liberty does not resolve peer-to-peer sources"
    );
  }

  if (typeof stream.url === "string" && /^\s*magnet:/i.test(stream.url)) {
    return reject(
      "magnet_source_unsupported",
      "stream url is a magnet link; Project Liberty does not resolve magnet links"
    );
  }

  if (stream.url === undefined && typeof stream.ytId === "string" && stream.ytId !== "") {
    return reject(
      "youtube_id_unsupported",
      "stream is a YouTube id; turning one into a media URL requires extraction this adapter does not perform"
    );
  }

  if (stream.url === undefined && typeof stream.externalUrl === "string" && stream.externalUrl !== "") {
    return reject(
      "external_url_not_playable",
      "stream is a hand-off link to another application, not a playable media URL"
    );
  }

  if (stream.url === undefined || stream.url.trim() === "") {
    return reject("no_playable_url", "stream offers no direct url");
  }

  /*
   * `proxyHeaders` asks us to replay addon-supplied headers (typically Referer
   * or Cookie) to the media origin. Refused, and refused loudly rather than
   * ignored: a stream that only plays when someone else's Referer is attached is
   * a stream whose origin is enforcing an access control, and satisfying that
   * request is the "fallback logic whose purpose is to evade provider
   * enforcement" that docs/CONTENT_RIGHTS.md forbids. It is also a request to
   * turn our server into a header-injecting proxy for an arbitrary URL.
   */
  const proxyHeaders = stream.behaviorHints?.proxyHeaders;
  if (proxyHeaders !== undefined && proxyHeaders !== null) {
    return reject(
      "proxy_headers_unsupported",
      "stream requires replayed request headers; that is an access control this adapter will not work around"
    );
  }

  const checked = checkUrl(stream.url.trim(), { allowLoopback: context.allowLoopback });
  if (!checked.ok) return reject(checked.reason, checked.detail);

  const notWebReady = stream.behaviorHints?.notWebReady === true;
  if (notWebReady && !context.acceptNotWebReady) {
    return reject(
      "stream_not_web_ready",
      "addon flags the stream as not playable in a browser and this source did not opt in"
    );
  }

  const url = checked.url.toString();
  const candidate: StreamCandidate = {
    id: `${context.sourceId}:${stableStreamKey(url)}`,
    providerId: context.sourceId,
    // The declared value, copied. Not derived, not defaulted, not corrected.
    rights: context.rights,
    protocol: deriveProtocol(checked.url),
    height: UNKNOWN_HEIGHT,
    bitrateKbps: UNKNOWN_BITRATE_KBPS,
    estimatedLatencyMs: Math.max(0, Math.round(context.observedLatencyMs)),
    healthScore: context.healthScore,
    videoCodec: UNKNOWN_VIDEO_CODEC,
    audioCodec: UNKNOWN_AUDIO_CODEC
  };

  /*
   * Validated against the contract before it leaves the adapter.
   *
   * Everything above is typed, so this can only fire on a value the type system
   * could not see -- an out-of-range `healthScore` from a caller-supplied
   * context, a NaN latency from a clock that went backwards. The provider SDK is
   * the boundary where third-party data becomes internal data; a boundary that
   * only checks its input and trusts its own output is half a boundary.
   */
  const validated = streamCandidateSchema.safeParse(candidate);
  if (!validated.success) {
    return reject(
      "candidate_failed_contract",
      `mapped candidate failed streamCandidateSchema: ${formatIssues(validated.error.issues)}`
    );
  }

  return {
    ok: true,
    mapped: {
      candidate,
      url,
      unknownFields: ["height", "bitrateKbps", "videoCodec", "audioCodec"],
      notWebReady,
      label: streamLabel(stream)
    }
  };
}

export interface RejectedStream {
  /** Identifies the refused stream in a reason trail. */
  readonly ref: string;
  readonly reason: StreamRejectionReason;
  readonly detail: string;
}

export interface StreamMappingBatch {
  readonly mapped: MappedStream[];
  readonly rejected: RejectedStream[];
}

/**
 * Maps a whole `/stream` response.
 *
 * Addon ORDER IS PRESERVED. Re-sorting here would discard the addon's own
 * ordering without adding information, and choosing between candidates is
 * media-engine's job, not an adapter's -- an adapter that ranks is an adapter
 * whose ranking cannot be seen in the playback decision's reason trail.
 *
 * Duplicate URLs collapse to the first occurrence. Addons routinely list the
 * same file twice under different titles, and two candidates with the same id
 * would make a playback decision's rejection list ambiguous about which one was
 * refused.
 */
export function mapStremioStreams(
  streams: readonly StremioStream[],
  context: StreamMappingContext
): StreamMappingBatch {
  const mapped: MappedStream[] = [];
  const rejected: RejectedStream[] = [];
  const seen = new Set<string>();

  streams.forEach((stream, index) => {
    const result = mapStremioStream(stream, context);
    if (!result.ok) {
      rejected.push({
        ref: `${context.sourceId}:#${index} ${streamLabel(stream)}`,
        reason: result.reason,
        detail: result.detail
      });
      return;
    }

    if (seen.has(result.mapped.candidate.id)) {
      rejected.push({
        ref: result.mapped.candidate.id,
        reason: "duplicate_stream_url",
        detail: "duplicate of an earlier stream with the same URL"
      });
      return;
    }

    seen.add(result.mapped.candidate.id);
    mapped.push(result.mapped);
  });

  return { mapped, rejected };
}
