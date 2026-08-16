import type { AudioRole, AudioTrack, PlaybackCapabilities } from "@liberty/contracts";

/**
 * Audio track selection.
 *
 * Ranking stream CANDIDATES (see ranking.ts) answers "which stream do we
 * play". This answers "which of that stream's audio tracks do we play", and it
 * is a different problem with different failure modes. A wrong candidate is
 * usually visible -- lower resolution, buffering. A wrong audio track is a film
 * that starts in the wrong language, or in director's commentary, and the
 * viewer often cannot tell whether that was their fault, the provider's, or a
 * bug. So every decision here carries a reason, and the reason distinguishes
 * "you got what you asked for" from each specific way we fell back.
 *
 * The policy is ORDERED, not weighted. Scoring was right for candidates, where
 * resolution genuinely trades off against bitrate and latency. It is wrong
 * here: no amount of extra channels should outrank the viewer's language, and a
 * weighted model makes that trade silently representable. Comparing criteria in
 * a fixed sequence means language can never be outvoted.
 */

export type AudioRejectionReason =
  | "unsupported_audio_codec"
  | "channels_exceed_capability";

/**
 * Why the selected track was selected. `preferred_language_*` means the viewer
 * got a language they asked for; every other value is a fallback and says which
 * one, because "we could not honour your preference" and "you expressed none"
 * are different situations and a player may want to surface them differently.
 */
export type AudioSelectionReason =
  | "preferred_language_exact"
  | "preferred_language_primary_subtag"
  | "fallback_original_language"
  | "fallback_provider_default"
  | "fallback_first_eligible"
  | "no_eligible_tracks";

export interface AudioSelection {
  selected: AudioTrack | null;
  reason: AudioSelectionReason;
  /** Ordered exactly as the policy ranked them; index 0 is `selected`. */
  ordered: AudioTrack[];
  rejected: Array<{ trackId: string; reason: AudioRejectionReason }>;
  /** Human-readable trail, sufficient to debug a surprising choice. */
  explanation: string;
}

/**
 * Role preference, most to least appropriate as a default.
 *
 * `descriptive` (audio description for blind and low-vision viewers) and
 * `commentary` rank last NOT because they matter less, but because neither
 * should ever be selected by accident. A viewer who wants audio description
 * chooses it deliberately; auto-selecting it for someone who did not ask is a
 * broken experience for both groups.
 */
const ROLE_ORDER: readonly AudioRole[] = ["main", "original", "dub", "descriptive", "commentary"];

function roleRank(role: AudioRole): number {
  const index = ROLE_ORDER.indexOf(role);
  // An unknown role sorts last rather than first. A role this build does not
  // recognise is not a role it should silently prefer.
  return index === -1 ? ROLE_ORDER.length : index;
}

/**
 * Codec preference, most to least efficient at equal bitrate.
 *
 * Only consulted after language, role and channels have tied, so this never
 * decides anything a viewer would notice more than the criteria above it.
 */
const CODEC_ORDER = ["opus", "eac3", "aac", "ac3"] as const;

function codecRank(codec: AudioTrack["codec"]): number {
  const index = CODEC_ORDER.indexOf(codec);
  return index === -1 ? CODEC_ORDER.length : index;
}

/** "en-GB" -> "en". Case is already normalised by the contract. */
export function primarySubtag(language: string): string {
  return language.split("-")[0] ?? language;
}

/**
 * How well a track's language matches the viewer's ordered preferences.
 *
 * Returns the index of the matched preference (lower is better) and how exact
 * the match was, so a same-language-different-region track loses to an exact
 * one but still beats an unrelated language. Absent from the list entirely
 * returns null, which sorts after every match regardless of index.
 */
export function languageMatch(
  trackLanguage: string,
  preferred: readonly string[]
): { index: number; exact: boolean } | null {
  const track = trackLanguage.toLowerCase();
  const trackPrimary = primarySubtag(track);

  let bestPrimary: number | null = null;
  for (let i = 0; i < preferred.length; i++) {
    const want = (preferred[i] ?? "").toLowerCase();
    if (!want) continue;
    // Exact wins immediately at the first preference that matches, because the
    // list is ordered: a later exact match must not beat an earlier one.
    if (want === track) return { index: i, exact: true };
    if (bestPrimary === null && primarySubtag(want) === trackPrimary) bestPrimary = i;
  }

  return bestPrimary === null ? null : { index: bestPrimary, exact: false };
}

function firstRejectionReason(
  track: AudioTrack,
  capabilities: PlaybackCapabilities
): AudioRejectionReason | null {
  if (!capabilities.supportedAudioCodecs.includes(track.codec)) return "unsupported_audio_codec";
  // Undefined maxAudioChannels means unconstrained, not stereo. See the contract.
  if (capabilities.maxAudioChannels !== undefined && track.channels > capabilities.maxAudioChannels) {
    return "channels_exceed_capability";
  }
  return null;
}

/**
 * Ordered comparison. Each criterion is only consulted when everything above it
 * has tied, so the priority is structural rather than a matter of weights that
 * could be tuned into outranking each other.
 *
 * The final tiebreak is the track id, so the result never depends on the order
 * the provider happened to list its tracks in. Two runs over the same set
 * always produce the same selection.
 */
function compareTracks(
  a: AudioTrack,
  b: AudioTrack,
  capabilities: PlaybackCapabilities
): number {
  const preferred = capabilities.preferredAudioLanguages ?? [];

  const matchA = languageMatch(a.language, preferred);
  const matchB = languageMatch(b.language, preferred);

  // 1. Any language match beats none.
  if ((matchA === null) !== (matchB === null)) return matchA === null ? 1 : -1;

  if (matchA && matchB) {
    // 2. Earlier position in the preference list wins.
    if (matchA.index !== matchB.index) return matchA.index - matchB.index;
    // 3. At the same position, an exact region match beats a primary-subtag one.
    if (matchA.exact !== matchB.exact) return matchA.exact ? -1 : 1;
  }

  // 4. Role: never let a commentary track win on channel count.
  const roleDelta = roleRank(a.role) - roleRank(b.role);
  if (roleDelta !== 0) return roleDelta;

  // 5. More channels, having already been capped by eligibility.
  if (a.channels !== b.channels) return b.channels - a.channels;

  // 6. The provider's own default, as a hint only -- it is consulted after
  //    everything the viewer expressed, never before.
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;

  // 7. Codec efficiency.
  const codecDelta = codecRank(a.codec) - codecRank(b.codec);
  if (codecDelta !== 0) return codecDelta;

  // 8. Determinism.
  return a.id.localeCompare(b.id);
}

function reasonFor(
  selected: AudioTrack,
  capabilities: PlaybackCapabilities
): AudioSelectionReason {
  const match = languageMatch(selected.language, capabilities.preferredAudioLanguages ?? []);
  if (match) return match.exact ? "preferred_language_exact" : "preferred_language_primary_subtag";
  if (selected.role === "original") return "fallback_original_language";
  if (selected.isDefault) return "fallback_provider_default";
  return "fallback_first_eligible";
}

const REASON_TEXT: Record<AudioSelectionReason, string> = {
  preferred_language_exact: "matched a preferred language exactly",
  preferred_language_primary_subtag: "matched a preferred language by primary subtag",
  fallback_original_language: "no preferred language available; used the original-language track",
  fallback_provider_default: "no preferred language available; used the provider's default track",
  fallback_first_eligible: "no preferred language available; used the highest-ranked eligible track",
  no_eligible_tracks: "no track satisfied the device's codec and channel capabilities"
};

/**
 * Pure and deterministic: same tracks and capabilities in, same selection out,
 * regardless of input ordering.
 */
export function selectAudioTrack(
  tracks: readonly AudioTrack[],
  capabilities: PlaybackCapabilities
): AudioSelection {
  const rejected: AudioSelection["rejected"] = [];
  const eligible: AudioTrack[] = [];

  for (const track of tracks) {
    const reason = firstRejectionReason(track, capabilities);
    if (reason) rejected.push({ trackId: track.id, reason });
    else eligible.push(track);
  }

  if (!eligible.length) {
    return {
      selected: null,
      reason: "no_eligible_tracks",
      ordered: [],
      rejected,
      explanation: `${REASON_TEXT.no_eligible_tracks} (${rejected.length} track(s) rejected)`
    };
  }

  const ordered = [...eligible].sort((a, b) => compareTracks(a, b, capabilities));
  const selected = ordered[0] as AudioTrack;
  const reason = reasonFor(selected, capabilities);

  return {
    selected,
    reason,
    ordered,
    rejected,
    explanation:
      `${selected.id} (${selected.language}, ${selected.role}, ${selected.channels}ch, ` +
      `${selected.codec}): ${REASON_TEXT[reason]}`
  };
}
