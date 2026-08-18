import { describe, expect, it } from "vitest";
import type {
  EpisodeCatalogItem,
  MovieCatalogItem,
  SeriesCatalogItem
} from "@liberty/contracts/domains/catalog";
import {
  appearsOnHome,
  buildHomeCatalog,
  formatCatalogMeta,
  formatRuntime,
  getHomeCatalog,
  isSurfaceable,
  loadHomeCatalog
} from "./catalog";
import { demoCatalog } from "./demo-catalog";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const ISO = NOW.toISOString();

/*
 * One builder per kind rather than one builder plus overrides.
 *
 * `CatalogItem` is a discriminated union, so `Partial<CatalogItem>` distributes
 * into a union of partials and stops being a usable override bag — and a single
 * builder could no longer produce a valid series without also being able to
 * produce an invalid movie. Per-kind builders make each override set exactly
 * the fields that kind allows, so a test cannot silently construct an item the
 * contract would reject.
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

describe("formatRuntime", () => {
  it("renders sub-hour runtimes without an hour component", () => {
    expect(formatRuntime(52)).toBe("52m");
  });

  it("zero-pads the minute component", () => {
    expect(formatRuntime(128)).toBe("2h 08m");
    expect(formatRuntime(114)).toBe("1h 54m");
  });

  it("renders exact hours", () => {
    expect(formatRuntime(120)).toBe("2h 00m");
  });
});

describe("formatCatalogMeta", () => {
  it("uses runtime for movies", () => {
    expect(formatCatalogMeta(movie({ id: "a", genre: "Sci-fi", runtimeMinutes: 128 })))
      .toBe("Sci-fi · 2h 08m");
  });

  it("uses episode count for series", () => {
    expect(formatCatalogMeta(series({ id: "b", genre: "Drama", episodeCount: 8 })))
      .toBe("Drama · 8 episodes");
  });

  it("uses runtime for an individual episode", () => {
    expect(formatCatalogMeta(episode({ id: "c", genre: "Mystery", runtimeMinutes: 47 })))
      .toBe("Mystery · 47m");
  });

  /*
   * There used to be a "falls back to genre alone when neither runtime nor
   * episodes are known" case here. That state is now unrepresentable: the
   * contract requires a runtime on movies and episodes and an episode count on
   * series, so the fallback it covered was dead code. Asserting every kind
   * renders a shape component is the invariant that replaced it.
   */
  it("always renders a shape component for every kind", () => {
    const rendered = [
      formatCatalogMeta(movie({ id: "m" })),
      formatCatalogMeta(series({ id: "s" })),
      formatCatalogMeta(episode({ id: "e" }))
    ];
    for (const meta of rendered) {
      expect(meta).toContain(" · ");
    }
  });
});

describe("rights boundary", () => {
  it("surfaces every allowlisted rights value", () => {
    for (const rights of ["licensed", "owned", "public-domain"] as const) {
      expect(isSurfaceable(movie({ id: rights, rights }))).toBe(true);
    }
  });

  it("refuses anything off the allowlist", () => {
    expect(isSurfaceable(movie({ id: "x", rights: "unlicensed" as never }))).toBe(false);
  });

  it("never places a non-surfaceable item on a rail", () => {
    const response = buildHomeCatalog(
      [movie({ id: "ok" }), movie({ id: "bad", rights: "unlicensed" as never })],
      ISO
    );
    const ids = response.rails.flatMap((rail) => rail.items.map((item) => item.id));
    expect(ids).toEqual(["ok"]);
  });
});

describe("buildHomeCatalog", () => {
  it("omits rails that have no surfaceable items", () => {
    const response = buildHomeCatalog([movie({ id: "only-a-movie" })], ISO);
    expect(response.rails.map((rail) => rail.id)).toEqual(["movies"]);
  });

  it("separates films and series onto their own rails", () => {
    const response = buildHomeCatalog([movie({ id: "m" }), series({ id: "s" })], ISO);
    expect(response.rails.map((rail) => rail.id)).toEqual(["movies", "series"]);
  });

  it("orders by release year descending, then title", () => {
    const response = buildHomeCatalog([
      movie({ id: "old", title: "Older", releaseYear: 2020 }),
      movie({ id: "new-b", title: "Beta", releaseYear: 2025 }),
      movie({ id: "new-a", title: "Alpha", releaseYear: 2025 })
    ], ISO);

    const movies = response.rails.find((rail) => rail.id === "movies");
    expect(movies?.items.map((item) => item.id)).toEqual(["new-a", "new-b", "old"]);
  });

  it("is deterministic and independent of input ordering", () => {
    const forward = buildHomeCatalog([movie({ id: "a" }), series({ id: "b" })], ISO);
    const reverse = buildHomeCatalog([series({ id: "b" }), movie({ id: "a" })], ISO);
    expect(reverse).toEqual(forward);
  });

  it("returns no rails for an empty catalog", () => {
    expect(buildHomeCatalog([], ISO).rails).toEqual([]);
  });
});

describe("loadHomeCatalog", () => {
  it("returns ok with validated rails for the demo fixtures", async () => {
    const result = await loadHomeCatalog(() => getHomeCatalog(NOW));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.rails.length).toBeGreaterThan(0);
    expect(result.response.generatedAt).toBe(ISO);
  });

  it("distinguishes empty from error", async () => {
    const result = await loadHomeCatalog(() => getHomeCatalog(NOW, []));
    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.generatedAt).toBe(ISO);
  });

  it("reports a validation failure as an error state, not an empty one", async () => {
    // Empty title violates the published contract.
    const result = await loadHomeCatalog(() =>
      getHomeCatalog(NOW, [movie({ id: "broken", title: "" })])
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("catalog_response_failed_validation");
  });

  it("converts a throwing source into an error state", async () => {
    const result = await loadHomeCatalog(() => {
      throw new Error("provider unreachable");
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("catalog_source_unavailable");
  });

  it("converts a rejecting async source into an error state", async () => {
    const result = await loadHomeCatalog(() => Promise.reject(new Error("timeout")));
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("catalog_source_unavailable");
  });

  it("surfaces exactly the fixtures eligible for a home rail", async () => {
    const result = await loadHomeCatalog(() => getHomeCatalog(NOW));
    if (result.status !== "ok") throw new Error("expected fixtures to load");

    const surfaced = result.response.rails.flatMap((rail) => rail.items);
    const eligible = demoCatalog.filter(appearsOnHome);

    expect(surfaced.map((item) => item.id).sort()).toEqual(
      eligible.map((item) => item.id).sort()
    );
    for (const item of surfaced) {
      expect(isSurfaceable(item)).toBe(true);
    }
  });

  it("does not place standalone episodes on a home rail", async () => {
    // Built by the episode builder rather than `movie({ kind: "episode" })`.
    // Overriding `kind` on another kind's builder no longer type-checks, which
    // is the point: it was previously possible to construct a "movie" carrying
    // an episode's discriminator and nothing caught it.
    const standalone = episode({ id: "ep-1" });
    expect(appearsOnHome(standalone)).toBe(false);

    const result = await loadHomeCatalog(() => getHomeCatalog(NOW, [standalone]));
    expect(result.status).toBe("empty");
  });
});
