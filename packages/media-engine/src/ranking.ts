import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts";

export interface RankedCandidate {
  candidate: StreamCandidate;
  score: number;
  reason: string;
}

export interface PlaybackDecision {
  selected: RankedCandidate | null;
  ranked: RankedCandidate[];
  rejected: Array<{ candidateId: string; reason: string }>;
  reason: string;
}

function scoreCandidate(candidate: StreamCandidate, capabilities: PlaybackCapabilities): number {
  const resolutionRatio = Math.min(candidate.height, capabilities.maxHeight) / capabilities.maxHeight;
  const qualityScore = resolutionRatio * 42;
  const healthScore = candidate.healthScore * 38;
  const latencyPenalty = Math.min(candidate.estimatedLatencyMs / 500, 1) * 14;
  const bitrateEfficiency = Math.min(candidate.bitrateKbps / 20000, 1) * 6;

  return Number((qualityScore + healthScore + bitrateEfficiency - latencyPenalty).toFixed(4));
}

export function rankStreamCandidates(
  candidates: StreamCandidate[],
  capabilities: PlaybackCapabilities
): PlaybackDecision {
  const rejected: PlaybackDecision["rejected"] = [];
  const eligible = candidates.filter((candidate) => {
    if (!capabilities.supportedVideoCodecs.includes(candidate.videoCodec)) {
      rejected.push({ candidateId: candidate.id, reason: "unsupported_video_codec" });
      return false;
    }

    if (!capabilities.supportedAudioCodecs.includes(candidate.audioCodec)) {
      rejected.push({ candidateId: candidate.id, reason: "unsupported_audio_codec" });
      return false;
    }

    if (candidate.height > capabilities.maxHeight) {
      rejected.push({ candidateId: candidate.id, reason: "resolution_exceeds_capability" });
      return false;
    }

    if (candidate.healthScore < 0.5) {
      rejected.push({ candidateId: candidate.id, reason: "provider_health_below_floor" });
      return false;
    }

    return true;
  });

  const ranked = eligible
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, capabilities),
      reason: `quality=${candidate.height}p health=${candidate.healthScore.toFixed(2)} latency=${candidate.estimatedLatencyMs}ms`
    }))
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));

  return {
    selected: ranked[0] ?? null,
    ranked,
    rejected,
    reason: ranked.length > 0 ? "highest_eligible_score" : "no_eligible_candidates"
  };
}
