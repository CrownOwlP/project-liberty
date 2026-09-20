import {
  projectToCatalogRecord,
  resolveCatalogMetadataProvider,
  runIngestionPass,
  type CatalogMetadataProvider,
  type CatalogProviderRuntime,
  type ProjectionRefusal,
  type ProviderFetchFailure,
  type RecordRefusalReason,
  type Territory,
  type UnstatedAvailability
} from "@liberty/catalog-ingestion";
import type {
  CatalogAnswer,
  CatalogAnswerState,
  CatalogMetadataRecord,
  CatalogMetadataSource,
  CatalogRecordWithheld
} from "./catalog-source";

/* -------------------------------------------------------------------------
 * The adapter: @liberty/catalog-ingestion, projected into the application's port
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT. It is the ONE module that
 * knows both `@liberty/catalog-ingestion`'s public API and this application's
 * `CatalogMetadataSource`. It contains NO query, NO fetch, NO URL, NO SPARQL and
 * no source name: every one of those lives behind the package's provider and
 * transport boundaries, and this file cannot see them. It imports the package's
 * ROOT ENTRY POINT and nothing else -- in particular it names no Wikidata module
 * and no Wikidata type -- so replacing or adding a licensed source changes
 * nothing here.
 *
 * WHY THE APPLICATION GOT A SECOND FILE RATHER THAN A FEW LINES IN THE REGISTRY.
 * `catalog-source-registry.ts` is a composition root: it decides WHICH source
 * this process has. Projecting a pass result into records is a different job
 * with its own failure vocabulary, and putting it in the registry would mean the
 * registry grew an ingestion pass, a projection, a clock and an error class. The
 * registry calls one function here and keeps its own shape.
 *
 * ==========================================================================
 * FOUR STATES, FOUR ANSWERS -- the thing this adapter exists to keep straight
 * ==========================================================================
 *
 * An empty rail has four completely different causes with four different
 * remedies, and the defect this whole port was built against is all four
 * arriving as `[]`:
 *
 *   1. NO SOURCE IS CONFIGURED. Answered by the REGISTRY, before this file is
 *      reached: `resolveCatalogMetadataSource` returns `not-configured` with
 *      `no_metadata_source_configured`. Remedy: configure a runtime.
 *      (A runtime that was supplied and REFUSED is its own reason there,
 *      `catalog_metadata_source_configuration_refused`, because the remedy is
 *      to correct a deployment rather than to make one.)
 *   2. A SOURCE ANSWERED AND NOTHING IT RETURNED IS USABLE -- every record was
 *      withheld for want of an established rights basis, or for want of stated
 *      availability. `describeCatalog()` answers `no_records_usable` and lists
 *      WHY, per record. Remedy: the operator's rights register, or availability
 *      data. THIS IS THE STATE A WIKIDATA-BACKED DEPLOYMENT WITH NO RIGHTS
 *      REGISTER IS IN, and it must not look like an empty catalog.
 *   3. THE PROVIDER OR THE NETWORK FAILED. `describeCatalog()`, `listRecords()`
 *      and `findRecord()` all THROW `CatalogMetadataSourceUnavailableError`,
 *      carrying the package's own named `ProviderFetchFailure`. Remedy: retry,
 *      or fix egress. This is the port's documented contract -- "THROWS when it
 *      cannot answer at all" -- and it is what keeps a bad afternoon from being
 *      published as a fact about the catalog.
 *   4. THE CATALOG IS TRULY EMPTY. A complete pass, nothing refused, nothing
 *      withheld. `describeCatalog()` answers `catalog_empty`. There is no
 *      remedy; it is a fact.
 *
 * HOW A CALLER TELLS 2 FROM 4, which is the pair that is genuinely hard.
 * `listRecords()` answers `[]` for both, because both really do have no records
 * -- so the distinction is NOT in the array and was never going to be. It is in
 * `describeCatalog()`, which is why that method exists and why it is the
 * primary: `listRecords()` is a narrowing of it, not the other way round.
 * `describeCatalog` is OPTIONAL ON THE PORT (see `catalog-source.ts`) for the
 * same reason `searchWorks` is optional on the provider port -- the in-process
 * fixture source cannot answer it and should not be made to pretend -- and
 * `requireCatalogDescription` is the guard, returning the method rather than a
 * boolean so a caller that got past the check holds something callable.
 *
 * WHAT THIS ADAPTER WILL NOT DO, stated because each was available and each
 * would have made a rail populate:
 *
 *   - IT WILL NOT DECLARE A RIGHTS BASIS. The package refuses a record whose
 *     basis is null and this adapter does not second-guess it. Wikidata knowing
 *     that a film exists is not authorization to surface that film, and the
 *     nearest available lie -- carrying the record through with the item's own
 *     `rights` field, which the contract forces to hold one of three values
 *     whether or not anybody established it -- is exactly the substitution
 *     `selectDeclaredItems` was written to refuse.
 *   - IT WILL NOT INVENT AN AVAILABILITY WINDOW. `unstatedAvailability` is the
 *     operator's stated reading of a source that names no territory, it is
 *     REQUIRED with no default here as it is in the package, and neither value
 *     synthesises a window. `refuse` withholds the work; `treat_as_worldwide` is
 *     an operator assertion about their own position, recorded as theirs.
 *   - IT WILL NOT BUFFER A PASS SO A SYNCHRONOUS CALLER CAN HAVE ONE. Everything
 *     here is a promise because the I/O is real. See the registry on what
 *     happened to the synchronous accessor.
 *   - IT WILL NOT READ AN ENVIRONMENT VARIABLE, hold a credential, or default
 *     any part of a runtime. A deployment that supplies no runtime gets no
 *     source, and there is no ambient configuration from which one could appear.
 *
 * WHAT IT IS NOT YET: an ingestion worker. Each query runs one pass and nothing
 * is persisted between them, so a rail costs a pass and `findRecord` costs a
 * pass. That is honest -- the answer really is as fresh as the pass that built
 * it -- and it is not what a catalog of real size wants. `docs/CATALOG_SOURCE.md`
 * carries the scheduler and the store as outstanding.
 * ---------------------------------------------------------------------- */

/**
 * How much of a source one query reads, and for whom.
 *
 * NOTHING HERE HAS A DEFAULT. Every field is a deployment decision with a
 * consequence somebody has to own: which locales a reader is served, which
 * territory availability is evaluated for, how an unstated availability is
 * read, and how much of a third party's catalog one request may pull. A default
 * for any of them would be this module choosing on an operator's behalf, which
 * is the argument `transport.ts` makes for `userAgent` and `wikidata.ts` makes
 * for the rights register.
 */
export interface CatalogIngestionReadOptions {
  /** Preferred locales, most preferred first. At least one. */
  readonly locales: readonly string[];
  /** The territory availability is evaluated for. */
  readonly territory: Territory;
  /** How a source that names no territory is to be read. Never synthesises a window. */
  readonly unstatedAvailability: UnstatedAvailability;
  /** Records per page requested. The package clamps it to what the provider serves. */
  readonly pageSize: number;
  /**
   * How many pages one query reads.
   *
   * A BOUND, NOT A TUNING KNOB, for the reason `IngestionPassOptions.maxPages`
   * gives: a provider returning a cursor that points at itself would otherwise
   * read a third party's responses into this process until it died.
   */
  readonly maxPages: number;
}

/**
 * Everything this application needs to stand a real source behind its port.
 *
 * `provider` IS CARRIED WHOLE AND NEVER INSPECTED. It is the package's own
 * `CatalogProviderRuntime` -- the licensed source name, the egress policy, the
 * transport, the User-Agent, the slice to read and the operator's rights
 * register -- and this module neither reads nor defaults a field of it. That is
 * what keeps the source seam in the package: a second licensed source changes
 * the shape of that value and changes nothing in `apps/web`.
 */
export interface CatalogIngestionRuntime {
  readonly provider: CatalogProviderRuntime;
  readonly read: CatalogIngestionReadOptions;
  /**
   * The clock, injected.
   *
   * Used for the pass's `observedAt` and for the instant availability windows
   * are evaluated against. A parameter rather than `Date.now` so a test states
   * the time it means, and so the two cannot be a millisecond apart for no
   * reason.
   */
  readonly now: () => number;
}

/**
 * Why a record the source listed did not become a browsable record.
 *
 * TWO VOCABULARIES, NEITHER RESTATED. `RecordRefusalReason` is the ingestion
 * pass's -- a media address in a catalog payload, a schema failure, and the one
 * that matters here, `rights_basis_not_declared`. `ProjectionRefusal` is the
 * projection's -- no title in the requested locales, availability not stated,
 * not available in this territory. Both are the package's own names, carried
 * through unchanged, because an operator reading "availability_not_stated"
 * needs the string the code actually produced and not a translation of it.
 */
export type CatalogRecordWithheldReason = RecordRefusalReason | ProjectionRefusal;

/**
 * The port's withheld record, with the reason narrowed to the package's names.
 *
 * The PORT declares `reason: string` and defines no vocabulary, deliberately --
 * see `catalog-source.ts`. This adapter knows exactly which strings it can
 * produce, so it states them, and the narrower type is assignable to the wider
 * one. The benefit is not decoration: a test asserting
 * `rights_basis_not_declared` is checked against the package's union at compile
 * time, so a reason that gets renamed upstream fails to build here rather than
 * quietly never matching.
 *
 * `recordId` has two sources because the two refusal points know different
 * things: a record refused by the pass has only a native id, and one refused at
 * projection has a derived content id. Naming which is which would put a
 * discriminant in a diagnostic nobody branches on.
 */
export interface CatalogIngestionRecordWithheld extends CatalogRecordWithheld {
  readonly reason: CatalogRecordWithheldReason;
}

/** The port's answer, with this adapter's narrower withheld reasons. */
export interface CatalogIngestionAnswer extends CatalogAnswer {
  readonly withheld: readonly CatalogIngestionRecordWithheld[];
}

/**
 * The source could not answer.
 *
 * THROWN RATHER THAN RETURNED, which is the port's documented split: `findRecord`
 * answers `null` for an id the source does not know and throws when it cannot
 * answer at all. A failure returned as an empty list is the specific dishonesty
 * the whole four-state design exists to prevent -- `lib/catalog.ts` converts a
 * throw into `catalog_source_unavailable` and an empty list into `empty`, and
 * those are different things to put in front of a reader.
 *
 * `reason` IS THE PACKAGE'S OWN `ProviderFetchFailure` and is a FIELD rather than
 * only a message, so a caller branches on an `instanceof` and a property read
 * instead of comparing error text. `detail` is the package's detail string,
 * carried unchanged; nothing here composes one from a third party's payload.
 */
export class CatalogMetadataSourceUnavailableError extends Error {
  readonly reason: ProviderFetchFailure;
  readonly detail: string;

  constructor(reason: ProviderFetchFailure, detail: string) {
    super(`the catalog metadata source could not answer (${reason})`);
    this.name = "CatalogMetadataSourceUnavailableError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * A source that can say why an empty answer is empty.
 *
 * The narrow port plus `describeCatalog`. Declared as its own interface so the
 * guard below has something to narrow to, and so a caller holding one of these
 * knows at the type level that states 2 and 4 are distinguishable to it.
 */
export interface DescribingCatalogMetadataSource extends CatalogMetadataSource {
  describeCatalog(): Promise<CatalogIngestionAnswer>;
}

/**
 * Why a runtime did not become a source.
 *
 * Both values are the package's own reasons, carried through rather than
 * collapsed: `no_catalog_provider_licensed` means a human Licensing decision is
 * missing, and `catalog_provider_configuration_refused` means the decision
 * exists and this deployment's runtime was rejected -- a bad User-Agent, an
 * egress policy reaching outside the licensed namespaces, an unusable
 * selection. Opposite remedies, so one reason would send an operator to the
 * wrong one.
 */
export type CatalogIngestionSourceRefusal =
  | "no_catalog_provider_licensed"
  | "catalog_provider_configuration_refused";

export type CatalogIngestionSourceCreation =
  | { readonly ok: true; readonly source: DescribingCatalogMetadataSource }
  | {
      readonly ok: false;
      readonly reason: CatalogIngestionSourceRefusal;
      readonly detail: string;
    };

/**
 * Projects one ingestion pass into an answer.
 *
 * SEPARATED FROM THE PROVIDER RESOLUTION ABOVE IT so that this -- the part with
 * the rights and availability behaviour in it -- is testable against any
 * `CatalogMetadataProvider`, including a hand-written one, without composing a
 * real source or a transport. The alternative is a test that can only reach the
 * rights refusal by building a third party's response, which tests the response
 * fixture as much as the rule.
 *
 * EVERY WITHHELD RECORD IS COUNTED, from both refusal points, and the state is
 * derived from the counts rather than asserted. That is what makes
 * `no_records_usable` impossible to reach by accident and impossible to miss
 * when it is reached.
 */
export function catalogSourceOverProvider(
  provider: CatalogMetadataProvider,
  read: CatalogIngestionReadOptions,
  now: () => number
): DescribingCatalogMetadataSource {
  const describeCatalog = async (): Promise<CatalogIngestionAnswer> => {
    const pass = await runIngestionPass(
      provider,
      {
        pageSize: read.pageSize,
        maxPages: read.maxPages,
        resumeCursor: null,
        /*
         * A FULL READ, NEVER AN INCREMENTAL ONE. `changedSince` asks a provider
         * for a SUBSET, and a subset is the wrong answer to "what is in the
         * catalog" when nothing here persists the rest. `knownContentIds` is
         * empty for the same reason: this adapter has no store, so it knows of
         * no work that could have gone missing, and handing the pass an empty
         * set is what makes `reconcileTombstones` mint nothing rather than
         * mint wrongly.
         */
        changedSince: null,
        knownContentIds: []
      },
      { now }
    );

    if (pass.failure !== null) {
      throw new CatalogMetadataSourceUnavailableError(pass.failure.reason, pass.failure.detail);
    }

    const records: CatalogMetadataRecord[] = [];
    const withheld: CatalogIngestionRecordWithheld[] = pass.refused.map((refusal) => ({
      recordId: refusal.nativeId,
      reason: refusal.reason
    }));

    const atMs = now();
    for (const accepted of pass.accepted) {
      const projection = projectToCatalogRecord(accepted, {
        locales: read.locales,
        territory: read.territory,
        atMs,
        unstatedAvailability: read.unstatedAvailability
      });
      if (!projection.ok) {
        withheld.push({ recordId: accepted.work.contentId, reason: projection.reason });
        continue;
      }
      /*
       * ASSIGNED, NOT MAPPED. `ProjectedCatalogRecord` and `CatalogMetadataRecord`
       * are the same two fields spelled in the same published contract types on
       * both sides of the package boundary, neither importing the other. If
       * either ever grows a field the other does not have, this line stops
       * compiling -- here, at the one place that joins them, which is where
       * somebody should be looking.
       */
      records.push(projection.record);
    }

    const state: CatalogAnswerState =
      records.length > 0
        ? "records_available"
        : withheld.length > 0
          ? "no_records_usable"
          : "catalog_empty";

    return {
      state,
      records,
      withheld,
      observedAt: pass.observedAt,
      complete: pass.complete
    };
  };

  return {
    sourceId: provider.sourceId,
    describeCatalog,
    listRecords: async () => (await describeCatalog()).records,
    /*
     * ONE PASS PER LOOKUP, and the cost is stated rather than hidden behind a
     * cache. A cache here would be a store this adapter does not have and cannot
     * invalidate, and the first thing it would do is hand a caller a record the
     * source has since withdrawn -- which is precisely the state tombstones
     * exist to express and which nothing in this application yet reads. When a
     * real store lands, `findRecord` reads it; until then this is honest and
     * slow rather than fast and stale.
     */
    findRecord: async (contentId) => {
      const answer = await describeCatalog();
      return answer.records.find((record) => record.item.id === contentId) ?? null;
    }
  };
}

/**
 * A real catalog metadata source over a deployment's runtime, or a named reason
 * there is none.
 *
 * THE ONLY THING IN `apps/web` THAT NAMES `resolveCatalogMetadataProvider`. It
 * does not choose a source -- the package's frozen licensed-source list does
 * that, and the runtime merely names which licensed source it is reaching -- and
 * it cannot introduce one: there is no field on `CatalogProviderRuntime` a
 * caller could set to license something, and no value this function could return
 * for a name nobody licensed except the refusal.
 */
export function createCatalogIngestionSource(
  runtime: CatalogIngestionRuntime
): CatalogIngestionSourceCreation {
  const resolution = resolveCatalogMetadataProvider(runtime.provider);
  if (resolution.status === "not-configured") {
    return { ok: false, reason: resolution.reason, detail: resolution.detail };
  }

  return {
    ok: true,
    source: catalogSourceOverProvider(resolution.provider, runtime.read, runtime.now)
  };
}

/**
 * Guards the optional description capability at its call sites.
 *
 * RETURNS THE METHOD RATHER THAN A BOOLEAN, for the reason
 * `requireProviderSideSearch` gives about the provider port's optional search: a
 * boolean leaves `source.describeCatalog?.()` written somewhere, and the `?.`
 * silently answers `undefined` on the day the check and the call disagree. A
 * caller that got past this holds something callable.
 *
 * `null` MEANS THE SOURCE CANNOT SAY, WHICH IS NOT THE SAME AS SAYING NOTHING.
 * The in-process fixture source cannot distinguish "no fixture is usable" from
 * "there are no fixtures", because it has no pass behind it and no refusals to
 * report; making it answer a `CatalogAnswer` would mean inventing one of those
 * states for it. A caller handed `null` knows the distinction is unavailable
 * here rather than being told a state that was guessed.
 */
export function requireCatalogDescription(
  source: CatalogMetadataSource
): (() => CatalogAnswer | Promise<CatalogAnswer>) | null {
  const describe = source.describeCatalog;
  if (describe === undefined) return null;
  return describe.bind(source);
}
