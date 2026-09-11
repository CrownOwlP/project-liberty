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
import { resolveSynchronousCatalogMetadataSource } from "../../lib/catalog-source-registry";
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
 * IT NAMES NO IMPLEMENTATION, which it has not managed until now. It first
 * imported the raw `demoCatalog` array, which is ungated: a hosted deployment
 * served invented titles from `/title/:id` while the home rails, already routed
 * through the port, refused, and `docs/CATALOG_SOURCE.md` names that pair as
 * incoherent. The fix for that reached `demoCatalogSource` instead — gated, but
 * still an implementation named here and an environment classified here, which
 * made this a second module that knew both halves. Neither is imported now: the
 * lookups below take a `SynchronousCatalogMetadataSource` from
 * `lib/catalog-source-registry.ts`, the one composition root.
 *
 * A DEPLOYMENT DOES NOT REACH THE FIXTURES THROUGH THIS MODULE, and the reason is
 * structural rather than a check a later edit could quietly drop: the registry
 * cannot build `demoCatalogSource` without a `NonDeploymentEnvironment`, the only
 * mint for one reads the process and answers `null` for a deployment, and no
 * function on this path takes an environment NAME through which some other answer
 * could be supplied. What reaches this module on a deployment is the registry's
 * refusal, which `configuredSource` below turns into
 * `CatalogMetadataSourceNotConfiguredError`. That binds a CALLER; it is not a
 * claim that the fixture source cannot be built at all, and
 * `docs/CATALOG_SOURCE.md` states the exact boundary — a cast past the brand, an
 * edit to one of three files, and code that rewrites its own `NODE_ENV` all lie
 * outside it.
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
 * IT ASKS THE REGISTRY AND NAMES NO IMPLEMENTATION.
 * `resolveSynchronousCatalogMetadataSource` is the registry's accessor for a
 * caller that cannot await, and that is what this surface is:
 * `findDemoTitleDetail` is synchronous because `getTitleDetail` in
 * `title-detail.ts` is. This function used to classify `NODE_ENV` itself and
 * construct `demoCatalogSource` itself, because the registry's only accessor
 * carried a `CatalogMetadataSource` whose `listRecords` and `findRecord` may
 * answer with a promise — correct for a real provider and unusable from here.
 * The narrowing now lives in the registry, so the choice of implementation and
 * the environment gate are made in one file for every discovery surface, and
 * this one only translates the outcome into the vocabulary the title page
 * publishes.
 *
 * IT IS NOT THE OLD `readFixtureCatalogItems`. That accessor returned
 * `readonly CatalogItem[]` and answered `[]` on a deployment, which is exactly
 * the collapse of "refused" into "empty" this module has to avoid; it was
 * deleted along with `getHomeCatalog`, its one caller. What the registry answers
 * now is a tagged resolution, so the refusal below is a branch on a named status
 * rather than a guess about what an empty list meant.
 *
 * A REAL PROVIDER STILL DOES NOT LAND BEHIND THIS FUNCTION, and the reason is
 * unchanged — it does I/O, and this call site cannot await. What has changed is
 * where that shows up: a provider that cannot answer synchronously is not
 * assignable to `SynchronousCatalogMetadataSource`, so it is the REGISTRY that
 * fails to compile, in the one file that composes sources, rather than this
 * surface silently keeping a private route to the fixtures. The migration is the
 * same one `docs/CATALOG_SOURCE.md` records: this function and the loader above
 * it become asynchronous, and the narrow accessor disappears with them.
 *
 * THE REGISTRY'S REASON IS NOT REPUBLISHED VERBATIM. It refuses with
 * `no_metadata_source_configured`; the page's vocabulary is
 * `catalog_source_not_configured`, which is what the home rails and the search
 * surface already publish and what `[titleId]/page.tsx` renders. The two are the
 * same fact under two vocabularies today, so the mapping is total. If the
 * registry ever names a second reason — a source that exists but cannot answer
 * without awaiting — this branch has to choose what a reader is told rather than
 * continuing to publish this one.
 *
 * `environment` IS A PARAMETER SO THE REFUSAL IS REACHABLE FROM A TEST, the same
 * arrangement the registry and `getSearchResults` use: a suite reaches the
 * deployment branch by passing `null` instead of mutating `process.env` and
 * racing every other suite in the same worker. It is NOT a request input —
 * nothing on the title route passes one — and it is forwarded to the registry
 * unchanged. Every default on that chain, including this one, classifies the
 * process at CALL time and never at module scope, for the reason
 * `deployment-environment.ts` gives: a module-scope read freezes the answer to
 * whatever the process looked like when the first route was loaded. Only one of
 * those defaults ever runs, because a hop that was given a value passes it on.
 *
 * IT IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME. It used to be a `nodeEnv`
 * string forwarded to `classify`, and a caller could therefore name an
 * environment this process was not running in and be issued a genuine capability
 * for it. The mint declares no parameter now, so the only non-`null` value
 * anything can hand this function is one that came from a classification of the
 * running process, and `null` is the only value a deployment can obtain.
 *
 * Passing `undefined` EXPLICITLY re-enters the default and therefore classifies
 * this process, which under vitest is `test` and therefore on the allowlist. A
 * test that means "a deployment" passes `null`.
 */
function configuredSource(
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): SynchronousCatalogMetadataSource {
  const resolution = resolveSynchronousCatalogMetadataSource(environment);
  if (resolution.status === "not-configured") {
    throw new CatalogMetadataSourceNotConfiguredError();
  }

  return resolution.source;
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
 * `environment` is forwarded to `configuredSource`, whose comment carries the
 * whole argument for it: it is the capability or `null` rather than a runtime
 * name, it exists so a test can reach the deployment refusal by passing `null`
 * without mutating `process.env`, and it is never a request input.
 * `getTitleDetail` in `title-detail.ts` calls this with one argument and
 * therefore gets the process default, which is the production path.
 */
export function findDemoTitleDetail(
  contentId: string,
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): TitleDetail | null {
  const source = configuredSource(environment);

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
