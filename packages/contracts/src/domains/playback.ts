import { z } from "zod";
import { audioCodecSchema, videoCodecSchema } from "../shared/codecs";
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
