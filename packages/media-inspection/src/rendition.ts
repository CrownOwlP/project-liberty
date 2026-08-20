import type { DeclaredCodecs } from "./codecs";
import type {
  DeclaredRendition,
  FactEvidence,
  InspectedFact,
  RenditionKind,
  RenditionLocation
} from "./types";
import { INSPECTED_FACTS } from "./types";

/* -------------------------------------------------------------------------
 * Turning declarations into facts, and refusing to turn them into anything else.
 *
 * Both parsers funnel through here so that HLS and DASH cannot develop different
 * ideas about what counts as a stated value. The rules:
 *
 *   ABSENT is `null` and is recorded in `unknownFacts`. No default, no
 *   inference, no derivation from a neighbouring field. PL-0205's premise.
 *
 *   PRESENT BUT UNREADABLE is ALSO `null` -- and is additionally recorded in
 *   `unreadableDeclarations`. `BANDWIDTH="fast"`, `@height="-1"`,
 *   `@frameRate="30/0"` are not facts, and passing `NaN` or `-1` downstream
 *   would be an invented fact of the worst kind, because it survives every
 *   null-check a consumer wrote. Keeping the two states distinguishable matters
 *   because one is a terse publisher and the other is a broken one, and only the
 *   second is worth reporting to anybody.
 *
 *   Nothing here reads a URL, an extension or a MIME type. A `.m3u8` suffix is
 *   attacker-chosen and says nothing about the bytes.
 * ---------------------------------------------------------------------- */

/**
 * A raw attribute value as either parser hands it over.
 *
 * `null` means the attribute was ABSENT. `m3u8-parser` has already coerced some
 * HLS values to numbers (and to `NaN` on failure); DASH attributes are always
 * strings. Both spellings are accepted so that neither parser has to pre-clean
 * its input and hide a malformed value in the process.
 */
export type RawDeclaration = string | number | null;

export interface FactReading {
  readonly value: number | null;
  /** True only when the attribute was present and its value was not usable. */
  readonly unreadable: boolean;
}

const ABSENT: FactReading = { value: null, unreadable: false };

function unreadable(): FactReading {
  return { value: null, unreadable: true };
}

/**
 * `BANDWIDTH`, `@bandwidth`, `@width`, `@height` and the two halves of an HLS
 * `RESOLUTION`. All are counts, so a non-integer, a zero and a negative are each
 * as meaningless as a word.
 */
export function readPositiveInteger(raw: RawDeclaration): FactReading {
  if (raw === null) return ABSENT;

  const numeric = typeof raw === "number" ? raw : Number(raw.trim());
  // `Number("")` is 0 and `Number("  ")` is 0, so the `> 0` test also rejects an
  // attribute that was written with no value at all -- which is present-but-
  // unreadable rather than absent, and is reported as such.
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric <= 0) return unreadable();
  return { value: numeric, unreadable: false };
}

/**
 * Frame rate, in both spellings the two formats use.
 *
 * HLS `FRAME-RATE` is decimal floating point and `m3u8-parser` has already run
 * `parseFloat` over it. DASH `@frameRate` is either an integer or an exact
 * ratio -- `30000/1001` for 29.97 -- and the ratio form is the common one for
 * anything derived from NTSC. Evaluating the ratio is arithmetic on a declared
 * value, not an inference: the publisher stated 30000/1001 and 30000/1001 is
 * what it equals.
 *
 * A zero or negative denominator is unreadable rather than infinite. Reporting
 * `Infinity` would put a value in a numeric field that no consumer's range check
 * expects.
 */
export function readFrameRate(raw: RawDeclaration): FactReading {
  if (raw === null) return ABSENT;

  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? { value: raw, unreadable: false } : unreadable();
  }

  const text = raw.trim();
  if (text === "") return unreadable();

  const slash = text.indexOf("/");
  if (slash === -1) {
    const single = Number(text);
    return Number.isFinite(single) && single > 0 ? { value: single, unreadable: false } : unreadable();
  }

  const numerator = Number(text.slice(0, slash).trim());
  const denominator = Number(text.slice(slash + 1).trim());
  if (!Number.isFinite(numerator) || numerator <= 0) return unreadable();
  if (!Number.isFinite(denominator) || denominator <= 0) return unreadable();
  return { value: numerator / denominator, unreadable: false };
}

/**
 * Everything a parser has to decide, gathered so that `buildRendition` can be
 * the only place `unknownFacts` and `mediaEvidence` are derived.
 *
 * `evidenceDetail` is a FULL record rather than a partial one: every fact needs
 * a citation ready in case it turns out to have a value, and requiring all six
 * means a parser that adds a fact without saying where it read it does not
 * compile. For DASH the strings differ per rendition, because a value inherited
 * from an `AdaptationSet` and a value stated on the `Representation` are
 * different provenance and the trail should say which.
 */
export interface RenditionDraft {
  readonly kind: RenditionKind;
  readonly location: RenditionLocation;
  readonly codecs: DeclaredCodecs;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly bandwidthBps: number | null;
  readonly unreadableDeclarations: readonly string[];
  readonly evidenceDetail: Readonly<Record<InspectedFact, string>>;
  readonly observedAt: string;
}

/**
 * `unknownFacts` and the keys of `mediaEvidence` are exact complements, and both
 * are derived here from one predicate so they cannot drift.
 *
 * THE PREDICATE IS "DID THE PUBLISHER DECLARE IT", NOT "DO WE HAVE A VOCABULARY
 * VALUE". Those differ for exactly one case and it is worth being precise about:
 * a manifest declaring `dvhe.05.06` HAS declared a video codec, so `videoCodec`
 * is not unknown and it carries evidence -- but Dolby Vision is not in
 * `@liberty/contracts`'s four-value enum, so `videoCodec` is `null` and
 * `videoCodecDeclared` holds the identifier. Reporting that as "unknown" would
 * lose the publisher's statement; reporting a vocabulary value would invent one.
 * A consumer that needs a vocabulary value checks `videoCodec` for `null`; a
 * consumer that needs to know whether anybody said anything reads
 * `unknownFacts`.
 */
export function buildRendition(draft: RenditionDraft): DeclaredRendition {
  const declared: Readonly<Record<InspectedFact, boolean>> = {
    videoCodec: draft.codecs.videoDeclared !== null,
    audioCodec: draft.codecs.audioDeclared !== null,
    width: draft.width !== null,
    height: draft.height !== null,
    frameRate: draft.frameRate !== null,
    bandwidthBps: draft.bandwidthBps !== null
  };

  const mediaEvidence: Partial<Record<InspectedFact, FactEvidence>> = {};
  const unknownFacts: InspectedFact[] = [];

  // Iterating the canonical constant rather than the object's own keys, so that
  // insertion order is fixed by the vocabulary and a serialised rendition is
  // byte-stable regardless of how this function was written.
  for (const fact of INSPECTED_FACTS) {
    if (!declared[fact]) {
      unknownFacts.push(fact);
      continue;
    }
    mediaEvidence[fact] = {
      // Always `manifest_declared` here, by construction: this module is only
      // reachable from a manifest parser. A probe writes its own evidence with
      // its own source rather than borrowing this builder, which is why the
      // field is a constant and not a parameter -- a parameter would let a
      // caller label a declaration as a measurement.
      source: "manifest_declared",
      observedAt: draft.observedAt,
      detail: draft.evidenceDetail[fact]
    };
  }

  return {
    kind: draft.kind,
    location: draft.location,
    videoCodec: draft.codecs.videoCodec,
    videoCodecDeclared: draft.codecs.videoDeclared,
    audioCodec: draft.codecs.audioCodec,
    audioCodecDeclared: draft.codecs.audioDeclared,
    otherCodecsDeclared: [...draft.codecs.otherDeclared],
    width: draft.width,
    height: draft.height,
    frameRate: draft.frameRate,
    bandwidthBps: draft.bandwidthBps,
    unknownFacts,
    // Sorted and deduplicated so that the field is a set with a canonical
    // spelling; the order attributes happen to be visited is not information.
    unreadableDeclarations: [...new Set(draft.unreadableDeclarations)].sort(),
    mediaEvidence
  };
}
