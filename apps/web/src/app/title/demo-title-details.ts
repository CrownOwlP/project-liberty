import type {
  CatalogItem,
  SeriesCatalogItem,
  TitleDetail,
  TitleEpisodeSummary,
  TitleTechnicalMetadata
} from "@liberty/contracts";
import { demoCatalog } from "../../lib/demo-catalog";

/**
 * Fictional development fixtures for the title surface, derived from the same
 * `demoCatalog` the home rails read.
 *
 * Derived rather than duplicated: if the detail page carried its own copy of a
 * title's genre or release year, the two surfaces would eventually disagree
 * about the same work and nothing would catch it. Only the fields a detail view
 * adds — synopsis, presentation facts, the episode list — are declared here.
 *
 * These are replaced by an authorized provider adapter in PL-0301; nothing
 * downstream should assume this module exists in production.
 */

/**
 * What a source that reported nothing looks like.
 *
 * This is the fallback for a title with no extras entry, and it is deliberately
 * all-null rather than a set of plausible defaults. A fixture that quietly
 * claims 1080p for every title it has no data about produces a UI that is never
 * wrong-looking and always wrong.
 */
const NOTHING_REPORTED: TitleTechnicalMetadata = {
  maxHeight: null,
  audioLanguages: null,
  subtitleLanguages: null
};

interface DemoDetailExtras {
  synopsis: string | null;
  technical: TitleTechnicalMetadata;
}

const DETAIL_EXTRAS: Readonly<Record<string, DemoDetailExtras>> = {
  "aurora-fall": {
    synopsis:
      "A survey pilot loses contact with her relay station and has to decide how much of the sky she is willing to give up to get it back.",
    technical: {
      maxHeight: 2160,
      audioLanguages: ["en", "fr"],
      subtitleLanguages: ["en", "fr", "es"]
    }
  },
  "signal-zero": {
    synopsis:
      "Two analysts on opposite sides of a shutdown order spend one night proving which of them is reading the same data wrong.",
    technical: {
      maxHeight: 1080,
      audioLanguages: ["en"],
      // Reported, and empty: this title genuinely ships no subtitle tracks.
      // That is a different claim from `null`, and the page says so differently.
      subtitleLanguages: []
    }
  },
  "deep-current": {
    // No synopsis was supplied. Not an empty string, which would render as a
    // blank paragraph indistinguishable from a layout bug.
    synopsis: null,
    technical: NOTHING_REPORTED
  },
  northstar: {
    synopsis:
      "A coastal shipping town keeps its ledgers honest for eighty years, and then a single audit asks who has been paying for that.",
    technical: {
      maxHeight: 2160,
      audioLanguages: ["en"],
      subtitleLanguages: ["en"]
    }
  },
  "harbor-lights": {
    synopsis:
      "Every lighthouse on the coast logs the same ship passing on the same night, and none of the logs agree about the year.",
    technical: {
      maxHeight: 1080,
      audioLanguages: ["en", "de"],
      subtitleLanguages: ["en"]
    }
  }
};

function extrasFor(contentId: string): DemoDetailExtras {
  return DETAIL_EXTRAS[contentId] ?? { synopsis: null, technical: NOTHING_REPORTED };
}

/**
 * Fixture episodes whose rights basis has not been established.
 *
 * One is deliberately present so the undeclared-rights path is exercised by the
 * running application and not only by unit tests. A series can be licensed as a
 * work while a single episode has no basis recorded yet, and the list has to
 * withhold the play affordance for exactly that episode.
 */
const UNDECLARED_RIGHTS_EPISODE_IDS: ReadonlySet<string> = new Set(["harbor-lights-s1e6"]);

/**
 * Deterministic episode fixtures for a series.
 *
 * Generated from `episodeCount` rather than hand-listed so the detail page can
 * never show a different number of episodes than the catalog card advertises.
 * Every derived value is a pure function of the episode number: no randomness,
 * no `Date.now()`, so two renders of the same series are byte-identical.
 */
function demoEpisodes(series: SeriesCatalogItem): TitleEpisodeSummary[] {
  return Array.from({ length: series.episodeCount }, (_, index) => {
    const episodeNumber = index + 1;
    const id = `${series.id}-s1e${episodeNumber}`;

    return {
      id,
      title: `Episode ${episodeNumber}`,
      seasonNumber: 1,
      episodeNumber,
      runtimeMinutes: 42 + ((episodeNumber * 7) % 11),
      synopsis: null,
      rights: UNDECLARED_RIGHTS_EPISODE_IDS.has(id) ? null : series.rights
    };
  });
}

function buildSeriesDetail(series: SeriesCatalogItem): TitleDetail {
  const extras = extrasFor(series.id);

  return {
    kind: "series",
    id: series.id,
    title: series.title,
    rights: series.rights,
    genre: series.genre,
    releaseYear: series.releaseYear,
    synopsis: extras.synopsis,
    technical: extras.technical,
    episodes: demoEpisodes(series)
  };
}

/**
 * An episode reports nothing technical of its own.
 *
 * Inheriting the series' presentation facts would read as data but would be an
 * invention: those figures describe the best presentation of the series, and
 * asserting them for one episode converts "we have not checked this episode"
 * into "this episode is available in 2160p". Unknown is the honest answer until
 * a provider adapter states otherwise.
 */
function buildEpisodeDetail(series: SeriesCatalogItem, episode: TitleEpisodeSummary): TitleDetail {
  return {
    kind: "episode",
    id: episode.id,
    title: episode.title,
    rights: episode.rights,
    genre: series.genre,
    releaseYear: series.releaseYear,
    synopsis: episode.synopsis,
    technical: NOTHING_REPORTED,
    seriesId: series.id,
    seriesTitle: series.title,
    seasonNumber: episode.seasonNumber,
    episodeNumber: episode.episodeNumber,
    runtimeMinutes: episode.runtimeMinutes
  };
}

function buildCatalogItemDetail(item: CatalogItem): TitleDetail | null {
  if (item.kind === "series") return buildSeriesDetail(item);

  if (item.kind === "movie") {
    const extras = extrasFor(item.id);
    return {
      kind: "movie",
      id: item.id,
      title: item.title,
      rights: item.rights,
      genre: item.genre,
      releaseYear: item.releaseYear,
      synopsis: extras.synopsis,
      technical: extras.technical,
      runtimeMinutes: item.runtimeMinutes
    };
  }

  /*
   * A bare `episode` sitting in the catalog has no series to belong to, and an
   * episode detail without its series cannot offer the one navigation an
   * episode page exists for. PL-0101 already established that episodes are
   * reached through their series; treating this as not-found keeps that rule in
   * one place instead of inventing a second, series-less episode page.
   */
  return null;
}

/**
 * Fixture source: resolve a normalized content id to a title detail.
 *
 * Returns `null` for an id nothing knows about. `null` means not-found and only
 * not-found — a source failure throws, so the loader can keep the two apart.
 */
export function findDemoTitleDetail(contentId: string): TitleDetail | null {
  const item = demoCatalog.find((candidate) => candidate.id === contentId);
  if (item) return buildCatalogItemDetail(item);

  // Episode ids are not catalog ids; they are owned by the series that
  // generated them, so the only place to look is inside each series.
  for (const series of demoCatalog) {
    if (series.kind !== "series") continue;

    const episode = demoEpisodes(series).find((candidate) => candidate.id === contentId);
    if (episode) return buildEpisodeDetail(series, episode);
  }

  return null;
}
