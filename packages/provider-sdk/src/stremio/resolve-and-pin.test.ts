import type { HostResolver, PinnedTarget } from "@liberty/media-inspection/egress";
import type { PinnedFetch } from "@liberty/media-inspection/pin";
import { bareAddress } from "@liberty/net-policy/host";
import { HOSTILE_ADDRESS_SPELLINGS } from "@liberty/net-policy/testing/host-spellings";
import { describe, expect, it } from "vitest";
import { fetchJson, type HttpOptions } from "./http";

/**
 * PROVIDER OUTBOUND HTTP RESOLVES, CLASSIFIES AND PINS ITS DESTINATION
 * (PL-0710, resolve-and-pin half).
 *
 * WHAT THIS FILE IS ABOUT, and why every assertion in it is a refusal or an
 * identity. Until this change `fetchJson` checked a HOST LITERAL and then handed
 * the HOSTNAME to a `fetch`-shaped port, so the runtime resolved the name a
 * second time when it opened the socket. The address that was judged and the
 * address that was connected to were two independent answers to the same
 * question, and whoever controls the authoritative resolver chooses both. Every
 * clause below is a separate way that arrangement fails:
 *
 *   1. resolution happens BEFORE the connection;
 *   2. EVERY resolved address is classified, not just the first;
 *   3. any disallowed answer refuses the target, mixed sets included;
 *   4. the transport is given the AUTHORISED ADDRESSES and nothing else, so no
 *      second resolution can choose the destination;
 *   5. each redirect hop is authorised and pinned independently;
 *   6. loopback stays behind the two-key rule;
 *   7. the pin carries the ORIGINAL URL and hostname, never an address --
 *      `pinned-transport.test.ts` is where that one is taken to a real socket.
 *
 * THE MECHANISM IS NOT NEW AND MUST NOT BE. `authoriseResolvedTarget` is
 * `@liberty/media-inspection`'s, minting the same unforgeable `PinnedTarget`
 * that `authoriseFetchTarget` mints, and the transport is the same
 * `PinnedFetch`. A second resolve-and-pin control written beside the first would
 * be the two-SSRF-classifiers defect one layer up -- which is the defect PL-0710
 * spent its first half removing.
 *
 * THE ADDRESS CORPUS IS IMPORTED, NOT RESTATED. `HOSTILE_ADDRESS_SPELLINGS` is
 * the table PL-0710's extraction put in the leaf package: NAT64 `64:ff9b::/96`,
 * 6to4 `2002::/16`, IPv4-translated `::ffff:0:0/96`, the metadata address, CGNAT
 * and the public controls. Restating any of them here would be a fourth copy of
 * the vocabulary and would drift exactly as the classifier did.
 */

const MANIFEST_URL = "https://archive.example.com/manifest.json";
/** A public address, per the corpus' own control row. */
const PUBLIC_ADDRESS = "93.184.216.34";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

interface Recorded {
  readonly resolved: string[];
  readonly pins: PinnedTarget[];
}

interface Rig {
  readonly options: HttpOptions;
  readonly recorded: Recorded;
}

/**
 * A `fetchJson` rig with both ports recorded.
 *
 * `resolveHost` and the transport are the only two things stubbed, and neither
 * of them is a policy: the URL gate, the host classification, the per-address
 * classification, the loopback keys and the pin minting are all the production
 * ones. A resolver that answers 10.0.0.5 for a public name is a resolver a
 * hostile publisher can genuinely arrange, which is the entire point.
 */
function rig(
  resolve: HostResolver,
  respond: (target: PinnedTarget) => Response | Promise<Response>,
  over: Partial<HttpOptions> = {}
): Rig {
  const recorded: Recorded = { resolved: [], pins: [] };
  const resolveHost: HostResolver = async (hostname) => {
    recorded.resolved.push(hostname);
    return resolve(hostname);
  };
  const fetchImpl: PinnedFetch = async (target) => {
    recorded.pins.push(target);
    return respond(target);
  };
  return {
    recorded,
    options: {
      fetchImpl,
      resolveHost,
      timeoutMs: 2_000,
      maxResponseBytes: 65_536,
      maxRedirects: 2,
      allowLoopback: false,
      localDeployment: false,
      userAgent: "pl-0710-test",
      now: () => 1_700_000_000_000,
      ...over
    }
  };
}

const answering = (...addresses: string[]): HostResolver => async () => addresses;

describe("clause 1 -- DNS resolution happens before the outbound connection", () => {
  it("resolves the name, then connects, in that order", async () => {
    const order: string[] = [];
    const { options } = rig(
      async (hostname) => {
        order.push(`resolve:${hostname}`);
        return [PUBLIC_ADDRESS];
      },
      (target) => {
        order.push(`connect:${target.addresses.join(",")}`);
        return json({ id: "org.archive" });
      }
    );

    const result = await fetchJson(MANIFEST_URL, options);

    expect(result.ok).toBe(true);
    expect(order).toEqual(["resolve:archive.example.com", `connect:${PUBLIC_ADDRESS}`]);
  });

  it("opens nothing when the resolver fails", async () => {
    const { options, recorded } = rig(
      () => Promise.reject(new Error("SERVFAIL for archive.example.com from 10.0.0.53")),
      () => json({})
    );

    const result = await fetchJson(MANIFEST_URL, options);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("dns_resolution_failed");
    // And the resolver's own message is not repeated: some resolvers name the
    // query and the server they asked, and a reason trail is not a place for
    // either.
    expect(!result.ok && result.detail).toBe("host archive.example.com could not be resolved");
    expect(recorded.pins).toHaveLength(0);
  });

  it("opens nothing when the name resolves to no addresses at all", async () => {
    const { options, recorded } = rig(answering(), () => json({}));

    const result = await fetchJson(MANIFEST_URL, options);

    expect(!result.ok && result.reason).toBe("dns_resolved_no_addresses");
    expect(recorded.pins).toHaveLength(0);
  });
});

describe("clause 2 and 3 -- every resolved address is classified, and one bad answer refuses the target", () => {
  it("refuses a public name whose only answer is private", async () => {
    const { options, recorded } = rig(answering("10.0.0.5"), () => json({}));

    const result = await fetchJson(MANIFEST_URL, options);

    expect(!result.ok && result.reason).toBe("dns_resolved_private_address");
    expect(!result.ok && result.detail).toBe(
      "host archive.example.com resolves to an address in a private range"
    );
    expect(recorded.pins).toHaveLength(0);
  });

  it("refuses a mixed answer set whatever order the private answer arrives in", async () => {
    /*
     * THE ORDERING IS THE TEST. A gate that looked at `addresses[0]` would admit
     * the first of these and refuse the second, which is the worst available
     * failure mode: a round-robin into the private network that presents as
     * flakiness rather than as a hole.
     */
    for (const answer of [
      [PUBLIC_ADDRESS, "10.0.0.5"],
      ["10.0.0.5", PUBLIC_ADDRESS],
      [PUBLIC_ADDRESS, PUBLIC_ADDRESS, "169.254.169.254"]
    ]) {
      const { options, recorded } = rig(answering(...answer), () => json({}));
      const result = await fetchJson(MANIFEST_URL, options);
      expect(!result.ok && result.reason).toBe("dns_resolved_private_address");
      expect(recorded.pins).toHaveLength(0);
    }
  });

  it("pins every authorised address when they are all public", async () => {
    const { options, recorded } = rig(answering(PUBLIC_ADDRESS, "8.8.8.8"), () => json({}));

    const result = await fetchJson(MANIFEST_URL, options);

    expect(result.ok).toBe(true);
    expect(recorded.pins[0]?.addresses).toEqual([PUBLIC_ADDRESS, "8.8.8.8"]);
  });

  it.each(
    HOSTILE_ADDRESS_SPELLINGS.map((entry) => ({
      answer: bareAddress(entry.spelling),
      admissible: entry.expected === "public",
      why: entry.why
    }))
  )("classifies the resolver answer $answer -- $why", async ({ answer, admissible }) => {
    /*
     * Driven from `@liberty/net-policy/testing/host-spellings`, in the spelling a
     * RESOLVER produces: bare, never bracketed. That difference is the whole of
     * F1 -- a bare `fe80::1` handed to a classifier written for URL hostnames
     * used to fall out of the bottom as `public` -- and it is why the resolve
     * path goes through `classifyResolvedAddress`, which brackets first.
     *
     * NAT64 `64:ff9b::/96`, 6to4 `2002::/16` and IPv4-translated `::ffff:0:0/96`
     * are in this corpus as F8. They are carried, not re-derived: a translation
     * prefix wrapping 10.0.0.1 is refused and the same prefix wrapping 8.8.8.8 is
     * admitted, so the table's public rows are what stops this from being a test
     * that a classifier refusing everything would pass.
     */
    const { options, recorded } = rig(answering(answer), () => json({ id: "org.archive" }));

    const result = await fetchJson(MANIFEST_URL, options);

    if (admissible) {
      expect(result.ok).toBe(true);
      expect(recorded.pins[0]?.addresses).toEqual([answer]);
    } else {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("dns_resolved_private_address");
      expect(recorded.pins).toHaveLength(0);
    }
  });
});

describe("clause 4 -- the transport connects only to an address the authorisation approved", () => {
  it("hands the transport a pinned target rather than a URL string", async () => {
    const { options, recorded } = rig(answering(PUBLIC_ADDRESS), () => json({}));

    await fetchJson(MANIFEST_URL, options);

    const pin = recorded.pins[0];
    // Not a string. A transport that receives only a URL has no way to learn
    // which addresses were authorised and must resolve the name itself, which is
    // the second resolution this whole design removes.
    expect(typeof pin).toBe("object");
    expect(pin?.url).toBe(MANIFEST_URL);
    expect(pin?.hostname).toBe("archive.example.com");
    expect(pin?.addresses).toEqual([PUBLIC_ADDRESS]);
  });

  it("gives the transport the addresses the FIRST resolution returned, not a later one", async () => {
    /*
     * DNS REBINDING, stated as the two answers it really is. The resolver here
     * answers a public address once and the cloud metadata endpoint every time
     * after -- which is exactly what an authoritative server under a publisher's
     * control does when it sets a one-second TTL. The authorisation must be the
     * thing that chose the destination.
     */
    let calls = 0;
    const { options, recorded } = rig(
      async () => (++calls === 1 ? [PUBLIC_ADDRESS] : ["169.254.169.254"]),
      () => json({ id: "org.archive" })
    );

    const result = await fetchJson(MANIFEST_URL, options);

    expect(result.ok).toBe(true);
    // One hop, one resolution: nothing downstream gets a second answer to choose
    // from, because nothing downstream asks.
    expect(calls).toBe(1);
    expect(recorded.pins[0]?.addresses).toEqual([PUBLIC_ADDRESS]);
    expect(recorded.pins[0]?.addresses).not.toContain("169.254.169.254");
  });
});

describe("clause 5 -- every redirect hop is authorised and pinned independently", () => {
  const REDIRECTED_TO = "https://cdn.example.com/manifest.json";

  it("re-resolves and re-pins for the second hop rather than reusing the first hop's pin", async () => {
    const { options, recorded } = rig(
      async (hostname) => (hostname === "archive.example.com" ? [PUBLIC_ADDRESS] : ["8.8.8.8"]),
      (target) =>
        target.url === MANIFEST_URL
          ? new Response(null, { status: 302, headers: { location: REDIRECTED_TO } })
          : json({ id: "org.archive" })
    );

    const result = await fetchJson(MANIFEST_URL, options);

    expect(result.ok).toBe(true);
    expect(recorded.resolved).toEqual(["archive.example.com", "cdn.example.com"]);
    expect(recorded.pins.map((pin) => pin.hostname)).toEqual([
      "archive.example.com",
      "cdn.example.com"
    ]);
    expect(recorded.pins.map((pin) => pin.addresses)).toEqual([[PUBLIC_ADDRESS], ["8.8.8.8"]]);
    // Two distinct authorisations, not one pin carried forward. A pin reused
    // across hops would hand hop 1 the addresses hop 0 was authorised for.
    expect(recorded.pins[0]).not.toBe(recorded.pins[1]);
  });

  it("refuses at the hop where the resolution turns private, naming the hop", async () => {
    const { options, recorded } = rig(
      async (hostname) =>
        hostname === "archive.example.com" ? [PUBLIC_ADDRESS] : ["169.254.169.254"],
      (target) =>
        target.url === MANIFEST_URL
          ? new Response(null, { status: 302, headers: { location: REDIRECTED_TO } })
          : json({ id: "org.archive" })
    );

    const result = await fetchJson(MANIFEST_URL, options);

    expect(!result.ok && result.reason).toBe("dns_resolved_private_address");
    expect(!result.ok && result.detail).toBe(
      "redirect hop 1: host cdn.example.com resolves to an address in a private range"
    );
    // The second hop never became a pin, so it never became a socket.
    expect(recorded.pins).toHaveLength(1);
  });

  it("refuses a relative redirect that resolves into the private network", async () => {
    // A relative `Location` resolves against the hop that issued it, so it goes
    // through the same gate as an absolute one rather than being misread as a
    // bare hostname.
    const { options } = rig(answering("10.0.0.5"), (target) =>
      target.url === MANIFEST_URL
        ? new Response(null, { status: 302, headers: { location: "/other.json" } })
        : json({})
    );

    const result = await fetchJson(MANIFEST_URL, options);

    expect(!result.ok && result.reason).toBe("dns_resolved_private_address");
  });
});

describe("clause 6 -- loopback needs both keys, and a public name never borrows them", () => {
  const LOCAL_URL = "http://localhost:9200/manifest.json";

  it("permits a loopback name when the source opted in AND the deployment is local", async () => {
    const { options, recorded } = rig(answering("127.0.0.1"), () => json({ id: "local" }), {
      allowLoopback: true,
      localDeployment: true
    });

    const result = await fetchJson(LOCAL_URL, options);

    expect(result.ok).toBe(true);
    expect(recorded.pins[0]?.hostname).toBe("localhost");
    expect(recorded.pins[0]?.addresses).toEqual(["127.0.0.1"]);
  });

  it("refuses, and does not even resolve, when the source did not opt in", async () => {
    const { options, recorded } = rig(answering("127.0.0.1"), () => json({}), {
      allowLoopback: false,
      localDeployment: true
    });

    const result = await fetchJson(LOCAL_URL, options);

    expect(!result.ok && result.reason).toBe("url_loopback_not_permitted");
    // The static gate decides this one, so no name lookup is performed at all.
    expect(recorded.resolved).toEqual([]);
  });

  it("refuses when the source opted in but the instance is hosted", async () => {
    const { options, recorded } = rig(answering("127.0.0.1"), () => json({}), {
      allowLoopback: true,
      localDeployment: false
    });

    const result = await fetchJson(LOCAL_URL, options);

    expect(!result.ok && result.reason).toBe("url_loopback_not_local_deployment");
    expect(recorded.resolved).toEqual([]);
  });

  it("refuses a PUBLIC name that resolves to loopback even with both keys set", async () => {
    /*
     * The two keys are a statement about an operator's own machine reached by
     * its own name. A public name answering 127.0.0.1 is the rebinding shape --
     * the classic way an SSRF filter that trusts the name is walked past -- and
     * it is refused on the resolved address regardless of the keys.
     */
    const { options, recorded } = rig(answering("127.0.0.1"), () => json({}), {
      allowLoopback: true,
      localDeployment: true
    });

    const result = await fetchJson(MANIFEST_URL, options);

    expect(!result.ok && result.reason).toBe("dns_resolved_private_address");
    expect(!result.ok && result.detail).toBe(
      "host archive.example.com resolves to an address in a loopback range"
    );
    expect(recorded.pins).toHaveLength(0);
  });
});

describe("clause 7 -- the pin carries the hostname, so nothing downstream can verify an address", () => {
  it("never substitutes an address into the URL or the hostname", async () => {
    const { options, recorded } = rig(answering(PUBLIC_ADDRESS), () => json({}));

    await fetchJson(MANIFEST_URL, options);

    const pin = recorded.pins[0];
    // `Host`, SNI and `tls.checkServerIdentity` are all computed from these two
    // fields by the transport. An address here is the rejected design -- rewrite
    // the URL to the IP and set a Host header -- under which the certificate is
    // validated against an IP that no ordinary certificate carries.
    expect(pin?.url).not.toContain(PUBLIC_ADDRESS);
    expect(pin?.hostname).not.toContain(PUBLIC_ADDRESS);
    expect(pin?.url).toBe(MANIFEST_URL);
    expect(pin?.hostname).toBe("archive.example.com");
  });

  it("keeps the bracketed spelling of an IPv6 literal in the hostname and drops it in the address", async () => {
    // The brackets belong to the URL grammar. The transport compares the lookup's
    // hostname against the pin's, and hands the socket layer the bare address.
    const { options, recorded } = rig(answering(), () => json({}), {
      allowLoopback: true,
      localDeployment: true
    });

    const result = await fetchJson("http://[::1]:9200/manifest.json", options);

    expect(result.ok).toBe(true);
    expect(recorded.resolved).toEqual([]);
    expect(recorded.pins[0]?.hostname).toBe("[::1]");
    expect(recorded.pins[0]?.addresses).toEqual(["::1"]);
  });
});
