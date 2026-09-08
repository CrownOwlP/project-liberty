export { rankStreamCandidates, PLAYABLE_RIGHTS, PROVIDER_HEALTH_FLOOR } from "./ranking";
export type {
  PlaybackDecision,
  PlaybackDecisionReason,
  RankedCandidate,
  RejectionReason
} from "./ranking";
export {
  scoreCandidate,
  explainScore,
  SCORE_WEIGHTS,
  SCORE_PRECISION,
  UNKNOWABLE_DIMENSIONS,
  CODEC_EFFICIENCY,
  PROTOCOL_ADAPTIVITY,
  BITRATE_KBPS_PER_LINE,
  LATENCY_CEILING_MS
} from "./scoring";
export type { CandidateScore, ScoreComponent, ScoreDimension } from "./scoring";
export {
  selectAudioTrack,
  languageMatch,
  matchesOnlyAcrossScripts,
  normaliseLanguageTag,
  primarySubtag
} from "./audio";
// `ScriptPolicy` is exported because `languageMatch` now REQUIRES one: without
// the type an external caller cannot name the argument it has to pass.
export type { AudioSelection, AudioSelectionReason, AudioRejectionReason, ScriptPolicy } from "./audio";
export * from "./failover";
export { selectSubtitleTrack, withSelectedAudio, SUBTITLE_OUTCOME_BY_REASON } from "./subtitles";
export type {
  SubtitleOutcome,
  SubtitleSelection,
  SubtitleSelectionReason,
  SubtitleRejectionReason
} from "./subtitles";
