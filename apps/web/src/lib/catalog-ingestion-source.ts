import {
  checkRightsBasis,
  createInMemoryCatalogStore,
  partitionCatalogWorks,
  projectToCatalogRecord,
  refreshCatalogIfDue,
  resolveCatalogMetadataProvider,
  type CatalogMetadataProvider,
  type CatalogProviderRuntime,
  type CatalogRefreshFailure,
  type CatalogRefreshReason,
  type CatalogRefreshSchedule,
  type CatalogRefreshStatus,
  type CatalogStore,
  type FreshnessVerdict,
  type ProjectionRefusal,
  type ProviderFetchFailure,
  type RecordRefusalReason,
  type Territory,
  type UnstatedAvailability,
  type WorkTombstone
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
 * ==========================================================================
 * READ-TRIGGERED AND SCHEDULE-GATED. STILL NOT A WORKER, AND NOT DESCRIBED AS
 * ONE
 * ==========================================================================
 *
 * This section used to say "each query runs one pass and nothing is persisted
 * between them", which was true and was the defect PL-0309 exists to close: it
 * made every page view an outbound crawl, tied response time to a third party,
 * and scaled the load on that third party with this product's traffic. What
 * happens now:
 *
 *   - The source answers from STORED STATE, held behind the package's
 *     `CatalogStore` port. A read asks `refreshCatalogIfDue` whether a pass is
 *     due; when it is not, no request leaves the process.
 *   - A COLD START STILL AWAITS A PASS. There is nothing stored on the first
 *     read of a process, so that read pays a full pass and waits for it. That is
 *     stated rather than hidden: it is the honest cost of having no worker and
 *     no durable state.
 *   - A FAILED REFRESH SERVES THE PREVIOUS STATE AND SAYS SO. The answer carries
 *     `refresh.status: "failed"` with the package's own failure reason. What it
 *     does NOT do is present the old state as current -- the age and the stated
 *     policy travel with the answer, so nothing becomes fresher by being stored.
 *     A cold start whose first pass fails still THROWS, because there is no
 *     previous state to serve and an empty list would be a lie.
 *
 * WHAT THIS IS NOT, AND MUST NOT BE WRITTEN UP AS. It is not a background
 * ingestion worker and PL-0305 did not deliver one either. NOTHING REFRESHES
 * WHILE THIS PROCESS IS IDLE: there is no timer anywhere in this path, so a
 * catalog that goes untouched for a day is refreshed by the first reader after
 * that day, who waits for it. Reads no longer cost a pass each; passes are still
 * driven by reads. A real worker needs a process entry point, which is outside
 * this file.
 *
 * AND NOTHING IS DURABLE. The store behind this is in-memory, so a restart
 * empties it and the next read is a cold start again. `docs/CATALOG_SOURCE.md`
 * carries both gaps.
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
  /**
   * How old an answer may be, and how far a failing provider is backed off.
   *
   * OPTIONAL, AND THAT IS A ROUTING CONSTRAINT RATHER THAN A DEFAULT. Nothing
   * else on this interface has a default and this has none either: ABSENT MEANS
   * NO POLICY WAS STATED, which the package spells `policy_not_stated` and which
   * behaves exactly as this adapter did before it was scheduled -- every read
   * refreshes, because nothing may be described as fresh against a policy nobody
   * wrote. It is not "refresh every read" chosen on an operator's behalf; it is
   * the absence of the statement that would let anything be reused.
   *
   * WHY IT IS NOT REQUIRED. `apps/web/src/lib/server-bootstrap.ts` is the
   * composition root that constructs this value out of an operator's
   * environment, and it is outside PL-0309's write surface. Making this field
   * required would stop that file compiling, and a deployment would then have no
   * catalog at all. The two variables it needs, and the three lines that read
   * them, are recorded in `docs/CATALOG_SOURCE.md` as the edit that turns this
   * on for a real deployment. Until that edit lands, a hosted process gets the
   * store, the tombstone handling and the read-time re-evaluation, and still
   * pays a pass per read.
   */
  readonly schedule?: CatalogRefreshSchedule | null;
  /**
   * Where stored state lives, if the composition root wants to say.
   *
   * ALSO OPTIONAL, AND THE DEFAULT IS NOT "A FRESH STORE PER CALL" -- that would
   * be useless, see `createCatalogIngestionSource`. A supplied store is how a
   * durable implementation of the package's `CatalogStore` gets in without this
   * module knowing what it is made of.
   */
  readonly store?: CatalogStore;
}

/**
 * Why a record the source listed did not become a browsable record.
 *
 * THREE VOCABULARIES, NONE RESTATED. `RecordRefusalReason` is the ingestion
 * pass's -- a media address in a catalog payload, a schema failure, and the one
 * that matters here, `rights_basis_not_declared`. `ProjectionRefusal` is the
 * projection's -- no title in the requested locales, availability not stated,
 * not available in this territory. `WorkTombstone["reason"]` is the store's --
 * `withdrawn_by_source` and `absent_from_complete_sync` -- and it joined the
 * union when stored state arrived: a work that is in the store and under a
 * tombstone must be withheld BY NAME rather than simply not be there, because a
 * withdrawn work that quietly vanishes from a rail is indistinguishable from one
 * that was never ingested. All three are the package's own names, carried
 * through unchanged, because an operator reading "availability_not_stated"
 * needs the string the code actually produced and not a translation of it.
 */
export type CatalogRecordWithheldReason =
  | RecordRefusalReason
  | ProjectionRefusal
  | WorkTombstone["reason"];

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

/**
 * What the most recent refresh did, and when the next one may run.
 *
 * WHY AN ANSWER CARRIES THIS AT ALL. Stored state introduces exactly one new way
 * to lie: serving yesterday's catalog as though it were today's. The port's
 * `observedAt` already says when the state was read, and this says whether the
 * attempt to make it newer succeeded. The pair is what keeps "the provider is
 * down and you are looking at an hour-old rail" distinguishable from "the
 * provider is fine and the catalog really is like this" -- two facts that a
 * cache without this field collapses into one.
 *
 * `status` IS THE MOST RECENT ATTEMPT EVER, NOT THIS READ'S. A read that found
 * the state fresh made no attempt, and reporting `never_attempted` for it would
 * erase the failure that happened five minutes ago and is the reason the state
 * is as old as it is. `attempted` is the per-read fact and is separate.
 */
export interface CatalogAnswerRefresh {
  /** Whether this read ran a pass. `false` means the schedule said nothing was due. */
  readonly attempted: boolean;
  readonly status: CatalogRefreshStatus;
  /** The package's own named failure from the most recent failed attempt. */
  readonly failure: CatalogRefreshFailure | null;
  /**
   * Whether the records in this answer come from state this read did not
   * refresh -- either because no pass was due, or because the pass that ran
   * failed and the previous state was kept.
   */
  readonly servedFromStoredState: boolean;
  /** Why the schedule did or did not run a pass. The package's own reason. */
  readonly scheduleReason: CatalogRefreshReason;
  /** When a pass may next run. `null` when nothing has been attempted yet. */
  readonly nextDueAtMs: number | null;
  readonly consecutiveFailures: number;
}

/**
 * The port's answer, with this adapter's narrower withheld reasons and the two
 * signals stored state makes necessary.
 *
 * ADDITIVE ON THIS INTERFACE, NEVER ON THE PORT. `CatalogAnswer` lives in
 * `catalog-source.ts` and deliberately carries no freshness vocabulary -- see
 * that file on why expressing an age there would import the package's
 * vocabulary into the module graph of every surface that renders a card.
 * `freshness` and `refresh` are therefore declared here, on the adapter's own
 * narrower answer, and are assignable to the port wherever the port is what a
 * caller holds. NOTHING OUTSIDE THIS FILE READS THEM YET: `lib/catalog.ts`
 * consumes `state`, `records` and `withheld`, and widening it to publish an age
 * to a reader is a separate task with a copy decision in it.
 */
export interface CatalogIngestionAnswer extends CatalogAnswer {
  readonly withheld: readonly CatalogIngestionRecordWithheld[];
  /**
   * How old this answer is and the policy it is being described against.
   *
   * `null` WHEN NO POLICY WAS STATED, rather than a verdict computed against a
   * policy this module chose. An operator who has not said how old a catalog may
   * be gets no claim about how old this one is -- only `observedAt`, which is a
   * fact rather than a judgement.
   */
  readonly freshness: FreshnessVerdict | null;
  readonly refresh: CatalogAnswerRefresh;
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
 * Where a source's state lives and how often it may be refreshed.
 *
 * BOTH FIELDS ARE REQUIRED HERE even though both are optional on
 * `CatalogIngestionRuntime`, and the asymmetry is the point.
 * `createCatalogIngestionSource` is the composition step that resolves an
 * absent field into a stated one -- `null` for "no policy was stated", a
 * process-lifetime store for "the caller did not supply one" -- so by the time
 * this function is called the decision has been taken and is visible in the
 * argument. A function that took `schedule?: ...` would let the decision be
 * taken implicitly at a dozen call sites instead of once.
 */
export interface CatalogIngestionScheduling {
  /** `null` means no staleness policy was stated, so every read refreshes. */
  readonly schedule: CatalogRefreshSchedule | null;
  readonly store: CatalogStore;
}

/**
 * Where stored state is turned into an answer, and where a refresh is asked for.
 *
 * SEPARATED FROM THE PROVIDER RESOLUTION ABOVE IT so that this -- the part with
 * the rights and availability behaviour in it -- is testable against any
 * `CatalogMetadataProvider`, including a hand-written one, without composing a
 * real source or a transport. The alternative is a test that can only reach the
 * rights refusal by building a third party's response, which tests the response
 * fixture as much as the rule.
 *
 * EVERY WITHHELD RECORD IS COUNTED, from all three refusal points now -- the
 * pass's own refusals as the store remembers them, the tombstones standing over
 * stored works, and the re-evaluation below -- and the state is derived from the
 * counts rather than asserted. That is what makes `no_records_usable` impossible
 * to reach by accident and impossible to miss when it is reached.
 *
 * ==========================================================================
 * RIGHTS AND AVAILABILITY ARE RE-EVALUATED HERE, AGAINST THE STORED RECORD
 * ==========================================================================
 *
 * The pass that stored a work checked its rights basis and this read checks it
 * AGAIN, on the stored record, before the work reaches an answer. That is not
 * belt and braces, it is the difference between a catalog and a cache of
 * decisions:
 *
 *   - A RIGHTS BASIS CAN LAPSE. The one the pass saw was the operator's register
 *     answer at that moment. `checkRightsBasis` runs here on
 *     `stored.work`, so a stored record whose basis is absent or whose reference
 *     is not opaque is withheld at the read rather than served on the strength
 *     of a pass that accepted it. It matters most for a store this process did
 *     not fill: a durable implementation loads state written by an older build,
 *     another process, or an operator, and the read path has to be correct over
 *     all of those.
 *   - AN AVAILABILITY WINDOW CAN CLOSE. `projectToCatalogRecord` is given
 *     `atMs: now()`, the instant of THIS read, so a window that expired between
 *     the pass and the read withholds the record with the package's
 *     `not_available_in_territory`. This is why the store holds `AcceptedWork`
 *     and not projected records: a projection is an answer to "may this reader
 *     see this, here, now", and storing one freezes the "now".
 *
 * A RECORD IS NEVER SERVED BECAUSE A PASS ACCEPTED IT AN HOUR AGO.
 */
export function catalogSourceOverProvider(
  provider: CatalogMetadataProvider,
  read: CatalogIngestionReadOptions,
  now: () => number,
  scheduling: CatalogIngestionScheduling
): DescribingCatalogMetadataSource {
  const describeCatalog = async (): Promise<CatalogIngestionAnswer> => {
    const run = await refreshCatalogIfDue({
      provider,
      store: scheduling.store,
      schedule: scheduling.schedule,
      pass: { pageSize: read.pageSize, maxPages: read.maxPages },
      now
    });

    const snapshot = run.snapshot;
    const servedFromStoredState = !run.refreshed || run.result?.failure !== null;

    if (snapshot === null || snapshot.observedAt === null) {
      /*
       * NO STATE AT ALL, so there is nothing to serve and an empty list would be
       * the exact lie the four-state design exists to stop. This is reachable in
       * two ways and both throw: a cold start whose first pass failed, and a
       * process still inside the backoff from such a failure -- the second one
       * throws the REMEMBERED failure without going out again, which is the
       * point of storing it.
       */
      const failure = snapshot?.lastRefresh.failure ?? run.result?.failure ?? null;
      if (failure !== null) {
        throw new CatalogMetadataSourceUnavailableError(failure.reason, failure.detail);
      }
      /*
       * Unreachable by construction: a pass that did not fail records its
       * observation instant, so a snapshot with no `observedAt` and no failure
       * would mean a successful pass stored nothing at all. Stated rather than
       * silently falling through to an empty answer, because falling through
       * would publish "the catalog is empty" for a condition nobody understands.
       */
      throw new CatalogMetadataSourceUnavailableError(
        "provider_response_malformed",
        "the catalog store holds neither an observation nor a failure"
      );
    }

    const { live, tombstoned } = partitionCatalogWorks(snapshot);

    const withheld: CatalogIngestionRecordWithheld[] = snapshot.refused.map((refusal) => ({
      recordId: refusal.nativeId,
      reason: refusal.reason
    }));
    /*
     * A TOMBSTONE SURVIVES A REFRESH AND IS REPORTED, NOT JUST OBEYED. The work
     * is in the store and is not in the answer, and the reason it is not is the
     * source's own -- `withdrawn_by_source` or `absent_from_complete_sync`.
     * `store.ts` holds the rule about what may release one; this only reads it.
     */
    for (const { work, tombstone } of tombstoned) {
      withheld.push({ recordId: work.work.contentId, reason: tombstone.reason });
    }

    const records: CatalogMetadataRecord[] = [];
    const atMs = now();
    for (const accepted of live) {
      const rights = checkRightsBasis(accepted.work);
      if (!rights.ok) {
        withheld.push({ recordId: accepted.work.contentId, reason: rights.reason });
        continue;
      }

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
      observedAt: snapshot.observedAt,
      complete: snapshot.complete,
      freshness: run.verdict,
      refresh: {
        attempted: run.refreshed,
        status: snapshot.lastRefresh.status,
        failure: snapshot.lastRefresh.failure,
        servedFromStoredState,
        scheduleReason: run.plan.reason,
        nextDueAtMs: run.plan.dueAtMs,
        consecutiveFailures: snapshot.lastRefresh.consecutiveFailures
      }
    };
  };

  return {
    sourceId: provider.sourceId,
    describeCatalog,
    listRecords: async () => (await describeCatalog()).records,
    /*
     * A LOOKUP NO LONGER COSTS A PASS, AND STILL DOES NOT READ A STALE RECORD.
     * This used to run a full pass per lookup, and the comment here explained
     * that a cache would be worse because it would hand a caller a record the
     * source had since withdrawn. The store answers that objection rather than
     * ignoring it: a withdrawn work is under a tombstone, `partitionCatalogWorks`
     * keeps it out of `records`, and the rights and availability of everything
     * else are re-decided above on every call. So this reads stored state, and
     * what it reads has been re-evaluated for this reader at this instant.
     */
    findRecord: async (contentId) => {
      const answer = await describeCatalog();
      return answer.records.find((record) => record.item.id === contentId) ?? null;
    }
  };
}

/**
 * One store per registered runtime, for as long as that runtime is registered.
 *
 * ==========================================================================
 * WHY THIS EXISTS AT ALL, WHICH IS A PROPERTY OF THE REGISTRY AND NOT A
 * PREFERENCE
 * ==========================================================================
 *
 * `resolveCatalogMetadataSource` calls `createCatalogIngestionSource(runtime)`
 * ON EVERY CALL -- it builds a source per request rather than holding one. So a
 * store created inside that function would be discarded before anything could
 * read it, every read would find an empty store, every read would therefore be
 * due, and PL-0309 would have changed nothing about the defect it exists to fix:
 * one full pass per query. The lifetime the store needs is the lifetime of the
 * RUNTIME, which is the value a composition root constructs once and registers.
 *
 * KEYED ON THE RUNTIME OBJECT, NOT A MODULE SINGLETON. A single module-level
 * store would be shared by every runtime this process ever composes, so a test's
 * runtime and a deployment's runtime would read each other's catalog, and
 * `registerCatalogIngestionRuntime(null)` -- which tests call in a `finally`
 * precisely so one suite's configuration does not leak into the next -- would
 * leave the state behind. A `WeakMap` keyed on the runtime makes the store's
 * lifetime exactly the runtime's: drop the last reference to the runtime and the
 * store goes with it.
 *
 * `runtime.store` WINS WHENEVER IT IS SUPPLIED, and that is the path a durable
 * implementation takes. This fallback is for the composition root that has not
 * been taught to construct one yet, which today is all of them.
 */
const storesByRuntime = new WeakMap<CatalogIngestionRuntime, CatalogStore>();

function storeForRuntime(runtime: CatalogIngestionRuntime): CatalogStore {
  if (runtime.store !== undefined) return runtime.store;
  const existing = storesByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const created = createInMemoryCatalogStore();
  storesByRuntime.set(runtime, created);
  return created;
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
 *
 * `schedule` RESOLVES TO `null` WHEN A RUNTIME DOES NOT STATE ONE, which the
 * package reads as `policy_not_stated` and which refreshes on every read. That
 * is the same behaviour this adapter had before it was scheduled, reached by a
 * named absence rather than by a policy invented here -- see the field's comment
 * on `CatalogIngestionRuntime` for the routing constraint behind it.
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
    source: catalogSourceOverProvider(resolution.provider, runtime.read, runtime.now, {
      schedule: runtime.schedule ?? null,
      store: storeForRuntime(runtime)
    })
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
