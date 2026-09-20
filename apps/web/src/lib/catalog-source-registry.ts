import { NonDeploymentEnvironment } from "../app/api/deployment-environment";
import {
  createCatalogIngestionSource,
  type CatalogIngestionRuntime
} from "./catalog-ingestion-source";
import type { CatalogMetadataSource } from "./catalog-source";
import { demoCatalogSource } from "./demo-catalog";

/* -------------------------------------------------------------------------
 * Which metadata source this process has
 *
 * THE ONE MODULE THAT KNOWS BOTH THE PORT AND AN IMPLEMENTATION. `catalog-source.ts`
 * imports no implementation and `demo-catalog.ts` imports no consumer, so this
 * is the single file the choice of source is made in. It now has two to choose
 * between.
 *
 * THERE IS A REAL SOURCE NOW, AND THIS FILE REACHES IT. Every previous version
 * of this header said the opposite, at length, and the sentences it spent on
 * "the edit this file is waiting for" have been replaced by the edit. What
 * happened:
 *
 *   - `apps/web/package.json` declares `@liberty/catalog-ingestion`.
 *   - `lib/catalog-ingestion-source.ts` projects that package's PUBLIC API into
 *     a `CatalogMetadataSource`. It is the only module in `apps/web` that names
 *     the package, it names no Wikidata module and no Wikidata type, and it
 *     contains no query and no fetch -- both stay behind the package's provider
 *     and transport boundaries.
 *   - `resolveCatalogMetadataSource` below returns that source when a deployment
 *     supplies a runtime, IN ANY ENVIRONMENT. A configured real source outranks
 *     the fixtures; the fixtures are what a developer gets when nothing is
 *     configured, not a thing a configured process falls back to.
 *
 * WHAT A RUNTIME IS AND WHERE IT COMES FROM. It is the package's own
 * `CatalogProviderRuntime` -- the licensed source name, the egress policy, the
 * transport for the runtime being composed for, the required User-Agent, which
 * slice of the source to read, and the OPERATOR'S RIGHTS REGISTER -- plus the
 * read options and a clock. It is SUPPLIED, never discovered: nothing here reads
 * an environment variable, consults a file, or holds a credential, and there is
 * no field on it a caller could set to license a source the package's frozen
 * list does not name. A deployment that supplies nothing gets nothing, and that
 * is still a named refusal rather than an empty catalog.
 *
 * `registerCatalogIngestionRuntime` IS HOW A DEPLOYMENT SUPPLIES ONE, and it is
 * a registration rather than a read. The distinction matters here: this file
 * refuses to let a process NAME the environment it wishes to be treated as, and
 * a runtime read out of `process.env` would be the same mistake in a different
 * field -- a hosted process describing its own catalog configuration into
 * existence. A registration is a call some composition root makes on purpose,
 * with a value it constructed, and it is visible in a stack trace.
 *
 * NOTHING CALLS IT YET, AND THAT IS STATED RATHER THAN IMPLIED. The call belongs
 * in this app's server bootstrap, next to whatever constructs the Node pinned
 * fetch from `@liberty/media-inspection/node/pinned-fetch` -- and that file is
 * outside round 51's write surface, so this round wired the seam and did not
 * write the bootstrap. Until it is written, a hosted deployment answers
 * `no_metadata_source_configured`, which is TRUE of it: no runtime has been
 * registered, so no source is configured. What has changed is that this is now a
 * statement about the deployment rather than about this file.
 *
 * ==========================================================================
 * FOUR STATES, FOUR ANSWERS
 * ==========================================================================
 *
 * An empty rail has four causes with four different remedies. Two of them are
 * answered here and two are answered by the source:
 *
 *   1. NO SOURCE CONFIGURED -> `not-configured` / `no_metadata_source_configured`.
 *      Remedy: register a runtime.
 *   1b. A RUNTIME WAS SUPPLIED AND REFUSED -> `not-configured` /
 *      `catalog_metadata_source_configuration_refused`, with the package's own
 *      detail. Remedy: correct the deployment -- an unlicensed source name, a
 *      User-Agent the provider will not accept, an egress policy reaching
 *      outside the licensed namespaces. Separate from 1 because telling an
 *      operator to configure a source they already configured sends them the
 *      wrong way; it is the same split `authorized-candidates.ts` draws between
 *      `not-configured` and `provider-unavailable`.
 *   2. CONFIGURED, AND NOTHING IT RETURNED IS USABLE -> the source's
 *      `describeCatalog()` answers `no_records_usable` and lists why per record.
 *      Remedy: the operator's rights register, or availability data.
 *   3. THE PROVIDER OR THE NETWORK FAILED -> the source THROWS
 *      `CatalogMetadataSourceUnavailableError`. Remedy: retry, or fix egress.
 *   4. TRULY EMPTY -> `describeCatalog()` answers `catalog_empty`.
 *
 * `lib/catalog-ingestion-source.ts` carries 2, 3 and 4 in full. What is worth
 * knowing here is that `listRecords()` answers `[]` for BOTH 2 and 4 -- because
 * both genuinely have no records -- so a caller that needs them apart calls
 * `describeCatalog` through `requireCatalogDescription`. `loadHomeCatalog` in
 * `lib/catalog.ts` does not yet: it maps a refusal to
 * `catalog_source_not_configured`, a throw to `catalog_source_unavailable` and
 * `[]` to `empty`, so today it collapses 2 into 4. That file is outside round
 * 51's write surface; the distinction exists at the port and the remaining edit
 * is named rather than hidden.
 *
 * ==========================================================================
 * THERE IS ONE ACCESSOR. THE SYNCHRONOUS ONE IS DELETED.
 * ==========================================================================
 *
 * This file used to predict, in detail, what would happen the day a real source
 * landed: a provider that does I/O is not assignable to
 * `SynchronousCatalogMetadataSource`, so returning one from the narrow accessor
 * is a COMPILE ERROR, and one of two things would have to be written on purpose
 * -- the title surface becomes asynchronous and that accessor is deleted, or the
 * refusal gains a second reason naming the state honestly.
 *
 * THE DAY ARRIVED AND THE FIRST THING WAS WRITTEN. `getTitleDetail` and
 * `findDemoTitleDetail` are asynchronous, the title surface reads
 * `resolveCatalogMetadataSource` like every other discovery surface, and
 * `resolveSynchronousCatalogMetadataSource`,
 * `SynchronousCatalogMetadataSourceResolution` and the
 * `metadata_source_requires_awaiting` reason are GONE. `loadTitleDetail`
 * already awaited its source and `TitleDetailSource` already admitted a
 * promise, both written that way for a provider that does I/O, so the migration
 * cost three lines above this registry.
 *
 * THE SECOND OPTION WAS WRITTEN FIRST AND THEN REMOVED, which is worth recording
 * rather than tidying away. For one round the narrow accessor refused with
 * `metadata_source_requires_awaiting` and the title page published
 * `catalog_source_requires_async_caller`. That was an honest description of an
 * unfinished migration, and it stopped being honest the moment the migration
 * finished: a refusal path with no caller is dead code wearing a safety label,
 * and a published reason code for a state that cannot occur sends whoever meets
 * it in a log looking for a problem that no longer exists. Both went with the
 * condition.
 *
 * WHAT WAS REFUSED OUTRIGHT THROUGHOUT, because each would have made the type
 * check and each is a lie: buffering a pass behind a synchronous API (a
 * synchronous answer extracted from a promise is a stale answer or a deadlock),
 * returning the demo fixtures to a process that has a real source configured,
 * and returning an empty source (indistinguishable from an empty catalog).
 *
 * `SynchronousCatalogMetadataSource` -- the TYPE, in `catalog-source.ts` --
 * survives the accessor, and that is not an oversight.
 * `DemoCatalogMetadataSource` in `lib/demo-catalog.ts` extends it, because an
 * in-process fixture array really does answer without awaiting and saying so in
 * its type is a true statement about it. What is gone is the RESOLUTION that
 * promised one to a caller, which is the thing that had no caller left.
 *
 * ==========================================================================
 * WHAT HAS NOT CHANGED
 * ==========================================================================
 *
 * NEITHER ACCESSOR TAKES A RUNTIME NAME. Both used to take a `nodeEnv` they
 * forwarded to `classify`, which meant a hosted process could name the
 * environment it wished to be treated as and be issued a genuine capability for
 * it -- and the fixtures with it. They take the capability, or `null`, and the
 * only producer of a non-`null` one is a mint that reads the process and
 * declares no parameter. See `app/api/deployment-environment.ts`.
 *
 * The environment is classified at CALL time and never at module scope, for the
 * reason `deployment-environment.ts` gives: a default argument is evaluated per
 * call, while a module-scope read freezes the answer to whatever the process
 * looked like when the first route was loaded, which in a serverless cold start
 * is not necessarily the request's environment.
 *
 * NEITHER ACCESSOR CAN ANSWER AN EMPTY CATALOG. Both return the same tagged
 * union, a refusal is `not-configured` with a named reason, and there is no
 * value either of them can answer that a caller could mistake for "the catalog
 * contains nothing". That is the property the deleted `readFixtureCatalogItems`
 * did not have -- it returned `readonly CatalogItem[]` and answered `[]` on a
 * deployment, which `app/api/v1/catalog/home/route.ts` then served as
 * `{ rails: [] }` at 200 -- and it is the property the whole pair exists for.
 * ---------------------------------------------------------------------- */

/**
 * Why no source answered.
 *
 * Two values, and the union was written as one from the start so that adding a
 * reason is additive rather than a second hand-maintained shape.
 *
 *   - `no_metadata_source_configured` -- nothing was supplied. The remedy is to
 *     supply something.
 *   - `catalog_metadata_source_configuration_refused` -- something was supplied
 *     and the package refused to build a provider over it. The remedy is to
 *     correct it, and telling this operator to "configure a metadata source"
 *     would send them to look for a thing they already did.
 *
 * A THIRD VALUE, `metadata_source_requires_awaiting`, EXISTED FOR ONE ROUND AND
 * IS DELETED. It named a source that was configured and a caller that could not
 * await it, and only the synchronous accessor could produce it. The title
 * surface -- that accessor's one production caller -- is asynchronous now, so
 * the state is unreachable and the name went with it. Every consumer of this
 * union maps it TOTALLY (`PUBLISHED_REASON` in `app/title/demo-title-details.ts`
 * is a `Record` over it), so a removal is caught by the compiler exactly as an
 * addition is.
 */
export type CatalogSourceUnavailableReason =
  | "no_metadata_source_configured"
  | "catalog_metadata_source_configuration_refused";

/**
 * What every discovery surface gets back.
 *
 * ONE UNION, BECAUSE THERE IS ONE ACCESSOR. This was a generic
 * `CatalogMetadataSourceResolutionOf<TSource>` with two instantiations -- the
 * published port and its synchronous narrowing -- written once so that a refusal
 * reason could not be added to one and missed on the other. The narrowing is
 * gone, so the parameter had one argument left and was collapsed rather than
 * kept for symmetry with something that no longer exists.
 *
 * `detail` IS `null` RATHER THAN ABSENT when there is nothing to add. An
 * optional field would make "this refusal carries no detail" and "whoever wrote
 * this branch forgot the detail" the same value at runtime, and the second is
 * the one worth catching. It carries the PACKAGE'S OWN detail string unchanged
 * where there is one; nothing here composes a message out of a third party's
 * response.
 */
export type CatalogMetadataSourceResolution =
  | { readonly status: "configured"; readonly source: CatalogMetadataSource }
  | {
      readonly status: "not-configured";
      readonly reason: CatalogSourceUnavailableReason;
      readonly detail: string | null;
    };

/* -------------------------------------------------------------------------
 * The registered runtime
 * ---------------------------------------------------------------------- */

/**
 * The runtime this process was given, if any.
 *
 * MODULE STATE, WHICH THIS FILE OTHERWISE ARGUES AGAINST, and the distinction is
 * worth being exact about. What the rest of this module refuses is a module-scope
 * READ OF THE PROCESS -- classifying `NODE_ENV` once at import and freezing the
 * verdict, which in a serverless cold start answers for the wrong request. This
 * is not that. It holds a value a composition root CONSTRUCTED and HANDED OVER;
 * it is `null` until somebody calls the registrar; and it cannot be conjured
 * from the environment, a file, or a default, because nothing here reads any of
 * those.
 */
let registeredRuntime: CatalogIngestionRuntime | null = null;

/**
 * Hand this process its catalog metadata runtime, or take it away.
 *
 * FOR A COMPOSITION ROOT AND A TEST, AND NOT FOR A REQUEST. Nothing on a request
 * path may call this: a runtime carries an egress policy and a rights register,
 * and a value a request could set is a value a request could weaken. It is
 * exported because the bootstrap that will call it lives in another file, and
 * because a test that needs a configured deployment must be able to build one
 * without an environment variable existing for it to read.
 *
 * `null` CLEARS IT, which is what makes it usable from a test without leaking
 * one suite's configuration into the next. Pass the previous value back in a
 * `finally`.
 */
export function registerCatalogIngestionRuntime(runtime: CatalogIngestionRuntime | null): void {
  registeredRuntime = runtime;
}

/** What `registerCatalogIngestionRuntime` last set. `null` when nothing has. */
export function registeredCatalogIngestionRuntime(): CatalogIngestionRuntime | null {
  return registeredRuntime;
}

/* -------------------------------------------------------------------------
 * The accessors
 * ---------------------------------------------------------------------- */

/**
 * The metadata source for this process, or a stated reason there is none.
 *
 * THE ORDER OF THE TWO BRANCHES IS THE WHOLE BEHAVIOUR. A configured runtime
 * wins over the fixtures, in every environment, because a process that was given
 * a real catalog should read the real catalog -- a developer who configures one
 * locally and silently gets six invented films back has been lied to in the
 * least useful possible way. The fixtures are what an UNCONFIGURED
 * non-deployment gets.
 *
 * `runtime` DEFAULTS TO WHAT WAS REGISTERED, not to `null`, so the production
 * path and the test path are the same expression. A test that wants "an
 * unconfigured deployment" passes `null` for both arguments and gets the answer
 * a deployment gets, obtained the way a deployment gets it.
 *
 * `environment` IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME. It used to be
 * a `nodeEnv` string forwarded to `classify`, so a caller could name the
 * environment it wished to be treated as and be issued a real capability for it.
 * There is nothing to name now: the default is the parameterless mint, which
 * reads THIS process, and a caller cannot pass a non-`null` value it did not
 * receive from that mint.
 */
export function resolveCatalogMetadataSource(
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify(),
  runtime: CatalogIngestionRuntime | null = registeredCatalogIngestionRuntime()
): CatalogMetadataSourceResolution {
  if (runtime !== null) {
    const created = createCatalogIngestionSource(runtime);
    if (!created.ok) {
      return {
        status: "not-configured",
        reason: "catalog_metadata_source_configuration_refused",
        detail: `${created.reason}: ${created.detail}`
      };
    }
    return { status: "configured", source: created.source };
  }

  if (environment === null) {
    return { status: "not-configured", reason: "no_metadata_source_configured", detail: null };
  }

  return { status: "configured", source: demoCatalogSource(environment) };
}

/* -------------------------------------------------------------------------
 * THERE IS NO SECOND ACCESSOR.
 *
 * `resolveSynchronousCatalogMetadataSource` stood here. It answered the same
 * question for a caller that could not await, and it had exactly one production
 * caller: `findDemoTitleDetail` in `app/title/demo-title-details.ts`, which was
 * synchronous because `getTitleDetail` in `app/title/title-detail.ts` was. Both
 * are asynchronous now and read the accessor above, so this one had no
 * legitimate production consumer and was deleted rather than left as a refusal
 * path nothing calls.
 *
 * ITS TESTS ARE NOT LOST, THEY MOVED. What that suite proved -- that a
 * deployment is refused by name and never handed the fixtures, and that a
 * refusal is never an empty catalog -- is proved of the one remaining accessor,
 * against the same two inputs it could ever be handed: a classification this
 * process was really issued, and `null`.
 * ---------------------------------------------------------------------- */

