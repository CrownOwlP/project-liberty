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
