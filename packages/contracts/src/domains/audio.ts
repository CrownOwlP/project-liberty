import { z } from "zod";
import { audioCodecSchema } from "../shared/codecs";

/* -------------------------------------------------------------------------
 * Audio tracks (PL-0202)
 *
 * The sibling of `./subtitles`: that module answers "what, if anything, do we
 * put on screen", this one describes the sound tracks a title ships and what
 * each is FOR. Depends on the shared codec vocabulary and on nothing else, so
 * an audio contract change cannot invalidate a playback or catalog build.
 * ---------------------------------------------------------------------- */

/**
 * What an audio track is FOR, which is not the same as what it sounds like.
 *
 * Role is a first-class field rather than something inferred from the track
 * title, because titles are provider-authored free text and the difference
 * between a main mix and a director's commentary is not a stylistic detail --
 * selecting commentary by accident is one of the more jarring failures a player
 * can produce. `original` marks the language the work was produced in, which is
 * the correct fallback when none of the viewer's preferred languages exist.
 */
export const audioRoleSchema = z.enum([
  "main",
  "original",
  "dub",
  "descriptive",
  "commentary"
]);
export type AudioRole = z.infer<typeof audioRoleSchema>;

export const audioTrackSchema = z.object({
  id: z.string().min(1),
  /**
   * BCP-47-ish. Normalised to lower case so "en-US" and "en-us" cannot become
   * two different languages; matching is on the SPOKEN LANGUAGE, which is the
   * primary subtag for almost every tag, so a viewer who asked for "en-GB" is
   * still served an "en" track rather than nothing.
   *
   * The exception is an EXTENDED LANGUAGE subtag ("zh-cmn", "zh-yue"), which
   * names the language rather than the "zh" it is prefixed with. A macrolanguage
   * is not a language, and RFC 5646 notes the varieties "zh" encompasses are
   * generally not mutually intelligible when spoken -- so Cantonese is not served
   * to a listener who asked for Mandarin, and neither is served for a bare "zh".
   * The prefixed and bare spellings of one variety are the same language in both
   * directions. The rule lives in `languageMatch` in `@liberty/media-engine`.
   */
  language: z.string().min(2).transform((value) => value.toLowerCase()),
  codec: audioCodecSchema,
  /** 2 = stereo, 6 = 5.1, 8 = 7.1. */
  channels: z.number().int().min(1).max(16),
  role: audioRoleSchema,
  /** The provider's own default. A hint, never an override of viewer intent. */
  isDefault: z.boolean()
});
export type AudioTrack = z.infer<typeof audioTrackSchema>;
