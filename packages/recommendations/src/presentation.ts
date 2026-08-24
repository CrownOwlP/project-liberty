import type { CatalogItemKind } from "@liberty/contracts/domains/catalog";
import type { GeneratorReason } from "./generator";
import type { RankedRecommendation } from "./ranking";
import type { RecommendationView, ViewExclusion } from "./view";

/* -------------------------------------------------------------------------
 * The presentation layer (PL-0801)
 *
 * THE LAYER MOST LIKELY TO LOSE THE REASON TRAIL. A presentation type is written
 * against a mock, reviewed by whoever owns the surface, and shaped by what the
 * component renders today — and no component renders "why". So `reasons` is a
 * required, non-empty field here, not an optional one, and the mapping below has
 * no branch that can produce an item without it.
 *
 * WHAT THIS TYPE DOES NOT HAVE is the other half of the boundary. There is no
 * url, no stream descriptor, no provider, no manifest, no token, no
 * entitlement — nothing a client could act on to obtain bytes. A recommendation
 * says "this exists and here is why we surfaced it"; making it playable requires
 * going to the playback resolution path, which performs its own rights check
 * against `PLAYABLE_CONTENT_RIGHTS`. That is what "recommendation can never make
 * content playable" means concretely: the most a compromised or buggy generator
 * can achieve is putting a title on a shelf.
 * ---------------------------------------------------------------------- */

export interface PresentedRecommendation {
  /**
   * Plain `string`, not `EligibleContentId`.
   *
   * The brand is an internal proof obligation, not a wire format. Serialising a
   * branded type would make it look as though eligibility travels with the
   * payload, and a client that received one might treat it as an entitlement.
   * Downstream surfaces re-resolve eligibility for themselves; this id is a
   * pointer to a catalog entry and nothing more.
   */
  readonly contentId: string;
  readonly title: string;
  readonly kind: CatalogItemKind;
  readonly rank: number;
  readonly reasons: readonly [GeneratorReason, ...GeneratorReason[]];
}

export interface RecommendationSlate {
  /** Echoed from the caller's explicit instant. Nothing here reads a clock. */
  readonly generatedAt: string;
  readonly items: readonly PresentedRecommendation[];
  /**
   * Everything the profile referenced that did not make the slate, and why.
   *
   * Published rather than logged, because the question this answers — "I have it
   * on my watchlist, why is it not there" — is asked from the client, and an
   * empty slate with no explanation is the failure mode that gets escalated as a
   * data bug.
   */
  readonly excluded: readonly ViewExclusion[];
}

/**
 * Maps the ranked slate onto the presentation shape.
 *
 * Every ranked id has catalog metadata by construction — `buildView` refuses to
 * admit an id it cannot describe — so a missing lookup here is not a data gap
 * but a broken invariant, and it throws rather than dropping the entry. A silent
 * drop would make the slate shorter than the ranking for a reason no field
 * records, which is the same class of bug as losing the reason trail.
 */
export function presentSlate(
  view: RecommendationView,
  ranked: readonly RankedRecommendation[],
  excluded: readonly ViewExclusion[],
  generatedAt: string
): RecommendationSlate {
  const factsById = new Map(view.catalog.map((facts) => [facts.contentId as string, facts]));

  const items = ranked.map((entry) => {
    const facts = factsById.get(entry.contentId);
    if (facts === undefined) {
      throw new Error(`ranked candidate ${entry.contentId} has no catalog metadata; buildView should have excluded it`);
    }
    return {
      contentId: entry.contentId as string,
      title: facts.title,
      kind: facts.kind,
      rank: entry.rank,
      reasons: entry.reasons
    };
  });

  return { generatedAt, items, excluded };
}
