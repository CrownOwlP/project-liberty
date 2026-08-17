import { z } from "zod";
export * from "./search";

export const contentRightsSchema = z.enum(["licensed", "owned", "public-domain"]);
export type ContentRights = z.infer<typeof contentRightsSchema>;

export const videoCodecSchema = z.enum(["h264", "hevc", "av1", "vp9"]);
export const audioCodecSchema = z.enum(["aac", "ac3", "eac3", "opus"]);

/**
 * The KNOWN codec values, exported as named types (PL-0205).
 *
 * `StreamCandidate["videoCodec"]` is no longer usable as "a codec": it now
 * includes `null`. Code that genuinely needs a real codec -- a lookup table
 * keyed by codec, a decoder capability map -- must say so, and `Record<K, V>`
 * will not even accept `null` as a key. Naming the non-null types keeps those
 * call sites expressing the right thing instead of reaching for `NonNullable<>`
 * around a field reference.
 */
export type VideoCodec = z.infer<typeof videoCodecSchema>;
export type AudioCodec = z.infer<typeof audioCodecSchema>;

/**
 * The four candidate fields a provider may genuinely be unable to state.
 *
 * Named as a first-class enum rather than left implicit in the candidate shape,
 * because a reason trail has to say WHICH fact was missing, not merely that
 * something was. "Ranked lower because the codec was never stated" and "ranked
 * lower because the bitrate was never stated" send a reader to different
 * systems.
 *
 * The order is the order in which a missing value matters, and it matches the
 * order the Stremio adapter reports its refusals in: codecs decide whether a
 * stream can play at all, resolution and bitrate only decide how well. Every
 * derived list is produced by filtering this constant, so two subsystems can
 * never disagree about the order and no published list depends on the order an
 * object literal happened to be written in.
 */
export const mediaFactSchema = z.enum(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
export type MediaFact = z.infer<typeof mediaFactSchema>;

export const MEDIA_FACTS: readonly MediaFact[] = [
  "videoCodec",
  "audioCodec",
  "height",
  "bitrateKbps"
];

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
 * This mirrors the catalog union below, where `runtimeMinutes`/`episodeCount`
 * are explicitly `null` rather than absent, for the same reason: "does not
 * apply" and "was not sent" are different claims and the resolver needs to tell
 * them apart.
 */
export const streamCandidateSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
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
 * Takes only the four fields, so a caller can ask about a half-built candidate
 * without first having to invent the rest of one.
 */
export function unknownMediaFacts(candidate: Pick<StreamCandidate, MediaFact>): MediaFact[] {
  return MEDIA_FACTS.filter((fact) => candidate[fact] === null);
}

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

/**
 * What an audio track is FOR, which is not the same as what it sounds like.
 *
 * Role is a first-class field rather than something inferred from the track
 * title, because titles are provider-authored free text and the difference
 * between a main mix and a director's commentary is not a stylistic detail --
 * selecting commentary by accident is one of the more jarring failures a player
 * can produce. `original` marks the language the work was produced in, which is
 * the correct fallback when none of the viewer's preferred languages exist.
 */
export const audioRoleSchema = z.enum([
  "main",
  "original",
  "dub",
  "descriptive",
  "commentary"
]);
export type AudioRole = z.infer<typeof audioRoleSchema>;

export const audioTrackSchema = z.object({
  id: z.string().min(1),
  /**
   * BCP-47-ish. Normalised to lower case so "en-US" and "en-us" cannot become
   * two different languages; matching is on the primary subtag, so a viewer who
   * asked for "en-GB" is still served an "en" track rather than nothing.
   */
  language: z.string().min(2).transform((value) => value.toLowerCase()),
  codec: audioCodecSchema,
  /** 2 = stereo, 6 = 5.1, 8 = 7.1. */
  channels: z.number().int().min(1).max(16),
  role: audioRoleSchema,
  /** The provider's own default. A hint, never an override of viewer intent. */
  isDefault: z.boolean()
});
export type AudioTrack = z.infer<typeof audioTrackSchema>;

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

/* -------------------------------------------------------------------------
 * Catalog (PL-0101)
 * ---------------------------------------------------------------------- */

/**
 * Rights values the platform may surface to a user. Declared as an explicit
 * allowlist so any rights value added later is non-surfaceable until reviewed.
 *
 * NOTE: `@liberty/media-engine` currently declares an equivalent
 * `PLAYABLE_RIGHTS` for the playback path. Once PL-0201 is out of review those
 * should converge on this single definition — tracked as a follow-up rather
 * than edited here, because media-engine is frozen pending GPT review.
 */
export const PLAYABLE_CONTENT_RIGHTS: readonly ContentRights[] = [
  "licensed",
  "owned",
  "public-domain"
];

export const catalogItemKindSchema = z.enum(["movie", "series", "episode"]);
export type CatalogItemKind = z.infer<typeof catalogItemKindSchema>;

/**
 * Fields whose meaning does not depend on `kind`.
 *
 * Split out so the per-kind branches below differ ONLY in the cross-field
 * invariants, which makes it obvious at a glance that nothing else diverges.
 */
const catalogItemBaseShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  rights: contentRightsSchema,
  genre: z.string().min(1),
  releaseYear: z.number().int().min(1888)
};

const runtime = z.number().int().positive();
const episodes = z.number().int().positive();

/**
 * `runtimeMinutes` and `episodeCount` are NOT independently nullable: which one
 * carries the shape is determined by `kind`. Expressing that as a plain object
 * with two `.nullable()` fields — as this schema previously did — documents the
 * invariant in a comment while accepting every payload that violates it: a
 * series with a runtime, a movie with an episode count, or an item with
 * neither. A comment is not a validator.
 *
 * A discriminated union makes the invariant structural, so an invalid
 * combination cannot parse and cannot be constructed in TypeScript either.
 * Zod also uses the discriminator to report the error against the correct
 * branch instead of unioning every branch's failures.
 *
 * Both fields stay REQUIRED (explicitly `null`, never absent) in every branch.
 * A provider that omits a field is signalling something different from one that
 * asserts the field does not apply, and the resolver needs to tell them apart.
 */
export const movieCatalogItemSchema = z.object({
  ...catalogItemBaseShape,
  kind: z.literal("movie"),
  /** A movie always has a runtime. */
  runtimeMinutes: runtime,
  /** Only a series is counted in episodes. */
  episodeCount: z.null()
});

export const seriesCatalogItemSchema = z.object({
  ...catalogItemBaseShape,
  kind: z.literal("series"),
  /** A series has no single runtime; its episodes do. */
  runtimeMinutes: z.null(),
  episodeCount: episodes
});

export const episodeCatalogItemSchema = z.object({
  ...catalogItemBaseShape,
  kind: z.literal("episode"),
  /** An individual episode has its own runtime. */
  runtimeMinutes: runtime,
  /** An episode is one unit; it does not itself contain episodes. */
  episodeCount: z.null()
});

export const catalogItemSchema = z.discriminatedUnion("kind", [
  movieCatalogItemSchema,
  seriesCatalogItemSchema,
  episodeCatalogItemSchema
]);
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export type MovieCatalogItem = z.infer<typeof movieCatalogItemSchema>;
export type SeriesCatalogItem = z.infer<typeof seriesCatalogItemSchema>;
export type EpisodeCatalogItem = z.infer<typeof episodeCatalogItemSchema>;

export const catalogRailSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  items: z.array(catalogItemSchema)
});
export type CatalogRail = z.infer<typeof catalogRailSchema>;

/** Response body of `GET /api/v1/catalog/home`. */
export const catalogHomeResponseSchema = z.object({
  rails: z.array(catalogRailSchema),
  generatedAt: z.string().datetime()
});
export type CatalogHomeResponse = z.infer<typeof catalogHomeResponseSchema>;

export * from "./title";
export * from "./failover";
export * from "./subtitles";
