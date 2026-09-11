import { describe, expect, it } from "vitest";
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
  it("throws rather than answering when there is no classification", () => {
    expect(() => findDemoTitleDetail("aurora-fall", null)).toThrow(
      CatalogMetadataSourceNotConfiguredError
    );
  });

  /*
   * THE ONE THAT MATTERS. A deployment refuses an id it would have known and an
   * id nothing has ever known in exactly the same way, because neither was
   * looked up. Answering `null` for the second would report "no such title" from
   * a process that never consulted a catalog.
   */
  it("refuses an unknown id the same way, rather than reporting not-found", () => {
    expect(() => findDemoTitleDetail("no-such-title", null)).toThrow(
      CatalogMetadataSourceNotConfiguredError
    );
  });

  it("carries the reason code the home rails and the search surface already publish", () => {
    let thrown: unknown = null;

    try {
      findDemoTitleDetail("aurora-fall", null);
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
  it("answers a detail when handed a classification", () => {
    const detail = findDemoTitleDetail("aurora-fall", TEST_RUNTIME);

    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("aurora-fall");
    expect(detail?.kind).toBe("movie");
  });

  /*
   * Both of the port's questions. A series comes back through `findRecord`; an
   * episode is not a catalog record at all and is only reachable by scanning
   * `listRecords` and regenerating the series' episode list.
   */
  it("resolves a series directly and an episode through its series", () => {
    const series = findDemoTitleDetail("northstar", TEST_RUNTIME);
    expect(series?.kind).toBe("series");
    expect(series?.id).toBe("northstar");

    const episode = findDemoTitleDetail("northstar-s1e1", TEST_RUNTIME);
    expect(episode?.kind).toBe("episode");
    expect(episode?.id).toBe("northstar-s1e1");
  });

  it("answers null for an id nothing knows about", () => {
    expect(findDemoTitleDetail("no-such-title", TEST_RUNTIME)).toBeNull();
    expect(findDemoTitleDetail("", TEST_RUNTIME)).toBeNull();
  });

  /*
   * Both directions from one id. Either assertion alone would pass against an
   * implementation that had stopped consulting the environment entirely -- one
   * against a source that always refuses, the other against one that never does.
   */
  it("keeps not-found and refused apart, which is why one of them throws", () => {
    expect(findDemoTitleDetail("no-such-title", TEST_RUNTIME)).toBeNull();
    expect(() => findDemoTitleDetail("no-such-title", null)).toThrow(
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
    const result = await loadTitleDetail("aurora-fall", (id) => {
      const detail = findDemoTitleDetail(id, null);
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
    const result = await loadTitleDetail("aurora-fall", (id) => {
      const detail = findDemoTitleDetail(id, TEST_RUNTIME);
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
    const missing = await loadTitleDetail("no-such-title", (id) => {
      const detail = findDemoTitleDetail(id, TEST_RUNTIME);
      return detail === null ? null : { detail, generatedAt: ISO };
    });

    expect(missing.status).toBe("not-found");
  });
});
