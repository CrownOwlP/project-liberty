import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EligibleContentId } from "./eligibility";
import { sealEligibility } from "./eligibility";
import type { CandidateGenerator } from "./generator";
import { reason } from "./generator";
import { recommend } from "./recommend";
import {
  eligibleVerdict,
  facts,
  ineligibleVerdict,
  progress,
  request,
  requestArb,
  type GeneratedRequest
} from "./testing/fixtures";

/* -------------------------------------------------------------------------
 * Acceptance clause: eligibility is resolved upstream, so recommendation can
 * never make content playable.
 *
 * THE PRIMARY ENFORCEMENT IS NOT TESTED HERE, BECAUSE IT CANNOT BE. A generator
 * cannot name an ineligible work because it has no `EligibleContentId` for one
 * and no way to construct one — that is a compile-time property, and a passing
 * runtime test says nothing about it. What the compiler cannot cover is a
 * generator arriving as untyped JavaScript or one using a cast, so the tests
 * below exercise the runtime backstop and the seal's refusal rules, and the
 * type-level guarantee is asserted by the absence of an exported brand
 * constructor in `index.ts`.
 * ---------------------------------------------------------------------- */

describe("an ineligible work cannot reach the slate", () => {
  it("refuses a work upstream marked not-eligible, however loudly the profile asked for it", () => {
    const slate = recommend(
      request({
        eligibility: [ineligibleVerdict("gamma", "rights lapsed"), eligibleVerdict("alpha")],
        watchlist: ["alpha", "gamma"],
        progress: [progress("gamma", { positionSeconds: 3600 })],
        catalog: [facts("alpha"), facts("gamma")]
      })
    );

    expect(slate.items.map((item) => item.contentId)).toEqual(["alpha"]);
    expect(slate.excluded).toContainEqual({
      contentId: "gamma",
      reason: "upstream_not_eligible",
      detail: "rights lapsed"
    });
  });

  it("fails closed on a work with no verdict at all", () => {
    /*
     * Absence is a refusal, not a default-allow. An upstream that forgot to
     * resolve an id is indistinguishable from one that could not, and the safe
     * reading of both is "not eligible".
     */
    const slate = recommend(request({ watchlist: ["alpha"], catalog: [facts("alpha")] }));

    expect(slate.items).toEqual([]);
    expect(slate.excluded).toEqual([
      {
        contentId: "alpha",
        reason: "upstream_not_eligible",
        detail: "upstream supplied no eligible verdict for this id"
      }
    ]);
  });

  it("lets the refusal win over the approval in either arrival order", () => {
    /*
     * Last-writer-wins here would be both an order-dependence defect and a
     * rights bypass: appending a verdict would make content surfaceable.
     */
    const both = [eligibleVerdict("alpha"), ineligibleVerdict("alpha", "conflicting verdicts")];

    for (const eligibility of [both, [...both].reverse()]) {
      const seal = sealEligibility(eligibility);
      expect(seal.admit("alpha")).toBeNull();
      expect(seal.eligibleIds).toEqual([]);
    }
  });

  it("declines to carry an eligible verdict whose rights basis is off the allowlist", () => {
    /*
     * Not a second eligibility decision — a refusal to TRANSPORT a verdict that
     * contradicts `PLAYABLE_CONTENT_RIGHTS`. Reachable only with a value outside
     * `contentRightsSchema`, which is why the cast is here rather than in the
     * fixture: every member of the current vocabulary is on the allowlist, so
     * with well-typed input this check is vacuous today and stops being vacuous
     * the moment a fourth rights value is added to one list and not the other.
     */
    const seal = sealEligibility([
      { contentId: "alpha", verdict: "eligible", rightsBasis: "scraped" as never }
    ]);

    expect(seal.admit("alpha")).toBeNull();
    expect(seal.excluded[0]?.detail).toContain("not on the playable allowlist");
  });
});

describe("the runtime backstop covers what the compiler cannot", () => {
  it("throws when a generator produces an id that is not in the eligible view", () => {
    /*
     * The cast is the point: this is the only way to write this generator, and
     * writing it requires deliberately defeating the type. A filtered slate
     * would let this pass as a slate that quietly shrank, so it throws.
     */
    const rogue: CandidateGenerator = {
      id: "rogue",
      generate: () => [
        {
          contentId: "unlicensed-work" as unknown as EligibleContentId,
          reasons: reason("rogue", "on_your_watchlist", "fabricated")
        }
      ]
    };

    expect(() =>
      recommend(
        request({ eligibility: [eligibleVerdict("alpha")], watchlist: ["alpha"], catalog: [facts("alpha")] }),
        [rogue]
      )
    ).toThrow(/cannot be widened here/);
  });
});

describe("the slate carries nothing that could be acted on to obtain bytes", () => {
  it("exposes no url, stream, provider, manifest, token or entitlement field", () => {
    /*
     * The other half of "recommendation cannot make content playable": even a
     * correct, eligible recommendation must not be a shortcut to playback. The
     * most a compromised generator can achieve is putting a title on a shelf.
     */
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const slate = recommend(request(generated));
        for (const item of slate.items) {
          for (const key of Object.keys(item)) {
            expect(key).not.toMatch(/url|uri|stream|manifest|provider|token|licen[cs]e|drm|entitle/i);
          }
        }
      })
    );
  });
});

describe("the rights boundary holds for arbitrary input", () => {
  it("never presents a work without a surviving eligible verdict", () => {
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const slate = recommend(request(generated));
        const refused = new Set(
          generated.eligibility.filter((v) => v.verdict === "not-eligible").map((v) => v.contentId)
        );
        const approved = new Set(
          generated.eligibility.filter((v) => v.verdict === "eligible").map((v) => v.contentId)
        );

        for (const item of slate.items) {
          expect(approved.has(item.contentId)).toBe(true);
          expect(refused.has(item.contentId)).toBe(false);
        }
      })
    );
  });

  it("accounts for every referenced work exactly once, in items or in excluded", () => {
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        /*
         * Only meaningful without truncation — a limit legitimately drops ranked
         * items, and they are not exclusions. Run at the full limit so the
         * partition is exhaustive.
         */
        const slate = recommend(request({ ...generated, limit: 100 }));
        const referenced = new Set([
          ...generated.watchlist,
          ...generated.progress.map((entry) => entry.contentId),
          ...generated.catalog.map((entry) => entry.contentId)
        ]);

        const presented = slate.items.map((item) => item.contentId);
        const excluded = slate.excluded.map((entry) => entry.contentId);
        const accounted = new Set([...presented, ...excluded]);

        for (const id of accounted) expect(referenced.has(id)).toBe(true);
        expect(new Set(presented).size).toBe(presented.length);
        expect(new Set(excluded).size).toBe(excluded.length);
        for (const id of presented) expect(excluded).not.toContain(id);
      })
    );
  });
});
