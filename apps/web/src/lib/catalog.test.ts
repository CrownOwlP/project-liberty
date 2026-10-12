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
  createCatalogMemo,
  describeSurfacedRightsBasis,
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

describe("describeSurfacedRightsBasis (Wave 132)", () => {
  /*
   * THE DEFECT CLASS THESE PIN: an availability indicator that is a guess.
   *
   * The tempting badge on a discovery surface reads "Available" or "Playable",
   * and this application cannot support either anywhere on that path:
   * `CatalogItem` carries no stream, no provider and no URL, and a playable
   * stream is resolved through authorized provider adapters at playback time.
   * What IS established is the rights basis the gate read, so that is the only
   * thing this function is allowed to say -- and these cases assert it does not
   * say anything stronger.
   */
  it("reports the rights basis the gate actually read, for every value on the allowlist", () => {
    expect(describeSurfacedRightsBasis(movie({ id: "a", rights: "licensed" }))).toBe(
      "Licensed for this installation"
    );
    expect(describeSurfacedRightsBasis(movie({ id: "b", rights: "owned" }))).toBe(
      "From your own library"
    );
    expect(describeSurfacedRightsBasis(series({ id: "c", rights: "public-domain" }))).toBe(
      "Public domain"
    );
  });

  it("never claims a title is playable, available, streaming or ready", () => {
    /*
     * Asserted as a PROHIBITION on the vocabulary rather than as three more
     * equality checks, because the failure this guards against is somebody
     * later improving the copy into a claim. The words are the claim.
     */
    const forbidden = ["playable", "available to watch", "streaming", "ready to watch", "watch now"];
    for (const rights of ["licensed", "owned", "public-domain"] as const) {
      const sentence = describeSurfacedRightsBasis(movie({ id: rights, rights })).toLowerCase();
      for (const word of forbidden) {
        expect(sentence, `${rights}: "${word}"`).not.toContain(word);
      }
    }
  });

  it("says so, rather than naming a basis, for an item the gate would refuse", () => {
    /*
     * UNREACHABLE FROM BROWSE AND SEARCH -- both gate before they build a list
     * -- and written because this function is exported and the next caller may
     * not gate first. A describer that silently calls an ungated item
     * "licensed" is how a gate gets reported as having passed when it was never
     * run. It is also total: no empty string, which would render as a blank
     * line indistinguishable from a missing label.
     */
    const refused = { ...movie({ id: "r" }), rights: "unreviewed" as never };
    expect(isSurfaceable(refused)).toBe(false);
    const sentence = describeSurfacedRightsBasis(refused);
    expect(sentence).toContain("Not available here");
    expect(sentence.length).toBeGreaterThan(0);
  });
});

describe("createCatalogMemo (Wave 132)", () => {
  /*
   * THE DEFECT CLASS: one port asked the same question twice inside one
   * request, with no guarantee the two answers agree.
   *
   * `app/title/[titleId]/page.tsx` states the failure exactly -- two reads for
   * one request whose answers "are not required to agree", so a source that
   * failed between them would title the tab after a title the page says it
   * could not load. That is a correctness defect before it is a cost one. These
   * cases MEASURE the primitive, because this wave's instruction on caching was
   * "measure, do not assume".
   */
  it("reads once and reports both counters", async () => {
    let reads = 0;
    const memo = createCatalogMemo(async () => {
      reads += 1;
      return ["one"];
    });
    expect(memo.stats()).toEqual({ sourceReads: 0, reuses: 0 });
    expect(await memo.read()).toEqual(["one"]);
    expect(await memo.read()).toEqual(["one"]);
    expect(await memo.read()).toEqual(["one"]);
    expect(reads).toBe(1);
    expect(memo.stats()).toEqual({ sourceReads: 1, reuses: 2 });
  });

  it("caches the PROMISE, so concurrent callers share one read", async () => {
    /*
     * The case a value cache cannot serve: two surfaces rendering concurrently
     * in one request both arrive before either answer exists, miss, and read
     * twice. Deliberately resolved only after both callers have arrived.
     */
    let reads = 0;
    /*
     * The resolver is captured through a holder rather than a bare `let`, which
     * TypeScript narrows to `null` because it does not track an assignment made
     * inside a promise executor -- the resulting `release?.()` is a call
     * expression on `never` and does not compile.
     */
    const latch: { release: () => void } = { release: () => undefined };
    const gate = new Promise<void>((resolve) => {
      latch.release = resolve;
    });
    const memo = createCatalogMemo(async () => {
      reads += 1;
      await gate;
      return ["one"];
    });

    const both = Promise.all([memo.read(), memo.read(), memo.read()]);
    expect(reads).toBe(1);
    latch.release();
    const [a, b, c] = await both;
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(reads).toBe(1);
    expect(memo.stats()).toEqual({ sourceReads: 1, reuses: 2 });
  });

  it("accepts a synchronous read without the caller knowing which it got", async () => {
    /* The metadata port's `listRecords` may answer immediately or with a
     * promise; that is a fact about one source and not a shape the port
     * guarantees, so the memo normalises it. */
    const memo = createCatalogMemo(() => 7);
    expect(await memo.read()).toBe(7);
    expect(await memo.read()).toBe(7);
    expect(memo.stats()).toEqual({ sourceReads: 1, reuses: 1 });
  });

  it("caches `null`, because 'no source is configured' is a settled answer", async () => {
    /*
     * On these ports `null` means the deployment has no metadata source -- a
     * fact about the deployment, not a failure. Re-asking inside one request
     * cannot change it, so treating it as a miss would read the registry once
     * per surface to receive the identical refusal.
     */
    let reads = 0;
    const memo = createCatalogMemo(async () => {
      reads += 1;
      return null;
    });
    expect(await memo.read()).toBeNull();
    expect(await memo.read()).toBeNull();
    expect(reads).toBe(1);
  });

  it("does NOT cache a rejection, so one transient fault cannot poison the scope", async () => {
    /*
     * A cached rejection would turn a single provider fault into a permanently
     * refusing request scope, and these surfaces keep "the source threw" apart
     * from "no source is configured" precisely so the first stays retryable.
     * The memo does not retry on anybody's behalf -- it has no idea whether
     * asking again would help -- it only stops standing in the way.
     */
    let reads = 0;
    const memo = createCatalogMemo(async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient");
      return ["recovered"];
    });
    await expect(memo.read()).rejects.toThrow("transient");
    expect(await memo.read()).toEqual(["recovered"]);
    expect(reads).toBe(2);
    expect(memo.stats()).toEqual({ sourceReads: 2, reuses: 0 });
  });

  it("does not retry a rejection for the callers already waiting on it", async () => {
    /* Everyone who joined the failed flight sees the failure; the clearing only
     * affects the NEXT caller. Otherwise one fault would fan out into one retry
     * per concurrent surface. */
    let reads = 0;
    const memo = createCatalogMemo(async () => {
      reads += 1;
      throw new Error("down");
    });
    const results = await Promise.allSettled([memo.read(), memo.read()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(reads).toBe(1);
  });

  it("gives separate memos separate state, so a scope cannot leak into another", async () => {
    /* React's `cache` supplies the scope; this asserts the primitive does not
     * quietly share one across scopes via module state. */
    let reads = 0;
    const read = async () => {
      reads += 1;
      return reads;
    };
    const first = createCatalogMemo(read);
    const second = createCatalogMemo(read);
    expect(await first.read()).toBe(1);
    expect(await second.read()).toBe(2);
    expect(first.stats()).toEqual({ sourceReads: 1, reuses: 0 });
    expect(second.stats()).toEqual({ sourceReads: 1, reuses: 0 });
  });
});
