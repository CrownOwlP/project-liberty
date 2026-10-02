/* -------------------------------------------------------------------------
 * Audio and subtitle selection, between the engine and the contracted policy
 * (PW-0206)
 *
 * ===========================================================================
 * WHAT THIS MODULE IS, IN ONE SENTENCE
 * ===========================================================================
 *
 * It turns the tracks an ENGINE reports into the tracks the CONTRACTED POLICY
 * decides over, applies that policy, and remembers a viewer's own choice well
 * enough to re-apply it after a candidate switch -- and it invents nothing on
 * the way through.
 *
 * It decides no policy of its own. `selectAudioTrack` and `selectSubtitleTrack`
 * in `@liberty/media-engine` are the policy, over the contract shapes in
 * `@liberty/contracts`, and the acceptance says so in terms: the default
 * selection comes from there "rather than a second policy being invented here".
 * Everything below is a bridge, an identity, and a reason trail.
 *
 * ===========================================================================
 * THE IMPEDANCE MISMATCH, WHICH IS THE WHOLE DIFFICULTY
 * ===========================================================================
 *
 * `AudioTrack` and `SubtitleTrack` describe what a PROVIDER ships, where every
 * field is known because somebody catalogued it. `PlayerTrack` describes what
 * an ENGINE found in a manifest, where several of those fields are routinely
 * absent. Four of them are required by the contract and nullable at the
 * boundary: audio `role` and `channels`, subtitle `kind` and `format`.
 *
 * So each one is answered separately, and the two answers are different in
 * kind:
 *
 *   - AN ASSUMPTION, where the format's own signalling makes absence
 *     meaningful. DASH and HLS mark commentary and audio description
 *     EXPLICITLY; an unmarked track is an ordinary mix, and that is what the
 *     signalling is for. The same holds for an unmarked subtitle track that is
 *     not forced. Those are assumed, and every assumption is reported in the
 *     result with the track it was made about and the reason -- product
 *     invariant 4 is a reason trail sufficient to debug a selection, and an
 *     assumption nobody can see is the opposite of one.
 *
 *   - UNDECIDABLE, where absence means the policy cannot run. A track with no
 *     language cannot be ranked by a language policy. A track whose codec
 *     cannot be named cannot be checked against the device's decoders. A
 *     subtitle whose format is unknown cannot be checked against what this
 *     client can draw -- and `subtitles.ts` records that an unrenderable
 *     subtitle format "fails silently far more often than an audio codec
 *     does", which is exactly why this one is not assumed.
 *
 * AN UNDECIDABLE TRACK IS STILL OFFERED. It is excluded from AUTOMATIC
 * selection and listed for the viewer to choose deliberately, with the fields
 * that were missing named. Hiding a track because we could not describe it
 * would be the worse failure: the track exists and the viewer may want it.
 *
 * ===========================================================================
 * WHY A VIEWER'S CHOICE CANNOT BE REMEMBERED AS A TRACK ID
 * ===========================================================================
 *
 * The acceptance requires a viewer's selection to survive a failover, "because
 * a candidate switch is a full teardown and losing the viewer's language on a
 * network blip is the defect this clause exists to prevent".
 *
 * A track id does not survive that teardown. `WebPlayerAdapter` builds audio
 * ids as `audio:<language>` and takes subtitle ids from whatever the manifest
 * said; a different candidate is a different manifest, from possibly a
 * different provider, and the ids are not the same strings. Remembering the id
 * would lose the choice on precisely the event the clause names.
 *
 * So a choice is remembered as a `TrackIdentity` -- what the viewer actually
 * chose, which is a language and a purpose -- and re-applied by MATCHING, with
 * the confidence of the match reported rather than hidden. See `reapply`.
 * ---------------------------------------------------------------------- */
import type { AudioRole, AudioTrack } from "@liberty/contracts/domains/audio";
import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";
import type {
  SubtitleFormat,
  SubtitleKind,
  SubtitleMode,
  SubtitlePolicy,
  SubtitleTrack
} from "@liberty/contracts/domains/subtitles";
import type { AudioCodec } from "@liberty/contracts/shared/codecs";
import {
  selectAudioTrack,
  selectSubtitleTrack,
  withSelectedAudio,
  type AudioSelection,
  type SubtitleSelection
} from "@liberty/media-engine";

import type { PlayerTrack, PlayerTrackKind } from "./player-adapter";

/* ===========================================================================
 * CONVERSION
 * ======================================================================== */

/** A field the contract requires that the engine did not state, and we assumed. */
export type AssumedField = "role" | "channels" | "kind";

/** A field the contract requires that the engine did not state, and we will not assume. */
export type UndecidableField = "language" | "codec" | "format";

export interface TrackAssumption {
  readonly trackId: string;
  readonly field: AssumedField;
  readonly assumed: string;
  readonly because: string;
}

export interface TrackUndecidable {
  readonly trackId: string;
  /** Sorted, so the same track always reports the same list. */
  readonly fields: readonly UndecidableField[];
}

export type TrackConversion<T> =
  | { readonly converted: true; readonly track: T; readonly assumptions: readonly TrackAssumption[] }
  | { readonly converted: false; readonly fields: readonly UndecidableField[] };

/**
 * Assumed when the engine states no role.
 *
 * Not a preference. DASH signals `commentary` and `description` with explicit
 * role descriptors and HLS with CHARACTERISTICS, so a track carrying neither
 * is one nobody marked as special -- which is what "main" means. The contract
 * ranks `original` above `main` as a fallback, so this assumption never
 * outranks a stated role: it only makes an unmarked track eligible at all.
 */
const ASSUMED_ROLE: AudioRole = "main";
const ASSUMED_ROLE_BECAUSE =
  "the engine stated no role. DASH and HLS mark commentary and audio description explicitly, " +
  "so an unmarked track is an ordinary mix rather than one that needs an explicit request";

/**
 * Assumed when the engine states no channel count.
 *
 * Two, and the direction matters. `maxAudioChannels` is optional in
 * `PlaybackCapabilities` and absent means "no channel constraint known", so
 * this value is consulted only by a device that stated a maximum -- and
 * assuming the MINIMUM means an undescribed track is never wrongly REJECTED by
 * that check. It also ranks undescribed tracks below described ones in the
 * policy's comparator, which is the conservative order: a track we can
 * describe is a better default than one we cannot.
 */
const ASSUMED_CHANNELS = 2;
const ASSUMED_CHANNELS_BECAUSE =
  "the engine stated no channel count. Two is assumed because it is the floor: a device that " +
  "declared a maximum can then never reject this track for exceeding it, and the policy's " +
  "comparator ranks it below any track that did state its layout";

const ASSUMED_SUBTITLE_KIND: SubtitleKind = "subtitles";
const ASSUMED_SUBTITLE_KIND_BECAUSE =
  "the engine stated no kind and did not mark the track forced. Commentary and caption tracks " +
  "are signalled explicitly, so an unmarked track is an ordinary subtitle track";

/**
 * Codec strings an engine reports → the contract's `AudioCodec`.
 *
 * RFC 6381 spellings as well as plain names, because a manifest states the
 * former and a container often the latter. `mp4a.40.*` is AAC in all its
 * profile numbers, so the family is matched by prefix rather than listing
 * them; everything else is an exact match on the part before any profile
 * suffix.
 *
 * AN UNRECOGNISED CODEC IS `null`, NEVER A GUESS. The device-capability check
 * is what keeps a viewer from selecting a track their machine cannot decode,
 * and a wrong codec name makes that check answer confidently about the wrong
 * decoder.
 */
export function toAudioCodec(codec: string | null): AudioCodec | null {
  if (codec === null) return null;
  const normalised = codec.trim().toLowerCase();
  if (normalised === "") return null;
  if (normalised.startsWith("mp4a.40") || normalised === "mp4a" || normalised === "aac") {
    return "aac";
  }
  switch (normalised.split(".", 1)[0]) {
    case "ac-3":
    case "ac3":
      return "ac3";
    case "ec-3":
    case "eac3":
    case "ec3":
      return "eac3";
    case "opus":
      return "opus";
    default:
      return null;
  }
}

/** Sorted and de-duplicated, so one track always reports one list. */
function fields(...found: readonly (UndecidableField | null)[]): readonly UndecidableField[] {
  return [...new Set(found.filter((f): f is UndecidableField => f !== null))].sort();
}

export function toAudioTrack(track: PlayerTrack): TrackConversion<AudioTrack> {
  const codec = toAudioCodec(track.codec);
  const language = track.language?.trim().toLowerCase() ?? null;
  const missing = fields(
    language === null || language.length < 2 ? "language" : null,
    codec === null ? "codec" : null
  );
  if (missing.length > 0 || language === null || codec === null) {
    return { converted: false, fields: missing };
  }

  const assumptions: TrackAssumption[] = [];
  if (track.audioRole === null) {
    assumptions.push({
      trackId: track.id,
      field: "role",
      assumed: ASSUMED_ROLE,
      because: ASSUMED_ROLE_BECAUSE
    });
  }
  if (track.channels === null) {
    assumptions.push({
      trackId: track.id,
      field: "channels",
      assumed: String(ASSUMED_CHANNELS),
      because: ASSUMED_CHANNELS_BECAUSE
    });
  }

  return {
    converted: true,
    assumptions,
    track: {
      id: track.id,
      language,
      codec,
      channels: track.channels ?? ASSUMED_CHANNELS,
      role: track.audioRole ?? ASSUMED_ROLE,
      isDefault: track.isDefault
    }
  };
}

export function toSubtitleTrack(track: PlayerTrack): TrackConversion<SubtitleTrack> {
  const language = track.language?.trim().toLowerCase() ?? null;
  const missing = fields(
    language === null || language.length < 2 ? "language" : null,
    track.textFormat === null ? "format" : null
  );
  if (missing.length > 0 || language === null || track.textFormat === null) {
    return { converted: false, fields: missing };
  }

  const assumptions: TrackAssumption[] = [];
  let kind: SubtitleKind;
  if (track.subtitleKind !== null) {
    kind = track.subtitleKind;
  } else if (track.isForced) {
    /* Not an assumption: the engine said forced, and `forced` is a kind. */
    kind = "forced";
  } else {
    kind = ASSUMED_SUBTITLE_KIND;
    assumptions.push({
      trackId: track.id,
      field: "kind",
      assumed: kind,
      because: ASSUMED_SUBTITLE_KIND_BECAUSE
    });
  }

  return {
    converted: true,
    assumptions,
    track: {
      id: track.id,
      language,
      kind,
      format: track.textFormat,
      isDefault: track.isDefault
    }
  };
}

/* ===========================================================================
 * IDENTITY, AND SURVIVING A CANDIDATE SWITCH
 * ======================================================================== */

export interface TrackIdentity {
  readonly kind: PlayerTrackKind;
  /** Lower-cased where stated. `null` = the track the viewer chose had no language. */
  readonly language: string | null;
  readonly audioRole: AudioRole | null;
  readonly subtitleKind: SubtitleKind | null;
  readonly channels: number | null;
  readonly label: string | null;
}

export function identify(track: PlayerTrack): TrackIdentity {
  return {
    kind: track.kind,
    language: track.language?.trim().toLowerCase() ?? null,
    audioRole: track.audioRole,
    subtitleKind: track.subtitleKind ?? (track.isForced ? "forced" : null),
    channels: track.channels,
    label: track.label
  };
}

/**
 * How closely a re-applied choice matched, most to least.
 *
 * REPORTED, NOT HIDDEN, because the three are different outcomes for a viewer.
 * `exact` restored what they had. `purpose` restored their language and the
 * kind of track they wanted but something else about it differs -- a different
 * channel layout, a different label. `language` gave them their language and
 * something else about the PURPOSE changed, which for a subtitle track can
 * mean SDH where they had plain subtitles. `none` means their choice does not
 * exist on this candidate at all, and the policy decides instead.
 */
export type ReapplyConfidence = "exact" | "purpose" | "language" | "none";

export interface Reapplied {
  readonly trackId: string | null;
  readonly confidence: ReapplyConfidence;
  readonly explanation: string;
}

function purposeOf(identity: TrackIdentity): string | null {
  return identity.kind === "audio" ? identity.audioRole : identity.subtitleKind;
}

/**
 * Find the track on THIS candidate that is the one the viewer chose on the
 * last one.
 *
 * Three passes, narrowest first, and each one stops at the first match in the
 * order the engine listed the tracks -- which is the engine's own preference
 * order and the only ordering available here.
 *
 * A choice whose identity carries NO LANGUAGE cannot be matched beyond an
 * exact field-for-field hit: language is the thing a viewer is actually
 * choosing, and matching "the track with no language" to a different track
 * with no language would be matching on the absence of information.
 */
export function reapply(identity: TrackIdentity, tracks: readonly PlayerTrack[]): Reapplied {
  const candidates = tracks.filter((track) => track.kind === identity.kind);

  const exact = candidates.find((track) => {
    const other = identify(track);
    return (
      other.language === identity.language &&
      other.audioRole === identity.audioRole &&
      other.subtitleKind === identity.subtitleKind &&
      other.channels === identity.channels &&
      other.label === identity.label
    );
  });
  if (exact !== undefined) {
    return {
      trackId: exact.id,
      confidence: "exact",
      explanation: `restored the viewer's ${identity.kind} choice exactly (${exact.id})`
    };
  }

  if (identity.language === null) {
    return {
      trackId: null,
      confidence: "none",
      explanation:
        `the viewer's ${identity.kind} choice stated no language, so it can only be restored by ` +
        "an exact match; this candidate offers none, and the policy decides"
    };
  }

  const purpose = purposeOf(identity);
  const samePurpose = candidates.find((track) => {
    const other = identify(track);
    return other.language === identity.language && purposeOf(other) === purpose;
  });
  if (samePurpose !== undefined) {
    return {
      trackId: samePurpose.id,
      confidence: "purpose",
      explanation:
        `restored the viewer's ${identity.language} ${identity.kind} choice by language and ` +
        `purpose (${samePurpose.id}); the track differs from the one they chose in some other ` +
        "respect"
    };
  }

  const sameLanguage = candidates.find((track) => identify(track).language === identity.language);
  if (sameLanguage !== undefined) {
    return {
      trackId: sameLanguage.id,
      confidence: "language",
      explanation:
        `restored the viewer's ${identity.language} ${identity.kind} choice by LANGUAGE ONLY ` +
        `(${sameLanguage.id}); no track on this candidate has the same purpose`
    };
  }

  return {
    trackId: null,
    confidence: "none",
    explanation:
      `this candidate offers no ${identity.kind} track in ${identity.language}; the policy decides`
  };
}

/* ===========================================================================
 * RESOLUTION
 * ======================================================================== */

/**
 * What the viewer asked for, if anything.
 *
 * `null` is "they have not chosen" and is NOT the same as `"off"`, which is a
 * state the contract models deliberately -- `subtitleModeSchema`'s own comment
 * explains that a viewer who turned subtitles off and a viewer for whom
 * nothing matched arrive at the same blank screen by different routes.
 */
export interface TrackChoice {
  readonly audio: TrackIdentity | null;
  readonly subtitle: TrackIdentity | "off" | null;
}

export const NO_CHOICE: TrackChoice = Object.freeze({ audio: null, subtitle: null });

/** The viewer's subtitle settings, minus the two fields this module supplies. */
export interface SubtitlePreferences {
  readonly preferredLanguages: readonly string[];
  readonly hearingImpaired: boolean;
  readonly supportedFormats: readonly SubtitleFormat[];
}

export interface TrackResolutionInput {
  readonly tracks: readonly PlayerTrack[];
  readonly capabilities: PlaybackCapabilities;
  readonly subtitles: SubtitlePreferences;
  readonly choice?: TrackChoice;
}

export interface ResolvedTrack {
  /** The engine track id to select, or `null` for "select nothing". */
  readonly trackId: string | null;
  /** `viewer` when their remembered choice decided it; `policy` otherwise. */
  readonly source: "viewer" | "policy";
  /** The policy's own reason code, or the re-application confidence. */
  readonly reason: string;
  readonly explanation: string;
  /** Ids to offer, in the order to show them. Automatic candidates first. */
  readonly offered: readonly string[];
  /** Playable but never automatic: commentary, audio description. */
  readonly manualOnly: readonly string[];
  /** Real tracks the policy could not reason about, with the fields that were missing. */
  readonly undecidable: readonly TrackUndecidable[];
  /** Every field this module filled in, named with the track and the reason. */
  readonly assumptions: readonly TrackAssumption[];
}

export interface TrackResolution {
  readonly audio: ResolvedTrack;
  readonly subtitle: ResolvedTrack;
}

interface Converted<T> {
  readonly tracks: readonly T[];
  readonly undecidable: readonly TrackUndecidable[];
  readonly assumptions: readonly TrackAssumption[];
}

function convertAll<T>(
  tracks: readonly PlayerTrack[],
  kind: PlayerTrackKind,
  convert: (track: PlayerTrack) => TrackConversion<T>
): Converted<T> {
  const converted: T[] = [];
  const undecidable: TrackUndecidable[] = [];
  const assumptions: TrackAssumption[] = [];
  for (const track of tracks) {
    if (track.kind !== kind) continue;
    const result = convert(track);
    if (result.converted) {
      converted.push(result.track);
      assumptions.push(...result.assumptions);
    } else {
      undecidable.push({ trackId: track.id, fields: result.fields });
    }
  }
  return { tracks: converted, undecidable, assumptions };
}

function ids(tracks: readonly { readonly id: string }[]): readonly string[] {
  return tracks.map((track) => track.id);
}

function resolveAudio(input: TrackResolutionInput): {
  readonly resolved: ResolvedTrack;
  readonly selection: AudioSelection;
} {
  const { tracks, undecidable, assumptions } = convertAll(input.tracks, "audio", toAudioTrack);
  const selection = selectAudioTrack(tracks, input.capabilities);

  const base = {
    offered: ids(selection.ordered),
    manualOnly: ids(selection.manualOnly),
    undecidable,
    assumptions
  } as const;

  const wanted = input.choice?.audio ?? null;
  if (wanted !== null) {
    /* Re-applied over the FULL engine list, undecidable tracks included. A
     * viewer may deliberately choose a track the policy could not reason
     * about, and refusing to restore it would quietly overrule them. */
    const restored = reapply(wanted, input.tracks);
    if (restored.trackId !== null) {
      return {
        selection,
        resolved: {
          ...base,
          trackId: restored.trackId,
          source: "viewer",
          reason: restored.confidence,
          explanation: restored.explanation
        }
      };
    }
    return {
      selection,
      resolved: {
        ...base,
        trackId: selection.selected?.id ?? null,
        source: "policy",
        reason: selection.reason,
        explanation: `${restored.explanation}. ${selection.explanation}`
      }
    };
  }

  return {
    selection,
    resolved: {
      ...base,
      trackId: selection.selected?.id ?? null,
      source: "policy",
      reason: selection.reason,
      explanation: selection.explanation
    }
  };
}

function resolveSubtitle(
  input: TrackResolutionInput,
  audio: AudioSelection,
  audioTrackId: string | null
): ResolvedTrack {
  const { tracks, undecidable, assumptions } = convertAll(input.tracks, "subtitle", toSubtitleTrack);

  /*
   * A VIEWER'S "OFF" IS A MODE, NOT A SHORT CIRCUIT.
   *
   * It is passed to the policy rather than returning `null` here, because
   * `subtitleKindSchema` records that a FORCED track survives an off
   * preference: it exists for a viewer who is not reading, to translate the
   * lines the soundtrack does not deliver. Short-circuiting on "off" would
   * delete that behaviour, which is the one kind of subtitle a viewer who
   * turned subtitles off still needs.
   */
  const mode: SubtitleMode = input.choice?.subtitle === "off" ? "off" : "auto";

  /*
   * The audio language the policy is told about is the audio that will ACTUALLY
   * PLAY, which is not always the policy's own pick -- the viewer may have
   * overridden it. `withSelectedAudio` is reused rather than reimplemented
   * because it owns the normalise-and-reject-sub-minimum-tag rule, and the
   * selection handed to it carries whichever track is really playing.
   */
  const playing = audioTrackId === null
    ? null
    : (audio.ordered.find((track) => track.id === audioTrackId) ??
       audio.manualOnly.find((track) => track.id === audioTrackId) ??
       null);
  const policy: SubtitlePolicy = withSelectedAudio(
    {
      mode,
      preferredLanguages: [...input.subtitles.preferredLanguages],
      hearingImpaired: input.subtitles.hearingImpaired,
      audioLanguage: null,
      supportedFormats: [...input.subtitles.supportedFormats]
    },
    { ...audio, selected: playing }
  );

  const selection: SubtitleSelection = selectSubtitleTrack(tracks, policy);
  const base = {
    offered: ids(selection.ordered),
    manualOnly: ids(selection.manualOnly),
    undecidable,
    assumptions
  } as const;

  const wanted = input.choice?.subtitle ?? null;
  if (wanted !== null && wanted !== "off") {
    const restored = reapply(wanted, input.tracks);
    if (restored.trackId !== null) {
      return {
        ...base,
        trackId: restored.trackId,
        source: "viewer",
        reason: restored.confidence,
        explanation: restored.explanation
      };
    }
    return {
      ...base,
      trackId: selection.selected?.id ?? null,
      source: "policy",
      reason: selection.reason,
      explanation: `${restored.explanation}. ${selection.explanation}`
    };
  }

  return {
    ...base,
    trackId: selection.selected?.id ?? null,
    /* "off" is the VIEWER's, even when the policy is what turned the forced
     * track on underneath it, so the source says who the decision belongs to. */
    source: wanted === "off" ? "viewer" : "policy",
    reason: selection.reason,
    explanation: selection.explanation
  };
}

/**
 * The whole decision, for one candidate, as a pure function.
 *
 * Audio first and subtitles second, and that order is load-bearing rather than
 * tidy: a forced subtitle track is keyed to the language coming out of the
 * SPEAKERS, not to what the viewer likes to read, so the subtitle decision
 * cannot be made until the audio one has been.
 */
export function resolveTracks(input: TrackResolutionInput): TrackResolution {
  const { resolved, selection } = resolveAudio(input);
  return { audio: resolved, subtitle: resolveSubtitle(input, selection, resolved.trackId) };
}

/**
 * What to remember when a viewer picks a track, by id, from a list.
 *
 * `null` when the id is not in the list, which is a caller error rather than a
 * state to encode -- a UI can only offer what it was given.
 */
export function rememberChoice(
  tracks: readonly PlayerTrack[],
  trackId: string
): TrackIdentity | null {
  const track = tracks.find((entry) => entry.id === trackId);
  return track === undefined ? null : identify(track);
}
