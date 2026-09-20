import type { CatalogItem, SeriesCatalogItem } from "@liberty/contracts/domains/catalog";
import type {
  TitleDetail,
  TitleEpisodeSummary,
  TitleTechnicalMetadata
} from "@liberty/contracts/domains/title";
import {
  selectDeclaredItems,
  type CatalogMetadataSource
} from "../../lib/catalog-source";
import {
  resolveCatalogMetadataSource,
  type CatalogSourceUnavailableReason
} from "../../lib/catalog-source-registry";
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
 * lookups below take a `CatalogMetadataSource` from
 * `lib/catalog-source-registry.ts`, the one composition root.
 *
 * AND IT IS ASYNCHRONOUS NOW, WHICH IS THE WHOLE OF THE MIGRATION THIS MODULE
 * SPENT SEVERAL ROUNDS PREDICTING. `findDemoTitleDetail` used to be synchronous
 * because `getTitleDetail` in `title-detail.ts` was, which meant it could only
 * be served by a source that answers without awaiting -- which meant the
 * fixtures, and only the fixtures, forever. Both are `async` as of round 51,
 * this surface reads `resolveCatalogMetadataSource` like every other discovery
 * surface, and `resolveSynchronousCatalogMetadataSource` has been DELETED
 * because this was its only production caller.
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
export type TitleCatalogSourceRefusalReason =
  | "catalog_source_not_configured"
  | "catalog_source_configuration_refused";

export class CatalogMetadataSourceNotConfiguredError extends Error {
  /**
   * What the page publishes. One of three now, and a FIELD SET AT CONSTRUCTION
   * rather than a literal on the class.
   *
   * `catalog_source_not_configured` is unchanged and is still what an
   * unconfigured deployment gets -- the home rails and the search surface
   * publish the same string, `[titleId]/page.tsx` renders it, and `e2e` asserts
   * it. `catalog_source_configuration_refused` arrived with the real source: a
   * runtime WAS supplied and the package refused to build a provider over it.
   * The two are not folded together because the remedies are opposite -- one
   * needs a configuration, the other needs a correction -- and telling an
   * operator to configure a source they already configured sends them the wrong
   * way.
   *
   * THERE WAS BRIEFLY A THIRD, `catalog_source_requires_async_caller`, and it is
   * gone. It named the state where a source was configured and this surface
   * could not reach it because it did not await. That state no longer exists:
   * this module is asynchronous and reads the general accessor. A published
   * reason code for a state that cannot occur is worse than no code at all --
   * whoever met it in a log would go looking for a migration that has already
   * happened -- so it was deleted with the condition rather than left behind.
   *
   * THE CLASS NAME FITS BOTH SURVIVORS reasonably: "not configured" and
   * "configuration refused" are both statements about this process's catalog
   * configuration. It was a poor fit for the third, which is one more reason
   * that one is gone. A rename would still reach `[titleId]/page.tsx`, which
   * imports this class by name for `CatalogMetadataSourceNotConfiguredError
   * ["reason"]`, and that file is outside round 51's write surface.
   */
  readonly reason: TitleCatalogSourceRefusalReason;

  constructor(reason: TitleCatalogSourceRefusalReason, message: string) {
    super(message);
    this.name = "CatalogMetadataSourceNotConfiguredError";
    this.reason = reason;
  }
}

/**
 * The registry's vocabulary, mapped onto the page's.
 *
 * TOTAL AND EXHAUSTIVE, AND THE TYPE ENFORCES BOTH. It is a `Record` over
 * `CatalogSourceUnavailableReason`, so the day the registry names a fourth
 * reason this object fails to compile and somebody has to decide what a reader
 * is told -- which is exactly what the previous version of this module said had
 * to happen and could not make happen, because it published one literal for
 * every refusal there was.
 *
 * THE TWO VOCABULARIES ARE NOT THE SAME FACT ANY MORE. They were while there was
 * one reason on each side. The registry now distinguishes "nothing was supplied"
 * from "something was supplied and the package refused it", and collapsing those
 * into `catalog_source_not_configured` would tell an operator to configure a
 * source they had already configured.
 */
const PUBLISHED_REASON: Record<CatalogSourceUnavailableReason, TitleCatalogSourceRefusalReason> = {
  no_metadata_source_configured: "catalog_source_not_configured",
  catalog_metadata_source_configuration_refused: "catalog_source_configuration_refused"
};

/**
 * The metadata source for this process, or a refusal.
 *
 * IT ASKS THE REGISTRY AND NAMES NO IMPLEMENTATION. `resolveCatalogMetadataSource`
 * is THE accessor -- there is no longer a second one -- and this surface reads it
 * exactly as `loadHomeCatalog` and `getSearchResults` do. This function used to
 * classify `NODE_ENV` itself and construct `demoCatalogSource` itself; then it
 * read a synchronous narrowing of the registry, because `findDemoTitleDetail`
 * could not await. Both of those are gone. The choice of implementation and the
 * environment gate are made in one file for every discovery surface, and this
 * one only translates the outcome into the vocabulary the title page publishes.
 *
 * IT IS NOT THE OLD `readFixtureCatalogItems`. That accessor returned
 * `readonly CatalogItem[]` and answered `[]` on a deployment, which is exactly
 * the collapse of "refused" into "empty" this module has to avoid; it was
 * deleted along with `getHomeCatalog`, its one caller. What the registry answers
 * now is a tagged resolution, so the refusal below is a branch on a named status
 * rather than a guess about what an empty list meant.
 *
 * A REAL PROVIDER DOES LAND BEHIND THIS FUNCTION NOW, and every previous version
 * of this paragraph said it could not. The obstacle was real and it was this
 * surface's own synchrony: a provider does I/O, and a synchronous caller can
 * only be served by a source that answers without awaiting. The obstacle was
 * removed rather than worked around -- `getTitleDetail` in `title-detail.ts` is
 * `async`, this function is `async`, `loadTitleDetail` already awaited its
 * source, and `TitleDetailSource` already admitted a promise. Nothing is
 * buffered, nothing is cached, and no stale or demo answer is returned to
 * satisfy a type.
 *
 * THE REGISTRY'S REASON IS NOT REPUBLISHED VERBATIM, and the mapping is TOTAL
 * BY TYPE. `PUBLISHED_REASON` above is a `Record` over the registry's whole
 * union, so a reason added there fails to compile here until somebody decides
 * what a reader is told. A previous version of this comment said that decision
 * "has to happen" one day; it has happened twice since, once to add
 * `catalog_source_configuration_refused` and once to delete a third reason when
 * this migration removed the state behind it.
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
): CatalogMetadataSource {
  const resolution = resolveCatalogMetadataSource(environment);
  if (resolution.status === "not-configured") {
    throw new CatalogMetadataSourceNotConfiguredError(
      PUBLISHED_REASON[resolution.reason],
      resolution.detail ?? "no catalog metadata source is configured for this process"
    );
  }

  return resolution.source;
}

/**
 * Metadata source: resolve a normalized content id to a title detail.
 *
 * ASYNCHRONOUS, WHICH IS WHAT LETS A REAL SOURCE ANSWER IT. The port's
 * `listRecords` and `findRecord` may return a promise, because a provider does
 * I/O; awaiting them is the only honest way to consume that port and it is what
 * this function does. Nothing here holds a buffered pass, a cache, or a fixture
 * fallback.
 *
 * Returns `null` for an id nothing knows about. `null` means not-found and only
 * not-found — a source failure throws, so the loader can keep the two apart.
 * Two such failures are reachable now: a process with no configured source
 * (`CatalogMetadataSourceNotConfiguredError`, from `configuredSource`) and a
 * provider that could not be reached (`CatalogMetadataSourceUnavailableError`,
 * thrown by the ingestion-backed source itself and converted by
 * `loadTitleDetail` into `title_source_unavailable`, which is the correct
 * "retry" advice for it).
 *
 * The direct lookup goes through `findRecord` and the episode scan through
 * `listRecords`, which are the port's two questions. Episodes are not catalog
 * entities here — they are generated from a series' `episodeCount` — so the
 * second question is the only way to reach one.
 *
 * THE EPISODE SCAN IS A SECOND QUESTION AND THEREFORE, AGAINST A REAL SOURCE, A
 * SECOND PASS. That is the adapter's documented cost rather than something this
 * surface can fix, and it is only paid for an id `findRecord` did not answer.
 * When a store lands behind the adapter it becomes a lookup; recorded in
 * `docs/CATALOG_SOURCE.md` rather than worked around with a cache here.
 *
 * `environment` is forwarded to `configuredSource`, whose comment carries the
 * whole argument for it: it is the capability or `null` rather than a runtime
 * name, it exists so a test can reach the deployment refusal by passing `null`
 * without mutating `process.env`, and it is never a request input.
 * `getTitleDetail` in `title-detail.ts` awaits this with one argument and
 * therefore gets the process default, which is the production path.
 */
export async function findDemoTitleDetail(
  contentId: string,
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): Promise<TitleDetail | null> {
  const source = configuredSource(environment);

  const record = await source.findRecord(contentId);
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
  for (const item of selectDeclaredItems(await source.listRecords()).items) {
    if (item.kind !== "series") continue;

    const episode = demoEpisodes(item).find((candidate) => candidate.id === contentId);
    if (episode) return buildEpisodeDetail(item, episode);
  }

  return null;
}
