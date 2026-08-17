import { z } from "zod";

/* -------------------------------------------------------------------------
 * Subtitles (PL-0203)
 *
 * A module of its own rather than more of `index.ts`, and deliberately one that
 * imports nothing from it. `title.ts` and `search.ts` both have to reach shared
 * vocabularies through `z.lazy` because `index.ts` re-exports them and reading a
 * sibling's `const` at module scope would touch it inside its temporal dead
 * zone. Nothing here needs the rights or codec vocabularies, so the cycle never
 * forms and no deferral is required.
 * ---------------------------------------------------------------------- */

/**
 * What a subtitle track is FOR, which is not the same as what it contains.
 *
 * Two tracks can carry near-identical text and still be aimed at different
 * viewers, and the selection policy turns entirely on that distinction:
 *
 *   - `subtitles` -- a full transcription or translation of the dialogue, for a
 *     viewer who has chosen to read.
 *   - `sdh` -- the same, plus speaker identification and non-speech audio, for a
 *     viewer who cannot hear the soundtrack. Frequently the ONLY subtitle track
 *     a title ships in a given language, so it must remain automatically
 *     selectable for everyone; it is an accessibility track, not a novelty one.
 *   - `forced` -- only the lines the soundtrack does not deliver: foreign
 *     dialogue and on-screen signage. It exists for a viewer who is NOT reading
 *     subtitles, which makes it the one kind that survives an "off" preference.
 *   - `commentary` -- subtitled commentary or trivia. Never something a viewer
 *     should be given without asking.
 *
 * One enum rather than orthogonal `forced`/`hearingImpaired` booleans, which
 * would describe four states of which two ("forced SDH", "forced commentary")
 * are not things that exist -- and an unrepresentable state cannot be reasoned
 * about wrongly. This mirrors `audioRoleSchema`, which makes the same trade for
 * the same reason. Like role, `kind` is a first-class field rather than
 * something inferred from a provider-authored track title, because "SDH" in a
 * label is a naming convention and this is a decision input.
 */
export const subtitleKindSchema = z.enum(["subtitles", "sdh", "forced", "commentary"]);
export type SubtitleKind = z.infer<typeof subtitleKindSchema>;

/**
 * Timed-text formats a device may or may not be able to render.
 *
 * Present for the same reason `supportedAudioCodecs` is: a track the client
 * cannot render is not a track, and a policy that selects one has produced a
 * confident answer that shows nothing on screen. A subtitle format the renderer
 * does not understand fails silently far more often than an audio codec does,
 * which is exactly why it has to be decided here rather than discovered at
 * playback.
 */
export const subtitleFormatSchema = z.enum(["webvtt", "ttml", "srt", "ass"]);
export type SubtitleFormat = z.infer<typeof subtitleFormatSchema>;

export const subtitleTrackSchema = z.object({
  id: z.string().min(1),
  /**
   * BCP-47-ish, normalised to lower case so "pt-BR" and "pt-br" cannot become
   * two different languages. Matching is on the primary subtag, so a viewer who
   * asked for "pt-PT" is still offered a "pt-BR" track rather than nothing.
   */
  language: z.string().min(2).transform((value) => value.toLowerCase()),
  kind: subtitleKindSchema,
  format: subtitleFormatSchema,
  /** The provider's own default. A hint, never an override of viewer intent. */
  isDefault: z.boolean()
});
export type SubtitleTrack = z.infer<typeof subtitleTrackSchema>;

/**
 * Whether the viewer is reading at all.
 *
 * `off` is a STATE, not the absence of one. A viewer who turned subtitles off
 * and a viewer for whom nothing matched arrive at the same empty screen by
 * different routes, and a player has to be able to tell them apart: one wants a
 * "no subtitles available for this title" affordance, the other must never see
 * it. Modelling `off` as "an empty preference list" would collapse the two.
 *
 * `auto` means "decide from my preferences", and an `auto` viewer with no stated
 * language still gets no subtitles -- unlike audio, where something must play,
 * the correct default here is nothing on screen.
 *
 * Two values, and `off` deliberately does not mean "never put text on screen":
 * see `forced` in `subtitleKindSchema`. If the product ever needs a true
 * suppress-everything mode, that is a NEW value here, not a reinterpretation of
 * this one -- redefining `off` would silently change what every viewer who
 * already set it gets.
 */
export const subtitleModeSchema = z.enum(["auto", "off"]);
export type SubtitleMode = z.infer<typeof subtitleModeSchema>;

/**
 * Everything the subtitle decision is allowed to depend on.
 *
 * Viewer intent and device capability in one object because the policy is a pure
 * function of both and neither is meaningful alone; the same shape is why
 * `PlaybackCapabilities` carries `preferredAudioLanguages` beside
 * `supportedAudioCodecs`.
 */
export const subtitlePolicySchema = z.object({
  mode: subtitleModeSchema,
  /** Ordered, most-preferred first. Order is meaningful, not a set. */
  preferredLanguages: z.array(z.string()).default([]),
  /**
   * The viewer's accessibility setting. It answers WHICH KIND of track they
   * need when subtitles are shown, not by itself whether subtitles are shown --
   * with one exception documented at `selectSubtitleTrack`, where the audio
   * language supplies the missing language for a viewer who cannot hear it.
   */
  hearingImpaired: z.boolean().default(false),
  /**
   * The language of the audio that will actually play, required and explicitly
   * nullable: `null` means no audio selection has been established, never
   * "silent" and never a language to guess at.
   *
   * A forced track is keyed to the AUDIO, not to what the viewer likes to read:
   * an English forced track exists to translate the Japanese lines inside an
   * English soundtrack, and showing it over French audio would caption dialogue
   * the viewer can already understand while leaving the foreign lines untouched.
   * Without this field, forced selection would have to guess, and `.optional()`
   * would make "nobody told me" indistinguishable from "we could not determine
   * it" -- the same argument the media-fact nullability in `index.ts` makes.
   */
  audioLanguage: z.string().min(2).transform((value) => value.toLowerCase()).nullable(),
  /**
   * Formats the client can render. Deliberately NOT `.min(1)`: a device that
   * renders no timed text at all is a real device, and requiring it to name a
   * format it cannot draw would make every track spuriously eligible. An empty
   * list rejects everything, which is the honest outcome and is reported as
   * such.
   */
  supportedFormats: z.array(subtitleFormatSchema).default([])
});
export type SubtitlePolicy = z.infer<typeof subtitlePolicySchema>;
