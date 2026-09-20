import { describe, expect, it } from "vitest";
import {
  PRIVATE_HOST_SUFFIXES,
  classifyHost,
  classifyResolvedAddress,
  type HostClass
} from "./classify";
import { HOSTILE_ADDRESS_SPELLINGS, HOSTILE_HOST_SPELLINGS } from "./testing/host-spellings";

/**
 * THE SHARED CLASSIFIER'S OWN SUITE.
 *
 * This replaces the two-implementation agreement test PL-0709 wrote in
 * `@liberty/media-inspection`. That test existed because there were two answers
 * to "what is this host" and no way to observe both from one place without a
 * deep cross-package import; it is meaningless now that there is one answer, and
 * keeping it would have been a test asserting that a function agrees with
 * itself.
 *
 * What replaces it is this suite plus the package-boundary tests in both
 * consumers. Those matter as much as these do: an extraction that nothing
 * imports is a third copy rather than a merge, and no amount of testing THIS
 * file would notice.
 *
 * NON-VACUITY IS THE STANDING RISK IN THIS FILE. Nearly every assertion here is
 * "must not be public", and a classifier that answered `"private"` for
 * everything would satisfy all of them. Every group therefore carries a positive
 * control -- a real public address or name that must come back `"public"` -- and
 * the F8 cases are asserted in both directions: a translation prefix wrapping
 * 10.0.0.1 is private AND the same prefix wrapping 8.8.8.8 is public, because
 * F8's fix is strictly correct rather than merely stricter.
 */

describe("the classifier answers something other than one class", () => {
  it("has a positive control, because a refusal suite needs one", () => {
    expect(classifyHost("cdn.example.test")).toBe("public");
    expect(classifyHost("93.184.216.34")).toBe("public");
    expect(classifyHost("[2606:4700:4700::1111]")).toBe("public");
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("10.0.0.1")).toBe("private");
    expect(classifyHost("")).toBe("unparseable");
  });

  it("reaches all four classes over the shared address table", () => {
    const answered = new Set(HOSTILE_ADDRESS_SPELLINGS.map((entry) => classifyHost(entry.spelling)));
    expect([...answered].sort()).toEqual(["loopback", "private", "public", "unparseable"]);
  });
});

describe("F7 -- the DNS root label is folded before anything is compared", () => {
  it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical !== null))(
    "classifies $spelling exactly as $canonical",
    ({ spelling, canonical }) => {
      const canonicalClass: HostClass = classifyHost(canonical as string);
      expect(classifyHost(spelling)).toBe(canonicalClass);
      // Without this line the assertion above would be satisfied by both sides
      // answering "unparseable", which is how an agreement test goes green on a
      // broken classifier.
      expect(canonicalClass).not.toBe("unparseable");
    }
  );

  it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical === null))(
    "refuses $spelling rather than repairing it",
    ({ spelling }) => {
      expect(classifyHost(spelling)).toBe("unparseable");
    }
  );

  it("names the specific hosts F7 let through as public", () => {
    // The four spellings in the finding, restated as the values they must not
    // return rather than as a comparison with another function.
    expect(classifyHost("metadata.google.internal.")).toBe("private");
    expect(classifyHost("foo.local.")).toBe("private");
    expect(classifyHost("vault.corp.")).toBe("private");
    expect(classifyHost("localhost.")).toBe("loopback");
  });
});

describe("F1 -- an unbracketed IPv6 literal is refused, not read as a name", () => {
  it("refuses the bare spellings a resolver produces", () => {
    expect(classifyHost("::1")).toBe("unparseable");
    expect(classifyHost("fe80::1")).toBe("unparseable");
    expect(classifyHost("fd00::1")).toBe("unparseable");
    expect(classifyHost("64:ff9b::a00:1")).toBe("unparseable");
  });

  it("accepts the same addresses in the bracketed spelling a URL parser produces", () => {
    // The control that keeps the refusal above from being "refuses IPv6".
    expect(classifyHost("[::1]")).toBe("loopback");
    expect(classifyHost("[fe80::1]")).toBe("private");
    expect(classifyHost("[fd00::1]")).toBe("private");
    expect(classifyHost("[2606:4700:4700::1111]")).toBe("public");
  });

  it("refuses a half-bracketed literal rather than guessing which end is missing", () => {
    expect(classifyHost("[::1")).toBe("unparseable");
    expect(classifyHost("::1]")).toBe("unparseable");
  });
});

describe("F8 -- a translation prefix is classified by the address it carries", () => {
  it.each(HOSTILE_ADDRESS_SPELLINGS)("classifies $spelling as $expected", ({ spelling, expected }) => {
    expect(classifyHost(spelling)).toBe(expected);
  });

  it("is strictly correct rather than merely stricter", () => {
    // Each pair is the SAME prefix over a private and over a public address. A
    // fix that simply refused the three prefixes would pass the private half of
    // this suite and fail here.
    expect(classifyHost("[64:ff9b::a00:1]")).toBe("private");
    expect(classifyHost("[64:ff9b::808:808]")).toBe("public");
    expect(classifyHost("[2002:a00:1::]")).toBe("private");
    expect(classifyHost("[2002:808:808::]")).toBe("public");
    expect(classifyHost("[::ffff:0:a00:1]")).toBe("private");
    expect(classifyHost("[::ffff:0:808:808]")).toBe("public");
  });

  it("still catches the IPv4-mapped spelling the zero-prefix branch owns", () => {
    expect(classifyHost("[::ffff:a00:1]")).toBe("private");
    expect(classifyHost("[::ffff:7f00:1]")).toBe("loopback");
    expect(classifyHost("[::ffff:808:808]")).toBe("public");
  });

  it("keeps ::0 and ::1 as the unspecified and loopback addresses", () => {
    // Not 0.0.0.0 and 0.0.0.1, which is what the IPv4-compatible branch would
    // otherwise make of them.
    expect(classifyHost("[::]")).toBe("private");
    expect(classifyHost("[::1]")).toBe("loopback");
  });
});

describe("the IPv4 ranges a socket must not be opened to", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["0.0.0.0", "private"],
    ["10.255.255.254", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "private"],
    ["100.64.0.1", "private"],
    ["192.0.2.1", "private"],
    ["198.18.0.1", "private"],
    ["198.51.100.1", "private"],
    ["203.0.113.1", "private"],
    ["224.0.0.1", "private"],
    ["255.255.255.255", "private"]
  ] as const)("classifies %s as %s", (address, expected) => {
    expect(classifyHost(address)).toBe(expected);
  });

  it("does not sweep the neighbours of those ranges in with them", () => {
    // The control for the table above: an off-by-one in any mask shows up here
    // rather than as a quietly over-strict gate nobody notices.
    expect(classifyHost("172.15.0.1")).toBe("public");
    expect(classifyHost("172.32.0.1")).toBe("public");
    expect(classifyHost("100.63.255.255")).toBe("public");
    expect(classifyHost("100.128.0.1")).toBe("public");
    expect(classifyHost("192.167.1.1")).toBe("public");
    expect(classifyHost("11.0.0.1")).toBe("public");
    expect(classifyHost("223.255.255.255")).toBe("public");
  });
});

describe("a numeric-looking host the URL parser did not normalise is refused", () => {
  it("never treats an unparsed number as a name to resolve", () => {
    expect(classifyHost("0")).toBe("unparseable");
    expect(classifyHost("2130706433")).toBe("unparseable");
    expect(classifyHost("1.2.3")).toBe("unparseable");
    expect(classifyHost("cdn.example.42")).toBe("unparseable");
    expect(classifyHost("999.999.999.999")).toBe("unparseable");
  });

  it("still admits a name whose last label merely starts with a digit", () => {
    expect(classifyHost("cdn1.example.test")).toBe("public");
    expect(classifyHost("cdn.example.4k")).toBe("public");
  });
});

describe("the private name suffixes", () => {
  it("classifies every published suffix as private", () => {
    // Driven from the exported constant rather than a restatement of it, so the
    // documented list and the enforced list are the same object.
    expect(PRIVATE_HOST_SUFFIXES.length).toBeGreaterThan(0);
    for (const suffix of PRIVATE_HOST_SUFFIXES) {
      expect(classifyHost(`vault${suffix}`)).toBe("private");
      expect(classifyHost(`vault${suffix}.`)).toBe("private");
    }
  });

  it("treats localhost and everything under it as loopback, per RFC 6761", () => {
    expect(classifyHost("localhost")).toBe("loopback");
    expect(classifyHost("tenant-a.localhost")).toBe("loopback");
    // And does not let the name merely CONTAINING it through as loopback.
    expect(classifyHost("localhost.evil.test")).toBe("public");
    expect(classifyHost("notlocalhost")).toBe("public");
  });

  it("does not let a name that merely contains a suffix become private", () => {
    expect(classifyHost("mylocal")).toBe("public");
    expect(classifyHost("internal.example.test")).toBe("public");
  });
});

describe("classifyResolvedAddress is the named step a resolver answer takes", () => {
  it("brackets a bare IPv6 answer so it is classified rather than refused", () => {
    // This is the difference between a control and a decoration: every one of
    // these comes back "unparseable" from `classifyHost` alone, and
    // "unparseable" is not "public", so a caller that forgot to bracket would
    // refuse rather than connect -- but a caller that forgot the other way round
    // is exactly F1.
    expect(classifyResolvedAddress("::1")).toBe("loopback");
    expect(classifyResolvedAddress("fe80::1")).toBe("private");
    expect(classifyResolvedAddress("fd00::1")).toBe("private");
    expect(classifyResolvedAddress("64:ff9b::a00:1")).toBe("private");
    expect(classifyResolvedAddress("2606:4700:4700::1111")).toBe("public");
  });

  it("leaves IPv4 answers and already-bracketed answers alone", () => {
    expect(classifyResolvedAddress("10.0.0.1")).toBe("private");
    expect(classifyResolvedAddress("93.184.216.34")).toBe("public");
    expect(classifyResolvedAddress("[::1]")).toBe("loopback");
  });

  it("still refuses a zone id instead of guessing what interface it named", () => {
    expect(classifyResolvedAddress("fe80::1%eth0")).toBe("unparseable");
  });
});
