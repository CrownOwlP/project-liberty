import { describe, expect, it } from "vitest";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import {
  deriveNormalizedContentId,
  normalizeIdSegment,
  resolveWorkIdentities,
  type IdentityCandidate
} from "./identity";

const candidate = (
  sourceId: string,
  nativeId: string,
  crossRefs: readonly { authority: string; id: string }[] = []
): IdentityCandidate => {
  const derived = deriveNormalizedContentId({ sourceId, nativeId });
  if (!derived.ok) throw new Error(`fixture id did not derive: ${derived.reason}`);
  return { contentId: derived.contentId, ref: { sourceId, nativeId }, crossRefs };
};

describe("normalizeIdSegment", () => {
  it("folds provider spellings into the id alphabet", () => {
    expect(normalizeIdSegment("tt0133093")).toBe("tt0133093");
    expect(normalizeIdSegment("Q83495")).toBe("q83495");
    expect(normalizeIdSegment("The Matrix (1999)")).toBe("the-matrix-1999");
    expect(normalizeIdSegment("--leading--and--trailing--")).toBe("leading-and-trailing");
  });

  /*
   * WHAT THIS CATCHES: a lossy default being introduced for non-ASCII ids. The
   * tempting behaviours are to emit `--`, to emit the empty string, or to
   * transliterate with whatever `normalize("NFD")` happens to do. The first two
   * produce ids that either collide with each other or fail the contract; the
   * third is a decision that needs taking deliberately. A `null` here is what
   * forces every caller to have a refusal branch.
   */
  it("refuses a segment with nothing in the id alphabet rather than emitting a stub", () => {
    expect(normalizeIdSegment("日本語")).toBeNull();
    expect(normalizeIdSegment("...")).toBeNull();
    expect(normalizeIdSegment("")).toBeNull();
  });
});

describe("deriveNormalizedContentId", () => {
  it("namespaces the provider's id by its source", () => {
    const derived = deriveNormalizedContentId({ sourceId: "example-source", nativeId: "tt0133093" });
    expect(derived).toEqual({ ok: true, contentId: "example-source-tt0133093" });
  });

  /*
   * WHAT THIS CATCHES: the derivation drifting away from the contract it has to
   * satisfy. Every id minted here is interpolated into `/title/<id>`, so one
   * that `normalizedContentIdSchema` would reject is a broken route. Asserting
   * against the CONTRACT's parser rather than against this module's own regex is
   * the point -- a copy of the pattern here would agree with itself forever.
   */
  it("only ever mints ids the contract accepts", () => {
    const awkward = [
      { sourceId: "Example Source", nativeId: "Title: The Sequel" },
      { sourceId: "s", nativeId: "1" },
      { sourceId: "UPPER", nativeId: "___x___" }
    ];
    for (const ref of awkward) {
      const derived = deriveNormalizedContentId(ref);
      expect(derived.ok, JSON.stringify(ref)).toBe(true);
      if (!derived.ok) continue;
      expect(normalizedContentIdSchema.safeParse(derived.contentId).success).toBe(true);
    }
  });

  it("names which half failed to normalize", () => {
    expect(deriveNormalizedContentId({ sourceId: "日本語", nativeId: "x" })).toEqual({
      ok: false,
      reason: "source_id_not_normalizable"
    });
    expect(deriveNormalizedContentId({ sourceId: "x", nativeId: "日本語" })).toEqual({
      ok: false,
      reason: "native_id_not_normalizable"
    });
  });
});

describe("resolveWorkIdentities", () => {
  const precedence = ["alpha", "beta", "gamma"];

  /*
   * WHAT THIS CATCHES: a fuzzy matcher being introduced. These two records are
   * the same film by every human measure -- same normalized title, same year --
   * and they cite no common authority. Merging them would be a guess, and a
   * guess here merges two rights bases. If someone adds title similarity to this
   * function, this test fails.
   */
  it("does not merge two records that merely look alike", () => {
    const resolution = resolveWorkIdentities(
      [candidate("alpha", "the-matrix"), candidate("beta", "the-matrix")],
      precedence
    );
    expect(resolution.identities).toHaveLength(2);
    expect(resolution.identities.map((identity) => identity.canonicalId)).toEqual([
      "alpha-the-matrix",
      "beta-the-matrix"
    ]);
  });

  it("merges two records that cite the same authority identifier", () => {
    const resolution = resolveWorkIdentities(
      [
        candidate("beta", "b1", [{ authority: "imdb", id: "tt0133093" }]),
        candidate("alpha", "a1", [{ authority: "imdb", id: "tt0133093" }])
      ],
      precedence
    );

    expect(resolution.identities).toHaveLength(1);
    const [identity] = resolution.identities;
    expect(identity?.canonicalId).toBe("alpha-a1");
    expect(identity?.mergedFrom).toEqual(["beta-b1"]);
  });

  /*
   * WHAT THIS CATCHES: a pairwise implementation replacing the union-find. A and
   * B share an IMDb id; B and C share a Wikidata id; A and C share nothing. All
   * three are one work, and a naive pass that only compared adjacent pairs, or
   * that indexed by the first ref only, would produce two groups.
   */
  it("merges transitively across different authorities", () => {
    const resolution = resolveWorkIdentities(
      [
        candidate("alpha", "a1", [{ authority: "imdb", id: "tt1" }]),
        candidate("beta", "b1", [
          { authority: "imdb", id: "tt1" },
          { authority: "wikidata", id: "q1" }
        ]),
        candidate("gamma", "c1", [{ authority: "wikidata", id: "q1" }])
      ],
      precedence
    );

    expect(resolution.identities).toHaveLength(1);
    expect(resolution.identities[0]?.members).toHaveLength(3);
    expect(resolution.identities[0]?.canonicalId).toBe("alpha-a1");
  });

  /*
   * WHAT THIS CATCHES: an authority key built by string concatenation with a
   * separator that can appear in the data. `("a", "bc")` and `("ab", "c")` join
   * to the same `a:bc` under a colon, which silently merges two unrelated works
   * -- the exact accidental merge the strict-matching rule exists to prevent.
   */
  it("does not merge two different authority refs that concatenate alike", () => {
    const resolution = resolveWorkIdentities(
      [
        candidate("alpha", "a1", [{ authority: "a", id: "bc" }]),
        candidate("beta", "b1", [{ authority: "ab", id: "c" }])
      ],
      precedence
    );
    expect(resolution.identities).toHaveLength(2);
  });

  /*
   * WHAT THIS CATCHES: a canonical choice that depends on arrival order. The
   * same three candidates are resolved in two different orders and must produce
   * byte-identical output, because a catalog whose canonical titles change
   * between runs makes a diff between two ingestion passes meaningless.
   */
  it("is order-independent", () => {
    const one = candidate("gamma", "c1", [{ authority: "imdb", id: "tt1" }]);
    const two = candidate("alpha", "a1", [{ authority: "imdb", id: "tt1" }]);
    const three = candidate("beta", "b9");

    const forwards = resolveWorkIdentities([one, two, three], precedence);
    const backwards = resolveWorkIdentities([three, two, one], precedence);

    expect(forwards).toEqual(backwards);
    expect(forwards.identities[0]?.canonicalId).toBe("alpha-a1");
  });

  /*
   * WHAT THIS CATCHES: an undeclared source being appended to the end of the
   * precedence list instead of refused. `Array.prototype.indexOf` answers -1 for
   * a missing entry, so an implementation that ranked by `indexOf` without the
   * membership check would rank an UNKNOWN source ABOVE every declared one --
   * making a source nobody configured the canonical one.
   */
  it("refuses a record from a source with no declared precedence", () => {
    const resolution = resolveWorkIdentities(
      [candidate("alpha", "a1"), candidate("unlisted", "u1")],
      precedence
    );
    expect(resolution.identities.map((identity) => identity.canonicalId)).toEqual(["alpha-a1"]);
    expect(resolution.refused).toEqual([
      { contentId: "unlisted-u1", reason: "source_precedence_not_declared" }
    ]);
  });
});
