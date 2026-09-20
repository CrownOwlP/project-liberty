import { describe, expect, it } from "vitest";
import {
  LICENSED_CATALOG_SOURCE_IDS,
  WIKIDATA_CC0_HOSTS,
  noRightsBasisEstablished,
  type CatalogProviderRuntime,
  type HostClass
} from "@liberty/catalog-ingestion";
import {
  CatalogMetadataSourceUnavailableError,
  type CatalogIngestionRuntime
} from "../../lib/catalog-ingestion-source";
import {
  registerCatalogIngestionRuntime,
  registeredCatalogIngestionRuntime
} from "../../lib/catalog-source-registry";
import { NonDeploymentEnvironment } from "../api/deployment-environment";
import {
  CatalogMetadataSourceNotConfiguredError,
  findDemoTitleDetail
} from "./demo-title-details";
import { loadTitleDetail } from "./title-detail";

/* -------------------------------------------------------------------------
 * The title surface's deployment refusal
 *
 * WHY THIS FILE EXISTS. When `demo-title-details.ts` stopped importing the raw
 * `demoCatalog` array and started reading the catalog metadata port, it acquired
 * a behaviour it had never had: on a process with no metadata source it THROWS
 * instead of answering. Reading the ungated array could not fail that way, so
 * nothing in the suite named the new refusal. These are the assertions for it.
 *
 * THE DISTINCTION UNDER TEST IS BETWEEN TWO ABSENCES. `null` means "no title has
 * this id" and is answered by correcting the link; the throw means "this process
 * has no catalog" and is answered by an operator configuring one. Every test
 * below exists to keep those two from collapsing into each other, which is the
 * failure the port's `findRecord` contract and `TitleDetailSource` both name.
 *
 * NO COMPONENT IS MOUNTED AND NO DOM IS TOUCHED. `apps/web/vitest.config.ts`
 * sets `environment: "node"`, so everything here is a pure function call.
 * ---------------------------------------------------------------------- */

/**
 * This process's own classification, minted once at import.
 *
 * `findDemoTitleDetail` TAKES THE CAPABILITY OR `null`, NOT A RUNTIME NAME.
 * There used to be a list of deployment names here, passed as the second
 * argument and forwarded through the registry to the mint -- which is the hole
 * PL-0706 closed, because a hosted process could name `test` and be issued a
 * genuine capability for it. The granting case is now the classification this
 * process really holds (vitest runs as `test`, which the one allowlist admits,
 * so the classification is true rather than asserted), and the refusing case is
 * `null`, which is exactly what `classify()` answers in a deployment.
 *
 * `null` IS ALSO WHY `undefined` IS NEVER PASSED HERE. `undefined` re-enters the
 * default parameter and classifies this process, which is on the allowlist -- so
 * a test that passed it expecting a refusal would be asserting the opposite of
 * what it appeared to.
 *
 * Name-by-name coverage of the allowlist has not been dropped, only moved: it is
 * asserted against `isNonDeploymentEnvironmentName` in
 * `lib/catalog-source-registry.test.ts`, which answers about a string and issues
 * nothing.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

const TEST_RUNTIME: NonDeploymentEnvironment = classifiedProcess();

/** A fixed clock, so nothing here depends on when the suite runs. */
const ISO = "2026-08-14T00:00:00.000Z";

describe("findDemoTitleDetail on a deployment", () => {
  it("rejects rather than answering when there is no classification", async () => {
    await expect(findDemoTitleDetail("aurora-fall", null)).rejects.toBeInstanceOf(
      CatalogMetadataSourceNotConfiguredError
    );
  });

  /*
   * THE ONE THAT MATTERS. A deployment refuses an id it would have known and an
   * id nothing has ever known in exactly the same way, because neither was
   * looked up. Answering `null` for the second would report "no such title" from
   * a process that never consulted a catalog.
   */
  it("refuses an unknown id the same way, rather than reporting not-found", async () => {
    await expect(findDemoTitleDetail("no-such-title", null)).rejects.toBeInstanceOf(
      CatalogMetadataSourceNotConfiguredError
    );
  });

  it("carries the reason code the home rails and the search surface already publish", async () => {
    let thrown: unknown = null;

    try {
      await findDemoTitleDetail("aurora-fall", null);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CatalogMetadataSourceNotConfiguredError);
    if (!(thrown instanceof CatalogMetadataSourceNotConfiguredError)) return;

    expect(thrown.reason).toBe("catalog_source_not_configured");
    expect(thrown.name).toBe("CatalogMetadataSourceNotConfiguredError");
  });
});

describe("findDemoTitleDetail outside a deployment", () => {
  /*
   * The granting branch, reached the only way anything can reach it: with a
   * classification this process was actually issued. There is no loop over
   * environment names because there is no parameter to put one in.
   */
  it("answers a detail when handed a classification", async () => {
    const detail = await findDemoTitleDetail("aurora-fall", TEST_RUNTIME);

    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("aurora-fall");
    expect(detail?.kind).toBe("movie");
  });

  /*
   * Both of the port's questions. A series comes back through `findRecord`; an
   * episode is not a catalog record at all and is only reachable by scanning
   * `listRecords` and regenerating the series' episode list.
   */
  it("resolves a series directly and an episode through its series", async () => {
    const series = await findDemoTitleDetail("northstar", TEST_RUNTIME);
    expect(series?.kind).toBe("series");
    expect(series?.id).toBe("northstar");

    const episode = await findDemoTitleDetail("northstar-s1e1", TEST_RUNTIME);
    expect(episode?.kind).toBe("episode");
    expect(episode?.id).toBe("northstar-s1e1");
  });

  it("answers null for an id nothing knows about", async () => {
    expect(await findDemoTitleDetail("no-such-title", TEST_RUNTIME)).toBeNull();
    expect(await findDemoTitleDetail("", TEST_RUNTIME)).toBeNull();
  });

  /*
   * Both directions from one id. Either assertion alone would pass against an
   * implementation that had stopped consulting the environment entirely -- one
   * against a source that always refuses, the other against one that never does.
   */
  it("keeps not-found and refused apart, which is why one of them rejects", async () => {
    expect(await findDemoTitleDetail("no-such-title", TEST_RUNTIME)).toBeNull();
    await expect(findDemoTitleDetail("no-such-title", null)).rejects.toBeInstanceOf(
      CatalogMetadataSourceNotConfiguredError
    );
  });
});

/*
 * The refusal as a reader actually receives it.
 *
 * The source is injected rather than left to default, because the default
 * classifies this process and under vitest that succeeds. Injecting the same
 * shape `getTitleDetail` builds -- `findDemoTitleDetail` wrapped in a
 * `generatedAt` -- exercises the real throw through the real loader while still
 * letting the test choose the branch it means, by handing the fixture module
 * `null` instead of the capability.
 */
describe("the refusal as loadTitleDetail publishes it", () => {
  it("reports catalog_source_not_configured rather than the generic source failure", async () => {
    const result = await loadTitleDetail("aurora-fall", async (id) => {
      const detail = await findDemoTitleDetail(id, null);
      return detail === null ? null : { detail, generatedAt: ISO };
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("catalog_source_not_configured");
  });

  it("still reports an ordinary source failure as title_source_unavailable", async () => {
    const result = await loadTitleDetail("aurora-fall", () => {
      throw new Error("provider unreachable");
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("title_source_unavailable");
  });

  it("loads normally through the same injected shape outside a deployment", async () => {
    const result = await loadTitleDetail("aurora-fall", async (id) => {
      const detail = await findDemoTitleDetail(id, TEST_RUNTIME);
      return detail === null ? null : { detail, generatedAt: ISO };
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.response.detail.id).toBe("aurora-fall");
    expect(result.response.generatedAt).toBe(ISO);
  });

  /*
   * A refused deployment and a genuinely absent title are still different
   * results at the loader boundary, not only inside the fixture module.
   */
  it("keeps not-found apart from the refusal at the loader boundary", async () => {
    const missing = await loadTitleDetail("no-such-title", async (id) => {
      const detail = await findDemoTitleDetail(id, TEST_RUNTIME);
      return detail === null ? null : { detail, generatedAt: ISO };
    });

    expect(missing.status).toBe("not-found");
  });
});

/* -------------------------------------------------------------------------
 * The title surface, once a real source exists
 *
 * ITEM 9 OF THE ROUND-51 CORRECTIVE, FINISHED. `findDemoTitleDetail` and
 * `getTitleDetail` are asynchronous, this surface reads
 * `resolveCatalogMetadataSource` like the home rails and the search index, and
 * `resolveSynchronousCatalogMetadataSource` is deleted because this was its only
 * production caller.
 *
 * AN EARLIER VERSION OF THIS BLOCK ASSERTED THE OPPOSITE, and it is worth saying
 * so rather than quietly replacing it. For one round the surface refused a
 * configured deployment with `catalog_source_requires_async_caller`, which was an
 * honest description of an unfinished migration. The migration is finished, the
 * state cannot occur, and the reason code is gone -- so the tests that pinned it
 * are gone too, replaced by the tests below, which assert that the surface now
 * REACHES the source it used to refuse.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The transport is scripted: it answers one
 * 200 with a body that is not JSON, so the request goes through the real egress
 * boundary and the real parse boundary and comes back as the package's own
 * `provider_response_malformed`. That is the point -- a source failure has to
 * arrive as a source failure.
 * ---------------------------------------------------------------------- */

const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.")) return "loopback";
  return "public";
};

/**
 * A real, licensed runtime whose transport answers one unparseable document.
 *
 * `noRightsBasisEstablished` is passed by name, as the package requires, so even
 * a well-formed response would publish nothing. Nothing in this suite depends on
 * that: what is under test is which ERROR a reader gets, and the rights position
 * is asserted in `lib/catalog-ingestion-source.test.ts`.
 */
const licensedRuntime = (
  over: Partial<CatalogProviderRuntime> = {}
): CatalogIngestionRuntime => ({
  provider: {
    sourceId: LICENSED_CATALOG_SOURCE_IDS[0] ?? "",
    selection: { classQid: "Q11424", kind: "movie", locales: ["en"] },
    document: {
      egress: {
        allowedHosts: [...WIKIDATA_CC0_HOSTS],
        allowLoopback: false,
        localDeployment: false
      },
      timeoutMs: 10_000,
      maxResponseBytes: 4_000_000,
      maxRedirects: 3,
      userAgent: "LibertyCatalog/0.1 (https://liberty.example.test; ops@example.test)"
    },
    transport: {
      fetchImpl: () =>
        Promise.resolve(
          new Response("this is not JSON", {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        ),
      classifyHost,
      resolveHost: () => Promise.resolve(["198.51.100.10"]),
      now: () => NOW_MS
    },
    rightsRegister: noRightsBasisEstablished,
    ...over
  },
  read: {
    locales: ["en"],
    territory: "GB",
    unstatedAvailability: "refuse",
    pageSize: 10,
    maxPages: 2
  },
  now: () => NOW_MS
});

/** Registers a runtime for one test and always takes it away again. */
async function withRuntime(
  runtime: CatalogIngestionRuntime,
  body: () => Promise<void>
): Promise<void> {
  const previous = registeredCatalogIngestionRuntime();
  registerCatalogIngestionRuntime(runtime);
  try {
    await body();
  } finally {
    registerCatalogIngestionRuntime(previous);
  }
}

describe("findDemoTitleDetail on a deployment with a real source configured", () => {
  /*
   * THE MIGRATION, ASSERTED AS THE THING IT CHANGED. A deployment with a real
   * source no longer gets a configuration refusal from this surface: it gets
   * whatever the source says. Here the source cannot parse what it was handed,
   * so the failure is the ingestion adapter's named one -- which means the
   * request really went out through the provider, the transport and the parse
   * boundary, rather than being turned away by the registry.
   */
  it("reaches the configured source instead of refusing to be served by it", async () => {
    await withRuntime(licensedRuntime(), async () => {
      await expect(findDemoTitleDetail("aurora-fall", null)).rejects.toBeInstanceOf(
        CatalogMetadataSourceUnavailableError
      );

      const thrown = await findDemoTitleDetail("aurora-fall", null).catch(
        (error: unknown) => error
      );
      expect(thrown).not.toBeInstanceOf(CatalogMetadataSourceNotConfiguredError);
      expect(thrown).toBeInstanceOf(CatalogMetadataSourceUnavailableError);
      if (!(thrown instanceof CatalogMetadataSourceUnavailableError)) return;
      expect(thrown.reason).toBe("provider_response_malformed");
    });
  });

  /*
   * AND THE READER IS TOLD SOMETHING TRUE. A source that exists and did not
   * answer is `title_source_unavailable` -- "try again in a moment" -- which is
   * `loadTitleDetail`'s existing, correct branch for a source that throws
   * anything other than the configuration class. It is NOT
   * `catalog_source_not_configured`, which would send an operator to configure
   * a source they configured, and there is no longer any such thing as
   * `catalog_source_requires_async_caller`.
   */
  it("publishes a source failure as a source failure, through the real loader", async () => {
    await withRuntime(licensedRuntime(), async () => {
      const result = await loadTitleDetail("aurora-fall");

      expect(result).toEqual({ status: "error", reason: "title_source_unavailable" });
    });
  });

  /*
   * THE SURVIVING SECOND REASON, WHICH IS ABOUT CONFIGURATION AND NOT ABOUT THE
   * CALLER. A runtime naming a source no licensing decision covers is refused by
   * the package, and the title page says so in its own vocabulary rather than
   * reporting a missing configuration.
   */
  it("publishes a refused runtime as a refused configuration", async () => {
    await withRuntime(licensedRuntime({ sourceId: "tmdb" }), async () => {
      expect(await loadTitleDetail("aurora-fall")).toEqual({
        status: "error",
        reason: "catalog_source_configuration_refused"
      });
    });
  });

  /*
   * AND WITH NOTHING REGISTERED IT IS UNCHANGED. The string every other surface
   * and the e2e suite assert is still what an unconfigured deployment gets;
   * nothing about finishing the migration moved it.
   */
  it("still publishes catalog_source_not_configured when nothing is registered", async () => {
    expect(registeredCatalogIngestionRuntime()).toBeNull();

    const deploymentSource = async (id: string) => {
      const detail = await findDemoTitleDetail(id, null);
      return detail === null ? null : { detail, generatedAt: ISO };
    };

    expect(await loadTitleDetail("aurora-fall", deploymentSource)).toEqual({
      status: "error",
      reason: "catalog_source_not_configured"
    });
  });
});
