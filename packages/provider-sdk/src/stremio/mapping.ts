import {
  MEDIA_FACTS,
  PLAYABLE_CONTENT_RIGHTS,
  streamCandidateSchema,
  unknownMediaFacts,
  type AudioCodec,
  type ContentRights,
  type MediaFact,
  type StreamCandidate,
  type VideoCodec
} from "@liberty/contracts";
import { compareCodePoint } from "./order";
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
 *   3. It never invents the media facts the contract carries. Codec, resolution
 *      and bitrate are emitted as `null` -- the contract's word for UNKNOWN --
 *      when the protocol does not state them, and are never re-derived from a
 *      title, a filename or a file size. See `resolveStreamMedia`.
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
  /**
   * The contract facts this stream never stated, in `MEDIA_FACTS` order.
   *
   * Read off the finished candidate with the contract's own
   * `unknownMediaFacts`, never assembled here: media-engine publishes the same
   * list on every `RankedCandidate`, and two implementations of "which facts are
   * missing" would eventually disagree about the set or the order, which would
   * surface as an adapter trail contradicting the playback trail beside it.
   */
  readonly unknownFacts: readonly MediaFact[];
}

export type StreamMappingResult =
  | { readonly ok: true; readonly mapped: MappedStream }
  | { readonly ok: false; readonly reason: StreamRejectionReason; readonly detail: string };

/**
 * Every media fact the contract carries, all of them STATED.
 *
 * The codec fields are the contract's non-nullable `VideoCodec`/`AudioCodec` and
 * NOT `StreamCandidate["videoCodec"]`. That is a correction, not a style
 * preference. When PL-0205 made those candidate fields nullable, every
 * declaration written as `StreamCandidate["videoCodec"]` silently widened to
 * include `null` -- including this one, whose entire job is to promise the
 * opposite. A type that means "we know this" must not be spelled in terms of a
 * type that means "we may or may not know this"; the field reference reads like
 * a link to the contract while actually inheriting whatever the contract's
 * uncertainty happens to be that week.
 */
export interface KnownMedia {
  readonly videoCodec: VideoCodec;
  readonly audioCodec: AudioCodec;
  readonly height: number;
  readonly bitrateKbps: number;
}

/**
 * What the addon actually told us about the media itself.
 *
 * Derived from `KnownMedia` rather than restated, so the two shapes cannot drift
 * apart and a future re-pinning of one is automatically a re-pinning of the
 * other. Every field is optional because the Stremio protocol carries none of
 * them, and an absent field means ABSENT -- not "assume the common case", and
 * NOT `null`: `null` is the contract's assertion that a producer looked and had
 * no answer, and an observation cannot make that assertion on the producer's
 * behalf. The mapped type therefore admits `undefined` and refuses `null`
 * outright, which is what stops an unknown being laundered into `KnownMedia`.
 */
export type ObservedMedia = {
  readonly [Fact in keyof KnownMedia]?: KnownMedia[Fact] | undefined;
};

/**
 * The four facts as they appear ON THE CANDIDATE: stated, or `null` for unknown.
 *
 * Taken from the contract with `Pick` rather than written out, so a fifth
 * nullable fact added to `MediaFact` becomes a compile error in this file
 * instead of a candidate field the adapter quietly stops populating.
 */
export type StreamMedia = Pick<StreamCandidate, MediaFact>;

/**
 * Everything the protocol lets us STATE about the media. Today: nothing.
 *
 * Separated from `resolveStreamMedia` so that the candidate's facts are driven
 * by what is known rather than by a constant, and so the day a probe can
 * genuinely answer one of these -- reading an HLS variant list from the
 * delivered manifest, a contract that carries container metadata -- the change
 * is to this function and the other three keep reporting unknown on their own.
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
   *   - the filename extension names a CONTAINER, not a codec. `.mp4` carries
   *     h264, hevc or av1; reading a codec off it is the same guess as reading
   *     one off the title, wearing a more technical-looking hat.
   */
  void stream;
  return {};
}

/**
 * An observation becomes a contract fact, or the contract's word for unknown.
 *
 * `null` is rejected as an INPUT here as well as by the parameter type. The
 * types are the real guarantee, but observations are the one place in this file
 * where a value can arrive from outside TypeScript's view -- a future probe
 * parsing a manifest, a JavaScript caller, a JSON fixture -- and a boundary that
 * only checks `=== undefined` treats a `null` as a stated value. That was
 * exactly the defect: `null` flowed through as though someone had measured it.
 *
 * A stated-but-INVALID observation (`height: 0`, a codec outside the enum) is
 * deliberately NOT converted to unknown. It is a broken probe, and turning it
 * into "we have no idea" would hide the break; it falls through to
 * `streamCandidateSchema` below and is reported as `candidate_failed_contract`.
 */
function stated<Fact>(observed: Fact | null | undefined): Fact | null {
  return observed === undefined || observed === null ? null : observed;
}

/**
 * Turns observations into the four facts the candidate carries.
 *
 * TOTAL -- it cannot fail, and that is the change PL-0205 bought. These fields
 * were previously placeholders (height 480, bitrate 3600, codecs h264/aac); the
 * pair of numbers was chosen to be neutral inside media-engine's score model,
 * which was true and beside the point, because a neutral lie is still recorded
 * on the candidate as a fact. The codec defaults were worse than merely wrong:
 * h264/aac is the most widely supported pair in existence, so claiming it made a
 * stream pass capability eligibility PRECISELY BECAUSE we supplied values every
 * device accepts, converting "we do not know whether this plays here" into "we
 * know this plays here".
 *
 * The placeholders were then replaced by a REFUSAL, which was honest and left
 * the adapter inert: the contract required all four fields, so a perfectly
 * playable public-domain film produced no candidate at all. `null` is now a
 * first-class value for all four, so the honest answer is representable and the
 * stream survives as a candidate that says out loud what it does not know.
 * Downstream, media-engine neither passes an unknown codec as compatible nor
 * fails a constraint it cannot measure, scores an unknown dimension zero, and
 * labels the result `unverified`.
 *
 * What is still forbidden, and always was: re-deriving any of these. No codec
 * from a file extension, no resolution from a title, no bitrate from a file
 * size, no "reasonable default". Unknown means `null`.
 */
export function resolveStreamMedia(observed: ObservedMedia): StreamMedia {
  // Type arguments stated explicitly rather than inferred: the return type of
  // this function is the difference between a fact and an unknown, and it should
  // not depend on how an inference site happens to decompose a union.
  return {
    videoCodec: stated<VideoCodec>(observed.videoCodec),
    audioCodec: stated<AudioCodec>(observed.audioCodec),
    height: stated<number>(observed.height),
    bitrateKbps: stated<number>(observed.bitrateKbps)
  };
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
 *
 * Note the boundary this stays on the right side of: `protocol` is how the bytes
 * are DELIVERED, which the URL states, while `videoCodec` is how they are
 * ENCODED, which it does not. `.m3u8` is an HLS playlist whatever is inside it;
 * `.mp4` is a container that carries h264, hevc or av1 indifferently. Reading
 * the first off the path is reading a fact; reading the second off it would be
 * the guess this file exists to refuse.
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
 * What a refused stream POINTED AT, said without quoting it back.
 *
 * A URL an addon supplied may be a magnet link, may carry a signed token or a
 * session id in its query string, and may be arbitrarily long; a reason trail
 * that echoes it verbatim reproduces all three into logs. So the URL is parsed
 * and only its scheme, host and path survive, and a non-http scheme is reduced
 * to the scheme alone -- enough to tell two streams apart, not enough to replay
 * one. Info hashes and YouTube ids are named by KIND and never reproduced at
 * all: this system does not resolve them, so it has no business recording them
 * in a form anybody could paste somewhere that does.
 */
export function streamTarget(stream: StremioStream): string {
  const raw = typeof stream.url === "string" ? stream.url.trim() : "";
  if (raw !== "") {
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "https:" || parsed.protocol === "http:"
        ? truncate(`${parsed.origin}${parsed.pathname}`, 100)
        : parsed.protocol;
    } catch {
      return "(unparseable url)";
    }
  }
  if (typeof stream.infoHash === "string" && stream.infoHash !== "") return "(info hash)";
  if (stream.fileIdx !== undefined) return "(torrent file index)";
  if (stream.sources !== undefined && stream.sources.length > 0) return "(peer sources)";
  if (typeof stream.ytId === "string" && stream.ytId !== "") return "(youtube id)";
  if (typeof stream.externalUrl === "string" && stream.externalUrl !== "") return "(external url)";
  return "(no source)";
}

/**
 * Identifies a refused stream in the trail, WITHOUT using where it sat in the
 * addon's response.
 *
 * This used to be `${sourceId}:#${index} ${label}`, and the index made the whole
 * rejection list depend on the order the addon happened to answer in: the same
 * two streams arriving the other way round produced a different trail for an
 * identical decision, so two runs of the same resolution diffed as different
 * outcomes. A stream is named by what it IS instead -- the thing it pointed at,
 * plus the addon's own display text -- which is both order-independent and more
 * useful, since "#2" only identifies a stream to someone holding that exact
 * response body.
 *
 * Two genuinely identical streams produce the same ref, and that is correct:
 * they are indistinguishable, so their rejection entries are equal objects and
 * their relative order carries no information.
 */
export function streamRef(stream: StremioStream, sourceId: string): string {
  return `${sourceId}:${streamTarget(stream)} ${streamLabel(stream)}`;
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

  const media = resolveStreamMedia(observeStreamMedia(stream));
  const url = checked.url.toString();
  const candidate: StreamCandidate = {
    id: `${context.sourceId}:${stableStreamKey(url)}`,
    providerId: context.sourceId,
    // The declared value, copied. Not derived, not defaulted, not corrected.
    rights: context.rights,
    // Delivery, read off the URL path. See `deriveProtocol` for why this is a
    // fact and the codec below is not.
    protocol: deriveProtocol(checked.url),
    // Observed or `null`. Never defaulted, never re-derived. See
    // `resolveStreamMedia`; today the Stremio protocol states none of the four,
    // so all four are `null` and the candidate travels labelled unverified.
    height: media.height,
    bitrateKbps: media.bitrateKbps,
    estimatedLatencyMs: Math.max(0, Math.round(context.observedLatencyMs)),
    healthScore: context.healthScore,
    videoCodec: media.videoCodec,
    audioCodec: media.audioCodec
  };

  /*
   * Validated against the contract before it leaves the adapter.
   *
   * Everything above is typed, so this can only fire on a value the type system
   * could not see -- an out-of-range `healthScore` from a caller-supplied
   * context, a NaN latency from a clock that went backwards, a future probe
   * reporting `height: 0`. The provider SDK is the boundary where third-party
   * data becomes internal data; a boundary that only checks its input and trusts
   * its own output is half a boundary.
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
      label: streamLabel(stream),
      unknownFacts: unknownMediaFacts(candidate)
    }
  };
}

export interface RejectedStream {
  /** Identifies the refused stream in a reason trail. See `streamRef`. */
  readonly ref: string;
  readonly reason: StreamRejectionReason;
  readonly detail: string;
}

export interface StreamMappingBatch {
  readonly mapped: MappedStream[];
  readonly rejected: RejectedStream[];
}

/**
 * Orders one media fact against the same fact on another candidate.
 *
 * `null` -- the contract's word for UNKNOWN -- sorts before every stated value,
 * so a candidate that measured nothing can never displace one that did.
 *
 * Strings terminate in `compareCodePoint`, which is the one string comparator
 * this package sorts with. Numbers do not: they are compared as quantities,
 * because `compareCodePoint` on the SPELLINGS of 1080 and 720 puts 1080 first,
 * and an order that is total while contradicting the thing it orders is a second
 * defect rather than a fix for the first.
 */
function compareStatedFact(a: string | number | null, b: string | number | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  if (typeof a === "string" && typeof b === "string") return compareCodePoint(a, b);
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  // The same fact holding a string on one candidate and a number on another is
  // not a state `streamCandidateSchema` admits. Ordered by type name anyway,
  // rather than left tied, because the whole value of this comparator is that a
  // remaining tie MEANS the two entries are equal -- and an exception to that
  // rule is how the property stops being checkable.
  return compareCodePoint(typeof a, typeof b);
}

/**
 * TOTAL order over mapped streams: a remaining tie means the two entries are
 * equal in every field, not merely in the fields it happened to look at.
 *
 * That was previously a precondition rather than a property. The comparator
 * compared `id`, `url`, `notWebReady` and `label` only, which was total ONLY
 * because `observeStreamMedia` states nothing today and so every mapped stream
 * carries the same four `null`s. The day a probe answers one of them, two
 * streams with the same URL and the same label but different observations would
 * have tied, and the survivor of a duplicate group would have become
 * arrival-dependent again -- the same defect class, one field further down.
 *
 * So the four media facts are compared too, walked through the contract's own
 * `MEDIA_FACTS` rather than listed out here, so that a fifth nullable fact is
 * one this comparator already covers rather than one it silently ignores.
 * `unknownFacts` needs no comparison of its own: it is `unknownMediaFacts` of
 * exactly these four, so equal facts are equal unknowns.
 *
 * The rest of the candidate is not compared because it cannot differ once `url`
 * is equal: `providerId`, `rights`, `estimatedLatencyMs` and `healthScore` come
 * from the shared context, and `protocol` is derived from the URL string.
 */
function compareMapped(a: MappedStream, b: MappedStream): number {
  const byId = compareCodePoint(a.candidate.id, b.candidate.id);
  if (byId !== 0) return byId;
  const byUrl = compareCodePoint(a.url, b.url);
  if (byUrl !== 0) return byUrl;
  if (a.notWebReady !== b.notWebReady) return a.notWebReady ? 1 : -1;
  const byLabel = compareCodePoint(a.label, b.label);
  if (byLabel !== 0) return byLabel;
  for (const fact of MEDIA_FACTS) {
    const byFact = compareStatedFact(a.candidate[fact], b.candidate[fact]);
    if (byFact !== 0) return byFact;
  }
  return 0;
}

/** Total order over rejections; a remaining tie means the entries are equal. */
function compareRejected(a: RejectedStream, b: RejectedStream): number {
  const byRef = compareCodePoint(a.ref, b.ref);
  if (byRef !== 0) return byRef;
  const byReason = compareCodePoint(a.reason, b.reason);
  if (byReason !== 0) return byReason;
  return compareCodePoint(a.detail, b.detail);
}

/**
 * Maps a whole `/stream` response.
 *
 * BOTH LISTS ARE SORTED, and neither preserves the addon's ordering. This is a
 * correction of a defect, not a new feature.
 *
 * The previous reading -- "re-sorting would discard the addon's own ordering
 * without adding information, and choosing between candidates is media-engine's
 * job" -- had it backwards on both halves. Preserving the addon's order does not
 * decline to rank; it ADOPTS the ranking of the party being ranked, and hands it
 * to every consumer that reads `candidates[0]` or renders the list as returned.
 * And it made the batch order-dependent: the same streams arriving in a
 * different order produced a different `mapped`, a different `rejected` and a
 * different reason trail for an identical decision, which the architecture
 * forbids outright.
 *
 * Sorting by candidate id is a CANONICAL order, not a quality order: the id is a
 * hash of the URL, so it carries no signal about which stream is better and
 * cannot smuggle an adapter-side preference into the decision. media-engine's
 * own sort is total (score, then unknown-fact count, then candidate id), so the
 * order candidates arrive in cannot influence what gets selected either way --
 * what changes is that the trail is now reproducible.
 *
 * Deduplication is by candidate id, which is the URL. Addons routinely list the
 * same file twice under different titles, and two candidates with the same id
 * would make a playback decision's rejection list ambiguous about which one was
 * refused. The survivor is the one that sorts FIRST under the same comparator
 * the output uses, not the one that arrived first: "first occurrence" is a fact
 * about the response's ordering, so keeping it would have left the surviving
 * entry's `label` and `notWebReady` -- and therefore the whole batch -- dependent
 * on that ordering again, one level down.
 *
 * DUPLICATES ARE GROUPED AND THEN DECIDED ONCE, rather than folded pairwise as
 * they arrive. Keeping the running minimum picked the same survivor and dropped
 * the same losers whichever order they came in -- that much of the old reasoning
 * held -- but it did not produce the same REJECTIONS, because each rejection's
 * `detail` named the incumbent at that moment rather than the eventual survivor.
 * Three duplicates labelled A, B and C arriving as [A,B,C] both read "duplicate
 * of A"; arriving as [B,C,A] one of them read "duplicate of B". Same input set,
 * different `StreamMappingBatch`, which is the order-dependence this file exists
 * to remove and which a two-duplicate test cannot see, since with two the
 * incumbent at rejection time is always the survivor. Deciding per GROUP makes
 * the survivor and the wording of every rejection functions of the set.
 */
export function mapStremioStreams(
  streams: readonly StremioStream[],
  context: StreamMappingContext
): StreamMappingBatch {
  const groups = new Map<string, MappedStream[]>();
  const rejected: RejectedStream[] = [];

  for (const stream of streams) {
    const result = mapStremioStream(stream, context);
    if (!result.ok) {
      rejected.push({
        ref: streamRef(stream, context.sourceId),
        reason: result.reason,
        detail: result.detail
      });
      continue;
    }

    const candidateId = result.mapped.candidate.id;
    const group = groups.get(candidateId);
    if (group === undefined) groups.set(candidateId, [result.mapped]);
    else group.push(result.mapped);
  }

  /*
   * `groups` is a Map, so both its keys and each group's contents are in ARRIVAL
   * order here, and neither survives into the result: every group is sorted
   * before anything is read off it, and both output lists are sorted below.
   * Stated rather than assumed, because "we sort it later" is exactly the
   * reasoning that failed above -- the old fold also sorted its output, and the
   * order still leaked out through the rejection wording.
   */
  const mapped: MappedStream[] = [];
  for (const [candidateId, group] of groups) {
    const ordered = [...group].sort(compareMapped);
    const survivor = ordered[0];
    // A group exists only because something was pushed into it, so this cannot
    // be empty. Guarded rather than asserted with `!`: the emptiness is a fact
    // about the loop above, and a guard keeps it true when that loop changes.
    if (survivor === undefined) continue;
    mapped.push(survivor);
    for (const dropped of ordered.slice(1)) {
      rejected.push({
        ref: `${candidateId} ${dropped.label}`,
        reason: "duplicate_stream_url",
        detail: `duplicate of ${survivor.label}, which resolves to the same URL and the same candidate id`
      });
    }
  }

  return { mapped: mapped.sort(compareMapped), rejected: rejected.sort(compareRejected) };
}
