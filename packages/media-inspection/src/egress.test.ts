import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROTOCOLS,
  authoriseFetchTarget,
  checkUrlStatically,
  hostOnAllowlist,
  type EgressPolicy
} from "./egress";
import { permissiveEgress, testClassifyHost, testResolver } from "./testing/fixtures";

/**
 * PL-0304 acceptance: "the service never becomes a general-purpose fetcher, so
 * protocols are allowlisted, egress is confined to an allowlist, hostnames are
 * resolved and private ranges rejected before inspection is invoked, and
 * redirects are revalidated rather than trusted because the first host was
 * allowed."
 *
 * The first three clauses are pinned here. The fourth is in `inspect.test.ts`,
 * because a redirect is only observable through a whole fetch.
 */

const loopbackOptIn: EgressPolicy = { ...permissiveEgress, allowLoopback: true };
const localDeployment: EgressPolicy = { ...loopbackOptIn, localDeployment: true };

describe("protocols are allowlisted", () => {
  it.each([
    ["ftp://cdn.example.test/master.m3u8"],
    ["file:///etc/passwd"],
    ["data:application/xml,<MPD/>"],
    ["concat:a|b"],
    ["magnet:?xt=urn:btih:0000"],
    ["ws://cdn.example.test/socket"]
  ])("refuses %s", (raw) => {
    const verdict = checkUrlStatically(raw, permissiveEgress, testClassifyHost);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // `file:` and `data:` are the FFmpeg arbitrary-file-read and inline-document
    // primitives. They are refused here even though the manifest path never
    // invokes a binary, so that adding the probe path cannot widen the allowlist
    // by omission.
    expect(verdict.reason).toBe("url_scheme_not_allowed");
  });

  /*
   * A pool wider than `ALLOWED_PROTOCOLS`, so the test below has something to
   * say in both directions. Every scheme is spelled with an authority so that
   * one URL shape covers all of them: `new URL` keeps the authority for a
   * non-special scheme, so the gate sees the same host in every case and the
   * SCHEME is the only variable.
   */
  const PROBED_SCHEMES: readonly string[] = [
    "https:",
    "http:",
    "ftp:",
    "file:",
    "data:",
    "concat:",
    "magnet:",
    "ws:",
    "javascript:"
  ];

  it("refuses exactly the schemes ALLOWED_PROTOCOLS omits, so the constant IS the gate", () => {
    /*
     * The `it.each` above pins named schemes, which is what it is for -- but it
     * would pass unchanged if somebody added `"ftp:"` to `ALLOWED_PROTOCOLS`,
     * because it never reads the constant. That makes it unable to detect the
     * defect its own describe block names: a documented control that the code
     * does not consult. This one derives its expectation FROM the constant, so
     * it fails in both directions -- a scheme admitted by the code but missing
     * from the list, and a scheme on the list that the code still refuses.
     */
    for (const scheme of PROBED_SCHEMES) {
      const verdict = checkUrlStatically(
        `${scheme}//cdn.example.test/master.m3u8`,
        permissiveEgress,
        testClassifyHost
      );
      const refusedByScheme = !verdict.ok && verdict.reason === "url_scheme_not_allowed";
      // Compared as a labelled pair so a failure names the offending scheme
      // instead of reporting `false !== true`.
      expect({ scheme, refusedByScheme }).toEqual({
        scheme,
        refusedByScheme: !ALLOWED_PROTOCOLS.includes(scheme)
      });
    }
  });

  it("lists every scheme with the trailing colon `URL.protocol` carries", () => {
    // An entry spelled `"https"` matches nothing, so it would withdraw a scheme
    // silently rather than fail. Cheap to pin, invisible in review.
    for (const scheme of ALLOWED_PROTOCOLS) expect(scheme).toMatch(/^[a-z][a-z0-9+.-]*:$/);
  });

  it("accepts https on an allowlisted host", () => {
    const verdict = checkUrlStatically(
      "https://cdn.example.test/master.m3u8",
      permissiveEgress,
      testClassifyHost
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses plaintext http to a remote host", () => {
    const verdict = checkUrlStatically("http://cdn.example.test/x", permissiveEgress, testClassifyHost);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("url_plaintext_http_not_loopback");
  });

  it("refuses embedded credentials, whatever the host looks like", () => {
    const verdict = checkUrlStatically(
      "https://cdn.example.test@other.example.test/x",
      permissiveEgress,
      testClassifyHost
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("url_credentials_present");
  });
});

describe("egress is confined to an allowlist", () => {
  it("refuses a host that is not named, however ordinary it looks", () => {
    const verdict = checkUrlStatically("https://evil.test/master.m3u8", permissiveEgress, testClassifyHost);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("url_host_not_on_egress_allowlist");
  });

  it("fetches nothing at all when the allowlist is empty", () => {
    const closed: EgressPolicy = { ...permissiveEgress, allowedHosts: [] };
    const verdict = checkUrlStatically("https://cdn.example.test/x", closed, testClassifyHost);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("url_host_not_on_egress_allowlist");
  });

  it("matches a subdomain only through an explicit leading dot", () => {
    expect(hostOnAllowlist("edge.cdn.example.test", [".cdn.example.test"])).toBe(true);
    expect(hostOnAllowlist("cdn.example.test", [".cdn.example.test"])).toBe(false);
    // The bypass the leading dot exists to close: a bare suffix match would
    // accept an attacker-registered `evilcdn.example.test`.
    expect(hostOnAllowlist("evilcdn.example.test", [".cdn.example.test"])).toBe(false);
    expect(hostOnAllowlist("evil-cdn.example.test", ["cdn.example.test"])).toBe(false);
  });

  it("ignores blank entries rather than treating them as a wildcard", () => {
    expect(hostOnAllowlist("anything.test", ["", "  ", "."])).toBe(false);
  });
});

describe("private and loopback hosts are refused as literals", () => {
  it.each([
    ["https://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["https://10.0.0.5:9200/_search"],
    ["https://192.168.1.1/"],
    ["https://metrics.internal/"]
  ])("refuses %s before the allowlist is even consulted", (raw) => {
    const verdict = checkUrlStatically(raw, permissiveEgress, testClassifyHost);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("url_host_private_literal");
  });

  it("needs two independent permissions for loopback, never either alone", () => {
    const target = "http://localhost:8096/library/master.m3u8";

    const neither = checkUrlStatically(target, permissiveEgress, testClassifyHost);
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.reason).toBe("url_loopback_not_permitted");

    const sourceOnly = checkUrlStatically(target, loopbackOptIn, testClassifyHost);
    expect(sourceOnly.ok).toBe(false);
    // The important one: a source config saying "I am local" must not be able to
    // aim a hosted Liberty instance at its own admin surface.
    if (!sourceOnly.ok) expect(sourceOnly.reason).toBe("url_loopback_not_local_deployment");

    expect(checkUrlStatically(target, localDeployment, testClassifyHost).ok).toBe(true);
  });
});

describe("hostnames are resolved and private ranges rejected before the fetch", () => {
  const deps = (answers: Readonly<Record<string, readonly string[]>>) => ({
    classifyHost: testClassifyHost,
    resolveHost: testResolver(answers)
  });

  it("accepts a public name that resolves publicly", async () => {
    const verdict = await authoriseFetchTarget(
      "https://cdn.example.test/master.m3u8",
      permissiveEgress,
      deps({ "cdn.example.test": ["93.184.216.34"] })
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses a public name whose A record points into the private network", async () => {
    // The residual risk url-policy documents and explicitly does not close --
    // recorded as R1 under "Residual risks, open" in docs/SECURITY.md, and NOT
    // as PL-0701, which an earlier version of this comment cited and which is
    // the critical end-to-end harness. This package must close it, because a
    // manifest host is chosen by a publisher rather than fixed by an operator,
    // so checking the NAME proves nothing about the address.
    const verdict = await authoriseFetchTarget(
      "https://cdn.example.test/master.m3u8",
      permissiveEgress,
      deps({ "cdn.example.test": ["10.0.0.5"] })
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("dns_resolved_private_address");
  });

  it("checks every address, not just the first", async () => {
    // A round-robin with one public and one internal answer would pass roughly
    // half the time under an `addresses[0]` check, which looks like flakiness
    // rather than a hole and is therefore the worst possible failure mode.
    const verdict = await authoriseFetchTarget(
      "https://cdn.example.test/master.m3u8",
      permissiveEgress,
      deps({ "cdn.example.test": ["93.184.216.34", "10.0.0.5"] })
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("dns_resolved_private_address");
  });

  it("refuses an IPv6 answer in a private range", async () => {
    // Pins the bracketing in `classifyResolvedAddress`: a resolver returns bare
    // `fd00::1`, and a classifier written for URL hostnames dispatches on the
    // leading `[`. Unbracketed, this address classifies as public.
    const verdict = await authoriseFetchTarget(
      "https://cdn.example.test/master.m3u8",
      permissiveEgress,
      deps({ "cdn.example.test": ["fd00::1"] })
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("dns_resolved_private_address");
  });

  it("refuses a name that resolves to nothing", async () => {
    const verdict = await authoriseFetchTarget(
      "https://cdn.example.test/master.m3u8",
      permissiveEgress,
      deps({ "cdn.example.test": [] })
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("dns_resolved_no_addresses");
  });

  it("refuses when resolution fails, and does not repeat the resolver's message", async () => {
    const verdict = await authoriseFetchTarget("https://cdn.example.test/master.m3u8", permissiveEgress, {
      classifyHost: testClassifyHost,
      resolveHost: async () => {
        throw new Error("queryA ENOTFOUND cdn.example.test via 10.0.0.53");
      }
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("dns_resolution_failed");
      expect(verdict.detail).not.toContain("10.0.0.53");
    }
  });

  it("does not resolve an IP literal", async () => {
    let called = false;
    const verdict = await authoriseFetchTarget(
      "http://127.0.0.1:8096/library/master.m3u8",
      localDeployment,
      {
        classifyHost: testClassifyHost,
        resolveHost: async () => {
          called = true;
          return [];
        }
      }
    );
    expect(verdict.ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe("refusal details never carry a URL's query string", () => {
  it("names a host at most", () => {
    const verdict = checkUrlStatically(
      "https://evil.test/master.m3u8?token=SUPERSECRET&exp=1",
      permissiveEgress,
      testClassifyHost
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.detail).not.toContain("SUPERSECRET");
      expect(verdict.detail).not.toContain("master.m3u8");
    }
  });

  it("names only the scheme and a length when the URL did not parse", () => {
    // Protocol-relative, so `new URL` refuses it outright with no base -- which
    // is the branch that has no parsed URL to reduce and therefore the one most
    // likely to echo its input.
    const verdict = checkUrlStatically(
      "//cdn.example.test/master.m3u8?token=SUPERSECRET",
      permissiveEgress,
      testClassifyHost
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("url_unparseable");
      expect(verdict.detail).not.toContain("SUPERSECRET");
      expect(verdict.detail).toContain("(no scheme)");
    }
  });
});
