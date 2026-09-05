import { describe, expect, it } from "vitest";
import { catalogHomeResponseSchema } from "@liberty/contracts/domains/catalog";
import type { CatalogLoadResult } from "../../../../../lib/catalog";
import { catalogHomeStatusFor, handleCatalogHomeResult } from "./handler";

/*
 * The result-to-response mapping, exercised on every branch.
 *
 * `route.test.ts` executes the module Next deploys, but only in the environment
 * the suite happens to run in — which is `test`, where the fixture source is
 * configured, so the refusal a deployment produces is unreachable from there
 * without writing `NODE_ENV` and changing how every other suite in the same
 * worker behaves. Injecting the already-decided `CatalogLoadResult` reaches it
 * without either.
 */

const ISO = "2026-08-17T00:00:00.000Z";

const RESPONSE = {
  rails: [
    {
      id: "movies",
      title: "Films",
      items: [
        {
          id: "aurora-fall",
          title: "Aurora Fall",
          kind: "movie",
          rights: "owned",
          genre: "Sci-fi",
          releaseYear: 2024,
          runtimeMinutes: 128,
          episodeCount: null
        }
      ]
    }
  ],
  generatedAt: ISO
};

/*
 * Parsed rather than asserted as a literal: the `ok` branch is contracted to
 * return exactly what the loader validated, so the fixture this test hands it
 * has to be a payload the contract actually accepts. A hand-written object that
 * drifted from `catalogHomeResponseSchema` would make the assertions below agree
 * with each other and with nothing else.
 */
const OK_RESPONSE = catalogHomeResponseSchema.parse(RESPONSE);
const OK_RESULT: CatalogLoadResult = { status: "ok", response: OK_RESPONSE };

describe("handleCatalogHomeResult", () => {
  it("serves the validated rails at 200", async () => {
    const response = handleCatalogHomeResult(OK_RESULT);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK_RESPONSE);
  });

  /*
   * `rails: []` at 200 is a documented, contract-valid answer meaning "genuinely
   * nothing to show". It is reachable only from a CONFIGURED source, which is
   * what makes it honest; the refusal below is what a deployment gets.
   */
  it("serves a configured-but-empty catalog as contract-valid empty rails at 200", async () => {
    const response = handleCatalogHomeResult({ status: "empty", generatedAt: ISO });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ rails: [], generatedAt: ISO });
    expect(catalogHomeResponseSchema.safeParse(body).success).toBe(true);
  });

  /*
   * THE ONE THAT MATTERS. A process with no metadata source refuses and names
   * the reason, rather than serving empty rails at 200 — which would state, in
   * the shape the contract reserves for a real answer, that this deployment's
   * catalog is empty.
   */
  it("refuses with a stated reason when no metadata source is configured", async () => {
    const response = handleCatalogHomeResult({
      status: "error",
      reason: "catalog_source_not_configured"
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "catalog_source_not_configured" });
  });

  it("distinguishes a refusal from an empty catalog on the wire", async () => {
    const refused = handleCatalogHomeResult({
      status: "error",
      reason: "catalog_source_not_configured"
    });
    const empty = handleCatalogHomeResult({ status: "empty", generatedAt: ISO });

    expect(refused.status).not.toBe(empty.status);
    expect(await refused.json()).not.toEqual(await empty.json());
  });

  it("answers a source that could not be reached as unavailable, not as empty", async () => {
    const response = handleCatalogHomeResult({
      status: "error",
      reason: "catalog_source_unavailable"
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "catalog_source_unavailable" });
  });

  it("answers a payload this server could not publish as a server fault", async () => {
    const response = handleCatalogHomeResult({
      status: "error",
      reason: "catalog_response_failed_validation"
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "catalog_response_failed_validation" });
  });

  /*
   * `CatalogLoadResult.reason` is a `string`, so the loader can grow a reason
   * this module has not been taught. It must not become a 200: an unrecognised
   * failure is still a failure, and 500 says the inconsistency is on this side.
   */
  it("fails closed on a reason it does not recognise", async () => {
    const response = handleCatalogHomeResult({ status: "error", reason: "reason_from_the_future" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "reason_from_the_future" });
    expect(catalogHomeStatusFor("reason_from_the_future")).toBe(500);
  });

  it("serves every branch no-store, including the refusals", () => {
    const results: readonly CatalogLoadResult[] = [
      OK_RESULT,
      { status: "empty", generatedAt: ISO },
      { status: "error", reason: "catalog_source_not_configured" },
      { status: "error", reason: "catalog_source_unavailable" },
      { status: "error", reason: "catalog_response_failed_validation" }
    ];

    for (const result of results) {
      const label = result.status === "error" ? `error/${result.reason}` : result.status;
      expect(handleCatalogHomeResult(result).headers.get("cache-control"), label).toBe("no-store");
    }
  });
});
