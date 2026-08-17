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
  | "no_audio_tracks"
  | "no_auto_selectable_tracks"
  | "no_eligible_tracks";

export interface AudioSelection {
  selected: AudioTrack | null;
  reason: AudioSelectionReason;
  /** Ordered exactly as the policy ranked them; index 0 is `selected`. */
  ordered: AudioTrack[];
  /**
   * Playable, but only on an explicit request: commentary and audio
   * description. Returned rather than discarded so a player can offer them;
   * never a candidate for automatic selection.
   */
  manualOnly: AudioTrack[];
  rejected: Array<{ trackId: string; reason: AudioRejectionReason }>;
  /** Human-readable trail, sufficient to debug a surprising choice. */
  explanation: string;
}

/**
 * Role preference, most to least appropriate as a default.
 *
 * `original` outranks `main`, which looks wrong until you notice when role is
 * consulted at all: only after language has tied. If the viewer's language
 * matched, every remaining track is in that language and the two are
 * interchangeable. If NOTHING matched, the contract states that the
 * original-language track is the correct fallback -- and with `main` ranked
 * first that outcome was unreachable whenever a main mix existed, which is
 * nearly always, making `fallback_original_language` dead code the tests never
 * exercised because they only ever paired `original` against `dub`.
 *
 * `descriptive` (audio description for blind and low-vision viewers) and
 * `commentary` rank last NOT because they matter less, but because neither
 * should ever be selected by accident. A viewer who wants audio description
 * chooses it deliberately; auto-selecting it for someone who did not ask is a
 * broken experience for both groups.
 */
const ROLE_ORDER: readonly AudioRole[] = ["original", "main", "dub", "descriptive", "commentary"];

/**
 * Roles eligible for AUTOMATIC selection. Ranking was not enough.
 *
 * Ordering commentary and description last only protected them once language
 * had tied. Language is compared first, so a French commentary track still beat
 * a Japanese original for a viewer preferring French -- and if commentary or
 * description were the only technically playable tracks, one of them was
 * necessarily selected. The comment claimed "never auto-selected" while the
 * code guaranteed nothing of the kind.
 *
 * They are now outside the automatic pool entirely and returned separately, so
 * a player can still offer them. That is the honest arrangement: a viewer who
 * wants audio description picks it, and nobody is given it by accident.
 */
const AUTO_SELECTABLE_ROLES: readonly AudioRole[] = ["original", "main", "dub"];

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

/**
 * "en-GB" -> "en".
 *
 * Lowercases here rather than trusting the contract to have done it. The
 * schema's `.transform()` only runs on `.parse()`, and `selectAudioTrack` takes
 * the TYPE, not parsed output -- so a provider adapter constructing an
 * AudioTrack literally never invokes the transform, and `z.infer` cannot tell
 * normalised from raw. This is exported, so an external caller passing "EN-GB"
 * would otherwise get "EN", which never equals an internally derived "en".
 */
export function primarySubtag(language: string): string {
  const lower = language.toLowerCase();
  return lower.split("-")[0] ?? lower;
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
): { groupIndex: number; exactIndex: number | null } | null {
  const track = trackLanguage.toLowerCase();
  const trackPrimary = primarySubtag(track);

  /*
   * TWO independent coordinates, because one number cannot carry both facts.
   *
   * `groupIndex` is where this track's LANGUAGE first appears in the list.
   * `exactIndex` is where this track's exact tag appears, or null.
   *
   * The first attempt returned the exact preference's own index for exact
   * matches and the group's first index otherwise, so the field meant different
   * things in different branches: with ["en-us","en-gb"], an "en-gb" track
   * scored {index:1,exact:true} while an unrequested "en-au" scored
   * {index:0,exact:false}, and comparing index first meant en-AU beat the
   * en-GB the viewer had explicitly listed.
   *
   * Collapsing everything to the group index fixed that and introduced the
   * mirror image: with the same preferences, "en-us" and "en-gb" both became
   * {index:0,exact:true}, tying on language so channels or codec could hand the
   * win to en-GB even though the viewer put en-US first. Preference ORDER is
   * meaningful, and that ordering was being discarded.
   *
   * Keeping both coordinates preserves both behaviours at once: language group
   * decides first, an exact match beats a mere subtag match within the group,
   * and between two exact matches the earlier preference wins.
   */
  let groupIndex: number | null = null;
  let exactIndex: number | null = null;

  for (let i = 0; i < preferred.length; i++) {
    const want = (preferred[i] ?? "").trim().toLowerCase();
    if (!want || primarySubtag(want) !== trackPrimary) continue;
    if (groupIndex === null) groupIndex = i;
    if (want === track && exactIndex === null) exactIndex = i;
  }

  return groupIndex === null ? null : { groupIndex, exactIndex };
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
    // 2. Whichever LANGUAGE the viewer listed first.
    if (matchA.groupIndex !== matchB.groupIndex) return matchA.groupIndex - matchB.groupIndex;

    // 3. Within that language, an exact tag match beats a subtag-only one.
    const exactA = matchA.exactIndex !== null;
    const exactB = matchB.exactIndex !== null;
    if (exactA !== exactB) return exactA ? -1 : 1;

    // 4. Between two exact matches, the earlier preference wins. Without this
    //    the viewer's ordering of regional variants is silently discarded and
    //    a later criterion decides something they had already decided.
    if (exactA && exactB && matchA.exactIndex !== matchB.exactIndex) {
      return (matchA.exactIndex as number) - (matchB.exactIndex as number);
    }
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

  /*
   * 8. Determinism -- by CODE POINT, not localeCompare.
   *
   * localeCompare without an explicit locale uses the host's collation, so the
   * same tracks on a device with Swedish collation can order differently from
   * one with en-US. "Same input, same output" would then be false across
   * devices, which is precisely the property this task exists to provide.
   */
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Why the winner won -- derived from the criterion that ACTUALLY decided it.
 *
 * This used to read the winner's own fields and infer a reason from them, which
 * let it attribute the choice to something that played no part. With
 * preferences ["fr"] and tracks {de, 8ch, isDefault} versus {it, 2ch}, the
 * German track wins on CHANNELS at step 5 and step 6 is never reached -- yet
 * the old code saw `isDefault: true` and reported "used the provider's default
 * track". A support engineer would go and inspect the manifest's default flag
 * for a decision the channel count made. A reason trail that names the wrong
 * cause is worse than none, because it is trusted.
 *
 * So the runner-up is compared against the winner criterion by criterion, and
 * the first one that separates them is the reason. With a single eligible track
 * nothing was chosen over anything, and the honest answer is first-eligible.
 */
function reasonFor(
  selected: AudioTrack,
  runnerUp: AudioTrack | undefined,
  capabilities: PlaybackCapabilities
): AudioSelectionReason {
  const preferred = capabilities.preferredAudioLanguages;
  const match = languageMatch(selected.language, preferred);
  if (match) {
    return match.exactIndex !== null
      ? "preferred_language_exact"
      : "preferred_language_primary_subtag";
  }

  // No language matched. Which fallback criterion actually broke the tie?
  if (!runnerUp) return "fallback_first_eligible";

  if (roleRank(selected.role) !== roleRank(runnerUp.role)) {
    return selected.role === "original" ? "fallback_original_language" : "fallback_first_eligible";
  }
  if (selected.channels !== runnerUp.channels) return "fallback_first_eligible";
  if (selected.isDefault !== runnerUp.isDefault) return "fallback_provider_default";
  return "fallback_first_eligible";
}

const REASON_TEXT: Record<AudioSelectionReason, string> = {
  preferred_language_exact: "matched a preferred language exactly",
  preferred_language_primary_subtag: "matched a preferred language by primary subtag",
  fallback_original_language: "no preferred language available; used the original-language track",
  fallback_provider_default: "no preferred language available; used the provider's default track",
  fallback_first_eligible: "no preferred language available; used the highest-ranked eligible track",
  no_audio_tracks: "the stream offered no audio tracks at all",
  no_auto_selectable_tracks:
    "only commentary or audio-description tracks are playable; those require an explicit choice",
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

  // Sorted, so the whole result is order-invariant. `ordered` and `selected`
  // were already deterministic; leaving `rejected` in provider order made the
  // claim above it false for the AudioSelection as a whole.
  rejected.sort((a, b) => (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0));

  // Split AFTER eligibility, so a commentary track the device cannot decode is
  // still reported as a codec rejection rather than silently reclassified.
  const manualOnly = eligible.filter((t) => !AUTO_SELECTABLE_ROLES.includes(t.role));
  const autoSelectable = eligible.filter((t) => AUTO_SELECTABLE_ROLES.includes(t.role));

  if (eligible.length && !autoSelectable.length) {
    return {
      selected: null,
      reason: "no_auto_selectable_tracks",
      ordered: [],
      manualOnly,
      rejected,
      explanation:
        `${REASON_TEXT.no_auto_selectable_tracks} ` +
        `(${manualOnly.map((t) => t.id).join(", ")})`
    };
  }

  if (!eligible.length) {
    /*
     * "No tracks were offered" and "tracks were offered but none was playable"
     * are different faults -- a provider/manifest defect versus a device
     * capability limit -- and reporting the first as the second sends whoever
     * debugs it to the wrong place. This is the same conflation the header
     * comment argues against for language fallbacks.
     */
    const reason: AudioSelectionReason = tracks.length === 0 ? "no_audio_tracks" : "no_eligible_tracks";
    return {
      selected: null,
      reason,
      ordered: [],
      manualOnly,
      rejected,
      explanation: `${REASON_TEXT[reason]} (${rejected.length} track(s) rejected)`
    };
  }

  const ordered = [...autoSelectable].sort((a, b) => compareTracks(a, b, capabilities));
  const selected = ordered[0] as AudioTrack;
  const reason = reasonFor(selected, ordered[1], capabilities);

  return {
    selected,
    reason,
    ordered,
    manualOnly,
    rejected,
    explanation:
      `${selected.id} (${selected.language}, ${selected.role}, ${selected.channels}ch, ` +
      `${selected.codec}): ${REASON_TEXT[reason]}`
  };
}
