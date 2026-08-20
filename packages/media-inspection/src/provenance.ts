import type { DeclaredRendition, FactSource, InspectedFact } from "./types";
import { INSPECTED_FACTS } from "./types";

/* -------------------------------------------------------------------------
 * Divergence, preserved rather than collapsed.
 *
 * The acceptance criterion asks for two things that sound like one: a fact
 * obtained by inspection must be distinguishable from a fact merely stated by a
 * provider, AND a divergence between the two must be preserved rather than
 * collapsed into a fact of unknowable origin. The second is the harder one. The
 * natural implementation of "trust the better source" overwrites the worse one,
 * and the disagreement -- which is a first-class signal about the provider, not
 * metadata about the fact -- disappears without anybody deciding it should.
 *
 * So nothing here overwrites anything. Reconciliation SELECTS; every observation
 * that went in comes out, and `agreement` says whether they agreed.
 *
 * A provider stating 1080p for a manifest declaring 720p is not noise. It means
 * that provider's catalogue is wrong, and if that is true here it is true for
 * every other title it lists, most of which nobody will ever inspect. That is
 * the whole reason to keep the losing observation.
 * ---------------------------------------------------------------------- */

/**
 * The only place the ordering between sources is written down.
 *
 * A single table rather than a comparison scattered across call sites, because
 * inserting a fourth source later must be one edit with one review, not a search
 * for every `=== "probe"`.
 *
 * The order is an argument about EVIDENCE, not about trust in a vendor:
 *
 *   1. `provider_declared` -- an aggregator repeating a claim out of band, often
 *      copied from a third catalogue, with nothing tying it to the bytes on
 *      offer.
 *   2. `manifest_declared` -- the publisher's own statement, in a document with
 *      a specified grammar, which we fetched and parsed ourselves. Still a
 *      claim: a publisher can misdeclare, and some do.
 *   3. `probe` -- read out of the media. The only one that is a measurement.
 *      Nothing produces it yet; it is here so that when the FFmpeg path lands it
 *      slots in without any of this being redefined.
 */
export const FACT_SOURCE_STRENGTH: Readonly<Record<FactSource, number>> = {
  provider_declared: 1,
  manifest_declared: 2,
  probe: 3
};

export interface FactObservation<Value> {
  readonly fact: InspectedFact;
  readonly value: Value;
  readonly source: FactSource;
  readonly observedAt: string;
  readonly detail: string;
}

export type FactAgreement = "unobserved" | "sole_source" | "corroborated" | "divergent";

export interface ReconciledFact<Value> {
  readonly fact: InspectedFact;
  /** `null` only when there were no observations at all. Never a default. */
  readonly value: Value | null;
  /** The observation `value` came from, so provenance travels with the value. */
  readonly evidence: FactObservation<Value> | null;
  /** Every observation, strongest first. Nothing is dropped, ever. */
  readonly observations: readonly FactObservation<Value>[];
  readonly agreement: FactAgreement;
}

/**
 * A total order over observations: strongest source first, then oldest first,
 * then by citation, then by the value's own text.
 *
 * Total to the last key on purpose. A comparator that returns 0 for two distinct
 * observations hands their order to `Array.prototype.sort`'s stability, which
 * makes the output a function of the order a caller happened to assemble the
 * list in -- the exact defect class this repository has hit six times.
 */
function compareObservations<Value>(a: FactObservation<Value>, b: FactObservation<Value>): number {
  const byStrength = FACT_SOURCE_STRENGTH[b.source] - FACT_SOURCE_STRENGTH[a.source];
  if (byStrength !== 0) return byStrength;
  if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? -1 : 1;
  if (a.detail !== b.detail) return a.detail < b.detail ? -1 : 1;
  const valueA = String(a.value);
  const valueB = String(b.value);
  if (valueA !== valueB) return valueA < valueB ? -1 : 1;
  return 0;
}

/**
 * Reconciles every observation of ONE fact.
 *
 * `equals` defaults to `Object.is` and exists for values that are not primitives
 * or that need a tolerance -- a probed frame rate of 29.97002997 and a declared
 * `30000/1001` are the same fact, and calling that a divergence would fill the
 * signal with noise until nobody reads it. The default is strict because the
 * caller knows the value type and this module does not.
 *
 * Does not mutate its argument: the array is copied before sorting.
 */
export function reconcileFact<Value>(
  fact: InspectedFact,
  observations: readonly FactObservation<Value>[],
  equals: (a: Value, b: Value) => boolean = Object.is
): ReconciledFact<Value> {
  const ordered = [...observations].sort(compareObservations);
  const strongest = ordered[0];

  if (strongest === undefined) {
    // Unobserved is not a value. It is reported as `null` with no evidence, and
    // it is emphatically not a mid-range default -- the same rule PL-0303 states
    // for a provider with zero observations.
    return { fact, value: null, evidence: null, observations: [], agreement: "unobserved" };
  }

  let divergent = false;
  let corroborated = false;
  // Indexed rather than `for...of` with an identity skip: the same observation
  // object can legitimately appear twice, and skipping by reference would then
  // discard the second copy's agreement instead of the first's position.
  for (let index = 1; index < ordered.length; index++) {
    const observation = ordered[index];
    if (observation === undefined) continue;
    if (equals(observation.value, strongest.value)) {
      corroborated = true;
    } else {
      divergent = true;
    }
  }

  // Divergence outranks corroboration when both are present. Three sources of
  // which two agree is still a disagreement, and reporting it as "corroborated"
  // would hide the odd one out behind a majority vote nobody asked for.
  const agreement: FactAgreement = divergent
    ? "divergent"
    : corroborated
      ? "corroborated"
      : "sole_source";

  return { fact, value: strongest.value, evidence: strongest, observations: ordered, agreement };
}

/**
 * Turns a rendition into observations, so a caller can hand them to
 * `reconcileFact` alongside whatever a provider claimed.
 *
 * Only facts the manifest actually declared produce an observation. An unknown
 * fact contributes NOTHING rather than contributing a `null` -- an observation
 * of "I do not know" is not evidence, and letting one into the list would make
 * `sole_source` reachable for a fact nobody stated.
 *
 * `value` is `unknown` because the six facts do not share a type. The caller
 * knows which fact it asked for and narrows there; widening this to a union
 * would push a cast into every consumer instead of one.
 */
export function observationsFromRendition(
  rendition: DeclaredRendition
): readonly FactObservation<unknown>[] {
  const out: FactObservation<unknown>[] = [];

  // Driven by the canonical constant, so the returned order is the vocabulary's
  // and not the order this function's author wrote the cases in.
  for (const fact of INSPECTED_FACTS) {
    const evidence = rendition.mediaEvidence[fact];
    if (evidence === undefined) continue;
    out.push({
      fact,
      value: valueOf(rendition, fact),
      source: evidence.source,
      observedAt: evidence.observedAt,
      detail: evidence.detail
    });
  }

  return out;
}

/**
 * The declared value of a fact.
 *
 * For the two codec facts this is the RAW RFC 6381 identifier rather than the
 * normalised vocabulary value. A divergence check has to compare like with like,
 * and the normalised field is `null` for everything outside the four-value enum
 * -- so comparing normalised values would report "the provider said hevc, the
 * manifest said nothing" for a manifest that plainly said `dvhe.05.06`.
 */
function valueOf(rendition: DeclaredRendition, fact: InspectedFact): unknown {
  switch (fact) {
    case "videoCodec":
      return rendition.videoCodecDeclared;
    case "audioCodec":
      return rendition.audioCodecDeclared;
    case "width":
      return rendition.width;
    case "height":
      return rendition.height;
    case "frameRate":
      return rendition.frameRate;
    case "bandwidthBps":
      return rendition.bandwidthBps;
  }
}
