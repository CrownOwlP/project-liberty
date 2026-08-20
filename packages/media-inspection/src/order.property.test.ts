import {
  MAX_LIST_LENGTH,
  defined,
  permutationKeysArb,
  permute
} from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import { parseDashLadder } from "./dash";
import { parseHlsLadder } from "./hls";
import { DEFAULT_INSPECTION_LIMITS } from "./inspect";
import { canonicaliseRenditions, compareRenditions } from "./order";
import {
  permissiveEgress,
  renderDashMpd,
  renderHlsMaster,
  testClassifyHost,
  type VariantSpec
} from "./testing/fixtures";
import type { DeclaredRendition, ManifestParseContext } from "./types";

/**
 * Ordering properties (fast-check).
 *
 * WHY THESE EXIST. Six order-dependence defects have been found in this
 * repository by hand and every one of them passed a green example suite first.
 * This package is a fresh instance of exactly the conditions that produced them:
 * the input is a LIST written by a third party, both parsers walk it in document
 * order, and the obvious implementation returns the ladder in whatever order the
 * publisher happened to type it. Every downstream cache key, comparison and
 * reason trail would then be a function of a stranger's formatting.
 *
 * The properties compare the WHOLE returned ladder, never just the top rung. A
 * defect in a secondary field is precisely the defect that got through last
 * time, and `expect(top).toEqual(top)` would have shipped it again.
 *
 * The seed is pinned by importing `@liberty/contracts/testing/arbitraries`,
 * which calls `fc.configureGlobal` on first import. `LIBERTY_FC_SEED` widens the
 * search without an edit.
 *
 * THE GENERATOR POOLS ARE DELIBERATELY NARROW. Wide pools make ties
 * astronomically rare, and every tie-break key in `compareRenditions` after the
 * first would then never be exercised -- which is the same as not having tested
 * them. Duplicate variants are generated on purpose too, because collapsing them
 * is a code path with its own way of depending on input order.
 */

const resolutionArb = fc.option(
  fc.constantFrom(
    { width: 640, height: 360 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 800 }
  ),
  { nil: null, freq: 3 }
);

const variantSpecArb: Arbitrary<VariantSpec> = fc
  .record(
    {
      bandwidthBps: fc.option(fc.constantFrom(400_000, 800_000, 2_400_000, 5_000_000), {
        nil: null,
        freq: 3
      }),
      resolution: resolutionArb,
      frameRate: fc.option(fc.constantFrom(24, 25, 29.97, 30, 50, 59.94), { nil: null, freq: 3 }),
      codecs: fc.option(
        fc.constantFrom(
          "avc1.4d401f,mp4a.40.2",
          "avc1.640028,mp4a.40.2",
          "hvc1.1.6.L93.B0,ec-3",
          "av01.0.05M.08",
          "dvhe.05.06",
          "mp4a.40.2",
          "stpp.ttml.im1t"
        ),
        { nil: null, freq: 3 }
      ),
      // A pool that includes a repeat, a relative reference, an absolute URL on
      // an allowlisted host, and one the egress policy refuses -- so the
      // location tie-break and the URI verdict are both reached.
      uri: fc.constantFrom(
        "v/a.m3u8",
        "v/a.m3u8",
        "v/b.m3u8",
        "../up.m3u8",
        "https://cdn.example.test/v/c.m3u8",
        "https://evil.test/v/d.m3u8"
      )
    },
    { noNullPrototype: true }
  )
  .map(({ resolution, ...rest }) => ({
    ...rest,
    width: resolution === null ? null : resolution.width,
    height: resolution === null ? null : resolution.height
  }));

const variantSpecsArb: Arbitrary<VariantSpec[]> = fc.array(variantSpecArb, {
  minLength: 0,
  maxLength: MAX_LIST_LENGTH
});

const context: ManifestParseContext = {
  observedAt: "2026-08-20T09:00:00.000Z",
  baseUrl: "https://cdn.example.test/media/master.m3u8",
  egress: permissiveEgress,
  classifyHost: testClassifyHost,
  // The shipped cap, and far above `MAX_LIST_LENGTH`, so no generated manifest
  // is refused on its size and every property below is about ORDER rather than
  // about the ladder cap. The cap has its own tests.
  maxRenditions: DEFAULT_INSPECTION_LIMITS.maxRenditions
};

const FORMATS: readonly {
  readonly name: string;
  readonly render: (specs: readonly VariantSpec[]) => string;
  readonly parse: (text: string) => readonly DeclaredRendition[];
}[] = [
  {
    name: "hls",
    render: renderHlsMaster,
    parse: (text) => parseHlsLadder(text, context).renditions
  },
  {
    name: "dash",
    render: renderDashMpd,
    parse: (text) => parseDashLadder(text, context).renditions
  }
];

for (const format of FORMATS) {
  describe(`${format.name}: the whole ladder is invariant under manifest order`, () => {
    it("returns an identical ladder for any permutation of the declared variants", () => {
      fc.assert(
        fc.property(variantSpecsArb, permutationKeysArb, (specs, keys) => {
          const canonical = format.parse(format.render(specs));
          const permuted = format.parse(format.render(permute(specs, keys)));
          expect(permuted).toEqual(canonical);
        })
      );
    });

    it("returns an identical ladder for the reversed manifest", () => {
      /*
       * Called out separately from the general permutation because reversal is
       * what a human reviewer actually tries, and it is the single permutation
       * most likely to expose a stability-dependent sort: it inverts the
       * relative order of every tied pair at once, where a random shuffle of a
       * short list frequently leaves ties untouched.
       */
      fc.assert(
        fc.property(variantSpecsArb, (specs) => {
          expect(format.parse(format.render([...specs].reverse()))).toEqual(
            format.parse(format.render(specs))
          );
        })
      );
    });

    it("returns the identical ladder however many times it is called", () => {
      fc.assert(
        fc.property(variantSpecsArb, (specs) => {
          const text = format.render(specs);
          const first = format.parse(text);
          expect(format.parse(text)).toEqual(first);
          expect(format.parse(text)).toEqual(first);
        })
      );
    });
  });

  describe(`${format.name}: the published order is total`, () => {
    it("publishes no comparator ties, which is a post-condition of canonicalisation", () => {
      /*
       * RETITLED, BECAUSE THE OLD NAME CLAIMED SOMETHING THIS CANNOT CHECK. It
       * used to say that a distinguishable pair comparing equal would fail here.
       * It would not: this asserts over `canonicaliseRenditions` OUTPUT, and
       * that function drops any entry comparing equal to its predecessor, so
       * every surviving adjacent pair is non-zero by construction -- including
       * in the defect it named, where the collision would have silently deleted
       * a rung before this loop ever saw it.
       *
       * What it does pin is still worth pinning: the published ladder contains
       * no pair whose order was left to `Array.prototype.sort`'s stability. That
       * is a post-condition of `canonicaliseRenditions`, and it fails if the
       * adjacent-dedup is ever removed while the comparator still returns 0 for
       * something. The claim it used to make is now made -- and can now fail --
       * in "canonicalisation drops nothing distinguishable" below.
       */
      fc.assert(
        fc.property(variantSpecsArb, (specs) => {
          const ladder = format.parse(format.render(specs));
          for (let index = 1; index < ladder.length; index++) {
            const previous = defined(ladder[index - 1], "previous rung");
            const current = defined(ladder[index], "current rung");
            expect(compareRenditions(previous, current)).toBeLessThan(0);
          }
        })
      );
    });

    it("canonicalisation drops nothing distinguishable", () => {
      /*
       * THE ONE THAT CAN ACTUALLY FAIL. `canonicaliseRenditions` deletes entries
       * that compare equal to a neighbour, so a comparator returning 0 for two
       * rungs a caller can tell apart does not produce a wrong ORDER -- it
       * produces a missing RUNG, and a ladder that is silently one shorter than
       * the publisher declared. Asserting over the output cannot see that. This
       * asserts over the input.
       *
       * The pre-canonicalisation rungs are reconstructed by parsing each spec on
       * its own: a one-variant manifest yields one rendition, and canonicalising
       * a single entry drops nothing, so each rung is exactly what the parser
       * would have held before the collapse. `JSON.stringify` is a sound
       * identity here because `buildRendition` inserts every key in a fixed
       * order and `mediaEvidence` in `INSPECTED_FACTS` order -- a serialised
       * rendition is byte-stable, which `types.ts` states and `rendition.ts`
       * implements deliberately.
       *
       * So: as many rungs survive as there are distinct rungs. Fewer means the
       * comparator equated two things that differ.
       */
      fc.assert(
        fc.property(variantSpecsArb, (specs) => {
          const rungs = specs.flatMap((spec) => [...format.parse(format.render([spec]))]);
          const distinct = new Set(rungs.map((rung) => JSON.stringify(rung))).size;
          expect(canonicaliseRenditions(rungs)).toHaveLength(distinct);
        })
      );
    });

    it("places every unknown fact after every stated one on the key it is unknown in", () => {
      // Unknown is a POSITION meaning "not placed", never a numeric claim. A
      // `null` bandwidth sorted as 0 would read as the smallest rung.
      fc.assert(
        fc.property(variantSpecsArb, (specs) => {
          const ladder = format.parse(format.render(specs));
          const firstUnknown = ladder.findIndex((rung) => rung.bandwidthBps === null);
          if (firstUnknown === -1) return;
          for (let index = firstUnknown; index < ladder.length; index++) {
            expect(defined(ladder[index], "rung").bandwidthBps).toBeNull();
          }
        })
      );
    });

    it("is a fixed point of the order it publishes", () => {
      // Sorting an already-sorted ladder changes nothing. A corollary of the
      // permutation property, and the one a reader checks by hand -- it fails
      // loudly and legibly if the sort is ever made stability-dependent, where
      // the general property fails on some unrelated-looking shuffle.
      fc.assert(
        fc.property(variantSpecsArb, (specs) => {
          const ladder = format.parse(format.render(specs));
          expect(canonicaliseRenditions(ladder)).toEqual([...ladder]);
        })
      );
    });
  });
}

describe("canonicalisation leaves the caller's array alone", () => {
  it("does not mutate, reorder or reuse the array it was given", () => {
    /*
     * NOT implied by the permutation properties. An in-place sort is invisible
     * to them -- both calls would be equally affected and both results would
     * still match -- and it is nevertheless the same defect class: a function
     * whose output depends on how many times it has been called with the same
     * array. It is one `.sort(...)` away at all times.
     */
    fc.assert(
      fc.property(variantSpecsArb, (specs) => {
        const ladder = parseHlsLadder(renderHlsMaster(specs), context).renditions;
        const input = [...ladder];
        const snapshot = input.map((rung) => ({ ...rung }));

        canonicaliseRenditions(input);

        expect(input).toEqual(snapshot);
      })
    );
  });
});
