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

export const catalogItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: catalogItemKindSchema,
  rights: contentRightsSchema,
  genre: z.string().min(1),
  releaseYear: z.number().int().min(1888),
  /** Null for series, where `episodeCount` carries the shape instead. */
  runtimeMinutes: z.number().int().positive().nullable(),
  /** Null for anything that is not a series. */
  episodeCount: z.number().int().positive().nullable()
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;

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
