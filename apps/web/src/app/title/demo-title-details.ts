import type { CatalogItem, SeriesCatalogItem } from "@liberty/contracts/domains/catalog";
import type {
  TitleDetail,
  TitleEpisodeSummary,
  TitleTechnicalMetadata
} from "@liberty/contracts/domains/title";
import {
  selectDeclaredItems,
  type SynchronousCatalogMetadataSource
} from "../../lib/catalog-source";
import { demoCatalogSource } from "../../lib/demo-catalog";
import { NonDeploymentEnvironment } from "../api/deployment-environment";

/**
 * Fictional development fixtures for the title surface, built from the same
 * catalog metadata source the home rails and the search index read.
 *
 * Derived rather than duplicated: if the detail page carried its own copy of a
 * title's genre or release year, the two surfaces would eventually disagree
 * about the same work and nothing would catch it. Only the fields a detail view
 * adds — synopsis, presentation facts, the episode list — are declared here.
 *
 * IT NO LONGER IMPORTS `demoCatalog` DIRECTLY, and that is the point of this
 * change. The raw fixture array is ungated; reading it meant a hosted deployment
 * served invented titles from `/title/:id` while the home rails, already routed
 * through the port, refused. `docs/CATALOG_SOURCE.md` names that pair as
 * incoherent. The lookups below go through `CatalogMetadataSource`, so the
 * fixtures are not withheld from a deployment — they are unconstructible in one.
 *
 * The extras declared in this file (synopsis, technical metadata, episodes) are
 * still fixtures with no source behind them, and they are still replaced when an
 * authorized provider adapter arrives. Nothing downstream should assume this
 * module exists in production.
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
 * The refusal this module raises when the process has no catalog metadata source.
 *
 * THROWN RATHER THAN RETURNED AS `null`, because `findDemoTitleDetail` has
 * already spent `null` on not-found and the two are different facts with
 * different remedies: "no title has that id" is answered by correcting the link,
 * "this deployment has no catalog" is answered by an operator configuring one.
 * The port draws exactly this line — `CatalogMetadataSource.findRecord` answers
 * `null` for an id it does not know and throws when it cannot answer at all —
 * and so does `TitleDetailSource` in `title-detail.ts`, which documents that a
 * source which cannot answer throws.
 *
 * WHAT A READER ACTUALLY SEES, now that the mapping exists. `loadTitleDetail` in
 * `title-detail.ts` tests for this class with `instanceof` ahead of its generic
 * `catch` branch and publishes `reason` below unchanged, so the deployment
 * refusal reaches the page as `catalog_source_not_configured` rather than as the
 * loader's `title_source_unavailable`. `[titleId]/page.tsx` renders that code
 * verbatim in its unavailable panel. The class is exported, and the reason is a
 * field rather than only a message, so that branch is an `instanceof` and a
 * property read instead of a comparison against error text.
 *
 * It stays an `error` result and therefore a 200 page carrying
 * `robots: index false` (`TITLE_UNAVAILABLE_METADATA`). It is deliberately not
 * `not-found`: that would assert no title has this id, when in fact no id was
 * looked up.
 */
export class CatalogMetadataSourceNotConfiguredError extends Error {
  /** The reason code the home rails and the search surface already publish. */
  readonly reason = "catalog_source_not_configured";

  constructor() {
    super("no catalog metadata source is configured for this process");
    this.name = "CatalogMetadataSourceNotConfiguredError";
  }
}

/**
 * The metadata source for this process, or a refusal.
 *
 * IT REACHES THE FIXTURE SOURCE DIRECTLY RATHER THAN THROUGH
 * `resolveCatalogMetadataSource`, and that is a wart with a reason.
 * `findDemoTitleDetail` is synchronous because `getTitleDetail` in
 * `title-detail.ts` is, and the registry's resolution carries a
 * `CatalogMetadataSource` whose `listRecords` and `findRecord` may answer with a
 * promise — correct for a real provider and unusable from a synchronous caller.
 * The registry used to carry `readFixtureCatalogItems`, which made the same
 * compromise for the same reason. It has been deleted, together with
 * `getHomeCatalog` — the one caller it existed to serve — now that the home route
 * awaits `loadHomeCatalog`. It was never usable here in any case: it answered
 * `[]` on a deployment, which is exactly the collapse of "refused" into "empty"
 * this module has to avoid.
 *
 * The consequence is that a real provider does not land behind this function. It
 * lands in the registry, and this surface has to become asynchronous along with
 * the loader above it — the follow-up the home path has already completed and
 * this one has not.
 *
 * `nodeEnv` IS A PARAMETER SO THE REFUSAL IS REACHABLE FROM A TEST, the same
 * arrangement `resolveCatalogMetadataSource` and `getSearchResults` use: a suite
 * states the environment it means instead of mutating `process.env` and racing
 * every other suite in the same worker. It is NOT a request input — nothing on
 * the title route passes one — and it defaults to a read of the process boundary
 * at CALL time, never at module scope, for the reason
 * `deployment-environment.ts` gives: a module-scope read freezes the answer to
 * whatever the process looked like when the first route was loaded.
 *
 * Passing `undefined` EXPLICITLY re-enters that default and reads
 * `process.env.NODE_ENV`, which under vitest is `test` and therefore on the
 * allowlist. A caller that means "no environment was stated" passes `""`, which
 * is how `classify` itself spells an unset variable (`?? ""`).
 *
 * `NonDeploymentEnvironment` cannot be constructed outside that module and
 * `demoCatalogSource` requires one, so there is no expression here that reaches
 * the fixtures without handling the `null` — deleting the check is a compile
 * error rather than a silent widening.
 */
function configuredSource(
  nodeEnv: string | undefined = process.env.NODE_ENV
): SynchronousCatalogMetadataSource {
  const environment = NonDeploymentEnvironment.classify(nodeEnv);
  if (environment === null) throw new CatalogMetadataSourceNotConfiguredError();

  return demoCatalogSource(environment);
}

/**
 * Metadata source: resolve a normalized content id to a title detail.
 *
 * Returns `null` for an id nothing knows about. `null` means not-found and only
 * not-found — a source failure throws, so the loader can keep the two apart, and
 * a process with no configured source is the first such failure this actually
 * raises (`CatalogMetadataSourceNotConfiguredError`, from `configuredSource`).
 *
 * The direct lookup goes through `findRecord` and the episode scan through
 * `listRecords`, which are the port's two questions. Episodes are not catalog
 * entities here — they are generated from a series' `episodeCount` — so the
 * second question is the only way to reach one.
 *
 * `nodeEnv` is forwarded to `configuredSource`, whose comment carries the whole
 * argument for it: it exists so a test can reach the deployment refusal without
 * mutating `process.env`, it is never a request input, and `undefined` means
 * "read the process" rather than "no environment". `getTitleDetail` in
 * `title-detail.ts` calls this with one argument and therefore gets the process
 * default, which is the production path.
 */
export function findDemoTitleDetail(
  contentId: string,
  nodeEnv: string | undefined = process.env.NODE_ENV
): TitleDetail | null {
  const source = configuredSource(nodeEnv);

  const record = source.findRecord(contentId);
  if (record !== null) {
    /*
     * One record, through the same gate the rails and the search index apply.
     * A source that declared no rights basis, or one that contradicts the item
     * it describes, publishes nothing — so the title is not-found rather than
     * rendered from a record the port refused. Unreachable against the current
     * fixtures, every one of which declares `owned` over an item carrying
     * `owned`; it is here because a real source has two inputs and they can
     * disagree.
     *
     * THE CONTRACT ARGUES THE OTHER WAY FOR ONE OF THOSE TWO REFUSALS, and this
     * comment exists so the divergence is recorded rather than discovered.
     * `packages/contracts/src/domains/title.ts` says a title detail is reachable
     * by direct id for anything the metadata layer knows about, INCLUDING a work
     * nobody has yet cleared — that is what `titleRightsBasisSchema`'s `null` is
     * for, and the honest mapping for `rights_basis_not_declared` is therefore a
     * detail carrying `rights: null` with the play CTA withheld, not a dead
     * address. `rights_basis_contradicts_item` is not the same case: there the
     * source disagreed with itself, so there is no undeclared-but-known work to
     * publish and refusing is right.
     *
     * THE CLOSED FAIL IS KEPT HERE ANYWAY, deliberately and for now. Building the
     * undeclared detail means carrying a nullable basis past
     * `selectDeclaredItems`, which returns `CatalogItem`s whose `rights` cannot
     * be null — so `buildCatalogItemDetail` and `demoEpisodes` would both have to
     * take an override, and a series with no declared basis would have to force
     * every generated episode to `null` rather than inherit `series.rights`. That
     * is a wider change than a fixture module should carry ahead of the real
     * source, and the current behaviour errs toward showing less. Nothing reaches
     * it today: every fixture declares `owned` over an item carrying `owned`. The
     * deeper fix is the one `lib/catalog-source.ts` already names — widen
     * `catalogItemSchema` to carry a nullable basis — and it belongs with the
     * contract change, not here.
     */
    const [item] = selectDeclaredItems([record]).items;
    return item === undefined ? null : buildCatalogItemDetail(item);
  }

  // Episode ids are not catalog ids; they are owned by the series that
  // generated them, so the only place to look is inside each series the source
  // publishes.
  for (const item of selectDeclaredItems(source.listRecords()).items) {
    if (item.kind !== "series") continue;

    const episode = demoEpisodes(item).find((candidate) => candidate.id === contentId);
    if (episode) return buildEpisodeDetail(item, episode);
  }

  return null;
}
