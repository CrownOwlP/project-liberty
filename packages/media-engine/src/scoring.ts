import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts";

/**
 * Candidate score model (PL-0201).
 *
 * Every dimension is a pure function of (candidate, capabilities). No clocks,
 * no randomness, no I/O, no ambient state — the same inputs always produce the
 * same score, which is what makes playback decisions reproducible in a bug
 * report and safe to regression-test.
 *
 * Each dimension returns a `raw` value normalized to [0, 1] and a `weighted`
 * contribution of `raw * weight`. Penalties carry a negative weight. The total
 * is the sum of weighted contributions, so a score is always fully explained by
 * its components and the components always reconstruct the total.
 */

export type ScoreDimension =
  | "resolution"
  | "health"
  | "codecEfficiency"
  | "protocolAdaptivity"
  | "bitrateEfficiency"
  | "latency";

export interface ScoreComponent {
  dimension: ScoreDimension;
  weight: number;
  raw: number;
  weighted: number;
  explanation: string;
}

export interface CandidateScore {
  total: number;
  components: ScoreComponent[];
}

/** Decimal places every stored score value is rounded to. */
export const SCORE_PRECISION = 4;

/**
 * Positive weights sum to 100; `latency` is the only penalty. Changing any
 * weight is a deliberate product decision — see docs/DECISIONS.md.
 *
 * Weights must remain integers. `weighted` is derived from the *rounded* `raw`,
 * so with an integer weight the exact invariant
 * `round(raw * weight) === weighted` holds for every component. (Plain IEEE
 * equality `raw * weight === weighted` is *not* guaranteed — the product can
 * land a fraction of an ulp off the stored value — which is why the invariant
 * is stated at SCORE_PRECISION.)
 */
export const SCORE_WEIGHTS: Record<ScoreDimension, number> = {
  resolution: 40,
  health: 30,
  bitrateEfficiency: 12,
  codecEfficiency: 10,
  protocolAdaptivity: 8,
  latency: -15
};

/** Relative compression efficiency at equal perceptual quality. */
export const CODEC_EFFICIENCY: Record<StreamCandidate["videoCodec"], number> = {
  av1: 1,
  hevc: 0.85,
  vp9: 0.7,
  h264: 0.5
};

/** Adaptive protocols can shift rendition mid-stream; progressive cannot. */
export const PROTOCOL_ADAPTIVITY: Record<StreamCandidate["protocol"], number> = {
  hls: 1,
  dash: 1,
  https: 0.5
};

/**
 * Target bitrate heuristic in kbps for a given rendition height. Both
 * under-provisioned (artefacts) and over-provisioned (wasted bandwidth,
 * rebuffer risk) streams are penalised, so this is a distance, not a maximum.
 */
export const BITRATE_KBPS_PER_LINE = 7.5;

/** Latency at or above this value scores the full penalty. */
export const LATENCY_CEILING_MS = 1000;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function round(value: number): number {
  return Number(value.toFixed(SCORE_PRECISION));
}

function component(
  dimension: ScoreDimension,
  raw: number,
  explanation: string
): ScoreComponent {
  const weight = SCORE_WEIGHTS[dimension];
  // Round first, then derive `weighted` from the rounded value. Deriving from
  // the unrounded value would leave the published `raw` and `weighted`
  // inconsistent with each other, so the breakdown would not reconstruct the
  // published total at SCORE_PRECISION.
  const storedRaw = round(clamp01(raw));
  return {
    dimension,
    weight,
    raw: storedRaw,
    weighted: round(storedRaw * weight),
    explanation
  };
}

export function scoreCandidate(
  candidate: StreamCandidate,
  capabilities: PlaybackCapabilities
): CandidateScore {
  const resolutionRatio = Math.min(candidate.height, capabilities.maxHeight) / capabilities.maxHeight;
  const targetBitrate = candidate.height * BITRATE_KBPS_PER_LINE;
  const bitrateDistance = targetBitrate > 0
    ? Math.abs(candidate.bitrateKbps - targetBitrate) / targetBitrate
    : 1;

  const components: ScoreComponent[] = [
    component(
      "resolution",
      resolutionRatio,
      `${candidate.height}p against a ${capabilities.maxHeight}p ceiling`
    ),
    component(
      "health",
      candidate.healthScore,
      `provider ${candidate.providerId} health ${candidate.healthScore.toFixed(2)}`
    ),
    component(
      "bitrateEfficiency",
      1 - Math.min(bitrateDistance, 1),
      `${candidate.bitrateKbps}kbps vs ${Math.round(targetBitrate)}kbps target for ${candidate.height}p`
    ),
    component(
      "codecEfficiency",
      CODEC_EFFICIENCY[candidate.videoCodec],
      `${candidate.videoCodec} compression efficiency`
    ),
    component(
      "protocolAdaptivity",
      PROTOCOL_ADAPTIVITY[candidate.protocol],
      `${candidate.protocol} ${PROTOCOL_ADAPTIVITY[candidate.protocol] === 1 ? "supports" : "does not support"} mid-stream adaptation`
    ),
    component(
      "latency",
      Math.min(candidate.estimatedLatencyMs / LATENCY_CEILING_MS, 1),
      `${candidate.estimatedLatencyMs}ms estimated startup latency`
    )
  ];

  return {
    total: round(components.reduce((sum, item) => sum + item.weighted, 0)),
    components
  };
}

/** Human-readable one-line trail, ordered by absolute contribution. */
export function explainScore(score: CandidateScore): string {
  return [...score.components]
    .sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted))
    .map((item) => `${item.dimension}=${item.weighted}`)
    .join(" ");
}
