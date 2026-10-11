import { describe, expect, it } from "vitest";
import {
  CLIENT_FAILURE_LOG_PREFIX,
  MAX_DIGEST_LENGTH,
  MAX_ERROR_NAME_LENGTH,
  MAX_PATHNAME_LENGTH,
  describeClientFailure,
  formatClientFailureLine,
  readClientFailure,
  sanitisePathname
} from "./client-failure";

describe("sanitisePathname", () => {
  it("drops the query, because /search?q= carries what the viewer typed", () => {
    expect(sanitisePathname("/search?q=secret+thing")).toBe("/search");
    expect(sanitisePathname("/browse?kind=series&genre=Drama")).toBe("/browse");
  });

  it("drops the fragment too", () => {
    expect(sanitisePathname("/title/abc#cast")).toBe("/title/abc");
    expect(sanitisePathname("/?a=b#c")).toBe("/");
  });

  it("always yields a rooted path", () => {
    expect(sanitisePathname("browse")).toBe("/browse");
    expect(sanitisePathname("")).toBe("/");
  });

  it("bounds the length", () => {
    const long = `/${"a".repeat(MAX_PATHNAME_LENGTH * 2)}`;
    expect(sanitisePathname(long)).toHaveLength(MAX_PATHNAME_LENGTH);
  });
});

describe("describeClientFailure", () => {
  it("keeps a digest that looks like one and the error's name", () => {
    const error = Object.assign(new Error("connection string in here"), { digest: "9f2a1c" });
    const report = describeClientFailure("global-error", error, "/watch/x?t=12");
    expect(report).toEqual({
      boundary: "global-error",
      pathname: "/watch/x",
      digest: "9f2a1c",
      errorName: "Error",
      hadMessage: true
    });
  });

  it("NEVER carries the message or the stack", () => {
    /* The property this module exists to hold: a message from a server
     * component can carry a path, a query or a secret. */
    const error = Object.assign(new Error("postgres://user:pw@host/db"), { digest: "ab" });
    const report = describeClientFailure("route-error", error, "/");
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("postgres");
    expect(serialised).not.toContain("pw@host");
    expect(Object.keys(report).sort()).toEqual([
      "boundary",
      "digest",
      "errorName",
      "hadMessage",
      "pathname"
    ]);
  });

  it("refuses a digest that is not a digest rather than laundering it", () => {
    for (const digest of ["../../etc/passwd", "9F2A1C", "9f2a-1c", "", "x".repeat(MAX_DIGEST_LENGTH + 1)]) {
      const error = Object.assign(new Error("x"), { digest });
      expect(describeClientFailure("global-error", error, "/").digest).toBeNull();
    }
  });

  it("refuses an error name that is not an identifier", () => {
    for (const name of ["Not A Name", "1Error", "x".repeat(MAX_ERROR_NAME_LENGTH + 1), ""]) {
      const error = Object.assign(new Error("x"), { name });
      expect(describeClientFailure("global-error", error, "/").errorName).toBeNull();
    }
  });

  it("survives anything being thrown, which in JavaScript is anything", () => {
    for (const thrown of [null, undefined, "a string", 42, Symbol("s"), []]) {
      const report = describeClientFailure("global-error", thrown, "/");
      expect(report.boundary).toBe("global-error");
      expect(report.hadMessage).toBe(false);
    }
  });

  it("survives a throwing getter, because the last-resort boundary must not throw", () => {
    const hostile = {
      get digest(): string {
        throw new Error("no");
      }
    };
    expect(() => describeClientFailure("global-error", hostile, "/")).not.toThrow();
    expect(describeClientFailure("global-error", hostile, "/").digest).toBeNull();
  });

  it("says an error carried no message without inventing one", () => {
    const report = describeClientFailure("route-error", new Error(""), "/");
    expect(report.hadMessage).toBe(false);
  });
});

describe("readClientFailure", () => {
  it("accepts what describeClientFailure produces, unchanged", () => {
    const made = describeClientFailure("global-error", Object.assign(new Error("m"), { digest: "ff" }), "/x");
    expect(readClientFailure(JSON.parse(JSON.stringify(made)))).toEqual(made);
  });

  it("refuses a body that is not a report", () => {
    for (const body of [null, undefined, 1, "x", [], {}, { boundary: "elsewhere", pathname: "/" }]) {
      expect(readClientFailure(body)).toBeNull();
    }
  });

  it("re-sanitises rather than trusting the page that shares its origin", () => {
    /* The server does not believe a body because it arrived from our own
     * document: the value reaches a log line an operator pastes. */
    const read = readClientFailure({
      boundary: "route-error",
      pathname: "/search?q=typed+by+the+viewer",
      digest: "NOT A DIGEST",
      errorName: "also not",
      hadMessage: "yes"
    });
    expect(read).toEqual({
      boundary: "route-error",
      pathname: "/search",
      digest: null,
      errorName: null,
      hadMessage: false
    });
  });

  it("ignores fields it does not declare", () => {
    const read = readClientFailure({
      boundary: "global-error",
      pathname: "/",
      stack: "Error: at /home/someone/secret.ts:1",
      message: "a message the client tried to smuggle"
    });
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(JSON.stringify(read)).not.toContain("smuggle");
  });
});

describe("formatClientFailureLine", () => {
  it("is one greppable line", () => {
    const line = formatClientFailureLine(
      describeClientFailure("global-error", Object.assign(new Error("m"), { digest: "0a" }), "/")
    );
    expect(line.startsWith(CLIENT_FAILURE_LOG_PREFIX)).toBe(true);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line.slice(CLIENT_FAILURE_LOG_PREFIX.length)).digest).toBe("0a");
  });
});
