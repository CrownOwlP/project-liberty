import { describe, expect, it } from "vitest";
import type { CatalogItem } from "@liberty/contracts";
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

const movie = (over: Partial<CatalogItem> & { id: string }): CatalogItem => ({
  title: "Untitled",
  kind: "movie",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  ...over
});

const series = (over: Partial<CatalogItem> & { id: string }): CatalogItem =>
  movie({ kind: "series", runtimeMinutes: null, episodeCount: 6, ...over });

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

  it("falls back to genre alone when neither runtime nor episodes are known", () => {
    expect(formatCatalogMeta(movie({ id: "c", genre: "Documentary", runtimeMinutes: null })))
      .toBe("Documentary");
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
    const episode = movie({ id: "ep-1", kind: "episode" });
    expect(appearsOnHome(episode)).toBe(false);

    const result = await loadHomeCatalog(() => getHomeCatalog(NOW, [episode]));
    expect(result.status).toBe("empty");
  });
});
