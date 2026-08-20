import type { AudioCodec, VideoCodec } from "@liberty/contracts/shared/codecs";
import type { EgressPolicy, EgressRejectionReason, HostClassifier } from "./egress";

/* -------------------------------------------------------------------------
 * What media inspection returns, and what each value is allowed to mean.
 *
 * The whole package answers one question: what did the PUBLISHER declare about
 * this presentation, in a machine-readable document, without opening a single
 * media segment. Everything below is shaped so that the answer cannot be
 * confused with a different kind of answer.
 * ---------------------------------------------------------------------- */

export type ManifestFormat = "hls" | "dash";

/**
 * The epistemic state of a fact, and the whole point of this package.
 *
 * `gpt-architect` asked for probed facts to be distinguishable from
 * provider-stated ones. A manifest declaration is neither: it is a THIRD state.
 * The publisher said so, in a document whose grammar is specified and whose
 * contents we read ourselves -- stronger than a provider repeating a claim
 * out-of-band in a catalogue response, weaker than measuring the bytes. Folding
 * it into either neighbour would lose a real distinction:
 *
 *   - collapsed into `provider_declared`, a correct manifest would be discounted
 *     to the level of an aggregator's guess;
 *   - collapsed into `probe`, a publisher's MISDECLARATION would be recorded as
 *     something we observed, which is the exact defect this project keeps
 *     rejecting elsewhere -- a proxy labelled as truth.
 *
 * The values are named for the ACT that produced the fact, not for the component
 * that reported it, so `probe` slots in when the FFmpeg path lands without any
 * of these three being redefined and without any consumer's switch changing
 * meaning. `FACT_SOURCE_STRENGTH` in `provenance.ts` is the only place the
 * ordering between them is written down.
 */
export type FactSource = "provider_declared" | "manifest_declared" | "probe";

/**
 * Provenance for one fact.
 *
 * `observedAt` timestamps WHEN WE READ IT, not when the publisher wrote it --
 * nothing in a manifest says the latter, and a field that looks like a
 * publication time but is a fetch time is worse than no field. It is the
 * inspection's own clock, taken once per inspection so that every fact from one
 * manifest shares an instant and two facts can never appear to disagree about
 * when a single read happened.
 *
 * `detail` names the exact declaration the value came from -- the tag and
 * attribute for HLS, the element and attribute for DASH, including WHICH element
 * when DASH allows a value to be inherited. It is a vocabulary term, never a
 * URL and never publisher-authored text.
 */
export interface FactEvidence {
  readonly source: FactSource;
  readonly observedAt: string;
  readonly detail: string;
}

/**
 * The facts this package reports, in the canonical order every derived list is
 * produced by filtering. Following `@liberty/contracts`'s `MEDIA_FACTS`: codecs
 * decide whether a stream can play at all, geometry and bitrate only decide how
 * well.
 *
 * WHY THIS SET AND NOT A LARGER ONE. Every fact here is expressible in BOTH
 * manifest formats. That buys a property worth more than the extra fields it
 * costs: a `null` in this shape always means "this publisher did not declare
 * it", and never "this format cannot say it". HLS `AVERAGE-BANDWIDTH` is the
 * field that was dropped to keep that true -- DASH has no equivalent, so
 * including it would have made every DASH rendition report an unknown that was
 * really a format limitation, and a consumer cannot tell those apart from the
 * outside.
 *
 * The names deliberately match `@liberty/contracts`'s vocabulary where the two
 * overlap (`videoCodec`, `audioCodec`, `height`), so mapping a rendition onto a
 * `StreamCandidate` is a rename-free operation for the fields that exist there.
 */
export const INSPECTED_FACTS = [
  "videoCodec",
  "audioCodec",
  "width",
  "height",
  "frameRate",
  "bandwidthBps"
] as const;

export type InspectedFact = (typeof INSPECTED_FACTS)[number];

/**
 * Evidence keyed by fact, present for exactly the facts that carry a value.
 *
 * Keyed rather than a list because that is the shape the architect specified
 * (`{ videoCodec: "hevc", mediaEvidence: { videoCodec: { source, observedAt } } }`)
 * and because a consumer holding a fact name wants a lookup, not a scan. Keys
 * are always inserted in `INSPECTED_FACTS` order, so a serialised rendition is
 * byte-stable.
 *
 * Absence here is never the only signal that a fact is unknown: `unknownFacts`
 * states it positively. Two representations of the same thing is deliberate --
 * "no key" and "listed as unknown" are easy to conflate with "we forgot to
 * record evidence", and the explicit list is what a reason trail can print.
 */
export type RenditionEvidence = Readonly<Partial<Record<InspectedFact, FactEvidence>>>;

/**
 * What a rendition is, as the format declares it -- not as we deduce it.
 *
 * `multiplexed` is what an HLS `#EXT-X-STREAM-INF` MEANS: the tag describes a
 * whole presentation, so calling it multiplexed is reading the format, not
 * inferring from content. DASH separates tracks into `AdaptationSet`s, so the
 * kind comes from `@contentType` or `@mimeType` when either is declared and is
 * `unknown` when neither is. It is never derived from the codec string, and
 * never from a file extension.
 */
export type RenditionKind = "multiplexed" | "video" | "audio" | "text" | "unknown";

/**
 * The verdict on a URI a MANIFEST supplied.
 *
 * `allowed: true` is deliberately not a clearance to fetch. For HLS and DASH the
 * input is second-order -- whoever controls the manifest controls every URL a
 * follow-up would open -- so a variant URI is untrusted input that has passed
 * only the checks available without a network round trip: scheme, credentials,
 * host literal class, egress allowlist. It has NOT been resolved, and a DNS
 * answer taken now would not be the answer taken at fetch time anyway. A caller
 * that fetches one must put it through `authoriseFetchTarget` at that moment.
 * The field is named for that obligation so it cannot be read as a clearance by
 * someone skimming the type.
 */
export type UriVerdict =
  | { readonly allowed: true; readonly obligation: "revalidate_before_fetch" }
  | { readonly allowed: false; readonly reason: EgressRejectionReason | "not_evaluated" };

/**
 * Where a rendition's media lives, as a union rather than a nullable string,
 * because the three cases mean genuinely different things and a `null` would
 * flatten them into one unanswerable question.
 *
 *   - `declared`   HLS gave a variant playlist URI. `resolvedUrl` is absolute
 *                  against the FINAL manifest URL (post-redirect, per RFC 8216)
 *                  and is populated only when the verdict allows it, so an
 *                  unvetted URL is never handed out in a usable form.
 *   - `not_declared`   a variant whose URI we could not read. NOT PRODUCED BY
 *                  THE PARSER WE SHIP, and the correction is worth writing down
 *                  because the obvious reading is wrong: `m3u8-parser` appends a
 *                  playlist entry only when it sees a URI line, so a
 *                  `#EXT-X-STREAM-INF` with nothing after it produces no entry
 *                  at all rather than an entry with a missing URI. The member is
 *                  kept as the total answer for a parser that reports the tag
 *                  and the missing URI separately, so that swapping or upgrading
 *                  the library is a behaviour change rather than a type change
 *                  that reaches every consumer. See `locationFor` in `hls.ts`.
 *   - `not_applicable`  DASH. A refusal, not an absence: segment URLs in an MPD
 *                  are CONSTRUCTED from `BaseURL`, `SegmentTemplate` and
 *                  `$Number$`/`$Time$` substitution, and doing that construction
 *                  would make this package a generator of attacker-shaped URLs
 *                  on an attacker's behalf. It is player work. We decline it, so
 *                  no DASH-declared URL is ever emitted at all.
 */
export type RenditionLocation =
  | {
      readonly kind: "declared";
      readonly declaredUri: string;
      readonly resolvedUrl: string | null;
      readonly verdict: UriVerdict;
    }
  | { readonly kind: "not_declared" }
  | { readonly kind: "not_applicable" };

/**
 * One rung of the declared ladder.
 *
 * NORMALISED AND RAW CODECS ARE BOTH KEPT. `videoCodec` is the
 * `@liberty/contracts` vocabulary value, which is what the media engine ranks
 * on; `videoCodecDeclared` is the RFC 6381 identifier exactly as written. The
 * raw string is not debug residue -- it carries the profile and level
 * (`avc1.640028` is High@4.0), which the enum cannot express and a future
 * capability check will need. When the identifier is outside the vocabulary, or
 * ambiguous, the normalised field is `null` and the raw one still says what was
 * declared: an unrecognised codec is an unknown codec, never a guess.
 *
 * `unreadableDeclarations` names attributes that were PRESENT but whose value
 * could not be read as the type the format requires -- `BANDWIDTH="fast"`,
 * `@height="-1"`, `@frameRate="30/0"`. Those facts come back `null` like any
 * other unknown, because a nonsensical declaration is not a fact; the list is
 * what keeps that from being indistinguishable from silence, which matters
 * because one is a broken publisher and the other is a terse one.
 */
export interface DeclaredRendition {
  readonly kind: RenditionKind;
  readonly location: RenditionLocation;
  readonly videoCodec: VideoCodec | null;
  readonly videoCodecDeclared: string | null;
  readonly audioCodec: AudioCodec | null;
  readonly audioCodecDeclared: string | null;
  /**
   * RFC 6381 identifiers in neither family, in declared order -- timed text and
   * anything unregistered. Kept so that a text rendition which declared a codec
   * is not reported as having declared nothing. See `codecs.ts`.
   */
  readonly otherCodecsDeclared: readonly string[];
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly bandwidthBps: number | null;
  /** The complement of `mediaEvidence`'s keys, in `INSPECTED_FACTS` order. */
  readonly unknownFacts: readonly InspectedFact[];
  /** Attribute names, sorted, deduplicated. See the type doc above. */
  readonly unreadableDeclarations: readonly string[];
  readonly mediaEvidence: RenditionEvidence;
}

/**
 * What a parser needs beyond the manifest text.
 *
 * `egress` and `classifyHost` are nullable TOGETHER and only so that the
 * parsers stay callable as pure functions in a test or a batch reprocessing job
 * with no policy configured. When either is absent every declared URI is
 * reported with a `not_evaluated` verdict and no `resolvedUrl` -- the parser
 * never falls back to emitting an unchecked URL, because a URL that reads as
 * usable is the thing a caller will use.
 *
 * `baseUrl` must be the FINAL manifest URL after redirects, per RFC 8216 §4:
 * relative variant URIs resolve against where the playlist actually came from,
 * not against where it was requested. Resolving against the pre-redirect URL is
 * a correctness bug that only shows up on redirecting CDNs.
 */
export interface ManifestParseContext {
  readonly observedAt: string;
  readonly baseUrl: string | null;
  readonly egress: EgressPolicy | null;
  readonly classifyHost: HostClassifier | null;
  /**
   * The largest DECLARED ladder a parser will build.
   *
   * A LIMIT ON WORK, WHICH IS WHY IT IS HERE AND NOT APPLIED TO THE RESULT. Both
   * parsers refuse as soon as the declared count is known -- once the playlist
   * list is in hand for HLS, once the `Representation` elements are counted for
   * DASH -- and before the first rung is constructed or the ladder is sorted.
   * That ordering is the whole point: `compareRenditions` stringifies several
   * fields per comparison, so sorting a ladder of tens of thousands of
   * publisher-declared renditions is millions of `JSON.stringify` calls, and
   * nothing bounds it in time (the fetch deadline in `http.ts` is cleared before
   * parsing begins). Capping the returned ladder instead would bound only the
   * output, which was never the expensive part.
   *
   * Required, with no default, for the same reason `InspectionOptions` has no
   * optional fields: a hidden default is a policy nobody reviewed.
   */
  readonly maxRenditions: number;
}

export interface ParsedLadder {
  readonly renditions: readonly DeclaredRendition[];
  readonly reasons: readonly InspectionReason[];
}

export type InspectionReasonCode =
  // Refusals this service made.
  | "authorization_expired"
  | "response_too_large"
  | "too_many_redirects"
  | "too_many_renditions"
  | EgressRejectionReason
  // The publisher or the network failed us.
  | "timeout"
  | "network_error"
  | "http_status"
  | "redirect_without_location"
  | "unrecognised_manifest_format"
  | "manifest_unparseable"
  // Successful inspections still carry a reason. See `InspectionResult`.
  | "ladder_read_from_manifest"
  | "media_playlist_declares_no_ladder"
  | "no_renditions_declared";

/** `detail` never contains a URL's path, query or fragment. See `egress.ts`. */
export interface InspectionReason {
  readonly code: InspectionReasonCode;
  readonly detail: string;
}

/**
 * The result, as a discriminated union on outcome with `reasons` on EVERY
 * branch -- including the successful one.
 *
 * The same shape PL-0501 is specified with, for the same reason: an outcome with
 * no reason trail violates product invariant 4 whether it succeeded or failed,
 * and an optional `reasons` field is one that consumers learn to ignore. A
 * successful inspection of a manifest that declared nothing is a real and
 * confusing outcome, and it is the one the trail has to explain.
 *
 * `refused` and `unavailable` are split on WHO decided. `refused` means this
 * service declined -- a policy the operator can change. `unavailable` means the
 * publisher or the network did not deliver -- retrying might work. Collapsing
 * them sends whoever reads the trail to the wrong system.
 */
export type InspectionResult =
  | {
      readonly outcome: "inspected";
      readonly observedAt: string;
      readonly format: ManifestFormat;
      readonly renditions: readonly DeclaredRendition[];
      readonly reasons: readonly InspectionReason[];
    }
  | {
      readonly outcome: "refused";
      readonly observedAt: string;
      readonly format: ManifestFormat | null;
      readonly reasons: readonly InspectionReason[];
    }
  | {
      readonly outcome: "unavailable";
      readonly observedAt: string;
      readonly format: ManifestFormat | null;
      readonly reasons: readonly InspectionReason[];
    };
