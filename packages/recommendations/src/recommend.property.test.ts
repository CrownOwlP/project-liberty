import { defined, permutationKeysArb, permute } from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recommend } from "./recommend";
import { request, requestArb, type GeneratedRequest } from "./testing/fixtures";

/* -------------------------------------------------------------------------
 * Determinism properties for the whole boundary (PL-0801).
 *
 * WHY THESE EXIST. Six order-dependence defects have been found in this
 * repository by hand, and every one of them passed a green example suite first.
 * The shape is always the same: a determinism claim that holds only in the
 * configuration the examples happen to use. So the properties below compare the
 * WHOLE slate — items, ranks, reasons and exclusions — never just the first
 * item. A defect in a secondary field is exactly the defect that got through
 * last time.
 *
 * Each of the four input arrays is permuted INDEPENDENTLY with its own key
 * stream. Permuting them together would leave a shared index alignment intact,
 * and a pipeline that accidentally paired the nth watchlist entry with the nth
 * catalog entry would survive it.
 *
 * `fast-check` is a declared devDependency of this package at the same
 * specifier every sibling uses, and the arbitraries are reached from
 * `@liberty/contracts/testing/arbitraries` so the repository keeps one pinned
 * seed. Both require `npm install` to have been run after this package was
 * added.
 * ---------------------------------------------------------------------- */

const fourKeyStreams = fc.tuple(
  permutationKeysArb,
  permutationKeysArb,
  permutationKeysArb,
  permutationKeysArb
);

function permuted(generated: GeneratedRequest, keys: readonly number[][]): Record<string, unknown> {
  return request({
    at: generated.at,
    limit: generated.limit,
    eligibility: permute(generated.eligibility, defined(keys[0], "eligibility keys")),
    watchlist: permute(generated.watchlist, defined(keys[1], "watchlist keys")),
    progress: permute(generated.progress, defined(keys[2], "progress keys")),
    catalog: permute(generated.catalog, defined(keys[3], "catalog keys"))
  });
}

describe("the whole slate is invariant under input order", () => {
  it("produces an identical slate for any permutation of the four input arrays", () => {
    fc.assert(
      fc.property(requestArb, fourKeyStreams, (generated: GeneratedRequest, keys) => {
        expect(recommend(permuted(generated, keys))).toEqual(recommend(request(generated)));
      })
    );
  });

  it("produces an identical slate when every input array is reversed", () => {
    /*
     * Called out separately from the general permutation because reversal is
     * what a human reviewer actually tries, and it is the single permutation
     * most likely to expose a stability-dependent sort: it inverts the relative
     * order of every tied pair at once, where a random shuffle of a short list
     * frequently leaves ties untouched.
     */
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const reversed = request({
          at: generated.at,
          limit: generated.limit,
          eligibility: [...generated.eligibility].reverse(),
          watchlist: [...generated.watchlist].reverse(),
          progress: [...generated.progress].reverse(),
          catalog: [...generated.catalog].reverse()
        });

        expect(recommend(reversed)).toEqual(recommend(request(generated)));
      })
    );
  });
});

describe("the slate is stable, and the caller's arrays are left alone", () => {
  /*
   * NEITHER of these is implied by the permutation properties above, which is
   * the only reason they are here rather than being redundant restatements.
   *
   * An in-place sort of the caller's array is invisible to a permutation
   * property: both calls would be equally affected and both results would still
   * match. It is nevertheless the same defect class — a function whose output
   * depends on how many times it has been called with the same input — and it is
   * one `.sort(...)` away at all times, because the view is built by sorting.
   *
   * Repeated-call determinism is not implied either. A permutation property
   * fixes the RELATION between two calls made in one test body; it says nothing
   * about a memo keyed on something incidental, a lazily-initialised module
   * constant, or a clock read that this package claims not to make.
   */
  it("does not mutate or reorder the request it was given", () => {
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const input = request(generated);
        const snapshot = structuredClone(input);

        recommend(input);

        expect(input).toEqual(snapshot);
      })
    );
  });

  it("returns the identical slate however many times it is called", () => {
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const first = recommend(request(generated));
        expect(recommend(request(generated))).toEqual(first);
        expect(recommend(request(generated))).toEqual(first);
      })
    );
  });
});

describe("the published order is total", () => {
  it("ranks strictly, from 1, with no gaps and no repeats", () => {
    /*
     * STRICTLY increasing, not non-decreasing. A comparator that returns 0 for
     * two distinct entries leaves their order to `Array.prototype.sort`
     * stability, which leaves it to input order — a determinism bug no example
     * test can see, because the example always supplies them in one order.
     */
    fc.assert(
      fc.property(requestArb, (generated: GeneratedRequest) => {
        const { items } = recommend(request(generated));
        items.forEach((item, index) => {
          expect(item.rank).toBe(index + 1);
        });
        expect(new Set(items.map((item) => item.contentId)).size).toBe(items.length);
      })
    );
  });

  it("makes a shorter slate a prefix of a longer one", () => {
    /*
     * The limit selects a prefix of a fixed order rather than influencing what
     * is ranked. If truncation happened before ranking, the shorter slate would
     * not be a prefix of the longer one — which is exactly what a caller assumes
     * when it asks for more.
     */
    fc.assert(
      fc.property(requestArb, fc.integer({ min: 0, max: 6 }), (generated: GeneratedRequest, limit) => {
        const short = recommend(request({ ...generated, limit }));
        const long = recommend(request({ ...generated, limit: 100 }));

        expect(short.items).toEqual(long.items.slice(0, limit));
        // Exclusions are not truncation: a limited slate still explains itself.
        expect(short.excluded).toEqual(long.excluded);
      })
    );
  });

  it("never reads a clock", () => {
    /*
     * The instant is an explicit input, so the only correct value of
     * `generatedAt` is the one the caller supplied. A `Date.now()` anywhere in
     * the pipeline shows up here and nowhere else.
     */
    fc.assert(
      fc.property(requestArb, fc.constantFrom("2020-01-01T00:00:00.000Z", "2031-06-30T12:34:56.000Z"), (generated, at) => {
        expect(recommend(request({ ...generated, at })).generatedAt).toBe(at);
      })
    );
  });
});
