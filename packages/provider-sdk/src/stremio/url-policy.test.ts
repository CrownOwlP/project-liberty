import { describe, expect, it } from "vitest";
import { checkUrl, classifyHost } from "./url-policy";

/** An ordinary hosted instance talking to an ordinary remote addon. */
const remote = { allowLoopback: false, localDeployment: false } as const;
/** Both loopback conditions satisfied: a local addon on a local deployment. */
const local = { allowLoopback: true, localDeployment: true } as const;
/** The dangerous half: a source that says it is local, in a hosted process. */
const optedInButHosted = { allowLoopback: true, localDeployment: false } as const;
/** The other half: a local deployment, and a source that never opted in. */
const localWithoutOptIn = { allowLoopback: false, localDeployment: true } as const;

/** Reason or "ok" -- keeps the assertions readable when a case flips. */
const outcome = (
  raw: string,
  options: { allowLoopback: boolean; localDeployment: boolean }
): string => {
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

  it("refuses an UNBRACKETED IPv6 literal instead of calling it public", () => {
    /*
     * The precondition, asserted as behaviour. Every caller inside this package
     * passes a `URL.hostname`, which `new URL()` always brackets -- so this was
     * not reachable from here. The caller that CAN reach it is a
     * resolve-then-classify egress gate, which classifies bare resolver
     * answers, and one of those now exists in `@liberty/media-inspection`.
     *
     * Before this check the three addresses below matched no IPv4 branch, no
     * numeric branch, no loopback name and no private suffix, and fell out of
     * `classifyHost` as "public" -- the single answer that opens a socket. A
     * link-local metadata address and a unique-local internal service would
     * both have been connected to.
     *
     * The expected value is "unparseable" and NOT "private": auto-bracketing
     * would widen what this function accepts on behalf of a consumer that does
     * its own bracketing, turning that consumer's step into dead code nobody
     * notices has stopped mattering. Enforcing the precondition fails at the
     * call site that broke it.
     */
    expect(classifyHost("fd00::1")).toBe("unparseable");
    expect(classifyHost("fe80::1")).toBe("unparseable");
    expect(classifyHost("::1")).toBe("unparseable");
    // And the bracketed spellings of the same three still classify, so the
    // guard refuses a violated precondition rather than refusing IPv6.
    expect(classifyHost("[fd00::1]")).toBe("private");
    expect(classifyHost("[fe80::1]")).toBe("private");
    expect(classifyHost("[::1]")).toBe("loopback");
  });

  /* ---------------------------------------------------------------------
   * PL-0702 F7. The DNS root label.
   *
   * `new URL()` keeps a trailing dot on a DOMAIN and strips it from an IP
   * literal, so every numeric case above was already canonical and none of them
   * could have caught this. Each name below is the same name as its
   * dotless spelling to every resolver, and each one classified "public" before
   * the root label was stripped ahead of the comparisons.
   * ------------------------------------------------------------------- */
  it("classifies a fully qualified name the same as its dotless spelling", () => {
    expect(classifyHost("metadata.google.internal.")).toBe("private");
    expect(classifyHost("nas.local.")).toBe("private");
    expect(classifyHost("vault.corp.")).toBe("private");
    expect(classifyHost("host.lan.")).toBe("private");
    expect(classifyHost("router.home.arpa.")).toBe("private");
    expect(classifyHost("localhost.")).toBe("loopback");
    expect(classifyHost("addon.localhost.")).toBe("loopback");
    // Still narrowing only: an ordinary public name is unaffected either way.
    expect(classifyHost("example.com.")).toBe("public");
  });

  it("refuses an empty label rather than collapsing it into a name", () => {
    // The root on its own names no host, and a zero-length label is not a name
    // any resolver accepts. Repairing either would invent a name for a caller.
    expect(classifyHost(".")).toBe("unparseable");
    expect(classifyHost("nas.local..")).toBe("unparseable");
  });

  /* ---------------------------------------------------------------------
   * PL-0702 F8. IPv6 prefixes that CARRY an IPv4 address without the zero
   * prefix that `::ffff:a00:1` has. Each of these was "public" while naming
   * 10.0.0.1, because it matched neither the mapped/compatible branch nor any
   * of the fc00/fe80/ff00 masks.
   * ------------------------------------------------------------------- */
  it("sees the IPv4 address inside a translation prefix", () => {
    expect(classifyHost("[64:ff9b::a00:1]")).toBe("private"); // NAT64 well-known, 10.0.0.1.
    expect(classifyHost("[64:ff9b::a9fe:a9fe]")).toBe("private"); // NAT64, 169.254.169.254.
    expect(classifyHost("[64:ff9b::7f00:1]")).toBe("loopback"); // NAT64, 127.0.0.1.
    expect(classifyHost("[2002:a00:1::]")).toBe("private"); // 6to4, 10.0.0.1.
    expect(classifyHost("[2002:a9fe:a9fe::1]")).toBe("private"); // 6to4, 169.254.169.254.
    expect(classifyHost("[::ffff:0:a00:1]")).toBe("private"); // IPv4-translated, 10.0.0.1.
  });

  it("does not over-reach: a translation prefix wrapping a public address stays public", () => {
    // The point is that the embedded address is CLASSIFIED, not that the prefix
    // is banned. 8.8.8.8 is public however it is spelled.
    expect(classifyHost("[64:ff9b::808:808]")).toBe("public");
    expect(classifyHost("[2002:808:808::]")).toBe("public");
    // And an ordinary global-unicast address that merely starts with 0x2001 is
    // not 6to4 and is not reinterpreted as one.
    expect(classifyHost("[2001:db8::1]")).toBe("public");
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

  it("describes an unparseable URL instead of reproducing it", () => {
    /*
     * The one branch with no parsed URL to reduce, and therefore the one that
     * used to echo its input -- up to 120 characters of it. `detail` is copied
     * verbatim into a candidate's reason trail by `mapping.ts`, and this case is
     * reachable with content the addon chose: a protocol-relative stream URL
     * throws in `new URL()`, so the token below went straight through.
     */
    const signed = "//cdn.example.com/f.mp4?token=super-secret-token";
    const result = checkUrl(signed, remote);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("url_unparseable");
    expect(!result.ok && result.detail).not.toContain("super-secret-token");
    expect(!result.ok && result.detail).not.toContain("cdn.example.com");
    // What survives cannot carry a secret and still tells the two failures
    // apart: an operator's relative path has no scheme, and the length
    // distinguishes an empty config field from a mangled URL.
    expect(!result.ok && result.detail).toContain("(no scheme)");
    expect(!result.ok && result.detail).toContain(`${signed.length} characters`);
  });

  it("names the scheme when the string has one", () => {
    // `http://` is a valid scheme with an invalid (empty) host, so the parser
    // throws before `url_host_missing` can be reached -- which is why this
    // branch has to say something useful on its own.
    const result = checkUrl("http://", remote);
    expect(!result.ok && result.reason).toBe("url_unparseable");
    expect(!result.ok && result.detail).toContain("scheme http:");
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

  it("does not let a source opt itself into reaching this machine in a hosted deployment", () => {
    // The failure this prevents: on a hosted instance, 127.0.0.1 is the Liberty
    // server. `allowLoopback` is written by whoever can edit a source config, so
    // if it were sufficient, adding a source would be enough to aim the server's
    // own fetches at its admin ports.
    for (const raw of [
      "http://127.0.0.1:8096/manifest.json",
      "http://localhost:11470/manifest.json",
      "https://[::1]/manifest.json",
      "http://[::ffff:127.0.0.1]/manifest.json"
    ]) {
      expect(outcome(raw, optedInButHosted)).toBe("url_loopback_not_local_deployment");
    }
  });

  it("does not let a local deployment reach loopback for a source that never opted in", () => {
    // The mirror image, and the reason the two conditions are separate: running
    // the dev stack must not silently widen every configured public addon.
    expect(outcome("http://127.0.0.1:8096/manifest.json", localWithoutOptIn)).toBe(
      "url_loopback_not_permitted"
    );
    expect(outcome("http://localhost:11470/manifest.json", localWithoutOptIn)).toBe(
      "url_loopback_not_permitted"
    );
  });

  it("permits a declared local addon over plaintext http, which is the point of the exemption", () => {
    // Only with BOTH conditions: a local source AND a local deployment.
    expect(outcome("http://127.0.0.1:8096/manifest.json", local)).toBe("ok");
    expect(outcome("http://localhost:11470/manifest.json", local)).toBe("ok");
    expect(outcome("https://127.0.0.1:8096/manifest.json", local)).toBe("ok");
  });

  it("caps the host it names, because a hostname has no length limit", () => {
    /*
     * `detail` reaches a candidate's reason trail verbatim through `mapping.ts`,
     * and on a stream URL the host is the addon's choice. The WHATWG parser
     * enforces no bound on a hostname -- 253 bytes is a resolver rule, not a
     * parsing one -- so the whole thing used to be reproduced in every log line
     * and every response carrying that trail. A host cannot hold a signed query
     * string, so this is flooding rather than leakage, and 64 characters
     * identify a host to a human.
     */
    const flood = `${"a".repeat(4096)}.local`;
    const result = checkUrl(`https://${flood}/manifest.json`, remote);

    expect(!result.ok && result.reason).toBe("url_private_address");
    expect(!result.ok && result.detail.length).toBeLessThan(200);
    expect(!result.ok && result.detail).toContain("...");
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

  /* ---------------------------------------------------------------------
   * PL-0702 F7, at the GATE rather than at the classifier, and on the two paths
   * a third party actually controls: a stream URL an addon returns, and a
   * `Location:` header it sends. A classifier unit test would have gone green
   * on the fix without proving that `checkUrl` refuses; these assert the
   * refusal, and the reason each one is refused FOR.
   * ------------------------------------------------------------------- */
  it("refuses a fully qualified private name as an outbound target", () => {
    expect(outcome("https://metadata.google.internal./computeMetadata/v1/", remote)).toBe(
      "url_private_address"
    );
    expect(outcome("https://vault.corp./v1/secret", remote)).toBe("url_private_address");
    expect(outcome("https://nas.local./media.mp4", remote)).toBe("url_private_address");
  });

  it("makes a fully qualified loopback name ASK for both permissions", () => {
    /*
     * The sharp edge of F7. Classified "public", `localhost.` never reached the
     * loopback branch at all, so neither the source opt-in nor the deployment
     * check was consulted and a hosted instance accepted a URL aimed at itself.
     * The four options objects below are the same four the rest of this suite
     * uses, and the dotted spelling must now answer exactly as `localhost` does.
     */
    expect(outcome("https://localhost.:9200/_search", remote)).toBe("url_loopback_not_permitted");
    expect(outcome("https://localhost.:9200/_search", optedInButHosted)).toBe(
      "url_loopback_not_local_deployment"
    );
    expect(outcome("https://localhost.:9200/_search", localWithoutOptIn)).toBe(
      "url_loopback_not_permitted"
    );
    expect(outcome("https://localhost.:9200/_search", local)).toBe("ok");
    // http to a loopback name is the documented exemption, and it still is.
    expect(outcome("http://addon.localhost./manifest.json", local)).toBe("ok");
    expect(outcome("http://addon.localhost./manifest.json", remote)).toBe(
      "url_loopback_not_permitted"
    );
  });

  it("refuses a redirect into a fully qualified private name", () => {
    const result = checkUrl(
      "https://metadata.google.internal./computeMetadata/v1/",
      remote,
      "https://addon.example.com/manifest.json"
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("url_private_address");
  });

  it("refuses a redirect into an IPv4 address wearing a translation prefix", () => {
    const result = checkUrl(
      "https://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
      remote,
      "https://addon.example.com/manifest.json"
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("url_private_address");
  });
});
