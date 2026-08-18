import { describe, expect, it } from "vitest";
import {
  titleDetailResponseSchema,
  type EpisodeTitleDetail,
  type MovieTitleDetail,
  type SeriesTitleDetail,
  type TitleDetailResponse,
  type TitleEpisodeSummary,
  type TitleTechnicalMetadata
} from "@liberty/contracts/domains/title";
import {
  NONE_LABEL,
  NOT_REPORTED_LABEL,
  formatLanguageList,
  formatMaxHeight,
  formatTitleMeta,
  getTitleDetail,
  groupEpisodesBySeason,
  loadTitleDetail,
  resolvePlayAvailability,
  resolveSeriesPlayTarget,
  resolveTitlePlayAvailability,
  sortEpisodes
} from "./title-detail";
import { demoCatalog } from "../../lib/demo-catalog";

const NOW = new Date("2026-08-17T00:00:00.000Z");
const ISO = NOW.toISOString();

/*
 * One builder per kind, as in `lib/catalog.test.ts` and for the same reason:
 * `TitleDetail` is a discriminated union, so a single builder with a
 * `Partial<TitleDetail>` override bag would distribute into a union of partials
 * and let a test construct an item the contract rejects.
 */
type Overrides<T> = Partial<Omit<T, "kind">> & { id: string };

/** Nothing reported, which is the only honest default for absent facts. */
const NOTHING_REPORTED: TitleTechnicalMetadata = {
  maxHeight: null,
  audioLanguages: null,
  subtitleLanguages: null
};

const movie = (over: Overrides<MovieTitleDetail>): MovieTitleDetail => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  synopsis: null,
  technical: NOTHING_REPORTED,
  runtimeMinutes: 100,
  ...over,
  kind: "movie"
});

const series = (over: Overrides<SeriesTitleDetail>): SeriesTitleDetail => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  synopsis: null,
  technical: NOTHING_REPORTED,
  episodes: [],
  ...over,
  kind: "series"
});

const episodeDetail = (over: Overrides<EpisodeTitleDetail>): EpisodeTitleDetail => ({
  title: "Untitled",
  rights: "owned",
  genre: "Drama",
  releaseYear: 2024,
  synopsis: null,
  technical: NOTHING_REPORTED,
  seriesId: "a-series",
  seriesTitle: "A Series",
  seasonNumber: 1,
  episodeNumber: 1,
  runtimeMinutes: 47,
  ...over,
  kind: "episode"
});

const episode = (over: Partial<TitleEpisodeSummary> & { id: string }): TitleEpisodeSummary => ({
  title: "Untitled",
  seasonNumber: 1,
  episodeNumber: 1,
  runtimeMinutes: 47,
  synopsis: null,
  rights: "owned",
  ...over
});

const respond = (detail: TitleDetailResponse["detail"]): TitleDetailResponse => ({
  detail,
  generatedAt: ISO
});

describe("play gate", () => {
  it("offers playback for every allowlisted rights basis", () => {
    for (const rights of ["licensed", "owned", "public-domain"] as const) {
      expect(resolvePlayAvailability({ id: "aurora-fall", rights })).toEqual({
        status: "playable",
        href: "/watch/aurora-fall"
      });
    }
  });

  it("withholds playback when no rights basis has been declared", () => {
    expect(resolvePlayAvailability({ id: "aurora-fall", rights: null })).toEqual({
      status: "blocked",
      reason: "rights_not_declared"
    });
  });

  it("withholds playback for a basis that is not on the allowlist", () => {
    expect(resolvePlayAvailability({ id: "aurora-fall", rights: "bootleg" as never })).toEqual({
      status: "blocked",
      reason: "rights_not_playable"
    });
  });

  /*
   * The two blocked reasons must stay distinct. "Nobody has told us" and "we
   * were told, and the answer disqualifies it" send an operator to different
   * systems, and only the first one is an unanswered question.
   */
  it("does not report an undeclared basis as a disqualified one", () => {
    const undeclared = resolvePlayAvailability({ id: "x", rights: null });
    const disqualified = resolvePlayAvailability({ id: "x", rights: "bootleg" as never });
    expect(undeclared).not.toEqual(disqualified);
  });
});

describe("resolveTitlePlayAvailability", () => {
  it("plays a movie by its own normalized id", () => {
    expect(resolveTitlePlayAvailability(movie({ id: "aurora-fall" }))).toEqual({
      status: "playable",
      href: "/watch/aurora-fall"
    });
  });

  it("plays an episode by its own normalized id, not its series", () => {
    expect(
      resolveTitlePlayAvailability(episodeDetail({ id: "northstar-s1e2", seriesId: "northstar" }))
    ).toEqual({ status: "playable", href: "/watch/northstar-s1e2" });
  });

  it("points a series at its first playable episode", () => {
    const detail = series({
      id: "northstar",
      episodes: [
        episode({ id: "northstar-s1e2", episodeNumber: 2 }),
        episode({ id: "northstar-s1e1", episodeNumber: 1 })
      ]
    });

    expect(resolveTitlePlayAvailability(detail)).toEqual({
      status: "playable",
      href: "/watch/northstar-s1e1"
    });
  });

  it("skips an episode whose rights are undeclared rather than blocking the series", () => {
    const detail = series({
      id: "northstar",
      episodes: [
        episode({ id: "northstar-s1e1", episodeNumber: 1, rights: null }),
        episode({ id: "northstar-s1e2", episodeNumber: 2 })
      ]
    });

    expect(resolveTitlePlayAvailability(detail)).toEqual({
      status: "playable",
      href: "/watch/northstar-s1e2"
    });
  });

  it("blocks a series whose own rights are undeclared even when an episode is cleared", () => {
    const detail = series({
      id: "northstar",
      rights: null,
      episodes: [episode({ id: "northstar-s1e1" })]
    });

    expect(resolveTitlePlayAvailability(detail)).toEqual({
      status: "blocked",
      reason: "rights_not_declared"
    });
  });

  it("blocks a series with no episodes", () => {
    expect(resolveTitlePlayAvailability(series({ id: "northstar" }))).toEqual({
      status: "blocked",
      reason: "no_playable_episode"
    });
  });

  it("blocks a series in which no episode is cleared", () => {
    const detail = series({
      id: "northstar",
      episodes: [
        episode({ id: "northstar-s1e1", rights: null }),
        episode({ id: "northstar-s1e2", episodeNumber: 2, rights: null })
      ]
    });

    expect(resolveTitlePlayAvailability(detail)).toEqual({
      status: "blocked",
      reason: "no_playable_episode"
    });
  });

  it("resolves the series target from the rendered order, not the source order", () => {
    const episodes = [
      episode({ id: "northstar-s2e1", seasonNumber: 2, episodeNumber: 1 }),
      episode({ id: "northstar-s1e5", episodeNumber: 5 })
    ];

    expect(resolveSeriesPlayTarget(episodes)?.id).toBe("northstar-s1e5");
  });
});

describe("sortEpisodes", () => {
  it("orders by season then episode regardless of input order", () => {
    const ordered = sortEpisodes([
      episode({ id: "e-s2e1", seasonNumber: 2, episodeNumber: 1 }),
      episode({ id: "e-s1e10", episodeNumber: 10 }),
      episode({ id: "e-s1e2", episodeNumber: 2 })
    ]);

    expect(ordered.map((item) => item.id)).toEqual(["e-s1e2", "e-s1e10", "e-s2e1"]);
  });

  /*
   * The determinism case that matters: two rows can share a (season, episode)
   * pair, and `Array.prototype.sort` is stable, so without the id tiebreak the
   * output would simply echo the input order. Asserting both input orders
   * produce the same output is what proves the tiebreak exists.
   */
  it("breaks a duplicate season/episode pair on id, in both input orders", () => {
    const first = episode({ id: "e-s1e1-a" });
    const second = episode({ id: "e-s1e1-b" });

    expect(sortEpisodes([first, second]).map((item) => item.id)).toEqual([
      "e-s1e1-a",
      "e-s1e1-b"
    ]);
    expect(sortEpisodes([second, first]).map((item) => item.id)).toEqual([
      "e-s1e1-a",
      "e-s1e1-b"
    ]);
  });

  it("does not mutate the caller's list", () => {
    const episodes = [
      episode({ id: "e-s1e2", episodeNumber: 2 }),
      episode({ id: "e-s1e1", episodeNumber: 1 })
    ];

    sortEpisodes(episodes);
    expect(episodes.map((item) => item.id)).toEqual(["e-s1e2", "e-s1e1"]);
  });
});

describe("groupEpisodesBySeason", () => {
  it("returns no seasons for no episodes", () => {
    expect(groupEpisodesBySeason([])).toEqual([]);
  });

  it("produces ascending, contiguous seasons from interleaved input", () => {
    const seasons = groupEpisodesBySeason([
      episode({ id: "e-s2e1", seasonNumber: 2, episodeNumber: 1 }),
      episode({ id: "e-s1e1", episodeNumber: 1 }),
      episode({ id: "e-s2e2", seasonNumber: 2, episodeNumber: 2 }),
      episode({ id: "e-s1e2", episodeNumber: 2 })
    ]);

    expect(seasons.map((season) => season.seasonNumber)).toEqual([1, 2]);
    expect(seasons[0]?.episodes.map((item) => item.id)).toEqual(["e-s1e1", "e-s1e2"]);
    expect(seasons[1]?.episodes.map((item) => item.id)).toEqual(["e-s2e1", "e-s2e2"]);
  });
});

describe("absent metadata", () => {
  it("reports an unstated resolution as unreported rather than as a value", () => {
    expect(formatMaxHeight(null)).toBe(NOT_REPORTED_LABEL);
    expect(formatMaxHeight(2160)).toBe("2160p");
  });

  it("keeps an unreported language list distinct from an empty one", () => {
    expect(formatLanguageList(null)).toBe(NOT_REPORTED_LABEL);
    expect(formatLanguageList([])).toBe(NONE_LABEL);
    expect(formatLanguageList(null)).not.toBe(formatLanguageList([]));
  });

  it("preserves the source order of a reported list", () => {
    expect(formatLanguageList(["fr", "en"])).toBe("fr, en");
  });
});

describe("formatTitleMeta", () => {
  it("describes a movie by its runtime", () => {
    expect(formatTitleMeta(movie({ id: "m", genre: "Sci-fi", runtimeMinutes: 128 }))).toBe(
      "Sci-fi · 2024 · 2h 08m"
    );
  });

  it("describes a series by how many episodes it lists", () => {
    const detail = series({
      id: "s",
      genre: "Drama",
      episodes: [episode({ id: "s-s1e1" })]
    });
    expect(formatTitleMeta(detail)).toBe("Drama · 2024 · 1 episode");
  });

  it("describes a series with no episodes without claiming otherwise", () => {
    expect(formatTitleMeta(series({ id: "s", genre: "Drama" }))).toBe("Drama · 2024 · 0 episodes");
  });

  it("places an episode in its season before its runtime", () => {
    const detail = episodeDetail({
      id: "s-s2e3",
      genre: "Mystery",
      seasonNumber: 2,
      episodeNumber: 3,
      runtimeMinutes: 47
    });
    expect(formatTitleMeta(detail)).toBe("Mystery · 2024 · S2E3 · 47m");
  });
});

describe("loadTitleDetail", () => {
  it("returns ok with a validated payload", async () => {
    const result = await loadTitleDetail("aurora-fall", (id) => getTitleDetail(id, NOW));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.detail.id).toBe("aurora-fall");
    expect(result.response.generatedAt).toBe(ISO);
  });

  it("reports an id nothing knows about as not-found", async () => {
    const result = await loadTitleDetail("no-such-title", (id) => getTitleDetail(id, NOW));

    expect(result.status).toBe("not-found");
    if (result.status !== "not-found") return;
    expect(result.contentId).toBe("no-such-title");
  });

  /*
   * A path segment is user input. An id that is not normalized cannot name a
   * title, so it is answered without asking the source at all -- both because
   * not-found is the honest answer and because unvalidated input has no
   * business reaching a provider boundary.
   */
  it("rejects a non-normalized id without consulting the source", async () => {
    const malformed = ["Aurora Fall", "AURORA-FALL", "aurora_fall", "../secret", "aurora--fall", ""];
    let calls = 0;

    for (const contentId of malformed) {
      const result = await loadTitleDetail(contentId, (id) => {
        calls += 1;
        return getTitleDetail(id, NOW);
      });
      expect(result.status).toBe("not-found");
    }

    expect(calls).toBe(0);
  });

  it("reports a payload that fails the contract as an error, not as not-found", async () => {
    // An empty title violates the published contract.
    const result = await loadTitleDetail("broken", () => respond(movie({ id: "broken", title: "" })));

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("title_response_failed_validation");
  });

  it("refuses a payload for a different title than the one requested", async () => {
    const result = await loadTitleDetail("aurora-fall", () => respond(movie({ id: "signal-zero" })));

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("title_response_id_mismatch");
  });

  it("converts a throwing source into an error state", async () => {
    const result = await loadTitleDetail("aurora-fall", () => {
      throw new Error("provider unreachable");
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("title_source_unavailable");
  });

  it("converts a rejecting async source into an error state", async () => {
    const result = await loadTitleDetail("aurora-fall", () => Promise.reject(new Error("timeout")));

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("title_source_unavailable");
  });

  /*
   * The three states this page exists to keep apart. A series with no episodes
   * is a SUCCESSFUL load: the remedy is to wait, not to retry and not to fix
   * the link, and the loader must not fold it into either failure.
   */
  it("keeps not-found, error and an empty episode list apart", async () => {
    const missing = await loadTitleDetail("no-such-title", () => null);
    const failed = await loadTitleDetail("aurora-fall", () => {
      throw new Error("down");
    });
    const emptySeries = await loadTitleDetail("northstar", () =>
      respond(series({ id: "northstar" }))
    );

    expect(missing.status).toBe("not-found");
    expect(failed.status).toBe("error");
    expect(emptySeries.status).toBe("ok");
    if (emptySeries.status !== "ok") return;
    expect(emptySeries.response.detail.kind).toBe("series");
    if (emptySeries.response.detail.kind !== "series") return;
    expect(emptySeries.response.detail.episodes).toEqual([]);
  });
});

describe("demo fixtures", () => {
  it("resolves every browsable catalog item against the published contract", () => {
    const browsable = demoCatalog.filter((item) => item.kind !== "episode");
    expect(browsable.length).toBeGreaterThan(0);

    for (const item of browsable) {
      const response = getTitleDetail(item.id, NOW);
      expect(response, `no detail for ${item.id}`).not.toBeNull();
      expect(titleDetailResponseSchema.safeParse(response).success).toBe(true);
    }
  });

  it("lists exactly as many episodes as the catalog card advertises", () => {
    for (const item of demoCatalog) {
      if (item.kind !== "series") continue;

      const response = getTitleDetail(item.id, NOW);
      if (response === null || response.detail.kind !== "series") {
        throw new Error(`expected a series detail for ${item.id}`);
      }
      expect(response.detail.episodes).toHaveLength(item.episodeCount);
    }
  });

  it("reaches an episode by its own id and links it back to its series", async () => {
    const result = await loadTitleDetail("northstar-s1e3", (id) => getTitleDetail(id, NOW));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const { detail } = result.response;
    expect(detail.kind).toBe("episode");
    if (detail.kind !== "episode") return;
    expect(detail.seriesId).toBe("northstar");
    expect(detail.seasonNumber).toBe(1);
    expect(detail.episodeNumber).toBe(3);
  });

  it("withholds play from the one fixture episode with no declared rights", () => {
    const response = getTitleDetail("harbor-lights", NOW);
    if (response === null || response.detail.kind !== "series") {
      throw new Error("expected a series detail for harbor-lights");
    }

    const undeclared = response.detail.episodes.find((item) => item.id === "harbor-lights-s1e6");
    if (undeclared === undefined) throw new Error("expected an undeclared fixture episode");

    expect(undeclared.rights).toBeNull();
    expect(resolvePlayAvailability(undeclared)).toEqual({
      status: "blocked",
      reason: "rights_not_declared"
    });

    // The series as a whole is still playable, via an episode that is cleared.
    expect(resolveTitlePlayAvailability(response.detail)).toEqual({
      status: "playable",
      href: "/watch/harbor-lights-s1e1"
    });
  });

  it("reports nothing technical for an episode rather than inheriting its series", () => {
    const response = getTitleDetail("northstar-s1e1", NOW);
    if (response === null) throw new Error("expected an episode detail for northstar-s1e1");

    expect(response.detail.technical).toEqual({
      maxHeight: null,
      audioLanguages: null,
      subtitleLanguages: null
    });
  });
});
