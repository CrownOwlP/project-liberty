import {
  unknownMediaFacts,
  type CompatibilityConfidence,
  type PlaybackCapabilities,
  type StreamCandidate
} from "@liberty/contracts/domains/playback";
import type { MediaFact } from "@liberty/contracts/shared/media-facts";
import { PLAYABLE_CONTENT_RIGHTS, type ContentRights } from "@liberty/contracts/shared/rights";
import { type CandidateScore, explainScore, scoreCandidate } from "./scoring";

export interface RankedCandidate {
  candidate: StreamCandidate;
  score: number;
  reason: string;
  breakdown: CandidateScore["components"];
  /**
   * Whether successful decode has been ESTABLISHED for this candidate.
   *
   * Carried on every ranked entry, not just internally, because a player and a
   * failover policy both need it downstream: `unverified` means the candidate
   * survived eligibility by not being disqualified rather than by being
   * qualified, so a decode error here is a foreseeable outcome and not evidence
   * that the provider has gone bad. Without this on the output, a successful
   * selection is indistinguishable from a verified one.
   */
  compatibility: CompatibilityConfidence;
  /**
   * Contract facts the provider never stated, in `MEDIA_FACTS` order. Empty for
   * a fully described candidate. This is the machine-readable form of the
   * missing-facts trail; `reason` and `breakdown[].explanation` are the readable
   * ones.
   */
  unknownFacts: readonly MediaFact[];
}

/**
 * Why the decision came out the way it did.
 *
 * `highest_eligible_score_unverified_compatibility` is a separate value rather
 * than a flag beside `highest_eligible_score`, so that a caller pattern-matching
 * on the reason cannot handle "we picked something" without noticing that what
 * we picked has not been shown to play. The distinction the architecture
 * requires is authorized != known-compatible != attemptable, and a single
 * success reason collapses the last two.
 */
export type PlaybackDecisionReason =
  | "highest_eligible_score"
  | "highest_eligible_score_unverified_compatibility"
  | "no_eligible_candidates";

export interface PlaybackDecision {
  selected: RankedCandidate | null;
  ranked: RankedCandidate[];
  rejected: Array<{ candidateId: string; reason: RejectionReason }>;
  reason: PlaybackDecisionReason;
}

/**
 * Rights boundary. Only content the platform is actually entitled to serve may
 * enter playback resolution. This is an explicit allowlist rather than a
 * denylist so that any new rights value is non-playable until it is reviewed.
 *
 * AN ALIAS, NOT A SECOND ALLOWLIST. The members live in
 * `@liberty/contracts/shared/rights`, which is where every other surface that
 * gates on rights reads them: the provider SDK, the catalog and the playback
 * session route all consult `PLAYABLE_CONTENT_RIGHTS`. This module used to
 * declare its own copy with the same three values, which meant the adapter that
 * ESTABLISHED authorization and the code that RE-CHECKS it agreed by
 * coincidence rather than by construction -- a fourth rights value added to one
 * list and not the other would either admit a stream the SDK refused or refuse
 * one it admitted, and nothing would fail until a viewer saw the wrong answer.
 * The contracts module's own comment names this exact failure ("a
 * surface-specific home for a cross-surface allowlist is how a second one gets
 * written").
 *
 * Bound as a value under the engine's historical name rather than written as
 * `export ... from`, because `firstRejectionReason` below reads it and a
 * re-export creates no local binding.
 */
export const PLAYABLE_RIGHTS: readonly ContentRights[] = PLAYABLE_CONTENT_RIGHTS;

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
 *
 * UNKNOWN IS NEITHER A PASS NOR A FAIL (PL-0205). A `null` codec is not compared
 * against the supported list and a `null` height is not compared against the
 * ceiling, because there is nothing to compare them to. Rejecting an unstated
 * codec as `unsupported_video_codec` would report a device limitation nobody has
 * demonstrated, and rejecting an unstated height as
 * `resolution_exceeds_capability` would refuse a stream over a measurement that
 * does not exist — the mirror-image error of the adapter defaulting to h264 and
 * thereby claiming compatibility. Both directions invent a fact.
 *
 * No existing rejection is softened. A STATED codec outside the supported list
 * is still refused, a STATED height above the ceiling is still refused, and a
 * candidate carrying both an unstated codec and an unplayable rights value still
 * reports rights first. What survives on an unknown fact is not admitted as
 * compatible; it is admitted as attemptable, which `compatibilityOf` labels and
 * `scoreCandidate` charges for in the ranking.
 */
function firstRejectionReason(
  candidate: StreamCandidate,
  capabilities: PlaybackCapabilities
): RejectionReason | null {
  if (!PLAYABLE_RIGHTS.includes(candidate.rights)) return "rights_not_playable";
  if (candidate.videoCodec !== null && !capabilities.supportedVideoCodecs.includes(candidate.videoCodec)) {
    return "unsupported_video_codec";
  }
  if (candidate.audioCodec !== null && !capabilities.supportedAudioCodecs.includes(candidate.audioCodec)) {
    return "unsupported_audio_codec";
  }
  if (candidate.height !== null && candidate.height > capabilities.maxHeight) {
    return "resolution_exceeds_capability";
  }
  if (candidate.healthScore < PROVIDER_HEALTH_FLOOR) return "provider_health_below_floor";
  return null;
}

/**
 * Only the codecs decide this.
 *
 * An unknown height or bitrate means we cannot say how GOOD a stream is; an
 * unknown codec means we cannot say whether it plays at all, and those are
 * different problems for a player to plan around. Failover needs to know that a
 * decode error was foreseeable, not that a resolution was unlabelled.
 *
 * By the time this runs, a stated codec is necessarily a supported one —
 * eligibility rejected the rest — so "both stated" is exactly "both checked
 * against the device". The capability lists are deliberately NOT re-read here:
 * two places deciding compatibility is two places that can disagree, and the
 * label would then contradict the rejection list it sits beside.
 */
function compatibilityOf(candidate: StreamCandidate): CompatibilityConfidence {
  return candidate.videoCodec === null || candidate.audioCodec === null
    ? "unverified"
    : "verified";
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

  /*
   * Sorted by id, so the WHOLE decision is input-order invariant.
   *
   * `ranked` and `selected` were already deterministic; `rejected` was left in
   * provider order, which made that claim false for the PlaybackDecision as a
   * whole — two resolutions of the same candidate set would diff as different
   * responses. Identical defect to the one already fixed in the audio policy,
   * and by CODE POINT for the same reason: localeCompare without an explicit
   * locale uses the host's collation, so the same inputs would order differently
   * on different machines.
   */
  rejected.sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));

  const ranked = eligible
    .map((candidate) => {
      const score = scoreCandidate(candidate, capabilities);
      const unknownFacts = unknownMediaFacts(candidate);
      return {
        candidate,
        score: score.total,
        /*
         * The missing facts are appended to the trail, not left to the
         * breakdown alone. `explainScore` can only mention dimensions, and
         * `audioCodec` has no dimension — an unknown audio codec would
         * otherwise be invisible in the human-readable reason while being the
         * very thing that made the candidate unverified.
         */
        reason: unknownFacts.length > 0
          ? `${explainScore(score)} | unverified: ${unknownFacts.join(", ")} not stated`
          : explainScore(score),
        breakdown: score.components,
        compatibility: compatibilityOf(candidate),
        unknownFacts
      };
    })
    /*
     * Deterministic: score descending, then fewer unknown facts, then candidate
     * id ascending so equal scores never depend on input ordering.
     *
     * The unknown-facts tiebreak is not decoration. Score alone does not
     * guarantee that a measured candidate beats an otherwise-identical unmeasured
     * one: a stated bitrate far enough from target clamps `bitrateEfficiency` to
     * zero, exactly like an unstated one, so two candidates can tie on total
     * while only one of them was actually verified. The architecture requires the
     * measured stream to win, so it is stated explicitly here rather than left to
     * an arithmetic coincidence that a future weight change could remove.
     *
     * The id tiebreak is by CODE POINT, not localeCompare. Without an explicit
     * locale that uses the host's collation, so two devices could rank the same
     * candidates differently -- and candidate ids are not contractually
     * restricted to ASCII. The architecture requires deterministic playback for
     * identical inputs, which this quietly violated. Same defect was found and
     * removed from the audio policy; fixed here rather than left inconsistent.
     */
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.unknownFacts.length !== b.unknownFacts.length) {
        return a.unknownFacts.length - b.unknownFacts.length;
      }
      return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
    });

  const selected = ranked[0] ?? null;

  return {
    selected,
    ranked,
    rejected,
    reason: selected === null
      ? "no_eligible_candidates"
      : selected.compatibility === "verified"
        ? "highest_eligible_score"
        : "highest_eligible_score_unverified_compatibility"
  };
}
