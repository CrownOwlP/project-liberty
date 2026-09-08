import type {
  SubtitleFormat,
  SubtitleKind,
  SubtitlePolicy,
  SubtitleTrack
} from "@liberty/contracts/domains/subtitles";
import {
  languageMatch,
  matchesOnlyAcrossScripts,
  normaliseLanguageTag,
  type AudioSelection
} from "./audio";

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
 *      is the one thing an "off" preference does not suppress. `withSelectedAudio`
 *      below is how that key is established, so the coupling to the audio
 *      DECISION is mechanical rather than something each caller has to remember.
 */

/* -------------------------------------------------------------------------
 * THE LANGUAGE MATCHING RULE, stated once for the whole policy.
 *
 * Every language comparison in this file -- viewer preference against track,
 * audio language against forced track -- goes through `languageMatch` in
 * `audio.ts`, and this is what that function means, written out here because a
 * rule nobody states becomes an accident of whichever comparison happened to be
 * written first.
 *
 * Both sides are normalised IDENTICALLY -- trimmed and lower-cased, by
 * `normaliseLanguageTag` in `audio.ts`, which is also what `describe` and
 * `describeLanguages` below print, so the trail cannot render a tag differently
 * from the way the matcher compared it. That symmetry is new. The preference
 * side used to be trimmed and the track side only case-folded, which was a
 * defect and not a safe direction: `"en-gb "` from a manifest kept its language
 * group and silently lost its EXACT match against an `en-gb` preference, while
 * `" en"` put the padding inside the primary subtag and matched nothing at all
 * -- two logically equivalent raw values receiving different answers depending
 * on which side of the comparison they arrived on, with nothing in the result
 * explaining either. Both policies take the TYPE rather than parsed output, so
 * the schema's normalising `.transform()` never ran on those values. Then:
 *
 *   - they MATCH when their PRIMARY SUBTAGS are equal, where the primary subtag
 *     is everything before the first "-" (`primarySubtag`) -- EXCEPT when both
 *     tags explicitly state a script and the scripts differ, which is not a
 *     match at all here (consequence 4 below);
 *   - the match is EXACT when the whole tags are equal, and a VARIANT match
 *     otherwise;
 *   - a blank preference entry is skipped outright, and a track stating no
 *     language has an empty primary subtag, which no well-formed tag shares. An
 *     unstated language is therefore never a wildcard -- the failure mode a
 *     `startsWith` comparator has with an empty needle.
 *
 * Four consequences worth naming, because each is a place a plausible
 * implementation differs:
 *
 *   1. It is SYMMETRIC. A preference for `pt` accepts a `pt-BR` track and a
 *      preference for `pt-BR` accepts a bare `pt` track; likewise `sv` and
 *      `sv-FI`. Both are variant matches, and an exact tag always outranks a
 *      variant one (`compareTracks` step 3), so a viewer who names the specific
 *      tag still gets it when it exists. `startsWith` would give only one of the
 *      two directions and would additionally match `sv` against `sventon`.
 *   2. A UN M.49 region such as `es-419` is an ORDINARY subtag. It matches `es`
 *      and `es-ES` as a variant and is exact only against `es-419`; there is no
 *      numeric-region special case, and none is wanted -- Latin American and
 *      European Spanish are a last-resort fallback for one another in exactly
 *      the way two country codes would be.
 *   3. Preference LIST ORDER is meaningful, which the contract states directly:
 *      `preferredLanguages` is "ordered, most-preferred first ... not a set".
 *      The order is honoured group first (`compareTracks` steps 2 to 4): the
 *      earliest language group wins, an exact tag beats a variant within that
 *      group, and between two exact tags the earlier preference wins.
 *   4. A SCRIPT conflict is not a fallback at all, where a REGION difference
 *      still is. Every comparison in this file passes
 *      `require_compatible_script` to the shared `languageMatch`, so a
 *      `zh-Hant` preference does not match a `zh-Hans` track: it is never
 *      selected automatically, it is still returned in whichever pool its kind
 *      belongs to so a player can offer it, and the outcome carries a reason of
 *      its own
 *      (`preferred_language_other_script_only`) instead of the value a
 *      `en-GB`-served-`en-US` fallback reports. A script subtag is RFC 5646's
 *      way of stating a distinction in WRITTEN language, and automatically
 *      showing a viewer text in a script they may not read while telling them
 *      their language was matched is precisely what invariant 4 forbids;
 *      `sr-Latn`/`sr-Cyrl`, `uz-Latn`/`uz-Cyrl` and `az-Latn`/`az-Arab` are the
 *      same case. Only two STATED, DIFFERING scripts conflict -- a bare `zh`
 *      preference still accepts both, because the viewer expressed no script
 *      preference and inventing one for them would be the mirror of the defect
 *      this fixes. The rule applies uniformly here, forced tracks included,
 *      because everything this file selects is READ. Audio deliberately keeps
 *      `ignore_script`, since a viewer who cannot read a script can still hear
 *      the language; `ScriptPolicy` in `audio.ts` carries that argument in full
 *      and is one parameter of one shared comparator rather than a second copy
 *      of it.
 * ---------------------------------------------------------------------- */

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
  /* The language exists, in a script the viewer did not ask for. Carved out of
   * `no_preferred_language_available`, which would otherwise tell a viewer no
   * Chinese subtitle exists while a `zh-Hans` track sits in `ordered` waiting to
   * be chosen deliberately. The remedy is a player affordance, not a different
   * title. */
  | "preferred_language_other_script_only"
  | "no_preferred_language_available"
  /* Nothing was selected because there was nothing to select from. */
  | "no_subtitle_tracks"
  | "no_eligible_tracks";

/**
 * What a reason MEANS for the screen, as opposed to why it happened.
 *
 * Fourteen reasons is the right granularity for a debugger and the wrong one for
 * a player: rendering a "no subtitles available" affordance should not require
 * an exhaustive `switch`, and every consumer that writes its own is one release
 * away from disagreeing with the next. So the classification is published here
 * instead, once.
 */
export interface SubtitleOutcome {
  /** Whether anything is put on screen. Equivalent to `selected !== null`. */
  showsText: boolean;
  /**
   * Whether what is on screen is a FULL reading track rather than a forced
   * narrative one.
   *
   * Separate from `showsText` because a forced track does not satisfy a viewer
   * who asked to read: it carries only the lines the soundtrack leaves
   * untranslated. A UI that treats "something is on screen" as "the request was
   * honoured" tells a viewer their subtitles are working while most of the
   * dialogue goes untitled, which is the conflation product invariant 4 exists
   * to prevent.
   */
  showsFullSubtitles: boolean;
}

/**
 * The outcome of every reason, exhaustively.
 *
 * A `Record` over the reason union rather than a lookup with a default, so
 * adding a reason without deciding what it puts on screen is a COMPILE error
 * rather than a value that silently reads as "nothing". `subtitles.property.test.ts`
 * checks the table against the function over generated input, so the two cannot
 * drift either.
 */
export const SUBTITLE_OUTCOME_BY_REASON: Record<SubtitleSelectionReason, SubtitleOutcome> = {
  preferred_language_exact: { showsText: true, showsFullSubtitles: true },
  preferred_language_primary_subtag: { showsText: true, showsFullSubtitles: true },
  hearing_impaired_audio_language: { showsText: true, showsFullSubtitles: true },
  hearing_impaired_audio_language_primary_subtag: { showsText: true, showsFullSubtitles: true },
  /* Text, but not the subtitles anyone asked to read. */
  forced_narrative_with_subtitles_off: { showsText: true, showsFullSubtitles: false },
  forced_narrative_for_audio_language: { showsText: true, showsFullSubtitles: false },
  off_by_viewer_preference: { showsText: false, showsFullSubtitles: false },
  no_preference_expressed: { showsText: false, showsFullSubtitles: false },
  preferred_language_forced_only: { showsText: false, showsFullSubtitles: false },
  preferred_language_manual_only: { showsText: false, showsFullSubtitles: false },
  /* Nothing on screen ON PURPOSE: the track exists and is offered, and showing
   * it uninvited is the harm the script rule exists to prevent. */
  preferred_language_other_script_only: { showsText: false, showsFullSubtitles: false },
  no_preferred_language_available: { showsText: false, showsFullSubtitles: false },
  no_subtitle_tracks: { showsText: false, showsFullSubtitles: false },
  no_eligible_tracks: { showsText: false, showsFullSubtitles: false }
};

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
 *
 * The derived tag is carried WHOLE, script included, and is then matched under
 * the same `require_compatible_script` rule as a stated one. So `zh-Hant` audio
 * with only a `zh-Hans` subtitle track yields no automatic selection for a
 * hearing-impaired viewer, reported as `preferred_language_other_script_only`.
 * That is the uncomfortable end of the script rule and it is deliberate: the
 * alternative is putting a script this viewer may not read in front of the one
 * viewer who cannot check it against the soundtrack, under a reason value
 * claiming their language was matched -- the defect the rule exists to remove,
 * in its sharpest form. The track is still returned, so the remedy is a player
 * offering it rather than the policy imposing it.
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
 * `require_compatible_script`, exactly as the automatic pool uses. A forced
 * track is TEXT: `zh-Hant` audio served by a `zh-Hans` forced track puts a
 * script on screen the viewer may not read, and it does so on the one path that
 * survives an "off" preference -- so if anything the argument is stronger here
 * than for the reading pool. It is the same argument, so it is the same rule,
 * passed to the same comparator; that is what keeps the two pools from
 * disagreeing about what "the same language" is.
 */
function audioLanguageFit(
  track: SubtitleTrack,
  audioLanguage: string | null
): { exact: boolean } | null {
  if (audioLanguage === null || audioLanguage.trim() === "") return null;
  const match = languageMatch(track.language, [audioLanguage], "require_compatible_script");
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
  const matchA = languageMatch(a.language, languages, "require_compatible_script");
  const matchB = languageMatch(b.language, languages, "require_compatible_script");

  // 1. Any language match beats none.
  if ((matchA === null) !== (matchB === null)) return matchA === null ? 1 : -1;

  if (matchA && matchB) {
    // 2. Whichever LANGUAGE the viewer listed first.
    if (matchA.groupIndex !== matchB.groupIndex) return matchA.groupIndex - matchB.groupIndex;

    // 3. Within that language, an exact tag match beats a variant-only one.
    //    This is what stops an unrequested `pt-AO` from beating the `pt-PT` a
    //    viewer explicitly listed. A `zh-Hans` track against a `zh-Hant`
    //    preference never reaches this step at all: it is not a match, so step 1
    //    has already put it behind every track that is.
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
   *    NOT the same missing capability as the script rule, which is why that one
   *    landed and this one did not. The script rule DISQUALIFIES a pair the
   *    matcher would otherwise accept, and a disqualification is expressible in
   *    the binary `languageMatch` already reports; ranking two ACCEPTED
   *    non-exact variants against each other needs something the result does not
   *    carry, a degree of closeness. Adding that degree in this one comparator
   *    would make the forced pool and the automatic pool order the identical
   *    three tags differently, and leave audio selection -- which shares the
   *    comparator and has the same gap -- untouched. That is the divergence
   *    `audioLanguageFit` exists to avoid, so the degree belongs in
   *    `languageMatch` as one definition serving all three call sites, and it is
   *    not part of this change. The consequence meanwhile is bounded: a forced
   *    track that fits the audio at all still beats one that does not, and the
   *    outcome stays deterministic.
   */
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;

  const formatDelta = formatRank(a.format) - formatRank(b.format);
  if (formatDelta !== 0) return formatDelta;

  return compareIds(a.id, b.id);
}

/**
 * Determinism -- by UTF-16 CODE UNIT, not `localeCompare`.
 *
 * `localeCompare` without an explicit locale uses the host's collation, so the
 * same tracks on a device with Swedish collation can order differently from one
 * with en-US. "Same input, same output" would then be false across devices,
 * which is precisely the property this task exists to provide.
 *
 * Code UNIT rather than code POINT: `<` on strings compares UTF-16 code units,
 * which is the same order as code point for everything in the BMP and differs
 * above it -- an astral character (U+10000 and up) is a surrogate pair beginning
 * at U+D800, so it sorts before U+E000..U+FFFF rather than after. Determinism is
 * unaffected, since every host compares the same units; only the claim about
 * WHICH order this is has to be accurate, because that is what a reader porting
 * this comparator would reimplement.
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
 * cannot get full subtitles. "There is a Chinese track, in the other script" is
 * an offer the player should make and the viewer should accept or decline --
 * saying instead that nothing exists in their language would simply be false.
 * "You expressed no preference" is a settings problem, not a content one. One
 * shared "no subtitles" reason would send every one of those to the wrong place.
 */
function unmatchedReason(
  effective: EffectiveLanguages,
  forced: readonly SubtitleTrack[],
  manualOnly: readonly SubtitleTrack[],
  eligible: readonly SubtitleTrack[]
): SubtitleSelectionReason {
  if (effective.source === "none") return "no_preference_expressed";
  const matches = (track: SubtitleTrack): boolean =>
    languageMatch(track.language, effective.languages, "require_compatible_script") !== null;
  // Forced is checked before commentary because it is the more surprising
  // outcome to a viewer: a forced track puts SOME text in their language on
  // screen, so "there are no subtitles in your language" would read as a
  // contradiction of what they can see.
  if (forced.some(matches)) return "preferred_language_forced_only";
  if (manualOnly.some(matches)) return "preferred_language_manual_only";
  /*
   * Last of the three, and over EVERY eligible track rather than one pool.
   *
   * Last because the two above it describe a track in the script the viewer
   * actually asked for -- one they can read, and could be given by a player --
   * which is the more actionable fact when both are true. Over every pool
   * because the claim is about the stream: "your language is here only in
   * another script" is equally true of a plain, a forced or a commentary track,
   * and this reason carves that case out of `no_preferred_language_available`,
   * which would otherwise report that the language is not present at all.
   */
  if (eligible.some((track) => matchesOnlyAcrossScripts(track.language, effective.languages))) {
    return "preferred_language_other_script_only";
  }
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
  preferred_language_other_script_only:
    "a preferred language exists only in a different script, which may be unreadable and is never shown automatically",
  no_preferred_language_available: "no subtitle track is available in a preferred language",
  no_subtitle_tracks: "the stream offered no subtitle tracks at all",
  no_eligible_tracks: "no subtitle track is in a format this client can render"
};

/**
 * Normalised at the render point THROUGH THE MATCHER'S OWN FUNCTION, for the
 * reason the contract states about its `.transform()`: it only runs on
 * `.parse()`, and this policy takes the TYPE, so a provider adapter
 * constructing a track literal never invokes it. A `"PT-BR"` track therefore
 * compares as `pt-br` everywhere in this file and would print as `PT-BR` here
 * alone -- the one place a human reads it. Someone debugging why `pt-br` did
 * not match would be looking at the only rendering of that field that disagrees
 * with what the matcher saw.
 *
 * `normaliseLanguageTag` rather than a local `.toLowerCase()`, so the agreement
 * is structural: when the matcher's normalisation gained a `trim()`, this line
 * gained it in the same edit instead of quietly falling a step behind.
 */
function describe(track: SubtitleTrack): string {
  return `${track.id} (${normaliseLanguageTag(track.language)}, ${track.kind}, ${track.format})`;
}

/**
 * The REQUESTED side of the same rendering problem `describe` solves for the
 * track side, and it was left raw when that one was fixed.
 *
 * `languageMatch` compares `normaliseLanguageTag(want)`, so a policy carrying
 * `"PT-BR"` or `" fr"` -- both reachable, because `selectSubtitleTrack` takes
 * the TYPE and the schema's `.transform()` only runs on `.parse()` -- was matched as
 * `pt-br` and `fr` and then printed here verbatim. This string exists precisely
 * for the outcomes where nothing matched, so the one line telling a reader what
 * we looked for was the one line disagreeing with what we actually looked for:
 * someone debugging `no_preferred_language_available` would compare a track
 * rendered as `pt-br` against a request rendered as `PT-BR` and conclude the
 * case fold was the bug.
 *
 * Normalised rather than the comparator loosened. The matcher is right to fold
 * case and trim; only the trail was wrong, and it is fixed where a human reads
 * it so the shared `languageMatch` keeps one definition of a language tag.
 */
function describeLanguages(effective: EffectiveLanguages): string {
  const listed = effective.languages
    .map((language) => normaliseLanguageTag(language))
    .filter((language) => language !== "");
  if (!listed.length) return "no language requested";
  const suffix = effective.source === "audio_language_for_hearing_impaired" ? " (from the audio)" : "";
  return `looked for: ${listed.join(", ")}${suffix}`;
}

/**
 * Key a subtitle policy to the audio that will ACTUALLY play.
 *
 * `audioLanguage` is the only field coupling this policy to the audio decision,
 * and the entire forced-narrative branch is dead without it. Leaving each caller
 * to populate it by hand has two failure modes and neither of them raises
 * anything:
 *
 *   - Forget it, and `null` disables forced selection completely. Nothing
 *     reports an error; the viewer simply gets untranslated foreign dialogue.
 *   - Fill it from `PlaybackCapabilities.preferredAudioLanguages`, which is the
 *     nearest language-shaped value to hand, and it is wrong whenever the
 *     preference could not be honoured -- which is routine. A viewer preferring
 *     French, served Japanese because no French mix exists, would have forced
 *     selection hunting a FRENCH forced track over JAPANESE audio: it captions
 *     lines they could already follow and leaves the ones they cannot. That is
 *     precisely the failure `subtitlePolicySchema.audioLanguage` documents.
 *
 * So this takes the `AudioSelection`, not a language and not a track: the input
 * is the DECISION, which is the only thing that knows what will be heard.
 *
 * `null` in four cases, all of them genuinely unknown rather than defaulted:
 * audio selection chose nothing (`no_audio_tracks`, `no_eligible_tracks`,
 * `no_auto_selectable_tracks`), the chosen track states no language, it states
 * only whitespace, or -- trimmed -- it states a single character.
 *
 * The test is the LENGTH the contract requires, not emptiness. `audioLanguage` is
 * declared `z.string().min(2).transform(...).nullable()`, so `""` and `"e"` are
 * equally values that field forbids, and a guard that only rejected `""` would
 * write a one-character tag straight through and construct a `SubtitlePolicy` the
 * schema would reject. `selectAudioTrack` takes the TYPE, so a provider adapter
 * constructing a track literal reaches all four cases. What a sub-minimum tag
 * would mean is "a language I cannot name" -- which is what `null` is already
 * for.
 *
 * Lower-cased because this CONSTRUCTS a `SubtitlePolicy` and the schema
 * lower-cases that field on `.parse()`. `languageMatch` folds case anyway, so
 * this is about the value being what the contract says it is, not about making
 * the comparison work.
 *
 * Every other field is passed through untouched: this establishes one fact and
 * has no opinion about the viewer's settings.
 */
export function withSelectedAudio(policy: SubtitlePolicy, audio: AudioSelection): SubtitlePolicy {
  const selected = audio.selected;
  const language = selected === null ? "" : normaliseLanguageTag(selected.language);
  return { ...policy, audioLanguage: language.length < 2 ? null : language };
}

/**
 * Pure and deterministic: same tracks and policy in, same selection out,
 * regardless of input ordering. Every list in the result is sorted by a
 * comparator that terminates in a UTF-16 code-unit tiebreak on the track id, so
 * the WHOLE result is order-invariant, not merely `selected`.
 *
 * THE PRECEDENCE, IN ONE PLACE. Steps 1, 2, 4, 5 and 6 are the TERMINAL ones:
 * they are early returns in the order written and step 6 is exhaustive, so every
 * input leaves by exactly one of them and "given any input, exactly one outcome"
 * is structural rather than a claim. Step 3 ends nothing -- it is the language
 * derivation that every input surviving step 2 passes through, and steps 4 to 6
 * read its result. `SUBTITLE_OUTCOME_BY_REASON` says what each resulting reason
 * puts on screen.
 *
 *   1. RENDERABILITY. A track whose format `supportedFormats` does not list is
 *      rejected before anything else looks at it, because selecting one produces
 *      a confident answer that shows nothing. If nothing survives:
 *      `no_subtitle_tracks` when the stream offered none, `no_eligible_tracks`
 *      when it offered some and the client can draw none. Checked BEFORE `mode`,
 *      because whether this stream carries subtitles at all is knowledge only
 *      these inputs hold, while the viewer's mode is already in the caller's hand.
 *   2. OFF. `mode: "off"` ends the decision: nothing from the automatic pool can
 *      be selected, whatever its language, kind or provider default. The single
 *      exception is a forced track that fits the audio
 *      (`forced_narrative_with_subtitles_off`), which the contract defines as
 *      part of presenting the film rather than as subtitles the viewer declined.
 *      Otherwise `off_by_viewer_preference`, with `ordered` still populated so
 *      "you turned these off" stays distinguishable from "there is nothing to
 *      turn on".
 *   3. LANGUAGE. The viewer's `preferredLanguages` if it holds any non-blank
 *      entry; otherwise, and only for a `hearingImpaired` viewer with a KNOWN
 *      `audioLanguage`, that audio language; otherwise none at all. This is the
 *      only place the policy supplies a language nobody stated, and the reason
 *      values keep the derivation visible.
 *   4. FULL SUBTITLES. The best automatic-pool track in one of those languages,
 *      ranked by `compareTracks`: any language match over none, then language
 *      group, then exact-over-variant, then preference index, then kind, then the
 *      provider default, then format, then the track id. Nothing outside those
 *      languages is ever selected, so there is no "first eligible" fallback --
 *      audio must play something, subtitles must not appear uninvited.
 *   5. FORCED. Failing that, the best forced track that belongs to the audio in
 *      play (`forced_narrative_for_audio_language`), ranked by
 *      `compareForcedTracks`, which asks about the AUDIO language and never about
 *      what the viewer likes to read.
 *   6. NOTHING, and which nothing: `no_preference_expressed`,
 *      `preferred_language_forced_only`, `preferred_language_manual_only`,
 *      `preferred_language_other_script_only`, or
 *      `no_preferred_language_available`.
 *
 * Where `isDefault` sits, because it is the input most often mistaken for an
 * instruction: sixth of the eight criteria at step 4, below everything the viewer
 * expressed and above only format and the id tiebreak, and third of the five in
 * the forced comparator. It is therefore consulted only among tracks that have
 * already qualified, and it can decide WHICH track is shown but never WHETHER one
 * is. A `DEFAULT=YES` in a manifest is frequently just whichever rendition was
 * written first; it must never speak over the viewer.
 *
 * Ties are broken by the track id compared by UTF-16 CODE UNIT, never by the
 * order the provider listed its tracks in. The only input ordering this policy treats as
 * meaningful is `preferredLanguages`, which the contract declares meaningful.
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
  const match = best
    ? languageMatch(best.language, effective.languages, "require_compatible_script")
    : null;

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
     * The subtag reason now carries exactly one meaning: a same-language
     * fallback that is NOT a script substitution. It used to carry two.
     * `primarySubtag` reduces `zh-Hant` and `zh-Hans` alike to `zh`, so
     * "requested zh-Hant, served zh-Hans" reported the same value as "requested
     * en-GB, served en-US" -- and those are not comparable degradations. en-GB
     * to en-US costs a reader nothing; zh-Hant to zh-Hans hands a
     * traditional-script reader a script they may not read at all, while the
     * trail tells them their language was matched. sr-Latn/sr-Cyrl,
     * uz-Latn/uz-Cyrl and az-Latn/az-Arab collapsed the same way.
     *
     * A stated script conflict is no longer a language match, so that pair
     * cannot reach this branch at all. It falls past it -- to the forced
     * narrative track if one fits the audio, and otherwise out of step 6 as
     * `preferred_language_other_script_only`, with nothing on screen and the
     * track still returned so a player can present it deliberately.
     * The rule lives in the shared `languageMatch` as a `ScriptPolicy`
     * argument, which audio passes differently and for stated reasons, rather
     * than as a special case here -- subtitle selection must not develop a
     * private notion of "the same language", which is the divergence
     * `audioLanguageFit` above refuses to create.
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

  const reason = unmatchedReason(effective, forced, manualOnly, eligible);
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
