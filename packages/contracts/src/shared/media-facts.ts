import { z } from "zod";

/* -------------------------------------------------------------------------
 * Shared vocabulary: media facts
 *
 * A LEAF module: the NAMES of the four facts and their canonical order, with no
 * reference to any shape that carries them. The playback contract owns the
 * candidate that states these facts (`domains/playback.ts`), and
 * `unknownMediaFacts` lives there with it, because a function over a candidate
 * is a playback fact rather than a vocabulary.
 *
 * The vocabulary is shared rather than playback-private because it is what a
 * reason trail is written in: an adapter labels what it could not observe, an
 * API response explains a ranking with it, and a future data-saver policy reads
 * it. Those consumers name the facts without necessarily holding a candidate.
 * ---------------------------------------------------------------------- */

/**
 * The four candidate fields a provider may genuinely be unable to state.
 *
 * Named as a first-class enum rather than left implicit in the candidate shape,
 * because a reason trail has to say WHICH fact was missing, not merely that
 * something was. "Ranked lower because the codec was never stated" and "ranked
 * lower because the bitrate was never stated" send a reader to different
 * systems.
 *
 * The order is the order in which a missing value matters, and it matches the
 * order the Stremio adapter reports its refusals in: codecs decide whether a
 * stream can play at all, resolution and bitrate only decide how well. Every
 * derived list is produced by filtering this constant, so two subsystems can
 * never disagree about the order and no published list depends on the order an
 * object literal happened to be written in.
 */
export const mediaFactSchema = z.enum(["videoCodec", "audioCodec", "height", "bitrateKbps"]);
export type MediaFact = z.infer<typeof mediaFactSchema>;

export const MEDIA_FACTS: readonly MediaFact[] = [
  "videoCodec",
  "audioCodec",
  "height",
  "bitrateKbps"
];
