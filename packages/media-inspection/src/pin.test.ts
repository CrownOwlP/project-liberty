import "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authoriseFetchTarget, type EgressPolicy } from "./egress";
import { fetchManifestText, type ManifestFetchOptions } from "./http";
import {
  createPinnedLookup,
  type PinnedLookup,
  type PinnedLookupOptions,
  type PinnedTarget
} from "./pin";
import { permissiveEgress, scriptedFetch, testClassifyHost, testResolver } from "./testing/fixtures";

/**
 * PL-0304, the SSRF boundary's last mile: the address that was CLASSIFIED must
 * be the address that is CONNECTED TO.
 *
 * `egress.test.ts` pins the classification -- schemes, allowlists, loopback keys,
 * private answers refused. Every one of those assertions passed while the defect
 * this file exists for was live, because they all stop at the verdict. The
 * verdict was then thrown away: the hostname went to a `fetch`-shaped port and
 * the runtime resolved it again at connect time. A publisher controlling the
 * authoritative resolver answers those two queries differently -- public for
 * ours, 169.254.169.254 for the socket's -- and every assertion in that file
 * still passes.
 *
 * So the property under test here is not "private addresses are refused". It is
 * "no address other than an authorised one can reach the socket", and the two
 * are only the same thing when the connection is pinned.
 *
 * THE SEED IS PINNED by importing `@liberty/contracts/testing/arbitraries` for
 * its `fc.configureGlobal` side effect, the way `order.property.test.ts` does.
 * `LIBERTY_FC_SEED` widens the search without an edit.
 */

const NOW = Date.parse("2026-08-20T09:00:00.000Z");
const PUBLIC_ADDRESS = "93.184.216.34";
const SECOND_PUBLIC_ADDRESS = "198.51.100.7";
const REBOUND_ADDRESS = "10.0.0.5";

const fetchOptions: ManifestFetchOptions = {
  egress: permissiveEgress,
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
  maxRedirects: 3,
  userAgent: "test"
};

const MANIFEST = "#EXTM3U\n#EXT-X-VERSION:7\n";

/** Runs a lookup to completion. It answers on a microtask, so this must be awaited. */
function askLookup(
  lookup: PinnedLookup,
  hostname: string,
  options: PinnedLookupOptions = {}
): Promise<{ readonly code: string | null; readonly addresses: readonly string[] }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (error, address) => {
      if (error !== null) {
        resolve({ code: error.code ?? "(no code)", addresses: [] });
        return;
      }
      resolve({
        code: null,
        addresses: typeof address === "string" ? [address] : address.map((entry) => entry.address)
      });
    });
  });
}

/** A resolver that answers differently each time it is called -- a rebinding publisher. */
function rebindingResolver(answers: readonly (readonly string[])[]) {
  let call = 0;
  return async (): Promise<readonly string[]> => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return answer ?? [];
  };
}

async function pinFor(raw: string, resolveHost: () => Promise<readonly string[]>): Promise<PinnedTarget> {
  const verdict = await authoriseFetchTarget(raw, permissiveEgress, {
    classifyHost: testClassifyHost,
    resolveHost
  });
  if (!verdict.ok) throw new Error(`expected an authorisation, got ${verdict.reason}`);
  return verdict.pin;
}

describe("an authorisation yields the addresses to connect to, not just a yes", () => {
  it("carries every resolved address, unbracketed, alongside the URL", async () => {
    const pin = await pinFor("https://cdn.example.test/master.m3u8", async () => [
      PUBLIC_ADDRESS,
      SECOND_PUBLIC_ADDRESS
    ]);

    expect(pin.url).toBe("https://cdn.example.test/master.m3u8");
    expect(pin.hostname).toBe("cdn.example.test");
    expect(pin.addresses).toEqual([PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS]);
  });

  it("unbrackets an IPv6 literal, because a socket layer would try to RESOLVE `[::1]`", async () => {
    const local: EgressPolicy = {
      allowedHosts: ["[::1]"],
      allowLoopback: true,
      localDeployment: true
    };
    const verdict = await authoriseFetchTarget("http://[::1]:8096/library/master.m3u8", local, {
      classifyHost: testClassifyHost,
      resolveHost: async () => {
        throw new Error("a literal must not be resolved");
      }
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // The URL keeps the brackets the grammar requires; only the address drops
    // them. Handing `[::1]` to a socket layer is a name lookup, not a connect.
    expect(verdict.pin.url).toContain("[::1]");
    expect(verdict.pin.addresses).toEqual(["::1"]);
  });
});

describe("the pinned lookup answers from the authorised set and from nothing else", () => {
  it("returns the authorised address for the authorised name", async () => {
    const lookup = createPinnedLookup(await pinFor("https://cdn.example.test/m", async () => [PUBLIC_ADDRESS]));
    await expect(askLookup(lookup, "cdn.example.test")).resolves.toEqual({
      code: null,
      addresses: [PUBLIC_ADDRESS]
    });
  });

  it("answers the same set under `all`, which is how happy-eyeballs asks", async () => {
    const lookup = createPinnedLookup(
      await pinFor("https://cdn.example.test/m", async () => [PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS])
    );
    // Node's `net.connect` calls `lookup` with `all: true` when it is going to
    // race families. A pin that only implemented the single-address form would
    // fail closed here -- or, worse, be "fixed" by falling back to real DNS.
    await expect(askLookup(lookup, "cdn.example.test", { all: true })).resolves.toEqual({
      code: null,
      addresses: [PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS]
    });
  });

  it("refuses a hostname that is not the pinned one", async () => {
    const lookup = createPinnedLookup(await pinFor("https://cdn.example.test/m", async () => [PUBLIC_ADDRESS]));
    // Hop N's pin must not answer hop N+1's hostname. That would be a bypass
    // wearing the shape of a working pin: the connection would be to an address
    // authorised for a DIFFERENT host.
    const answer = await askLookup(lookup, "other.example.test");
    expect(answer.addresses).toEqual([]);
    expect(answer.code).toBe("ENOTFOUND");
  });

  it("matches the hostname case-insensitively, because DNS is", async () => {
    const lookup = createPinnedLookup(await pinFor("https://cdn.example.test/m", async () => [PUBLIC_ADDRESS]));
    await expect(askLookup(lookup, "CDN.Example.Test")).resolves.toEqual({
      code: null,
      addresses: [PUBLIC_ADDRESS]
    });
  });

  it("refuses a family it has no authorised address for, rather than widening", async () => {
    const lookup = createPinnedLookup(await pinFor("https://cdn.example.test/m", async () => [PUBLIC_ADDRESS]));
    const answer = await askLookup(lookup, "cdn.example.test", { family: 6 });
    expect(answer.addresses).toEqual([]);
    expect(answer.code).toBe("ENOTFOUND");
  });

  it("filters by family instead of answering the wrong one", async () => {
    const lookup = createPinnedLookup(
      await pinFor("https://cdn.example.test/m", async () => [PUBLIC_ADDRESS, "2606:2800:220:1::1"])
    );
    await expect(askLookup(lookup, "cdn.example.test", { family: "IPv6", all: true })).resolves.toEqual({
      code: null,
      addresses: ["2606:2800:220:1::1"]
    });
    await expect(askLookup(lookup, "cdn.example.test", { family: 4, all: true })).resolves.toEqual({
      code: null,
      addresses: [PUBLIC_ADDRESS]
    });
  });

  it("cannot be built with no addresses at all", () => {
    // An empty pin is indistinguishable from "unrestricted" to a later reader,
    // and an always-failing lookup looks like an outage rather than a bug.
    // `authoriseFetchTarget` refuses a name that resolves to nothing, so this is
    // a backstop for a target built some other way.
    expect(() =>
      createPinnedLookup({ url: "https://cdn.example.test/m", hostname: "cdn.example.test", addresses: [] })
    ).toThrow(TypeError);
  });
});

describe("a rebinding resolver cannot move the connection", () => {
  it("keeps answering the address that was classified, not the one DNS now returns", async () => {
    // The attack, exactly: the publisher's resolver answers a public address to
    // the query the policy makes, and a private one to the query the socket
    // would have made. Under the old design those were two different answers to
    // two different queries and the socket got the second.
    const resolveHost = rebindingResolver([[PUBLIC_ADDRESS], [REBOUND_ADDRESS]]);
    const lookup = createPinnedLookup(await pinFor("https://cdn.example.test/m", resolveHost));

    // The second answer is live and would classify as private -- it is simply
    // never asked for. The lookup has no resolver behind it at all.
    await expect(resolveHost()).resolves.toEqual([REBOUND_ADDRESS]);

    for (const options of [{}, { all: true }, { family: 4 }, { family: 0, all: true }]) {
      const answer = await askLookup(lookup, "cdn.example.test", options);
      expect(answer.addresses).toEqual([PUBLIC_ADDRESS]);
      expect(answer.addresses).not.toContain(REBOUND_ADDRESS);
    }
  });

  it("hands the transport the classified address, so nothing downstream can re-resolve", async () => {
    const { fetchImpl, pinned, requested } = scriptedFetch([{ status: 200, body: MANIFEST }]);

    const result = await fetchManifestText("https://cdn.example.test/master.m3u8", fetchOptions, {
      classifyHost: testClassifyHost,
      resolveHost: rebindingResolver([[PUBLIC_ADDRESS], [REBOUND_ADDRESS]]),
      fetchImpl,
      now: () => NOW
    });

    expect(result.ok).toBe(true);
    expect(requested).toEqual(["https://cdn.example.test/master.m3u8"]);
    // The whole fix in one assertion: what the transport was given is what the
    // policy approved. A transport that received only `requested[0]` would have
    // had to resolve the name itself, and would have got `REBOUND_ADDRESS`.
    expect(pinned).toEqual([[PUBLIC_ADDRESS]]);
  });

  it("still refuses outright when the FIRST answer is private", async () => {
    // The pin is not a substitute for the classification, and this is the test
    // that would catch somebody "simplifying" `authoriseFetchTarget` into a
    // resolver on the grounds that the connection is pinned anyway.
    const { fetchImpl, requested } = scriptedFetch([{ status: 200, body: MANIFEST }]);

    const result = await fetchManifestText("https://cdn.example.test/master.m3u8", fetchOptions, {
      classifyHost: testClassifyHost,
      resolveHost: rebindingResolver([[REBOUND_ADDRESS], [PUBLIC_ADDRESS]]),
      fetchImpl,
      now: () => NOW
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("dns_resolved_private_address");
    expect(requested).toEqual([]);
  });
});

describe("every redirect hop is pinned to its own authorisation", () => {
  const perHostResolver = (answers: Readonly<Record<string, readonly string[]>>) =>
    async (hostname: string): Promise<readonly string[]> => answers[hostname.toLowerCase()] ?? [];

  it("re-pins on each hop instead of carrying the first hop's addresses forward", async () => {
    const { fetchImpl, pinned, requested } = scriptedFetch([
      { status: 302, body: "", headers: { location: "https://other.example.test/m.m3u8" } },
      { status: 200, body: MANIFEST }
    ]);

    const result = await fetchManifestText("https://cdn.example.test/master.m3u8", fetchOptions, {
      classifyHost: testClassifyHost,
      resolveHost: perHostResolver({
        "cdn.example.test": [PUBLIC_ADDRESS],
        "other.example.test": [SECOND_PUBLIC_ADDRESS]
      }),
      fetchImpl,
      now: () => NOW
    });

    expect(result.ok).toBe(true);
    expect(requested).toHaveLength(2);
    // Distinct sets, in hop order. Reusing hop 0's pin for hop 1 would mean
    // connecting to an address authorised for a different hostname -- and the
    // lookup's hostname check would then refuse the connection outright, which
    // is the failure direction that is safe but still wrong.
    expect(pinned).toEqual([[PUBLIC_ADDRESS], [SECOND_PUBLIC_ADDRESS]]);
  });

  it("never reaches the transport for a hop whose host resolves privately", async () => {
    const { fetchImpl, pinned } = scriptedFetch([
      { status: 302, body: "", headers: { location: "https://other.example.test/m.m3u8" } },
      { status: 200, body: "must never be fetched" }
    ]);

    const result = await fetchManifestText("https://cdn.example.test/master.m3u8", fetchOptions, {
      classifyHost: testClassifyHost,
      resolveHost: perHostResolver({
        "cdn.example.test": [PUBLIC_ADDRESS],
        "other.example.test": [REBOUND_ADDRESS]
      }),
      fetchImpl,
      now: () => NOW
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("dns_resolved_private_address");
    expect(result.detail).toContain("redirect hop 1");
    // One hop reached the transport. The second was refused before a pin existed
    // for it, so there was never anything to connect with.
    expect(pinned).toEqual([[PUBLIC_ADDRESS]]);
  });

  it("pins a literal target to the literal itself, with no resolver consulted", async () => {
    const local: EgressPolicy = { ...permissiveEgress, allowLoopback: true, localDeployment: true };
    const { fetchImpl, pinned } = scriptedFetch([{ status: 200, body: MANIFEST }]);

    const result = await fetchManifestText(
      "http://127.0.0.1:8096/library/master.m3u8",
      { ...fetchOptions, egress: local },
      {
        classifyHost: testClassifyHost,
        resolveHost: async () => {
          throw new Error("a literal must not be resolved");
        },
        fetchImpl,
        now: () => NOW
      }
    );

    expect(result.ok).toBe(true);
    expect(pinned).toEqual([["127.0.0.1"]]);
  });
});

describe("the pin holds for any address set and any way of asking (fast-check)", () => {
  const addressArb = fc.oneof(
    fc.constantFrom(PUBLIC_ADDRESS, SECOND_PUBLIC_ADDRESS, "203.0.113.9", "8.8.8.8"),
    fc.constantFrom("2606:2800:220:1::1", "2001:db8::2", "2400:cb00::1")
  );

  // Inferred rather than annotated as `Arbitrary<PinnedLookupOptions>`:
  // `Arbitrary` is invariant in its parameter (`map` puts it in a contravariant
  // position), so the annotation would reject a perfectly assignable record.
  const optionsArb = fc.record({
    family: fc.constantFrom(undefined, 0, 4, 6, "IPv4", "IPv6"),
    all: fc.constantFrom(undefined, true, false),
    hints: fc.constantFrom(undefined, 0, 1024),
    verbatim: fc.constantFrom(undefined, true, false)
  });

  it("never answers with an address that was not authorised", async () => {
    /*
     * The example tests above each pin one shape of question. This one says the
     * thing that has to hold for ALL of them, because the socket layer -- not
     * this package -- chooses which shape it asks: whatever `family`, `all`,
     * `hints` and `verbatim` combination Node picks for a given platform and a
     * given `autoSelectFamily` setting, the answer is a subset of the authorised
     * set or it is a refusal. An implementation that fell back to real DNS for
     * an unhandled combination would be invisible to example tests written by
     * somebody who did not think of that combination -- which is precisely how
     * the original defect survived review.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(addressArb, { minLength: 1, maxLength: 4 }),
        optionsArb,
        async (addresses, options) => {
          const lookup = createPinnedLookup({
            url: "https://cdn.example.test/master.m3u8",
            hostname: "cdn.example.test",
            addresses
          });
          const answer = await askLookup(lookup, "cdn.example.test", options);
          for (const address of answer.addresses) expect(addresses).toContain(address);
        }
      )
    );
  });

  it("never answers for a hostname other than the pinned one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(addressArb, { minLength: 1, maxLength: 4 }),
        optionsArb,
        fc.constantFrom("other.example.test", "evil.test", "", "cdn.example.test.", "cdn.example.tes"),
        async (addresses, options, hostname) => {
          const lookup = createPinnedLookup({
            url: "https://cdn.example.test/master.m3u8",
            hostname: "cdn.example.test",
            addresses
          });
          const answer = await askLookup(lookup, hostname, options);
          expect(answer.addresses).toEqual([]);
          expect(answer.code).toBe("ENOTFOUND");
        }
      )
    );
  });
});

describe("the resolver is consulted exactly once per hop", () => {
  it("does not resolve again between the check and the connect", async () => {
    // The count IS the property. Two resolutions is the rebinding window; one is
    // the absence of it. Anything that reintroduces a second lookup -- a retry, a
    // transport that resolves for itself, a "refresh the pin" convenience --
    // fails here rather than silently reopening the hole.
    let resolutions = 0;
    const { fetchImpl } = scriptedFetch([
      { status: 302, body: "", headers: { location: "https://other.example.test/m.m3u8" } },
      { status: 200, body: MANIFEST }
    ]);

    const result = await fetchManifestText("https://cdn.example.test/master.m3u8", fetchOptions, {
      classifyHost: testClassifyHost,
      resolveHost: async (hostname) => {
        resolutions += 1;
        return testResolver()(hostname);
      },
      fetchImpl,
      now: () => NOW
    });

    expect(result.ok).toBe(true);
    expect(resolutions).toBe(2);
  });
});
