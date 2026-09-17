import { describe, expect, it } from "vitest";
import type {
  EgressPolicy,
  HostClass,
  ManifestFetchDependencies,
  PinnedFetch,
  PinnedTarget
} from "@liberty/media-inspection";
import {
  WIKIDATA_HYDRATION_RESPONSE,
  WIKIDATA_PAGE_RESPONSE,
  WIKIDATA_RATE_LIMITED_BODY,
  WIKIDATA_SEARCH_RESPONSE
} from "./__fixtures__/wikidata";
import { runIngestionPass } from "./ingest";
import { projectCatalogAnswer } from "./project";
import { requireProviderSideSearch, resolveCatalogMetadataProvider } from "./provider";
import type { NormalizedContentId } from "@liberty/contracts/shared/ids";
import { findMediaAddresses } from "./safety";
import { CATALOG_DOCUMENT_LIMITS, type CatalogDocumentOptions } from "./transport";
import {
  WIKIDATA_CAPABILITIES,
  createWikidataProvider,
  noRightsBasisEstablished,
  type WikidataRightsRegister,
  type WikidataSelection
} from "./wikidata";
import {
  RECORD_SEPARATOR,
  buildPageQuery,
  buildPageRequestUrl,
  buildSearchRequestUrl,
  checkWikidataUserAgent,
  containsServiceClause,
  requireCc0EntityId
} from "./wikidata-query";

/* -------------------------------------------------------------------------
 * The Wikidata adapter, driven by recorded real responses
 *
 * EVERY NETWORK CALL IN THIS FILE GOES THROUGH THE REAL EGRESS BOUNDARY. The
 * provider is handed a `ManifestFetchDependencies` whose `fetchImpl` is scripted
 * -- the same technique `transport.test.ts` uses and for the same reason: the
 * classifier and the resolver are injected ports, so a consumer's tests can
 * exercise the composition without reimplementing an SSRF filter. What is NOT
 * stubbed is `fetchCatalogDocument`, `fetchManifestText`, the allowlist, the
 * host classification or the body cap. A provider that had grown its own fetch
 * would fail these tests by never reaching the script.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The live counterpart is
 * `wikidata.live.test.ts`, which is excluded from the default suite by
 * `vitest.config.ts` and run with `npm run test:live` in this package.
 * ---------------------------------------------------------------------- */

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.")) return "loopback";
  if (host.startsWith("10.") || host.startsWith("192.168.") || host === "169.254.169.254") {
    return "private";
  }
  return "public";
};

const WIKIDATA_EGRESS: EgressPolicy = {
  allowedHosts: ["query.wikidata.org", "www.wikidata.org"],
  allowLoopback: false,
  localDeployment: false
};

const GOOD_AGENT = "LibertyCatalogIngestion/0.1 (https://liberty.example.test; ops@example.test)";

const documentOptions = (over: Partial<CatalogDocumentOptions> = {}): CatalogDocumentOptions => ({
  egress: WIKIDATA_EGRESS,
  ...CATALOG_DOCUMENT_LIMITS,
  userAgent: GOOD_AGENT,
  ...over
});

const FILMS: WikidataSelection = {
  classQid: "Q11424",
  kind: "movie",
  locales: ["en", "fr"]
};

interface Scripted {
  readonly deps: ManifestFetchDependencies;
  readonly opened: PinnedTarget[];
  readonly urls: string[];
}

/**
 * A transport that answers a fixed list of responses in order.
 *
 * `opened` records the PINNED TARGETS the boundary authorised, which is how the
 * assertions below distinguish "the provider went through the gate" from "the
 * provider produced the right answer", and `urls` records what was asked for so
 * a test can read the query text the adapter actually built.
 */
const scripted = (responses: readonly Response[]): Scripted => {
  const opened: PinnedTarget[] = [];
  const urls: string[] = [];
  let index = 0;
  const fetchImpl: PinnedFetch = (target) => {
    opened.push(target);
    urls.push(target.url);
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error("more requests than were scripted");
    return Promise.resolve(response);
  };
  return {
    deps: {
      fetchImpl,
      classifyHost,
      resolveHost: () => Promise.resolve(["198.51.100.10"]),
      now: () => NOW
    },
    opened,
    urls
  };
};

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });

const buildProvider = (
  responses: readonly Response[],
  register: WikidataRightsRegister = noRightsBasisEstablished,
  selection: WikidataSelection = FILMS
) => {
  const transport = scripted(responses);
  const created = createWikidataProvider({
    selection,
    document: documentOptions(),
    transport: transport.deps,
    rightsRegister: register
  });
  if (!created.ok) throw new Error(`provider refused: ${created.reason}`);
  return { provider: created.provider, ...transport };
};

/* ---------------------------------------------------------------------- */

describe("the CC0 / CC BY-SA line, as checks rather than prose", () => {
  /*
   * WHAT THIS CATCHES: `SERVICE wikibase:label` -- or any other federated call
   * -- being added to the query because it is shorter than writing `rdfs:label`
   * triples. A SPARQL SERVICE clause reaches an endpoint whose licence is
   * whatever that endpoint says it is, and the licensing decision evidenced CC0
   * for Wikidata's own structured data and for nothing else.
   */
  it("emits no federated SERVICE clause in any query it can build", () => {
    const keyset = buildPageQuery("Q11424", ["en", "fr"], {
      mode: "keyset",
      afterNumericId: 0,
      limit: 50
    });
    const identified = buildPageQuery("Q11424", ["en"], {
      mode: "identified",
      itemIds: ["Q83495"]
    });
    expect(containsServiceClause(keyset)).toBe(false);
    expect(containsServiceClause(identified)).toBe(false);
    // The detector itself has to work, or the two assertions above are vacuous.
    expect(containsServiceClause("SELECT * { SERVICE <x> { ?a ?b ?c } }")).toBe(true);
  });

  /*
   * WHAT THIS CATCHES: an image, a sitelink or an article extract being asked
   * for. `P18` and `P3383` are Commons FILES with their own licences -- film
   * posters on Commons are routinely not free at all -- and a Wikipedia extract
   * is CC BY-SA text, which is the exact confusion the licensing decision warns
   * against.
   */
  it("asks for no image, sitelink, poster or article extract", () => {
    const query = buildPageQuery("Q11424", ["en"], {
      mode: "keyset",
      afterNumericId: 0,
      limit: 5
    });
    for (const forbidden of ["P18", "P154", "P3383", "sitelink", "schema:about", "extract"]) {
      expect(query).not.toContain(forbidden);
    }
  });

  /*
   * WHAT THIS CATCHES: an `M`-id reaching a query. Commons MediaInfo captions
   * are CC0, the FILES they describe are not, and the decision evidenced neither
   * -- so the namespace is refused by name rather than admitted on a guess.
   */
  it("admits only the three namespaces the decision evidenced", () => {
    expect(requireCc0EntityId("Q83495")).toEqual({ ok: true, id: "Q83495" });
    expect(requireCc0EntityId("P31")).toEqual({ ok: true, id: "P31" });
    expect(requireCc0EntityId("L1234")).toEqual({ ok: true, id: "L1234" });
    for (const outside of ["M12345", "Q0", "Q007", "q83495", "Special:EntityData", "", "Q1 Q2"]) {
      expect(requireCc0EntityId(outside)).toEqual({
        ok: false,
        reason: "entity_id_outside_cc0_namespace"
      });
    }
  });

  /*
   * WHAT THIS CATCHES: the CC0 boundary being widened by an operator's egress
   * policy rather than by a code edit. A deployment whose catalog policy also
   * allowed `en.wikipedia.org` would be one query-builder change away from
   * ingesting CC BY-SA article text, so the provider refuses to exist over such
   * a policy. It is an allowlist of exactly two hosts, not a minimum.
   */
  it("refuses to be composed over an egress policy that reaches beyond Wikidata", () => {
    const created = createWikidataProvider({
      selection: FILMS,
      document: documentOptions({
        egress: {
          allowedHosts: ["query.wikidata.org", "www.wikidata.org", "en.wikipedia.org"],
          allowLoopback: false,
          localDeployment: false
        }
      }),
      transport: scripted([]).deps,
      rightsRegister: noRightsBasisEstablished
    });
    expect(created).toEqual({
      ok: false,
      reason: "egress_allows_a_host_outside_the_cc0_namespaces",
      detail: expect.any(String) as unknown as string
    });
  });

  it("refuses to be composed over an egress policy that cannot reach Wikidata at all", () => {
    const created = createWikidataProvider({
      selection: FILMS,
      document: documentOptions({
        egress: { allowedHosts: ["query.wikidata.org"], allowLoopback: false, localDeployment: false }
      }),
      transport: scripted([]).deps,
      rightsRegister: noRightsBasisEstablished
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.reason).toBe("egress_does_not_allow_the_wikidata_endpoints");
    expect(created.detail).toContain("www.wikidata.org");
  });
});

describe("the Wikimedia User-Agent obligation", () => {
  /*
   * WHAT THIS CATCHES: the thing that actually happens -- somebody copies a
   * browser agent string out of devtools to make a request work. The Wikimedia
   * policy names that specifically, and the consequence of ignoring it is an IP
   * block applied to the whole operator without notice, so it is refused at
   * construction rather than discovered on the first page.
   */
  it("refuses an agent string that impersonates a browser", () => {
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    expect(checkWikidataUserAgent(chrome)).toEqual({
      ok: false,
      reason: "user_agent_impersonates_a_browser"
    });
    const created = createWikidataProvider({
      selection: FILMS,
      document: documentOptions({ userAgent: chrome }),
      transport: scripted([]).deps,
      rightsRegister: noRightsBasisEstablished
    });
    expect(created.ok).toBe(false);
  });

  it("refuses an agent string with no way to reach a human", () => {
    expect(checkWikidataUserAgent("liberty-catalog")).toEqual({
      ok: false,
      reason: "user_agent_lacks_contact_information"
    });
    expect(checkWikidataUserAgent("LibertyCatalog/0.1 (ops@example.test)")).toEqual({ ok: true });
    expect(checkWikidataUserAgent("LibertyCatalog/0.1 (https://example.test/contact)")).toEqual({
      ok: true
    });
  });

  /*
   * WHAT THIS CATCHES: a default creeping back onto `userAgent`. The option is
   * required with no default precisely because a default would attach an
   * operator's contact reputation to a string this package chose, and the
   * licensing decision names that requirement as an obligation that follows from
   * it. A default would make this call compile.
   */
  it("keeps userAgent required, so a composition cannot omit it", () => {
    // @ts-expect-error -- `userAgent` has no default and must be supplied.
    const options: CatalogDocumentOptions = { egress: WIKIDATA_EGRESS, ...CATALOG_DOCUMENT_LIMITS };
    expect(options).toBeDefined();
  });
});

describe("fetchPage over recorded real responses", () => {
  it("goes through the egress boundary and reads the three real films", async () => {
    const { provider, opened, urls } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);

    const page = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.records.map((record) => record.nativeId)).toEqual(["Q83005", "Q83495", "Q83505"]);
    // The pin carries the NAME the gate authorised, which is what a wrapper
    // calling `fetch` on the URL could not produce.
    expect(opened[0]?.hostname).toBe("query.wikidata.org");
    expect(urls[0]).toContain("query.wikidata.org/sparql");
  });

  /*
   * WHAT THIS CATCHES: the packing coming apart. Eighteen genre labels in two
   * locales arrive in ONE `GROUP_CONCAT` cell, and if the separators drifted the
   * whole cell would become a single genre whose name is the concatenation of
   * all eighteen -- which parses, renders, and is wrong.
   */
  it("unpacks the locale-tagged columns a real record packs", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    const page = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    const matrix = page.records.find((record) => record.nativeId === "Q83495")?.raw as {
      titles: { locale: string; value: string }[];
      genres: { locale: string; value: string }[];
      synopses: { locale: string; value: string }[];
      releaseYear: number;
      runtimeMinutes: number | null;
      episodeCount: number | null;
      artwork: unknown[];
      availability: unknown[];
    };

    expect(matrix.titles).toEqual([
      { locale: "en", value: "The Matrix" },
      { locale: "fr", value: "Matrix" }
    ]);
    expect(matrix.genres).toContainEqual({ locale: "en", value: "science fiction film" });
    expect(matrix.genres).toContainEqual({ locale: "fr", value: "cyberpunk" });
    expect(matrix.genres.length).toBe(18);
    expect(matrix.synopses.map((entry) => entry.locale)).toEqual(["en", "fr"]);
    expect(matrix.releaseYear).toBe(1999);
    expect(matrix.runtimeMinutes).toBe(136);
    expect(matrix.episodeCount).toBeNull();
    // Statements, not stubs: Wikidata models neither.
    expect(matrix.artwork).toEqual([]);
    expect(matrix.availability).toEqual([]);
  });

  /*
   * WHAT THIS CATCHES: `GROUP_CONCAT` order leaking into the catalog. SPARQL
   * does not specify it, and the two live responses recorded for this package
   * packed `Q83495`'s genres in two DIFFERENT orders on the same day. A pass
   * whose output depended on that would make a diff between two runs meaningless
   * -- which `identity.ts` argues at length must not happen.
   */
  it("orders the unpacked entries deterministically rather than as the engine emitted them", async () => {
    const fromPage = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    const fromHydration = buildProvider([json(WIKIDATA_HYDRATION_RESPONSE)]);

    const page = await fromPage.provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    const hydrated = await fromHydration.provider.fetchPage({
      cursor: null,
      pageSize: 3,
      changedSince: null
    });
    expect(page.ok && hydrated.ok).toBe(true);
    if (!page.ok || !hydrated.ok) return;

    const pageMatrix = page.records.find((record) => record.nativeId === "Q83495")?.raw;
    const hydratedMatrix = hydrated.records.find((record) => record.nativeId === "Q83495")?.raw;
    expect(pageMatrix).toEqual(hydratedMatrix);
  });

  /*
   * WHAT THIS CATCHES: an offset creeping in. The cursor is the numeric part of
   * the highest item id on the page, and the next request must filter on it --
   * an `OFFSET` walk over a continuously edited source skips and repeats
   * records, which is the rule `provider.ts` states for every provider.
   */
  it("issues a keyset cursor and filters on it, never an offset", async () => {
    const { provider, urls } = buildProvider([
      json(WIKIDATA_PAGE_RESPONSE),
      json(WIKIDATA_PAGE_RESPONSE)
    ]);

    const first = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.nextCursor).toBe("83505");

    await provider.fetchPage({ cursor: first.nextCursor, pageSize: 3, changedSince: null });
    const secondQuery = new URL(urls[1] ?? "https://x.test").searchParams.get("query") ?? "";
    expect(secondQuery).toContain("FILTER(?n > 83505)");
    expect(secondQuery).not.toContain("OFFSET");
  });

  it("ends the enumeration on a short page", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    const page = await provider.fetchPage({ cursor: null, pageSize: 10, changedSince: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.nextCursor).toBeNull();
  });

  it("refuses a cursor it did not issue, before building a query", async () => {
    const { provider, urls } = buildProvider([]);
    const page = await provider.fetchPage({
      cursor: "83505) } UNION { ?item ?p ?o",
      pageSize: 3,
      changedSince: null
    });
    expect(page).toEqual({
      ok: false,
      reason: "provider_rejected_request",
      detail: "cursor is not a watermark this provider issued"
    });
    expect(urls).toEqual([]);
  });

  /*
   * WHAT THIS CATCHES: a provider pretending to honour a capability it does not
   * declare. `provider.ts` requires a provider without `incrementalSince` to
   * IGNORE `changedSince` rather than half-implement it, because a pass that
   * believed it was incremental and was not would look complete having read a
   * fraction of the source.
   */
  it("ignores changedSince entirely, because it does not declare incrementalSince", async () => {
    expect(WIKIDATA_CAPABILITIES.incrementalSince).toBe(false);
    const withSince = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    const without = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);

    await withSince.provider.fetchPage({
      cursor: null,
      pageSize: 3,
      changedSince: "2026-09-01T00:00:00.000Z"
    });
    await without.provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });

    expect(withSince.urls[0]).toBe(without.urls[0]);
  });

  it("clamps an oversized page request to what it declared it will serve", async () => {
    const { provider, urls } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    await provider.fetchPage({ cursor: null, pageSize: 5000, changedSince: null });
    const query = new URL(urls[0] ?? "https://x.test").searchParams.get("query") ?? "";
    expect(query).toContain(`LIMIT ${String(WIKIDATA_CAPABILITIES.maxPageSize)}`);
  });

  it("never reports a withdrawal, because it cannot observe one", async () => {
    expect(WIKIDATA_CAPABILITIES.reportsDeletions).toBe(false);
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    const page = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    expect(page.ok && page.withdrawn).toEqual([]);
  });
});

describe("failures a real deployment will meet", () => {
  /*
   * WHAT THIS CATCHES: a rate limit being read as a corrupt source. Wikimedia
   * answers 429 with PLAIN TEXT, not with a JSON error object -- researching this
   * adapter tripped it twice in a few minutes -- so a client that parsed first
   * and checked the status second would report `provider_response_malformed` and
   * send an operator looking for a broken publisher instead of slowing down.
   */
  it("reports a rate limit as a rejected request, not as a malformed document", async () => {
    const { provider } = buildProvider([
      new Response(WIKIDATA_RATE_LIMITED_BODY, {
        status: 429,
        headers: { "content-type": "text/plain" }
      })
    ]);
    const page = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    expect(page).toEqual({
      ok: false,
      reason: "provider_rejected_request",
      detail: "http_status"
    });
  });

  it("reports a document that is not a SPARQL result set as malformed", async () => {
    const { provider } = buildProvider([json({ error: "nope" })]);
    const page = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.reason).toBe("provider_response_malformed");
  });
});

describe("the rights and safety machinery, applied to real records", () => {
  /*
   * WHAT THIS CATCHES: a Wikidata record being published without anybody
   * establishing a right to show the work. Wikidata states that a film EXISTS;
   * it states nothing about this operator's licence, so the default register
   * answers `null` and `checkRightsBasis` refuses EVERY record. An empty catalog
   * is the correct outcome of pointing this provider at a real source with no
   * rights register behind it.
   */
  it("refuses every real record when no rights register has been supplied", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);

    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );

    expect(pass.accepted).toEqual([]);
    expect(pass.refused.map((refusal) => refusal.reason)).toEqual([
      "rights_basis_not_declared",
      "rights_basis_not_declared",
      "rights_basis_not_declared"
    ]);
  });

  /*
   * WHAT THIS CATCHES: the register being bypassed, or the adapter deciding a
   * rights basis from `P6216` on its own. It is handed the raw copyright-status
   * ids and does not read them; an operator who wants to rely on them writes
   * that mapping where a rights reviewer can see it.
   */
  it("accepts a real record only on a basis the operator's register stated", async () => {
    const seen: string[] = [];
    const register: WikidataRightsRegister = (observation) => {
      seen.push(observation.entityId);
      expect(observation.copyrightStatusEntityIds).toEqual([]);
      expect(observation.crossRefs).toContainEqual({ authority: "wikidata", id: observation.entityId });
      return observation.entityId === "Q83495"
        ? { category: "licensed", reference: "rights-register-0001" }
        : null;
    };
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)], register);

    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );

    expect(seen).toEqual(["Q83005", "Q83495", "Q83505"]);
    expect(pass.accepted.map((work) => work.work.contentId)).toEqual(["wikidata-q83495"]);
    expect(pass.refused).toHaveLength(2);
  });

  /*
   * WHAT THIS CATCHES: a rights reference that is not opaque. The predicate is
   * `@liberty/provider-sdk`'s and is applied here rather than restated -- an
   * operator whose register returned a contract URL would be writing an
   * agreement into a catalog record, which `docs/CONTENT_RIGHTS.md` forbids.
   */
  it("refuses a register that answers with something that is not an opaque reference", async () => {
    // Prose with no address in it, deliberately: the reference has to fail the
    // OPACITY rule specifically, and a reference containing a URL would be
    // refused one step earlier -- see the next case, which pins that ordering.
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)], () => ({
      category: "licensed",
      reference: "Acme Studios master agreement, term ends 2027-01-01"
    }));

    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );

    expect(pass.accepted).toEqual([]);
    expect(new Set(pass.refused.map((refusal) => refusal.reason))).toEqual(
      new Set(["rights_basis_reference_not_opaque"])
    );
  });

  /*
   * WHAT THIS CATCHES: the ordering between the two checks, which was found by
   * writing the case above and getting this answer instead. A rights reference
   * carrying a contract URL is refused as a MEDIA ADDRESS, not as a non-opaque
   * reference -- because `findMediaAddresses` runs on the raw payload before
   * anything else does. Both refusals are correct and the address one is the
   * stronger statement, so the ordering is pinned rather than papered over.
   */
  it("refuses a rights reference that carries a URL as an address, before the opacity rule sees it", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)], () => ({
      category: "licensed",
      reference: "https://agreements.example.test/contract/17"
    }));

    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );

    expect(pass.accepted).toEqual([]);
    expect(new Set(pass.refused.map((refusal) => refusal.reason))).toEqual(
      new Set(["media_address_in_catalog_payload"])
    );
    expect(pass.refused[0]?.detail).toContain("rights.reference");
  });

  /*
   * WHAT THIS CATCHES -- AND THIS IS THE ONE THE PRE-PARSE ORDERING EXISTS FOR.
   * A Wikidata label is a field any logged-in person on the internet can edit.
   * A vandalised title reading like a manifest URL is an ordinary non-empty
   * string as far as `localizedTextSchema` is concerned, so a schema-first
   * pipeline would publish it as a work's name. `findMediaAddresses` runs on the
   * RAW payload first and refuses the record instead.
   *
   * The fixture is a real response with ONE label value replaced, so everything
   * around the vandalism is exactly what the source sent.
   */
  it("refuses a record whose real label has been vandalised into a media address", async () => {
    const vandalised = JSON.parse(JSON.stringify(WIKIDATA_PAGE_RESPONSE)) as {
      results: { bindings: { titles?: { type: string; value: string } }[] };
    };
    const first = vandalised.results.bindings[0];
    if (first?.titles === undefined) throw new Error("fixture shape changed");
    // `RECORD_SEPARATOR` rather than an escape written out here: an invisible
    // control character in a test file is unreadable, and a second copy of the
    // separator is one more thing that can drift from the module that owns it.
    first.titles = {
      type: first.titles.type,
      value: `en${RECORD_SEPARATOR}https://cdn.example.test/pirate/master.m3u8`
    };

    const { provider } = buildProvider([json(vandalised)], () => ({
      category: "licensed",
      reference: null
    }));

    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );

    const refusal = pass.refused.find((entry) => entry.nativeId === "Q83005");
    expect(refusal?.reason).toBe("media_address_in_catalog_payload");
    expect(refusal?.detail).toContain("titles.0.value");
    // The other two real records are unaffected: one bad field refuses one
    // record, not a page.
    expect(pass.accepted).toHaveLength(2);
  });

  /*
   * WHAT THIS CATCHES: an address arriving in a payload built from a clean real
   * response. `wbsearchentities` really does return `url` and `concepturi`, the
   * fixture keeps both, and this asserts none of it reaches `raw`.
   */
  it("builds payloads from real responses that carry no address at all", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)]);
    const page = await provider.fetchPage({ cursor: null, pageSize: 3, changedSince: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    for (const record of page.records) {
      expect(findMediaAddresses(record.raw)).toEqual([]);
    }
  });

  /*
   * WHAT THIS CATCHES: a tombstone minted from a pass that did not enumerate the
   * source. Applied to real records because that is where it matters: a
   * rate-limited Wikidata afternoon must not delete the catalog.
   */
  it("withholds tombstones when a real page fails, and mints them from a complete pass", async () => {
    const known = ["wikidata-q83005", "wikidata-q99999"] as unknown as NormalizedContentId[];
    const accepting: WikidataRightsRegister = () => ({ category: "licensed", reference: null });

    const failed = buildProvider(
      [new Response(WIKIDATA_RATE_LIMITED_BODY, { status: 429 })],
      accepting
    );
    const afterFailure = await runIngestionPass(
      failed.provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: known },
      { now: () => NOW }
    );
    expect(afterFailure.tombstones).toEqual([]);
    expect(afterFailure.tombstonesWithheld).toBe("pass_failed");

    const complete = buildProvider([json(WIKIDATA_PAGE_RESPONSE)], accepting);
    const afterComplete = await runIngestionPass(
      complete.provider,
      { pageSize: 10, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: known },
      { now: () => NOW }
    );
    expect(afterComplete.complete).toBe(true);
    expect(afterComplete.tombstones).toEqual([
      {
        contentId: "wikidata-q99999",
        sourceId: "wikidata",
        observedAt: "2026-09-17T12:00:00.000Z",
        reason: "absent_from_complete_sync"
      }
    ]);
  });

  /*
   * WHAT THIS CATCHES: an answer built from real records losing its age. The
   * freshness verdict is computed from the OLDEST record, and the projection
   * refuses on availability -- because Wikidata states none and `refuse` is the
   * fail-closed reading -- which is itself the behaviour worth pinning.
   */
  it("dates an answer built from real records, and refuses them for unstated availability", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)], () => ({
      category: "licensed",
      reference: null
    }));
    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );
    expect(pass.accepted).toHaveLength(3);

    const answer = projectCatalogAnswer(
      pass.accepted,
      { locales: ["en"], territory: "GB", atMs: NOW + 60_000, unstatedAvailability: "refuse" },
      { freshForMs: 3_600_000, staleAfterMs: 86_400_000 },
      NOW + 60_000
    );

    expect(answer).not.toBeNull();
    if (answer === null) return;
    expect(answer.verdict.freshness).toBe("fresh");
    expect(answer.verdict.ageMs).toBe(60_000);
    expect(answer.value.records).toEqual([]);
    expect(new Set(answer.value.refused.map((refusal) => refusal.reason))).toEqual(
      new Set(["availability_not_stated"])
    );
  });

  it("projects a real record to a browse item when the operator reads unstated availability as worldwide", async () => {
    const { provider } = buildProvider([json(WIKIDATA_PAGE_RESPONSE)], () => ({
      category: "licensed",
      reference: "rights-register-0007"
    }));
    const pass = await runIngestionPass(
      provider,
      { pageSize: 3, maxPages: 1, resumeCursor: null, changedSince: null, knownContentIds: [] },
      { now: () => NOW }
    );

    const answer = projectCatalogAnswer(
      pass.accepted,
      {
        locales: ["fr", "en"],
        territory: "FR",
        atMs: NOW,
        unstatedAvailability: "treat_as_worldwide"
      },
      { freshForMs: 3_600_000, staleAfterMs: 86_400_000 },
      NOW
    );

    expect(answer).not.toBeNull();
    if (answer === null) return;
    const matrix = answer.value.records.find((record) => record.item.id === "wikidata-q83495");
    expect(matrix?.item.title).toBe("Matrix");
    expect(matrix?.item.kind).toBe("movie");
    expect(matrix?.item.runtimeMinutes).toBe(136);
    expect(matrix?.rights).toEqual({ category: "licensed", reference: "rights-register-0007" });
  });
});

describe("provider-side search", () => {
  /*
   * WHAT THIS CATCHES: search trusting what the source ranked. `wbsearchentities`
   * really does put an ALBUM called "The Matrix" above the film -- the recorded
   * fixture is that answer -- so the hits are hydrated through the
   * class-constrained query and anything that is not an instance of the
   * configured class simply has no row.
   */
  it("keeps the source's relevance order and drops hits that are not the configured class", async () => {
    const { provider, urls } = buildProvider([
      json(WIKIDATA_SEARCH_RESPONSE),
      json(WIKIDATA_HYDRATION_RESPONSE)
    ]);

    const guarded = requireProviderSideSearch(provider);
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;

    const result = await guarded.search("the matrix", null, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((record) => record.nativeId)).toEqual(["Q83495"]);
    expect(result.nextCursor).toBe("3");
    expect(urls[0]).toContain("www.wikidata.org/w/api.php");
    expect(urls[1]).toContain("query.wikidata.org/sparql");
  });

  /*
   * WHAT THIS CATCHES: the free-text term reaching SPARQL. It never does -- it
   * goes to the Action API as a URL parameter -- and this asserts a term made of
   * SPARQL syntax is percent-encoded rather than interpolated.
   */
  it("never lets a search term reach the query language", () => {
    const built = buildSearchRequestUrl('x" } UNION { ?s ?p ?o ', "en", 0, 5);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url.startsWith("https://www.wikidata.org/w/api.php?")).toBe(true);
    expect(built.url).not.toContain("UNION { ?s");
    expect(decodeURIComponent(new URL(built.url).searchParams.get("search") ?? "")).toBe(
      'x" } UNION { ?s ?p ?o '
    );
  });
});

describe("resolveCatalogMetadataProvider", () => {
  const runtime = {
    sourceId: "wikidata",
    selection: FILMS,
    document: documentOptions(),
    transport: scripted([]).deps,
    rightsRegister: noRightsBasisEstablished
  };

  /*
   * THIS REPLACES THE ROUND-44 TRIPWIRE, WHICH ASSERTED THE OPPOSITE ON PURPOSE.
   * That test said "refuses by name, because no catalog provider has been
   * licensed" and its comment said it "fails the day somebody returns a
   * configured provider, which is exactly when a rights review needs to have
   * happened". That day is 2026-09-17: the human commander's Licensing decision
   * is recorded on PL-0305 as `licensingDecision` and in `control/events.jsonl`
   * as a `decision.licensing` event. The assertion is inverted rather than
   * deleted, so the function that can change the answer is still pinned.
   */
  it("returns the Wikidata provider, because Wikidata is the licensed source", () => {
    const resolution = resolveCatalogMetadataProvider(runtime);
    expect(resolution.status).toBe("configured");
    if (resolution.status !== "configured") return;
    expect(resolution.provider.sourceId).toBe("wikidata");
    expect(resolution.provider.capabilities).toEqual({
      providerSideSearch: true,
      incrementalSince: false,
      reportsDeletions: false,
      maxPageSize: 50
    });
  });

  /*
   * THE TRIPWIRE THAT SURVIVES, AND IT IS THE ONE THAT MATTERS NOW. The decision
   * authorised Wikidata and explicitly did NOT authorise any credentialed
   * source: "TMDB and anything else requiring an API key remains a separate
   * Credentials escalation". This fails the day somebody wires one, which is
   * exactly when a Credentials escalation must have happened.
   */
  it("refuses any source the licensing decision did not name", () => {
    for (const sourceId of ["tmdb", "omdb", "trakt", "", "WIKIDATA"]) {
      const resolution = resolveCatalogMetadataProvider({ ...runtime, sourceId });
      expect(resolution.status).toBe("not-configured");
      if (resolution.status !== "not-configured") continue;
      expect(resolution.reason).toBe("no_catalog_provider_licensed");
    }
  });

  /*
   * WHAT THIS CATCHES: the runtime becoming a way to choose a source. It carries
   * a transport, a policy, an agent string, a rights register and which slice to
   * read -- deployment facts. None of them can make this answer name a different
   * source, and the only thing that decides is `sourceId` against a frozen list.
   */
  it("cannot be pointed at a different source by configuration", () => {
    const elsewhere = resolveCatalogMetadataProvider({
      ...runtime,
      document: documentOptions({
        egress: { allowedHosts: ["api.example.test"], allowLoopback: false, localDeployment: false }
      })
    });
    expect(elsewhere.status).toBe("not-configured");
    if (elsewhere.status !== "not-configured") return;
    expect(elsewhere.reason).toBe("catalog_provider_configuration_refused");
    if (elsewhere.reason !== "catalog_provider_configuration_refused") return;
    expect(elsewhere.refusal).toBe("egress_allows_a_host_outside_the_cc0_namespaces");
  });

  it("refuses a selection outside the CC0 namespaces", () => {
    const resolution = resolveCatalogMetadataProvider({
      ...runtime,
      selection: { ...FILMS, classQid: "M12345" }
    });
    expect(resolution.status).toBe("not-configured");
    if (resolution.status !== "not-configured") return;
    expect(resolution.reason).toBe("catalog_provider_configuration_refused");
    if (resolution.reason !== "catalog_provider_configuration_refused") return;
    expect(resolution.refusal).toBe("class_id_outside_cc0_namespace");
  });

  /*
   * WHAT THIS CATCHES: a class id being interpolated without validation. The
   * builders are the validators and the resolver runs one at construction, so a
   * selection that would close a SPARQL literal never becomes a provider.
   */
  it("refuses a class id that would break out of the query", () => {
    const built = buildPageRequestUrl("Q11424 } UNION { ?s ?p ?o", ["en"], 0, 10);
    expect(built).toEqual({
      ok: false,
      reason: "class_id_outside_cc0_namespace",
      detail: expect.any(String) as unknown as string
    });
  });
});
