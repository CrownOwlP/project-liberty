import { describe, expect, it } from "vitest";
import { checkUrl, classifyHost } from "./url-policy";

const remote = { allowLoopback: false } as const;
const local = { allowLoopback: true } as const;

/** Reason or "ok" -- keeps the assertions readable when a case flips. */
const outcome = (raw: string, options: { allowLoopback: boolean }): string => {
  const result = checkUrl(raw, options);
  return result.ok ? "ok" : result.reason;
};

describe("classifyHost", () => {
  it("classifies loopback literals and names", () => {
    expect(classifyHost("127.0.0.1")).toBe("loopback");
    expect(classifyHost("127.13.9.2")).toBe("loopback");
    expect(classifyHost("localhost")).toBe("loopback");
    expect(classifyHost("addon.localhost")).toBe("loopback");
    expect(classifyHost("[::1]")).toBe("loopback");
  });

  it("classifies every private and reserved IPv4 range", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // Cloud instance metadata. The single most valuable SSRF target.
      "100.64.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "0.0.0.0"
    ]) {
      expect(classifyHost(host)).toBe("private");
    }
  });

  it("does not over-reach: neighbours of the private ranges are public", () => {
    // 172.16/12 stops at 172.31, and 11/8 and 192.169/16 are ordinary internet.
    expect(classifyHost("172.32.0.1")).toBe("public");
    expect(classifyHost("172.15.0.1")).toBe("public");
    expect(classifyHost("11.0.0.1")).toBe("public");
    expect(classifyHost("192.169.1.1")).toBe("public");
    expect(classifyHost("example.com")).toBe("public");
  });

  it("sees through IPv6 spellings of the same address", () => {
    expect(classifyHost("[0:0:0:0:0:0:0:1]")).toBe("loopback");
    expect(classifyHost("[::ffff:127.0.0.1]")).toBe("loopback");
    expect(classifyHost("[::ffff:7f00:1]")).toBe("loopback");
    expect(classifyHost("[::ffff:10.0.0.1]")).toBe("private");
    expect(classifyHost("[::ffff:a00:1]")).toBe("private");
    expect(classifyHost("[fd00::1]")).toBe("private"); // Unique local.
    expect(classifyHost("[fe80::1]")).toBe("private"); // Link local.
    expect(classifyHost("[::]")).toBe("private");
    expect(classifyHost("[2606:4700::1111]")).toBe("public");
  });

  it("treats local-network name suffixes as private", () => {
    expect(classifyHost("nas.local")).toBe("private");
    expect(classifyHost("metadata.google.internal")).toBe("private");
    expect(classifyHost("router.home.arpa")).toBe("private");
  });

  it("refuses to interpret a malformed host rather than guessing", () => {
    expect(classifyHost("")).toBe("unparseable");
    expect(classifyHost("[fe80::1")).toBe("unparseable");
    expect(classifyHost("[fe80::1%eth0]")).toBe("unparseable");
    expect(classifyHost("[::zz]")).toBe("unparseable");
  });
});

describe("checkUrl scheme policy", () => {
  it("accepts https to a public host", () => {
    expect(outcome("https://addon.example.com/manifest.json", remote)).toBe("ok");
  });

  it("rejects plaintext http to a public host", () => {
    expect(outcome("http://addon.example.com/manifest.json", remote)).toBe(
      "url_plaintext_http_not_loopback"
    );
  });

  it("rejects every non-http scheme, including the ones this adapter must never resolve", () => {
    for (const raw of [
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
      "file:///etc/passwd",
      "data:application/json,{}",
      "ftp://example.com/a.mkv",
      "ws://example.com/socket",
      "javascript:alert(1)"
    ]) {
      expect(outcome(raw, local)).toBe("url_scheme_not_http");
    }
  });

  it("rejects embedded credentials, which disguise the real host", () => {
    expect(outcome("https://addon.example.com@evil.test/manifest.json", remote)).toBe(
      "url_credentials_present"
    );
  });

  it("rejects anything that is not an absolute URL", () => {
    expect(outcome("manifest.json", remote)).toBe("url_unparseable");
    expect(outcome("", remote)).toBe("url_unparseable");
  });
});

describe("checkUrl SSRF policy", () => {
  it("rejects private and link-local addresses", () => {
    expect(outcome("https://10.0.0.5/manifest.json", remote)).toBe("url_private_address");
    expect(outcome("http://169.254.169.254/latest/meta-data/", remote)).toBe("url_private_address");
    expect(outcome("https://192.168.1.1/manifest.json", remote)).toBe("url_private_address");
  });

  it("rejects private addresses even for a source allowed to reach loopback", () => {
    // Declaring a source local is a statement about THIS machine, never about
    // the operator's LAN or their VPC.
    expect(outcome("http://10.0.0.5/manifest.json", local)).toBe("url_private_address");
    expect(outcome("http://192.168.1.10:8096/manifest.json", local)).toBe("url_private_address");
    expect(outcome("http://[fd00::1]/manifest.json", local)).toBe("url_private_address");
  });

  it("rejects loopback unless the source declared itself local", () => {
    expect(outcome("http://127.0.0.1:8096/manifest.json", remote)).toBe("url_loopback_not_permitted");
    expect(outcome("http://localhost:8096/manifest.json", remote)).toBe("url_loopback_not_permitted");
    expect(outcome("https://[::1]/manifest.json", remote)).toBe("url_loopback_not_permitted");
  });

  it("permits a declared local addon over plaintext http, which is the point of the exemption", () => {
    expect(outcome("http://127.0.0.1:8096/manifest.json", local)).toBe("ok");
    expect(outcome("http://localhost:11470/manifest.json", local)).toBe("ok");
    expect(outcome("https://127.0.0.1:8096/manifest.json", local)).toBe("ok");
  });

  it("is not fooled by alternative spellings of a loopback address", () => {
    // `new URL()` normalises decimal, octal and hex hosts to a dotted quad; if a
    // host somehow survives that unnormalised, classifyHost refuses it as
    // unparseable. Either way the request must not be made.
    for (const raw of ["http://2130706433/", "http://0177.0.0.1/", "http://0x7f.0.0.1/"]) {
      const result = checkUrl(raw, remote);
      expect(result.ok).toBe(false);
    }
  });
});

describe("checkUrl redirect targets", () => {
  it("resolves a relative location against the URL that issued it", () => {
    const result = checkUrl("/stream/movie/tt1.json", remote, "https://addon.example.com/manifest.json");
    expect(result.ok).toBe(true);
    expect(result.ok && result.url.toString()).toBe("https://addon.example.com/stream/movie/tt1.json");
  });

  it("applies the same policy to a redirect target as to the original", () => {
    const result = checkUrl("http://169.254.169.254/", remote, "https://addon.example.com/manifest.json");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("url_private_address");
  });
});
