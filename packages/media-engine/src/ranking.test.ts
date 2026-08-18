import { describe, expect, it } from "vitest";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import { PLAYABLE_RIGHTS, PROVIDER_HEALTH_FLOOR, rankStreamCandidates } from "./ranking";
import { SCORE_PRECISION, SCORE_WEIGHTS, explainScore, scoreCandidate } from "./scoring";

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

const candidate = (over: Partial<StreamCandidate> & { id: string }): StreamCandidate => ({
  ...base,
  height: 1080,
  videoCodec: "h264",
  audioCodec: "aac",
  ...over
});

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

describe("rights boundary", () => {
  it("never scores a candidate whose rights are not playable", () => {
    const decision = rankStreamCandidates([
      // Deliberately bypasses the schema to simulate untrusted upstream data.
      candidate({ id: "pirated", rights: "unlicensed" as never })
    ], capabilities);

    expect(decision.selected).toBeNull();
    expect(decision.ranked).toHaveLength(0);
    expect(decision.rejected).toEqual([{ candidateId: "pirated", reason: "rights_not_playable" }]);
  });

  it("checks rights before any technical property", () => {
    // Unplayable rights AND an unsupported codec: rights must win.
    const decision = rankStreamCandidates([
      candidate({ id: "x", rights: "unlicensed" as never, videoCodec: "vp9" })
    ], capabilities);

    expect(decision.rejected).toEqual([{ candidateId: "x", reason: "rights_not_playable" }]);
  });

  it("admits every rights value on the playable allowlist", () => {
    for (const rights of PLAYABLE_RIGHTS) {
      const decision = rankStreamCandidates([candidate({ id: rights, rights })], capabilities);
      expect(decision.selected?.candidate.id).toBe(rights);
    }
  });
});

describe("eligibility floors", () => {
  it("excludes providers below the health floor", () => {
    const decision = rankStreamCandidates([
      candidate({ id: "sick", healthScore: PROVIDER_HEALTH_FLOOR - 0.01 })
    ], capabilities);

    expect(decision.rejected).toEqual([{ candidateId: "sick", reason: "provider_health_below_floor" }]);
  });

  it("keeps a candidate exactly at the health floor", () => {
    const decision = rankStreamCandidates([
      candidate({ id: "borderline", healthScore: PROVIDER_HEALTH_FLOOR })
    ], capabilities);

    expect(decision.selected?.candidate.id).toBe("borderline");
  });

  it("reports no_eligible_candidates when everything is filtered out", () => {
    const decision = rankStreamCandidates([candidate({ id: "too-big", height: 4320 })], capabilities);
    expect(decision.reason).toBe("no_eligible_candidates");
    expect(decision.rejected).toEqual([{ candidateId: "too-big", reason: "resolution_exceeds_capability" }]);
  });
});

describe("score model", () => {
  it("is deterministic across repeated evaluation", () => {
    const c = candidate({ id: "same" });
    const first = scoreCandidate(c, capabilities);
    const second = scoreCandidate(c, capabilities);
    expect(second).toEqual(first);
  });

  it("does not depend on input ordering", () => {
    const a = candidate({ id: "a", height: 720 });
    const b = candidate({ id: "b", height: 1440, bitrateKbps: 11000 });
    const forward = rankStreamCandidates([a, b], capabilities).ranked.map((r) => r.candidate.id);
    const reverse = rankStreamCandidates([b, a], capabilities).ranked.map((r) => r.candidate.id);
    expect(reverse).toEqual(forward);
  });

  it("decomposes exactly into its weighted components", () => {
    const score = scoreCandidate(candidate({ id: "explain" }), capabilities);
    const summed = score.components.reduce((total, item) => total + item.weighted, 0);
    expect(summed).toBeCloseTo(score.total, 8);
  });

  it("reconstructs stored weighted from stored raw and weight", () => {
    // The published breakdown must be internally consistent: a reader who
    // multiplies the stored raw by the stored weight must get the stored
    // weighted value, not merely something close to it.
    const probes = [
      candidate({ id: "a", height: 1440, bitrateKbps: 10800 }),
      candidate({ id: "b", height: 720, bitrateKbps: 1200, healthScore: 0.6133, protocol: "hls" }),
      candidate({ id: "c", height: 2160, bitrateKbps: 39000, videoCodec: "hevc", audioCodec: "eac3", estimatedLatencyMs: 913 })
    ];

    const atPrecision = (value: number) => Number(value.toFixed(SCORE_PRECISION));

    for (const probe of probes) {
      const score = scoreCandidate(probe, capabilities);
      for (const item of score.components) {
        // Exact, not approximate: the stored weighted value is exactly what a
        // reader gets by multiplying stored raw by stored weight and rounding
        // to the declared precision.
        expect(atPrecision(item.raw * item.weight)).toBe(item.weighted);
      }
      const summed = score.components.reduce((total, item) => total + item.weighted, 0);
      expect(atPrecision(summed)).toBe(score.total);
    }
  });

  it("stores every value at the declared precision", () => {
    const score = scoreCandidate(candidate({ id: "precise", height: 1440, bitrateKbps: 9337 }), capabilities);
    const atPrecision = (value: number) => Number(value.toFixed(SCORE_PRECISION)) === value;
    for (const item of score.components) {
      expect(atPrecision(item.raw)).toBe(true);
      expect(atPrecision(item.weighted)).toBe(true);
    }
    expect(atPrecision(score.total)).toBe(true);
  });

  it("keeps every component consistent with its own weight and raw value", () => {
    const score = scoreCandidate(candidate({ id: "consistent", height: 1440 }), capabilities);
    for (const item of score.components) {
      expect(item.raw).toBeGreaterThanOrEqual(0);
      expect(item.raw).toBeLessThanOrEqual(1);
      expect(Number((item.raw * item.weight).toFixed(SCORE_PRECISION))).toBe(item.weighted);
      expect(item.explanation.length).toBeGreaterThan(0);
    }
  });

  it("uses integer weights so the decomposition stays exact", () => {
    for (const weight of Object.values(SCORE_WEIGHTS)) {
      expect(Number.isInteger(weight)).toBe(true);
    }
  });

  it("exposes exactly one penalty dimension", () => {
    const penalties = Object.entries(SCORE_WEIGHTS).filter(([, weight]) => weight < 0);
    expect(penalties).toEqual([["latency", -15]]);
  });

  it("sums positive weights to 100", () => {
    const positive = Object.values(SCORE_WEIGHTS).filter((w) => w > 0).reduce((a, b) => a + b, 0);
    expect(positive).toBe(100);
  });

  it("attaches an explainable breakdown to every ranked candidate", () => {
    const decision = rankStreamCandidates([candidate({ id: "trail" })], capabilities);
    const selected = decision.selected;
    expect(selected).not.toBeNull();
    expect(selected?.breakdown.map((c) => c.dimension).sort()).toEqual(
      Object.keys(SCORE_WEIGHTS).sort()
    );
    expect(selected?.reason).toContain("resolution=");
  });

  it("orders the explanation by absolute contribution", () => {
    const score = scoreCandidate(candidate({ id: "ordered" }), capabilities);
    const magnitudes = explainScore(score)
      .split(" ")
      .map((part) => Math.abs(Number(part.split("=")[1])));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
  });
});

describe("score model monotonicity", () => {
  const at = (over: Partial<StreamCandidate>) =>
    scoreCandidate(candidate({ id: "probe", ...over }), capabilities).total;

  it("rewards higher resolution", () => {
    expect(at({ height: 2160, bitrateKbps: 16200 })).toBeGreaterThan(at({ height: 720, bitrateKbps: 5400 }));
  });

  it("rewards healthier providers", () => {
    expect(at({ healthScore: 1 })).toBeGreaterThan(at({ healthScore: 0.6 }));
  });

  it("penalises higher latency", () => {
    expect(at({ estimatedLatencyMs: 50 })).toBeGreaterThan(at({ estimatedLatencyMs: 800 }));
  });

  it("rewards adaptive protocols over progressive delivery", () => {
    expect(at({ protocol: "hls" })).toBeGreaterThan(at({ protocol: "https" }));
  });

  it("rewards more efficient codecs at equal quality", () => {
    expect(at({ videoCodec: "hevc" })).toBeGreaterThan(at({ videoCodec: "h264" }));
  });

  it("penalises both under- and over-provisioned bitrate", () => {
    const onTarget = at({ height: 1080, bitrateKbps: 8100 });
    expect(onTarget).toBeGreaterThan(at({ height: 1080, bitrateKbps: 1000 }));
    expect(onTarget).toBeGreaterThan(at({ height: 1080, bitrateKbps: 40000 }));
  });
});
