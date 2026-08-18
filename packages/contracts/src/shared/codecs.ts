import { z } from "zod";

/* -------------------------------------------------------------------------
 * Shared vocabulary: codecs
 *
 * A LEAF module. Shared because three domains name the same values and must not
 * be able to disagree about them: a stream candidate STATES a codec, playback
 * capabilities enumerate the codecs a device can DECODE, and an audio track
 * declares the codec it is ENCODED in. Three copies of these two enums would
 * drift, and the drift would surface as a device rejecting a stream it can
 * actually play.
 * ---------------------------------------------------------------------- */

export const videoCodecSchema = z.enum(["h264", "hevc", "av1", "vp9"]);
export const audioCodecSchema = z.enum(["aac", "ac3", "eac3", "opus"]);

/**
 * The KNOWN codec values, exported as named types (PL-0205).
 *
 * `StreamCandidate["videoCodec"]` is no longer usable as "a codec": it now
 * includes `null`. Code that genuinely needs a real codec -- a lookup table
 * keyed by codec, a decoder capability map -- must say so, and `Record<K, V>`
 * will not even accept `null` as a key. Naming the non-null types keeps those
 * call sites expressing the right thing instead of reaching for `NonNullable<>`
 * around a field reference.
 */
export type VideoCodec = z.infer<typeof videoCodecSchema>;
export type AudioCodec = z.infer<typeof audioCodecSchema>;
