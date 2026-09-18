import { z } from "zod";
import { audioCodecSchema, videoCodecSchema } from "../shared/codecs";
import { contentProtectionSchema, type ContentProtection } from "../shared/drm";
import { MEDIA_FACTS, type MediaFact } from "../shared/media-facts";
import { contentRightsSchema } from "../shared/rights";

/* -------------------------------------------------------------------------
 * Playback resolution (PL-0201 / PL-0205)
 *
 * What a provider may offer, what a device can decode, and the request that
 * asks the media engine to pick between them. Imports the shared vocabularies
 * directly; nothing here reaches through the barrel.
 * ---------------------------------------------------------------------- */

/**
 * `null` means UNKNOWN, and it is the only thing that means unknown.
 *
 * The four `MEDIA_FACTS` are `.nullable()` and stay REQUIRED. Three
 * representations were available and only one of them is safe:
 *
 *   - `.optional()` -- rejected. An omitted key is indistinguishable from a key
 *     the writer forgot or a producer that predates this change, so every read
 *     site would get `undefined` for both "we do not know" and "nobody told me
 *     to send this". Unknown has to be ASSERTED, not achieved by silence.
 *   - a sentinel value (`height: 0`, `videoCodec: "unknown"`) -- rejected. A
 *     sentinel is a number in a numeric field and a codec in a codec field, so
 *     it survives arithmetic, comparison and serialization without ever failing.
 *     That is exactly how a fabricated fact travels undetected, which is the
 *     thing this task exists to prevent.
 *   - `.nullable()` and required -- chosen. `null` is not a height, not a
 *     bitrate and not a codec, so nothing coerces it into one: under `strict`,
 *     `candidate.height > maxHeight` and `codecs.includes(candidate.videoCodec)`
 *     stop compiling, which forces every existing read site to decide what
 *     unknown means for it rather than silently inheriting an answer.
 *
 * Required-and-nullable also keeps the validator honest rather than leaving a
 * hole: `{ ..., "height": null }` parses, an omitted `height` does not. A
 * producer that cannot measure a field must say so out loud.
 *
 * This mirrors the catalog union in `./catalog`, where `runtimeMinutes` and
 * `episodeCount` are explicitly `null` rather than absent, for the same reason:
 * "does not apply" and "was not sent" are different claims and the resolver
 * needs to tell them apart.
 */
/* -------------------------------------------------------------------------
 * Length bounds on the candidate's identifiers (PL-0708, register entry F11)
 *
 * MEASURED, not hypothesised. `docs/SECURITY_REVIEW_PROVIDER_URL.md` F11: a
 * request carrying one candidate with a 1,000,000-character `id` produced a
 * 2,002,555-byte response. Both fields were `z.string().min(1)` with no upper
 * bound and no charset restriction.
 *
 * WHY THE BOUND IS HERE AND NOT AT A ROUTE. Every consumer of a candidate
 * inherits it from the contract; a per-route cap is one route away from being
 * forgotten, and it would leave the contract still ACCEPTING the value. The
 * defect that argument describes is real and currently live one layer up --
 * `apps/web`'s `playbackSessionCandidateSchema` restates `id` and `providerId`
 * as `z.string().min(1)` of its own rather than deriving them -- which is why
 * the limits below are EXPORTED. A consumer computes its budget from them. A
 * consumer that retypes the number is the same defect wearing a second schema.
 *
 * WHERE THE AMPLIFICATION COMES FROM, corrected against F11's wording. F11
 * attributes the 2x to the id appearing "in both the ranked entry and the
 * reason trail". The mechanism is slightly different, and the accurate version
 * is what sizes a budget: `packages/media-engine/src/ranking.ts` returns
 * `{ selected, ranked, rejected }` where `selected = ranked[0] ?? null` is the
 * SAME object serialized a second time. So an ELIGIBLE candidate costs 2x --
 * `ranked[i].candidate`, plus `selected.candidate` for the winner -- while an
 * INELIGIBLE one costs 1x, contributing only `rejected[i].candidateId`, an id
 * rather than a candidate. F11's measurement stands; 2x is the ceiling.
 *
 * A REJECTED CANDIDATE IS NEVER A SILENT DROP, which is the risk this task was
 * told to carry and not to introduce. Every point that enforces this schema
 * already names the field and the limit:
 *
 *   - `provider-sdk/src/stremio/mapping.ts` `safeParse`s each mapped candidate
 *     and turns a failure into `candidate_failed_contract` carrying the
 *     formatted issues, so the reason trail says which field and which limit.
 *   - `apps/web/.../playback/resolve/handler.ts` returns HTTP 400
 *     `{ error: "invalid_request", issues }`, naming `candidates.<i>.id`.
 *   - `provider-sdk/src/fixture/provider.ts` builds typed literals and never
 *     parses, so a bound cannot drop a fixture candidate at all.
 *
 * And the refusal does not itself amplify: Zod's `too_big` issue carries the
 * LIMIT and the path, never the received value, so the 1,000,000-character id
 * above yields a 180-byte refusal. That is asserted in the example suite rather
 * than assumed, because it is a property of a dependency this package does not
 * own.
 * ---------------------------------------------------------------------- */

/**
 * The longest `providerId` a candidate may carry: **64 characters**.
 *
 * Not a round number chosen for comfort -- it is the bound this repository's
 * two producers of the value ALREADY enforce, adopted so the contract cannot
 * refuse an id either of them can mint:
 *
 *   - `provider-sdk/src/stremio/source.ts`  `SOURCE_ID_PATTERN  = /^[a-z0-9][a-z0-9._-]{0,63}$/i`
 *   - `provider-sdk/src/fixture/provider.ts` `FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i`
 *
 * Both are one leading character plus 63, and `providerId` is exactly these
 * values: the Stremio mapper assigns `providerId: context.sourceId` and the
 * fixture provider assigns its configured id.
 *
 * What the longest LEGITIMATE value actually looks like, measured in this tree:
 * `"public-domain-archive"` (21), `"local-library"` (13), `"stremio-a"` (9),
 * `"wikidata"` (8), `"fixture"` (7). So 64 is roughly three times the longest
 * real one and is still the figure a producer would refuse above.
 */
export const MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS = 64;

/**
 * The longest candidate `id`: **141 characters**, and every term is derived.
 *
 * A candidate id is composed, never free-form, and there are exactly two
 * producers. The bound is the larger composition, computed from the segment
 * bounds that already exist rather than picked:
 *
 *   STREMIO -- `provider-sdk/src/stremio/mapping.ts`: `${sourceId}:${stableStreamKey(url)}`
 *     where `stableStreamKey` is FNV-1a 32-bit rendered `padStart(8, "0")`.
 *       64 (source id, above) + 1 (":") + 8 (hex key)                    =  73
 *
 *   FIXTURE -- `provider-sdk/src/fixture/provider.ts`: `${contentId}-${variant.key}`
 *     where `contentId` is a normalized content id, minted only by
 *     `catalog-ingestion/src/identity.ts` as `${source}-${native}`, and the
 *     variant keys are `progressive` / `hls` / `dash`.
 *       64 (source segment -- the same source id, normalized)
 *     +  1 ("-")
 *     + 64 (provider-native segment: a third-party-issued identifier such as a
 *           Wikidata QID. Given the same allowance as the source id, because
 *           there is no principled reason to hold an id issued BY an authority
 *           tighter than the id OF the authority, and `normalizedContentIdSchema`
 *           in `../shared/ids` states no length rule of its own -- it is the one
 *           unbounded term in the chain and this is where it gets bounded.)
 *     +  1 ("-")
 *     + 11 ("progressive", the longest variant key)                      = 141
 *
 * 141 = max(73, 141). What the longest legitimate value actually looks like,
 * measured in this tree: `"big-buck-bunny-progressive"` (26),
 * `"wikidata-q83495-progressive"` (27, from the real QID in
 * `catalog-ingestion/src/wikidata.ts`), `"aurora-fall-progressive"` (23). So the
 * bound is about five times the longest id this platform has ever emitted, and
 * still cannot refuse one either adapter is capable of emitting -- including a
 * ten-digit QID, which Wikidata has not reached.
 */
export const MAX_STREAM_CANDIDATE_ID_CHARS = 141;

/**
 * The most bytes one schema-accepted candidate can serialize to: **1489**.
 *
 * THE RESPONSE BUDGET, stated where every consumer can derive from it instead
 * of guessing. A route multiplies this by its own candidate cap (the resolve
 * scaffold's is 100) and by the 2x above; it does not invent a second number.
 *
 * Exact, and reconstructed by the example suite so the literal cannot drift
 * from the arithmetic. Worst case, in UTF-8 bytes of `JSON.stringify`:
 *
 *     171  structure: braces, the ten keys, quotes, commas, and the longest
 *          member of each vocabulary ("public-domain", "https", "hevc", "eac3")
 *     846  id          141 units x 6
 *     384  providerId   64 units x 6
 *      16  height       Number.MAX_SAFE_INTEGER, the ceiling of `.int()`
 *      72  the three remaining numbers, 24 each
 *    ----
 *    1489
 *
 * The 6 is not padding: a UTF-16 unit costs at most 6 UTF-8 bytes once
 * JSON-escaped -- a control character or a lone surrogate becomes `\u0000`,
 * six ASCII bytes -- and Zod's `.max()` counts UTF-16 units, so a 141-unit id
 * of control characters is accepted and serializes to 846 bytes. An ASCII id
 * costs 1 byte per unit; bounding against the readable case would understate
 * the budget six-fold. The 24 is the longest `JSON.stringify` rendering of a
 * finite double (e.g. `0.0000034017905570227214`).
 *
 * Scoped to `streamCandidateSchema`. `resolvedStreamCandidateSchema` adds
 * `protection` on top of this and is not covered by the figure.
 */
export const MAX_STREAM_CANDIDATE_JSON_BYTES = 1489;

export const streamCandidateSchema = z.object({
  /** Bounded: see `MAX_STREAM_CANDIDATE_ID_CHARS` for what 141 is computed from. */
  id: z.string().min(1).max(MAX_STREAM_CANDIDATE_ID_CHARS),
  /** Bounded: see `MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS`. */
  providerId: z.string().min(1).max(MAX_STREAM_CANDIDATE_PROVIDER_ID_CHARS),
  rights: contentRightsSchema,
  protocol: z.enum(["https", "hls", "dash"]),
  /** `null` = no resolution was stated. Never a guess, never a placeholder. */
  height: z.number().int().positive().nullable(),
  /** `null` = no bitrate was stated. A file size without a duration is not one. */
  bitrateKbps: z.number().positive().nullable(),
  estimatedLatencyMs: z.number().nonnegative(),
  healthScore: z.number().min(0).max(1),
  /**
   * `null` = UNVERIFIED, which is not the same as unsupported. A device that
   * cannot decode `vp9` rejects a stated `vp9`; a stream that states nothing has
   * not been shown to decode OR to fail, and the media engine must keep those
   * two outcomes apart.
   */
  videoCodec: videoCodecSchema.nullable(),
  audioCodec: audioCodecSchema.nullable()
});

export type StreamCandidate = z.infer<typeof streamCandidateSchema>;

/**
 * Which media facts this candidate did not state, in `MEDIA_FACTS` order.
 *
 * Lives beside the representation rather than inside the media engine because
 * every consumer needs the same answer: an adapter labelling what it could not
 * observe, an API response explaining a ranking, a future data-saver policy
 * deciding it has nothing to act on. A second implementation elsewhere would
 * eventually disagree about which fields count or what order they come in, and
 * the disagreement would surface as two reason trails that contradict each
 * other.
 *
 * The representation is `StreamCandidate`, so this function belongs to the
 * playback domain rather than to `shared/media-facts`: the shared module owns
 * the NAMES of the facts and their order, which several domains and both
 * downstream packages spell out, while reading them off a candidate is a
 * playback operation. Putting it in `shared/` would force `shared/` to import a
 * domain, which is the one direction the module boundary forbids.
 *
 * Takes only the four fields, so a caller can ask about a half-built candidate
 * without first having to invent the rest of one.
 */
export function unknownMediaFacts(candidate: Pick<StreamCandidate, MediaFact>): MediaFact[] {
  return MEDIA_FACTS.filter((fact) => candidate[fact] === null);
}

/* -------------------------------------------------------------------------
 * Content protection on the resolved candidate (PL-0902)
 * ---------------------------------------------------------------------- */

/**
 * A candidate AS RESOLVED FOR PLAYBACK: everything the ranker scores, plus the
 * one capability fact the ranker must not see and the player cannot do without.
 *
 * WHY THIS IS A SEPARATE SCHEMA AND NOT A FIELD ON `streamCandidateSchema`.
 * This is the question `control/tasks.json` told PL-0902 to settle before
 * writing anything, so the answer is recorded here rather than in a commit
 * message.
 *
 * `streamCandidateSchema` is the RANKER'S INPUT. It is what
 * `playbackResolveRequestSchema` carries and what `rankStreamCandidates` takes,
 * and ranking has no use for a key system: `docs/DESKTOP_PLAYBACK.md` §4 rules
 * that a desktop client reports the UNION of both engines' capabilities and
 * that per-candidate routing decides afterwards, explicitly accepting that
 * "ranking may prefer a candidate only one of the two adapters can play". So a
 * protection field on the scored candidate would be a field the scorer can
 * read and must not act on -- and the first score component that discounted
 * protected candidates would be a second opinion about routing, living in the
 * one component §4 says must not hold one ("It does not rank").
 *
 * `ResolvedStreamCandidate` is the PLAYER'S INPUT. It is what a provider
 * adapter has finished producing, what a playback session publishes, and what
 * `PlayerAdapter.canPlay` reads -- `PlaybackCandidate` in
 * `docs/DESKTOP_PLAYBACK.md` §3 is this shape once PL-0501 composes the
 * playable address onto it.
 *
 * THE `uri` ARGUMENT, AND HOW FAR IT REACHES. `packages/provider-sdk/src/fixture/provider.ts`
 * keeps the playable address off `StreamCandidate` and on a separate
 * `FixtureCandidate`, because "the candidate is metadata a ranker scores, and
 * this is the address a player is eventually handed", so `@liberty/media-engine`
 * "could not read `uri` even by accident" -- and because that seam is where a
 * short-lived playback credential would eventually be minted. `apps/web`'s
 * `playbackSessionCandidateSchema` makes the same split on the wire.
 *
 * That argument is NOT candidate-versus-session. It is ranker-input versus
 * player-input, and both halves of a protection descriptor are player-input:
 *
 *   - the LICENCE ENDPOINT is an address in exactly `uri`'s class -- it may be
 *     signed, it may be per-session, and only the boundary that owns the origin
 *     can produce one -- so it follows `uri` away from the scored candidate;
 *   - the KEY SYSTEM is not an address at all. It is a stable capability fact
 *     about the bytes, of the same kind as `protocol` and `videoCodec`, settled
 *     at resolution time and never a credential. Nothing about the `uri`
 *     argument excludes it from a candidate. What excludes it from the SCORED
 *     candidate is the paragraph above; here, on the resolved candidate, it is
 *     exactly where `canPlay` needs it.
 *
 * So: on the candidate, on the one the session publishes, and the session
 * restates it verbatim rather than deriving a second opinion -- see
 * `StatesContentProtection`.
 *
 * ADDING IT BREAKS NO EXISTING CANDIDATE. `streamCandidateSchema` is untouched,
 * so every producer, every ranking property and every fixture keeps its current
 * meaning; a candidate that states no protection is still a valid thing to RANK
 * and is not a valid thing to PLAY, which is the distinction the two schemas
 * exist to draw.
 *
 * `protection` is REQUIRED. Not `.optional()`, not `.default({ state: "clear" })`.
 * A default would make the absence of the field mean "unencrypted", which is
 * precisely the reading `docs/DESKTOP_PLAYBACK.md` §4 identifies as the one-word
 * mistake that produces an invariant-2 incident; `.optional()` would make
 * unknown reachable by silence, which is what `unknownMediaFacts`' whole
 * required-and-nullable argument above exists to prevent. A producer with
 * nothing to say states `PROTECTION_NOT_STATED` out loud.
 */
export const resolvedStreamCandidateSchema = streamCandidateSchema.extend({
  protection: contentProtectionSchema
});

export type ResolvedStreamCandidate = z.infer<typeof resolvedStreamCandidateSchema>;

/**
 * `true` when `Shape` states a content-protection requirement, else `never`.
 *
 * The mechanical half of "the session restates it". PL-0501 owns the wire shape
 * of the playback session and this module cannot reach it, so the obligation is
 * published as a type a consumer can pin:
 *
 * ```ts
 * const SESSION_CANDIDATE_STATES_PROTECTION: StatesContentProtection<PlaybackSessionCandidate> = true;
 * ```
 *
 * which stops compiling the moment the field is dropped or renamed. This is the
 * inverse of `domains/live.ts`'s `CarriesNoPlayability`, which pins the same
 * kind of obligation in the other direction -- there, that a listing must NOT
 * grow a playability-bearing key. A rule about a shape that is checked by review
 * is a rule that holds until somebody is in a hurry.
 *
 * Deliberately structural rather than `ResolvedStreamCandidate`-shaped: the
 * session publishes a NARROWER projection than the resolved candidate (today
 * `id`, `providerId`, `uri`, `mimeType`, `compatibility`), and requiring it to
 * carry `rights`, `healthScore` and `estimatedLatencyMs` in order to state a key
 * system would push the ranker's internal signals onto the wire.
 */
export type StatesContentProtection<Shape> = Shape extends {
  readonly protection: ContentProtection;
}
  ? true
  : never;

/**
 * Whether a decision has ESTABLISHED that the device can decode what it is
 * about to play.
 *
 * `unverified` is not a weaker `verified`. It says the candidate was allowed
 * through because nothing disqualified it, not because anything qualified it --
 * so a player should expect a decode failure to be a normal outcome here rather
 * than a defect, and a failover policy should not read the first error as
 * evidence that the provider is unhealthy. Without this label on the output, a
 * successful selection is indistinguishable from a verified one and both of
 * those behaviours are impossible to get right.
 *
 * Deliberately two values, not a number. A confidence score invites arithmetic,
 * and there is nothing here to average: either the facts that decide
 * compatibility were stated or they were not.
 */
export const compatibilityConfidenceSchema = z.enum(["verified", "unverified"]);
export type CompatibilityConfidence = z.infer<typeof compatibilityConfidenceSchema>;

export const playbackCapabilitiesSchema = z.object({
  maxHeight: z.number().int().positive(),
  supportedVideoCodecs: z.array(videoCodecSchema).min(1),
  supportedAudioCodecs: z.array(audioCodecSchema).min(1),
  /** Ordered, most-preferred first. Order is meaningful, not a set. */
  preferredAudioLanguages: z.array(z.string()).default([]),
  /**
   * Optional, and deliberately so: absent means "no channel constraint known",
   * not "stereo". A device that has not told us its layout should not be
   * silently downmixed, and `.optional()` rather than `.default(2)` also keeps
   * every existing caller constructing this type without change.
   */
  maxAudioChannels: z.number().int().min(1).max(16).optional()
});

export type PlaybackCapabilities = z.infer<typeof playbackCapabilitiesSchema>;

export const playbackResolveRequestSchema = z.object({
  contentId: z.string().min(1),
  capabilities: playbackCapabilitiesSchema,
  candidates: z.array(streamCandidateSchema).min(1)
});

export type PlaybackResolveRequest = z.infer<typeof playbackResolveRequestSchema>;
