import type { AudioRole, AudioTrack } from "@liberty/contracts/domains/audio";
import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";

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
 * The normalisation every language comparison in this package runs first.
 *
 * Trims AND lower-cases, and does so on BOTH sides of every comparison. Neither
 * is trusting the contract to have done it: the schema's `.transform()` only
 * runs on `.parse()`, and `selectAudioTrack` takes the TYPE, not parsed output,
 * so a provider adapter constructing an AudioTrack literal never invokes the
 * transform and `z.infer` cannot tell normalised from raw. This function and
 * `primarySubtag` are exported besides, so a caller passing "EN-GB" reaches
 * them directly.
 *
 * SYMMETRIC, which it was not. The preference side was trimmed and the track
 * side only lower-cased, so two logically equivalent raw values got different
 * answers depending on which side of the comparison they arrived on: a manifest
 * tag `"en-gb "` still shared a primary subtag with `en` but lost its EXACT
 * match against an `en-gb` preference, and `" en"` failed to match anything at
 * all because the padding landed inside the primary subtag. Nothing in the
 * result explained either outcome. The asymmetry was not a safeguard: a padded
 * tag is malformed input rather than hostile input, and declining to trim it
 * protected nothing that lower-casing the very same value did not already
 * concede.
 */
export function normaliseLanguageTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** "en-GB" -> "en", and " EN-GB " -> "en"; see `normaliseLanguageTag`. */
export function primarySubtag(language: string): string {
  const normalised = normaliseLanguageTag(language);
  return normalised.split("-")[0] ?? normalised;
}

/** Exactly three ASCII letters: the SHAPE of a BCP-47 extended-language subtag. */
const EXTLANG_SUBTAG = /^[a-z]{3}$/;

/**
 * The SPOKEN language a tag names, which is not always its primary subtag.
 *
 * `primarySubtag` answers a question about string structure. This answers the
 * question the matcher actually needs -- which language will come out of the
 * speakers -- and the two differ exactly where a MACROLANGUAGE has been narrowed
 * by an extended-language subtag.
 *
 * WHY THIS EXISTS (PL-0206). `zh` is a macrolanguage. RFC 5646 notes that the
 * languages it encompasses are generally NOT mutually intelligible when spoken,
 * and Cantonese and Mandarin are the standing example. Reducing `zh-yue` and
 * `zh-cmn` to `zh` made them the same language to this comparator, so a viewer
 * who asked for Mandarin could be handed Cantonese and told, in the reason trail,
 * that their preferred language had been matched. That is not a regional
 * fallback and it is not a script conflict; it is the wrong language, reported as
 * a success. gpt-architect carved this out of the PL-0203 approval for that
 * reason, and was explicit that it is a spoken-language problem rather than
 * another script rule.
 *
 * DERIVED FROM SHAPE, LIKE `scriptSubtag`, AND FOR THE SAME REASON -- no registry
 * is vendored into this package. BCP-47 spells a language subtag as `2*3ALPHA
 * ["-" extlang]`, an extlang as exactly `3ALPHA`, a region as two letters or
 * three DIGITS, and a script as four letters. So three ASCII letters immediately
 * after a two- or three-letter primary is unambiguously an extlang: no region,
 * script or variant can take that shape in that position. RFC 5646 permanently
 * invalidates the second and third extlang positions, so there is at most one to
 * find.
 *
 * THE COLLAPSE RUNS TOWARD THE SPECIFIC, NOT THE GENERAL. `zh-yue` becomes `yue`
 * rather than `zh`, so the prefixed and bare spellings of one language are the
 * same language in both directions -- `cmn` and `zh-cmn` are one, `yue` and
 * `zh-yue` are one -- and the equivalence survives whatever region or script
 * follows, because those subtags are not consulted here at all. A bare `zh` stays
 * `zh`: it names the macrolanguage and nothing narrower, so it is neither
 * Cantonese nor Mandarin, and treating it as either would invent a preference the
 * viewer did not express. That is the same asymmetry the script rule already
 * uses, where a tag naming no script conflicts with nothing.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not know which primary subtags are
 * macrolanguages, and it does not need to: a tag either narrows itself with an
 * extlang or it does not. The cost is that `zh` and `cmn` are simply different
 * languages here rather than related ones, which is why the boundary is REPORTED
 * separately by `matchesOnlyAcrossMacrolanguage` instead of being silently
 * absorbed into a fallback strength.
 */
export function spokenLanguage(language: string): string {
  const parts = normaliseLanguageTag(language).split("-");
  const primary = parts[0];
  if (primary === undefined) return "";
  if (primary.length < 2 || primary.length > 3) return primary;

  const second = parts[1];
  if (second !== undefined && EXTLANG_SUBTAG.test(second)) return second;
  return primary;
}

/** Exactly four ASCII letters: the SHAPE of a BCP-47 script subtag. */
const SCRIPT_SUBTAG = /^[a-z]{4}$/;

/**
 * The script a tag EXPLICITLY states, or null when it states none.
 *
 * Derived from subtag SHAPE, because shape is the only signal available here:
 * BCP-47 orders a tag language-extlang-script-region-variant with no keyword
 * marking any position, so `zh-Hant` and `en-GB` are structurally identical
 * two-subtag strings and only the second subtag's form tells them apart. A
 * script subtag is four letters (`Hant`, `Latn`, `Cyrl`); a region is two
 * letters or three digits (`GB`, `419`); a variant is five to eight
 * alphanumerics or four characters BEGINNING WITH A DIGIT (`1996`). So four
 * ASCII letters in a script position is unambiguous, and a naive "the second
 * subtag differs" test -- which would break `en-GB` against `en-US` -- is not
 * needed.
 *
 * Positions 2 and 3 are examined, and only those: the script may sit behind at
 * most one extlang (`zh-cmn-Hans-CN`), and nothing legal puts it later. The
 * scan stops at any subtag shorter than two characters -- a one-character
 * subtag is a singleton opening an extension or private-use sequence
 * (`en-US-x-abcd`) whose contents are free-form and say nothing about writing,
 * and an empty one means the tag is malformed, which is not a state to read a
 * script out of. A tag whose PRIMARY subtag is that short is itself private-use
 * (`x-abcd`) or irregular grandfathered (`i-ami`), and states no script here
 * either.
 *
 * What shape CANNOT distinguish: a four-letter subtag that reaches position 2
 * or 3 in a tag not following BCP-47's ordering is read as a script, and no
 * registry lookup happens, so an unregistered four-letter script is treated
 * exactly like a registered one. Both consequences are bounded in the same
 * direction -- the strict policy below declines an AUTOMATIC selection and the
 * track is still offered -- which is why a shape test is enough and a script
 * registry is not vendored into this package.
 */
function scriptSubtag(tag: string): string | null {
  const parts = normaliseLanguageTag(tag).split("-");
  const primary = parts[0];
  if (primary === undefined || primary.length < 2) return null;

  for (let index = 1; index <= 2 && index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) return null;
    if (part.length < 2) return null;
    if (SCRIPT_SUBTAG.test(part)) return part;
  }
  return null;
}

/**
 * Whether an explicitly stated, DIFFERING script disqualifies a language match.
 *
 * `ignore_script` is the comparator's base rule: same SPOKEN LANGUAGE, same
 * language group, one degree of inexactness below an exact tag. It read "same
 * primary subtag" until PL-0206, which is a different claim wherever an extlang
 * is present -- see `spokenLanguage`.
 * `require_compatible_script` additionally refuses a pair where BOTH tags name
 * a script and the two scripts differ. A tag that names no script is not in
 * conflict with anything -- a bare `zh` preference stays broad, because the
 * viewer expressed no script preference and inventing one for them would be the
 * mirror of the defect this fixes.
 *
 * A PARAMETER, not two functions. Audio and subtitles share this comparator
 * precisely so they cannot drift into disagreeing about what "the same
 * language" is, and the two differ by one rule rather than by one algorithm.
 *
 * WHICH CONSUMER TAKES WHICH, and why they differ:
 *
 *   - Subtitles pass `require_compatible_script`. A script subtag is a
 *     statement about the WRITING system, and automatically selecting
 *     `zh-Hans` for a viewer who asked for `zh-Hant` puts text on screen they
 *     may be unable to read while the reason trail tells them their language
 *     was matched. `sr-Latn`/`sr-Cyrl`, `uz-Latn`/`uz-Cyrl` and
 *     `az-Latn`/`az-Arab` are the same case.
 *   - Audio passes `ignore_script`. A viewer who cannot READ a script can
 *     almost always still HEAR the language, so the harm that motivates the
 *     subtitle rule does not transfer; and `selectAudioTrack` must play
 *     something, so narrowing the matcher there does not produce a careful
 *     refusal -- it demotes a same-language track below an UNRELATED language
 *     that happens to rank higher on role or channels, which is strictly worse
 *     for the listener. Where a script tag on an audio track really does stand
 *     in for a distinct spoken variety, the honest fix was said here to be an
 *     extlang-aware rule rather than this one -- and PL-0206 built it. It is
 *     `spokenLanguage`, it applies to BOTH policies rather than being a second
 *     `ScriptPolicy` value, and it is not a script rule at all: `zh-yue` and
 *     `zh-cmn` are different languages whatever script either is written in.
 */
export type ScriptPolicy = "ignore_script" | "require_compatible_script";

/**
 * How well a track's language matches the viewer's ordered preferences.
 *
 * Returns the index of the matched preference (lower is better) and how exact
 * the match was, so a same-language-different-region track loses to an exact
 * one but still beats an unrelated language. Absent from the list entirely
 * returns null, which sorts after every match regardless of index.
 *
 * `scriptPolicy` is required rather than defaulted, so every call site states
 * which rule it wants and a new consumer cannot inherit one by omission.
 */
export function languageMatch(
  trackLanguage: string,
  preferred: readonly string[],
  scriptPolicy: ScriptPolicy
): { groupIndex: number; exactIndex: number | null } | null {
  const track = normaliseLanguageTag(trackLanguage);
  /*
   * THE SPOKEN LANGUAGE, NOT THE PRIMARY SUBTAG (PL-0206). This comparison used
   * to be `primarySubtag(want) !== primarySubtag(track)`, which made `zh-yue` and
   * `zh-cmn` the same language and let a Mandarin preference be served Cantonese
   * under a fallback strength. `spokenLanguage` collapses an extlang toward the
   * specific language instead of toward the macrolanguage, so the prefixed and
   * bare spellings agree and the two varieties do not.
   */
  const trackLanguageId = spokenLanguage(track);
  const trackScript = scriptSubtag(track);

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
    const want = normaliseLanguageTag(preferred[i] ?? "");
    if (!want || spokenLanguage(want) !== trackLanguageId) continue;

    if (scriptPolicy === "require_compatible_script") {
      // Only TWO STATED, DIFFERING scripts conflict. One side stating a script
      // and the other not is a broader request being served, not a mismatch.
      const wantScript = scriptSubtag(want);
      if (trackScript !== null && wantScript !== null && trackScript !== wantScript) continue;
    }

    if (groupIndex === null) groupIndex = i;
    if (want === track && exactIndex === null) exactIndex = i;
  }

  return groupIndex === null ? null : { groupIndex, exactIndex };
}

/**
 * Whether this track shares a language with the preferences but ONLY across a
 * script boundary: it matches under `ignore_script` and does not match under
 * `require_compatible_script`.
 *
 * Exists so a policy can report that outcome instead of reporting the flat
 * "nothing in your language" it now falls into. "There is no Chinese subtitle"
 * and "there is one, in a script you did not ask for" are different facts with
 * different remedies -- the second is a track a player should offer
 * deliberately -- and collapsing them is the same class of conflation the
 * reason vocabularies in this package exist to prevent.
 *
 * Defined by calling the shared comparator twice rather than by re-deriving the
 * rule, so it cannot come to disagree with the matcher it describes.
 */
export function matchesOnlyAcrossScripts(
  trackLanguage: string,
  preferred: readonly string[]
): boolean {
  return (
    languageMatch(trackLanguage, preferred, "ignore_script") !== null &&
    languageMatch(trackLanguage, preferred, "require_compatible_script") === null
  );
}

/**
 * Whether this track shares a MACROLANGUAGE with the preferences but not a
 * spoken language: `zh-yue` against a `zh-cmn` preference, or either against a
 * bare `zh`.
 *
 * The counterpart to `matchesOnlyAcrossScripts`, and it exists for the same
 * reason (PL-0206). Once `languageMatch` stopped reducing a tag to its primary
 * subtag, a Cantonese track against a Mandarin preference stopped being a
 * fallback -- correctly -- and became indistinguishable from no Chinese audio at
 * all. Those are different facts with different remedies: the first is a track
 * worth OFFERING and refusing to select automatically, the second is nothing to
 * offer. Collapsing them would trade one conflation for another.
 *
 * DEFINED AS THE DIFFERENCE BETWEEN THE TWO RULES rather than by re-deriving
 * either, so it cannot drift from the matcher it describes. The old rule is the
 * primary-subtag comparison this task removed; the new rule is `languageMatch`
 * itself. A track that the old rule matched and the new rule does not is, by
 * construction, one whose macrolanguage the viewer asked for and whose spoken
 * language they did not.
 *
 * `ignore_script` on both sides deliberately: this asks a question about SPEECH,
 * and a script conflict is a separate finding with its own reason. The two turn
 * out to be mutually exclusive rather than overlapping -- setting the script
 * aside leaves the spoken-language comparison, which a different variety fails --
 * so no track is ever across both, and `subtitles.ts` records that argument where
 * it chooses between them.
 *
 * WHAT THIS DETECTS AND WHAT IT CANNOT, because the asymmetry is real and the
 * function above does not share it. `spokenLanguage` treats `cmn` and `zh-cmn` as
 * one language in both directions, which is the whole point of collapsing toward
 * the specific. This helper cannot: it needs a shared MACROLANGUAGE to notice,
 * and the only place a macrolanguage appears in a tag is the prefix of the
 * prefixed spelling. So it answers true for `zh` against `zh-cmn`, and FALSE for
 * `cmn` against `zh` -- one spoken language, two spellings, two different
 * findings. A bare `cmn` track against a bare `zh` preference therefore reports
 * `no_preferred_language_available` rather than the variety reason.
 *
 * That is a reporting gap rather than a selection defect: nothing is selected in
 * either case, and the matcher itself is symmetric. Closing it needs a
 * macrolanguage registry -- knowing that `cmn` belongs to `zh` is not derivable
 * from either string -- and this package has declined to vendor a registry for
 * scripts on the same reasoning. Stated here rather than left for someone to
 * discover from a reason code that seemed wrong.
 */
export function matchesOnlyAcrossMacrolanguage(
  trackLanguage: string,
  preferred: readonly string[]
): boolean {
  if (languageMatch(trackLanguage, preferred, "ignore_script") !== null) return false;

  const trackPrimary = primarySubtag(trackLanguage);
  if (!trackPrimary) return false;
  for (const want of preferred) {
    const wanted = normaliseLanguageTag(want);
    if (wanted && primarySubtag(wanted) === trackPrimary) return true;
  }
  return false;
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

  // `ignore_script`, deliberately: see `ScriptPolicy`. A listener who cannot
  // read a script can still hear the language, and this policy must play
  // something, so refusing a same-language track here would hand the choice to
  // an unrelated language rather than to a careful refusal.
  const matchA = languageMatch(a.language, preferred, "ignore_script");
  const matchB = languageMatch(b.language, preferred, "ignore_script");

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
  const match = languageMatch(selected.language, preferred, "ignore_script");
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
  const autoSelectable = eligible.filter((t) => AUTO_SELECTABLE_ROLES.includes(t.role));

  /*
   * Sorted, not filtered-and-returned.
   *
   * `manualOnly` was the last piece of this result still carrying provider
   * input order: reversing the incoming tracks reversed it, which contradicted
   * the order-invariance this function claims two lines above. Determinism that
   * holds for three of four fields is not determinism -- a player rendering
   * this list would show a different running order for the same stream.
   *
   * The same comparator is used rather than a bare id sort, so the list a
   * viewer is offered is ordered by something meaningful (their language
   * first), and it terminates in the code-point id tiebreak either way.
   */
  const manualOnly = eligible
    .filter((t) => !AUTO_SELECTABLE_ROLES.includes(t.role))
    .sort((a, b) => compareTracks(a, b, capabilities));

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
