import type { ManifestFetchDependencies } from "@liberty/media-inspection";
import type { ExternalRef, SourceWorkRef } from "./identity";
import type { IngestedWork } from "./record";
import type { CatalogDocumentOptions } from "./transport";
import { createWikidataProvider, type WikidataConfigRefusal, type WikidataRightsRegister, type WikidataSelection } from "./wikidata";
import { WIKIDATA_SOURCE_ID } from "./wikidata-query";

/* -------------------------------------------------------------------------
 * The provider adapter boundary, and the one source that now stands behind it
 *
 * THIS IS THE PORT A REAL METADATA PROVIDER IMPLEMENTS. In round 44 it shipped
 * with NO IMPLEMENTATION, because choosing where a product's catalog comes from
 * is a LICENSING decision that `control/policies.json` reserves to the human
 * commander. THAT DECISION HAS SINCE BEEN TAKEN -- Wikidata, 2026-09-17, as an
 * initial source choice and not an exclusive mandate -- and
 * `resolveCatalogMetadataProvider` at the foot of this file now composes an
 * adapter for it. The composition root section down there carries the decision's
 * scope limits in full, because they are the part a reader is most likely to
 * skip and most likely to get wrong.
 *
 * EVERYTHING BETWEEN HERE AND THERE IS UNCHANGED BY THAT, deliberately. The port
 * has no Wikidata-shaped field, no Wikidata vocabulary and no knowledge that an
 * adapter exists; `wikidata.ts` imports FROM this file and nothing in this
 * section imports from it. A second source joins or replaces the first without
 * any of these types moving.
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

/* -------------------------------------------------------------------------
 * THE COMPOSITION ROOT -- AND IT NOW HAS SOMETHING TO COMPOSE
 *
 * PL-0305 shipped this file in round 44 with `resolveCatalogMetadataProvider`
 * answering `not-configured` unconditionally, because choosing a catalog source
 * is a LICENSING decision and `control/policies.json` reserves Licensing to the
 * human commander. THAT DECISION HAS BEEN TAKEN. It is recorded on the task as
 * `licensingDecision` and in `control/events.jsonl` as a `decision.licensing`
 * event dated 2026-09-17: WIKIDATA IS THE INITIAL CATALOG METADATA SOURCE,
 * chosen because it needs no credential and keeps this seam replaceable.
 *
 * THE SCOPE OF THAT DECISION IS PART OF IT, and this module is built to the
 * scope rather than to the headline:
 *
 *   - It is an INITIAL SOURCE CHOICE AND NOT AN EXCLUSIVE OR PERMANENT SOURCE
 *     MANDATE, in the decision's own words. So the resolver below is a REGISTRY
 *     OVER LICENSED SOURCES that happens to have one entry, not a function that
 *     returns the Wikidata provider. A caller names the source it wants; a name
 *     that is not licensed is refused BY NAME. Nothing in `ingest.ts`,
 *     `project.ts`, `identity.ts`, `freshness.ts` or `safety.ts` mentions
 *     Wikidata, and the port above is byte-for-byte what it was before the
 *     adapter existed.
 *   - NO CREDENTIALED SOURCE IS AUTHORISED. TMDB and everything else needing an
 *     API key remains a separate Credentials escalation. There is still no
 *     environment variable read anywhere in this package and still no
 *     placeholder credential, and `resolveCatalogMetadataProvider({ sourceId:
 *     "tmdb", ... })` answers `no_catalog_provider_licensed` -- which is what
 *     keeps that refusal reachable, and therefore testable, rather than dead.
 *   - NOTHING IS DECIDED ABOUT THE EU/UK SUI GENERIS DATABASE RIGHT. It applies
 *     to Wikidata as much as to any other candidate and it is for counsel. It is
 *     recorded in `docs/CATALOG_SOURCE.md` as open; no code here can settle it.
 *   - ONLY WIKIDATA'S CC0 POSITION ON STRUCTURED DATA IN THE MAIN, PROPERTY AND
 *     LEXEME NAMESPACES WAS EVIDENCED. Text elsewhere is CC BY-SA. That line is
 *     enforced in `wikidata-query.ts` -- a frozen host set, an entity-id pattern
 *     admitting only those three namespaces, no federated `SERVICE` clause, and
 *     no request for any image, sitelink or article extract -- and the
 *     construction below refuses a runtime whose egress allowlist could reach
 *     anything else.
 *
 * WHAT THE RESOLVER TAKES, AND WHY THAT IS NOT A LICENSING KNOB. The round-44
 * version declared no parameter, and its test asserted the arity, on the ground
 * that nothing an operator could set should change what this build's catalog is.
 * That property is PRESERVED and is now the thing worth testing: the runtime
 * below carries a transport, an egress policy, a User-Agent, a rights register
 * and which slice of the source to read -- deployment facts, all of which a
 * deployment must supply and none of which can change WHICH SOURCE answers. The
 * source is decided by `sourceId` against a list of licensed names, and a
 * runtime cannot add to that list.
 * ---------------------------------------------------------------------- */

/**
 * The names this repository has a licensing decision for.
 *
 * ONE ENTRY, AND THE SHAPE IS A LIST BECAUSE THE DECISION SAID SO. Frozen, and
 * walked by index rather than through `Array.prototype.includes` for the reason
 * `packages/contracts/src/shared/runtime.ts` gives about its own allowlist: a
 * single assignment to that writable prototype property would make the check
 * answer `true` for a source nobody licensed while the frozen array stayed
 * correct.
 */
export const LICENSED_CATALOG_SOURCE_IDS: readonly string[] = Object.freeze([
  WIKIDATA_SOURCE_ID
]);

export function isLicensedCatalogSourceId(sourceId: string): boolean {
  for (let index = 0; index < LICENSED_CATALOG_SOURCE_IDS.length; index += 1) {
    if (LICENSED_CATALOG_SOURCE_IDS[index] === sourceId) return true;
  }
  return false;
}

/**
 * Why this build has no catalog metadata provider.
 *
 * `no_catalog_provider_licensed` SURVIVES THE DECISION rather than being
 * deleted by it. Wikidata is licensed; nothing else is, and a deployment that
 * asks for anything else has to be told that in those words -- including a
 * deployment that asks for a keyed source, which is the escalation the decision
 * explicitly did not grant.
 *
 * `catalog_provider_configuration_refused` is the new one: the source IS
 * licensed and this runtime cannot be composed over it. Separate from the first
 * because the remedies are opposite -- one needs a human decision, the other
 * needs a corrected deployment -- and a single reason would send an operator
 * to the wrong one.
 */
export type CatalogProviderUnavailableReason =
  | "no_catalog_provider_licensed"
  | "catalog_provider_configuration_refused";

/**
 * Everything a deployment must supply to reach a licensed source.
 *
 * NONE OF IT DECIDES WHICH SOURCE ANSWERS. `sourceId` selects among licensed
 * names and the rest is how to reach the one selected: the egress policy, the
 * limits, the required User-Agent, the transport for the runtime being composed
 * for, which slice of the source to read, and the operator's rights register.
 * There is no field here a caller could set to introduce a source, and no field
 * that carries a credential -- see `docs/CATALOG_SOURCE.md` on why a
 * placeholder for one would be worse than its absence.
 */
export interface CatalogProviderRuntime {
  /** Which licensed source to compose. */
  readonly sourceId: string;
  readonly selection: WikidataSelection;
  readonly document: CatalogDocumentOptions;
  readonly transport: ManifestFetchDependencies;
  /**
   * The operator's rights register.
   *
   * REQUIRED WITH NO DEFAULT. `noRightsBasisEstablished` is the honest answer
   * for an operator who holds no register, and it must be passed by name:
   * inheriting it would make "we have not done the rights work" a silent state
   * rather than a stated one. It refuses every record.
   */
  readonly rightsRegister: WikidataRightsRegister;
}

export type CatalogMetadataProviderResolution =
  | { readonly status: "configured"; readonly provider: CatalogMetadataProvider }
  | {
      readonly status: "not-configured";
      readonly reason: "no_catalog_provider_licensed";
      readonly detail: string;
    }
  | {
      readonly status: "not-configured";
      readonly reason: "catalog_provider_configuration_refused";
      readonly refusal: WikidataConfigRefusal;
      readonly detail: string;
    };

/**
 * The provider this deployment has, or a named reason it has none.
 *
 * THE SEAM IS UNCHANGED BY THE FACT THAT SOMETHING NOW STANDS BEHIND IT. This is
 * still the only place in the package a provider is named, `ingest.ts` still
 * takes one as an argument and knows nothing about where it came from, and a
 * second licensed source is one entry in `LICENSED_CATALOG_SOURCE_IDS` plus one
 * branch here.
 *
 * WHAT THIS STILL DOES NOT DO: read an environment variable, read a file,
 * consult a default, or hold a credential. A deployment that passes no runtime
 * gets no provider, and there is no ambient configuration that could supply one.
 *
 * IT IS WIRED NOW, AND THIS PARAGRAPH USED TO SAY IT WAS NOT. `apps/web`
 * declares a dependency on this package, `apps/web/src/lib/catalog-ingestion-
 * source.ts` projects the answer of a pass over this provider into the
 * application's `CatalogMetadataSource`, and `resolveCatalogMetadataSource`
 * returns that source when a deployment supplies a runtime. The consumer
 * imports the package's PUBLIC API and never `wikidata.ts`, so this seam did not
 * move in order to be consumed.
 *
 * WHAT IS STILL NOT WIRED: nothing calls this on a schedule, and nothing
 * persists what a pass accepts. The application's adapter runs a pass per query,
 * which is honest but is not an ingestion worker; `docs/CATALOG_SOURCE.md`
 * records both as outstanding.
 */
export function resolveCatalogMetadataProvider(
  runtime: CatalogProviderRuntime
): CatalogMetadataProviderResolution {
  if (!isLicensedCatalogSourceId(runtime.sourceId)) {
    return {
      status: "not-configured",
      reason: "no_catalog_provider_licensed",
      detail: `no licensing decision names ${runtime.sourceId} as a catalog metadata source`
    };
  }

  const created = createWikidataProvider({
    selection: runtime.selection,
    document: runtime.document,
    transport: runtime.transport,
    rightsRegister: runtime.rightsRegister
  });
  if (!created.ok) {
    return {
      status: "not-configured",
      reason: "catalog_provider_configuration_refused",
      refusal: created.reason,
      detail: created.detail
    };
  }
  return { status: "configured", provider: created.provider };
}
