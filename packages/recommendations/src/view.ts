import { catalogItemKindSchema, type CatalogItemKind } from "@liberty/contracts/domains/catalog";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import { z } from "zod";
import type { EligibilitySeal, EligibleContentId } from "./eligibility";
import { compareCodePoint } from "./ordering";

/* -------------------------------------------------------------------------
 * The generator's field of view (PL-0801)
 *
 * Data minimisation is a constraint on the input TYPE here, not a policy note in
 * a design doc. Recommendation profiling is the textbook case of processing that
 * quietly grows to consume every signal within reach, so the set of signals
 * within reach is fixed by `RecommendationView`, and a generator receives that
 * and nothing else.
 *
 * The permitted inputs, and the whole list of them:
 *
 *   1. the ACTIVE profile's explicit watchlist
 *   2. that profile's progress and completion state
 *   3. catalog metadata
 *   4. already-resolved eligibility
 *
 * What is absent is as deliberate as what is present. There is no profile id, no
 * account id, no other profile's anything, no demographic field, no device or
 * network fact, no free-text search history, and no wall clock. A generator that
 * wants one of those has to change this type, which is a reviewable act.
 *
 * `RecommendationInput` is `.strict()` at every level for the same reason: an
 * unknown key is a rejection, not a silently ignored extra. A caller that starts
 * passing `ageBracket` or `email` alongside the watchlist fails to parse instead
 * of quietly widening the profile.
 * ---------------------------------------------------------------------- */

const progressInputSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    positionSeconds: z.number().int().min(0),
    runtimeSeconds: z.number().int().positive(),
    completed: z.boolean()
  })
  .strict()
  .refine((entry) => entry.positionSeconds <= entry.runtimeSeconds, {
    message: "positionSeconds cannot exceed runtimeSeconds"
  });
export type ProgressInput = z.infer<typeof progressInputSchema>;

/**
 * Catalog metadata a generator may read.
 *
 * NO RIGHTS FIELD, deliberately. Rights are an eligibility input and eligibility
 * has already been resolved by the time anything here is built; re-exposing the
 * rights basis to a generator invites a second, weaker rights decision at the
 * one layer that must not make one. If a generator can read the basis it can
 * branch on it, and the next reviewer has to prove that branch is not a bypass.
 *
 * Also no provider, no url, no stream descriptor, no availability window. A
 * catalog fact here says a work exists and what it is about — never how to fetch
 * it. That is what makes it structurally impossible for the output of this
 * package to be mistaken for something playable.
 */
const catalogFactsInputSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    kind: catalogItemKindSchema,
    title: z.string().min(1),
    genre: z.string().min(1),
    releaseYear: z.number().int().min(1888)
  })
  .strict();
export type CatalogFactsInput = z.infer<typeof catalogFactsInputSchema>;

/**
 * One record per content id, enforced at parse time.
 *
 * Two progress records for the same work would make the view depend on which one
 * the reducer happened to see last, and that is the order-dependence class this
 * repository has already paid for six times. Rejecting the input is better than
 * picking a winner, because there is no defensible winner: a profile has one
 * position in one work.
 */
function uniqueByContentId<Entry extends { contentId: string }>(entries: readonly Entry[]): boolean {
  return new Set(entries.map((entry) => entry.contentId)).size === entries.length;
}

export const recommendationInputSchema = z
  .object({
    watchlist: z.array(normalizedContentIdSchema),
    progress: z
      .array(progressInputSchema)
      .refine(uniqueByContentId, { message: "a profile has at most one progress record per content id" }),
    catalog: z
      .array(catalogFactsInputSchema)
      .refine(uniqueByContentId, { message: "catalog metadata must not repeat a content id" })
  })
  .strict();
export type RecommendationInput = z.infer<typeof recommendationInputSchema>;

export interface ProfileProgress {
  readonly contentId: EligibleContentId;
  readonly positionSeconds: number;
  readonly runtimeSeconds: number;
  readonly completed: boolean;
}

export interface CatalogFacts {
  readonly contentId: EligibleContentId;
  readonly kind: CatalogItemKind;
  readonly title: string;
  readonly genre: string;
  readonly releaseYear: number;
}

export interface RecommendationView {
  /** 1. The active profile's explicit watchlist, eligible entries only. */
  readonly watchlist: readonly EligibleContentId[];
  /** 2. That profile's progress and completion state, eligible entries only. */
  readonly progress: readonly ProfileProgress[];
  /** 3. Catalog metadata, eligible entries only. */
  readonly catalog: readonly CatalogFacts[];
  /**
   * 4. Already-resolved eligibility, in enumerable form.
   *
   * Every id elsewhere in the view is an `EligibleContentId`, so eligibility is
   * already carried by the types and this field adds no authority. It exists so
   * a generator that wants to iterate the eligible set does not have to
   * reconstruct it from `catalog`, and so the fourth permitted input is a member
   * of this interface rather than an implicit consequence of the other three.
   */
  readonly eligibleIds: readonly EligibleContentId[];
}

/**
 * Why an id the profile referenced did not reach the slate.
 *
 * `no_eligibility_verdict` IS NOT A SYNONYM FOR `upstream_not_eligible`, and
 * collapsing the two is the defect this list was split to remove. Both exclude
 * the work — absence of a verdict is a refusal and that behaviour is unchanged —
 * but they are different operational facts and they page different people. A
 * refusal means the rights pipeline ran and said no, which is a licensing state
 * and usually correct. An absent verdict means the rights pipeline did not answer
 * for this id at all, which is a broken or incomplete upstream call and is never
 * correct. Reporting the second as the first tells an operator that a work is
 * unlicensed when what actually happened is that nobody asked.
 *
 * This is the same rule `PlaybackDecisionReason` follows in `media-engine` — a
 * separate value rather than a flag, so a caller pattern-matching on the reason
 * cannot handle the ordinary case without noticing the other one — and the same
 * rule the provider-health contract follows in adding an honest `unknown` beside
 * `pass`/`warn`/`fail`. The distinction was already computed here (the detail
 * string differed); it just was not machine-readable, so the only consumer that
 * could act on it was a human reading prose.
 *
 * An `eligible` verdict whose rights basis is off the playable allowlist stays
 * under `upstream_not_eligible` deliberately. Upstream answered and the seal
 * declined to carry the answer, with a stated reason in `detail`; that is a
 * refusal with an explanation, not a missing one, and a third code for it would
 * split the list on a distinction no consumer acts on differently.
 *
 * Exported as a value, for the reason `PERMITTED_VIEW_MEMBERS` is: the test that
 * asserts every published exclusion carries a known reason reads THIS list
 * rather than a copy, so adding a member without updating the test is impossible
 * rather than merely discouraged.
 */
export const VIEW_EXCLUSION_REASONS = [
  "no_catalog_metadata",
  "no_eligibility_verdict",
  "upstream_not_eligible"
] as const;

export type ViewExclusionReason = (typeof VIEW_EXCLUSION_REASONS)[number];

export interface ViewExclusion {
  readonly contentId: string;
  readonly reason: ViewExclusionReason;
  readonly detail: string;
}

export interface BuiltView {
  readonly view: RecommendationView;
  /** Everything the profile referenced that did not make it in, and why. */
  readonly excluded: readonly ViewExclusion[];
}

/**
 * Builds the view, which is where the boundary is actually enforced.
 *
 * An id enters only if the seal admits it AND catalog metadata for it was
 * supplied. Both conditions are structural rather than advisory: a refused id
 * has no `EligibleContentId` to be named by, and an id with no metadata cannot
 * be presented, so admitting it would only push a hole into the layer that can
 * least explain it.
 *
 * CANONICAL ORDER IS SET HERE, ONCE. Every list is sorted by code point before a
 * generator sees it, which is what makes the whole slate invariant under
 * permutation of the caller's arrays — not a final sort of the output. A final
 * sort would only fix the order of the result; it would not stop a generator
 * from emitting a DIFFERENT SET of candidates for a reordered input (any
 * generator that truncates, or picks a first match, does exactly that). Fixing
 * the order at the input is the version of the property that survives generators
 * being added.
 *
 * The result is deep-frozen. A generator that mutates the view it was handed
 * would make every later generator's output depend on generator order in a way
 * the ranking comparator cannot see.
 */
export function buildView(input: RecommendationInput, seal: EligibilitySeal): BuiltView {
  const catalogById = new Map(input.catalog.map((facts) => [facts.contentId, facts]));

  /*
   * The universe is what the PROFILE referenced plus what the catalog described
   * — not the eligibility list. A verdict for a work nobody referenced would
   * otherwise appear in the exclusion trail as "no catalog metadata", which is
   * true and useless, and would let the size of the trail be driven by how much
   * eligibility the caller happened to resolve.
   */
  const universe = [
    ...new Set([
      ...input.watchlist,
      ...input.progress.map((entry) => entry.contentId),
      ...input.catalog.map((facts) => facts.contentId)
    ])
  ].sort(compareCodePoint);

  const admittedIds = new Set<string>();
  const excluded: ViewExclusion[] = [];
  const refusalDetail = new Map(seal.excluded.map((entry) => [entry.contentId, entry.detail]));

  for (const contentId of universe) {
    if (seal.admit(contentId) === null) {
      /*
       * `refusalDetail` holding nothing for a non-admitted id means exactly one
       * thing, and the seal is what makes that safe to rely on: an id that
       * carried any verdict is either in `eligibleIds` or in `excluded`, because
       * every refusal path in `sealEligibility` records a detail and refusal
       * deletes from the admitted set. So "not admitted and not refused" is
       * "never adjudicated", and it is reported as that rather than as a refusal
       * nobody made.
       */
      const refusal = refusalDetail.get(contentId);
      excluded.push(
        refusal === undefined
          ? {
              contentId,
              reason: "no_eligibility_verdict",
              detail: "upstream supplied no verdict for this id; absence is treated as a refusal"
            }
          : { contentId, reason: "upstream_not_eligible", detail: refusal }
      );
      continue;
    }
    if (!catalogById.has(contentId)) {
      excluded.push({
        contentId,
        reason: "no_catalog_metadata",
        detail: "eligible, but no catalog metadata was supplied to describe it"
      });
      continue;
    }
    admittedIds.add(contentId);
  }

  const admit = (contentId: string): EligibleContentId | null =>
    admittedIds.has(contentId) ? seal.admit(contentId) : null;

  const watchlist = [...new Set(input.watchlist)]
    .sort(compareCodePoint)
    .flatMap((contentId) => {
      const eligible = admit(contentId);
      return eligible === null ? [] : [eligible];
    });

  const progress = [...input.progress]
    .sort((a, b) => compareCodePoint(a.contentId, b.contentId))
    .flatMap((entry) => {
      const eligible = admit(entry.contentId);
      if (eligible === null) return [];
      return [
        Object.freeze({
          contentId: eligible,
          positionSeconds: entry.positionSeconds,
          runtimeSeconds: entry.runtimeSeconds,
          completed: entry.completed
        })
      ];
    });

  const catalog = [...input.catalog]
    .sort((a, b) => compareCodePoint(a.contentId, b.contentId))
    .flatMap((facts) => {
      const eligible = admit(facts.contentId);
      if (eligible === null) return [];
      return [
        Object.freeze({
          contentId: eligible,
          kind: facts.kind,
          title: facts.title,
          genre: facts.genre,
          releaseYear: facts.releaseYear
        })
      ];
    });

  const view: RecommendationView = Object.freeze({
    watchlist: Object.freeze(watchlist),
    progress: Object.freeze(progress),
    catalog: Object.freeze(catalog),
    eligibleIds: Object.freeze(catalog.map((facts) => facts.contentId))
  });

  return {
    view,
    excluded: Object.freeze(
      excluded.sort(
        (a, b) => compareCodePoint(a.contentId, b.contentId) || compareCodePoint(a.reason, b.reason)
      )
    )
  };
}

/**
 * The exact member names a generator may read.
 *
 * Exported so the boundary test asserts against the same list the interface
 * documents, instead of a copy that can drift away from it. A field added to
 * `RecommendationView` without being added here fails the test, which is the
 * point: widening what a recommender may see should not be possible by
 * accident.
 */
export const PERMITTED_VIEW_MEMBERS: readonly string[] = ["catalog", "eligibleIds", "progress", "watchlist"];
