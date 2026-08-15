import { describe, expect, it } from "vitest";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts";
import { rankStreamCandidates } from "./ranking";

const capabilities: PlaybackCapabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3"],
  preferredAudioLanguages: ["en"]
};

const base: Omit<StreamCandidate, "id" | "height" | "videoCodec" | "audioCodec"> = {
  providerId: "fixture",
  rights: "licensed",
  protocol: "https",
  bitrateKbps: 6000,
  estimatedLatencyMs: 70,
  healthScore: 0.98
};

describe("rankStreamCandidates", () => {
  it("rejects unsupported codecs before ranking", () => {
    const decision = rankStreamCandidates([
      { ...base, id: "vp9", height: 1080, videoCodec: "vp9", audioCodec: "aac" }
    ], capabilities);

    expect(decision.selected).toBeNull();
    expect(decision.rejected).toEqual([
      { candidateId: "vp9", reason: "unsupported_video_codec" }
    ]);
  });

  it("prefers a healthy compatible high-quality candidate", () => {
    const candidates: StreamCandidate[] = [
      { ...base, id: "1080", height: 1080, videoCodec: "h264", audioCodec: "aac" },
      { ...base, id: "2160", height: 2160, bitrateKbps: 16000, estimatedLatencyMs: 120, healthScore: 0.96, videoCodec: "hevc", audioCodec: "eac3" }
    ];

    const decision = rankStreamCandidates(candidates, capabilities);
    expect(decision.selected?.candidate.id).toBe("2160");
  });

  it("uses candidate id as deterministic tie-breaker", () => {
    const candidates: StreamCandidate[] = [
      { ...base, id: "b", height: 1080, videoCodec: "h264", audioCodec: "aac" },
      { ...base, id: "a", height: 1080, videoCodec: "h264", audioCodec: "aac" }
    ];

    const decision = rankStreamCandidates(candidates, capabilities);
    expect(decision.ranked.map((item) => item.candidate.id)).toEqual(["a", "b"]);
  });
});
