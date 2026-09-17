import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import { describe, expect, it } from "vitest";
import type { EgressPolicy, HostClass, ManifestFetchDependencies } from "@liberty/media-inspection";
import { nodePinnedFetch } from "@liberty/media-inspection/node/pinned-fetch";
import { WIKIDATA_PAGE_RESPONSE } from "./__fixtures__/wikidata";
import { CATALOG_DOCUMENT_LIMITS } from "./transport";
import { createWikidataProvider, noRightsBasisEstablished } from "./wikidata";

/* -------------------------------------------------------------------------
 * THIS FILE TALKS TO THE REAL WIKIDATA AND IS NOT IN THE DEFAULT SUITE
 *
 * HOW IT IS KEPT OUT, mechanically rather than by convention: `vitest.config.ts`
 * in this package excludes `**\/*.live.test.ts` from the default `test` run, and
 * that run is the only one `turbo run test` and `npm run check` invoke. To run
 * this file you have to ask for it: `npm run test:live` in this package, which
 * points vitest at this one path and overrides nothing else.
 *
 * WHY IT IS NOT IN THE GATE. A test that needs the network is a liability in a
 * gate and this one is a particularly bad candidate for two independent reasons.
 * Wikimedia rate-limits aggressively -- researching this adapter tripped an HTTP
 * 429 twice inside a few minutes from one address -- so a CI fleet running it on
 * every push would be a self-inflicted block against an operator's whole IP, and
 * the Wikimedia User-Agent policy says a blocked client is blocked without
 * notice. And a shared public endpoint is allowed to be slow: the enumeration
 * query measured between 2.3 and 32.8 seconds depending on how far into the
 * class the watermark sits. Neither of those is a defect in this repository, and
 * a red gate that means "Wikidata is busy" teaches the reader to ignore the gate.
 *
 * WHAT IT IS FOR. The recorded fixtures in `__fixtures__` cannot notice that
 * reality has moved: Wikidata is edited continuously, and the query this package
 * sends could stop being valid -- a property deprecated, a `wikibase:` predicate
 * renamed, the service's result shape changed -- while every fixture-driven test
 * stayed green. This is the check a human runs deliberately when they want to
 * know whether the recording is still a recording of something real.
 *
 * IT ASSERTS SHAPE, NOT CONTENT. `Q83495` will keep being a 1999 film called
 * "The Matrix"; how many genres it carries is whatever the last editor decided,
 * so nothing here pins a count or a list. What is pinned is that the query
 * parses, the service answers it, the columns come back with the names the
 * reader expects, and the record built from the live answer still carries no
 * media address and still has no rights basis.
 *
 * THE HOST CLASSIFIER AND RESOLVER BELOW ARE TEST DOUBLES FOR INJECTED PORTS,
 * not a second SSRF implementation -- the same statement `transport.test.ts`
 * makes about its own. The difference here is that the resolver really resolves,
 * because the request really goes out.
 * ---------------------------------------------------------------------- */

const LIVE_EGRESS: EgressPolicy = {
  allowedHosts: ["query.wikidata.org", "www.wikidata.org"],
  allowLoopback: false,
  localDeployment: false
};

/**
 * The agent string this run identifies itself with.
 *
 * INFORMATIVE AND CARRYING CONTACT INFORMATION, because the Wikimedia policy
 * requires it and because `createWikidataProvider` refuses to build without it.
 * It names this repository and a reachable address rather than a browser.
 */
const LIVE_USER_AGENT =
  "LibertyCatalogIngestion/0.1 (https://github.com/project-liberty; contact: operator@example.test) node-fetch-pinned";

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.") || host === "::1") return "loopback";
  if (isIP(host) === 0 && !/^[a-z0-9.-]+$/.test(host)) return "unparseable";
  if (/^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(host)) return "private";
  return "public";
};

const liveDependencies: ManifestFetchDependencies = {
  fetchImpl: nodePinnedFetch,
  classifyHost,
  resolveHost: async (hostname) => dns.resolve4(hostname),
  now: () => Date.now()
};

const provider = () => {
  const created = createWikidataProvider({
    selection: { classQid: "Q11424", kind: "movie", locales: ["en", "fr"] },
    document: {
      egress: LIVE_EGRESS,
      ...CATALOG_DOCUMENT_LIMITS,
      // The enumeration query is legitimately slow against a large class: 32.8s
      // measured at watermark 0 over `Q11424`, 2.3s at 83000. The default 10s is
      // right for a catalog page from a dedicated API and wrong for a shared
      // public SPARQL service, so this run states its own.
      timeoutMs: 45_000,
      userAgent: LIVE_USER_AGENT
    },
    transport: liveDependencies,
    rightsRegister: noRightsBasisEstablished
  });
  if (!created.ok) throw new Error(`provider refused: ${created.reason}: ${created.detail}`);
  return created.provider;
};

describe("Wikidata, live", () => {
  it(
    "still answers the enumeration query with the columns the adapter reads",
    async () => {
      const page = await provider().fetchPage({
        cursor: "83000",
        pageSize: 3,
        changedSince: null
      });

      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.records.length).toBeGreaterThan(0);

      const first = page.records[0];
      expect(first?.nativeId).toMatch(/^Q[1-9][0-9]*$/);
      const raw = first?.raw as {
        titles: { locale: string; value: string }[];
        genres: { locale: string; value: string }[];
        releaseYear: unknown;
        rights: unknown;
        artwork: unknown[];
        availability: unknown[];
      };
      expect(raw.titles.length).toBeGreaterThan(0);
      expect(raw.genres.length).toBeGreaterThan(0);
      expect(typeof raw.releaseYear).toBe("number");
      // The two statements this adapter makes about what Wikidata does not
      // model, checked against the real answer rather than against a fixture.
      expect(raw.artwork).toEqual([]);
      expect(raw.availability).toEqual([]);
      // And the one that matters most: a real record still establishes no
      // rights basis, so it is still refused downstream.
      expect(raw.rights).toBeNull();
    },
    60_000
  );

  it(
    "still returns the recorded films for the recorded page request",
    async () => {
      const page = await provider().fetchPage({
        cursor: "83000",
        pageSize: 4,
        changedSince: null
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;

      /*
       * IDS, NOT CONTENT. The recorded fixture's three films are `Q83005`,
       * `Q83495` and `Q83505` and a fourth (`Q83103`) was dropped from the
       * recording. Which items are instances of `Q11424` above `Q83000` can
       * change -- an editor can add or remove a `P31` statement -- so a
       * disagreement here is a signal to re-record, not necessarily a defect.
       */
      const recorded = (
        WIKIDATA_PAGE_RESPONSE as {
          results: { bindings: { item: { value: string } }[] };
        }
      ).results.bindings.map((binding) => binding.item.value.split("/").pop());

      const live = page.records.map((record) => record.nativeId);
      for (const id of recorded) {
        expect(live).toContain(id);
      }
    },
    60_000
  );

  it(
    "still ranks an album above the film for 'the matrix', and still filters it out",
    async () => {
      const search = provider().searchWorks;
      expect(search).toBeDefined();
      if (search === undefined) return;

      const result = await search.call(provider(), "the matrix", null, 5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Every surviving record is an instance of the configured class, because
      // the hydration query carries the constraint. The album has no row.
      expect(result.records.map((record) => record.nativeId)).toContain("Q83495");
    },
    60_000
  );
});
