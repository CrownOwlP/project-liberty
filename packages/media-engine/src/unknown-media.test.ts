import { describe, expect, it } from "vitest";
import { unknownMediaFacts, type PlaybackCapabilities, type StreamCandidate } from "@liberty/contracts";
import { rankStreamCandidates } from "./ranking";
import {
  SCORE_PRECISION,
  SCORE_WEIGHTS,
  UNKNOWABLE_DIMENSIONS,
  explainScore,
  scoreCandidate
} from "./scoring";

/**
 * Unknown media metadata (PL-0205).
 *
 * The distinction under test throughout this file is authorized !=
 * known-compatible != attemptable. A candidate whose codec was never stated is
 * not compatible and not incompatible; it is unverified, and every assertion
 * here exists to stop one of those three collapsing into another.
 */

const capabilities: PlaybackCapabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3"],
  preferredAudioLanguages: ["en"]
};

/** Fully described: every media fact stated. Override one to make it unknown. */
const candidate = (over: Partial<StreamCandidate> & { id: string }): StreamCandidate => ({
  providerId: "fixture",
  rights: "licensed",
  protocol: "https",
  height: 1080,
  bitrateKbps: 8100,
  estimatedLatencyMs: 70,
  healthScore: 0.98,
  videoCodec: "h264",
  audioCodec: "aac",
  ...over
});

const componentFor = (score: ReturnType<typeof scoreCandidate>, dimension: string) => {
  const found = score.components.find((item) => item.dimension === dimension);
  expect(found).toBeDefined();
  return found as NonNullable<typeof found>;
};

describe("unknown metadata contract", () => {
  it("reports missing facts in the contract's canonical order", () => {
    // Filtered from MEDIA_FACTS, never assembled by pushing, so the published
    // order cannot drift with the order the checks are written in.
    expect(
      unknownMediaFacts({ videoCodec: null, audioCodec: null, height: null, bitrateKbps: null })
    ).toEqual(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
  });

  it("reports nothing missing for a fully described candidate", () => {
    expect(unknownMediaFacts(candidate({ id: "complete" }))).toEqual([]);
  });
});

describe("eligibility with unknown facts", () => {
  it("does not reject a candidate whose video codec was never stated", () => {
    const decision = rankStreamCandidates([candidate({ id: "no-vcodec", videoCodec: null })], capabilities);

    expect(decision.rejected).toEqual([]);
    expect(decision.selected?.candidate.id).toBe("no-vcodec");
  });

  it("does not reject a candidate whose audio codec was never stated", () => {
    const decision = rankStreamCandidates([candidate({ id: "no-acodec", audioCodec: null })], capabilities);

    expect(decision.rejected).toEqual([]);
    expect(decision.selected?.candidate.id).toBe("no-acodec");
  });

  it("still rejects a STATED codec the device cannot decode", () => {
    // The rejection this task must not weaken. Unknown became attemptable;
    // unsupported did not.
    const video = rankStreamCandidates([candidate({ id: "vp9", videoCodec: "vp9" })], capabilities);
    expect(video.selected).toBeNull();
    expect(video.rejected).toEqual([{ candidateId: "vp9", reason: "unsupported_video_codec" }]);

    const audio = rankStreamCandidates([candidate({ id: "ac3", audioCodec: "ac3" })], capabilities);
    expect(audio.selected).toBeNull();
    expect(audio.rejected).toEqual([{ candidateId: "ac3", reason: "unsupported_audio_codec" }]);
  });

  it("cannot exceed maxHeight with a height nobody stated", () => {
    // There is no measurement to exceed the ceiling with. Refusing here would
    // reject a stream over a number that does not exist.
    const decision = rankStreamCandidates(
      [candidate({ id: "no-height", height: null })],
      { ...capabilities, maxHeight: 720 }
    );

    expect(decision.rejected).toEqual([]);
    expect(decision.selected?.candidate.id).toBe("no-height");
  });

  it("still rejects a STATED height above the ceiling", () => {
    const decision = rankStreamCandidates([candidate({ id: "too-big", height: 4320 })], capabilities);
    expect(decision.rejected).toEqual([{ candidateId: "too-big", reason: "resolution_exceeds_capability" }]);
  });

  it("checks rights before anything unknown can excuse a candidate", () => {
    // Unknown must not become a way past the rights boundary: the ordering of
    // eligibility checks is unchanged.
    const decision = rankStreamCandidates(
      [
        // Deliberately bypasses the schema to simulate untrusted upstream data.
        candidate({ id: "pirated", rights: "unlicensed" as never, videoCodec: null, height: null })
      ],
      capabilities
    );

    expect(decision.selected).toBeNull();
    expect(decision.rejected).toEqual([{ candidateId: "pirated", reason: "rights_not_playable" }]);
  });
});

describe("scoring an unknown dimension", () => {
  it("awards nothing for a codec that was never stated", () => {
    const score = scoreCandidate(candidate({ id: "no-vcodec", videoCodec: null }), capabilities);
    const codec = componentFor(score, "codecEfficiency");

    expect(codec.known).toBe(false);
    expect(codec.raw).toBe(0);
    expect(codec.weighted).toBe(0);
    expect(codec.missingFacts).toEqual(["videoCodec"]);
  });

  it("awards nothing for a resolution that was never stated", () => {
    const score = scoreCandidate(candidate({ id: "no-height", height: null }), capabilities);
    const resolution = componentFor(score, "resolution");

    expect(resolution.known).toBe(false);
    expect(resolution.weighted).toBe(0);
    expect(resolution.missingFacts).toEqual(["height"]);
  });

  it("cannot measure bitrate efficiency without the height that sets the target", () => {
    // 8100kbps is close to ideal for 1080p and thin for 2160p. With no height
    // there is no distance to compute, so a stated bitrate is still unmeasured
    // -- and both absent facts are named rather than only the obvious one.
    const score = scoreCandidate(candidate({ id: "no-height", height: null }), capabilities);
    const bitrate = componentFor(score, "bitrateEfficiency");

    expect(bitrate.known).toBe(false);
    expect(bitrate.missingFacts).toEqual(["height"]);
  });

  it("names every absent input when both bitrate facts are missing", () => {
    const score = scoreCandidate(
      candidate({ id: "neither", height: null, bitrateKbps: null }),
      capabilities
    );
    expect(componentFor(score, "bitrateEfficiency").missingFacts).toEqual(["height", "bitrateKbps"]);
  });

  it("leaves the observed dimensions untouched", () => {
    // Unknown metadata must not contaminate what we did measure ourselves:
    // health, protocol and latency are platform observations, not provider
    // claims.
    const score = scoreCandidate(
      candidate({ id: "blind", videoCodec: null, height: null, bitrateKbps: null, protocol: "hls" }),
      capabilities
    );

    for (const dimension of ["health", "protocolAdaptivity", "latency"]) {
      expect(componentFor(score, dimension).known).toBe(true);
    }
    expect(componentFor(score, "health").weighted).toBe(29.4);
    expect(componentFor(score, "protocolAdaptivity").weighted).toBe(8);
  });

  it("keeps every unknowable dimension on a positive weight", () => {
    // Zero for a positive weight means "earned nothing"; zero for a PENALTY
    // would mean "escaped the penalty", i.e. a candidate rewarded for
    // withholding information. If a penalty dimension ever becomes nullable it
    // needs the opposite rule and this test is the thing that says so.
    for (const dimension of UNKNOWABLE_DIMENSIONS) {
      expect(SCORE_WEIGHTS[dimension]).toBeGreaterThan(0);
    }
  });

  it("does not renormalise the ceiling for what it could not measure", () => {
    /*
     * The decision recorded in scoring.ts: an unknown dimension contributes 0
     * and the 100-point ceiling stays where it is. Renormalising the surviving
     * weights back to 100 would let a stream that states nothing at all reach a
     * perfect score, which is the fabricated neutral measurement reached by
     * division instead of by a placeholder.
     */
    const best = scoreCandidate(
      candidate({
        id: "blind-but-perfect",
        videoCodec: null,
        height: null,
        bitrateKbps: null,
        protocol: "hls",
        healthScore: 1,
        estimatedLatencyMs: 0
      }),
      capabilities
    );

    // health(30) + protocolAdaptivity(8), and not one point more.
    expect(best.attainableTotal).toBe(38);
    expect(best.total).toBe(38);

    // The same stream, fully described, keeps the whole ceiling available.
    const described = scoreCandidate(
      candidate({ id: "described", protocol: "hls", healthScore: 1, estimatedLatencyMs: 0 }),
      capabilities
    );
    expect(described.attainableTotal).toBe(100);
    expect(described.total).toBeGreaterThan(best.total);
  });

  it("publishes the full ceiling for a fully described candidate", () => {
    const score = scoreCandidate(candidate({ id: "complete" }), capabilities);
    expect(score.attainableTotal).toBe(100);
    expect(score.unknownFacts).toEqual([]);
  });

  it("keeps the breakdown reconstructible when dimensions are unknown", () => {
    // The published breakdown must still add up: an unknown component is a real
    // component with a real zero, not a hole in the arithmetic.
    const score = scoreCandidate(
      candidate({ id: "mixed", videoCodec: null, bitrateKbps: null }),
      capabilities
    );
    const atPrecision = (value: number) => Number(value.toFixed(SCORE_PRECISION));

    for (const item of score.components) {
      expect(atPrecision(item.raw * item.weight)).toBe(item.weighted);
      expect(item.explanation.length).toBeGreaterThan(0);
    }
    expect(atPrecision(score.components.reduce((total, item) => total + item.weighted, 0)))
      .toBe(score.total);
    expect(score.components.map((item) => item.dimension).sort())
      .toEqual(Object.keys(SCORE_WEIGHTS).sort());
  });
});

describe("reason trail for missing facts", () => {
  it("distinguishes a dimension we measured at zero from one we were never told", () => {
    /*
     * Both weigh nothing. They are completely different findings: the first says
     * the stream is badly provisioned, the second says nobody described it. A
     * trail that prints `bitrateEfficiency=0` for both sends whoever reads it to
     * the wrong system.
     */
    const measuredZero = explainScore(
      scoreCandidate(candidate({ id: "wasteful", bitrateKbps: 100_000 }), capabilities)
    );
    expect(measuredZero).toContain("bitrateEfficiency=0");
    expect(measuredZero).not.toContain("unknown");

    const neverStated = explainScore(
      scoreCandidate(candidate({ id: "silent", bitrateKbps: null }), capabilities)
    );
    expect(neverStated).toContain("bitrateEfficiency=unknown");
  });

  it("names the missing fact in the component explanation", () => {
    const score = scoreCandidate(candidate({ id: "silent", videoCodec: null }), capabilities);
    expect(componentFor(score, "codecEfficiency").explanation).toContain("videoCodec");
    expect(componentFor(score, "codecEfficiency").explanation).toContain("not stated");
  });

  it("surfaces an unknown audio codec, which has no score dimension of its own", () => {
    // Nothing here measures audio quality, so an unknown audio codec costs no
    // points and would be invisible in a dimension-only trail -- while being the
    // very fact that made the candidate unverified.
    const decision = rankStreamCandidates([candidate({ id: "no-acodec", audioCodec: null })], capabilities);

    expect(decision.selected?.reason).toContain("unverified: audioCodec not stated");
    expect(decision.selected?.unknownFacts).toEqual(["audioCodec"]);
  });

  it("lists every missing fact on the ranked entry", () => {
    const decision = rankStreamCandidates(
      [candidate({ id: "silent", videoCodec: null, audioCodec: null, height: null, bitrateKbps: null })],
      capabilities
    );

    expect(decision.selected?.unknownFacts).toEqual([
      "videoCodec",
      "audioCodec",
      "height",
      "bitrateKbps"
    ]);
    expect(decision.selected?.reason).toContain(
      "unverified: videoCodec, audioCodec, height, bitrateKbps not stated"
    );
  });

  it("says nothing about unknowns when everything was stated", () => {
    const decision = rankStreamCandidates([candidate({ id: "complete" })], capabilities);
    expect(decision.selected?.reason).not.toContain("unverified");
  });
});

describe("compatibility labelling", () => {
  it("labels a selection whose codecs were never stated as unverified", () => {
    const decision = rankStreamCandidates([candidate({ id: "silent", videoCodec: null })], capabilities);

    expect(decision.selected?.compatibility).toBe("unverified");
    expect(decision.reason).toBe("highest_eligible_score_unverified_compatibility");
  });

  it("labels a fully checked selection as verified", () => {
    const decision = rankStreamCandidates([candidate({ id: "complete" })], capabilities);

    expect(decision.selected?.compatibility).toBe("verified");
    expect(decision.reason).toBe("highest_eligible_score");
  });

  it("treats an unknown height or bitrate as a quality gap, not a compatibility one", () => {
    // Compatibility is about decode. An unlabelled resolution says nothing about
    // whether the stream plays, so it must not be reported as if it did.
    const decision = rankStreamCandidates(
      [candidate({ id: "no-numbers", height: null, bitrateKbps: null })],
      capabilities
    );

    expect(decision.selected?.compatibility).toBe("verified");
    expect(decision.selected?.unknownFacts).toEqual(["height", "bitrateKbps"]);
  });
});

describe("ranking unknown against known", () => {
  it("prefers a measured candidate over an otherwise-identical unmeasured one", () => {
    // Ids are ordered AGAINST the expected winner, so the id tiebreak alone
    // would give the wrong answer.
    const decision = rankStreamCandidates(
      [
        candidate({ id: "zzz-known" }),
        candidate({ id: "aaa-unknown", videoCodec: null, height: null, bitrateKbps: null })
      ],
      capabilities
    );

    expect(decision.ranked.map((item) => item.candidate.id)).toEqual(["zzz-known", "aaa-unknown"]);
    expect(decision.selected?.compatibility).toBe("verified");
  });

  it("prefers the measured candidate even when the two tie on total score", () => {
    /*
     * Score alone does not guarantee the required ordering. A stated bitrate far
     * enough from target clamps `bitrateEfficiency` to zero, exactly like an
     * unstated one -- so these two candidates score identically and only the
     * unknown-facts tiebreak separates them. Ids again favour the loser.
     */
    const measured = candidate({ id: "zzz-measured", bitrateKbps: 100_000 });
    const unmeasured = candidate({ id: "aaa-unmeasured", bitrateKbps: null });

    expect(scoreCandidate(measured, capabilities).total)
      .toBe(scoreCandidate(unmeasured, capabilities).total);

    const decision = rankStreamCandidates([unmeasured, measured], capabilities);
    expect(decision.ranked.map((item) => item.candidate.id)).toEqual([
      "zzz-measured",
      "aaa-unmeasured"
    ]);
  });

  it("still selects an unverified candidate when it is the only thing available", () => {
    // Ranked low is not the same as invisible. A viewer with one attemptable
    // stream must be given it.
    const decision = rankStreamCandidates(
      [candidate({ id: "only", videoCodec: null, audioCodec: null, height: null, bitrateKbps: null })],
      capabilities
    );

    expect(decision.selected?.candidate.id).toBe("only");
    expect(decision.reason).toBe("highest_eligible_score_unverified_compatibility");
  });

  it("lets an unverified candidate beat a measured but poor one", () => {
    // The penalty for being unknown is bounded by the score model, not absolute:
    // a healthy unlabelled stream still outranks a near-dead labelled one.
    const decision = rankStreamCandidates(
      [
        candidate({ id: "sickly-known", healthScore: 0.51, height: 144, bitrateKbps: 40_000, estimatedLatencyMs: 990 }),
        candidate({ id: "healthy-unknown", videoCodec: null, height: null, bitrateKbps: null, protocol: "hls", healthScore: 1 })
      ],
      capabilities
    );

    expect(decision.selected?.candidate.id).toBe("healthy-unknown");
  });
});

describe("whole-decision determinism with unknowns", () => {
  it("produces an identical decision for the same set in a different order", () => {
    /*
     * The entire PlaybackDecision, not just `selected`. `rejected` was left in
     * provider order, which made the determinism claim false for the result as a
     * whole -- the same defect already fixed twice in the audio policy. Unknown
     * candidates are included because they tie more often than measured ones, so
     * they are exactly where an unstable comparator would show up.
     */
    const candidates = [
      candidate({ id: "zzz-vp9", videoCodec: "vp9" }),
      candidate({ id: "aaa-toobig", height: 4320 }),
      candidate({ id: "mmm-unknown", videoCodec: null, audioCodec: null, height: null, bitrateKbps: null }),
      candidate({ id: "bbb-unknown", videoCodec: null, audioCodec: null, height: null, bitrateKbps: null }),
      candidate({ id: "ccc-known" })
    ];

    const forward = rankStreamCandidates(candidates, capabilities);
    const reverse = rankStreamCandidates([...candidates].reverse(), capabilities);

    expect(reverse).toEqual(forward);
    expect(forward.rejected.map((item) => item.candidateId)).toEqual(["aaa-toobig", "zzz-vp9"]);
    expect(forward.ranked.map((item) => item.candidate.id)).toEqual([
      "ccc-known",
      "bbb-unknown",
      "mmm-unknown"
    ]);
  });

  it("orders two equally unknown candidates by code point, not host collation", () => {
    const decision = rankStreamCandidates(
      [
        candidate({ id: "a", videoCodec: null, height: null, bitrateKbps: null }),
        candidate({ id: "B", videoCodec: null, height: null, bitrateKbps: null })
      ],
      capabilities
    );

    expect(decision.ranked.map((item) => item.candidate.id)).toEqual(["B", "a"]);
  });

  it("orders the explanation deterministically when several dimensions sit at zero", () => {
    // Every unknown dimension weighs exactly zero, so without an explicit
    // tiebreak their relative order in the trail is whatever order the component
    // array happens to be built in.
    const score = scoreCandidate(
      candidate({ id: "silent", videoCodec: null, height: null, bitrateKbps: null }),
      capabilities
    );

    // Zeros last, and among themselves in dimension-name order rather than in
    // whatever order `scoreCandidate` builds the array.
    expect(explainScore(score)).toBe(
      "health=29.4 protocolAdaptivity=4 latency=-1.05 " +
        "bitrateEfficiency=unknown codecEfficiency=unknown resolution=unknown"
    );
  });
});
