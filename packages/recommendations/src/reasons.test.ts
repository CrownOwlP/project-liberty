import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EligibleContentId } from "./eligibility";
import { sealEligibility } from "./eligibility";
import type { CandidateGenerator, GeneratorReason } from "./generator";
import {
  CONTINUE_WATCHING_GENERATOR_ID,
  PLACEHOLDER_GENERATORS,
  WATCHLIST_GENERATOR_ID
} from "./generators";
import { rankCandidates } from "./ranking";
import { recommend } from "./recommend";
import { VIEW_EXCLUSION_REASONS, buildView } from "./view";
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
          /*
           * Read from the module's own list rather than a copy. The copy that
           * used to be written here went stale the moment a third reason was
           * added, and a stale allowlist in an assertion passes by accepting
           * less than it should.
           */
          expect(VIEW_EXCLUSION_REASONS).toContain(entry.reason);
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

/* -------------------------------------------------------------------------
 * The reason trail is PARSED at the seam, not trusted.
 *
 * `generators` is a parameter, so it is the way foreign code enters this
 * package — and `generatorReasonSchema` is strict with a closed enum precisely
 * so that what comes back out is a shape the presentation layer can render. A
 * schema that is never executed describes the seam without policing it, which
 * is the hole the eligibility backstop in `recommend.ts` exists to close on the
 * other field.
 *
 * Every generator below requires a cast to write, exactly like the rogue
 * generator in `eligibility.test.ts`. That is the point: these are the shapes
 * that reach the pipeline as untyped JavaScript or through a deliberate cast,
 * and no compiling caller can produce them.
 * ---------------------------------------------------------------------- */

const ELIGIBLE_ALPHA = { eligibility: [eligibleVerdict("alpha")], catalog: [facts("alpha")] };

function generatorEmitting(reasons: unknown): CandidateGenerator {
  return {
    id: "hand-written",
    generate: () => [
      {
        contentId: "alpha" as unknown as EligibleContentId,
        reasons: reasons as readonly [GeneratorReason, ...GeneratorReason[]]
      }
    ]
  };
}

describe("a reason that cannot be published stops the response", () => {
  it("refuses a code outside the published vocabulary", () => {
    /*
     * An unknown code is not a harmless extra label. The surface cannot render
     * or localise it, so it drops it — and the item then sits on a shelf with no
     * explanation, which is the failure PL-0801 exists to prevent, arriving by
     * the one route the closed enum was supposed to block.
     */
    expect(() =>
      recommend(request(ELIGIBLE_ALPHA), [
        generatorEmitting([{ generatorId: "hand-written", code: "because_we_said_so", detail: "trust us" }])
      ])
    ).toThrow(/unusable reason for alpha/);
  });

  it("refuses a reason carrying an extra field", () => {
    /*
     * The direction that matters. Strictness on the REQUEST stops a profile id
     * being smuggled IN; nothing ran on the way OUT, and only the outbound path
     * ends in something a client renders, a log line and a cache entry.
     */
    expect(() =>
      recommend(request(ELIGIBLE_ALPHA), [
        generatorEmitting([
          {
            generatorId: "hand-written",
            code: "on_your_watchlist",
            detail: "this profile added it to its watchlist",
            profileId: "p-1"
          }
        ])
      ])
    ).toThrow(/unusable reason for alpha/);
  });

  it("refuses an unattributed reason and an empty gloss", () => {
    /* A blank generatorId makes a bad rail untraceable to whatever produced it. */
    for (const bad of [
      { generatorId: "", code: "on_your_watchlist", detail: "fine" },
      { generatorId: "hand-written", code: "on_your_watchlist", detail: "" }
    ]) {
      expect(() => recommend(request(ELIGIBLE_ALPHA), [generatorEmitting([bad])])).toThrow(
        /unusable reason for alpha/
      );
    }
  });

  it("refuses a candidate that arrives with no reasons at all", () => {
    /*
     * The non-empty tuple is a compile-time guarantee and this is the runtime
     * shape that defeats it. An id with no trail is precisely a
     * `GeneratedCandidate[]` that was collapsed to a `string[]` somewhere
     * upstream of this package.
     */
    expect(() => recommend(request(ELIGIBLE_ALPHA), [generatorEmitting([])])).toThrow();
  });

  it("still admits a well-formed reason from a generator written by hand", () => {
    /*
     * The complement, so the four refusals above are not passing because the
     * backstop refuses everything from a foreign generator.
     */
    const slate = recommend(request(ELIGIBLE_ALPHA), [
      generatorEmitting([{ generatorId: "hand-written", code: "on_your_watchlist", detail: "picked by hand" }])
    ]);

    expect(slate.items.map((item) => item.contentId)).toEqual(["alpha"]);
    expect(slate.items[0]?.reasons).toEqual([
      { generatorId: "hand-written", code: "on_your_watchlist", detail: "picked by hand" }
    ]);
  });
});
