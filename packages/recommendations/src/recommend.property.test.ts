import { defined, permutationKeysArb, permute } from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recommend } from "./recommend";
import {
  AT,
  eligibleVerdict,
  facts,
  ineligibleVerdict,
  request,
  requestArb,
  type GeneratedRequest
} from "./testing/fixtures";

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

  it("pins the order of a tie the comparator cannot break on precedence", () => {
    /*
     * Two works on the watchlist and nothing else: one generator, so
     * `generatorIndex` ties for both and the order falls entirely to
     * `emissionIndex`. That index is a function of VIEW order, which `buildView`
     * has already made code-point canonical — which is why this holds under
     * reversal, and why the fix for a tie lives at the input rather than in a
     * final sort of the output.
     *
     * Stated as an example beside the general permutation property because this
     * is the configuration a reviewer asks about by name ("what happens when two
     * candidates are equally good"), and a property that merely says "the two
     * calls agree" does not say WHICH order they agree on.
     */
    const parts = {
      eligibility: [eligibleVerdict("alpha"), eligibleVerdict("gamma")],
      catalog: [facts("alpha"), facts("gamma")]
    };
    const forward = recommend(request({ ...parts, watchlist: ["alpha", "gamma"] }));
    const backward = recommend(request({ ...parts, watchlist: ["gamma", "alpha"] }));

    expect(forward.items.map((item) => item.contentId)).toEqual(["alpha", "gamma"]);
    expect(backward).toEqual(forward);
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

describe("the degenerate shapes, named", () => {
  /*
   * WHY EXAMPLES SIT IN A PROPERTY FILE. Two reasons, and neither is that
   * properties are insufficient in general.
   *
   * First, reachability. Every shape below needs all four of `requestArb`'s
   * arrays to land in one specific configuration at once — empty, or a single id
   * present in three of them — and whether any given run produces that is a fact
   * about fast-check's size bias, not something the suite guarantees. A shape the
   * generator reaches by luck is not covered.
   *
   * Second, and more importantly, a property fixes a RELATION and these fix a
   * VALUE. "Two calls agree" is true of a function that throws both times, and
   * true of one that returns an empty slate for a profile that should have had
   * one. What an empty profile actually gets back has to be written down.
   */

  it("returns an empty, well-formed slate for a profile with nothing at all", () => {
    const slate = recommend(request());

    expect(slate).toEqual({ generatedAt: AT, items: [], excluded: [] });
    // Not merely empty: still stable, and still echoing the caller's instant.
    expect(recommend(request())).toEqual(slate);
  });

  it("returns an empty slate, with a trail, for a profile whose every work is refused", () => {
    /*
     * The distinction that matters operationally: an empty slate because there
     * was nothing to say, versus an empty slate because everything was refused.
     * Those must not look alike, which is what `excluded` is published for.
     */
    const slate = recommend(
      request({
        eligibility: [ineligibleVerdict("alpha", "rights lapsed")],
        watchlist: ["alpha"],
        catalog: [facts("alpha")]
      })
    );

    expect(slate.items).toEqual([]);
    expect(slate.excluded).toHaveLength(1);
  });

  it("ranks a single candidate at 1, with its trail intact", () => {
    const slate = recommend(
      request({
        eligibility: [eligibleVerdict("alpha")],
        watchlist: ["alpha"],
        catalog: [facts("alpha")]
      })
    );

    expect(slate.items).toHaveLength(1);
    expect(slate.items[0]?.rank).toBe(1);
    expect(slate.items[0]?.reasons).toHaveLength(1);
  });

  it("serves a profile with no viewing history from the watchlist alone", () => {
    /*
     * No progress records at all. `continueWatchingGenerator` contributes
     * nothing, and the absence of a progress record must read as "not watched"
     * rather than as "completed" — the latter would empty the watchlist rail for
     * every new profile, which is the cold-start failure that looks like the
     * feature being broken.
     */
    const slate = recommend(
      request({
        eligibility: [eligibleVerdict("alpha"), eligibleVerdict("gamma")],
        watchlist: ["gamma", "alpha"],
        progress: [],
        catalog: [facts("alpha"), facts("gamma")]
      })
    );

    expect(slate.items.map((item) => item.contentId)).toEqual(["alpha", "gamma"]);
    for (const item of slate.items) {
      expect(item.reasons.map((entry) => entry.code)).toEqual(["on_your_watchlist"]);
    }
  });

  it("accounts for an eligible work it cannot describe, rather than dropping it", () => {
    /*
     * Eligible, referenced, and with no catalog metadata: the one case where the
     * seal says yes and the view still says no. It must appear in the trail —
     * silently vanishing is how a metadata gap gets reported as a rights bug.
     */
    const slate = recommend(
      request({ eligibility: [eligibleVerdict("alpha")], watchlist: ["alpha"], catalog: [] })
    );

    expect(slate.items).toEqual([]);
    expect(slate.excluded).toEqual([
      {
        contentId: "alpha",
        reason: "no_catalog_metadata",
        detail: "eligible, but no catalog metadata was supplied to describe it"
      }
    ]);
  });
});
