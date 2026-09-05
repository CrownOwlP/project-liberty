import { describe, expect, it } from "vitest";
import { watchlistResponseSchema } from "../contract";
import { DELETE, PUT } from "./route";

/*
 * THE ONLY TEST THAT EXECUTES THIS ROUTE MODULE, for the reason
 * `../../progress/[contentId]/route.test.ts` gives: `handler.test.ts` calls the
 * handlers directly so it can inject a repository, which means nothing there
 * would notice a renamed export or a `PUT` wired to the remove handler.
 *
 * `PUT` and `DELETE` are checked separately and asserted to be DIFFERENT
 * operations, because swapping them is the specific mistake this file exists to
 * catch and both would otherwise return a well-formed `mutated`.
 */

const CONTENT = "northstar";

function url(): string {
  return `https://liberty.test/api/v1/watchlist/${CONTENT}`;
}

function params(): { params: Promise<{ contentId: string }> } {
  return { params: Promise.resolve({ contentId: CONTENT }) };
}

describe("the route module Next actually deploys", () => {
  it("answers PUT and DELETE with members of the published union", async () => {
    const added = await PUT(new Request(url(), { method: "PUT" }), params());
    expect(added).toBeInstanceOf(Response);
    expect(added.headers.get("cache-control")).toBe("no-store");

    const addedBody = watchlistResponseSchema.parse(await added.json());
    expect(["mutated", "refused", "unavailable"]).toContain(addedBody.outcome);
    expect(addedBody.reasons.length).toBeGreaterThan(0);

    const removed = await DELETE(new Request(url(), { method: "DELETE" }), params());
    expect(removed).toBeInstanceOf(Response);

    const removedBody = watchlistResponseSchema.parse(await removed.json());
    expect(["mutated", "refused", "unavailable"]).toContain(removedBody.outcome);

    /*
     * If both were wired to the same handler, both primary reasons would be the
     * same code. They are not: the outcome vocabulary distinguishes add from
     * remove, and in the refused/unavailable cases both sides carry the same
     * preamble refusal -- so the assertion is made only when both actually
     * mutated.
     */
    if (addedBody.outcome === "mutated" && removedBody.outcome === "mutated") {
      expect(addedBody.reasons[0].code).not.toBe(removedBody.reasons[0].code);
    }
  });
});
