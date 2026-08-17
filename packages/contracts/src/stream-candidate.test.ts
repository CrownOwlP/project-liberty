import { describe, expect, it } from "vitest";
import {
  MEDIA_FACTS,
  playbackResolveRequestSchema,
  streamCandidateSchema,
  unknownMediaFacts
} from "./index";

/**
 * Unknown media metadata (PL-0205).
 *
 * The property these tests exist to hold is that "unknown" is a state a producer
 * must ASSERT. It has to parse when stated and fail when merely omitted --
 * otherwise `null` is decoration and the real representation of unknown is
 * silence, which no consumer can distinguish from a producer that has not been
 * updated.
 */

const described = {
  id: "aurora-fall-hls-1080",
  providerId: "demo-owned-library",
  rights: "owned",
  protocol: "hls",
  height: 1080,
  bitrateKbps: 8100,
  estimatedLatencyMs: 240,
  healthScore: 0.93,
  videoCodec: "hevc",
  audioCodec: "eac3"
};

const capabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3"],
  preferredAudioLanguages: ["en"]
};

describe("streamCandidateSchema unknown media facts", () => {
  it("accepts a fully described candidate", () => {
    expect(streamCandidateSchema.safeParse(described).success).toBe(true);
  });

  it("accepts an explicit null for every fact a provider may not know", () => {
    for (const fact of MEDIA_FACTS) {
      const result = streamCandidateSchema.safeParse({ ...described, [fact]: null });
      expect(result.success).toBe(true);
    }
  });

  it("accepts a candidate that states none of them", () => {
    const result = streamCandidateSchema.safeParse({
      ...described,
      videoCodec: null,
      audioCodec: null,
      height: null,
      bitrateKbps: null
    });
    expect(result.success).toBe(true);
  });

  it("rejects an OMITTED fact, so unknown cannot be reached by silence", () => {
    // The whole reason these are `.nullable()` rather than `.optional()`. An
    // absent key would be indistinguishable from a producer that has not been
    // taught about the field, and the validator would be a hole rather than a
    // check.
    for (const fact of MEDIA_FACTS) {
      const payload: Record<string, unknown> = { ...described };
      delete payload[fact];
      expect(streamCandidateSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("rejects undefined as loudly as it rejects an omitted key", () => {
    for (const fact of MEDIA_FACTS) {
      expect(streamCandidateSchema.safeParse({ ...described, [fact]: undefined }).success).toBe(false);
    }
  });

  it("still refuses a numeric sentinel dressed up as a measurement", () => {
    // Zero is not "unknown". If it parsed, a fabricated fact would survive every
    // downstream comparison without ever failing -- which is exactly the failure
    // `null` exists to make impossible.
    expect(streamCandidateSchema.safeParse({ ...described, height: 0 }).success).toBe(false);
    expect(streamCandidateSchema.safeParse({ ...described, bitrateKbps: 0 }).success).toBe(false);
  });

  it("still refuses a codec value that is not a codec", () => {
    expect(streamCandidateSchema.safeParse({ ...described, videoCodec: "unknown" }).success).toBe(false);
    expect(streamCandidateSchema.safeParse({ ...described, audioCodec: "" }).success).toBe(false);
  });

  it("accepts a resolve request carrying unverified candidates", () => {
    const result = playbackResolveRequestSchema.safeParse({
      contentId: "aurora-fall",
      capabilities,
      candidates: [{ ...described, videoCodec: null, audioCodec: null, height: null, bitrateKbps: null }]
    });
    expect(result.success).toBe(true);
  });
});

describe("unknownMediaFacts", () => {
  it("returns nothing for a fully described candidate", () => {
    expect(unknownMediaFacts({
      videoCodec: "hevc",
      audioCodec: "eac3",
      height: 1080,
      bitrateKbps: 8100
    })).toEqual([]);
  });

  it("reports missing facts in MEDIA_FACTS order, not argument order", () => {
    // Derived by filtering the canonical list, so two subsystems can never
    // publish the same set of missing facts in two different orders.
    expect(unknownMediaFacts({
      bitrateKbps: null,
      height: null,
      audioCodec: null,
      videoCodec: null
    })).toEqual(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
  });

  it("reports only what is actually missing", () => {
    expect(unknownMediaFacts({
      videoCodec: null,
      audioCodec: "aac",
      height: 720,
      bitrateKbps: null
    })).toEqual(["videoCodec", "bitrateKbps"]);
  });
});
