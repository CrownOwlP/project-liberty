import type { ExternalRef, SourceWorkRef } from "./identity";
import type { IngestedWork } from "./record";

/* -------------------------------------------------------------------------
 * The provider adapter boundary -- and the fact that nothing stands behind it
 *
 * THIS IS THE PORT A REAL METADATA PROVIDER IMPLEMENTS, and PL-0305 deliberately
 * ships it with NO IMPLEMENTATION. `resolveCatalogMetadataProvider` at the foot
 * of this file answers `not-configured` unconditionally, and that is the honest
 * state of this repository rather than a stub waiting to be filled in.
 *
 * WHY NOTHING IS WIRED. Choosing where a product's catalog comes from is a
 * LICENSING decision, and attaching a key to it is a CREDENTIALS decision.
 * `control/policies.json` lists both under `escalation.humanOnly`, so neither is
 * an engineering default and neither can be taken here. PL-0305's own task
 * record says the same thing in the same words. `docs/CATALOG_SOURCE.md` carries
 * the evidenced shortlist the commander would be deciding between; this module
 * carries the shape whichever one is chosen has to fit.
 *
 * WHAT A "NOT CONFIGURED" ANSWER IS FOR. It is the same control the catalog port
 * in `apps/web` already applies: a named refusal rather than an empty list, so
 * "this deployment has no provider" never arrives looking like "the catalog is
 * empty". Those have different remedies and a caller handed `[]` cannot tell
 * which it is looking at.
 *
 * ==========================================================
 * WHO OWNS PAGING, SEARCH AND RANKING -- part of the contract
 * ==========================================================
 *
 * `docs/CATALOG_SOURCE.md` names this as a contract question rather than an
 * implementation detail, because getting it wrong is invisible until the catalog
 * is too big to list. The division here:
 *
 *   - PAGING IS ALWAYS THE PROVIDER'S. `fetchPage` takes a cursor the provider
 *     issued and returns the next one. The ingestion side never computes an
 *     offset, because an offset over a collection the provider is concurrently
 *     editing skips and repeats records, and a cursor is the only shape that
 *     does not.
 *   - PROVIDER-SIDE SEARCH IS OPTIONAL AND DECLARED. A provider that can search
 *     says so in `capabilities.providerSideSearch` and implements `searchWorks`.
 *     One that cannot does neither, and `searchWorks` is then never called --
 *     `requireProviderSideSearch` below is the check, and it refuses by name
 *     rather than falling back to listing the whole source and filtering it,
 *     which is the shape only six fixtures can afford.
 *   - RELEVANCE RANKING IS THE PROVIDER'S WHEN IT SEARCHES, AND THE PLATFORM'S
 *     OTHERWISE. A provider that ran the query is the only party that knows why
 *     a result matched, so re-ranking its output here would be a second opinion
 *     with less information. Order is therefore preserved exactly as returned.
 *     When the platform searches its own store, the platform ranks.
 *
 * NOTHING HERE FETCHES. A provider adapter is handed its transport; see
 * `transport.ts` for the only one this package offers and why it is not `fetch`.
 * ---------------------------------------------------------------------- */

/**
 * A record exactly as a provider hands it over, BEFORE validation.
 *
 * `raw` is `unknown` on purpose and must stay that way. This is the parse
 * boundary for untrusted third-party I/O: typing it as a record shape would be
 * an assertion about a payload nobody has checked, and every field access after
 * that would compile while being a lie. `ingest.ts` parses it with
 * `ingestedWorkSchema` and refuses what does not fit.
 */
export interface RawProviderRecord {
  readonly nativeId: string;
  readonly sourceRevision: string | null;
  readonly crossRefs: readonly ExternalRef[];
  readonly raw: unknown;
}

export interface ProviderPageRequest {
  /** `null` starts at the beginning. Anything else is a cursor this provider issued. */
  readonly cursor: string | null;
  readonly pageSize: number;
  /**
   * Ask only for records the provider says changed since this instant.
   *
   * Honoured only when `capabilities.incrementalSince` is true; a provider
   * without it MUST ignore the field rather than pretend, because a provider
   * that silently ignores it while the caller believes it worked produces a
   * "complete" pass that saw a fraction of the source -- and would then tombstone
   * everything else. `ingest.ts` will not mint tombstones from an incremental
   * pass for exactly this reason.
   */
  readonly changedSince: string | null;
}

export type ProviderFetchFailure =
  | "provider_unreachable"
  | "provider_rejected_request"
  | "provider_rate_limited"
  | "provider_response_malformed";

export type ProviderPageResult =
  | {
      readonly ok: true;
      readonly records: readonly RawProviderRecord[];
      /** `null` means this was the last page. */
      readonly nextCursor: string | null;
      /**
       * Ids the provider says were DELETED since `changedSince`.
       *
       * Only a provider with `capabilities.reportsDeletions` may return a
       * non-empty list. It is the strong form of a tombstone -- the source said
       * so -- as opposed to the inferred form `ingest.ts` derives from a
       * complete pass.
       */
      readonly withdrawn: readonly string[];
    }
  | { readonly ok: false; readonly reason: ProviderFetchFailure; readonly detail: string };

export type ProviderSearchResult =
  | {
      readonly ok: true;
      /** In the provider's relevance order. Never re-sorted by this package. */
      readonly records: readonly RawProviderRecord[];
      readonly nextCursor: string | null;
    }
  | { readonly ok: false; readonly reason: ProviderFetchFailure; readonly detail: string };

/**
 * What this provider can actually do.
 *
 * DECLARED RATHER THAN PROBED. The alternative -- call the method and see what
 * happens -- turns a missing capability into a runtime failure on a user's
 * search, and a provider that answers a `changedSince` it does not implement by
 * ignoring it is indistinguishable from one that implements it and found no
 * changes. A declaration is checkable before anything is called.
 */
export interface ProviderCapabilities {
  readonly providerSideSearch: boolean;
  readonly incrementalSince: boolean;
  readonly reportsDeletions: boolean;
  /**
   * The largest page this provider will serve. `ingest.ts` clamps to it rather
   * than sending a larger number and hoping -- a provider that silently caps a
   * request to its own maximum, and one that errors, are both possible, and the
   * first would make a pass quietly slower per page than the caller believes.
   */
  readonly maxPageSize: number;
}

/**
 * A catalog metadata provider.
 *
 * `searchWorks` is optional at the TYPE level and conditional at the CAPABILITY
 * level, and both are needed: the optional method is what lets an adapter omit
 * it, and the capability flag is what lets a caller know before calling.
 */
export interface CatalogMetadataProvider {
  readonly sourceId: string;
  readonly capabilities: ProviderCapabilities;
  fetchPage(request: ProviderPageRequest): Promise<ProviderPageResult>;
  searchWorks?(query: string, cursor: string | null, pageSize: number): Promise<ProviderSearchResult>;
}

/**
 * A work the ingestion side has accepted, with its provenance.
 *
 * Declared here rather than in `record.ts` because it is the shape the PROVIDER
 * boundary produces, not the shape a source states -- `ingest.ts` builds it and
 * nothing outside this package's own pipeline constructs one.
 */
export interface AcceptedWork {
  readonly work: IngestedWork;
  readonly ref: SourceWorkRef;
  readonly crossRefs: readonly ExternalRef[];
  readonly observedAt: string;
  readonly sourceRevision: string | null;
}

export type ProviderSearchRefusal = "provider_side_search_not_supported";

/**
 * Guards the optional capability at its one call site.
 *
 * Returns the method rather than a boolean, so a caller that got past the check
 * holds something callable and there is no second, unchecked path to the same
 * method. A boolean would leave `provider.searchWorks?.(...)` written somewhere,
 * and the `?.` would silently answer `undefined` on the day the two disagree.
 */
export function requireProviderSideSearch(
  provider: CatalogMetadataProvider
):
  | {
      readonly ok: true;
      readonly search: NonNullable<CatalogMetadataProvider["searchWorks"]>;
    }
  | { readonly ok: false; readonly reason: ProviderSearchRefusal } {
  const search = provider.searchWorks;
  if (!provider.capabilities.providerSideSearch || search === undefined) {
    return { ok: false, reason: "provider_side_search_not_supported" };
  }
  return { ok: true, search: search.bind(provider) };
}

/**
 * Why this build has no catalog metadata provider.
 *
 * A union with one member so a second reason is additive, the same shape
 * `CatalogSourceUnavailableReason` uses in `apps/web`. The name states the
 * actual blocker: not "unimplemented", not "coming soon" -- no provider has been
 * licensed, and licensing is a decision this repository's policy reserves to the
 * human commander.
 */
export type CatalogProviderUnavailableReason = "no_catalog_provider_licensed";

export type CatalogMetadataProviderResolution =
  | { readonly status: "configured"; readonly provider: CatalogMetadataProvider }
  | { readonly status: "not-configured"; readonly reason: CatalogProviderUnavailableReason };

/**
 * The provider this build has. There is none.
 *
 * THIS FUNCTION IS THE COMPOSITION ROOT OF THE INGESTION PACKAGE and it is
 * intentionally the only place a provider could be named. It takes no
 * configuration argument, reads no environment variable and consults no file,
 * which is the point: there is no value an operator could set today that would
 * make it answer anything else, so nothing about this build's catalog can be
 * changed by configuration alone.
 *
 * WHAT WOULD CHANGE ON THE DAY A PROVIDER IS CHOSEN, so the next engineer is not
 * guessing:
 *
 *   1. A commander decision recorded against the Licensing escalation category,
 *      naming the source and what its terms permit. `docs/CATALOG_SOURCE.md`
 *      has the shortlist and the evidence.
 *   2. If that source needs a key: a Credentials escalation, and a secret
 *      delivered through whatever `apps/web`'s environment loader is extended to
 *      carry. Note `docs/DEVELOPMENT.md` -- `apps/web` reads dotenv from
 *      `apps/web/`, not the repository root. NO ENVIRONMENT VARIABLE IS READ
 *      HERE and none is invented: a placeholder that looks like a real key is
 *      worse than an absence, because it makes an unconfigured build look
 *      configured.
 *   3. An adapter implementing `CatalogMetadataProvider`, constructed over the
 *      transport in `transport.ts` -- which is the existing PL-0304 egress
 *      boundary and not a new one -- and an entry added to the operator's
 *      `EgressPolicy.allowedHosts`, without which it fetches nothing.
 *   4. This function returns it.
 */
export function resolveCatalogMetadataProvider(): CatalogMetadataProviderResolution {
  return { status: "not-configured", reason: "no_catalog_provider_licensed" };
}
