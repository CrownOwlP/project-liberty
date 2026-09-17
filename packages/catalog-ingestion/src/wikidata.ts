import { z } from "zod";
import type { ManifestFetchDependencies } from "@liberty/media-inspection";
import { deriveNormalizedContentId, type ExternalRef } from "./identity";
import type {
  CatalogMetadataProvider,
  ProviderCapabilities,
  ProviderFetchFailure,
  ProviderPageRequest,
  ProviderPageResult,
  ProviderSearchResult,
  RawProviderRecord
} from "./provider";
import type { IngestedRightsBasis, IngestedWorkKind, LocalizedText } from "./record";
import { fetchCatalogDocument, type CatalogDocumentFailure, type CatalogDocumentOptions } from "./transport";
import {
  CC0_ITEM_ID_PATTERN,
  RECORD_SEPARATOR,
  UNIT_SEPARATOR,
  WIKIDATA_ACTION_API_ENDPOINT,
  WIKIDATA_SOURCE_ID,
  WIKIDATA_SPARQL_ENDPOINT,
  buildHydrationRequestUrl,
  buildPageRequestUrl,
  buildSearchRequestUrl,
  checkWikidataUserAgent,
  isWikidataCc0Host,
  type QueryBuildRefusal,
  type UserAgentRefusal
} from "./wikidata-query";

/* -------------------------------------------------------------------------
 * The Wikidata adapter: one implementation of `CatalogMetadataProvider`
 *
 * WHAT IT IS. The first real metadata source this repository has, behind the
 * port unchanged, composed over the PL-0304 egress boundary in `transport.ts`
 * rather than over a second fetcher. `wikidata-query.ts` holds every request it
 * can make and the CC0/CC BY-SA rules those requests are bound by; this file
 * holds the reading, the projection and the provider itself.
 *
 * WHAT IT IS NOT. It is not "the catalog". The licensing decision it implements
 * is recorded in its own words as an INITIAL SOURCE CHOICE AND NOT AN EXCLUSIVE
 * OR PERMANENT SOURCE MANDATE, and the port is untouched, so a second adapter
 * joins or replaces this one without anything upstream of `resolveCatalogMetadata
 * Provider` noticing. Nothing in `ingest.ts`, `project.ts`, `identity.ts`,
 * `freshness.ts` or `safety.ts` mentions Wikidata.
 *
 * ==================================================================
 * WHAT THIS PROVIDER HONESTLY CANNOT DO -- the capability declaration
 * ==================================================================
 *
 * `provider.ts` requires capabilities to be DECLARED rather than probed, and
 * three of the four declarations below are negative. Each one is a limitation of
 * the source or of this adapter, measured against the live endpoints on
 * 2026-09-17, not a placeholder:
 *
 *   - `incrementalSince: false`. The provider therefore MUST ignore
 *     `changedSince`, and it does -- `buildPageRequestUrl` has no parameter for
 *     it and the field is not read. Wikidata does record modification times, but
 *     not in the Query Service's default graph: `schema:version` and
 *     `schema:dateModified` against the entity IRI bind nothing there (tried,
 *     empty result). They are on the Action API's `wbgetentities` response, at a
 *     measured ~206 KB per entity with `props=info|labels|descriptions|claims`
 *     -- 50 entities is ~10 MB against a 4 MB body cap -- so this adapter does
 *     not pay that cost and does not claim the capability. `ingest.ts` withholds
 *     tombstones from any pass with `changedSince` set, whatever the provider
 *     says, so a caller that sets it anyway still cannot delete a catalog.
 *   - `reportsDeletions: false`. `withdrawn` is always empty. Wikidata deletions
 *     are visible through `list=logevents`, which is a different API, a
 *     different pagination model and a different failure mode; claiming the
 *     capability without implementing it would let `ingest.ts` mint
 *     `withdrawn_by_source` tombstones from a field nothing populates.
 *   - `sourceRevision: null` on every record, for the same reason
 *     `incrementalSince` is false. The port says a revision is compared for
 *     equality only, never ordered; `null` means "this source did not say", and
 *     a consumer therefore cannot tell whether a record changed between passes.
 *     That is a real gap and it is the price of one cheap request per page.
 *   - `providerSideSearch: true` is the one positive declaration, and it is
 *     narrower than it sounds: see `searchWorks`.
 *
 * ===================================================
 * WHAT WIKIDATA SAYS ABOUT RIGHTS: NOTHING USABLE YET
 * ===================================================
 *
 * A Wikidata item states that a film EXISTS. It does not state that this
 * operator may show it. Those are different facts and only the operator's own
 * rights register holds the second, so `rights` on every record built here comes
 * from an INJECTED register and from nowhere else. `noRightsBasisEstablished` is
 * the shipped default behaviour a caller must ask for by name, it answers `null`
 * for every work, and `checkRightsBasis` in `safety.ts` then refuses every
 * record with `rights_basis_not_declared`.
 *
 * SO A DEFAULT COMPOSITION OF THIS PROVIDER PUBLISHES NOTHING, AND THAT IS THE
 * CORRECT OUTCOME rather than a bug to work around. The rights machinery is in
 * the path, applied to real records, and it fails closed on all of them.
 *
 * `P6216` (copyright status) IS READ AND IS NOT INTERPRETED. The register
 * receives the raw QIDs as opaque tokens -- `Q19652` and the rest are never
 * mapped to `public-domain` here -- because turning a crowd-edited statement
 * into a rights basis is a rights decision, and the licensing decision recorded
 * on this task does not cover it. An operator who wants to rely on it writes
 * that mapping in their own register, where a rights reviewer can see it. The
 * observation is offered so that decision is POSSIBLE without being taken here.
 *
 * ===========================================
 * WHY THE MEDIA-ADDRESS SCAN EARNS ITS KEEP
 * ===========================================
 *
 * `acceptRecord` in `ingest.ts` scans the RAW payload before zod parses it. On
 * a fixture provider that ordering is a precaution. On this one it is a live
 * control, because a Wikidata label, description or genre name is a field ANY
 * LOGGED-IN PERSON ON THE INTERNET CAN EDIT. A vandalised label reading
 * `https://cdn.example.test/x.m3u8` arrives here as an ordinary title string,
 * passes `localizedTextSchema` (which only requires a non-empty string), and
 * would be published as a work's name. The pre-parse scan refuses the record by
 * name instead. That is the first time in this repository that the scan has an
 * untrusted writer behind it.
 *
 * NO MEDIA ADDRESS IS REQUESTED, EITHER. No image property, no sitelink, no
 * Commons file: see `wikidata-query.ts`. The two controls are independent --
 * one bounds what is asked for, the other checks what arrives.
 * ---------------------------------------------------------------------- */

/**
 * What the register is told about a work, and nothing more.
 *
 * DELIBERATELY NOT THE WHOLE RECORD. A register that could see titles and
 * genres would be able to decide rights from a title, which is the fuzzy
 * matching `identity.ts` refuses one layer up and is worse here because the
 * output is a rights basis. What it gets is identity -- the ids -- plus the
 * source's own uninterpreted copyright-status tokens.
 */
export interface WikidataRightsObservation {
  /** The Wikidata item id, e.g. `Q83495`. */
  readonly entityId: string;
  /** The id this repository will know the work by. */
  readonly contentId: string;
  /**
   * `P6216` values as raw entity ids. NEVER interpreted by this package.
   *
   * Empty for the overwhelming majority of items: the property is rare on films
   * (absent from every one of the four real records this package ships as
   * fixtures).
   */
  readonly copyrightStatusEntityIds: readonly string[];
  /** Third-party identifiers the item cites, e.g. an IMDb id. */
  readonly crossRefs: readonly ExternalRef[];
}

/**
 * The operator's rights register, as a function.
 *
 * REQUIRED WITH NO DEFAULT, on exactly the argument `transport.ts` makes for
 * `userAgent`: a default here would be a rights position this package chose on
 * an operator's behalf, and the safe-looking default (`null` for everything) is
 * still a position -- it is just one that should be stated rather than inherited.
 * `noRightsBasisEstablished` is that position, available by name.
 */
export type WikidataRightsRegister = (
  observation: WikidataRightsObservation
) => IngestedRightsBasis | null;

/**
 * The register for an operator who holds no rights register.
 *
 * Every work gets `null`, `safety.ts` refuses every work, and the catalog is
 * empty with a named reason per record. Named rather than implicit so that
 * "we have not done the rights work" is something a composition root SAYS.
 */
export const noRightsBasisEstablished: WikidataRightsRegister = () => null;

/**
 * Which slice of Wikidata is being ingested.
 *
 * `kind` IS DECLARED, NOT DERIVED FROM THE CLASS. Wikidata has dozens of film
 * and series classes and their relationship to this repository's three-value
 * `IngestedWorkKind` is a mapping somebody has to own; deriving it from a table
 * in here would put that mapping in a package that cannot see the product
 * decision behind it. So a selection pairs one class with one kind, and an
 * operator who wants films and series runs two selections.
 *
 * THE KIND ALSO DECIDES WHICH QUANTITY IS CARRIED. `catalogItemSchema` is a
 * discriminated union: a movie has a runtime and no episode count, a series has
 * an episode count and no runtime. Wikidata states `P2047` (duration) on series
 * too -- it is the length of one EPISODE -- so carrying it for a series would
 * publish "The Simpsons, 22 minutes". The kind decides, the data does not.
 */
export interface WikidataSelection {
  /** The class whose instances are enumerated, e.g. `Q11424` (film). */
  readonly classQid: string;
  readonly kind: IngestedWorkKind;
  /** Locales to request, most preferred first. At least one. */
  readonly locales: readonly string[];
}

export interface WikidataProviderConfig {
  readonly selection: WikidataSelection;
  /**
   * Transport options, including the REQUIRED `userAgent`.
   *
   * `egress.allowedHosts` is checked against `WIKIDATA_CC0_HOSTS` at
   * construction and the provider refuses to exist if it names anything else.
   */
  readonly document: CatalogDocumentOptions;
  readonly transport: ManifestFetchDependencies;
  readonly rightsRegister: WikidataRightsRegister;
}

export type WikidataConfigRefusal =
  | QueryBuildRefusal
  | UserAgentRefusal
  | "egress_allows_a_host_outside_the_cc0_namespaces"
  | "egress_does_not_allow_the_wikidata_endpoints";

/**
 * The capabilities, as one frozen value.
 *
 * `maxPageSize` is 50 because that is the number the source itself uses: the
 * Action API's anonymous batch limit is 50 entities, and a measured WDQS page of
 * this shape costs about 1.5 KB per row, so 50 rows is ~75 KB against
 * `CATALOG_DOCUMENT_LIMITS.maxResponseBytes` of 4 MB. `ingest.ts` clamps to it.
 */
export const WIKIDATA_CAPABILITIES: ProviderCapabilities = Object.freeze({
  providerSideSearch: true,
  incrementalSince: false,
  reportsDeletions: false,
  maxPageSize: 50
});

/* -------------------------------------------------------------------------
 * Reading the two responses
 * ---------------------------------------------------------------------- */

/**
 * The SPARQL 1.1 Query Results JSON shape, as much of it as is read.
 *
 * PARSED, NOT ASSERTED. `fetchCatalogDocument` answers `unknown` because it is
 * the parse boundary, and this is the parse. A response that does not fit
 * becomes `provider_response_malformed` rather than a pile of `undefined`s that
 * each turn into a refused record with a misleading reason.
 *
 * `.passthrough()` is NOT used anywhere in this file, so an unexpected column --
 * one a future edit to the query added and forgot to read -- is dropped at the
 * boundary rather than carried into `raw`. That matters more here than usual: a
 * dropped column is a missing feature, whereas a carried one is a field nobody
 * reviewed arriving in a catalog payload.
 */
const sparqlCellSchema = z.object({
  type: z.string(),
  value: z.string()
});

const sparqlResponseSchema = z.object({
  head: z.object({ vars: z.array(z.string()) }),
  results: z.object({ bindings: z.array(z.record(z.string(), sparqlCellSchema)) })
});

/**
 * `wbsearchentities`, read for ids and for its continuation and nothing else.
 *
 * The real response also carries `url`, `concepturi`, `label`, `description` and
 * a `display` block. None is read. The ids go back through the SAME hydration
 * query the enumeration uses, so a searched record and a paged record are built
 * by one code path -- which is what stops search from becoming a second, less
 * checked way into the catalog.
 */
const searchResponseSchema = z.object({
  search: z.array(z.object({ id: z.string() })),
  "search-continue": z.number().int().nonnegative().optional()
});

const cell = (
  row: Readonly<Record<string, { readonly value: string }>>,
  name: string
): string | undefined => row[name]?.value;

/**
 * Unpacks one `GROUP_CONCAT` cell into locale-tagged entries.
 *
 * SORTED, and the sort is load-bearing rather than cosmetic. SPARQL does not
 * specify the order `GROUP_CONCAT` produces, so two passes over an unchanged
 * item could produce two differently ordered title arrays -- and this package
 * cares about that: `identity.ts` argues at length that two passes must produce
 * the same catalog so that a diff between runs means something. Sorting by
 * locale then value makes the record a function of the item rather than of the
 * query engine's mood.
 */
const unpackLocalized = (packed: string | undefined): LocalizedText[] => {
  if (packed === undefined || packed.length === 0) return [];
  const seen = new Set<string>();
  const entries: LocalizedText[] = [];
  for (const chunk of packed.split(UNIT_SEPARATOR)) {
    const boundary = chunk.indexOf(RECORD_SEPARATOR);
    if (boundary <= 0) continue;
    const locale = chunk.slice(0, boundary);
    const value = chunk.slice(boundary + 1);
    if (value.length === 0) continue;
    const key = `${locale}${RECORD_SEPARATOR}${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ locale, value });
  }
  entries.sort((left, right) =>
    left.locale === right.locale
      ? left.value < right.value
        ? -1
        : left.value > right.value
          ? 1
          : 0
      : left.locale < right.locale
        ? -1
        : 1
  );
  return entries;
};

const unpackTokens = (packed: string | undefined): string[] => {
  if (packed === undefined || packed.length === 0) return [];
  const tokens = [...new Set(packed.split(UNIT_SEPARATOR).filter((token) => token.length > 0))];
  tokens.sort();
  return tokens;
};

/**
 * A numeric cell, or `undefined`.
 *
 * `undefined` rather than a guess: an absent or unreadable release year leaves
 * the field off the payload, `ingestedWorkSchema` refuses it, and the refusal
 * names `releaseYear`. Defaulting to `0` or to the current year would publish a
 * wrong fact and nothing would ever report it.
 *
 * Rounded, because `P2047` is a quantity and is legitimately fractional
 * (`136.5` minutes), while `runtimeMinutes` is an integer in the contract.
 */
const readInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed);
};

const ITEM_IRI_PREFIX = "http://www.wikidata.org/entity/";

/**
 * One SPARQL row as a provider record.
 *
 * `raw` IS BUILT FIELD BY FIELD FROM NAMED READS, never spread from the
 * response. That is the property a reviewer should check: there is no
 * expression in this function that copies an unexamined value out of a third
 * party's document into the payload, so the only way a media address reaches
 * `raw` is inside one of the five text fields -- which is exactly where
 * `findMediaAddresses` looks, and exactly where a vandalised Wikidata label
 * would put one.
 *
 * `availability: []` AND `artwork: []` ARE STATEMENTS, NOT STUBS. Wikidata
 * models neither a distribution window nor a territory this operator may offer
 * a work in, so an empty availability is the truthful answer; `project.ts` with
 * `unstatedAvailability: "refuse"` then refuses the work, which is the
 * fail-closed reading and the right one for a source that knows nothing about
 * our licences. Artwork is empty because a Wikidata image is a Commons FILE with
 * its own licence -- routinely not CC0, and for film posters routinely not free
 * at all -- and `artworkRefSchema` requires an opaque asset reference plus a
 * stated basis, neither of which this adapter can mint.
 */
const readRow = (
  row: Readonly<Record<string, { readonly value: string }>>,
  selection: WikidataSelection,
  register: WikidataRightsRegister
): { readonly record: RawProviderRecord; readonly numericId: number } | null => {
  const iri = cell(row, "item");
  if (iri === undefined || !iri.startsWith(ITEM_IRI_PREFIX)) return null;
  const entityId = iri.slice(ITEM_IRI_PREFIX.length);
  if (!CC0_ITEM_ID_PATTERN.test(entityId)) return null;

  const numericId = readInteger(cell(row, "n"));
  if (numericId === undefined) return null;

  const derived = deriveNormalizedContentId({
    sourceId: WIKIDATA_SOURCE_ID,
    nativeId: entityId
  });
  // A `Q`-shaped id always normalizes, so this branch is unreachable today. It
  // is handled rather than asserted because the derivation is the contract's
  // check and not this file's, and a tightened contract should skip a record
  // here rather than throw inside a page read.
  if (!derived.ok) return null;

  const imdbIds = unpackTokens(cell(row, "imdbIds"));
  const copyrightStatusEntityIds = unpackTokens(cell(row, "copyrightStatuses"));

  const crossRefs: ExternalRef[] = [{ authority: "wikidata", id: entityId }];
  for (const imdbId of imdbIds) crossRefs.push({ authority: "imdb", id: imdbId });

  const rights = register({
    entityId,
    contentId: derived.contentId,
    copyrightStatusEntityIds,
    crossRefs
  });

  const runtimeMinutes = readInteger(cell(row, "runtimeMinutes"));
  const episodeCount = readInteger(cell(row, "episodeCount"));
  const isSeries = selection.kind === "series";

  const raw: Record<string, unknown> = {
    contentId: derived.contentId,
    kind: selection.kind,
    titles: unpackLocalized(cell(row, "titles")),
    synopses: unpackLocalized(cell(row, "synopses")),
    genres: unpackLocalized(cell(row, "genres")),
    releaseYear: readInteger(cell(row, "releaseYear")),
    runtimeMinutes: isSeries ? null : (runtimeMinutes ?? null),
    episodeCount: isSeries ? (episodeCount ?? null) : null,
    availability: [],
    artwork: [],
    rights
  };

  return {
    record: {
      nativeId: entityId,
      // Not available from the Query Service's default graph. See the header.
      sourceRevision: null,
      crossRefs,
      raw
    },
    numericId
  };
};

/* -------------------------------------------------------------------------
 * Failures
 * ---------------------------------------------------------------------- */

/**
 * Transport failures, as the port's four.
 *
 * AN EGRESS REFUSAL IS REPORTED AS `provider_unreachable`, WITH THE EXACT REASON
 * IN THE DETAIL. It is literally true -- under this policy the host cannot be
 * reached -- and the alternative, adding a fifth member to
 * `ProviderFetchFailure`, would be the port changing shape to suit one adapter,
 * which is the thing this task was told not to do. The detail carries
 * `url_host_not_on_egress_allowlist` verbatim, which is the string an operator
 * needs in order to know the remedy is an allowlist entry.
 *
 * `provider_rate_limited` IS CURRENTLY UNREACHABLE FROM THIS ADAPTER, AND THAT
 * IS A REAL GAP RATHER THAN A DESIGN. Wikimedia rate limiting is not theoretical
 * -- researching this adapter tripped it twice in a few minutes, answering HTTP
 * 429 with a plain-text body -- but `fetchManifestText` reports a non-2xx as
 * `http_status` with the number only inside a human-readable detail
 * (`publisher responded 429`). Parsing an English sentence to decide a control
 * flow is worse than the gap it would close, so this maps 429 to
 * `provider_rejected_request` like any other status. THE FIX IS UPSTREAM: the
 * transport should carry the status as a field. That is an edit to
 * `@liberty/media-inspection`, outside PL-0305's `allowedPaths`, and it is
 * recorded in `docs/CATALOG_SOURCE.md` rather than worked around here.
 *
 * The safety consequence is nil either way: `ingest.ts` withholds tombstones on
 * ANY page failure, so a rate-limited pass cannot delete anything regardless of
 * which name the failure is given.
 */
const asProviderFailure = (reason: CatalogDocumentFailure): ProviderFetchFailure => {
  switch (reason) {
    case "timeout":
    case "network_error":
    case "dns_resolution_failed":
    case "dns_resolved_no_addresses":
      return "provider_unreachable";
    case "document_not_json":
      return "provider_response_malformed";
    case "http_status":
      return "provider_rejected_request";
    default:
      // Every remaining member of `CatalogDocumentFailure` is an
      // `EgressRejectionReason`: the host is not allowed, the scheme is not
      // allowed, the name resolved into a private range. All of them mean the
      // same operational thing.
      return "provider_unreachable";
  }
};

/* -------------------------------------------------------------------------
 * Cursors
 * ---------------------------------------------------------------------- */

const CURSOR_PATTERN = /^[0-9]{1,15}$/;

/**
 * A cursor this provider issued, read back.
 *
 * VALIDATED EVEN THOUGH IT IS OURS. A cursor makes a round trip through a
 * caller's store between being issued and being returned, so by the time it
 * arrives it is a string from outside this process. It is interpolated into a
 * SPARQL `FILTER`, which is exactly the sort of place an unvalidated string does
 * damage; `buildPageRequestUrl` checks it a second time as an integer, and this
 * is the check that keeps a malformed cursor from becoming a confusing
 * `NaN`-shaped query.
 */
const readCursor = (
  cursor: string | null
): { readonly ok: true; readonly value: number } | { readonly ok: false } => {
  if (cursor === null) return { ok: true, value: 0 };
  if (!CURSOR_PATTERN.test(cursor)) return { ok: false };
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) ? { ok: true, value: parsed } : { ok: false };
};

/* -------------------------------------------------------------------------
 * The provider
 * ---------------------------------------------------------------------- */

const readSparqlRows = async (
  url: string,
  config: WikidataProviderConfig
): Promise<
  | { readonly ok: true; readonly rows: readonly Readonly<Record<string, { readonly value: string }>>[] }
  | { readonly ok: false; readonly reason: ProviderFetchFailure; readonly detail: string }
> => {
  const fetched = await fetchCatalogDocument(url, config.document, config.transport);
  if (!fetched.ok) {
    return { ok: false, reason: asProviderFailure(fetched.reason), detail: fetched.reason };
  }
  const parsed = sparqlResponseSchema.safeParse(fetched.document);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "provider_response_malformed",
      detail: `not a SPARQL results document: ${parsed.error.issues
        .map((issue) => issue.path.join(".") || "(root)")
        .join(", ")}`
    };
  }
  return { ok: true, rows: parsed.data.results.bindings };
};

const createProvider = (config: WikidataProviderConfig): CatalogMetadataProvider => {
  const { selection, rightsRegister } = config;

  const fetchPage = async (request: ProviderPageRequest): Promise<ProviderPageResult> => {
    /*
     * `request.changedSince` IS NOT READ, and that is the port's requirement for
     * a provider without `incrementalSince`: "a provider without it MUST ignore
     * the field rather than pretend". Honouring it partially would be worse than
     * ignoring it, because a pass that believed it was incremental and was not
     * would look complete while having read a fraction of the source.
     */
    const cursor = readCursor(request.cursor);
    if (!cursor.ok) {
      return {
        ok: false,
        reason: "provider_rejected_request",
        detail: "cursor is not a watermark this provider issued"
      };
    }

    const pageSize = Math.max(1, Math.min(request.pageSize, WIKIDATA_CAPABILITIES.maxPageSize));
    const built = buildPageRequestUrl(selection.classQid, selection.locales, cursor.value, pageSize);
    if (!built.ok) {
      return { ok: false, reason: "provider_rejected_request", detail: built.reason };
    }

    const fetched = await readSparqlRows(built.url, config);
    if (!fetched.ok) return { ok: false, reason: fetched.reason, detail: fetched.detail };

    const records: RawProviderRecord[] = [];
    let watermark = cursor.value;
    for (const row of fetched.rows) {
      const read = readRow(row, selection, rightsRegister);
      if (read === null) continue;
      records.push(read.record);
      if (read.numericId > watermark) watermark = read.numericId;
    }

    /*
     * A SHORT PAGE IS THE END OF THE ENUMERATION. The query asked for `pageSize`
     * ROWS and the outer `GROUP BY` produces exactly one row per item, so fewer
     * rows than asked for means the source had no more. Rows that `readRow`
     * skipped are counted here rather than in `records`, deliberately: dropping
     * an unreadable row must not be able to end a pass early, because that would
     * make `ingest.ts` believe it had enumerated the whole source and let it
     * tombstone everything it had not reached.
     */
    const exhausted = fetched.rows.length < pageSize;
    return {
      ok: true,
      records,
      nextCursor: exhausted ? null : String(watermark),
      // `reportsDeletions` is false, so this is always empty and `ingest.ts`
      // would ignore it even if it were not.
      withdrawn: []
    };
  };

  const searchWorks = async (
    query: string,
    cursor: string | null,
    pageSize: number
  ): Promise<ProviderSearchResult> => {
    const offset = readCursor(cursor);
    if (!offset.ok) {
      return {
        ok: false,
        reason: "provider_rejected_request",
        detail: "cursor is not an offset this provider issued"
      };
    }
    const locale = selection.locales[0];
    if (locale === undefined) {
      return {
        ok: false,
        reason: "provider_rejected_request",
        detail: "no locale to search in"
      };
    }

    const clamped = Math.max(1, Math.min(pageSize, WIKIDATA_CAPABILITIES.maxPageSize));
    const searchUrl = buildSearchRequestUrl(query, locale, offset.value, clamped);
    if (!searchUrl.ok) {
      return { ok: false, reason: "provider_rejected_request", detail: searchUrl.reason };
    }

    const searched = await fetchCatalogDocument(searchUrl.url, config.document, config.transport);
    if (!searched.ok) {
      return {
        ok: false,
        reason: asProviderFailure(searched.reason),
        detail: searched.reason
      };
    }
    const parsedSearch = searchResponseSchema.safeParse(searched.document);
    if (!parsedSearch.success) {
      return {
        ok: false,
        reason: "provider_response_malformed",
        detail: "not a wbsearchentities document"
      };
    }

    /*
     * RELEVANCE ORDER IS THE PROVIDER'S AND IS PRESERVED EXACTLY. `provider.ts`
     * says a provider that ran the query is the only party that knows why a
     * result matched, so the ids are kept in the order the search returned them
     * and the hydrated rows -- which come back ordered by item id, because the
     * hydration query is the enumeration query -- are put back into that order
     * below.
     */
    const orderedIds = parsedSearch.data.search
      .map((hit) => hit.id)
      .filter((id) => CC0_ITEM_ID_PATTERN.test(id));
    const continuation = parsedSearch.data["search-continue"];
    const nextCursor = continuation === undefined ? null : String(continuation);

    if (orderedIds.length === 0) return { ok: true, records: [], nextCursor };

    const hydrationUrl = buildHydrationRequestUrl(
      selection.classQid,
      selection.locales,
      orderedIds
    );
    if (!hydrationUrl.ok) {
      return { ok: false, reason: "provider_rejected_request", detail: hydrationUrl.reason };
    }

    const hydrated = await readSparqlRows(hydrationUrl.url, config);
    if (!hydrated.ok) return { ok: false, reason: hydrated.reason, detail: hydrated.detail };

    const byEntityId = new Map<string, RawProviderRecord>();
    for (const row of hydrated.rows) {
      const read = readRow(row, selection, rightsRegister);
      if (read === null) continue;
      byEntityId.set(read.record.nativeId, read.record);
    }

    /*
     * IDS THAT DID NOT HYDRATE ARE DROPPED, NOT REPORTED AS RECORDS. The
     * hydration query carries the class constraint, so a hit that is not an
     * instance of the configured class simply has no row -- `wbsearchentities`
     * ranks an ALBUM called "The Matrix" above the film, and that album is
     * filtered here rather than by a second guess about what a user meant.
     */
    const records: RawProviderRecord[] = [];
    for (const id of orderedIds) {
      const record = byEntityId.get(id);
      if (record !== undefined) records.push(record);
    }

    return { ok: true, records, nextCursor };
  };

  return {
    sourceId: WIKIDATA_SOURCE_ID,
    capabilities: WIKIDATA_CAPABILITIES,
    fetchPage,
    searchWorks
  };
};

export type WikidataProviderCreation =
  | { readonly ok: true; readonly provider: CatalogMetadataProvider }
  | { readonly ok: false; readonly reason: WikidataConfigRefusal; readonly detail: string };

/**
 * Builds the provider, or refuses to.
 *
 * EVERY CHECK HERE RUNS ONCE, AT CONSTRUCTION, AND FAILS CLOSED. A misconfigured
 * deployment gets NO PROVIDER rather than a provider that discovers its problem
 * on the first page -- which for the User-Agent check is the difference between
 * an error at startup and an IP block that arrives without notice and applies to
 * the whole operator.
 *
 * THE EGRESS CHECK IS THE CC0 BOUNDARY MADE MECHANICAL. It is not "the allowlist
 * must contain Wikidata"; it is "the allowlist must contain NOTHING BUT
 * Wikidata". An operator whose catalog egress policy also named
 * `en.wikipedia.org` would have a provider one query-builder edit away from
 * ingesting CC BY-SA article text as though it were CC0 structured data, and the
 * licensing decision does not cover that. So the policy this provider is handed
 * is narrow by construction, and an operator who needs a wider policy elsewhere
 * passes a different `EgressPolicy` to whatever needs it.
 */
export function createWikidataProvider(
  config: WikidataProviderConfig
): WikidataProviderCreation {
  const agent = checkWikidataUserAgent(config.document.userAgent);
  if (!agent.ok) {
    return {
      ok: false,
      reason: agent.reason,
      detail:
        agent.reason === "user_agent_impersonates_a_browser"
          ? "the Wikimedia User-Agent policy forbids impersonating a browser"
          : "the Wikimedia User-Agent policy requires contact information in the agent string"
    };
  }

  const allowed = config.document.egress.allowedHosts;
  for (const host of allowed) {
    if (!isWikidataCc0Host(host)) {
      return {
        ok: false,
        reason: "egress_allows_a_host_outside_the_cc0_namespaces",
        detail:
          "this provider may only be composed over an egress policy that allows the Wikidata endpoints and nothing else"
      };
    }
  }
  for (const endpoint of [WIKIDATA_SPARQL_ENDPOINT, WIKIDATA_ACTION_API_ENDPOINT]) {
    const host = new URL(endpoint).hostname;
    if (!allowed.some((entry) => entry.toLowerCase() === host)) {
      return {
        ok: false,
        reason: "egress_does_not_allow_the_wikidata_endpoints",
        detail: `${host} is not on the operator's egress allowlist`
      };
    }
  }

  // Built and discarded: the builders are the validators for the class id and
  // the locales, and running one here is what turns a bad selection into a
  // construction refusal instead of a page-one failure. There is no second
  // spelling of those rules in this file.
  const probe = buildPageRequestUrl(
    config.selection.classQid,
    config.selection.locales,
    0,
    WIKIDATA_CAPABILITIES.maxPageSize
  );
  if (!probe.ok) return { ok: false, reason: probe.reason, detail: probe.detail };

  return { ok: true, provider: createProvider(config) };
}
