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
 * Three things this file refuses to do, and why:
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
 *
 *   3. It never invents the media facts the contract requires. Codec, resolution
 *      and bitrate are refused with a named reason when the protocol does not
 *      state them, exactly like a torrent is refused -- see `resolveStreamMedia`.
 */

/**
 * The contract fields the Stremio protocol does not state, each naming the fact
 * a stream was refused for lacking. See `resolveStreamMedia`.
 */
export type UnknownMediaReason =
  | "unknown_video_codec"
  | "unknown_audio_codec"
  | "unknown_resolution"
  | "unknown_bitrate";

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
  | UnknownMediaReason
  | UrlRejectionReason;

export interface StreamMappingContext {
  /** Becomes `providerId`, and namespaces the candidate id. */
  readonly sourceId: string;
  /** The operator's declared rights. Copied onto the candidate unchanged. */
  readonly rights: ContentRights;
  readonly allowLoopback: boolean;
  /**
   * Whether this instance is a local/development deployment. Required alongside
   * `allowLoopback` before any loopback URL is reachable, and threaded here from
   * the authorized source rather than re-derived. See url-policy.ts.
   */
  readonly localDeployment: boolean;
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
  /** The addon's own `notWebReady` flag, preserved for the reason trail. */
  readonly notWebReady: boolean;
  /** The addon's display text, for logs. Never parsed for meaning. */
  readonly label: string;
}

export type StreamMappingResult =
  | { readonly ok: true; readonly mapped: MappedStream }
  | { readonly ok: false; readonly reason: StreamRejectionReason; readonly detail: string };

/**
 * What the addon actually told us about the media itself.
 *
 * Every field is optional because the Stremio protocol carries none of them, and
 * an absent field here means ABSENT -- not "assume the common case". That
 * distinction is the whole point of this type existing rather than the mapper
 * filling the contract in with defaults.
 */
export interface ObservedMedia {
  readonly videoCodec?: StreamCandidate["videoCodec"] | undefined;
  readonly audioCodec?: StreamCandidate["audioCodec"] | undefined;
  readonly height?: number | undefined;
  readonly bitrateKbps?: number | undefined;
}

/**
 * Everything the protocol lets us STATE about the media. Today: nothing.
 *
 * Separated from the refusal below so that the mapper's decision is driven by
 * what is known rather than by a constant, and so the day a probe can genuinely
 * answer one of these -- reading an HLS variant list from the delivered
 * manifest, a contract that carries container metadata -- the change is to this
 * function and the other three keep failing closed on their own.
 */
export function observeStreamMedia(stream: StremioStream): ObservedMedia {
  /*
   * The protocol has no codec, resolution or bitrate field. What it does have is
   * free-text `name`/`title` (where real addons write "1080p H.264") and
   * `behaviorHints.videoSize`, and neither is usable:
   *
   *   - the title is authored by the same party whose stream is being ranked, so
   *     reading quality out of it lets any addon promote its own streams by
   *     renaming them. Advertising is not measurement.
   *   - `videoSize` is a file size in bytes. A bitrate needs a duration, which
   *     no field carries, so the one number present would still have to be
   *     combined with an invented one.
   */
  void stream;
  return {};
}

/**
 * The contract fields that must be FACTS, checked in a fixed order.
 *
 * These were placeholders: height 480, bitrate 3600, codecs h264/aac. The pair
 * of numbers was chosen to be neutral inside media-engine's current score model,
 * which was true and beside the point -- a neutral lie is still recorded on the
 * candidate as a fact. Downstream code could no longer tell "480p at 3.6 Mbps"
 * from "we have no idea", and any future policy reading `height` outside that
 * one weighted formula -- a data-saver mode, a per-device resolution cap, an
 * analytics rollup of what viewers actually receive -- would have consumed
 * fabricated metadata without any way of noticing.
 *
 * The codec defaults were worse than merely wrong. h264/aac is not a neutral
 * guess; it is the most widely supported pair in existence, so claiming it made
 * a stream pass media-engine's capability eligibility PRECISELY BECAUSE we
 * supplied values every device accepts. That converts "we do not know whether
 * this plays here" into "we know this plays here", which is the one direction a
 * compatibility check must never be nudged.
 *
 * So an unknown field is a refusal with a name, like a torrent or a magnet link:
 * the stream produces no candidate and the reason says which fact was missing.
 *
 * DELIBERATE FOLLOW-UP, and the only acceptable way to get these candidates
 * back: `StreamCandidate` requires all four fields, so today a Stremio stream
 * cannot be represented at all and every one of them is refused. If losing them
 * turns out to be materially harmful, the fix is to change the CONTRACT so it
 * can represent unknown metadata, and to teach `@liberty/media-engine` what
 * unknown means when it ranks and when it checks device capability -- probably
 * "rank last, never claim compatible". The fix is NOT to re-derive plausible
 * values here. Unknown must arrive downstream labelled as unknown; it must never
 * be smuggled through the system wearing the shape of something we measured.
 * `@liberty/contracts` and `@liberty/media-engine` belong to other tasks, which
 * is why this adapter fails closed instead of editing them.
 */
const UNKNOWN_MEDIA_DETAIL: Record<UnknownMediaReason, string> = {
  unknown_video_codec:
    "the addon states no video codec; guessing one would decide device compatibility on our " +
    "behalf rather than report it",
  unknown_audio_codec:
    "the addon states no audio codec; guessing one would decide device compatibility on our " +
    "behalf rather than report it",
  unknown_resolution:
    "the addon states no resolution, and the resolution written in its own title text is a " +
    "claim by the party being ranked, not a measurement",
  unknown_bitrate: "the addon states no bitrate, and a file size without a duration is not one"
};

/** Every media fact the contract requires, all of them observed. */
export interface KnownMedia {
  readonly videoCodec: StreamCandidate["videoCodec"];
  readonly audioCodec: StreamCandidate["audioCodec"];
  readonly height: number;
  readonly bitrateKbps: number;
}

export type MediaResolutionResult =
  | { readonly ok: true; readonly media: KnownMedia }
  | { readonly ok: false; readonly reason: UnknownMediaReason; readonly detail: string };

/**
 * Turns observations into the facts the contract needs, or names the first one
 * we do not have.
 *
 * One reason rather than four, for the same purpose as media-engine's
 * `firstRejectionReason`: a stream reports the single most important thing wrong
 * with it. The order is the order in which the missing values matter -- codecs
 * decide whether the stream can play at all, resolution and bitrate only decide
 * how well.
 */
export function resolveStreamMedia(observed: ObservedMedia): MediaResolutionResult {
  const { videoCodec, audioCodec, height, bitrateKbps } = observed;
  const unknown = (reason: UnknownMediaReason): MediaResolutionResult => ({
    ok: false,
    reason,
    detail: UNKNOWN_MEDIA_DETAIL[reason]
  });

  if (videoCodec === undefined) return unknown("unknown_video_codec");
  if (audioCodec === undefined) return unknown("unknown_audio_codec");
  if (height === undefined) return unknown("unknown_resolution");
  if (bitrateKbps === undefined) return unknown("unknown_bitrate");

  return { ok: true, media: { videoCodec, audioCodec, height, bitrateKbps } };
}

/** Decimal places health is stored at, matching media-engine's score precision. */
const HEALTH_PRECISION = 4;

/**
 * Health from observed request outcomes, never from a hopeful constant.
 *
 * PROVISIONAL. This is an initial policy, not a validated one: it was chosen
 * because it has the right shape and the right failure behaviour, and it has not
 * been calibrated against how Stremio addons actually behave over time.
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
 *
 * SAMPLE SCOPE, which the number does not carry and a reader should not assume:
 * the counters are held in one `createStremioProvider` instance, in memory. They
 * cover only the requests THAT provider object has made to THAT source since it
 * was constructed -- manifest fetches, stream lookups and health probes, counted
 * alike and weighted alike. So the score is per-process and unshared across a
 * multi-instance deployment, it resets to 0.5 on restart or reconfiguration, and
 * it has no decay: an outage from six hours ago counts exactly as much as the
 * request that just failed. A source that has been broken all week and recovered
 * an hour ago still scores as damaged. Fixing that means a windowed or
 * time-decayed estimator over shared, persisted observations, which is a
 * different piece of work with its own storage; until then this ranks sources
 * within one process's own experience and nothing more.
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

  const checked = checkUrl(stream.url.trim(), {
    allowLoopback: context.allowLoopback,
    localDeployment: context.localDeployment
  });
  if (!checked.ok) return reject(checked.reason, checked.detail);

  const notWebReady = stream.behaviorHints?.notWebReady === true;
  if (notWebReady && !context.acceptNotWebReady) {
    return reject(
      "stream_not_web_ready",
      "addon flags the stream as not playable in a browser and this source did not opt in"
    );
  }

  /*
   * Last, because it is the least fundamental refusal: everything above says
   * this is not a thing we may play or may fetch, while this says we cannot
   * describe it honestly. See `UNKNOWN_MEDIA_DETAIL`.
   */
  const media = resolveStreamMedia(observeStreamMedia(stream));
  if (!media.ok) return reject(media.reason, media.detail);

  const url = checked.url.toString();
  const candidate: StreamCandidate = {
    id: `${context.sourceId}:${stableStreamKey(url)}`,
    providerId: context.sourceId,
    // The declared value, copied. Not derived, not defaulted, not corrected.
    rights: context.rights,
    protocol: deriveProtocol(checked.url),
    // Observed, or this stream was refused above. Never defaulted.
    height: media.media.height,
    bitrateKbps: media.media.bitrateKbps,
    estimatedLatencyMs: Math.max(0, Math.round(context.observedLatencyMs)),
    healthScore: context.healthScore,
    videoCodec: media.media.videoCodec,
    audioCodec: media.media.audioCodec
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
