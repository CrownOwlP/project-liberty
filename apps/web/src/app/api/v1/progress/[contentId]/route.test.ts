import { describe, expect, it } from "vitest";
import { progressResponseSchema } from "../contract";
import { GET, PUT } from "./route";

/*
 * THE ONLY TEST THAT EXECUTES THIS ROUTE MODULE. `handler.test.ts` calls the
 * handlers directly, which is the only way to inject a repository -- and which
 * means a renamed export, a `GET` wired to the write handler, or a dropped
 * `await params` would leave that whole suite green while the deployed path was
 * broken. (A stray second export is the one failure mode not covered here: Next
 * rejects that at build time, so it surfaces as a failed build.)
 *
 * It is also the only place the DEFAULT composition root runs, so every
 * assertion is written against BOTH of its states -- the in-memory adapter under
 * an allowlisted `NODE_ENV`, and a refusal when `DATABASE_URL` names a database
 * that is not there -- rather than against whichever one this machine happens to
 * be in.
 */

const CONTENT = "aurora-fall";

function url(): string {
  return `https://liberty.test/api/v1/progress/${CONTENT}`;
}

/** The App Router hands `params` to a route as a promise. */
function params(): { params: Promise<{ contentId: string }> } {
  return { params: Promise.resolve({ contentId: CONTENT }) };
}

describe("the route module Next actually deploys", () => {
  it("answers GET with a member of the published union", async () => {
    const response = await GET(new Request(url(), { method: "GET" }), params());

    /* Not `toBeTruthy`: a dropped `await` in the route would hand back a Promise,
     * whose `status` is `undefined` and which would otherwise fail three
     * assertions later as a confusing mismatch. */
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = progressResponseSchema.parse(await response.json());
    /*
     * With no profile selected on whatever identity the default account source
     * produced, a read is refused rather than answered -- and in a process with
     * no storage it is unavailable. Both are correct; what is asserted is that
     * the wire body is a member of the union and the status agrees with it.
     */
    expect(["read", "refused", "unavailable"]).toContain(body.outcome);
    expect(body.reasons.length).toBeGreaterThan(0);
    expect([200, 400, 403, 503]).toContain(response.status);
  });

  it("answers PUT with a member of the published union", async () => {
    const response = await PUT(
      new Request(url(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lease: { epoch: 1, writerId: "route-check" },
          writeSeq: 1,
          positionSeconds: 1,
          runtimeSeconds: null
        })
      }),
      params()
    );

    expect(response).toBeInstanceOf(Response);
    const body = progressResponseSchema.parse(await response.json());
    expect(["written", "refused", "unavailable"]).toContain(body.outcome);
    expect(body.reasons.length).toBeGreaterThan(0);
  });
});
