import { describe, expect, it } from "vitest";
import type {
  CatalogItem,
  EpisodeCatalogItem,
  MovieCatalogItem,
  SeriesCatalogItem
} from "@liberty/contracts/domains/catalog";
import { NonDeploymentEnvironment } from "../api/deployment-environment";
import {
  BROWSABLE_KINDS,
  BROWSE_SORT_LABEL,
  DEFAULT_BROWSE_SORT,
  browseItemsForRequest,
  readBrowseSortParam,
  type BrowseSortKey,
  KIND_LOCKED_PATHS,
  MOVIES_PATH,
  TV_PATH,
  BROWSE_GENRE_MAX_LENGTH,
  UNFILTERED,
  browseCatalog,
  buildBrowseHref,
  describeBrowseState,
  getBrowseItems,
  loadBrowseCatalog,
  readBrowseFilters,
  readBrowseGenreParam,
  readBrowseKindParam,
  type BrowseFilters
} from "./browse";

const NOW = new Date("2026-10-11T00:00:00.000Z");
const ISO = NOW.toISOString();

/**
 * This process's own classification, minted once at import -- the arrangement
 * `search.test.ts` documents. The granting case is the classification this
 * process really holds, and the refusing case is `null`, which is what a
 * deployment receives. Nothing here names an environment.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

const TEST_RUNTIME: NonDeploymentEnvironment = classifiedProcess();

/*
 * Per-kind builders, for the reason the catalog and search suites use them:
 * `CatalogItem` is a discriminated union, so one builder with a `Partial`
 * override bag can construct items the contract rejects.
 */
type Overrides<T> = Partial<Omit<T, "kind">> & { id: string };

const movie = (over: Overrides<MovieCatalogItem>): MovieCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  ...over,
  kind: "movie"
});

const series = (over: Overrides<SeriesCatalogItem>): SeriesCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: null,
  episodeCount: 6,
  ...over,
  kind: "series"
});

const episode = (over: Overrides<EpisodeCatalogItem>): EpisodeCatalogItem => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 47,
  episodeCount: null,
  ...over,
  kind: "episode"
});

const filters = (over: Partial<BrowseFilters> = {}): BrowseFilters => ({ ...UNFILTERED, ...over });
const ids = (response: { items: readonly CatalogItem[] }): string[] =>
  response.items.map((item) => item.id);

describe("browseCatalog", () => {
  it("lists the browsable kinds and nothing else", () => {
    const response = browseCatalog(
      [movie({ id: "m" }), series({ id: "s" }), episode({ id: "e" })],
      filters(),
      ISO
    );
    /* An episode has no standalone destination, so a card for one cannot be
     * opened -- the rule home and search already apply. */
    expect(ids(response)).toEqual(["m", "s"]);
    expect(BROWSABLE_KINDS).not.toContain("episode");
  });

  it("orders newest first, then title, then id, with no dependence on input order", () => {
    const items = [
      movie({ id: "c", title: "Beta", releaseYear: 2020 }),
      movie({ id: "a", title: "Alpha", releaseYear: 2024 }),
      movie({ id: "b", title: "Alpha", releaseYear: 2020 })
    ];
    const forwards = ids(browseCatalog(items, filters(), ISO));
    const backwards = ids(browseCatalog([...items].reverse(), filters(), ISO));
    expect(forwards).toEqual(["a", "b", "c"]);
    expect(backwards).toEqual(forwards);
  });

  it("breaks a full tie on id, so the sort can never fall back on arrival order", () => {
    const items = [
      movie({ id: "z", title: "Same", releaseYear: 2024 }),
      movie({ id: "y", title: "Same", releaseYear: 2024 })
    ];
    expect(ids(browseCatalog(items, filters(), ISO))).toEqual(["y", "z"]);
    expect(ids(browseCatalog([...items].reverse(), filters(), ISO))).toEqual(["y", "z"]);
  });

  it("compares titles by code point rather than by the host's collation", () => {
    /*
     * "Z" (U+005A) sorts before "a" (U+0061) by code point, and AFTER it under
     * every common locale collation. Asserting the code-point answer is what
     * pins this sort to `localeCompare` never coming back -- the defect already
     * removed from candidate ranking in @liberty/media-engine and from search's
     * result sort.
     */
    const items = [movie({ id: "lower", title: "apple" }), movie({ id: "upper", title: "Zebra" })];
    expect(ids(browseCatalog(items, filters(), ISO))).toEqual(["upper", "lower"]);
  });

  it("narrows to one kind", () => {
    const items = [movie({ id: "m" }), series({ id: "s" })];
    expect(ids(browseCatalog(items, filters({ kind: "movie" }), ISO))).toEqual(["m"]);
    expect(ids(browseCatalog(items, filters({ kind: "series" }), ISO))).toEqual(["s"]);
  });

  it("narrows to one genre, case-insensitively, because a shared link may be typed", () => {
    const items = [
      movie({ id: "drama", genre: "Drama" }),
      movie({ id: "scifi", genre: "Science fiction" })
    ];
    expect(ids(browseCatalog(items, filters({ genre: "drama" }), ISO))).toEqual(["drama"]);
    expect(ids(browseCatalog(items, filters({ genre: "DRAMA" }), ISO))).toEqual(["drama"]);
  });

  it("matches a genre exactly and not as a substring", () => {
    /* `includes` here would make "fiction" select "Science fiction", so a
     * facet the viewer never saw would appear to work and the page would
     * describe a genre the catalog does not have. */
    const items = [movie({ id: "scifi", genre: "Science fiction" })];
    expect(ids(browseCatalog(items, filters({ genre: "fiction" }), ISO))).toEqual([]);
    expect(ids(browseCatalog(items, filters({ genre: "Science fiction" }), ISO))).toEqual(["scifi"]);
  });

  describe("the genre facets", () => {
    it("are counted from the items that survived the gates, not from the input", () => {
      /*
       * THE CAST IS NECESSARY AND IT IS THE POINT. `contentRightsSchema` admits
       * only the three playable values today, so a schema-valid `CatalogItem`
       * is always surfaceable and the union cannot express the item this test
       * needs. The ordering being asserted -- gate first, count second -- is
       * nonetheless load-bearing: it is what stops a record the catalog has
       * declined to surface from contributing its genre NAME to a control the
       * viewer reads, which would disclose that something of that kind exists
       * while refusing to show it. Stating it here keeps the property pinned
       * against the rights vocabulary being widened later, which is the only
       * way this can regress.
       */
      const withheld = { ...movie({ id: "withheld", genre: "Withheld genre" }), rights: "secret" };
      const response = browseCatalog(
        [movie({ id: "shown", genre: "Drama" }), withheld as unknown as CatalogItem],
        filters(),
        ISO
      );
      expect(ids(response)).toEqual(["shown"]);
      expect(response.genres.map((facet) => facet.genre)).toEqual(["Drama"]);
    });

    it("never offer a genre whose only titles are the kind the viewer filtered out", () => {
      const items = [movie({ id: "m", genre: "Documentary" }), series({ id: "s", genre: "Drama" })];
      const asSeries = browseCatalog(items, filters({ kind: "series" }), ISO);
      expect(asSeries.genres.map((facet) => facet.genre)).toEqual(["Drama"]);
    });

    it("still offer every other genre while one is selected", () => {
      /* A facet list narrowed by the CURRENT genre would collapse to one entry
       * and the viewer could never pick another. */
      const items = [movie({ id: "a", genre: "Drama" }), movie({ id: "b", genre: "Comedy" })];
      const response = browseCatalog(items, filters({ genre: "Drama" }), ISO);
      expect(ids(response)).toEqual(["a"]);
      expect(response.genres.map((facet) => facet.genre)).toEqual(["Comedy", "Drama"]);
    });

    it("lead with the commonest, then by name in code point order", () => {
      const items = [
        movie({ id: "1", genre: "Drama" }),
        movie({ id: "2", genre: "Drama" }),
        movie({ id: "3", genre: "Comedy" }),
        movie({ id: "4", genre: "Western" })
      ];
      const response = browseCatalog(items, filters(), ISO);
      expect(response.genres).toEqual([
        { genre: "Drama", count: 2 },
        { genre: "Comedy", count: 1 },
        { genre: "Western", count: 1 }
      ]);
    });
  });

  it("echoes the filters it was given, so the page cannot describe a different view", () => {
    const asked = filters({ kind: "series", genre: "Drama" });
    expect(browseCatalog([], asked, ISO).filters).toEqual(asked);
  });
});

describe("reading the filters out of a URL", () => {
  it("takes the first value of a repeated parameter rather than joining them", () => {
    /* Joining would let a crafted link build a filter the viewer never chose. */
    expect(readBrowseKindParam(["series", "movie"])).toBe("series");
    expect(readBrowseGenreParam(["Drama", "Comedy"])).toBe("Drama");
  });

  it("falls back to unfiltered for anything it does not recognise", () => {
    for (const value of ["", "   ", "episode", "MOVIE", "all;drop", undefined, []]) {
      expect(readBrowseKindParam(value as string | string[] | undefined)).toBe("all");
    }
  });

  it("treats an absent, empty or over-long genre as every genre", () => {
    expect(readBrowseGenreParam(undefined)).toBeNull();
    expect(readBrowseGenreParam("")).toBeNull();
    expect(readBrowseGenreParam("   ")).toBeNull();
    expect(readBrowseGenreParam("x".repeat(BROWSE_GENRE_MAX_LENGTH))).toBe(
      "x".repeat(BROWSE_GENRE_MAX_LENGTH)
    );
    expect(readBrowseGenreParam("x".repeat(BROWSE_GENRE_MAX_LENGTH + 1))).toBeNull();
  });

  it("trims a genre, because a trailing space in a shared link is not a different genre", () => {
    expect(readBrowseGenreParam("  Drama ")).toBe("Drama");
  });

  it("reads both filters from one params object", () => {
    expect(readBrowseFilters({ kind: "movie", genre: "Drama" })).toEqual(
      filters({ kind: "movie", genre: "Drama" })
    );
    expect(readBrowseFilters({})).toEqual(UNFILTERED);
  });
});

describe("buildBrowseHref", () => {
  it("omits defaults, so the unfiltered page has one address", () => {
    expect(buildBrowseHref(UNFILTERED)).toBe("/browse");
  });

  it("percent-encodes a genre rather than letting it change the query", () => {
    expect(buildBrowseHref(filters({ genre: "Science fiction" }))).toBe(
      "/browse?genre=Science%20fiction"
    );
    expect(buildBrowseHref(filters({ genre: "a&kind=series" }))).toBe(
      "/browse?genre=a%26kind%3Dseries"
    );
  });

  it("carries both filters when both are set", () => {
    expect(buildBrowseHref(filters({ kind: "series", genre: "Drama" }))).toBe(
      "/browse?kind=series&genre=Drama"
    );
  });

  it("round-trips through the readers", () => {
    const asked = filters({ kind: "series", genre: "Science fiction" });
    const url = new URL(buildBrowseHref(asked), "https://example.invalid");
    expect(
      readBrowseFilters({
        kind: url.searchParams.get("kind") ?? undefined,
        genre: url.searchParams.get("genre") ?? undefined
      })
    ).toEqual(asked);
  });
});

describe("the routes whose path fixes the kind", () => {
  it("pairs each locked route with its kind, once", () => {
    expect([...KIND_LOCKED_PATHS.entries()]).toEqual([
      ["/movies", "movie"],
      ["/tv", "series"]
    ]);
  });

  it("lets the path win over the query, so a stale link cannot contradict the heading", () => {
    /* `/movies?kind=series` is a stale link or somebody poking at the surface.
     * Honouring it would serve series under a path and a heading that both say
     * films. */
    expect(readBrowseFilters({ kind: "series" }, "movie")).toEqual(filters({ kind: "movie" }));
    expect(readBrowseFilters({ kind: "movie" }, "series")).toEqual(filters({ kind: "series" }));
  });

  it("still reads the genre on a locked route", () => {
    expect(readBrowseFilters({ kind: "series", genre: "Drama" }, "movie")).toEqual(
      filters({ kind: "movie", genre: "Drama" })
    );
  });

  it("leaves /browse choosing for itself", () => {
    expect(readBrowseFilters({ kind: "series" })).toEqual(filters({ kind: "series" }));
  });

  it("does not repeat a locked kind in the query it builds", () => {
    /* Two sources of truth for one filter is a shareable link that can
     * contradict its own path. */
    expect(buildBrowseHref(filters({ kind: "movie" }), MOVIES_PATH)).toBe("/movies");
    expect(buildBrowseHref(filters({ kind: "movie", genre: "Drama" }), MOVIES_PATH)).toBe(
      "/movies?genre=Drama"
    );
    expect(buildBrowseHref(filters({ kind: "series" }), TV_PATH)).toBe("/tv");
  });

  it("still emits a kind that the route does NOT fix", () => {
    expect(buildBrowseHref(filters({ kind: "series" }), MOVIES_PATH)).toBe("/movies?kind=series");
  });

  it("is unchanged for /browse", () => {
    expect(buildBrowseHref(filters({ kind: "movie" }))).toBe("/browse?kind=movie");
    expect(buildBrowseHref(UNFILTERED)).toBe("/browse");
  });

  it("round-trips a locked route's own address back to the same filters", () => {
    const asked = filters({ kind: "series", genre: "Science fiction" });
    const url = new URL(buildBrowseHref(asked, TV_PATH), "https://example.invalid");
    expect(url.pathname).toBe(TV_PATH);
    expect(
      readBrowseFilters({ genre: url.searchParams.get("genre") ?? undefined }, "series")
    ).toEqual(asked);
  });
});

describe("loadBrowseCatalog", () => {
  it("reports a missing metadata source as a configuration state, not an empty catalog", async () => {
    const result = await loadBrowseCatalog(filters(), () => null, NOW);
    expect(result).toEqual({ status: "error", reason: "catalog_source_not_configured" });
  });

  it("converts a throwing source instead of propagating it mid-render", async () => {
    const result = await loadBrowseCatalog(
      filters(),
      () => {
        throw new Error("provider exploded");
      },
      NOW
    );
    expect(result).toEqual({ status: "error", reason: "browse_source_unavailable" });
  });

  it("says the catalog is empty when nothing browsable is in it", async () => {
    const result = await loadBrowseCatalog(filters(), () => [episode({ id: "e" })], NOW);
    expect(result).toMatchObject({ status: "empty", cause: "catalog_has_no_browsable_titles" });
  });

  it("says the filters matched nothing when something else would have matched", async () => {
    const result = await loadBrowseCatalog(
      filters({ genre: "Western" }),
      () => [movie({ id: "m", genre: "Drama" })],
      NOW
    );
    expect(result).toMatchObject({ status: "empty", cause: "filters_match_nothing" });
    /* The facet list survives the empty state, so the page can offer a way out
     * rather than being a dead end. */
    if (result.status === "empty") {
      expect(result.genres.map((facet) => facet.genre)).toEqual(["Drama"]);
    }
  });

  it("says the filters matched nothing when only the other kind has titles", async () => {
    const result = await loadBrowseCatalog(
      filters({ kind: "series" }),
      () => [movie({ id: "m" })],
      NOW
    );
    expect(result).toMatchObject({ status: "empty", cause: "filters_match_nothing" });
  });

  it("does not infer the cause from the length of the filtered array", async () => {
    /* Both empty states produce an empty array; only the facet list and the
     * kind filter distinguish them, which is what these two cases assert
     * together. */
    const noCatalog = await loadBrowseCatalog(filters(), () => [], NOW);
    const noMatch = await loadBrowseCatalog(
      filters({ genre: "Nothing" }),
      () => [movie({ id: "m", genre: "Drama" })],
      NOW
    );
    expect(noCatalog).toMatchObject({ cause: "catalog_has_no_browsable_titles" });
    expect(noMatch).toMatchObject({ cause: "filters_match_nothing" });
  });

  it("answers ok with the response when there is something to show", async () => {
    const result = await loadBrowseCatalog(filters(), () => [movie({ id: "m" })], NOW);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(ids(result.response)).toEqual(["m"]);
      expect(result.response.generatedAt).toBe(ISO);
    }
  });

  it("states the time it was given rather than reading the clock", async () => {
    const result = await loadBrowseCatalog(filters(), () => [], NOW);
    if (result.status === "empty") expect(result.generatedAt).toBe(ISO);
  });
});

describe("getBrowseItems", () => {
  it("refuses with null when the process holds no non-deployment capability", async () => {
    /* `null` is exactly what a deployment receives from the mint. */
    await expect(getBrowseItems(null)).resolves.toBeNull();
  });

  it("reads the configured catalog when this process is classified", async () => {
    const items = await getBrowseItems(TEST_RUNTIME);
    expect(items).not.toBeNull();
    /* Every item that reaches this surface is already rights-cleared and has a
     * declared basis, because `selectDeclaredItems` ran inside. */
    for (const item of items ?? []) expect(["licensed", "owned", "public-domain"]).toContain(item.rights);
  });

  it("goes through the same gates the home rails do, end to end", async () => {
    const items = (await getBrowseItems(TEST_RUNTIME)) ?? [];
    const response = browseCatalog(items, UNFILTERED, ISO);
    expect(response.items.length).toBeGreaterThan(0);
    expect(response.genres.length).toBeGreaterThan(0);
    for (const item of response.items) expect(BROWSABLE_KINDS).toContain(item.kind);
  });
});

describe("describeBrowseState", () => {
  it("has a sentence for every state", () => {
    expect(describeBrowseState({ status: "error", reason: "whatever" })).toBe(
      "The catalog is currently unavailable."
    );
    expect(
      describeBrowseState({
        status: "empty",
        filters: UNFILTERED,
        genres: [],
        cause: "catalog_has_no_browsable_titles",
        generatedAt: ISO
      })
    ).toBe("There are no titles in the catalog yet.");
    expect(
      describeBrowseState({
        status: "empty",
        filters: filters({ genre: "Western" }),
        genres: [{ genre: "Drama", count: 1 }],
        cause: "filters_match_nothing",
        generatedAt: ISO
      })
    ).toBe("No titles match these filters.");
  });

  it("names what the viewer is looking at, in the right number", () => {
    const sentence = (items: CatalogItem[], f: BrowseFilters) =>
      describeBrowseState({ status: "ok", response: browseCatalog(items, f, ISO) });

    expect(sentence([movie({ id: "a" })], filters())).toBe("1 title.");
    expect(sentence([movie({ id: "a" }), series({ id: "b" })], filters())).toBe("2 titles.");
    expect(sentence([movie({ id: "a" })], filters({ kind: "movie" }))).toBe("1 film.");
    expect(sentence([movie({ id: "a" }), movie({ id: "b" })], filters({ kind: "movie" }))).toBe(
      "2 films."
    );
  });

  it("does not pluralise series into nonsense", () => {
    /* A suffix rule would have produced "2 seriess", and the fix for that is a
     * table rather than a special case bolted onto a concatenation. */
    const response = browseCatalog(
      [series({ id: "a" }), series({ id: "b" })],
      filters({ kind: "series" }),
      ISO
    );
    expect(describeBrowseState({ status: "ok", response })).toBe("2 series.");
  });

  it("names the genre when one is selected", () => {
    const response = browseCatalog(
      [movie({ id: "a", genre: "Drama" })],
      filters({ kind: "movie", genre: "Drama" }),
      ISO
    );
    expect(describeBrowseState({ status: "ok", response })).toBe("1 film in Drama.");
  });
});

describe("browse sort order (Wave 132)", () => {
  /*
   * THE DEFECT CLASS THESE PIN: one hard-coded order presented as the only
   * order, and -- once there is more than one -- an order that is not total.
   *
   * A sort whose comparator can return 0 for two distinct items falls back on
   * the order the catalog arrived in, and the metadata port promises nothing
   * about that order. So every case below asserts the FULL list rather than a
   * leading element, and the determinism case feeds the same catalog in
   * several arrangements.
   */
  const catalog: CatalogItem[] = [
    movie({ id: "b-old", title: "Blade", releaseYear: 1998 }),
    movie({ id: "a-new", title: "Aurora", releaseYear: 2024 }),
    series({ id: "z-mid", title: "Zenith", releaseYear: 2010 }),
    movie({ id: "a-dup-2", title: "Aurora", releaseYear: 2024 })
  ];

  it("defaults to the order this surface has always had", () => {
    expect(DEFAULT_BROWSE_SORT).toBe("newest");
    /* Newest, then title by code point, then id. Byte-for-byte the previous
     * comparator, so an existing link describes the same page. */
    expect(ids(browseCatalog(catalog, UNFILTERED, ISO))).toEqual([
      "a-dup-2",
      "a-new",
      "z-mid",
      "b-old"
    ]);
  });

  it("orders oldest first without reversing the tie-break", () => {
    expect(ids(browseCatalog(catalog, filters({ sort: "oldest" }), ISO))).toEqual([
      "b-old",
      "z-mid",
      "a-dup-2",
      "a-new"
    ]);
  });

  it("orders A-Z and Z-A by title, with id still ascending in both", () => {
    /*
     * `title-desc` REVERSES ONLY THE TITLE. Negating the whole comparator would
     * also reverse `id`, so two items with the identical title would swap -- the
     * pair's relative order would then be a property of which button was
     * pressed rather than of the data.
     */
    expect(ids(browseCatalog(catalog, filters({ sort: "title" }), ISO))).toEqual([
      "a-dup-2",
      "a-new",
      "b-old",
      "z-mid"
    ]);
    expect(ids(browseCatalog(catalog, filters({ sort: "title-desc" }), ISO))).toEqual([
      "z-mid",
      "b-old",
      "a-dup-2",
      "a-new"
    ]);
  });

  it("orders titles by CODE POINT, never by the host's collation", () => {
    /*
     * `localeCompare` without an explicit locale uses the host's collation: in a
     * Swedish collation "ä" sorts after "z", in most others beside "a". An
     * A-Z that is a different A-Z per server is not a sort a reader can use, and
     * this repository has already removed the defect from candidate ranking and
     * from search's result sort.
     */
    const accented: CatalogItem[] = [
      movie({ id: "1", title: "Zebra" }),
      movie({ id: "2", title: "Älv" }),
      movie({ id: "3", title: "Apple" })
    ];
    expect(ids(browseCatalog(accented, filters({ sort: "title" }), ISO))).toEqual(["3", "1", "2"]);
  });

  it("is total: every order is unchanged by the order the catalog arrived in", () => {
    for (const sort of Object.keys(BROWSE_SORT_LABEL) as BrowseSortKey[]) {
      const expected = ids(browseCatalog(catalog, filters({ sort }), ISO));
      expect(ids(browseCatalog([...catalog].reverse(), filters({ sort }), ISO)), sort).toEqual(
        expected
      );
      for (let shift = 1; shift < catalog.length; shift += 1) {
        const rotated = [...catalog.slice(shift), ...catalog.slice(0, shift)];
        expect(ids(browseCatalog(rotated, filters({ sort }), ISO)), `${sort}+${shift}`).toEqual(
          expected
        );
      }
    }
  });

  it("sorts last, so no order can admit an item or change a facet", () => {
    /* Ordering cannot weaken a gate. The same population and the same facets
     * come back whichever order is asked for. */
    const refused = [
      ...catalog,
      { ...movie({ id: "refused", title: "Aaaa" }), rights: "unreviewed" as never }
    ];
    const asc = browseCatalog(refused, filters({ sort: "title" }), ISO);
    const desc = browseCatalog(refused, filters({ sort: "title-desc" }), ISO);
    expect(asc.items.length).toBe(4);
    expect([...ids(asc)].sort()).toEqual([...ids(desc)].sort());
    expect(asc.genres).toEqual(desc.genres);
    expect(ids(asc)).not.toContain("refused");
  });

  it("survives a sort key TypeScript never checked", () => {
    /*
     * `BrowseFilters` is a plain object, so a caller that built one from parsed
     * JSON or a stored preference has a `sort` the type system never saw. An
     * unknown key must order the page, not throw mid-render.
     */
    const smuggled = { ...UNFILTERED, sort: "by-vibes" as unknown as BrowseSortKey };
    expect(ids(browseCatalog(catalog, smuggled, ISO))).toEqual(
      ids(browseCatalog(catalog, UNFILTERED, ISO))
    );
  });
});

describe("readBrowseSortParam and the sort in an address", () => {
  it("takes the first value and ignores anything unrecognised", () => {
    expect(readBrowseSortParam("oldest")).toBe("oldest");
    expect(readBrowseSortParam(" title ")).toBe("title");
    expect(readBrowseSortParam(["title-desc", "oldest"])).toBe("title-desc");
    /* A typo, a probe or a stale link from a version with more orders. */
    expect(readBrowseSortParam("by-vibes")).toBe(DEFAULT_BROWSE_SORT);
    expect(readBrowseSortParam("")).toBe(DEFAULT_BROWSE_SORT);
    expect(readBrowseSortParam(undefined)).toBe(DEFAULT_BROWSE_SORT);
    expect(readBrowseSortParam([])).toBe(DEFAULT_BROWSE_SORT);
  });

  it("is not locked by a kind-locked route, because no path states an order", () => {
    expect(readBrowseFilters({ kind: "series", sort: "title" }, "movie")).toEqual(
      filters({ kind: "movie", sort: "title" })
    );
  });

  it("omits the default order from the address and round-trips the rest", () => {
    expect(buildBrowseHref(UNFILTERED)).toBe("/browse");
    expect(buildBrowseHref(filters({ sort: "newest" }))).toBe("/browse");
    expect(buildBrowseHref(filters({ sort: "title-desc" }))).toBe("/browse?sort=title-desc");
    expect(buildBrowseHref(filters({ genre: "Drama", sort: "oldest" }))).toBe(
      "/browse?genre=Drama&sort=oldest"
    );
    expect(buildBrowseHref(filters({ kind: "movie", sort: "title" }), MOVIES_PATH)).toBe(
      "/movies?sort=title"
    );

    for (const sort of Object.keys(BROWSE_SORT_LABEL) as BrowseSortKey[]) {
      const asked = filters({ genre: "Science fiction", sort });
      const url = new URL(buildBrowseHref(asked), "https://example.invalid");
      expect(
        readBrowseFilters({
          genre: url.searchParams.get("genre") ?? undefined,
          sort: url.searchParams.get("sort") ?? undefined
        }),
        sort
      ).toEqual(asked);
    }
  });
});

describe("describeBrowseState names a non-default order", () => {
  const two = [movie({ id: "a", title: "A" }), movie({ id: "b", title: "B" })];
  const sentence = (sort: BrowseSortKey): string =>
    describeBrowseState({
      status: "ok",
      response: browseCatalog(two, filters({ sort }), ISO)
    });

  it("says nothing about the default order, which the reader already assumed", () => {
    expect(sentence("newest")).toBe("2 titles.");
  });

  it("names any other order, because a chosen order has to be confirmed", () => {
    expect(sentence("oldest")).toBe("2 titles, oldest first.");
    expect(sentence("title")).toBe("2 titles, A–Z by title.");
    expect(sentence("title-desc")).toBe("2 titles, Z–A by title.");
  });

  it("keeps the genre clause ahead of the order clause", () => {
    expect(
      describeBrowseState({
        status: "ok",
        response: browseCatalog(two, filters({ genre: "Drama", sort: "oldest" }), ISO)
      })
    ).toBe("2 titles in Drama, oldest first.");
  });
});

describe("the request-scoped catalog memo (Wave 132)", () => {
  /*
   * MEASURED RATHER THAN ASSUMED, which was this wave's instruction. A cache
   * with no counter is a cache nobody can show is working -- or show has
   * stopped working when a later refactor accidentally builds a fresh memo per
   * call.
   *
   * `browseItemsForRequest` is `cache`d, which is request-scoped inside a Next
   * render and a PASS-THROUGH here: there is no React request scope in a vitest
   * `environment: "node"` suite. So the memo is held once and read twice, which
   * is what a single request does. The scope itself is React's and is not what
   * this asserts.
   */
  it("reads the metadata port once however many times the surface asks", async () => {
    const memo = browseItemsForRequest();
    const first = await memo.read();
    const second = await memo.read();
    expect(memo.stats()).toEqual({ sourceReads: 1, reuses: 1 });
    /* The identical answer, not merely an equal one: one read, one array. */
    expect(second).toBe(first);
  });

  it("shares one read between callers that arrive concurrently", async () => {
    /*
     * The case that makes this cache the PROMISE and not the value: two surfaces
     * rendering concurrently both arrive before either answer exists, so a
     * value cache would miss twice and read twice.
     */
    const memo = browseItemsForRequest();
    const [a, b] = await Promise.all([memo.read(), memo.read()]);
    expect(memo.stats().sourceReads).toBe(1);
    expect(a).toBe(b);
  });

  it("still answers through the loader, with the gates and the order unchanged", async () => {
    const result = await loadBrowseCatalog(filters({ sort: "title" }));
    expect(result.status).not.toBe("error");
    if (result.status !== "ok") return;
    const titles = result.response.items.map((item) => item.title);
    expect([...titles]).toEqual(
      [...titles].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
    );
  });
});
