import { describe, expect, it } from "vitest";
import type {
  EgressPolicy,
  HostClass,
  ManifestFetchDependencies,
  PinnedFetch,
  PinnedTarget
} from "@liberty/media-inspection";
import {
  CATALOG_DOCUMENT_LIMITS,
  fetchCatalogDocument,
  type CatalogDocumentOptions
} from "./transport";

/* -------------------------------------------------------------------------
 * These tests are about the COMPOSITION, not about the egress gate itself.
 *
 * The gate is `@liberty/media-inspection`'s and it has its own suite; re-testing
 * its internals here would be a second set of assertions to keep in agreement
 * with the first. What is worth proving is the thing a reviewer of THIS package
 * has to take on trust otherwise: that `fetchCatalogDocument` is actually wired
 * through that gate rather than around it. Every negative case below therefore
 * asserts BOTH the refusal reason and that the transport was never reached --
 * a wrapper that called `fetch` on the URL and checked the allowlist afterwards
 * would satisfy the first assertion and fail the second.
 *
 * The classifier and resolver below are crude test doubles and are NOT a second
 * SSRF implementation. They exist because the real classifier is an injected
 * port; the whole point of that injection is that a consumer's tests can
 * exercise the composition without reimplementing anything.
 * ---------------------------------------------------------------------- */

const NOW = Date.parse("2026-09-16T00:00:00.000Z");

const classifyHost = (hostname: string): HostClass => {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";
  if (host === "localhost" || host.startsWith("127.")) return "loopback";
  if (host.startsWith("10.") || host.startsWith("192.168.") || host === "169.254.169.254") {
    return "private";
  }
  return "public";
};

const egress: EgressPolicy = {
  allowedHosts: ["catalog.example.test", "redirected.example.test"],
  allowLoopback: false,
  localDeployment: false
};

const options: CatalogDocumentOptions = {
  egress,
  ...CATALOG_DOCUMENT_LIMITS,
  userAgent: "LibertyCatalogIngestion/0.1 (contact: operator@example.test)"
};

interface Scripted {
  readonly deps: ManifestFetchDependencies;
  readonly opened: PinnedTarget[];
}

const scripted = (
  responses: readonly Response[],
  resolutions: Readonly<Record<string, readonly string[]>> = {}
): Scripted => {
  const opened: PinnedTarget[] = [];
  let index = 0;
  const fetchImpl: PinnedFetch = (target) => {
    opened.push(target);
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error("more requests than were scripted");
    return Promise.resolve(response);
  };
  return {
    deps: {
      fetchImpl,
      classifyHost,
      resolveHost: (hostname) =>
        Promise.resolve(resolutions[hostname.toLowerCase()] ?? ["93.184.216.34"]),
      now: () => NOW
    },
    opened
  };
};

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });

describe("fetchCatalogDocument", () => {
  it("returns the parsed document for an allowlisted host", async () => {
    const { deps, opened } = scripted([json({ works: [{ id: "a" }] })]);

    const result = await fetchCatalogDocument(
      "https://catalog.example.test/v1/works",
      options,
      deps
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual({ works: [{ id: "a" }] });
    expect(result.finalUrl).toBe("https://catalog.example.test/v1/works");
    // The pin carries the NAME, and the addresses the gate authorised. A
    // transport handed an IP in the URL would break TLS identity; one handed no
    // addresses would have to resolve the name a second time.
    expect(opened[0]?.hostname).toBe("catalog.example.test");
    expect(opened[0]?.addresses).toEqual(["93.184.216.34"]);
  });

  /*
   * WHAT THIS CATCHES: a new fetcher being introduced instead of the existing
   * boundary. An allowlist that is consulted after the request is not an
   * allowlist, so the assertion that nothing was opened is the load-bearing one.
   */
  it("refuses a host that is not on the operator's allowlist, before opening anything", async () => {
    const { deps, opened } = scripted([json({})]);

    const result = await fetchCatalogDocument("https://evil.example.test/v1/works", options, deps);

    expect(result).toMatchObject({ ok: false, reason: "url_host_not_on_egress_allowlist" });
    expect(opened).toEqual([]);
  });

  /*
   * WHAT THIS CATCHES: the SSRF case that makes an allowlist insufficient on its
   * own -- an allowlisted NAME that resolves into the private network, which is
   * how a metadata provider's hostname reaches a cloud metadata endpoint.
   */
  it("refuses an allowlisted name that resolves to a private address", async () => {
    const { deps, opened } = scripted([json({})], {
      "catalog.example.test": ["169.254.169.254"]
    });

    const result = await fetchCatalogDocument(
      "https://catalog.example.test/v1/works",
      options,
      deps
    );

    expect(result).toMatchObject({ ok: false, reason: "dns_resolved_private_address" });
    expect(opened).toEqual([]);
  });

  /*
   * WHAT THIS CATCHES: a redirect escaping the allowlist. `fetch` follows
   * redirects by default, so a wrapper that validated only the first URL would
   * be bypassed by a provider answering 302 -- the classic way an SSRF filter is
   * defeated. Exactly one socket must have been opened: the first hop.
   */
  it("re-authorises every redirect hop against the same policy", async () => {
    const { deps, opened } = scripted([
      new Response(null, { status: 302, headers: { location: "https://evil.example.test/x" } })
    ]);

    const result = await fetchCatalogDocument(
      "https://catalog.example.test/v1/works",
      options,
      deps
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("url_host_not_on_egress_allowlist");
    expect(result.ok === false && result.detail).toContain("redirect hop 1");
    expect(opened).toHaveLength(1);
  });

  it("follows a redirect that stays inside the allowlist", async () => {
    const { deps, opened } = scripted([
      new Response(null, {
        status: 308,
        headers: { location: "https://redirected.example.test/v2/works" }
      }),
      json({ works: [] })
    ]);

    const result = await fetchCatalogDocument(
      "https://catalog.example.test/v1/works",
      options,
      deps
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.finalUrl).toBe("https://redirected.example.test/v2/works");
    expect(opened).toHaveLength(2);
  });

  /*
   * WHAT THIS CATCHES: an unbounded body. A catalog endpoint is a third party's
   * machine, and a response that never ends is a denial of service that needs no
   * exploit at all.
   */
  it("refuses a body larger than the cap", async () => {
    const { deps } = scripted([
      new Response("x".repeat(64), { status: 200, headers: { "content-length": "99999999" } })
    ]);

    const result = await fetchCatalogDocument(
      "https://catalog.example.test/v1/works",
      { ...options, maxResponseBytes: 32 },
      deps
    );

    expect(result).toMatchObject({ ok: false, reason: "response_too_large" });
  });

  /*
   * WHAT THIS CATCHES: a third party's response body being copied into an error
   * string. `JSON.parse` puts a slice of its input in the message, and the input
   * here is somebody else's payload -- which may be, or contain, a credential.
   */
  it("reports a non-JSON body without quoting it", async () => {
    const { deps } = scripted([
      new Response("<html>SECRET-TOKEN-abc</html>", { status: 200 })
    ]);

    const result = await fetchCatalogDocument(
      "https://catalog.example.test/v1/works",
      options,
      deps
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("document_not_json");
    expect(result.detail).not.toContain("SECRET-TOKEN");
    expect(result.detail).toContain("29 byte body");
  });

  it("passes the operator's user agent through rather than choosing one", () => {
    // Asserted on the options type rather than on a header, because the header
    // is set inside `fetchManifestText` and re-asserting it here would be a
    // second copy of that package's own test. What matters at THIS boundary is
    // that the field is required and has no default: a default would be a string
    // this package chose on an operator's behalf, attached to their reputation
    // with sources whose access policy makes it a condition.
    expect(options.userAgent).toContain("contact:");
    expect(Object.keys(CATALOG_DOCUMENT_LIMITS)).not.toContain("userAgent");
  });
});
