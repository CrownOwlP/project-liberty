import { describe, expect, it } from "vitest";
import { bareAddress, bracketedLiteral, canonicalHost, withoutRootLabel } from "./host";
import { HOSTILE_HOST_SPELLINGS } from "./testing/host-spellings";

/**
 * THE ONE CANONICALISER, tested where it now lives.
 *
 * Until PL-0710 this behaviour was asserted in three places against three
 * implementations: `url-policy.test.ts` in `@liberty/provider-sdk` (F7),
 * `egress.root-label.test.ts` in `@liberty/media-inspection` (F12), and not at
 * all for `pin.ts`'s `normaliseHost`, which did not fold the root label and was
 * safe only because both sides of its comparison came from the same `URL`
 * object.
 *
 * Almost every assertion below is a REFUSAL, which is the thing this suite has
 * to be careful about: a refusal assertion passes against a function that
 * refuses everything. Each group therefore carries its own positive control --
 * the same input shape that must NOT be refused -- so that "refuses the empty
 * label" cannot be satisfied by "refuses all input".
 */

describe("withoutRootLabel folds exactly one trailing dot", () => {
  it("leaves a dotless name completely alone", () => {
    expect(withoutRootLabel("cdn.example.test")).toBe("cdn.example.test");
    expect(withoutRootLabel("localhost")).toBe("localhost");
    expect(withoutRootLabel("127.0.0.1")).toBe("127.0.0.1");
    expect(withoutRootLabel("[::1]")).toBe("[::1]");
  });

  it("removes the root label from a fully qualified name", () => {
    expect(withoutRootLabel("cdn.example.test.")).toBe("cdn.example.test");
    expect(withoutRootLabel("metadata.google.internal.")).toBe("metadata.google.internal");
    expect(withoutRootLabel("localhost.")).toBe("localhost");
  });

  it("refuses an empty label rather than folding until something matches", () => {
    // The whole fail-closed half. Folding `cdn.example.test..` down to
    // `cdn.example.test` would admit a string the operator never wrote.
    expect(withoutRootLabel(".")).toBeNull();
    expect(withoutRootLabel("..")).toBeNull();
    expect(withoutRootLabel("cdn.example.test..")).toBeNull();
    expect(withoutRootLabel("localhost..")).toBeNull();
  });

  it("is idempotent on its own output, which is what makes one fold enough", () => {
    for (const { spelling } of HOSTILE_HOST_SPELLINGS) {
      const once = withoutRootLabel(spelling);
      if (once === null) continue;
      expect(withoutRootLabel(once)).toBe(once);
    }
  });
});

describe("canonicalHost is the spelling two hosts are compared in", () => {
  it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical !== null))(
    "reduces $spelling to $canonical",
    ({ spelling, canonical }) => {
      expect(canonicalHost(spelling)).toBe(canonical);
    }
  );

  it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical === null))(
    "answers null for $spelling, which names no host",
    ({ spelling }) => {
      expect(canonicalHost(spelling)).toBeNull();
    }
  );

  it("folds the empty string into null, so a caller cannot compare two non-hosts", () => {
    // `null === null` is true in JavaScript. Every caller has to guard, and the
    // guard is easier to get right when there is one falsy answer rather than
    // two.
    expect(canonicalHost("")).toBeNull();
    expect(canonicalHost(".")).toBeNull();
  });

  it("case folds and root-label folds in one pass rather than in turns", () => {
    expect(canonicalHost("CDN.Example.Test.")).toBe("cdn.example.test");
    expect(canonicalHost("LOCALHOST.")).toBe("localhost");
  });

  it("does NOT trim, because a hostname a URL parser produced never needs it", () => {
    // The positive control for the asymmetry documented on the module: trimming
    // here would admit a string no parser produces. `hostOnAllowlist` trims its
    // ENTRIES, which an operator types, and not its hostname.
    expect(canonicalHost(" cdn.example.test ")).toBe(" cdn.example.test ");
    expect(canonicalHost("cdn.example.test")).toBe("cdn.example.test");
  });
});

describe("bareAddress and bracketedLiteral are inverses on the shapes that matter", () => {
  it("strips the brackets a URL parser adds", () => {
    expect(bareAddress("[::1]")).toBe("::1");
    expect(bareAddress("[fe80::1]")).toBe("fe80::1");
  });

  it("leaves an unbracketed address and a name untouched", () => {
    expect(bareAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(bareAddress("cdn.example.test")).toBe("cdn.example.test");
    expect(bareAddress("::1")).toBe("::1");
  });

  it("brackets a bare IPv6 answer and nothing else", () => {
    expect(bracketedLiteral("::1")).toBe("[::1]");
    expect(bracketedLiteral("fe80::1")).toBe("[fe80::1]");
    // Already bracketed, so applying it twice cannot produce `[[::1]]`.
    expect(bracketedLiteral("[::1]")).toBe("[::1]");
    expect(bracketedLiteral(bracketedLiteral("::1"))).toBe("[::1]");
    // No colon: an IPv4 answer, or a name, is left exactly as it arrived.
    expect(bracketedLiteral("10.0.0.1")).toBe("10.0.0.1");
    expect(bracketedLiteral("cdn.example.test")).toBe("cdn.example.test");
  });

  it("round-trips a resolver answer back to itself", () => {
    for (const address of ["::1", "fe80::1", "64:ff9b::a00:1", "10.0.0.1", "93.184.216.34"]) {
      expect(bareAddress(bracketedLiteral(address))).toBe(address);
    }
  });
});
