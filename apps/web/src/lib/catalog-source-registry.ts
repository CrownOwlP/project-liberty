import { NonDeploymentEnvironment } from "../app/api/deployment-environment";
import type { CatalogMetadataSource } from "./catalog-source";
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
 * THERE IS NO SYNCHRONOUS ACCESSOR HERE ANY MORE, and its removal is the end of
 * a wart rather than a loss. This module used to export `readFixtureCatalogItems`,
 * which reached `demoCatalogSource` directly instead of going through
 * `resolveCatalogMetadataSource`, because `getHomeCatalog` in `lib/catalog.ts`
 * was synchronous and `app/api/v1/catalog/home/route.ts` called it synchronously.
 * It could not state a reason -- on a deployment it answered `[]`, which the
 * route served as `{ rails: [] }` at 200, a claim about the catalog made by a
 * process with no catalog. The fix it named has landed: the route now awaits
 * `loadHomeCatalog`, and `app/api/v1/catalog/home/handler.ts` answers
 * `catalog_source_not_configured` with 503. With its one caller gone the
 * accessor had only test callers left, so it was deleted rather than kept alive
 * for them, and `getHomeCatalog` went with it.
 *
 * `resolveCatalogMetadataSource` is therefore the only way in, and its return
 * type is correctly async-capable. The one surface still needing a synchronous
 * answer -- `app/title/demo-title-details.ts` -- reaches `demoCatalogSource`
 * itself and says why; it could not have used this accessor in any case, because
 * `[]` on a deployment is the collapse of "refused" into "empty" that surface
 * exists to avoid.
 * ---------------------------------------------------------------------- */

/** Why no source answered. One value today; a union so a second one is additive. */
export type CatalogSourceUnavailableReason = "no_metadata_source_configured";

export type CatalogMetadataSourceResolution =
  | { readonly status: "configured"; readonly source: CatalogMetadataSource }
  | { readonly status: "not-configured"; readonly reason: CatalogSourceUnavailableReason };

/**
 * The metadata source for this process, or a stated reason there is none.
 *
 * The environment is read at CALL time and never at module scope, for the reason
 * `deployment-environment.ts` gives: a module-scope read freezes the answer to
 * whatever the process looked like when the first route was loaded, which in a
 * serverless cold start is not necessarily the request's environment.
 *
 * `nodeEnv` is a parameter so a test can state the environment it means instead
 * of mutating `process.env` and racing every other suite in the same worker.
 */
export function resolveCatalogMetadataSource(
  nodeEnv: string | undefined = process.env.NODE_ENV
): CatalogMetadataSourceResolution {
  const environment = NonDeploymentEnvironment.classify(nodeEnv);

  if (environment === null) {
    return { status: "not-configured", reason: "no_metadata_source_configured" };
  }

  return { status: "configured", source: demoCatalogSource(environment) };
}
