import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sealEligibility } from "./eligibility";
import {
  CONTINUE_WATCHING_GENERATOR_ID,
  PLACEHOLDER_GENERATORS,
  WATCHLIST_GENERATOR_ID
} from "./generators";
import { rankCandidates } from "./ranking";
import { recommend } from "./recommend";
import { buildView } from "./view";
import {
  eligibleVerdict,
  facts,
  progress,
  request,
  requestArb,
  type GeneratedRequest
} from "./testing/fixtures";

/* -------------------------------------------------------------------------
 * Acceptance clause: it returns content ids plus generator reasons, so the
 * reason trail survives the layer most likely to lose it.
 *
 * The layer in question is the merge in `ranking.ts` and the mapping in
 * `presentation.ts` — the two places where "we only need the ids here" is a
 * natural thing to write. Every test below follows a reason all the way from the
 * generator that produced it to the presented item, rather than checking that a
 * `reasons` field exists.
 * ---------------------------------------------------------------------- */

const GENERATOR_IDS = [CONTINUE_WATCHING_GENERATOR_ID, WATCHLIST_GENERATOR_ID];

describe("a reason produced by a generator reaches the presented item", () => {
  it("carries the generator's own reason objects through ranking and presentation", () => {
    const parts = {
      eligibility: [eligibleVerdict("alpha")],
      watchlist: ["alpha"],
      catalog: [facts("alpha")]
    };

    const { view } = buildView(
      { watchlist: [...parts.watchlist], progress: [], catalog: [...parts.catalog] },
      sealEligibility(parts.eligibility)
    );
    const emitted = PLACEHOLDER_GENERATORS.flatMap((generator) => generator.generate(view)).flatMap(
      (candidate) => [...candidate.reasons]
    );

    const slate = recommend(request(parts));

    // The same objects by value, not merely a non-empty array of something.
    expect(slate.items[0]?.reasons).toEqual(emitted);
  });

  it("keeps BOTH reasons when two generators produce the same work", () => {
    /*
     * The merge ranks the work under the first generator and would be perfectly
     * functional if it discarded the second one's reason — the order would be
     * identical and no test of the order would notice. Dropping it would mean
     * the trail explains the ranking rather than the selection, which is the
     * weaker of the two things it is for.
     */
    const slate = recommend(
      request({
        eligibility: [eligibleVerdict("alpha")],
        watchlist: ["alpha"],
        progress: [progress("alpha", { positionSeconds: 600 })],
        catalog: [facts("alpha")]
      })
    );

    expect(slate.items[0]?.reasons.map((entry) => entry.generatorId)).toEqual([
      CONTINUE_WATCHING_GENERATOR_ID,
      WATCHLIST_GENERATOR_ID
    ]);
    expect(slate.items[0]?.reasons.map((entry) => entry.code)).toEqual([
      "continue_watching",
      "on_your_watchlist"
    ]);
  });

  it("orders merged reasons by generator precedence, not by arrival", () => {
    /*
     * Merge order is the generator array's order, which is a declared product
     * statement. If it were the order the map happened to be written in, adding
     * a generator would silently reshuffle every existing item's trail.
     */
    const parts = {
      eligibility: [eligibleVerdict("alpha")],
      watchlist: ["alpha"],
      progress: [progress("alpha")],
      catalog: [facts("alpha")]
    };
    const { view } = buildView(
      { watchlist: [...parts.watchlist], progress: [...parts.progress], catalog: [...parts.catalog] },
      sealEligibility(parts.eligibility)
    );

    const forward = rankCandidates(view, PLACEHOLDER_GENERATORS);
    const reversed = rankCandidates(view, [...PLACEHOLDER_GENERATORS].reverse());

    expect(forward[0]?.reasons.map((entry) => entry.generatorId)).toEqual([
      CONTINUE_WATCHING_GENERATOR_ID,
      WATCHLIST_GENERATOR_ID
    ]);
    expect(reversed[0]?.reasons.map((entry) => entry.generatorId)).toEqual([
      WATCHLIST_GENERATOR_ID,
      CONTINUE_WATCHING_GENERATOR_ID
    ]);
  });
});

describe("no item can reach the slate without a trail", () => {
  it("gives every presented item at least one reason, attributed to a real generator", () => {
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const slate = recommend(request(generated));
        for (const item of slate.items) {
          expect(item.reasons.length).toBeGreaterThan(0);
          for (const entry of item.reasons) {
            expect(GENERATOR_IDS).toContain(entry.generatorId);
            expect(entry.detail.length).toBeGreaterThan(0);
          }
        }
      })
    );
  });

  it("states a reason for every exclusion too", () => {
    /*
     * "I have it on my watchlist, why is it not there" is asked from the client,
     * so the answer is published rather than logged. An empty slate with no
     * explanation is the failure mode that gets escalated as a data bug.
     */
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const slate = recommend(request(generated));
        for (const entry of slate.excluded) {
          expect(["upstream_not_eligible", "no_catalog_metadata"]).toContain(entry.reason);
          expect(entry.detail.length).toBeGreaterThan(0);
        }
      })
    );
  });

  it("carries no measurement of the profile in a reason's text", () => {
    /*
     * A reason is rendered, logged and cached. "42% into a 118-minute film"
     * would push a precise behavioural measurement of one person into all three
     * in service of a sentence the `code` already conveys.
     */
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const slate = recommend(request(generated));
        for (const item of slate.items) {
          for (const entry of item.reasons) expect(entry.detail).not.toMatch(/\d/);
        }
      })
    );
  });
});
