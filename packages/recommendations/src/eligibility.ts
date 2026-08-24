import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import { PLAYABLE_CONTENT_RIGHTS, contentRightsSchema } from "@liberty/contracts/shared/rights";
import { z } from "zod";
import { compareCodePoint } from "./ordering";

/* -------------------------------------------------------------------------
 * The eligibility boundary (PL-0801)
 *
 * This module is the whole point of the package. Everything else is plumbing
 * around the guarantee it establishes:
 *
 *     RIGHTS / ELIGIBILITY  ->  CANDIDATE GENERATION  ->  RANKING  ->  PRESENTATION
 *
 * Eligibility is resolved UPSTREAM. This package receives verdicts; it does not
 * produce them, and it must never be able to widen one. The mechanism is a
 * branded id with exactly one mint.
 *
 * SCHEMAS ARE LOCAL ON PURPOSE, NOT BY PREFERENCE. `packages/contracts` is
 * locked package-wide for this task, so `resolvedEligibilitySchema` and the view
 * input schemas live here. They should migrate to
 * `@liberty/contracts/domains/recommendations` when the lock lifts — an
 * eligibility verdict crosses a package boundary, and a cross-package shape that
 * lives in one of the packages is how a second, subtly different copy gets
 * written. The vocabularies they are built from (`normalizedContentIdSchema`,
 * `contentRightsSchema`, `PLAYABLE_CONTENT_RIGHTS`) are read from contracts
 * rather than restated, for that same reason.
 * ---------------------------------------------------------------------- */

declare const eligibleBrand: unique symbol;

/**
 * A content id that UPSTREAM has already resolved as eligible.
 *
 * Branded rather than a plain `string` so that "recommendation cannot make
 * content playable" is a property of the type system instead of a rule in a
 * comment. Every id that reaches a generator, the ranker or the presentation
 * layer has this type; the only way to obtain a value of this type is
 * `EligibilitySeal.admit`, which returns `null` for anything upstream did not
 * mark eligible. There is deliberately no exported function anywhere in this
 * package that turns a `string` into an `EligibleContentId`.
 *
 * The consequence is the load-bearing one: a candidate generator cannot name an
 * ineligible work, because it has no value of the required type for one and no
 * way to construct one. It is not that generators are trusted not to; it is that
 * the code does not compile.
 */
export type EligibleContentId = string & { readonly [eligibleBrand]: "upstream-resolved-eligible" };

/**
 * An eligibility verdict as it arrives from upstream.
 *
 * A discriminated union rather than an object with a boolean and two nullable
 * fields, for the reason `domains/catalog.ts` gives about runtime/episode count:
 * a comment is not a validator. An eligible verdict must state the rights basis
 * it was granted under, and an ineligible one must state why and carry `null`
 * where the basis would be — explicitly `null`, never absent, so "upstream
 * omitted the field" and "upstream asserts there is no basis" stay
 * distinguishable.
 */
const eligibleVerdictSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    verdict: z.literal("eligible"),
    /** Which rights basis upstream granted this under. Carried, not re-decided. */
    rightsBasis: contentRightsSchema
  })
  .strict();

const ineligibleVerdictSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    verdict: z.literal("not-eligible"),
    /** No basis exists, stated rather than omitted. */
    rightsBasis: z.null(),
    /** Survives into the slate's exclusion trail, so a missing title is debuggable. */
    reason: z.string().min(1)
  })
  .strict();

export const resolvedEligibilitySchema = z.discriminatedUnion("verdict", [
  eligibleVerdictSchema,
  ineligibleVerdictSchema
]);
export type ResolvedEligibility = z.infer<typeof resolvedEligibilitySchema>;

export interface EligibilityExclusion {
  readonly contentId: string;
  readonly detail: string;
}

export interface EligibilitySeal {
  /**
   * The admitted ids, deduplicated and sorted by code point.
   *
   * Sorted here rather than wherever it is consumed, because everything
   * downstream is a function of this order and a set built from an array
   * inherits that array's order.
   */
  readonly eligibleIds: readonly EligibleContentId[];
  /**
   * The single mint for `EligibleContentId`.
   *
   * Returns `null` rather than throwing: refusing an id is an ordinary,
   * expected outcome that the caller records in the exclusion trail, and an
   * exception would push callers toward a try/catch that swallows it.
   */
  admit(contentId: string): EligibleContentId | null;
  /** Why each refused id was refused, in upstream's words, sorted by id. */
  readonly excluded: readonly EligibilityExclusion[];
}

/**
 * Turns upstream verdicts into a seal.
 *
 * FAIL CLOSED ON CONFLICT. If the same id arrives with both an eligible and an
 * ineligible verdict, the refusal wins. Last-writer-wins would make the seal a
 * function of the order upstream happened to serialise its verdicts in, which is
 * both an order-dependence defect and a rights-bypass: an attacker or a buggy
 * merge could make content playable by appending a verdict. The refusal also
 * wins over the *sorted* order for the same reason — the answer must not depend
 * on how the conflict is spelled.
 *
 * THE RIGHTS RE-CHECK IS A REFUSAL TO CARRY, NOT A SECOND DECISION. An
 * `eligible` verdict whose `rightsBasis` is outside `PLAYABLE_CONTENT_RIGHTS` is
 * dropped. This package does not compute eligibility and must not; what it
 * declines to do is transport a verdict that contradicts the one cross-surface
 * allowlist. With well-typed input the check is vacuous today — every member of
 * `contentRightsSchema` is currently on the allowlist — and it is written anyway
 * because it stops being vacuous the moment a fourth rights value is added to
 * the vocabulary and not to the allowlist, which is exactly the review step it
 * is protecting.
 */
export function sealEligibility(resolved: readonly ResolvedEligibility[]): EligibilitySeal {
  const refused = new Map<string, Set<string>>();
  const admitted = new Set<string>();

  const refuse = (contentId: string, detail: string): void => {
    const held = refused.get(contentId) ?? new Set<string>();
    held.add(detail);
    refused.set(contentId, held);
  };

  for (const record of resolved) {
    if (record.verdict === "not-eligible") {
      refuse(record.contentId, record.reason);
      continue;
    }
    if (!PLAYABLE_CONTENT_RIGHTS.includes(record.rightsBasis)) {
      refuse(
        record.contentId,
        `upstream reported the rights basis "${record.rightsBasis}", which is not on the playable allowlist`
      );
      continue;
    }
    admitted.add(record.contentId);
  }

  for (const contentId of refused.keys()) admitted.delete(contentId);

  const eligibleIds = [...admitted].sort(compareCodePoint) as EligibleContentId[];

  /*
   * EVERY refusal reason is kept, sorted, and joined — not the last one seen.
   *
   * Two `not-eligible` verdicts for one id can carry two different reasons, and
   * `Map.set` would have handed the published detail to whichever arrived last.
   * That is the order-dependence class this repository has already paid for six
   * times, hiding in a field nobody looks at: the slate would still refuse the
   * work, so every rights assertion would pass, and only the explanation would
   * differ between two serialisations of the same input.
   */
  const excluded = [...refused.entries()]
    .map(([contentId, details]) => ({ contentId, detail: [...details].sort(compareCodePoint).join("; ") }))
    .sort((a, b) => compareCodePoint(a.contentId, b.contentId));

  return {
    eligibleIds,
    admit: (contentId: string): EligibleContentId | null =>
      admitted.has(contentId) ? (contentId as EligibleContentId) : null,
    excluded
  };
}
