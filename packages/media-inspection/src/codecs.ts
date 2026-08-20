import type { AudioCodec, VideoCodec } from "@liberty/contracts/shared/codecs";

/* -------------------------------------------------------------------------
 * RFC 6381 codec identifiers, read rather than guessed.
 *
 * Both manifest formats declare codecs as a comma-separated list of RFC 6381
 * identifiers: HLS in `#EXT-X-STREAM-INF:CODECS`, DASH in `Representation@codecs`
 * or `AdaptationSet@codecs`. This module does two things to that list and
 * nothing else: it splits identifiers into the video family and the audio family
 * by their four-character prefix, and it maps the ones the
 * `@liberty/contracts` vocabulary can express onto that vocabulary.
 *
 * WHAT THIS MODULE REFUSES TO DO, because PL-0205 exists:
 *
 *   - It never derives a codec from a container, a file extension, a MIME type
 *     or a bitrate. The only input is the declaration itself.
 *   - It never maps an identifier it does not recognise onto the nearest
 *     vocabulary member. An unrecognised identifier yields `null` for the
 *     normalised field while the raw string is kept in full, so the consumer
 *     sees "declared, not understood" rather than either a guess or a silence.
 *   - It never resolves an ambiguity by picking. Two different video
 *     identifiers in one declaration, or a mix of recognised and unrecognised
 *     ones, yields `null`.
 *
 * THE RAW STRING IS NOT DEBUG RESIDUE. The vocabulary has four video values;
 * `avc1.640028` additionally states High profile at level 4.0, which is the
 * difference between a stream a device can decode and one it cannot. Discarding
 * it at this boundary would make that check impossible later without a second
 * fetch.
 * ---------------------------------------------------------------------- */

/**
 * Prefixes that name a video sample entry. Sourced from RFC 6381 and the ISO
 * registration authority, not from what our fixtures happen to contain.
 */
const VIDEO_PREFIXES: readonly string[] = [
  "avc1",
  "avc2",
  "avc3",
  "avc4",
  "hev1",
  "hvc1",
  "hvt1",
  "lhv1",
  "dvh1",
  "dvhe",
  "dva1",
  "dvav",
  "av01",
  "vp08",
  "vp09",
  "vp8",
  "vp9",
  "mp4v",
  "vvc1",
  "vvi1"
];

const AUDIO_PREFIXES: readonly string[] = [
  "mp4a",
  "ac-3",
  "ec-3",
  "ec+3",
  "ac-4",
  "opus",
  "vorbis",
  "flac",
  "alac",
  "dtsc",
  "dtse",
  "dtsh",
  "dtsl",
  "dtsx",
  "mha1",
  "mha2",
  "mhm1",
  "mhm2",
  "samr",
  "sevc"
];

/**
 * Exact identifiers, or identifier prefixes, that the vocabulary can express.
 *
 * Deliberately conservative. Every entry below is a mapping somebody can check
 * against a specification; anything not listed is video-or-audio family with a
 * `null` normalised value, which is an honest answer.
 *
 * Notable REFUSALS, each one a mapping that looks obvious and is wrong:
 *
 *   - `dvh1`/`dvhe` carry an HEVC bitstream, so mapping them to `hevc` is
 *     tempting. It would be a lie about decodability: Dolby Vision profile 5 is
 *     not decodable by an HEVC decoder that has no DV support, so a device
 *     advertising `hevc` would be handed a stream it renders as garbage. Dolby
 *     Vision is not in the vocabulary, so the answer is `null`.
 *   - `mp4a.40.34` is MPEG-1 Layer 3, not AAC, despite sharing the `mp4a.40`
 *     prefix with three AAC object types. Prefix-matching `mp4a.40` would have
 *     labelled MP3 as AAC, so the AAC entries are exact.
 *   - `mp4a.a5` and `mp4a.a6` are AC-3 and E-AC-3 wearing an `mp4a` prefix.
 *     Treating a bare `mp4a` as AAC would therefore be wrong for real streams,
 *     which is why there is no bare `mp4a` entry.
 */
const VIDEO_VOCABULARY: readonly (readonly [string, VideoCodec])[] = [
  ["avc1", "h264"],
  ["avc2", "h264"],
  ["avc3", "h264"],
  ["avc4", "h264"],
  ["hev1", "hevc"],
  ["hvc1", "hevc"],
  ["av01", "av1"],
  ["vp09", "vp9"],
  ["vp9", "vp9"]
];

const AUDIO_VOCABULARY: readonly (readonly [string, AudioCodec])[] = [
  ["mp4a.40.2", "aac"],
  ["mp4a.40.5", "aac"],
  ["mp4a.40.29", "aac"],
  ["mp4a.a5", "ac3"],
  ["mp4a.a6", "eac3"],
  ["ac-3", "ac3"],
  ["ec-3", "eac3"],
  ["opus", "opus"]
];

export interface DeclaredCodecs {
  readonly videoDeclared: string | null;
  readonly videoCodec: VideoCodec | null;
  readonly audioDeclared: string | null;
  readonly audioCodec: AudioCodec | null;
  /**
   * Identifiers in neither family, in declared order -- subtitle and timed-text
   * sample entries (`wvtt`, `stpp.ttml.im1t`) and anything unregistered. Kept
   * rather than dropped: a text rendition that declared a codec has declared
   * something, and reporting it as having declared nothing would be false.
   */
  readonly otherDeclared: readonly string[];
}

export const NO_DECLARED_CODECS: DeclaredCodecs = {
  videoDeclared: null,
  videoCodec: null,
  audioDeclared: null,
  audioCodec: null,
  otherDeclared: []
};

/** The part before the first `.`, which is the four-character sample entry name. */
function familyOf(identifier: string): string {
  const dot = identifier.indexOf(".");
  return dot === -1 ? identifier : identifier.slice(0, dot);
}

/**
 * Case is folded before every comparison.
 *
 * RFC 6381 identifiers are case sensitive in principle, and `Opus` and `fLaC`
 * are registered with exactly that capitalisation -- but real manifests are
 * written by hand and by a dozen packagers, and matching case-sensitively would
 * make `OPUS` an unrecognised codec. Folding cannot create a false match here
 * because no two entries in the tables above differ only by case.
 */
function fold(identifier: string): string {
  return identifier.toLowerCase();
}

function lookup<Value>(
  identifier: string,
  table: readonly (readonly [string, Value])[]
): Value | null {
  const folded = fold(identifier);
  for (const [key, value] of table) {
    // Exact match first so that `mp4a.40.2` cannot be shadowed by a shorter
    // entry, then a prefixed match so that `avc1.640028` resolves through
    // `avc1`. The separator is required: without it, a hypothetical `avc10`
    // would match `avc1`.
    if (folded === key) return value;
    if (folded.startsWith(`${key}.`)) return value;
  }
  return null;
}

/**
 * Splits a declaration into identifiers.
 *
 * The list is comma separated with optional whitespace. In HLS the whole list is
 * inside one pair of quotes, which `m3u8-parser` has already stripped, so a
 * comma reaching here always separates identifiers and never sits inside one.
 */
function splitIdentifiers(declaration: string): string[] {
  return declaration
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Reads a `CODECS` / `@codecs` declaration.
 *
 * Order within each family is the DECLARED order, not sorted. That is
 * deterministic -- it is a property of the manifest text, which is the input --
 * and re-sorting would destroy the pairing a reader expects between the raw
 * string here and the raw string in the manifest.
 */
export function readDeclaredCodecs(declaration: string | null): DeclaredCodecs {
  if (declaration === null) return NO_DECLARED_CODECS;

  const identifiers = splitIdentifiers(declaration);
  if (identifiers.length === 0) return NO_DECLARED_CODECS;

  const video: string[] = [];
  const audio: string[] = [];
  const other: string[] = [];

  for (const identifier of identifiers) {
    const family = fold(familyOf(identifier));
    if (VIDEO_PREFIXES.includes(family)) {
      video.push(identifier);
    } else if (AUDIO_PREFIXES.includes(family)) {
      audio.push(identifier);
    } else {
      other.push(identifier);
    }
  }

  return {
    videoDeclared: video.length === 0 ? null : video.join(","),
    videoCodec: normalise(video, VIDEO_VOCABULARY),
    audioDeclared: audio.length === 0 ? null : audio.join(","),
    audioCodec: normalise(audio, AUDIO_VOCABULARY),
    otherDeclared: other
  };
}

/**
 * Maps a family's identifiers onto one vocabulary value, or onto `null`.
 *
 * `null` whenever the answer is not forced: no identifiers, any identifier the
 * tables do not recognise, or two identifiers that map to different values. The
 * last case is a real manifest shape -- a packager listing an AVC and an HEVC
 * variant in one `CODECS` string is malformed, but it happens, and picking the
 * first would report a fact about half the stream as a fact about the stream.
 *
 * Two identifiers mapping to the SAME value is not ambiguous and is accepted;
 * `avc1.4d401f,avc3.4d401f` is h264 twice.
 */
function normalise<Value>(
  identifiers: readonly string[],
  table: readonly (readonly [string, Value])[]
): Value | null {
  if (identifiers.length === 0) return null;

  let agreed: Value | null = null;
  for (const identifier of identifiers) {
    const mapped = lookup(identifier, table);
    if (mapped === null) return null;
    if (agreed === null) {
      agreed = mapped;
      continue;
    }
    if (agreed !== mapped) return null;
  }
  return agreed;
}
