import { describe, expect, it } from "vitest";
import { catalogHomeResponseSchema } from "@liberty/contracts/domains/catalog";
import { GET } from "./route";

/*
 * THE ONLY TEST THAT EXECUTES THIS ROUTE MODULE. `handler.test.ts` calls the
 * mapping directly, which is the only way to reach the refusal branch -- and
 * which means a renamed export, a dropped `await`, or a route still calling the
 * synchronous `getHomeCatalog()` would leave that whole suite green while the
 * deployed path was wrong.
 *
 * WHAT IT DOES NOT COVER, stated rather than implied. Vitest runs with
 * `NODE_ENV=test`, which is on `NON_DEPLOYMENT_ENVIRONMENTS`, so the fixture
 * metadata source is configured and this route answers 200 here every time. The
 * deployment refusal is unreachable from this file without writing `NODE_ENV`,
 * which would change how every other suite in the same worker behaves; the
 * mapping is covered in `handler.test.ts` and the end-to-end production
 * behaviour belongs to the `e2e/` mode split.
 */

describe("the route module Next actually deploys", () => {
  it("answers a contract-valid body, no-store, where the fixtures are permitted", async () => {
    const response = await GET();

    /*
     * Not `toBeTruthy`: a dropped `await` in the route would hand back a
     * Promise, whose `status` is `undefined` and which would otherwise fail
     * several assertions later as a confusing mismatch.
     */
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = catalogHomeResponseSchema.parse(await response.json());
    expect(body.rails.length).toBeGreaterThan(0);
    for (const rail of body.rails) {
      expect(rail.items.length, rail.id).toBeGreaterThan(0);
    }
  });
});
