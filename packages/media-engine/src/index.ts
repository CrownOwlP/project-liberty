export { rankStreamCandidates, PLAYABLE_RIGHTS, PROVIDER_HEALTH_FLOOR } from "./ranking";
export type { PlaybackDecision, RankedCandidate, RejectionReason } from "./ranking";
export {
  scoreCandidate,
  explainScore,
  SCORE_WEIGHTS,
  SCORE_PRECISION,
  CODEC_EFFICIENCY,
  PROTOCOL_ADAPTIVITY,
  BITRATE_KBPS_PER_LINE,
  LATENCY_CEILING_MS
} from "./scoring";
export type { CandidateScore, ScoreComponent, ScoreDimension } from "./scoring";
