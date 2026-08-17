import type {
  SubtitleFormat,
  SubtitleKind,
  SubtitlePolicy,
  SubtitleTrack
} from "@liberty/contracts";
import { languageMatch } from "./audio";

/**
 * Subtitle track selection.
 *
 * The sibling of `audio.ts`, and the same shape of problem: ranking stream
 * candidates answers "which stream", audio selection answers "which of its
 * sound tracks", and this answers "what, if anything, do we put on screen". The
 * failure modes are the ones a viewer cannot diagnose -- an untranslated scene,
 * a wall of hearing-impaired sound cues nobody asked for, or subtitles that
 * simply never appear -- so every outcome carries a reason, and the reason
 * distinguishes "you got what you asked for" from each specific way we did not
 * give it to you.
 *
 * The policy is ORDERED, not weighted, for the reason `audio.ts` sets out at
 * length: a weighted model makes "this SDH track is the provider's default and
 * is WebVTT, so it outranks the plain track in the language you asked for" a
 * representable trade. Comparing criteria in a fixed sequence means language can
 * never be outvoted by a technical property.
 *
 * Three things make this NOT just audio selection with different field names,
 * and each of them is a place a naive port would be wrong:
 *
 *   1. Nothing is a valid answer, and it is the DEFAULT answer. Audio must
 *      always play something. A viewer who never asked for subtitles gets none,
 *      so there is no "fall back to the first eligible track" branch here --
 *      falling back would put text on screen that nobody requested.
 *   2. `off` is a state, not an empty preference. It is reported distinctly from
 *      every "nothing matched" outcome, and `ordered` is still populated so a
 *      player can tell "you turned these off" from "there is nothing to turn
 *      on".
 *   3. A `forced` track is not a high-ranking normal subtitle. It is keyed to
 *      the audio language rather than to the viewer's reading preference, and it
 *      is the one thing an "off" preference does not suppress.
 */

export type SubtitleRejectionReason = "unsupported_subtitle_format";

/**
 * Why the selected track was selected, or why nothing was.
 *
 * Grouped below by what a reader should conclude. The grouping is the point:
 * "no track in your language", "your language exists but only as a forced
 * track" and "you asked for none" are three different situations with three
 * different remedies, and a trail that renders them all as "no subtitles" is the
 * class of defect product invariant 4 exists to prevent.
 */
export type SubtitleSelectionReason =
  /* The preference was honoured. */
  | "preferred_language_exact"
  | "preferred_language_primary_subtag"
  /* The derived-language pair. Split for the same reason as the pair above it:
   * `audioLanguage: "ja"` served by a `ja` track and `audioLanguage: "pt-br"`
   * served by a bare `pt` track are not the same outcome, and this was the one
   * honoured path in the policy that reported them identically. */
  | "hearing_impaired_audio_language"
  | "hearing_impaired_audio_language_primary_subtag"
  /* A forced narrative track was shown. Not the same as honouring a request to
   * read: it translates what the soundtrack does not deliver. */
  | "forced_narrative_with_subtitles_off"
  | "forced_narrative_for_audio_language"
  /* Nothing was selected, on purpose, and these say which purpose. */
  | "off_by_viewer_preference"
  | "no_preference_expressed"
  | "preferred_language_forced_only"
  | "preferred_language_manual_only"
  | "no_preferred_language_available"
  /* Nothing was selected because there was nothing to select from. */
  | "no_subtitle_tracks"
  | "no_eligible_tracks";

export interface SubtitleSelection {
  /**
   * The track to display, or `null` for no subtitles.
   *
   * Always stated, never to be inferred from the lists below. `ordered[0]` and
   * `forced[0]` are the best candidate in their pool, which is NOT the same
   * claim as "this is what plays": with the viewer off, `ordered` is deliberately
   * full and `selected` is deliberately null.
   */
  selected: SubtitleTrack | null;
  reason: SubtitleSelectionReason;
  /**
   * The automatic pool -- `subtitles` and `sdh` -- ranked by the policy.
   *
   * Populated regardless of mode, which is a deliberate divergence from
   * `AudioSelection.ordered` (that returns `[]` on every non-selection path).
   * This list is what a player renders as the subtitle menu, and emptying it
   * when the viewer is off would make "you turned these off" and "this title has
   * none" identical payloads -- the exact conflation this policy exists to
   * avoid. `selected` is `ordered[0]` only when `reason` is one of the honoured
   * ones.
   */
  ordered: SubtitleTrack[];
  /**
   * Eligible forced tracks, ranked by fitness for the audio in play.
   *
   * Separate from `ordered` because a forced track is not a subtitle a viewer
   * chose to read, and separate from `manualOnly` because -- unlike commentary
   * -- it IS automatically selectable. A track is only taken from here when its
   * language matches `policy.audioLanguage`; the rest are returned so a player
   * can still offer them.
   */
  forced: SubtitleTrack[];
  /**
   * Playable, but only on an explicit request: subtitled commentary, and any
   * kind this build does not recognise. Never a candidate for automatic
   * selection.
   *
   * `sdh` is pointedly NOT here. It is an accessibility track and frequently the
   * only subtitle track a title ships in a language; moving it out of the
   * automatic pool would leave a viewer who needs it with nothing unless a
   * settings screen happened to offer the right toggle.
   */
  manualOnly: SubtitleTrack[];
  rejected: Array<{ trackId: string; reason: SubtitleRejectionReason }>;
  /** Human-readable trail, sufficient to debug a surprising choice. */
  explanation: string;
}

/**
 * Kinds eligible for AUTOMATIC selection.
 *
 * Ranking is not enough, and `audio.ts` documents why: language is compared
 * before kind, so a commentary track in the viewer's language would beat a plain
 * track in any other, and if commentary were the only eligible track it would
 * necessarily be selected. Keeping the pools disjoint makes "never
 * auto-selected" a property of the code rather than a claim in a comment.
 *
 * `sdh` is in the pool. The reasoning that removes commentary is about who a
 * track is FOR: nobody wants commentary by accident, whereas SDH is ordinary
 * subtitles plus extra cues -- mildly redundant for a hearing viewer, essential
 * for another, and often the only track in a given language. Excluding it would
 * be an accessibility regression dressed up as tidiness.
 */
const AUTO_SELECTABLE_KINDS: readonly SubtitleKind[] = ["subtitles", "sdh"];

/**
 * Kind preference, most to least appropriate as an automatic choice.
 *
 * Depends on the viewer, which is why it is a function rather than a constant:
 * SDH's speaker labels and `[door slams]` cues are the point of the track for
 * one viewer and clutter for another, so the same two tracks must order
 * differently for different people. Nothing else in the comparison behaves this
 * way.
 *
 * `forced` and `commentary` appear only so the order is total. They are in
 * disjoint pools, so their rank never decides a selection -- it decides the
 * running order of a menu.
 */
function kindOrder(hearingImpaired: boolean): readonly SubtitleKind[] {
  return hearingImpaired
    ? ["sdh", "subtitles", "forced", "commentary"]
    : ["subtitles", "sdh", "forced", "commentary"];
}

function kindRank(kind: SubtitleKind, hearingImpaired: boolean): number {
  const order = kindOrder(hearingImpaired);
  const index = order.indexOf(kind);
  // An unknown kind sorts last rather than first, and is excluded from the
  // automatic pool besides. A kind this build does not recognise is not one it
  // should silently put on screen.
  return index === -1 ? order.length : index;
}

/**
 * Format preference, most to least faithfully rendered.
 *
 * Only consulted after language, kind and the provider default have tied, so it
 * never decides anything a viewer notices more than the criteria above it.
 *
 * `srt` ranks last rather than `ass`, which is the one non-obvious call here.
 * SRT carries no positioning at all, so its text lands wherever the player puts
 * it -- routinely on top of burned-in signage or credits. ASS's rich styling is
 * renderer-dependent and degrades to plain text, which is strictly SRT's
 * behaviour with a chance of being better.
 */
const FORMAT_ORDER = ["webvtt", "ttml", "ass", "srt"] as const;

function formatRank(format: SubtitleFormat): number {
  const index = FORMAT_ORDER.indexOf(format);
  return index === -1 ? FORMAT_ORDER.length : index;
}

/**
 * Which languages this decision is actually looking for, and where they came
 * from.
 *
 * Almost always the viewer's own list. The exception is a hearing-impaired
 * viewer who has stated no language: they cannot hear the soundtrack, so the
 * language it is in is the language they need it transcribed in. That is a
 * derivation from a known fact, not a guess -- and it is the ONLY place this
 * policy supplies a language nobody stated, because everywhere else the honest
 * answer to "which language?" is silence.
 *
 * Without it, a deaf viewer whose settings screen collected an accessibility
 * toggle but not a language gets no subtitles at all, which is a real harm and
 * not one they could diagnose. With `audioLanguage` unknown there is nothing to
 * derive from and the policy falls through to selecting nothing.
 */
type LanguageSource = "viewer" | "audio_language_for_hearing_impaired" | "none";

interface EffectiveLanguages {
  languages: readonly string[];
  source: LanguageSource;
}

function effectiveLanguages(policy: SubtitlePolicy): EffectiveLanguages {
  // Tested with `.some` rather than filtered, so the indices `languageMatch`
  // reports stay the ones the caller wrote. Dropping blanks would renumber the
  // list and quietly change which preference "came first".
  if (policy.preferredLanguages.some((language) => language.trim() !== "")) {
    return { languages: policy.preferredLanguages, source: "viewer" };
  }
  if (policy.hearingImpaired && policy.audioLanguage !== null && policy.audioLanguage.trim() !== "") {
    return {
      languages: [policy.audioLanguage],
      source: "audio_language_for_hearing_impaired"
    };
  }
  return { languages: [], source: "none" };
}

/**
 * Whether a track's language belongs to the audio that will play.
 *
 * Uses `languageMatch` from `audio.ts` rather than comparing strings here.
 * That comparator has already been through the defect this exact problem
 * produces -- two fields measuring different things, so an unrequested regional
 * variant outranked one the viewer had explicitly named -- and a second
 * implementation would be free to reintroduce it. Subtitles carry the variant
 * problem more sharply than audio does (`pt` against `pt-BR`, `zh-Hans` against
 * `zh-Hant`), which is a reason to share the fixed comparator, not to write
 * another.
 *
 * A script subtag therefore matches as a VARIANT, not as an unrelated language:
 * `zh-Hant` requested against a `zh-Hans` track is a same-group, non-exact
 * match. That is right for a fallback of last resort and the ordered comparison
 * guarantees it can never beat the exact tag. If the product later decides a
 * script mismatch is no fallback at all, the fix belongs in `languageMatch`,
 * shared with audio -- a subtitle-local special case would leave the two
 * policies disagreeing about what "the same language" means.
 */
function audioLanguageFit(
  track: SubtitleTrack,
  audioLanguage: string | null
): { exact: boolean } | null {
  if (audioLanguage === null || audioLanguage.trim() === "") return null;
  const match = languageMatch(track.language, [audioLanguage]);
  return match === null ? null : { exact: match.exactIndex !== null };
}

function firstRejectionReason(
  track: SubtitleTrack,
  policy: SubtitlePolicy
): SubtitleRejectionReason | null {
  // Unlike `maxAudioChannels`, an empty list is not "unconstrained": a client
  // that named no renderable format has told us it can draw none of them.
  if (!policy.supportedFormats.includes(track.format)) return "unsupported_subtitle_format";
  return null;
}

/**
 * Ordered comparison for the automatic pool. Each criterion is only consulted
 * when everything above it has tied, so the priority is structural rather than a
 * matter of weights that could be tuned into outranking each other.
 *
 * The order is language, then kind, then the provider's default, then format.
 *
 * Language first for the same reason as audio: no technical property may
 * outrank what the viewer asked for. Kind second because SDH-versus-plain is
 * still a statement of viewer need, not a property of the file. `isDefault`
 * below both, because a `DEFAULT=YES` in a manifest is frequently just whichever
 * rendition was written first, and it must never speak over something the viewer
 * expressed. Format last of the meaningful criteria, because it is the only one
 * here the viewer has no opinion about.
 *
 * The final tiebreak is the track id, so the result never depends on the order
 * the provider happened to list its tracks in.
 */
function compareTracks(
  a: SubtitleTrack,
  b: SubtitleTrack,
  policy: SubtitlePolicy,
  languages: readonly string[]
): number {
  const matchA = languageMatch(a.language, languages);
  const matchB = languageMatch(b.language, languages);

  // 1. Any language match beats none.
  if ((matchA === null) !== (matchB === null)) return matchA === null ? 1 : -1;

  if (matchA && matchB) {
    // 2. Whichever LANGUAGE the viewer listed first.
    if (matchA.groupIndex !== matchB.groupIndex) return matchA.groupIndex - matchB.groupIndex;

    // 3. Within that language, an exact tag match beats a variant-only one.
    //    This is what stops an unrequested `pt-AO` from beating the `pt-PT` a
    //    viewer explicitly listed, and a `zh-Hans` track from beating `zh-Hant`.
    const exactA = matchA.exactIndex !== null;
    const exactB = matchB.exactIndex !== null;
    if (exactA !== exactB) return exactA ? -1 : 1;

    // 4. Between two exact matches, the earlier preference wins. Without this
    //    the viewer's ordering of regional variants is silently discarded and a
    //    later criterion decides something they had already decided.
    if (matchA.exactIndex !== null && matchB.exactIndex !== null && matchA.exactIndex !== matchB.exactIndex) {
      return matchA.exactIndex - matchB.exactIndex;
    }
  }

  // 5. Kind, which depends on whether this viewer needs the extra cues.
  const kindDelta = kindRank(a.kind, policy.hearingImpaired) - kindRank(b.kind, policy.hearingImpaired);
  if (kindDelta !== 0) return kindDelta;

  // 6. The provider's own default, as a hint only. It breaks ties between tracks
  //    that already satisfy the viewer; it never puts subtitles on screen, and
  //    there is no branch above that lets it.
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;

  // 7. Rendering fidelity.
  const formatDelta = formatRank(a.format) - formatRank(b.format);
  if (formatDelta !== 0) return formatDelta;

  return compareIds(a.id, b.id);
}

/**
 * Ordered comparison for forced tracks, which answer a different question.
 *
 * The viewer's reading preferences play no part: a forced track's job is to
 * translate the lines a specific soundtrack leaves untranslated, so the only
 * language that matters is the one the audio is in. Sorting these by the
 * viewer's list would put a French forced track first for a French-preferring
 * viewer watching English audio, where it captions nothing they cannot already
 * follow and omits the lines they cannot.
 */
function compareForcedTracks(a: SubtitleTrack, b: SubtitleTrack, policy: SubtitlePolicy): number {
  const fitA = audioLanguageFit(a, policy.audioLanguage);
  const fitB = audioLanguageFit(b, policy.audioLanguage);

  // 1. A track that belongs to this soundtrack beats one that does not.
  if ((fitA === null) !== (fitB === null)) return fitA === null ? 1 : -1;

  // 2. An exact tag beats a regional variant of it, exactly as in the automatic
  //    comparison: an `en-GB` forced track is the right one for `en-GB` audio.
  if (fitA && fitB && fitA.exact !== fitB.exact) return fitA.exact ? -1 : 1;

  /*
   * 3. GAP, stated rather than patched: there is no CLOSER-VARIANT rule between
   *    two non-exact fits. With `audioLanguage: "pt-br"` and forced tracks `pt`
   *    and `pt-pt`, neither is exact, so the provider default, then format, then
   *    the id decide -- although bare `pt` is plainly the better forced track
   *    for pt-BR audio and `pt-pt` is a third region nobody involved asked for.
   *
   *    Not fixed here because it is the SAME missing capability as the script
   *    defect recorded at the reason selection below: `languageMatch` reports a
   *    binary (exact or not) where ranking non-exact variants against each other
   *    needs a degree. Adding a closeness rule in this one comparator would make
   *    the forced pool and the automatic pool order the identical three tags
   *    differently, and leave audio selection -- which shares the comparator and
   *    has the same gap -- untouched. That is the divergence `audioLanguageFit`
   *    exists to avoid. It rides along with the PL-0202/PL-0203 change to
   *    `languageMatch`, where one definition of closeness fixes all three call
   *    sites at once. The consequence meanwhile is bounded: a forced track that
   *    fits the audio at all still beats one that does not, and the outcome
   *    stays deterministic.
   */
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;

  const formatDelta = formatRank(a.format) - formatRank(b.format);
  if (formatDelta !== 0) return formatDelta;

  return compareIds(a.id, b.id);
}

/**
 * Determinism -- by CODE POINT, not `localeCompare`.
 *
 * `localeCompare` without an explicit locale uses the host's collation, so the
 * same tracks on a device with Swedish collation can order differently from one
 * with en-US. "Same input, same output" would then be false across devices,
 * which is precisely the property this task exists to provide.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Why nothing was selected, when the viewer was reading and nothing matched.
 *
 * Split this finely because the remedies differ completely. "There is no French
 * track" is a content-availability answer. "There is a French track but it is
 * forced" means the viewer is seeing partial translation and wondering why they
 * cannot get full subtitles. "You expressed no preference" is a settings
 * problem, not a content one. One shared "no subtitles" reason would send every
 * one of those to the wrong place.
 */
function unmatchedReason(
  effective: EffectiveLanguages,
  forced: readonly SubtitleTrack[],
  manualOnly: readonly SubtitleTrack[]
): SubtitleSelectionReason {
  if (effective.source === "none") return "no_preference_expressed";
  const matches = (track: SubtitleTrack): boolean =>
    languageMatch(track.language, effective.languages) !== null;
  // Forced is checked before commentary because it is the more surprising
  // outcome to a viewer: a forced track puts SOME text in their language on
  // screen, so "there are no subtitles in your language" would read as a
  // contradiction of what they can see.
  if (forced.some(matches)) return "preferred_language_forced_only";
  if (manualOnly.some(matches)) return "preferred_language_manual_only";
  return "no_preferred_language_available";
}

const REASON_TEXT: Record<SubtitleSelectionReason, string> = {
  preferred_language_exact: "matched a preferred subtitle language exactly",
  preferred_language_primary_subtag:
    "matched a preferred subtitle language by primary subtag",
  hearing_impaired_audio_language:
    "no subtitle language was stated; used the audio language for a viewer who cannot hear it",
  hearing_impaired_audio_language_primary_subtag:
    "no subtitle language was stated; matched the audio language by primary subtag for a viewer who cannot hear it",
  forced_narrative_with_subtitles_off:
    "subtitles are off; showed the forced narrative track, which translates dialogue the soundtrack does not",
  forced_narrative_for_audio_language:
    "no full subtitle track applied; showed the forced narrative track for the audio language",
  off_by_viewer_preference: "the viewer turned subtitles off",
  no_preference_expressed:
    "no subtitle language was requested, so no subtitles were selected",
  preferred_language_forced_only:
    "a preferred language exists only as a forced narrative track, which is not full subtitles",
  preferred_language_manual_only:
    "a preferred language exists only as a commentary track; those require an explicit choice",
  no_preferred_language_available: "no subtitle track is available in a preferred language",
  no_subtitle_tracks: "the stream offered no subtitle tracks at all",
  no_eligible_tracks: "no subtitle track is in a format this client can render"
};

/**
 * Case-folded at the render point, for the reason the contract states about its
 * own `.transform()`: it only runs on `.parse()`, and this policy takes the
 * TYPE, so a provider adapter constructing a track literal never invokes it. A
 * `"PT-BR"` track therefore compares as `pt-br` everywhere in this file and
 * would print as `PT-BR` here alone -- the one place a human reads it. Someone
 * debugging why `pt-br` did not match would be looking at the only rendering of
 * that field that disagrees with what the matcher saw.
 */
function describe(track: SubtitleTrack): string {
  return `${track.id} (${track.language.toLowerCase()}, ${track.kind}, ${track.format})`;
}

function describeLanguages(effective: EffectiveLanguages): string {
  const listed = effective.languages.filter((language) => language.trim() !== "");
  if (!listed.length) return "no language requested";
  const suffix = effective.source === "audio_language_for_hearing_impaired" ? " (from the audio)" : "";
  return `looked for: ${listed.join(", ")}${suffix}`;
}

/**
 * Pure and deterministic: same tracks and policy in, same selection out,
 * regardless of input ordering. Every list in the result is sorted by a
 * comparator that terminates in a code-point tiebreak on the track id, so the
 * WHOLE result is order-invariant, not merely `selected`.
 */
export function selectSubtitleTrack(
  tracks: readonly SubtitleTrack[],
  policy: SubtitlePolicy
): SubtitleSelection {
  const rejected: SubtitleSelection["rejected"] = [];
  const eligible: SubtitleTrack[] = [];

  for (const track of tracks) {
    const reason = firstRejectionReason(track, policy);
    if (reason) rejected.push({ trackId: track.id, reason });
    else eligible.push(track);
  }

  rejected.sort((a, b) => compareIds(a.trackId, b.trackId));

  const effective = effectiveLanguages(policy);

  /*
   * Three disjoint pools, split AFTER eligibility so a commentary or forced
   * track the client cannot render is still reported as a format rejection
   * rather than silently reclassified as something on offer.
   *
   * The partition is exhaustive by construction -- anything neither
   * auto-selectable nor forced lands in `manualOnly` -- so a kind added to the
   * contract later is offered rather than dropped from the result entirely.
   * Dropping it would be invisible: the track would simply cease to exist as far
   * as every consumer of this selection is concerned.
   */
  const ordered = eligible
    .filter((track) => AUTO_SELECTABLE_KINDS.includes(track.kind))
    .sort((a, b) => compareTracks(a, b, policy, effective.languages));

  const forced = eligible
    .filter((track) => track.kind === "forced")
    .sort((a, b) => compareForcedTracks(a, b, policy));

  const manualOnly = eligible
    .filter((track) => !AUTO_SELECTABLE_KINDS.includes(track.kind) && track.kind !== "forced")
    .sort((a, b) => compareTracks(a, b, policy, effective.languages));

  // `forced` is sorted with audio-language fits first, so if the head does not
  // fit, nothing does.
  const bestForced = forced[0];
  const forcedForAudio =
    bestForced && audioLanguageFit(bestForced, policy.audioLanguage) !== null ? bestForced : null;

  // Shared across every return so the four lists cannot drift between branches.
  // A path that quietly returned an empty `rejected` would make the reason trail
  // depend on which outcome you happened to hit.
  const base = { ordered, forced, manualOnly, rejected };

  if (!eligible.length) {
    /*
     * "No tracks were offered" and "tracks were offered but none was renderable"
     * are different faults -- a provider/manifest gap versus a client capability
     * limit -- and reporting the first as the second sends whoever debugs it to
     * the wrong system.
     *
     * Checked BEFORE `mode`, deliberately. Whether this stream carries subtitles
     * at all is knowledge only these inputs hold; the viewer's mode is something
     * the caller already has in its hand. Reporting the stream fact tells a
     * caller something it did not already know.
     */
    const reason: SubtitleSelectionReason =
      tracks.length === 0 ? "no_subtitle_tracks" : "no_eligible_tracks";
    return {
      selected: null,
      reason,
      ...base,
      explanation: `${REASON_TEXT[reason]} (${rejected.length} track(s) rejected)`
    };
  }

  if (policy.mode === "off") {
    /*
     * The one thing "off" does not switch off.
     *
     * A forced track is not a subtitle the viewer declined to read: it carries
     * dialogue their soundtrack does not deliver, so suppressing it does not
     * give them a cleaner picture, it gives them a scene of people speaking a
     * language they cannot understand with nothing to indicate anything is
     * missing. Turning subtitles off is a statement about reading full dialogue.
     * This is also what every mainstream player and disc format does, so
     * matching it is what a viewer already expects.
     *
     * The reason value says which of the two "off" outcomes this is, and
     * `ordered` is still populated above, so a player can distinguish "you
     * turned these off" from "there was nothing to turn on".
     */
    if (forcedForAudio) {
      return {
        selected: forcedForAudio,
        reason: "forced_narrative_with_subtitles_off",
        ...base,
        explanation: `${describe(forcedForAudio)}: ${REASON_TEXT.forced_narrative_with_subtitles_off}`
      };
    }
    return {
      selected: null,
      reason: "off_by_viewer_preference",
      ...base,
      explanation:
        `${REASON_TEXT.off_by_viewer_preference} ` +
        `(${ordered.length} track(s) available if switched on)`
    };
  }

  /*
   * `ordered` puts every language match ahead of every non-match, so the head is
   * a match if and only if one exists. Testing the head is therefore the whole
   * test -- and it is tested rather than assumed, because with no stated
   * languages nothing matches and the correct answer is no subtitles at all.
   * There is no "first eligible" fallback here on purpose: audio must play
   * something, subtitles must not appear uninvited.
   */
  const best = ordered[0];
  const match = best ? languageMatch(best.language, effective.languages) : null;

  if (best && match) {
    /*
     * The honoured reasons describe the relationship between the selected track
     * and the stated preference, not whichever tiebreak fired. `audio.ts` has to
     * reconstruct the deciding criterion from the runner-up because it has
     * fallback selections whose cause could be misattributed; this policy has
     * none -- a track outside the viewer's languages is never selected at all --
     * so there is nothing here to misattribute.
     *
     * Both pairs split exact from subtag, including the derived-language one.
     * That path used to report a single value whether the audio language matched
     * exactly (`ja` audio, `ja` track) or only by subtag (`pt-br` audio, bare
     * `pt` track); every other honoured path in this policy distinguishes the
     * two, and invariant 4 is why. For the viewer this decision serves -- one
     * who cannot hear the soundtrack and stated no language of their own -- the
     * difference between "we transcribed the audio" and "we approximated it" is
     * the difference between a working accessibility path and one that silently
     * degraded, and nobody could tell which had happened from the trail.
     *
     * KNOWN DEFECT, deliberately not fixed here: the subtag reason cannot tell a
     * REGION fallback from a SCRIPT one. `primarySubtag` in audio.ts
     * lowercases and takes the first subtag, so `zh-Hant` and
     * `zh-Hans` both reduce to `zh` and "requested zh-Hant, served zh-Hans"
     * reports the same value as "requested en-GB, served en-US". Those are not
     * comparable degradations: en-GB to en-US costs a reader nothing, while
     * zh-Hant to zh-Hans hands a traditional-script reader a script they may not
     * read at all. The same collapse hits sr-Latn/sr-Cyrl, uz-Latn/uz-Cyrl and
     * az-Latn/az-Arab. The comparator itself is correct -- an exact tag always
     * wins and the tests pin that -- so what is wrong is only what gets
     * REPORTED, and a viewer whose subtitles are unreadable is told they matched
     * their language.
     *
     * The fix belongs in the shared `languageMatch`, not here. That function is
     * the single definition of "the same language" for audio and subtitles both,
     * and its result carries one binary (exact or not) where a script mismatch
     * needs a third degree. Inventing that degree locally would give subtitle
     * selection a notion of language closeness that audio selection does not
     * share, which is the exact divergence `audioLanguageFit` above refuses to
     * create -- and it would still not fix the audio side, where the same
     * substitution is just as wrong. So it is cross-lane work spanning PL-0202
     * (audio) and PL-0203 (subtitles) and must be routed as ONE change: a
     * degree-of-match on `languageMatch`, then new reason values on both
     * policies. A test in `subtitles.test.ts` pins the current behaviour, so the
     * day it changes is a visible edit rather than a surprise.
     */
    const exact = match.exactIndex !== null;
    const reason: SubtitleSelectionReason =
      effective.source === "audio_language_for_hearing_impaired"
        ? exact
          ? "hearing_impaired_audio_language"
          : "hearing_impaired_audio_language_primary_subtag"
        : exact
          ? "preferred_language_exact"
          : "preferred_language_primary_subtag";
    return {
      selected: best,
      reason,
      ...base,
      explanation: `${describe(best)}: ${REASON_TEXT[reason]}`
    };
  }

  if (forcedForAudio) {
    // Nothing the viewer asked to read is available, but the soundtrack still
    // has lines it does not translate. Partial translation beats none, and the
    // reason says plainly that this is not the subtitles they asked for.
    return {
      selected: forcedForAudio,
      reason: "forced_narrative_for_audio_language",
      ...base,
      explanation: `${describe(forcedForAudio)}: ${REASON_TEXT.forced_narrative_for_audio_language}`
    };
  }

  const reason = unmatchedReason(effective, forced, manualOnly);
  return {
    selected: null,
    reason,
    ...base,
    // The languages are named only when there were any. "no subtitle language
    // was requested (no language requested)" says the same thing twice and
    // hides which of the two facts a reader should act on.
    explanation:
      effective.source === "none"
        ? REASON_TEXT[reason]
        : `${REASON_TEXT[reason]} (${describeLanguages(effective)})`
  };
}
