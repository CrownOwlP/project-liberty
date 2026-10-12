import { describe, expect, it } from "vitest";
import {
  CLIENT_FAILURE_LOG_PREFIX,
  MAX_CHUNK_NAME_LENGTH,
  MAX_DIGEST_LENGTH,
  MAX_ERROR_NAME_LENGTH,
  MAX_FAILURE_FRAMES,
  MAX_PATHNAME_LENGTH,
  MAX_SOURCE_POSITION,
  REPORTER_BUDGET,
  classifyFailureShape,
  clientFailureReportsSent,
  describeClientFailure,
  extractFailureFrames,
  formatClientFailureLine,
  formatClientFailureReference,
  readClientFailure,
  reportClientFailure,
  resetClientFailureReporter,
  sanitisePathname
} from "./client-failure";

/*
 * A REAL STACK FROM THE REAL PACKAGED ARTIFACT, not a plausible-looking one.
 *
 * Captured on 2026-10-12 by booting the relocated packaged sidecar and driving
 * its homepage in Chromium with a throw injected into a component inside the
 * application shell. The frame extractor is the thing this round is betting the
 * next Windows diagnosis on, so its fixture has to come from a browser rather
 * than from an idea of what Chromium prints.
 */
const REAL_CHROMIUM_STACK = [
  "Error: Minified React error #185; visit https://react.dev/errors/185 for the full message",
  "    at ry (http://127.0.0.1:36771/_next/static/chunks/1oml7c7env4-g.js:31:41369)",
  "    at lK (http://127.0.0.1:36771/_next/static/chunks/1oml7c7env4-g.js:31:58829)",
  "    at sO (http://127.0.0.1:36771/_next/static/chunks/1oml7c7env4-g.js:31:156280)",
  "    at iw (http://127.0.0.1:36771/_next/static/chunks/1oml7c7env4-g.js:31:101766)",
  "    at ug (http://127.0.0.1:36771/_next/static/chunks/1oml7c7env4-g.js:31:125872)",
  "    at MessagePort.O (http://127.0.0.1:36771/_next/static/chunks/1oml7c7env4-g.js:1:3356)"
].join("\n");

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
      hadMessage: true,
      shape: "unclassified",
      frames: []
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
      "frames",
      "hadMessage",
      "pathname",
      "shape"
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
      hadMessage: false,
      shape: "unclassified",
      frames: []
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

describe("classifyFailureShape", () => {
  it("separates the five defects that hadMessage:true could not", () => {
    /* THE WHOLE POINT. 131A's report said hadMessage: true, which is
     * compatible with every one of these, and they have different fixes. */
    expect(classifyFailureShape("Cannot read properties of undefined (reading 'map')")).toBe(
      "undefined_property_read"
    );
    expect(classifyFailureShape("x.foo is not a function")).toBe("not_a_function");
    expect(classifyFailureShape("Intl.Segmenter is not a constructor")).toBe("not_a_constructor");
    expect(classifyFailureShape("structuredClone is not defined")).toBe("not_defined");
    expect(classifyFailureShape("Illegal invocation")).toBe("illegal_invocation");
  });

  it("classifies the same defect identically across engine wordings", () => {
    /* Chromium, Firefox and WebKit each phrase a null property read
     * differently. An operator reading a log should not have to know which
     * engine produced the line to know which defect it names. */
    for (const message of [
      "Cannot read properties of undefined (reading 'addEventListener')",
      "Cannot read property 'addEventListener' of undefined",
      "undefined is not an object (evaluating 'q.addEventListener')",
      "null is not an object"
    ]) {
      expect(classifyFailureShape(message), message).toBe("undefined_property_read");
    }
    for (const message of ["x is not a function", "q.addListener is not a method"]) {
      expect(classifyFailureShape(message), message).toBe("not_a_function");
    }
    expect(classifyFailureShape("can't find variable: structuredClone")).toBe("not_defined");
  });

  it("answers unclassified rather than guessing, and that is a real answer", () => {
    for (const message of [
      "Minified React error #185; visit https://react.dev/errors/185",
      "",
      "something nobody has seen before"
    ]) {
      expect(classifyFailureShape(message)).toBe("unclassified");
    }
  });

  it("is total, and refuses to scan an attacker-sized message", () => {
    for (const value of [null, undefined, 42, {}, [], Symbol("s"), () => undefined]) {
      expect(classifyFailureShape(value)).toBe("unclassified");
    }
    /* A regex over an unbounded string is the denial of service this module
     * exists not to be, so the bound is here and not only at the caller. */
    const huge = `${"Cannot read properties of undefined ".repeat(200)}`;
    expect(huge.length).toBeGreaterThan(2048);
    expect(classifyFailureShape(huge)).toBe("unclassified");
  });

  it("carries no part of the message into its answer", () => {
    const shape = classifyFailureShape("Cannot read properties of undefined (reading 'postgres://u:p@h/db')");
    expect(shape).toBe("undefined_property_read");
    expect(shape).not.toContain("postgres");
  });
});

describe("extractFailureFrames", () => {
  it("reads the real Chromium stack from the packaged build", () => {
    const frames = extractFailureFrames(REAL_CHROMIUM_STACK);
    expect(frames).toEqual([
      { chunk: "1oml7c7env4-g.js", line: 31, column: 41369 },
      { chunk: "1oml7c7env4-g.js", line: 31, column: 58829 },
      { chunk: "1oml7c7env4-g.js", line: 31, column: 156280 },
      { chunk: "1oml7c7env4-g.js", line: 31, column: 101766 }
    ]);
  });

  it("stops at the bound instead of carrying a whole stack", () => {
    /* The fixture has six app frames; a report that carried all of them from a
     * remount loop is how a diagnostic becomes a log nobody can paste. */
    expect(REAL_CHROMIUM_STACK.split("_next/static").length - 1).toBe(6);
    expect(extractFailureFrames(REAL_CHROMIUM_STACK)).toHaveLength(MAX_FAILURE_FRAMES);
  });

  it("keeps the basename and DROPS the host, the port and the directory", () => {
    const [frame] = extractFailureFrames(REAL_CHROMIUM_STACK);
    const serialised = JSON.stringify(frame);
    expect(serialised).not.toContain("127.0.0.1");
    expect(serialised).not.toContain("36771");
    expect(serialised).not.toContain("http");
    expect(serialised).not.toContain("/");
    /* And not the function name either: `ry` tells a reader nothing a position
     * does not, and an unminified build would put an app identifier there. */
    expect(serialised).not.toContain("ry");
  });

  it("cannot be made to carry a build path, which is the reason a stack is withheld", () => {
    /* The header says a stack carries build paths. These are the paths it
     * means, and not one of them is under /_next/static/, so not one of them
     * is matched at all. */
    const hostile = [
      "    at x (file:///D:/a/project-liberty/project-liberty/apps/web/.next/server/chunk.js:1:2)",
      "    at y (/home/claude/liberty/apps/web/src/secret.ts:3:4)",
      "    at z (chrome-extension://abcdefghijklmnop/inject.js:5:6)",
      "    at w (webpack-internal:///./src/app/page.tsx:7:8)",
      "    at v (http://127.0.0.1:1/api/v1/catalog?token=sekrit:9:10)",
      "    at u (https://evil.example/_next/statics/other.js:11:12)"
    ].join("\n");
    expect(extractFailureFrames(hostile)).toEqual([]);
  });

  it("refuses a chunk name that is not a bare basename", () => {
    for (const asset of ["..%2f..%2fetc%2fpasswd", "no-extension", "two.dots.js", `${"a".repeat(MAX_CHUNK_NAME_LENGTH)}.js`]) {
      const stack = `    at f (http://127.0.0.1:1/_next/static/chunks/${asset}:1:2)`;
      expect(extractFailureFrames(stack), asset).toEqual([]);
    }
  });

  it("refuses a position that is not one", () => {
    const over = String(MAX_SOURCE_POSITION + 1);
    expect(extractFailureFrames(`at f (http://h/_next/static/chunks/a.js:${over}:1)`)).toEqual([]);
    expect(extractFailureFrames("at f (http://h/_next/static/chunks/a.js:1e3:1)")).toEqual([]);
    expect(extractFailureFrames("at f (http://h/_next/static/chunks/a.js:-1:1)")).toEqual([]);
  });

  it("is total, and a second call is not affected by the first", () => {
    for (const value of [null, undefined, 42, {}, [], Symbol("s")]) {
      expect(extractFailureFrames(value)).toEqual([]);
    }
    /* A module-level /g regex keeps lastIndex between calls, which would make
     * the SECOND report on a page wrong -- and the second report is the one a
     * retry loop produces. */
    const once = extractFailureFrames(REAL_CHROMIUM_STACK);
    const twice = extractFailureFrames(REAL_CHROMIUM_STACK);
    expect(twice).toEqual(once);
    const enormous = `${REAL_CHROMIUM_STACK}\n`.repeat(4000);
    expect(enormous.length).toBeGreaterThan(65536);
    expect(extractFailureFrames(enormous)).toHaveLength(MAX_FAILURE_FRAMES);
  });
});

describe("describeClientFailure, with the Wave 132 fields", () => {
  it("names the shape and the throwing frame of the real captured failure", () => {
    const error = Object.assign(
      new Error("Cannot read properties of undefined (reading 'addEventListener')"),
      { stack: REAL_CHROMIUM_STACK }
    );
    const report = describeClientFailure("global-error", error, "/");
    expect(report.errorName).toBe("Error");
    expect(report.shape).toBe("undefined_property_read");
    expect(report.frames[0]).toEqual({ chunk: "1oml7c7env4-g.js", line: 31, column: 41369 });
    /* And still nothing that could be a secret or a path. */
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("addEventListener");
    expect(serialised).not.toContain("127.0.0.1");
  });

  it("loses only the field a throwing getter guards, not the other three", () => {
    /* ONE try PER READ. With a single try around all four reads, a hostile
     * `digest` would also cost us name, message and stack -- and this function
     * is the only thing reporting the Windows failure. */
    const hostile = {
      get digest(): string { throw new Error("no"); },
      name: "TypeError",
      message: "x is not a function",
      stack: REAL_CHROMIUM_STACK
    };
    const report = describeClientFailure("global-error", hostile, "/");
    expect(report.digest).toBeNull();
    expect(report.errorName).toBe("TypeError");
    expect(report.hadMessage).toBe(true);
    expect(report.shape).toBe("not_a_function");
    expect(report.frames).toHaveLength(MAX_FAILURE_FRAMES);
  });

  it("reproduces the operator's own line, and then says more than it did", () => {
    /* The line from the installed MSI at e25798428bb874a4999f680d27dae84fd441ed6a:
     *   {"boundary":"global-error","pathname":"/","digest":null,
     *    "errorName":"TypeError","hadMessage":true}
     * Everything in it is still there; what is added is the pair that would
     * have ended the diagnosis in one round instead of four. */
    const asOperatorSaw = Object.assign(new TypeError("whatever it was"), { stack: REAL_CHROMIUM_STACK });
    const report = describeClientFailure("global-error", asOperatorSaw, "/");
    expect(report.boundary).toBe("global-error");
    expect(report.pathname).toBe("/");
    expect(report.digest).toBeNull();
    expect(report.errorName).toBe("TypeError");
    expect(report.hadMessage).toBe(true);
    expect(report.frames.length).toBeGreaterThan(0);
  });
});

describe("readClientFailure, with the Wave 132 fields", () => {
  it("rebuilds frames rather than filtering them, so nothing extra survives", () => {
    const read = readClientFailure({
      boundary: "global-error",
      pathname: "/",
      hadMessage: true,
      shape: "not_a_function",
      frames: [{ chunk: "a.js", line: 1, column: 2, note: "injected", stack: "secret" }]
    });
    expect(read?.frames).toEqual([{ chunk: "a.js", line: 1, column: 2 }]);
    expect(JSON.stringify(read)).not.toContain("injected");
    expect(JSON.stringify(read)).not.toContain("secret");
  });

  it("refuses a shape it does not name, so the field cannot write chosen text to the log", () => {
    const read = readClientFailure({
      boundary: "global-error",
      pathname: "/",
      shape: "liberty-sidecar-ready {\"port\":1}"
    });
    expect(read?.shape).toBe("unclassified");
    expect(formatClientFailureLine(read!)).not.toContain("liberty-sidecar-ready {");
  });

  it("drops a frame whose chunk is a path and bounds how many it accepts", () => {
    const read = readClientFailure({
      boundary: "global-error",
      pathname: "/",
      frames: [
        { chunk: "../../../etc/passwd", line: 1, column: 1 },
        { chunk: "ok.js", line: 1.5, column: 1 },
        { chunk: "ok.js", line: 1, column: MAX_SOURCE_POSITION + 1 },
        { chunk: "ok.js", line: 1, column: 1 },
        { chunk: "ok.js", line: 2, column: 2 },
        { chunk: "ok.js", line: 3, column: 3 },
        { chunk: "ok.js", line: 4, column: 4 },
        { chunk: "ok.js", line: 5, column: 5 }
      ]
    });
    expect(read?.frames).toEqual([{ chunk: "ok.js", line: 1, column: 1 }]);
    expect(readClientFailure({ boundary: "global-error", pathname: "/", frames: "nope" })?.frames).toEqual([]);
  });
});

describe("formatClientFailureReference", () => {
  it("is what the operator can read off the screen when the POST is refused", () => {
    /* On a deployment with no sidecar token the request guard answers this
     * route 403, and then the screen is the only channel there is. */
    const report = describeClientFailure(
      "global-error",
      Object.assign(new TypeError("q.addEventListener is not a function"), { stack: REAL_CHROMIUM_STACK }),
      "/"
    );
    expect(formatClientFailureReference(report)).toBe(
      "global-error \u00b7 TypeError \u00b7 not_a_function \u00b7 1oml7c7env4-g.js:31:41369"
    );
  });

  it("says something useful even when there is nothing to say", () => {
    const bare = describeClientFailure("route-error", null, "/x");
    expect(formatClientFailureReference(bare)).toBe("route-error");
  });

  it("carries exactly what the log line carries and no more", () => {
    const report = describeClientFailure(
      "global-error",
      Object.assign(new Error("postgres://user:pw@host/db"), { digest: "ab12", stack: REAL_CHROMIUM_STACK }),
      "/search?q=typed"
    );
    const reference = formatClientFailureReference(report);
    expect(reference).toContain("digest ab12");
    for (const forbidden of ["postgres", "pw@host", "typed", "127.0.0.1", "http"]) {
      expect(reference, forbidden).not.toContain(forbidden);
    }
  });
});

describe("reportClientFailure's own budget", () => {
  /*
   * MEASURED, NOT ANTICIPATED. Driving the packaged homepage in Chromium with a
   * throw injected into a component inside the application shell produced
   * FIFTY-TWO POSTs to this route for one defect: React retries the boundary
   * and each retry re-runs the reporting effect. The server's budget exists and
   * could not help -- by the time it runs, the request has been made.
   */
  const report = (pathname: string) => describeClientFailure("global-error", new Error("x"), pathname);

  it("sends a bounded number of reports per document, not one per retry", () => {
    resetClientFailureReporter();
    const sent: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      sent.push(String(input));
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    try {
      for (let i = 0; i < 52; i += 1) reportClientFailure(report(`/p${String(i)}`));
    } finally {
      globalThis.fetch = original;
    }
    expect(sent).toHaveLength(REPORTER_BUDGET);
    expect(clientFailureReportsSent()).toBe(REPORTER_BUDGET);
  });

  it("drops an identical report before it spends any budget at all", () => {
    resetClientFailureReporter();
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    try {
      for (let i = 0; i < 20; i += 1) reportClientFailure(report("/"));
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(1);
    expect(clientFailureReportsSent()).toBe(1);
  });

  it("still cannot throw, which is the property that outranks the budget", () => {
    resetClientFailureReporter();
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("no fetch in this webview");
    }) as typeof fetch;
    try {
      expect(() => reportClientFailure(report("/"))).not.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});
