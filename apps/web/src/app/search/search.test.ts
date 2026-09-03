import { describe, expect, it } from "vitest";
import type {
  EpisodeCatalogItem,
  MovieCatalogItem,
  SeriesCatalogItem
} from "@liberty/contracts/domains/catalog";
import { SEARCH_QUERY_MAX_LENGTH, normalizeSearchQuery } from "@liberty/contracts/domains/search";
import {
  describeSearchState,
  getSearchResults,
  loadSearchResults,
  readSearchQueryParam,
  searchCatalog
} from "./search";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const ISO = NOW.toISOString();

/*
 * Per-kind builders, for the reason PL-0101's catalog tests use them:
 * `CatalogItem` is a discriminated union, so a single builder with a
 * `Partial<CatalogItem>` override bag can construct items the contract rejects.
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

const idsOf = (response: { results: ReadonlyArray<{ item: { id: string } }> }): string[] =>
  response.results.map((result) => result.item.id);

describe("normalizeSearchQuery", () => {
  it("collapses whitespace so equivalent URLs are the same search", () => {
    expect(normalizeSearchQuery("  the   fall  ")).toBe("the fall");
    expect(normalizeSearchQuery("the\tfall")).toBe("the fall");
  });

  it("treats a whitespace-only query as empty", () => {
    expect(normalizeSearchQuery("    ")).toBe("");
  });

  it("truncates rather than rejects an over-long query", () => {
    const long = "a".repeat(SEARCH_QUERY_MAX_LENGTH + 50);
    expect(normalizeSearchQuery(long)).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
  });

  it("is idempotent, so re-parsing our own response cannot change the query", () => {
    const once = normalizeSearchQuery(`  ${"b ".repeat(SEARCH_QUERY_MAX_LENGTH)}  `);
    expect(normalizeSearchQuery(once)).toBe(once);
  });
});

describe("readSearchQueryParam", () => {
  it("normalizes a single value", () => {
    expect(readSearchQueryParam("  Aurora  Fall ")).toBe("Aurora Fall");
  });

  it("takes the first value of a repeated parameter instead of joining them", () => {
    expect(readSearchQueryParam(["aurora", "; drop"])).toBe("aurora");
  });

  it("treats a missing or unusable parameter as an empty search", () => {
    expect(readSearchQueryParam(undefined)).toBe("");
    expect(readSearchQueryParam([])).toBe("");
    expect(readSearchQueryParam("   ")).toBe("");
  });

  it("resolves q=the+fall and q=the%20fall to the same search", () => {
    /*
     * The assumption the client's encoder choice rests on, written down.
     *
     * `buildSearchHref` percent-encodes with `encodeURIComponent`, so the
     * client path produces `q=the%20fall`. The no-JavaScript fallback lets the
     * browser submit the form itself, and a browser form GET is
     * `application/x-www-form-urlencoded`, so that path produces `q=the+fall`.
     * Two spellings of one search: if they ever stopped resolving to the same
     * query, a user without JavaScript would be running a different search from
     * the one the link they share resolves to, and nobody would think to look at
     * the encoding.
     *
     * Decoded here with `URLSearchParams`, which is the decoding a browser
     * applies to its own form submission and the one the framework applies
     * before `searchParams` reaches the page.
     */
    const fromFormSubmit = new URLSearchParams("q=the+fall").get("q") ?? "";
    const fromSharedLink = new URLSearchParams("q=the%20fall").get("q") ?? "";

    expect(fromFormSubmit).toBe("the fall");
    expect(fromSharedLink).toBe("the fall");
    expect(readSearchQueryParam(fromFormSubmit)).toBe(readSearchQueryParam(fromSharedLink));
    expect(readSearchQueryParam(fromFormSubmit)).toBe("the fall");
  });
});

describe("searchCatalog matching", () => {
  const catalog = [
    movie({ id: "aurora", title: "Aurora Fall", genre: "Sci-fi" }),
    movie({ id: "fall", title: "Fall", genre: "Drama" }),
    movie({ id: "nightfall", title: "Nightfall", genre: "Horror" }),
    series({ id: "quiet", title: "Quiet Harbour", genre: "Fall Drama" })
  ];

  it("classifies exact, prefix, substring and genre matches", () => {
    const response = searchCatalog(catalog, "fall", ISO);
    expect(response.results.map((result) => [result.item.id, result.matchedOn])).toEqual([
      ["fall", "title-exact"],
      ["aurora", "title-contains"],
      ["nightfall", "title-contains"],
      ["quiet", "genre-contains"]
    ]);
  });

  it("ranks an exact title above a prefix above a substring above a genre", () => {
    const response = searchCatalog(
      [
        movie({ id: "genre", title: "Unrelated", genre: "Falling" }),
        movie({ id: "contains", title: "Nightfall" }),
        movie({ id: "prefix", title: "Fallout" }),
        movie({ id: "exact", title: "Fall" })
      ],
      "fall",
      ISO
    );
    expect(idsOf(response)).toEqual(["exact", "prefix", "contains", "genre"]);
  });

  it("matches regardless of case on either side", () => {
    expect(idsOf(searchCatalog(catalog, "AURORA", ISO))).toEqual(["aurora"]);
    expect(idsOf(searchCatalog([movie({ id: "up", title: "UPPER" })], "upper", ISO))).toEqual([
      "up"
    ]);
  });

  it("treats the query as data, never as a pattern", () => {
    // A regex-flavoured query matches literally or not at all. If this ever
    // returns "any" the query has started being compiled instead of compared.
    const items = [movie({ id: "any", title: "Anything" }), movie({ id: "dot", title: "A.C" })];
    expect(idsOf(searchCatalog(items, ".*", ISO))).toEqual([]);
    expect(idsOf(searchCatalog(items, "a.c", ISO))).toEqual(["dot"]);
  });

  it("returns nothing for a query nothing matches", () => {
    expect(searchCatalog(catalog, "zzz", ISO).results).toEqual([]);
  });

  it("returns nothing for an empty query rather than the whole catalog", () => {
    expect(searchCatalog(catalog, "   ", ISO).results).toEqual([]);
  });

  it("echoes the normalized query, not the raw one", () => {
    expect(searchCatalog(catalog, "  AURORA  ", ISO).query).toBe("AURORA");
  });
});

describe("searchCatalog rights and kind boundary", () => {
  it("never surfaces an item off the rights allowlist", () => {
    const response = searchCatalog(
      [
        movie({ id: "ok", title: "Aurora Fall" }),
        movie({ id: "bad", title: "Aurora Fall", rights: "unlicensed" as never })
      ],
      "aurora",
      ISO
    );
    expect(idsOf(response)).toEqual(["ok"]);
  });

  it("never surfaces a standalone episode, which has nowhere to open", () => {
    const response = searchCatalog(
      [episode({ id: "ep", title: "Aurora Fall" }), movie({ id: "film", title: "Aurora Fall" })],
      "aurora",
      ISO
    );
    expect(idsOf(response)).toEqual(["film"]);
  });
});

describe("searchCatalog ordering determinism", () => {
  it("orders equal matches by release year descending", () => {
    const response = searchCatalog(
      [
        movie({ id: "old", title: "Fall One", releaseYear: 2019 }),
        movie({ id: "new", title: "Fall Two", releaseYear: 2025 })
      ],
      "fall",
      ISO
    );
    expect(idsOf(response)).toEqual(["new", "old"]);
  });

  it("orders equal-year titles by code point, not by host collation", () => {
    /*
     * "Nexus" before "apex": N is U+004E and a is U+0061. `localeCompare` in a
     * typical English locale orders these the other way round, and differently
     * again under other collations — which is exactly the non-determinism this
     * comparator exists to avoid. If this test ever flips, someone has
     * reintroduced a locale-dependent comparison.
     */
    const items = [movie({ id: "apex", title: "apex" }), movie({ id: "nexus", title: "Nexus" })];
    expect(idsOf(searchCatalog(items, "x", ISO))).toEqual(["nexus", "apex"]);
  });

  it("breaks a full tie on id so nothing depends on input order", () => {
    const forward = searchCatalog(
      [movie({ id: "b", title: "Fall" }), movie({ id: "a", title: "Fall" })],
      "fall",
      ISO
    );
    const reverse = searchCatalog(
      [movie({ id: "a", title: "Fall" }), movie({ id: "b", title: "Fall" })],
      "fall",
      ISO
    );
    expect(idsOf(forward)).toEqual(["a", "b"]);
    expect(idsOf(reverse)).toEqual(idsOf(forward));
  });

  it("produces the same response for the same catalog in any order", () => {
    const items = [
      movie({ id: "a", title: "Fall", releaseYear: 2021 }),
      movie({ id: "b", title: "Nightfall", releaseYear: 2021 }),
      series({ id: "c", title: "Fallout", genre: "Fall", releaseYear: 2024 })
    ];
    expect(searchCatalog([...items].reverse(), "fall", ISO)).toEqual(
      searchCatalog(items, "fall", ISO)
    );
  });
});

describe("getSearchResults against the demo fixtures", () => {
  it("finds a title by prefix", () => {
    const response = getSearchResults("aurora", NOW);
    expect(idsOf(response)).toEqual(["aurora-fall"]);
    expect(response.results[0]?.matchedOn).toBe("title-prefix");
    expect(response.generatedAt).toBe(ISO);
  });

  it("finds titles by genre", () => {
    const response = getSearchResults("drama", NOW);
    expect(idsOf(response)).toEqual(["northstar"]);
    expect(response.results[0]?.matchedOn).toBe("genre-contains");
  });
});

describe("loadSearchResults", () => {
  it("reports no query as idle, not as an empty result set", async () => {
    expect(await loadSearchResults("")).toEqual({ status: "idle" });
    expect(await loadSearchResults("   ")).toEqual({ status: "idle" });
  });

  it("distinguishes a query that matched nothing from a query that was never run", async () => {
    const result = await loadSearchResults("zzzz", (query) => getSearchResults(query, NOW));
    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.query).toBe("zzzz");
    expect(result.generatedAt).toBe(ISO);
  });

  it("returns validated results for a query that matched", async () => {
    const result = await loadSearchResults("aurora", (query) => getSearchResults(query, NOW));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(idsOf(result.response)).toEqual(["aurora-fall"]);
    expect(result.response.query).toBe("aurora");
  });

  it("reports a payload that violates the contract as an error, not as empty", async () => {
    const result = await loadSearchResults("aurora", () => ({
      query: "aurora",
      // Empty title violates the published contract.
      results: [{ item: movie({ id: "broken", title: "" }), matchedOn: "title-exact" }],
      generatedAt: ISO
    }));
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("search_response_failed_validation");
  });

  it("rejects a response computed for a query other than the one requested", async () => {
    /*
     * The contract publishes `query` so a client can tell a response apart from
     * one it no longer wants. Before this check the loader parsed it and then
     * believed it: the empty-state heading and the live-region sentence both
     * quote it, so a misrouted, coalesced or stale-cached response made the page
     * assert that nothing matched a search nobody ran. The schema cannot catch
     * this — the payload is perfectly well-formed, it is just somebody else's.
     */
    const result = await loadSearchResults("aurora", () => ({
      query: "northstar",
      results: [{ item: movie({ id: "northstar" }), matchedOn: "title-exact" }],
      generatedAt: ISO
    }));
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("search_response_query_mismatch");
  });

  it("checks identity before emptiness, so a mismatched empty body is not empty", async () => {
    // The order matters more than it looks: reversed, this response would render
    // "No titles match “northstar”" on a page the user searched "aurora" from,
    // which is the exact sentence the check exists to prevent.
    const result = await loadSearchResults("aurora", () => ({
      query: "northstar",
      results: [],
      generatedAt: ISO
    }));
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("search_response_query_mismatch");
  });

  it("does not mistake a differently spaced echo for a different query", async () => {
    // Both sides run through `normalizeSearchQuery` — the request here, the
    // echo via `searchQuerySchema` — so this compares meanings, not spellings.
    // Without that, every response would have to match byte for byte and the
    // check would fire on a whitespace difference that is not a difference.
    const result = await loadSearchResults("  the   fall  ", () => ({
      query: "the fall ",
      results: [],
      generatedAt: ISO
    }));
    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.query).toBe("the fall");
  });

  it("passes the in-process source, which cannot disagree with itself", async () => {
    // Why the check is unreachable today, stated rather than assumed: the
    // source computes the response from the query it was handed. It becomes
    // reachable the day `GET /api/v1/search` serves this shape over a network,
    // which is exactly when nobody would think to add it.
    const result = await loadSearchResults("  AURORA  ", (query) => getSearchResults(query, NOW));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.query).toBe("AURORA");
  });

  it("converts a throwing source into an error state", async () => {
    const result = await loadSearchResults("aurora", () => {
      throw new Error("index unreachable");
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("search_source_unavailable");
  });

  it("converts a rejecting async source into an error state", async () => {
    const result = await loadSearchResults("aurora", () => Promise.reject(new Error("timeout")));
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("search_source_unavailable");
  });
});

describe("describeSearchState", () => {
  it("says something in every state, including the two that render no results", async () => {
    expect(describeSearchState({ status: "idle" })).toBe("Type to search the catalog.");
    expect(describeSearchState({ status: "error", reason: "search_source_unavailable" })).toBe(
      "Search is currently unavailable."
    );
    expect(describeSearchState({ status: "empty", query: "zzzz", generatedAt: ISO })).toBe(
      "No titles match “zzzz”."
    );

    const one = await loadSearchResults("aurora", (query) => getSearchResults(query, NOW));
    expect(describeSearchState(one)).toBe("1 title matches “aurora”.");
  });

  it("pluralizes a multi-result announcement", () => {
    const response = searchCatalog(
      [movie({ id: "a", title: "Fall" }), movie({ id: "b", title: "Nightfall" })],
      "fall",
      ISO
    );
    expect(describeSearchState({ status: "ok", response })).toBe("2 titles match “fall”.");
  });
});
