import type { DeclaredRendition, RenditionKind, RenditionLocation } from "./types";
import { INSPECTED_FACTS } from "./types";

/* -------------------------------------------------------------------------
 * The canonical order of a ladder.
 *
 * WHY THIS IS ITS OWN MODULE WITH ITS OWN PROPERTY SUITE. Six order-dependence
 * defects have been found in this repository by hand, and every one of them
 * passed a green example suite first. The shape is always the same: a
 * determinism claim that holds only for the input the tests happen to use. A
 * manifest is a list, both parsers walk it in document order, and the obvious
 * implementation therefore returns the ladder in whatever order the publisher
 * wrote it -- which makes every downstream comparison, cache key and reason
 * trail a function of a third party's formatting.
 *
 * THE COMPARATOR IS TOTAL UP TO INDISTINGUISHABILITY. It compares every field
 * that a caller can observe, so two renditions that compare equal are deep
 * equal, and `Array.prototype.sort`'s stability -- which is the usual place
 * input order sneaks back in -- has nothing left to decide. That is the property
 * `order.property.test.ts` pins, and it is stronger than "sorted": a comparator
 * returning 0 for two DIFFERENT entries is an order-dependence bug that no
 * example test can see, because the example always supplies them one way round.
 *
 * UNKNOWN SORTS LAST, in every key, always. A rendition whose bandwidth was
 * never declared has no place on a ladder ordered by bandwidth, and putting it
 * at the bottom would imply it is the smallest rung. Last is a deliberate
 * position meaning "not placed", not a numeric claim -- which is why `null` is
 * never coerced to 0 or to Infinity anywhere in this file.
 * ---------------------------------------------------------------------- */

/**
 * Ascending, because a ladder is conventionally read bottom-up and because
 * `BANDWIDTH` is the one attribute HLS makes REQUIRED on every
 * `#EXT-X-STREAM-INF` and DASH makes required on every `Representation` -- so it
 * is the key most likely to be present and to discriminate.
 */
function compareNumbers(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * Lexicographic by UTF-16 code unit, matching every id comparator in
 * `@liberty/media-engine`. Explicitly NOT `localeCompare`, which is
 * locale-dependent and would make the output of a pure function depend on the
 * host's ICU data.
 */
function compareStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * A fixed rank rather than an alphabetical one, so that adding a kind is a
 * deliberate decision about where it belongs instead of an accident of spelling.
 */
const KIND_RANK: readonly RenditionKind[] = ["multiplexed", "video", "audio", "text", "unknown"];

function rankKind(kind: RenditionKind): number {
  const index = KIND_RANK.indexOf(kind);
  // A kind outside the list sorts last rather than at 0. Sorting an unknown
  // member first would silently promote it above every known one.
  return index === -1 ? KIND_RANK.length : index;
}

/**
 * A total sort key for a location.
 *
 * `resolvedUrl` and `verdict` are omitted on purpose: within one inspection both
 * are pure functions of `declaredUri`, the base URL and the policy, all of which
 * are fixed for the call. Including them would not change any comparison and
 * would weaken the claim that comparator equality implies deep equality, because
 * it would hide a case where they can differ.
 */
function locationKey(location: RenditionLocation): string {
  switch (location.kind) {
    case "declared":
      return joinForCompare(["1", location.declaredUri]);
    case "not_declared":
      return joinForCompare(["2"]);
    case "not_applicable":
      return joinForCompare(["3"]);
  }
}

/**
 * `JSON.stringify` rather than a `join`, and the reason is not fussiness.
 *
 * One of the lists compared through here is `otherCodecsDeclared`, whose
 * elements are whatever a publisher wrote between two commas -- so ANY
 * single-character separator can also occur inside an element, and `["a b"]`
 * would then compare equal to `["a", "b"]`. Two distinguishable rungs comparing
 * equal is not cosmetic here: `canonicaliseRenditions` collapses
 * comparator-equal entries, so a collision silently deletes a rung. Escaping
 * removes the class instead of betting on a character a publisher will not use.
 */
function joinForCompare(values: readonly string[]): string {
  return JSON.stringify(values);
}

/**
 * The evidence citations, in vocabulary order, with an empty slot for an unknown
 * fact. Fixed length by construction, so a missing citation cannot shift the
 * others along and make two unrelated rungs compare equal.
 */
function citationKey(rendition: DeclaredRendition): string {
  return joinForCompare(INSPECTED_FACTS.map((fact) => rendition.mediaEvidence[fact]?.detail ?? ""));
}

/**
 * The published order. Read it as the definition; the doc comment on
 * `canonicaliseRenditions` promises exactly this and nothing more.
 *
 * Every observable field appears, including the ones that look like metadata.
 * `unreadableDeclarations` is here because two renditions can agree on every
 * fact and disagree about whether a fact was ABSENT or MALFORMED, and that
 * difference has to reach the tiebreak or those two are ordered by input
 * position. `otherCodecsDeclared` is here for the same reason.
 *
 * The evidence CITATIONS are the last key, and they are not decoration. Within
 * one inspection `source` and `observedAt` are constant, but `detail` is not:
 * DASH lets an `AdaptationSet` state a value that its `Representation`s inherit,
 * so two rungs can agree on every fact above and still differ in whether the set
 * or the rendition said so. Leaving the citations out would make two
 * distinguishable rungs compare equal -- and because `canonicaliseRenditions`
 * collapses comparator-equal entries, one of them would be silently dropped
 * along with the provenance that made it different.
 */
export function compareRenditions(a: DeclaredRendition, b: DeclaredRendition): number {
  const byBandwidth = compareNumbers(a.bandwidthBps, b.bandwidthBps);
  if (byBandwidth !== 0) return byBandwidth;

  const byHeight = compareNumbers(a.height, b.height);
  if (byHeight !== 0) return byHeight;

  const byWidth = compareNumbers(a.width, b.width);
  if (byWidth !== 0) return byWidth;

  const byFrameRate = compareNumbers(a.frameRate, b.frameRate);
  if (byFrameRate !== 0) return byFrameRate;

  const byVideoCodec = compareStrings(a.videoCodecDeclared, b.videoCodecDeclared);
  if (byVideoCodec !== 0) return byVideoCodec;

  const byAudioCodec = compareStrings(a.audioCodecDeclared, b.audioCodecDeclared);
  if (byAudioCodec !== 0) return byAudioCodec;

  const byOtherCodecs = compareStrings(
    joinForCompare(a.otherCodecsDeclared),
    joinForCompare(b.otherCodecsDeclared)
  );
  if (byOtherCodecs !== 0) return byOtherCodecs;

  const byKind = rankKind(a.kind) - rankKind(b.kind);
  if (byKind !== 0) return byKind;

  const byLocation = compareStrings(locationKey(a.location), locationKey(b.location));
  if (byLocation !== 0) return byLocation;

  const byUnreadable = compareStrings(
    joinForCompare(a.unreadableDeclarations),
    joinForCompare(b.unreadableDeclarations)
  );
  if (byUnreadable !== 0) return byUnreadable;

  return compareStrings(citationKey(a), citationKey(b));
}

/**
 * Sorts a ladder into the published order and drops exact duplicates.
 *
 * NEVER MUTATES ITS ARGUMENT. An in-place sort of a caller's array is invisible
 * to a permutation property -- both calls are equally affected -- and is
 * nevertheless the same defect class: a function whose result depends on how
 * many times it has been called.
 *
 * DEDUPLICATION IS ADJACENT-ONLY AND THEREFORE SOUND. Because the comparator is
 * total up to indistinguishability, equal entries are adjacent after sorting,
 * and an entry that compares equal to its predecessor is deep equal to it. The
 * duplicates worth removing are real: a multi-period MPD restates the same
 * ladder in every `Period`, and returning the same rung six times would be
 * counted as a six-rung ladder by anything that counts.
 *
 * THE INPUT MUST COME FROM ONE INSPECTION OF ONE MANIFEST. That is the condition
 * under which comparator equality implies deep equality -- `observedAt` is
 * constant within a call and can vary across calls. Mixing two inspections here
 * could drop an entry that differs only in provenance, which is the one thing
 * this package must never lose.
 */
export function canonicaliseRenditions(
  renditions: readonly DeclaredRendition[]
): DeclaredRendition[] {
  const sorted = [...renditions].sort(compareRenditions);

  const out: DeclaredRendition[] = [];
  for (const rendition of sorted) {
    const previous = out[out.length - 1];
    if (previous !== undefined && compareRenditions(previous, rendition) === 0) continue;
    out.push(rendition);
  }
  return out;
}
