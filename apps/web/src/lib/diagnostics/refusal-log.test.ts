import { beforeEach, describe, expect, it } from "vitest";
import {
  REFUSAL_BUDGET,
  REFUSAL_LOG_PREFIX,
  REFUSAL_WINDOW_MS,
  describeRefusal,
  formatRefusalLine,
  refusalLogLines,
  resetRefusalBudget
} from "./refusal-log";

const T0 = 500_000;
const facts = (over: Partial<Parameters<typeof describeRefusal>[0]> = {}) =>
  describeRefusal({
    method: "GET",
    pathname: "/",
    tokenHeaderPresent: false,
    hostHeaderPresent: true,
    ...over
  });

beforeEach(() => resetRefusalBudget());

describe("describeRefusal", () => {
  it("records the facts that separate the cases, and no header value", () => {
    expect(facts({ pathname: "/_next/static/chunks/main.js" })).toEqual({
      method: "GET",
      pathname: "/_next/static/chunks/main.js",
      tokenHeaderPresent: false,
      hostHeaderPresent: true
    });
  });

  it("drops the query from the path", () => {
    expect(facts({ pathname: "/search?q=what+the+viewer+typed" }).pathname).toBe("/search");
  });

  it("normalises an unusual method rather than echoing it", () => {
    expect(facts({ method: "get" }).method).toBe("GET");
    expect(facts({ method: "WEIRD-METHOD-\n" }).method).toBe("OTHER");
    expect(facts({ method: "" }).method).toBe("OTHER");
  });

  it("distinguishes a webview that never attaches the token from one that does", () => {
    /* This is the pair that made PL-0753 diagnosable only from a screenshot. */
    expect(facts({ tokenHeaderPresent: false }).tokenHeaderPresent).toBe(false);
    expect(facts({ tokenHeaderPresent: true }).tokenHeaderPresent).toBe(true);
  });
});

describe("the refusal log", () => {
  it("is one greppable line per refusal", () => {
    const [line] = refusalLogLines(facts(), T0);
    expect(line?.startsWith(REFUSAL_LOG_PREFIX)).toBe(true);
    expect(line?.includes("\n")).toBe(false);
  });

  it("budgets, because one refused page load is dozens of refusals", () => {
    const lines: string[] = [];
    for (let i = 0; i < REFUSAL_BUDGET + 20; i += 1) lines.push(...refusalLogLines(facts(), T0 + i));
    expect(lines).toHaveLength(REFUSAL_BUDGET);
  });

  it("says how many it dropped when the window turns over", () => {
    for (let i = 0; i < REFUSAL_BUDGET + 4; i += 1) refusalLogLines(facts(), T0 + i);
    const next = refusalLogLines(facts(), T0 + REFUSAL_WINDOW_MS + 1);
    expect(next).toHaveLength(2);
    expect(next[1]).toContain('"suppressedInPreviousWindow":4');
  });

  it("formats from the described facts and nothing else", () => {
    const line = formatRefusalLine(facts({ pathname: "/api/v1/profiles?id=1" }));
    expect(JSON.parse(line.slice(REFUSAL_LOG_PREFIX.length))).toEqual({
      method: "GET",
      pathname: "/api/v1/profiles",
      tokenHeaderPresent: false,
      hostHeaderPresent: true
    });
  });
});
