import { describe, expect, it } from "vitest";
import type {
  CatalogHomeResponse,
  CatalogItem,
  EpisodeCatalogItem,
  MovieCatalogItem,
  SeriesCatalogItem
} from "@liberty/contracts/domains/catalog";
import {
  appearsOnHome,
  buildHomeCatalog,
  formatCatalogMeta,
  formatRuntime,
  isSurfaceable,
  loadHomeCatalog,
  readHomeCatalogFrom,
  type CatalogEmptyCause,
  type CatalogSource
} from "./catalog";
import type {
  CatalogAnswer,
  CatalogAnswerState,
  CatalogMetadataRecord
} from "./catalog-source";
import {
  resolveCatalogMetadataSource,
  type CatalogMetadataSourceResolution
} from "./catalog-source-registry";
import { demoCatalog } from "./demo-catalog";

/*
 * A fixed clock, stated as the ISO string the contract carries rather than as a
 * `Date`. Nothing in this file takes a `Date` any more: `buildHomeCatalog` is
 * given a `generatedAt` directly, and the synchronous `getHomeCatalog` that used
 * to convert one is gone.
 */
const ISO = "2026-08-14T00:00:00.000Z";

/*
 * A `CatalogSource` over an already-built response.
 *
 * The seam carries a CAUSE beside the payload as of PL-0310, because a
 * `CatalogHomeResponse` has one way to say "nothing" and there are two facts
 * that need saying. Tests that are not about the empty states pass
 * `cause_not_stated` by default rather than asserting a cause they do not
 * exercise; the ones that ARE about them name it.
 */
const answering =
  (payload: CatalogHomeResponse, cause: CatalogEmptyCause = "cause_not_stated"): CatalogSource =>
  () => ({ payload, cause });

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

/*
 * THE INJECTED SOURCES BELOW CALL `buildHomeCatalog` DIRECTLY.
 *
 * They used to call `getHomeCatalog(NOW, items)`, a synchronous wrapper that did
 * nothing but `buildHomeCatalog(items, now.toISOString())` and default `items` to
 * a synchronous read of the fixture source. Its one production caller — the home
 * API route — now awaits `loadHomeCatalog`, so it had only these callers left and
 * was deleted rather than kept alive for them. `buildHomeCatalog` is the pure
 * function it wrapped, and a literal `ISO` states the clock more directly than a
 * `Date` that was only ever converted back into one.
 */
describe("loadHomeCatalog", () => {
  it("returns ok with validated rails for the demo fixtures", async () => {
    const result = await loadHomeCatalog(answering(buildHomeCatalog(demoCatalog, ISO)));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.rails.length).toBeGreaterThan(0);
    expect(result.response.generatedAt).toBe(ISO);
  });

  /*
   * The wiring, with no source injected at all: `defaultHomeCatalogSource` reads
   * the registry, and this is the only test that exercises that path end to end
   * now that the synchronous fixture accessor is gone.
   *
   * Compared against the registry's own answer rather than against a hardcoded
   * verdict, so it asserts the wiring without also asserting which environment
   * the suite happens to run in — the same arrangement
   * `catalog-source-registry.test.ts` uses for its default-argument test.
   */
  it("reads the configured metadata source when nothing is injected", async () => {
    const resolution = resolveCatalogMetadataSource();
    const result = await loadHomeCatalog();

    if (resolution.status === "not-configured") {
      expect(result).toEqual({ status: "error", reason: "catalog_source_not_configured" });
      return;
    }

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.rails.length).toBeGreaterThan(0);
  });

  it("distinguishes empty from error", async () => {
    const result = await loadHomeCatalog(answering(buildHomeCatalog([], ISO), "catalog_empty"));
    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.generatedAt).toBe(ISO);
  });

  it("reports a validation failure as an error state, not an empty one", async () => {
    // Empty title violates the published contract.
    const result = await loadHomeCatalog(
      answering(buildHomeCatalog([movie({ id: "broken", title: "" })], ISO))
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("catalog_response_failed_validation");
  });

  /*
   * `null` from a source is the "no metadata source is configured" state, and it
   * is checked before validation because there is nothing to validate. It is not
   * `empty`: a deployment with no provider has an operator remedy, and an empty
   * catalog does not.
   */
  it("reports a source with no provider as a stated reason, not as empty", async () => {
    const result = await loadHomeCatalog(() => null);
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("catalog_source_not_configured");
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
    const result = await loadHomeCatalog(answering(buildHomeCatalog(demoCatalog, ISO)));
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

    const result = await loadHomeCatalog(answering(buildHomeCatalog([standalone], ISO)));
    expect(result.status).toBe("empty");
  });
});

/* -------------------------------------------------------------------------
 * PL-0310: AN EMPTY HOME SURFACE SAYS WHICH EMPTY IT IS
 *
 * `listRecords()` legitimately answers `[]` for two different facts, so a loader
 * that reads the length of an array can only ever produce one answer for both.
 * These drive the REAL composition -- `readHomeCatalogFrom`, which is what
 * `defaultHomeCatalogSource` calls, through `requireCatalogDescription`,
 * `selectDeclaredItems` and `buildHomeCatalog` in the shipped order -- over a
 * source the test controls, rather than restating that sequence here.
 * ---------------------------------------------------------------------- */

describe("loadHomeCatalog states which empty it is", () => {
  const answerOf = (
    over: { state: CatalogAnswerState } & Partial<Omit<CatalogAnswer, "state">>
  ): CatalogAnswer => ({
    records: [],
    withheld: [],
    observedAt: ISO,
    complete: true,
    ...over
  });

  /** A source that implements the optional description capability. */
  const describing = (answer: CatalogAnswer): CatalogMetadataSourceResolution => ({
    status: "configured",
    source: {
      sourceId: "describing",
      listRecords: () => answer.records,
      findRecord: () => null,
      describeCatalog: () => answer
    }
  });

  /**
   * A source that does NOT implement it. Legal: the method is optional on the
   * port, and the in-process fixture source is exactly this shape.
   */
  const silent = (
    records: readonly CatalogMetadataRecord[]
  ): CatalogMetadataSourceResolution => ({
    status: "configured",
    source: {
      sourceId: "silent",
      listRecords: () => records,
      findRecord: () => null
    }
  });

  const declared = (item: CatalogItem): CatalogMetadataRecord => ({
    item,
    rights: { category: item.rights, reference: null }
  });

  /** A record the source knows of and has declared no rights basis for. */
  const undeclared = (item: CatalogItem): CatalogMetadataRecord => ({ item, rights: null });

  const loadFrom = (resolution: CatalogMetadataSourceResolution) =>
    loadHomeCatalog(() => readHomeCatalogFrom(resolution));

  /*
   * THE REGRESSION THIS TASK IS FOR. Both states go through the real loader and
   * it answers differently. Before this change both arrived as
   * `{ status: "empty", generatedAt }` and nothing downstream could tell them
   * apart -- which is the one place PL-0305's four-state work stopped short of
   * the user.
   */
  it("distinguishes a catalog whose every record was withheld from an empty one", async () => {
    const withheld = await loadFrom(
      describing(
        answerOf({
          state: "no_records_usable",
          withheld: [{ recordId: "q1", reason: "rights_basis_not_declared" }]
        })
      )
    );
    const bare = await loadFrom(describing(answerOf({ state: "catalog_empty" })));

    expect(withheld.status).toBe("empty");
    expect(bare.status).toBe("empty");
    if (withheld.status !== "empty" || bare.status !== "empty") return;

    expect(withheld.cause).toBe("no_records_usable");
    expect(bare.cause).toBe("catalog_empty");
    expect(withheld.cause).not.toBe(bare.cause);
  });

  /*
   * A source that listed records and lost every one of them to
   * `selectDeclaredItems` is in the withheld state too, whatever it called its
   * own. It said `records_available` and there are still no rails, so "the
   * source has nothing" would be false.
   */
  it("reports records refused for want of a declared basis as withheld, not as empty", async () => {
    const result = await loadFrom(
      describing(
        answerOf({
          state: "records_available",
          records: [undeclared(movie({ id: "m1" })), undeclared(series({ id: "s1" }))]
        })
      )
    );

    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.cause).toBe("no_records_usable");
  });

  /*
   * `describeCatalog` IS OPTIONAL ON THE PORT. A source without it must still
   * load, and must not be reported as a failure of any kind -- it is a source
   * that cannot tell the two states apart, which is a gap in what is KNOWN and
   * not a fault in the source.
   */
  it("loads a source that does not implement describeCatalog", async () => {
    const result = await loadFrom(silent([declared(movie({ id: "m1" }))]));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.rails.flatMap((rail) => rail.items).map((item) => item.id)).toEqual([
      "m1"
    ]);
  });

  it("calls a source with no describeCatalog empty without a cause, never an error", async () => {
    const result = await loadFrom(silent([]));

    expect(result.status).not.toBe("error");
    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.cause).toBe("cause_not_stated");
  });

  /*
   * A bound stopped the read, so the absences are absences from a PREFIX of the
   * source. `catalog_empty` is not a claim a prefix can support, and the port
   * says so; a source that asserts it anyway is not repeated.
   */
  it("does not repeat catalog_empty from a read the source says was incomplete", async () => {
    const result = await loadFrom(
      describing(answerOf({ state: "catalog_empty", complete: false }))
    );

    expect(result.status).toBe("empty");
    if (result.status !== "empty") return;
    expect(result.cause).toBe("cause_not_stated");
  });

  /*
   * THE WITHHELD REASONS NAME INTERNAL POLICY VOCABULARY and are operator
   * diagnostics. What survives to the caller -- and therefore to whatever
   * renders it -- is the CAUSE. This fails the day somebody plumbs
   * `answer.withheld` into the result union "so the panel can be more helpful".
   */
  it("carries no withheld reason, and no record id, out of the loader", async () => {
    const result = await loadFrom(
      describing(
        answerOf({
          state: "no_records_usable",
          withheld: [
            { recordId: "Q42", reason: "rights_basis_not_declared" },
            { recordId: "Q7", reason: "availability_not_stated" }
          ]
        })
      )
    );

    const published = JSON.stringify(result);
    expect(published).not.toContain("rights_basis_not_declared");
    expect(published).not.toContain("availability_not_stated");
    expect(published).not.toContain("Q42");
    expect(published).not.toContain("Q7");
  });

  /*
   * Every empty result states a cause. The compiler already requires it --
   * `loadHomeCatalog` returns `CatalogLoadOutcome`, where the field is mandatory
   * -- and this asserts it of the values, over every empty-producing source in
   * this file, so the guarantee survives a future widening of the type.
   */
  it("never produces an empty result without a cause", async () => {
    const results = await Promise.all([
      loadFrom(describing(answerOf({ state: "catalog_empty" }))),
      loadFrom(describing(answerOf({ state: "no_records_usable" }))),
      loadFrom(describing(answerOf({ state: "catalog_empty", complete: false }))),
      loadFrom(silent([])),
      loadHomeCatalog(answering(buildHomeCatalog([], ISO), "catalog_empty"))
    ]);

    for (const result of results) {
      expect(result.status).toBe("empty");
      if (result.status !== "empty") continue;
      expect(["catalog_empty", "no_records_usable", "cause_not_stated"]).toContain(result.cause);
    }
  });

  /*
   * The states the registry answers are unchanged by any of this: a deployment
   * with no source is still a named refusal and never an empty catalog, and a
   * source that cannot answer still throws its way to `unavailable`.
   */
  it("still reports an unconfigured deployment as a refusal rather than an empty catalog", async () => {
    const result = await loadFrom({
      status: "not-configured",
      reason: "no_metadata_source_configured",
      detail: null
    });

    expect(result).toEqual({ status: "error", reason: "catalog_source_not_configured" });
  });

  it("still reports a describeCatalog that throws as unavailable", async () => {
    const result = await loadFrom({
      status: "configured",
      source: {
        sourceId: "broken",
        listRecords: () => [],
        findRecord: () => null,
        describeCatalog: () => {
          throw new Error("provider unreachable");
        }
      }
    });

    expect(result).toEqual({ status: "error", reason: "catalog_source_unavailable" });
  });
});
