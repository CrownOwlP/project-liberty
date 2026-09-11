import { NonDeploymentEnvironment } from "../app/api/deployment-environment";
import type { CatalogMetadataSource, SynchronousCatalogMetadataSource } from "./catalog-source";
import { demoCatalogSource } from "./demo-catalog";

/* -------------------------------------------------------------------------
 * Which metadata source this process has
 *
 * THE ONE MODULE THAT KNOWS BOTH THE PORT AND AN IMPLEMENTATION. `catalog-source.ts`
 * imports no implementation and `demo-catalog.ts` imports no consumer, so this
 * is the single file a real provider lands in: give it a `CatalogMetadataSource`
 * and return it from `resolveCatalogMetadataSource`. Nothing on the discovery
 * surfaces changes.
 *
 * THERE IS NO REAL SOURCE. In a deployment this resolves to nothing at all, and
 * that is the honest answer rather than a gap being papered over -- serving
 * invented titles from a hosted build would present them to a reader as the
 * product's catalog. `not-configured` is a distinct outcome, exactly as it is in
 * `resolveAuthorizedCandidates`, so the operator's remedy ("configure a metadata
 * source") is legible instead of arriving as a blank page.
 *
 * TWO ACCESSORS, ONE COMPOSITION, AND THE SECOND ONE IS A NARROWING RATHER THAN
 * A SHORTCUT. `resolveCatalogMetadataSource` answers the port as published --
 * `listRecords` and `findRecord` may return a promise, which is what a real
 * provider needs. `resolveSynchronousCatalogMetadataSource` answers the same
 * question for a caller that cannot await, and today it is one caller:
 * `findDemoTitleDetail` in `app/title/demo-title-details.ts`, synchronous
 * because `getTitleDetail` in `app/title/title-detail.ts` is. Before this pair
 * existed that surface reached `demoCatalogSource` itself and classified the
 * environment itself, which made a second composition root out of a module whose
 * job is to render a page.
 *
 * THE GENERAL ACCESSOR DELEGATES TO THE NARROW ONE, so the two cannot disagree
 * about the environment gate -- the refusal branch and the construction are
 * written once, in the narrow accessor, and the general one adds nothing but the
 * wider return type. Each takes the capability its caller holds and only falls
 * back to classifying the process when given nothing, so one resolution
 * classifies at most once: the delegation below states the `environment`, which
 * re-enters no default.
 *
 * NEITHER ACCESSOR TAKES A RUNTIME NAME. Both used to take a `nodeEnv` they
 * forwarded to `classify`, which meant a hosted process could name the
 * environment it wished to be treated as and be issued a genuine capability for
 * it -- and the fixtures with it. They take the capability, or `null`, and the
 * only producer of a non-`null` one is a mint that reads the process and
 * declares no parameter. See `app/api/deployment-environment.ts`.
 *
 * The delegation is also the record of a fact rather than a design: the only
 * implementation that exists answers synchronously, because
 * it is an in-process fixture array. The published port stays async-capable
 * because a real provider does I/O; that the fixtures do not is a fact about the
 * fixtures.
 *
 * WHAT HAPPENS ON THE DAY A REAL SOURCE LANDS is decided by the type rather than
 * left to whoever makes the edit. A provider that does I/O is not assignable to
 * `SynchronousCatalogMetadataSource`, so returning it from the narrow accessor is
 * a COMPILE ERROR. At that point one of two things has to be written on purpose
 * and in view: the title surface becomes asynchronous and this accessor is
 * deleted (the migration `docs/CATALOG_SOURCE.md` records as outstanding), or the
 * refusal below gains a second reason naming the state honestly -- a source is
 * configured, and it cannot answer without awaiting. Neither can happen by
 * accident, and neither is pre-empted here.
 *
 * IT IS NOT THE ACCESSOR THAT WAS DELETED. This module used to export
 * `readFixtureCatalogItems`, which returned `readonly CatalogItem[]` and answered
 * `[]` on a deployment -- a claim about the catalog made by a process with no
 * catalog, which `app/api/v1/catalog/home/route.ts` then served as
 * `{ rails: [] }` at 200. It could not state a reason because its return type had
 * nowhere to put one. The pair below cannot make that mistake: both return the
 * same tagged union, a refusal is `not-configured` with a named reason, and there
 * is no value either of them can answer that a caller could mistake for an empty
 * catalog. The route now awaits `loadHomeCatalog` and
 * `app/api/v1/catalog/home/handler.ts` answers `catalog_source_not_configured`
 * with 503; `readFixtureCatalogItems` and `getHomeCatalog` are both gone.
 * ---------------------------------------------------------------------- */

/** Why no source answered. One value today; a union so a second one is additive. */
export type CatalogSourceUnavailableReason = "no_metadata_source_configured";

/**
 * A resolution, parameterised by how much the caller needs to know about the
 * source it gets back.
 *
 * WRITTEN ONCE RATHER THAN TWICE. The two exported resolutions below differ in
 * exactly one thing -- whether the configured source is the published port or its
 * synchronous narrowing -- and everything else about them, including the refusal
 * vocabulary, is the same fact. Two hand-written unions would be two places to
 * edit when a reason is added, and the failure mode is one of them being missed.
 */
type CatalogMetadataSourceResolutionOf<TSource extends CatalogMetadataSource> =
  | { readonly status: "configured"; readonly source: TSource }
  | { readonly status: "not-configured"; readonly reason: CatalogSourceUnavailableReason };

export type CatalogMetadataSourceResolution =
  CatalogMetadataSourceResolutionOf<CatalogMetadataSource>;

/**
 * What a caller that cannot await gets back.
 *
 * The refusal arm is IDENTICAL to the async-capable one, and deliberately so: a
 * synchronous caller and an asynchronous caller on the same process are refused
 * for the same reason, so the two surfaces cannot end up telling an operator
 * different stories about one deployment.
 */
export type SynchronousCatalogMetadataSourceResolution =
  CatalogMetadataSourceResolutionOf<SynchronousCatalogMetadataSource>;

/**
 * The metadata source for this process, or a stated reason there is none.
 *
 * The environment is classified at CALL time and never at module scope, for the
 * reason `deployment-environment.ts` gives: a default argument is evaluated per
 * call, while a module-scope read freezes the answer to whatever the process
 * looked like when the first route was loaded, which in a serverless cold start
 * is not necessarily the request's environment.
 *
 * `environment` IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME. It used to be
 * a `nodeEnv` string forwarded to `classify`, so a caller could name the
 * environment it wished to be treated as and be issued a real capability for it.
 * There is nothing to name now: the default is the parameterless mint, which
 * reads THIS process, and a caller cannot pass a non-`null` value it did not
 * receive from that mint. A test that wants the refusal passes `null` -- the
 * answer a deployment gets, obtained the way a deployment gets it.
 */
export function resolveCatalogMetadataSource(
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): CatalogMetadataSourceResolution {
  return resolveSynchronousCatalogMetadataSource(environment);
}

/**
 * The same question, answered for a caller that cannot await.
 *
 * WHY IT EXISTS. `findDemoTitleDetail` is synchronous because `getTitleDetail`
 * is, and a synchronous caller can only be served by a source that answers
 * synchronously. Without this accessor that surface had two bad options and took
 * the second: await something it cannot await, or reach `demoCatalogSource`
 * directly and classify the environment itself. The second is what it did, and it
 * put a second module in this repository that knew both the port and an
 * implementation.
 *
 * WHAT IT PROMISES IS NARROWER THAN THE PORT AND NOT WIDER. It can only ever
 * return a source that satisfies `SynchronousCatalogMetadataSource`; it cannot
 * wrap, buffer or block on an asynchronous one, because a synchronous answer
 * extracted from a promise is either a stale answer or a deadlock. When there is
 * no source it REFUSES BY NAME. It never answers an empty catalog: "this process
 * has no metadata source" and "the catalog contains nothing" have different
 * remedies, and a caller handed `[]` cannot tell which one it is looking at.
 *
 * `demoCatalogSource` REQUIRES A `NonDeploymentEnvironment`, and this function is
 * handed one or `null`, so there is no expression here that reaches the fixtures
 * without handling that `null` -- deleting the check is a compile error rather
 * than a silent widening.
 *
 * THE CAPABILITY CANNOT BE ASKED FOR BY NAME, which is what makes the branch
 * below a gate rather than a formality. Its brand is a `unique symbol` private to
 * `@liberty/contracts/shared/runtime`, so no consumer can write one; its only
 * producer is `classifyRuntime`, which declares no parameter and classifies the
 * process it is running in; and the default below is this app's one-line door to
 * that mint. A deployment therefore arrives here with `null`, because `null` is
 * the only thing the mint will give it. That control now runs in one place for
 * every discovery surface, which is the point of both accessors living here.
 */
export function resolveSynchronousCatalogMetadataSource(
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): SynchronousCatalogMetadataSourceResolution {
  if (environment === null) {
    return { status: "not-configured", reason: "no_metadata_source_configured" };
  }

  return { status: "configured", source: demoCatalogSource(environment) };
}
