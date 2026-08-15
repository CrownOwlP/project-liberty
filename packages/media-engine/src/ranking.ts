import type { ContentRights, PlaybackCapabilities, StreamCandidate } from "@liberty/contracts";
import { type CandidateScore, explainScore, scoreCandidate } from "./scoring";

export interface RankedCandidate {
  candidate: StreamCandidate;
  score: number;
  reason: string;
  breakdown: CandidateScore["components"];
}

export interface PlaybackDecision {
  selected: RankedCandidate | null;
  ranked: RankedCandidate[];
  rejected: Array<{ candidateId: string; reason: string }>;
  reason: string;
}

/**
 * Rights boundary. Only content the platform is actually entitled to serve may
 * enter playback resolution. This is an explicit allowlist rather than a
 * denylist so that any new rights value is non-playable until it is reviewed.
 */
export const PLAYABLE_RIGHTS: readonly ContentRights[] = ["licensed", "owned", "public-domain"];

/** Providers below this health floor are excluded regardless of quality. */
export const PROVIDER_HEALTH_FLOOR = 0.5;

export type RejectionReason =
  | "rights_not_playable"
  | "unsupported_video_codec"
  | "unsupported_audio_codec"
  | "resolution_exceeds_capability"
  | "provider_health_below_floor";

/**
 * Eligibility is evaluated before scoring and in a fixed order, so a candidate
 * always reports the first (most fundamental) reason it was excluded. Rights
 * are checked first: an unlicensed candidate must never be scored, ranked, or
 * surfaced, whatever its technical quality.
 */
function firstRejectionReason(
  candidate: StreamCandidate,
  capabilities: PlaybackCapabilities
): RejectionReason | null {
  if (!PLAYABLE_RIGHTS.includes(candidate.rights)) return "rights_not_playable";
  if (!capabilities.supportedVideoCodecs.includes(candidate.videoCodec)) return "unsupported_video_codec";
  if (!capabilities.supportedAudioCodecs.includes(candidate.audioCodec)) return "unsupported_audio_codec";
  if (candidate.height > capabilities.maxHeight) return "resolution_exceeds_capability";
  if (candidate.healthScore < PROVIDER_HEALTH_FLOOR) return "provider_health_below_floor";
  return null;
}

export function rankStreamCandidates(
  candidates: StreamCandidate[],
  capabilities: PlaybackCapabilities
): PlaybackDecision {
  const rejected: PlaybackDecision["rejected"] = [];
  const eligible: StreamCandidate[] = [];

  for (const candidate of candidates) {
    const reason = firstRejectionReason(candidate, capabilities);
    if (reason) rejected.push({ candidateId: candidate.id, reason });
    else eligible.push(candidate);
  }

  const ranked = eligible
    .map((candidate) => {
      const score = scoreCandidate(candidate, capabilities);
      return {
        candidate,
        score: score.total,
        reason: explainScore(score),
        breakdown: score.components
      };
    })
    // Deterministic: score descending, then candidate id ascending so equal
    // scores never depend on input ordering.
    .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));

  return {
    selected: ranked[0] ?? null,
    ranked,
    rejected,
    reason: ranked.length > 0 ? "highest_eligible_score" : "no_eligible_candidates"
  };
}
