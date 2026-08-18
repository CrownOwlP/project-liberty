import {
  unknownMediaFacts,
  type PlaybackCapabilities,
  type StreamCandidate
} from "@liberty/contracts/domains/playback";
import type { VideoCodec } from "@liberty/contracts/shared/codecs";
import type { MediaFact } from "@liberty/contracts/shared/media-facts";

/**
 * Candidate score model (PL-0201, extended for unknown metadata by PL-0205).
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
 *
 * WHAT AN UNKNOWN DIMENSION CONTRIBUTES: zero, with the 100-point ceiling left
 * exactly where it is. The two available treatments are arithmetically
 * different, and the difference is the whole decision:
 *
 *   (a) contribute 0 and do not touch the ceiling. A candidate that states no
 *       codec, height or bitrate can reach at most health(30) +
 *       protocolAdaptivity(8) = 38, minus its latency penalty.
 *   (b) drop the dimension and renormalise the surviving weights back to 100 —
 *       score the candidate on what IS known, then scale the result up.
 *
 * (b) is REJECTED. Renormalising asserts "the facts we do not have are as good
 * as the facts we do", which is the fabricated neutral measurement this task
 * exists to remove — reached by division rather than by a placeholder constant,
 * and with a worse consequence: a stream that states nothing at all could reach
 * 100 and outrank a measured 2160p HEVC candidate. Letting an unverified stream
 * beat a verified one on the strength of the verification it lacks is the one
 * outcome the ranking must never produce.
 *
 * (a) is CHOSEN. The total is a SUM against a fixed ceiling, not an average, so
 * the ceiling reads as "how much we were able to establish about this stream".
 * Unknown earns nothing because nothing was established. That does rank unknowns
 * low, deliberately — but it is a ranking consequence, never a rejection. An
 * unverified candidate stays eligible and is selected whenever it is the best
 * thing available, which is precisely when a viewer needs it to be.
 *
 * `attainableTotal` publishes the ceiling this candidate could actually have
 * reached, so a reader sees 34 out of 38 instead of a bare 34 against an implied
 * 100. It is REPORTING ONLY. It is not a divisor, and dividing the total by it
 * would silently implement (b).
 *
 * `audioCodec` has no score dimension — nothing here measures audio quality — so
 * an unknown audio codec costs no points. It is still reported in `unknownFacts`
 * and it still makes the candidate's compatibility unverified in ranking.ts,
 * because the fact that matters about it is decodability, not rank.
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
  /**
   * Whether this dimension was actually measured.
   *
   * A separate flag rather than "infer it from raw === 0", because a measured
   * dimension can legitimately score zero — a bitrate far enough from target
   * clamps to 0 on a stated number — and a reason trail that cannot tell "we
   * measured this and it was bad" from "we were never told" is not a reason
   * trail. This is the machine-readable half of that distinction; `explanation`
   * and `missingFacts` are the readable ones.
   */
  known: boolean;
  /** Which contract facts were absent. Always empty when `known`. */
  missingFacts: readonly MediaFact[];
  explanation: string;
}

export interface CandidateScore {
  total: number;
  components: ScoreComponent[];
  /** Facts the candidate never stated, in `MEDIA_FACTS` order. */
  unknownFacts: readonly MediaFact[];
  /**
   * Positive weight this candidate was in a position to earn: 100 when
   * everything was stated, less when it was not. Reporting only — see the
   * header. Penalties are excluded because a penalty is not credit.
   */
  attainableTotal: number;
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

/**
 * Dimensions that can be UNMEASURABLE, because the facts they read are
 * `MEDIA_FACTS` a provider may not state.
 *
 * `health`, `protocolAdaptivity` and `latency` are absent from this list on
 * purpose: their inputs are things the platform observes for itself — a
 * measured round trip, a success/failure record, the shape of the URL — not
 * claims a provider hands us, so they are always available.
 *
 * Every dimension listed here MUST carry a positive weight, and a test asserts
 * it. An unmeasurable dimension contributes zero; against a positive weight that
 * reads as "earned no credit", but against a penalty it would read as "escaped
 * the penalty" and a candidate would be REWARDED for withholding information.
 * If a penalty dimension ever becomes nullable it needs the opposite rule —
 * charge the full penalty — not this one.
 */
export const UNKNOWABLE_DIMENSIONS: readonly ScoreDimension[] = [
  "resolution",
  "bitrateEfficiency",
  "codecEfficiency"
];

/**
 * Relative compression efficiency at equal perceptual quality.
 *
 * Keyed by `VideoCodec`, not by `StreamCandidate["videoCodec"]`, which now
 * includes `null` and cannot be a record key at all. The type change is the
 * point: an unknown codec has no efficiency to look up, so the lookup must not
 * be reachable with one.
 */
export const CODEC_EFFICIENCY: Record<VideoCodec, number> = {
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
    known: true,
    missingFacts: [],
    explanation
  };
}

/**
 * A dimension the candidate gave us nothing to measure.
 *
 * `weighted` is written as the literal `0` rather than computed from
 * `raw * weight`, because `0 * -15` is negative zero in IEEE arithmetic and
 * `Object.is(-0, 0)` is false — a published breakdown containing `-0` would fail
 * its own reconstruction invariant under strict equality. No unknowable
 * dimension carries a negative weight today (see `UNKNOWABLE_DIMENSIONS`), so
 * this is belt and braces rather than a live bug, but it costs nothing and the
 * failure it prevents would be extremely confusing to read.
 *
 * The explanation names the absent facts rather than describing the dimension,
 * so a reader of the trail learns what to go and fix.
 */
function unknownComponent(
  dimension: ScoreDimension,
  missingFacts: readonly MediaFact[]
): ScoreComponent {
  return {
    dimension,
    weight: SCORE_WEIGHTS[dimension],
    raw: 0,
    weighted: 0,
    known: false,
    missingFacts,
    explanation:
      `${missingFacts.join(" and ")} not stated by the provider; ` +
      "this dimension earns nothing rather than an assumed value"
  };
}

/**
 * The subset of `facts` this candidate did not state, in `MEDIA_FACTS` order.
 *
 * Filtered from the contract's own canonical list rather than assembled by
 * pushing onto an array, so the published `missingFacts` never depends on the
 * order the checks happen to be written in.
 */
function missingAmong(candidate: StreamCandidate, facts: readonly MediaFact[]): MediaFact[] {
  return unknownMediaFacts(candidate).filter((fact) => facts.includes(fact));
}

function resolutionComponent(
  candidate: StreamCandidate,
  capabilities: PlaybackCapabilities
): ScoreComponent {
  const { height } = candidate;
  if (height === null) return unknownComponent("resolution", ["height"]);
  return component(
    "resolution",
    Math.min(height, capabilities.maxHeight) / capabilities.maxHeight,
    `${height}p against a ${capabilities.maxHeight}p ceiling`
  );
}

/**
 * Needs BOTH numbers, and says so when either is missing.
 *
 * The target is derived from the height, so a stated bitrate with no stated
 * height is still unmeasurable: 8100kbps is close to ideal for 1080p and thin
 * for 2160p, and with no height there is no distance to compute. Reporting only
 * `bitrateKbps` as the missing fact in that case would send a reader looking for
 * the wrong thing, so every absent input is named.
 */
function bitrateComponent(candidate: StreamCandidate): ScoreComponent {
  const { height, bitrateKbps } = candidate;
  if (height === null || bitrateKbps === null) {
    return unknownComponent(
      "bitrateEfficiency",
      missingAmong(candidate, ["height", "bitrateKbps"])
    );
  }

  const target = height * BITRATE_KBPS_PER_LINE;
  const distance = target > 0 ? Math.abs(bitrateKbps - target) / target : 1;
  return component(
    "bitrateEfficiency",
    1 - Math.min(distance, 1),
    `${bitrateKbps}kbps vs ${Math.round(target)}kbps target for ${height}p`
  );
}

function codecComponent(candidate: StreamCandidate): ScoreComponent {
  const { videoCodec } = candidate;
  if (videoCodec === null) return unknownComponent("codecEfficiency", ["videoCodec"]);
  return component(
    "codecEfficiency",
    CODEC_EFFICIENCY[videoCodec],
    `${videoCodec} compression efficiency`
  );
}

export function scoreCandidate(
  candidate: StreamCandidate,
  capabilities: PlaybackCapabilities
): CandidateScore {
  const components: ScoreComponent[] = [
    resolutionComponent(candidate, capabilities),
    component(
      "health",
      candidate.healthScore,
      `provider ${candidate.providerId} health ${candidate.healthScore.toFixed(2)}`
    ),
    bitrateComponent(candidate),
    codecComponent(candidate),
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
    components,
    unknownFacts: unknownMediaFacts(candidate),
    attainableTotal: components.reduce(
      (sum, item) => (item.known && item.weight > 0 ? sum + item.weight : sum),
      0
    )
  };
}

/**
 * Human-readable one-line trail, ordered by absolute contribution.
 *
 * An unmeasured dimension prints `=unknown`, not `=0`. Those are the same number
 * and completely different facts: the first says nobody told us, the second says
 * we looked and it was bad. Product invariant 4 is about being able to debug a
 * selection, and "why is codecEfficiency zero?" has two answers that lead to two
 * different investigations.
 *
 * Equal magnitudes tie-break on the dimension name. Every unknown dimension sits
 * at exactly zero, so without an explicit tiebreak their relative order would be
 * whatever order `scoreCandidate` happens to build the array in — stable, but
 * incidental, and it would move the day a dimension is inserted. Determinism in
 * this package is a stated guarantee, not a happy accident.
 */
export function explainScore(score: CandidateScore): string {
  return [...score.components]
    .sort((a, b) => {
      const byMagnitude = Math.abs(b.weighted) - Math.abs(a.weighted);
      if (byMagnitude !== 0) return byMagnitude;
      return a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0;
    })
    .map((item) => `${item.dimension}=${item.known ? item.weighted : "unknown"}`)
    .join(" ");
}
