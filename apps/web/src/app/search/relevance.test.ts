import { describe, expect, it } from "vitest";
import type { MovieCatalogItem } from "@liberty/contracts/domains/catalog";
import { SEARCH_MATCH_RANK, searchMatchKindSchema } from "@liberty/contracts/domains/search";
import {
  classifyFieldMatch,
  compareByRelevance,
  describeRelevance,
  foldSearchText,
  foldedTextComputations,
  foldedTextFor,
  foldedTextReuses,
  isWordStart,
  resetFoldedTextCounters,
  scoreCatalogItem,
  type SearchRelevance
} from "./relevance";

/* -------------------------------------------------------------------------
 * Tests for the relevance scorer (Wave 132, worker C).
 *
 * A PLAIN `.ts` SUITE AGAINST A PLAIN `.ts` MODULE, which is the arrangement
 * `apps/web/vitest.config.ts` forces: `environment: "node"`, no jsdom, no
 * app-router context. The scorer is where it is precisely so that it can be
 * tested at all -- the same reasoning that put `describeSearchState` and
 * `describeBrowseState` beside their loaders instead of inside their JSX.
 * ---------------------------------------------------------------------- */

type Overrides = Partial<Omit<MovieCatalogItem, "kind">> & { id: string };

/**
 * A per-kind builder, for the reason the browse, catalog and search suites all
 * use them: `CatalogItem` is a discriminated union, so a single builder with a
 * `Partial` override bag can construct items the contract rejects.
 */
const movie = (over: Overrides): MovieCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  ...over,
  kind: "movie"
});

/** The scorer's answer, or a readable failure rather than a null dereference. */
function score(item: MovieCatalogItem, query: string): SearchRelevance {
  const relevance = scoreCatalogItem(item, foldSearchText(query));
  if (relevance === null) throw new Error(`expected ${item.id} to match ${JSON.stringify(query)}`);
  return relevance;
}

describe("classifyFieldMatch", () => {
  it("separates exact, leading-edge, word-start and mid-word hits", () => {
    expect(classifyFieldMatch("the fall", "the fall")).toBe("exact");
    expect(classifyFieldMatch("the fall of aurora", "the fall")).toBe("prefix");
    expect(classifyFieldMatch("the fall of aurora", "fall")).toBe("word-prefix");
    expect(classifyFieldMatch("pitfalls", "fall")).toBe("substring");
  });

  it("matches nothing for an empty query, rather than matching everything", () => {
    /*
     * THE REGRESSION THIS PINS. `indexOf("")` is 0 for every string, so without
     * the guard every item would score a leading-edge hit and the idle state
     * would render as a full result set -- the exact defect `search.ts` keeps
     * `idle` and `empty` apart to avoid, arriving through the scorer.
     */
    expect(classifyFieldMatch("anything at all", "")).toBeNull();
    expect(classifyFieldMatch("", "")).toBeNull();
    expect(scoreCatalogItem(movie({ id: "a", title: "Anything" }), "")).toBeNull();
  });

  it("returns null when the query is not in the field at all", () => {
    expect(classifyFieldMatch("the fall of aurora", "zeppelin")).toBeNull();
  });

  it("finds the BEST occurrence, not the first", () => {
    /*
     * The defect this exists to stop: a scanner that returned on the first
     * `indexOf` hit would score this `substring` -- `fall` appears mid-word in
     * "Pitfall" at index 0..3 before it appears as a word at index 15 -- and so
     * would rank a genuine word-start title below a mid-word collision.
     */
    expect(classifyFieldMatch("pitfall of the fall", "fall")).toBe("word-prefix");
    /* And the reverse order, so the result does not depend on which came first. */
    expect(classifyFieldMatch("the fall of a pitfall", "fall")).toBe("word-prefix");
  });

  it("treats every kind of separator as a word boundary, not just a space", () => {
    for (const text of [
      "aurora-fall",
      "aurora:fall",
      "aurora fall",
      "aurora/fall",
      "aurora.fall",
      "aurora—fall",
      "aurora。fall",
      "aurora fall"
    ]) {
      expect(classifyFieldMatch(text, "fall"), text).toBe("word-prefix");
    }
  });

  it("does not treat a digit or a letter as a boundary", () => {
    expect(classifyFieldMatch("blade2fall", "fall")).toBe("substring");
    expect(classifyFieldMatch("xfall", "fall")).toBe("substring");
  });
});

describe("isWordStart, over unicode rather than over ASCII", () => {
  it("counts index 0 and refuses to read before the string", () => {
    expect(isWordStart("fall", 0)).toBe(true);
    expect(isWordStart("fall", -1)).toBe(true);
  });

  it("reads the preceding CODE POINT, not the preceding code unit", () => {
    /*
     * THE DEFECT CLASS: `text[index - 1]` on an astral character reads the LOW
     * HALF of a surrogate pair, which matches no word class, so a match sitting
     * immediately after an emoji or an astral letter was reported as a word
     * start for a reason that has nothing to do with the text.
     *
     * U+1D400 MATHEMATICAL BOLD CAPITAL A is a LETTER, so what follows it is
     * mid-word. U+1F600 GRINNING FACE is not, so what follows it is a word
     * start. A code-unit reader cannot tell these two apart -- both end in a low
     * surrogate.
     */
    const afterAstralLetter = `\u{1D400}fall`;
    expect(afterAstralLetter.indexOf("fall")).toBe(2);
    expect(isWordStart(afterAstralLetter, 2)).toBe(false);
    expect(classifyFieldMatch(afterAstralLetter, "fall")).toBe("substring");

    const afterEmoji = `\u{1F600}fall`;
    expect(isWordStart(afterEmoji, 2)).toBe(true);
    expect(classifyFieldMatch(afterEmoji, "fall")).toBe("word-prefix");
  });

  it("treats a combining mark as part of the word it attaches to", () => {
    /*
     * Decomposed "é" is "e" + U+0301. Without `\p{M}` in the word class the mark
     * reads as a separator, so "école" would appear to have a word boundary in
     * the middle of its first letter and `cole` would be promoted to a
     * word-start hit it has not earned.
     */
    const decomposed = "école";
    expect(decomposed.indexOf("cole")).toBe(2);
    expect(isWordStart(decomposed, 2)).toBe(false);
    expect(classifyFieldMatch(decomposed, "cole")).toBe("substring");
  });

  it("scores non-ASCII titles by the same rules as ASCII ones", () => {
    expect(classifyFieldMatch(foldSearchText("Les Chutes d'Aurore"), "aurore")).toBe("word-prefix");
    expect(classifyFieldMatch(foldSearchText("ÉCOLE"), "école")).toBe("exact");
    /* CJK has no spaces, so every interior hit is correctly a substring. */
    expect(classifyFieldMatch("秋の終り", "の終")).toBe("substring");
    expect(classifyFieldMatch("秋の終り", "秋")).toBe("prefix");
  });
});

describe("scoreCatalogItem", () => {
  const fall = movie({ id: "fall", title: "The Fall of Aurora", genre: "Drama" });

  it("ranks a title hit above a genre hit even when the genre hit is exact", () => {
    /*
     * "Title over other fields" as a NUMBER rather than as the order of two `if`
     * statements. A mid-word title collision still beats a perfect genre match,
     * which is the rule this wave was asked to make real.
     */
    const dramaByTitle = movie({ id: "t", title: "Melodramatic", genre: "Comedy" });
    const dramaByGenre = movie({ id: "g", title: "Zeppelin", genre: "Drama" });
    const byTitle = score(dramaByTitle, "drama");
    const byGenre = score(dramaByGenre, "drama");
    expect(byTitle.field).toBe("title");
    expect(byTitle.tier).toBe("substring");
    expect(byGenre.field).toBe("genre");
    expect(byGenre.tier).toBe("exact");
    expect(byTitle.score).toBeLessThan(byGenre.score);
  });

  it("takes the best field rather than the first field that matched", () => {
    /* `drama` is an exact genre hit and a word-start title hit; title wins. */
    const both = movie({ id: "both", title: "Drama School", genre: "Drama" });
    const relevance = score(both, "drama");
    expect(relevance.field).toBe("title");
    expect(relevance.tier).toBe("prefix");
  });

  it("orders the four title tiers strictly", () => {
    const tiers = [
      score(movie({ id: "1", title: "Fall" }), "fall"),
      score(fall, "the fall"),
      score(fall, "fall"),
      score(movie({ id: "4", title: "Pitfalls" }), "fall")
    ];
    expect(tiers.map((t) => t.tier)).toEqual(["exact", "prefix", "word-prefix", "substring"]);
    const scores = tiers.map((t) => t.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(new Set(scores).size).toBe(4);
  });

  it("is case-insensitive without being locale-sensitive", () => {
    expect(score(fall, "THE FALL OF AURORA").tier).toBe("exact");
    expect(score(fall, "tHe FaLl").tier).toBe("prefix");
    /*
     * `toLocaleLowerCase` under a Turkish locale maps "I" to a dotless "ı", so
     * this title would stop matching `titanic` on a machine configured that way.
     * The scorer folds with `toLowerCase`, so the fold is the identity function
     * on locale.
     */
    const titanic = movie({ id: "ti", title: "TITANIC" });
    expect(score(titanic, "titanic").tier).toBe("exact");
    expect(foldSearchText("TITANIC")).toBe("titanic");
  });

  it("publishes only labels the contract admits, and says where the mapping is lossy", () => {
    const labels = [
      score(movie({ id: "1", title: "Fall" }), "fall"),
      score(fall, "the fall"),
      score(fall, "fall"),
      score(movie({ id: "4", title: "Pitfalls" }), "fall"),
      score(movie({ id: "5", title: "Zeppelin", genre: "Drama" }), "drama")
    ];
    for (const relevance of labels) {
      expect(searchMatchKindSchema.safeParse(relevance.matchedOn).success).toBe(true);
      expect(SEARCH_MATCH_RANK[relevance.matchedOn]).toBeTypeOf("number");
    }
    expect(labels.map((l) => l.matchedOn)).toEqual([
      "title-exact",
      "title-prefix",
      /*
       * THE RECORDED LOSS. `word-prefix` and `substring` are different scores
       * and therefore different POSITIONS, but `SearchMatchKind` has no
       * `title-word-prefix` member and `packages/contracts` is read-only to this
       * change -- so they publish the same LABEL. The order is the finer truth;
       * the label is the contract's current resolution, and the contract change
       * is proposed in the wave report rather than made from here. If this
       * assertion ever fails because the enum grew that member, the mapping in
       * `contractLabel` is what to update.
       */
      "title-contains",
      "title-contains",
      "genre-contains"
    ]);
  });

  it("does not let the query act as a pattern", () => {
    /*
     * The query is DATA on this path -- `===`, `startsWith`, `indexOf` -- and
     * never a `RegExp` compiled from user input. A regex-backed scorer would
     * both change what these searches mean and open a ReDoS surface on a public
     * query parameter.
     */
    const dotted = movie({ id: "d", title: "A B" });
    expect(scoreCatalogItem(dotted, foldSearchText("a.b"))).toBeNull();
    expect(scoreCatalogItem(dotted, foldSearchText(".*"))).toBeNull();
    const literal = movie({ id: "l", title: "2 + 2 (a*)" });
    expect(score(literal, "a*").tier).toBe("word-prefix");
    expect(scoreCatalogItem(movie({ id: "n", title: "aaaaaaaa" }), foldSearchText("(a+)+$"))).toBeNull();
  });
});

describe("compareByRelevance", () => {
  const at = (item: MovieCatalogItem, query: string) => ({ item, relevance: score(item, query) });

  it("sorts by relevance first and the clock second", () => {
    /*
     * THE DEFECT THE TIER EXISTS TO REMOVE, pinned. Under the old classifier
     * both of these were `title-contains`, so the tie fell to release year and
     * the NEWER but worse match won. A word-start hit now wins outright.
     */
    const better = at(movie({ id: "better", title: "The Fall of Aurora", releaseYear: 1999 }), "fall");
    const worse = at(movie({ id: "worse", title: "Pitfalls", releaseYear: 2025 }), "fall");
    expect([worse, better].sort(compareByRelevance).map((r) => r.item.id)).toEqual([
      "better",
      "worse"
    ]);
  });

  it("breaks an exact relevance tie by newest, then title, then id", () => {
    const old = at(movie({ id: "c", title: "Fall", releaseYear: 1999 }), "fall");
    const recent = at(movie({ id: "b", title: "Fall", releaseYear: 2025 }), "fall");
    expect([old, recent].sort(compareByRelevance).map((r) => r.item.id)).toEqual(["b", "c"]);

    const zed = at(movie({ id: "a", title: "Fall", releaseYear: 2025 }), "fall");
    const alpha = at(movie({ id: "z", title: "Fall", releaseYear: 2025 }), "fall");
    /* Same score, same year, same title: `id` decides and nothing else can. */
    expect([alpha, zed].sort(compareByRelevance).map((r) => r.item.id)).toEqual(["a", "z"]);
  });

  it("is a total order: it never returns 0 for two distinct items", () => {
    /*
     * The property that makes the surface reproducible from the data alone. A
     * comparator that can return 0 falls back on the order the catalog arrived
     * in, and the catalog port promises nothing about that order.
     */
    const rows = ["a", "b", "c", "d"].map((id, index) =>
      at(movie({ id, title: index < 2 ? "Fall" : "Fall", releaseYear: 2025 }), "fall")
    );
    for (const left of rows) {
      for (const right of rows) {
        if (left.item.id === right.item.id) continue;
        expect(compareByRelevance(left, right), `${left.item.id} vs ${right.item.id}`).not.toBe(0);
        /* Antisymmetric, so the sort cannot depend on argument order. */
        expect(Math.sign(compareByRelevance(left, right))).toBe(
          -Math.sign(compareByRelevance(right, left))
        );
      }
    }
  });

  it("orders titles by CODE POINT, so two machines agree", () => {
    /*
     * `localeCompare` without an explicit locale uses the host's collation: in
     * several locales "á" ("á" decomposed) sorts beside "a", and in a
     * Swedish collation "ä" sorts after "z". Code-point order is the same
     * everywhere, which is the property this surface needs and the reason this
     * repository has removed `localeCompare` from ordering twice already.
     */
    const plain = at(movie({ id: "1", title: "Fall a", releaseYear: 2025 }), "fall");
    const accented = at(movie({ id: "2", title: "Fall ä", releaseYear: 2025 }), "fall");
    const zed = at(movie({ id: "3", title: "Fall z", releaseYear: 2025 }), "fall");
    const ordered = [accented, zed, plain].sort(compareByRelevance).map((r) => r.item.title);
    expect(ordered).toEqual(["Fall a", "Fall z", "Fall ä"]);
  });

  it("produces the same list whatever order the catalog arrived in", () => {
    const rows = [
      at(movie({ id: "m1", title: "Fall", releaseYear: 2001 }), "fall"),
      at(movie({ id: "m2", title: "The Fall of Aurora", releaseYear: 2024 }), "fall"),
      at(movie({ id: "m3", title: "Pitfalls", releaseYear: 2030 }), "fall"),
      at(movie({ id: "m4", title: "Fallow", releaseYear: 2001 }), "fall"),
      at(movie({ id: "m5", title: "Zeppelin", genre: "Fallout" }), "fall")
    ];
    const expected = [...rows].sort(compareByRelevance).map((r) => r.item.id);
    expect(expected).toEqual(["m1", "m4", "m2", "m3", "m5"]);
    /* Every rotation of the input produces the identical output. */
    for (let shift = 1; shift < rows.length; shift += 1) {
      const rotated = [...rows.slice(shift), ...rows.slice(0, shift)];
      expect(rotated.sort(compareByRelevance).map((r) => r.item.id)).toEqual(expected);
    }
    /* And so does the exact reverse. */
    expect([...rows].reverse().sort(compareByRelevance).map((r) => r.item.id)).toEqual(expected);
  });
});

describe("the folded-text memo, measured rather than assumed", () => {
  it("folds each item once and reuses it afterwards", () => {
    /*
     * MEASUREMENT, WHICH IS THE INSTRUCTION. A cache with no counter is a cache
     * nobody can show is working, so the module publishes both counters and this
     * asserts on the delta rather than on a feeling.
     *
     * WHAT THIS DOES AND DOES NOT PROVE, stated so the number is not over-read:
     * the memo is keyed on OBJECT IDENTITY, so it removes repeated folding of
     * the SAME item objects within one process -- which is what happens when a
     * surface scores the same in-process catalog for several queries. It does
     * NOT survive a re-read that constructs new objects, and
     * `selectDeclaredItems` validates and rebuilds records, so two separate
     * requests against a provider-backed source will fold again. That is the
     * honest limit and it is deliberate: identity keying cannot serve stale
     * text, which a TTL cache over `id` could.
     */
    const items = ["a", "b", "c"].map((id) => movie({ id, title: `Title ${id}` }));
    /* Prime: the counters must measure this test and not the suite above it. */
    for (const item of items) foldedTextFor(item);
    resetFoldedTextCounters();

    for (const item of items) foldedTextFor(item);
    expect(foldedTextComputations()).toBe(0);
    expect(foldedTextReuses()).toBe(3);

    /* Three more queries over the same objects add no folding work at all. */
    for (const query of ["title", "a", "zeppelin"]) {
      for (const item of items) scoreCatalogItem(item, query);
    }
    expect(foldedTextComputations()).toBe(0);
    expect(foldedTextReuses()).toBe(12);
  });

  it("recomputes for a freshly constructed item, so it can never serve stale text", () => {
    resetFoldedTextCounters();
    const first = movie({ id: "same-id", title: "Original" });
    expect(foldedTextFor(first).title).toBe("original");
    /* Same id, different object and different title: a re-read, not a repeat. */
    const second = movie({ id: "same-id", title: "Renamed" });
    expect(foldedTextFor(second).title).toBe("renamed");
    expect(foldedTextComputations()).toBe(2);
    expect(foldedTextReuses()).toBe(0);
  });
});

describe("describeRelevance", () => {
  it("names every tier distinctly, including the one the contract cannot label", () => {
    const sentences = (
      [
        { field: "title", tier: "exact" },
        { field: "title", tier: "prefix" },
        { field: "title", tier: "word-prefix" },
        { field: "title", tier: "substring" },
        { field: "genre", tier: "exact" },
        { field: "genre", tier: "substring" }
      ] as const
    ).map((partial) =>
      describeRelevance({ ...partial, score: 0, matchedOn: "title-exact" } as SearchRelevance)
    );
    expect(new Set(sentences).size).toBe(6);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0);
    /*
     * The two tiers that share a contract label get DIFFERENT sentences, which
     * is the point of deriving the copy from the tier instead of from
     * `matchedOn`: the reader is told the real reason even though the published
     * enum cannot carry it.
     */
    expect(sentences[2]).not.toBe(sentences[3]);
  });
});
