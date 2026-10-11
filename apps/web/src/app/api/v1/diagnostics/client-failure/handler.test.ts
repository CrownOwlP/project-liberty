import { beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_FAILURE_BUDGET,
  CLIENT_FAILURE_WINDOW_MS,
  MAX_CLIENT_FAILURE_BYTES,
  handleClientFailureReport,
  resetClientFailureBudget
} from "./handler";

const T0 = 1_000_000;
const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ boundary: "global-error", pathname: "/", digest: "ab12", hadMessage: true, ...over });

beforeEach(() => resetClientFailureBudget());

describe("the client-failure route's rules", () => {
  it("logs one line and answers 204", () => {
    const outcome = handleClientFailureReport(report(), T0);
    expect(outcome.status).toBe(204);
    expect(outcome.logged).toHaveLength(1);
    expect(outcome.logged[0]).toContain('"digest":"ab12"');
  });

  it("refuses a body that is not JSON, and logs nothing", () => {
    const outcome = handleClientFailureReport("{not json", T0);
    expect(outcome.status).toBe(400);
    expect(outcome.logged).toEqual([]);
  });

  it("refuses a body that is not a report, and logs nothing", () => {
    expect(handleClientFailureReport('{"boundary":"nope","pathname":"/"}', T0)).toEqual({
      status: 400,
      logged: []
    });
  });

  it("refuses an oversized body BEFORE parsing it", () => {
    /* The bound is the point: `request.json()` on an unmeasured body parses
     * whatever arrived. */
    const huge = `{"boundary":"global-error","pathname":"/","pad":"${"x".repeat(MAX_CLIENT_FAILURE_BYTES)}"}`;
    expect(huge.length).toBeGreaterThan(MAX_CLIENT_FAILURE_BYTES);
    expect(handleClientFailureReport(huge, T0)).toEqual({ status: 413, logged: [] });
  });

  it("keeps the FIRST reports in a window and drops the rest", () => {
    /* The tenth copy of a failure says nothing the first did not, and a
     * remount loop would otherwise drown the line that matters. */
    const logged: string[] = [];
    for (let i = 0; i < CLIENT_FAILURE_BUDGET + 5; i += 1) {
      logged.push(...handleClientFailureReport(report(), T0 + i).logged);
    }
    expect(logged).toHaveLength(CLIENT_FAILURE_BUDGET);
  });

  it("still answers 204 for a report it dropped, so the wire says nothing about the budget", () => {
    for (let i = 0; i < CLIENT_FAILURE_BUDGET; i += 1) handleClientFailureReport(report(), T0 + i);
    expect(handleClientFailureReport(report(), T0 + 100).status).toBe(204);
  });

  it("says how many it dropped, once, when the next window opens", () => {
    for (let i = 0; i < CLIENT_FAILURE_BUDGET + 3; i += 1) handleClientFailureReport(report(), T0 + i);
    const next = handleClientFailureReport(report(), T0 + CLIENT_FAILURE_WINDOW_MS + 1);
    expect(next.logged).toHaveLength(2);
    expect(next.logged[1]).toContain('"suppressedInPreviousWindow":3');
    /* And not again on the following report. */
    const after = handleClientFailureReport(report(), T0 + CLIENT_FAILURE_WINDOW_MS + 2);
    expect(after.logged).toHaveLength(1);
  });

  it("never writes a message or a stack the client tried to send", () => {
    const outcome = handleClientFailureReport(
      report({ message: "postgres://u:p@h/db", stack: "at /home/x/secret.ts" }),
      T0
    );
    expect(outcome.logged.join("\n")).not.toContain("postgres");
    expect(outcome.logged.join("\n")).not.toContain("secret.ts");
  });
});
