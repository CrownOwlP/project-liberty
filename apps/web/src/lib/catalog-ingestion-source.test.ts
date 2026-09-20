import { describe, expect, it } from "vitest";
import {
  LICENSED_CATALOG_SOURCE_IDS,
  WIKIDATA_CC0_HOSTS,
  noRightsBasisEstablished,
  type CatalogMetadataProvider,
  type CatalogProviderRuntime,
  type EgressPolicy,
  type HostClass,
  type IngestedWork,
  type ManifestFetchDependencies,
  type PinnedFetch,
  type ProviderPageResult,
  type RawProviderRecord
} from "@liberty/catalog-ingestion";
import {
  CatalogMetadataSourceUnavailableError,
  catalogSourceOverProvider,
  createCatalogIngestionSource,
  requireCatalogDescription,
  type CatalogIngestionReadOptions
} from "./catalog-ingestion-source";

/* -------------------------------------------------------------------------
 * The adapter that stands @liberty/catalog-ingestion behind the app's port
 *
 * WHAT IS FAKED HERE AND WHAT IS NOT. The PROVIDER is a hand-written object
 * satisfying the package's published `CatalogMetadataProvider`, and nothing
 * else is: `runIngestionPass`, `deriveNormalizedContentId`,
 * `ingestedWorkSchema`, `findMediaAddresses`, `checkRightsBasis` and
 * `projectToCatalogRecord` are the real ones, so a rights refusal in these
 * tests is the package's refusal and not a restatement of it.
 *
 * WHY A HAND-WRITTEN PROVIDER RATHER THAN A RECORDED WIKIDATA RESPONSE. Two
 * reasons, and the second is the one that matters. The rules under test --
 * rights fail closed, availability is not invented, four states stay apart --
 * are source-independent, and a test written against one source's response
 * shape tests that fixture as much as the rule. And `apps/web` must not grow
 * knowledge of a specific source: building a SPARQL response in this directory
 * would be exactly the Wikidata-shaped thing that is supposed to live behind
 * the package boundary. The one test that DOES name the licensed source is the
 * composition test at the foot of this file, and it reaches it only through the
 * package's public API.
 * ---------------------------------------------------------------------- */

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");
const SOURCE_ID = "test-source";

const READ: CatalogIngestionReadOptions = {
  locales: ["en"],
  territory: "GB",
  unstatedAvailability: "refuse",
  pageSize: 10,
  maxPages: 3
};

/**
 * A work exactly as a source would state it, with every field a caller can vary.
 *
 * `contentId` IS DERIVED THE WAY THE PASS DERIVES IT -- `<sourceId>-<nativeId>`
 * -- rather than written out, because `runIngestionPass` refuses a record whose
 * stated id does not match its own derivation, and a test that hardcoded the
 * string would be one rename away from asserting that refusal by accident.
 */
const work = (nativeId: string, over: Partial<IngestedWork> = {}): IngestedWork => ({
  contentId: `${SOURCE_ID}-${nativeId}`,
  kind: "movie",
  titles: [{ locale: "en", value: `Work ${nativeId}` }],
  synopses: [],
  genres: [{ locale: "en", value: "Drama" }],
  releaseYear: 2001,
  runtimeMinutes: 101,
  episodeCount: null,
  availability: [{ territory: "WW", startsAt: null, endsAt: null }],
  artwork: [],
  rights: { category: "owned", reference: "rights-register-0001" },
  ...over
});

const raw = (nativeId: string, over: Partial<IngestedWork> = {}): RawProviderRecord => ({
  nativeId,
  sourceRevision: null,
  crossRefs: [],
  raw: work(nativeId, over)
});

/** A provider that answers one page and then ends. */
const providerOf = (records: readonly RawProviderRecord[]): CatalogMetadataProvider => ({
  sourceId: SOURCE_ID,
  capabilities: {
    providerSideSearch: false,
    incrementalSince: false,
    reportsDeletions: false,
    maxPageSize: 50
  },
  fetchPage: () =>
    Promise.resolve({ ok: true, records, nextCursor: null, withdrawn: [] } satisfies ProviderPageResult)
});

/** A provider that cannot answer. */
const failingProvider = (): CatalogMetadataProvider => ({
  sourceId: SOURCE_ID,
  capabilities: {
    providerSideSearch: false,
    incrementalSince: false,
    reportsDeletions: false,
    maxPageSize: 50
  },
  fetchPage: () =>
    Promise.resolve({
      ok: false,
      reason: "provider_unreachable",
      detail: "the name did not resolve"
    } satisfies ProviderPageResult)
});

const sourceOver = (provider: CatalogMetadataProvider, read: CatalogIngestionReadOptions = READ) =>
  catalogSourceOverProvider(provider, read, () => NOW_MS);

/* ---------------------------------------------------------------------- */

describe("rights fail closed", () => {
  /*
   * THE CLAUSE THAT MATTERS MOST, and the one a working provider makes easy to
   * get wrong: a source that can enumerate a catalogue is not a source that has
   * authorized anything. Wikidata knowing that a film exists says nothing about
   * this operator's right to surface it, and the record below is exactly that
   * case -- complete, valid, well-formed, and with no basis anybody established.
   *
   * IT IS NOT SURFACED AND IT IS NOT SILENT. The record is withheld with the
   * package's own `rights_basis_not_declared`, so an empty rail comes with a
   * per-record reason rather than looking like an empty catalog.
   */
  it("withholds a well-formed record whose rights basis nobody established", async () => {
    const source = sourceOver(providerOf([raw("q1", { rights: null })]));
    const answer = await source.describeCatalog();

    expect(answer.records).toEqual([]);
    expect(answer.state).toBe("no_records_usable");
    expect(answer.withheld).toEqual([{ recordId: "q1", reason: "rights_basis_not_declared" }]);
  });

  /*
   * THE NEAR MISS THAT WOULD HAVE POPULATED THE RAIL. `CatalogItem.rights` is
   * REQUIRED by the published contract to hold one of three values whether or
   * not anybody established a basis, and `projectToCatalogRecord` fills it with
   * the most restrictive value in the vocabulary precisely so an undeclared work
   * can still be parsed and then refused BY NAME. An adapter that read that
   * field as evidence would turn "we have not checked" into "licensed" for every
   * work the source is quiet about.
   *
   * Asserted as an absence of items rather than as a property of one, because
   * the failure mode is a record appearing, not a record appearing wrong.
   */
  it("does not read the item's own rights field as a substitute for a basis", async () => {
    const source = sourceOver(providerOf([raw("q1", { rights: null }), raw("q2")]));
    const answer = await source.describeCatalog();

    expect(answer.records.map((record) => record.item.id)).toEqual([`${SOURCE_ID}-q2`]);
    expect(answer.records.every((record) => record.rights !== null)).toBe(true);
    expect(answer.state).toBe("records_available");
  });

  /*
   * The default position of an operator who holds no register, end to end. It is
   * the state a Wikidata-backed deployment is in until somebody does the rights
   * work, and the honest outcome is a rail that is empty for a stated reason.
   */
  it("publishes nothing at all when no record has a basis", async () => {
    const source = sourceOver(
      providerOf([raw("q1", { rights: null }), raw("q2", { rights: null })])
    );

    expect(await source.listRecords()).toEqual([]);
    expect(await source.findRecord(`${SOURCE_ID}-q1`)).toBeNull();
    expect((await source.describeCatalog()).withheld).toHaveLength(2);
  });
});

describe("availability stays honest", () => {
  /*
   * A source that names no territory has told us nothing, and under the
   * fail-closed reading the work is withheld rather than shown. What this test
   * is really guarding is the absence of the shortcut: nothing in the adapter
   * synthesises a window to make the record pass.
   */
  it("withholds a work whose availability the source never stated", async () => {
    const source = sourceOver(providerOf([raw("q1", { availability: [] })]));
    const answer = await source.describeCatalog();

    expect(answer.state).toBe("no_records_usable");
    expect(answer.withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "availability_not_stated" }
    ]);
  });

  /*
   * A window that exists and does not cover the reader. Distinct from the above
   * -- one is "nobody said", the other is "somebody said no" -- and the package
   * names them differently, which this carries through unchanged.
   */
  it("withholds a work whose window does not cover the requested territory", async () => {
    const source = sourceOver(
      providerOf([raw("q1", { availability: [{ territory: "FR", startsAt: null, endsAt: null }] })])
    );

    expect((await source.describeCatalog()).withheld).toEqual([
      { recordId: `${SOURCE_ID}-q1`, reason: "not_available_in_territory" }
    ]);
  });

  /*
   * `treat_as_worldwide` IS AN OPERATOR ASSERTION AND STILL NOT A FABRICATED
   * WINDOW. The record goes through, and the thing asserted here is that no
   * window appeared anywhere as a result: the work is published because an
   * operator stated a reading of unstated availability, not because the adapter
   * invented an availability claim on their behalf. `CatalogItem` has no
   * availability field, which is what makes that structural rather than
   * conventional.
   */
  it("carries an operator's stated reading of unstated availability without inventing a window", async () => {
    const source = sourceOver(providerOf([raw("q1", { availability: [] })]), {
      ...READ,
      unstatedAvailability: "treat_as_worldwide"
    });
    const answer = await source.describeCatalog();

    expect(answer.state).toBe("records_available");
    expect(answer.records).toHaveLength(1);
    expect(Object.keys(answer.records[0]?.item ?? {})).not.toContain("availability");
  });
});

describe("four states, four answers", () => {
  /*
   * STATE 2 AND STATE 4, WHICH ARE THE PAIR THAT IS ACTUALLY HARD. Both answer
   * `[]` from `listRecords()` and both really do have no records, so the
   * distinction was never going to live in the array. It lives in
   * `describeCatalog`, and the assertion is written as a whole-value comparison
   * of the two answers so that an implementation which stopped recording
   * withholdings -- and therefore started calling state 2 an empty catalog --
   * fails here rather than passing a length check.
   */
  it("tells 'nothing usable' apart from 'nothing there'", async () => {
    const nothingUsable = await sourceOver(
      providerOf([raw("q1", { rights: null })])
    ).describeCatalog();
    const nothingThere = await sourceOver(providerOf([])).describeCatalog();

    expect(nothingUsable.state).toBe("no_records_usable");
    expect(nothingThere.state).toBe("catalog_empty");

    expect(nothingUsable.records).toEqual([]);
    expect(nothingThere.records).toEqual([]);
    expect(nothingUsable.withheld).toHaveLength(1);
    expect(nothingThere.withheld).toEqual([]);
  });

  /*
   * STATE 3. A provider that could not be reached is not a catalog that is
   * empty, and the difference has to survive as far as `loadHomeCatalog`, which
   * converts a throw into `catalog_source_unavailable` and an empty list into
   * `empty`. So the adapter THROWS -- the port's documented contract -- and
   * carries the package's own named failure on the error rather than in its
   * message text.
   *
   * ALL THREE ENTRY POINTS, because a caller that reached the source through
   * `findRecord` must not be told `null`, which means "no such title".
   */
  it("throws a named failure rather than answering an empty catalog", async () => {
    const source = sourceOver(failingProvider());

    await expect(source.describeCatalog()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
    await expect(source.listRecords()).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );
    await expect(source.findRecord("anything")).rejects.toBeInstanceOf(
      CatalogMetadataSourceUnavailableError
    );

    await source.describeCatalog().catch((error: unknown) => {
      expect(error).toBeInstanceOf(CatalogMetadataSourceUnavailableError);
      if (!(error instanceof CatalogMetadataSourceUnavailableError)) return;
      expect(error.reason).toBe("provider_unreachable");
      expect(error.detail).toBe("the name did not resolve");
    });
  });

  /*
   * An answer states when it was read and whether it was read in full, so
   * "nothing there" is never claimed on the strength of a truncated pass.
   */
  it("dates its answer and says whether the source was read in full", async () => {
    const answer = await sourceOver(providerOf([raw("q1")])).describeCatalog();

    expect(answer.observedAt).toBe(new Date(NOW_MS).toISOString());
    expect(answer.complete).toBe(true);
  });
});

describe("requireCatalogDescription", () => {
  /*
   * Returns the METHOD rather than a boolean, for the reason
   * `requireProviderSideSearch` gives about the provider port's optional search:
   * a boolean leaves a `?.` call written somewhere, and the `?.` answers
   * `undefined` on the day the check and the call disagree.
   */
  it("hands back a callable bound to its source", async () => {
    const source = sourceOver(providerOf([raw("q1")]));
    const describe = requireCatalogDescription(source);

    expect(describe).not.toBeNull();
    expect((await describe?.())?.state).toBe("records_available");
  });

  /*
   * A source that cannot tell state 2 from state 4 says so by not implementing
   * the method, and gets `null` rather than a guessed answer.
   */
  it("answers null for a source that cannot describe itself", () => {
    expect(
      requireCatalogDescription({
        sourceId: "no-description",
        listRecords: () => [],
        findRecord: () => null
      })
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * The composition, over the real licensed source
 * ---------------------------------------------------------------------- */

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.")) return "loopback";
  if (host.startsWith("10.") || host.startsWith("192.168.")) return "private";
  return "public";
};

/**
 * A transport that would answer if anything asked it.
 *
 * NOTHING IN THIS FILE LETS IT BE ASKED. The composition tests below assert what
 * `createCatalogIngestionSource` DECIDES -- whether a provider exists for this
 * runtime -- and a decision is made at construction, before a page is fetched.
 * `fetchImpl` throwing is therefore the assertion that no test here opened a
 * socket, not a stub for one.
 */
const unusedTransport = (): ManifestFetchDependencies => {
  const fetchImpl: PinnedFetch = () => {
    throw new Error("no test in this file may reach the network");
  };
  return {
    fetchImpl,
    classifyHost,
    resolveHost: () => Promise.resolve(["198.51.100.10"]),
    now: () => NOW_MS
  };
};

const licensedEgress: EgressPolicy = {
  allowedHosts: [...WIKIDATA_CC0_HOSTS],
  allowLoopback: false,
  localDeployment: false
};

/**
 * A runtime for the one licensed source.
 *
 * THE SOURCE NAME IS READ OUT OF THE PACKAGE'S FROZEN LIST rather than written
 * as a literal. The licensing decision is an INITIAL SOURCE CHOICE AND NOT AN
 * EXCLUSIVE MANDATE, and a test that hardcoded `"wikidata"` would have to be
 * edited the day a second source is licensed -- which is the day this test
 * should keep passing unchanged.
 *
 * `noRightsBasisEstablished` IS PASSED BY NAME. It is the honest register for an
 * operator who holds none, and the package requires it to be stated rather than
 * inherited, so this composition publishes nothing. That is the correct outcome
 * for a test that is about whether the source can be STOOD UP, not about what it
 * would serve.
 */
const licensedRuntime = (over: Partial<CatalogProviderRuntime> = {}): CatalogProviderRuntime => ({
  sourceId: LICENSED_CATALOG_SOURCE_IDS[0] ?? "",
  selection: { classQid: "Q11424", kind: "movie", locales: ["en"] },
  document: {
    egress: licensedEgress,
    timeoutMs: 10_000,
    maxResponseBytes: 4_000_000,
    maxRedirects: 3,
    userAgent: "LibertyCatalog/0.1 (https://liberty.example.test; ops@example.test)"
  },
  transport: unusedTransport(),
  rightsRegister: noRightsBasisEstablished,
  ...over
});

describe("createCatalogIngestionSource", () => {
  /*
   * THE WIRING, ASSERTED. This is the statement round 51 exists to make true:
   * the application can stand the package's real, licensed, network-backed
   * source behind its own port. The source that comes back reports the
   * PROVIDER'S id, so a diagnostic naming a wrong rail names the provider that
   * supplied it.
   */
  it("stands the real licensed source behind the application's port", () => {
    const created = createCatalogIngestionSource({
      provider: licensedRuntime(),
      read: READ,
      now: () => NOW_MS
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.sourceId).toBe(LICENSED_CATALOG_SOURCE_IDS[0]);
    expect(typeof created.source.describeCatalog).toBe("function");
  });

  /*
   * NO HIDDEN CREDENTIALED SOURCE. A name nobody licensed gets no provider and
   * gets told so in those words, which is the refusal that keeps a keyed source
   * out: attaching an API key to a catalog is a separate Credentials escalation
   * that has not been taken.
   */
  it("refuses a source name no licensing decision covers", () => {
    const created = createCatalogIngestionSource({
      provider: licensedRuntime({ sourceId: "tmdb" }),
      read: READ,
      now: () => NOW_MS
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("no_catalog_provider_licensed");
  });

  /*
   * A LICENSED SOURCE AND A RUNTIME THAT CANNOT BE COMPOSED OVER IT. Separate
   * from the refusal above because the remedies are opposite: one needs a human
   * licensing decision, the other needs a corrected deployment. An egress policy
   * reaching outside the licensed namespaces is the case with a rights
   * consequence, which is why it is the one asserted.
   */
  it("refuses a runtime whose egress reaches outside the licensed namespaces", () => {
    const created = createCatalogIngestionSource({
      provider: licensedRuntime({
        document: {
          ...licensedRuntime().document,
          egress: {
            allowedHosts: [...WIKIDATA_CC0_HOSTS, "en.wikipedia.org"],
            allowLoopback: false,
            localDeployment: false
          }
        }
      }),
      read: READ,
      now: () => NOW_MS
    });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("catalog_provider_configuration_refused");
    expect(created.detail).toContain("egress policy");
  });
});
