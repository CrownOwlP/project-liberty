import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import { SEARCH_QUERY_MAX_LENGTH, normalizeSearchQuery } from "./search";
/*
 * Imported for its side effect and nothing else: first import of that module
 * calls `fc.configureGlobal` and applies the PINNED fast-check seed, so a
 * counterexample found here is reproducible by anyone who runs the suite. An
 * unpinned property suite fails on one CI run in forty with a counterexample
 * nobody can reproduce, and a test that cannot be reproduced gets retried until
 * it passes.
 */
import "../testing/arbitraries";

/**
 * PL-0102 follow-up: `normalizeSearchQuery` is TOTAL, and that has to include
 * the shape of what it returns.
 *
 * The contract's own docblock has always called this function deliberately
 * total, meaning it converts bad input into a usable query rather than throwing.
 * That claim was only half true. Its output travelled straight into
 * `encodeURIComponent`, which throws `URIError` on an unpaired surrogate — and
 * this function could both PASS ONE THROUGH from the input and MANUFACTURE one,
 * because the length cap sliced by UTF-16 code unit and could land between the
 * halves of a surrogate pair.
 *
 * A total function may not return a value that makes its own documented consumer
 * throw, so the guarantee is now stated and tested in both directions: nothing
 * unpaired survives, and the cap never creates something unpaired.
 */

/** One astral character, i.e. TWO UTF-16 code units. */
const ASTRAL = String.fromCodePoint(0x1f600);
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Well-formedness, scanned by hand.
 *
 * Written as an explicit walk rather than by reusing the implementation's own
 * regex: a check that shares its definition of "unpaired" with the code under
 * test proves the two agree, which is not the same as proving either is right.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * Any single UTF-16 CODE UNIT, unpaired surrogate halves included.
 *
 * fast-check's `unit: "binary"` generates code POINTS and documents that it
 * excludes half surrogate pairs, so every string it builds is already
 * well-formed and none of them could have produced this defect. Raw code units
 * are the point.
 */
const codeUnitArb: Arbitrary<string> = fc
  .integer({ min: 0x0000, max: 0xffff })
  .map((unit) => String.fromCharCode(unit));

/**
 * Padding lengths that put an astral character astride the cap.
 *
 * Random generation reaches the failing alignment eventually and only
 * eventually — the pair has to land on exactly the 128th code unit. Aiming at it
 * turns "a few thousand runs" into "the first few".
 */
const capBoundaryArb: Arbitrary<string> = fc
  .integer({ min: SEARCH_QUERY_MAX_LENGTH - 4, max: SEARCH_QUERY_MAX_LENGTH + 2 })
  .map((padding) => `${"a".repeat(padding)}${ASTRAL}bbb`);

const anyQueryTextArb: Arbitrary<string> = fc.oneof(
  fc.string({ unit: codeUnitArb, maxLength: 260 }),
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ maxLength: 40 }),
  capBoundaryArb
);

describe("normalizeSearchQuery repairs unpaired surrogates", () => {
  it("replaces a lone half, wherever in the query it sits", () => {
    expect(normalizeSearchQuery(HIGH)).toBe(REPLACEMENT);
    expect(normalizeSearchQuery(LOW)).toBe(REPLACEMENT);
    expect(normalizeSearchQuery(`a${HIGH}b`)).toBe(`a${REPLACEMENT}b`);
    expect(normalizeSearchQuery(`a${LOW}b`)).toBe(`a${REPLACEMENT}b`);
  });

  it("leaves a genuine surrogate pair alone", () => {
    // The complement of the rule above. If this ever fails, every astral
    // character — every emoji anyone searches for — has been mangled.
    expect(normalizeSearchQuery(`a${ASTRAL}b`)).toBe(`a${ASTRAL}b`);
    expect(normalizeSearchQuery(String.fromCharCode(0xd800, 0xdc00))).toBe(
      String.fromCharCode(0xd800, 0xdc00)
    );
  });

  it("resolves a run of surrogates in favour of the pair inside it", () => {
    // A high surrogate followed by a pair: the first is unpaired, the next two
    // are not. Matching greedily from the left is what gets this right, and a
    // rule that scanned for "a high surrogate" alone would corrupt the pair.
    expect(normalizeSearchQuery(`${HIGH}${ASTRAL}`)).toBe(`${REPLACEMENT}${ASTRAL}`);
    // Reversed halves are two orphans, not a pair.
    expect(normalizeSearchQuery(`${LOW}${HIGH}`)).toBe(`${REPLACEMENT}${REPLACEMENT}`);
  });

  it("replaces rather than deletes, because the URL round trip already does", () => {
    /*
     * A lone surrogate has no UTF-8 encoding. The browser substitutes U+FFFD
     * when it submits the no-JavaScript form, and the URL parser substitutes it
     * when the server reads `q` back — so deleting the code unit here would make
     * the client path produce a different query from the no-JavaScript path for
     * the same typed text. Same text, two result sets, which is the exact
     * client/server disagreement this function exists to prevent.
     */
    expect(normalizeSearchQuery(`a${HIGH}b`)).toHaveLength(3);
  });
});

describe("normalizeSearchQuery truncates at a code-point boundary", () => {
  it("drops the whole astral character that straddles the cap", () => {
    /*
     * THE BLOCKER. 127 ASCII characters plus one astral character is 129 code
     * units, so a plain `slice(0, 128)` cut between the halves and returned a
     * string ending in a lone high surrogate — on which `encodeURIComponent`
     * throws. Backing up to the boundary costs one character and cannot throw.
     */
    const straddling = `${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}${ASTRAL}`;
    expect(straddling).toHaveLength(SEARCH_QUERY_MAX_LENGTH + 1);

    const normalized = normalizeSearchQuery(straddling);
    expect(normalized).toBe("a".repeat(SEARCH_QUERY_MAX_LENGTH - 1));
    expect(hasLoneSurrogate(normalized)).toBe(false);
  });

  it("keeps an astral character that ends exactly on the cap", () => {
    // Backing up must happen at the boundary and nowhere else, or the cap would
    // quietly cost a character on every over-long query.
    const exact = `${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 2)}${ASTRAL}`;
    expect(exact).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
    expect(normalizeSearchQuery(exact)).toBe(exact);
  });

  it("stays idempotent when the truncation lands on a pair", () => {
    // Re-parsing our own response must not change the query. A truncation that
    // left half a character behind would fail this the moment U+FFFD appeared.
    const once = normalizeSearchQuery(`${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}${ASTRAL}bbb`);
    expect(normalizeSearchQuery(once)).toBe(once);
  });
});

describe("normalizeSearchQuery output properties", () => {
  it("never emits an unpaired surrogate, for any sequence of code units", () => {
    fc.assert(
      fc.property(anyQueryTextArb, (raw) => {
        expect(hasLoneSurrogate(normalizeSearchQuery(raw))).toBe(false);
      })
    );
  });

  it("never returns something percent-encoding refuses", () => {
    /*
     * The guarantee stated as its consumer sees it. `buildSearchHref` in
     * `apps/web` calls `encodeURIComponent` on this result, and that call is the
     * one that used to throw — inside a debounce callback, after the navigation
     * had already been recorded, leaving the search field accepting typing and
     * never moving again. Asserted here as well as there because this is the
     * side of the boundary that makes the promise.
     */
    fc.assert(
      fc.property(anyQueryTextArb, (raw) => {
        expect(() => encodeURIComponent(normalizeSearchQuery(raw))).not.toThrow();
      })
    );
  });

  it("stays within the cap and idempotent for any input", () => {
    fc.assert(
      fc.property(anyQueryTextArb, (raw) => {
        const once = normalizeSearchQuery(raw);
        expect(once.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_LENGTH);
        expect(normalizeSearchQuery(once)).toBe(once);
      })
    );
  });
});
