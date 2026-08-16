import { z } from "zod";

export const contentRightsSchema = z.enum(["licensed", "owned", "public-domain"]);
export type ContentRights = z.infer<typeof contentRightsSchema>;

export const videoCodecSchema = z.enum(["h264", "hevc", "av1", "vp9"]);
export const audioCodecSchema = z.enum(["aac", "ac3", "eac3", "opus"]);

export const streamCandidateSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  rights: contentRightsSchema,
  protocol: z.enum(["https", "hls", "dash"]),
  height: z.number().int().positive(),
  bitrateKbps: z.number().positive(),
  estimatedLatencyMs: z.number().nonnegative(),
  healthScore: z.number().min(0).max(1),
  videoCodec: videoCodecSchema,
  audioCodec: audioCodecSchema
});

export type StreamCandidate = z.infer<typeof streamCandidateSchema>;

export const playbackCapabilitiesSchema = z.object({
  maxHeight: z.number().int().positive(),
  supportedVideoCodecs: z.array(videoCodecSchema).min(1),
  supportedAudioCodecs: z.array(audioCodecSchema).min(1),
  preferredAudioLanguages: z.array(z.string()).default([])
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
