import type { HostResolver, PinnedTarget } from "@liberty/media-inspection/egress";
import type { PinnedFetch } from "@liberty/media-inspection/pin";
import { describe, expect, it } from "vitest";
import { normalizeAddonUrl, previewStremioAddon } from "./add-by-url";
import type { HttpOptions } from "./http";

/**
 * ADD-BY-URL (PL-0743).
 *
 * The feature is three lines of composition, so the tests are not about the
 * composition. They are about the two things that can be wrong in a way that
 * matters, and both of them are ORDERING:
 *
 *   1. `stremio://` is normalised BEFORE the URL and network policy run, and
 *      the normalisation grants the URL no authority it would not have had as
 *      `https://`. A scheme swap that quietly exempted a host from the
 *      loopback or private-range rules would be a hole shaped exactly like a
 *      convenience feature.
 *   2. a preview is NOT an authorization, and nothing about holding one brings
 *      a source into existence.
 *
 * The third thing, that the network call goes through the pinned transport and
 * not around it, is asserted structurally: the rig below stubs ONLY the
 * resolver and the transport port, exactly as `resolve-and-pin.test.ts` does,
 * and every refusal observed here is produced by the production gate. If a
 * future edit reached the network another way, these tests would stop seeing
 * resolutions at all.
 */

const MANIFEST_URL = "https://addons.example.com/manifest.json";
/** An ordinary hosted deployment talking to an ordinary remote addon. */
const REMOTE = { allowLoopback: false, localDeployment: false } as const;
const PUBLIC_ADDRESS = "93.184.216.34";

const MANIFEST = {
  id: "org.example.addon",
  version: "1.4.2",
  name: "Example Public Domain Films",
  description: "Films in the public domain.",
  types: ["movie"],
  resources: ["stream", { name: "catalog", types: ["movie"] }],
  catalogs: [{ type: "movie", id: "pd-top" }],
  behaviorHints: { adult: false, p2p: false }
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

interface Rig {
  readonly options: HttpOptions;
  readonly resolved: string[];
  readonly pins: PinnedTarget[];
}

/** Same shape as `resolve-and-pin.test.ts`: only the two ports are doubles. */
function rig(
  resolve: HostResolver = async () => [PUBLIC_ADDRESS],
  respond: (target: PinnedTarget) => Response | Promise<Response> = () => json(MANIFEST),
  over: Partial<HttpOptions> = {}
): Rig {
  const resolved: string[] = [];
  const pins: PinnedTarget[] = [];
  const resolveHost: HostResolver = async (hostname) => {
    resolved.push(hostname);
    return resolve(hostname);
  };
  const fetchImpl: PinnedFetch = async (target) => {
    pins.push(target);
    return respond(target);
  };
  return {
    resolved,
    pins,
    options: {
      fetchImpl,
      resolveHost,
      timeoutMs: 2_000,
      maxResponseBytes: 65_536,
      maxRedirects: 2,
      allowLoopback: false,
      localDeployment: false,
      userAgent: "pl-0743-test",
      now: () => 1_700_000_000_000,
      ...over
    }
  };
}

/* ------------------------------------------------------------------------ */
/* 1. NORMALISATION                                                          */
/* ------------------------------------------------------------------------ */

describe("stremio:// is a scheme swap and nothing else", () => {
  it("accepts the scheme every addon directory publishes", () => {
    const result = normalizeAddonUrl("stremio://addons.example.com/manifest.json", REMOTE);
    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toBe("https://addons.example.com/manifest.json");
    expect(result.ok && result.normalizedFromStremioScheme).toBe(true);
  });

  it("is case-insensitive on the scheme, as every URL scheme is", () => {
    const result = normalizeAddonUrl("STREMIO://addons.example.com/manifest.json", REMOTE);
    expect(result.ok && result.url).toBe("https://addons.example.com/manifest.json");
  });

  it("LEAVES THE HOST, PORT, PATH AND QUERY EXACTLY AS THEY WERE", () => {
    /*
     * The whole safety argument for normalising at all. If this rewrote any
     * other part of the URL, the policy would be judging one destination and
     * the socket opening another -- which is the failure `http.ts` exists to
     * prevent, reintroduced one layer above it.
     */
    const result = normalizeAddonUrl(
      "stremio://addons.example.com:8443/configured/abc%2Fdef/manifest.json?token=1#frag",
      REMOTE
    );
    expect(result.ok && result.url).toBe(
      "https://addons.example.com:8443/configured/abc%2Fdef/manifest.json?token=1#frag"
    );
  });

  it("only touches a LEADING stremio://, never one inside the URL", () => {
    const raw = "https://addons.example.com/manifest.json?next=stremio://other.test/manifest.json";
    const result = normalizeAddonUrl(raw, REMOTE);
    expect(result.ok && result.url).toBe(raw);
    expect(result.ok && result.normalizedFromStremioScheme).toBe(false);
  });

  it("hands every OTHER scheme to the policy rather than judging it here", () => {
    /*
     * `stremio:` with no authority, `http:` to a remote host, `file:`,
     * `magnet:` -- none of these is this file's decision. url-policy.ts owns
     * schemes, and a second scheme judgement here would be the two-classifiers
     * defect one layer up. What IS asserted is that the refusal arrives, with
     * url-policy's own reason, before anything opens a socket.
     */
    for (const raw of [
      "stremio:addons.example.com/manifest.json",
      "http://addons.example.com/manifest.json",
      "file:///etc/manifest.json",
      "magnet:?xt=urn:btih:deadbeef"
    ]) {
      const result = normalizeAddonUrl(raw, REMOTE);
      expect(result.ok, raw).toBe(false);
      expect(!result.ok && result.reason, raw).toMatch(/^url_/);
    }
  });

  it("requires the path source.ts will later require, rather than failing late", () => {
    const result = normalizeAddonUrl("https://addons.example.com/addon/", REMOTE);
    expect(!result.ok && result.reason).toBe("manifest_url_not_manifest_json");
  });

  it.each(["", "   ", "\n"])("an empty paste is a reason, not a crash (%j)", (raw) => {
    const result = normalizeAddonUrl(raw, REMOTE);
    expect(!result.ok && result.reason).toBe("empty_input");
  });

  it("a paste that is not a URL is a reason, not a crash", () => {
    const result = normalizeAddonUrl("my favourite addon", REMOTE);
    expect(!result.ok && result.reason).toBe("url_unparseable");
  });
});

/* ------------------------------------------------------------------------ */
/* 2. THE SCHEME SWAP BUYS NO AUTHORITY                                      */
/* ------------------------------------------------------------------------ */

describe("A stremio:// URL IS SUBJECT TO EVERY RULE ITS https:// FORM IS", () => {
  /*
   * THE TEST THIS FILE EXISTS FOR. Each case runs the SAME host twice, once
   * through each spelling, and requires the outcome to be identical. Asserting
   * a fixed reason string would pass even if the two spellings diverged; the
   * identity is what cannot be satisfied by a normalisation that exempts
   * anything.
   */
  const bothSpellings = async (host: string, over: Partial<HttpOptions> = {}) => {
    const viaHttps = await previewStremioAddon(`https://${host}/manifest.json`, rig(undefined, undefined, over).options);
    const viaStremio = await previewStremioAddon(`stremio://${host}/manifest.json`, rig(undefined, undefined, over).options);
    return {
      https: viaHttps.ok ? "ok" : viaHttps.reason,
      stremio: viaStremio.ok ? "ok" : viaStremio.reason
    };
  };

  it("refuses a loopback host identically through both", async () => {
    const outcome = await bothSpellings("127.0.0.1");
    expect(outcome.stremio).toBe(outcome.https);
    expect(outcome.stremio).not.toBe("ok");
  });

  it("refuses a private-range host identically through both", async () => {
    const outcome = await bothSpellings("10.0.0.5");
    expect(outcome.stremio).toBe(outcome.https);
    expect(outcome.stremio).not.toBe("ok");
  });

  it("refuses the cloud metadata address identically through both", async () => {
    const outcome = await bothSpellings("169.254.169.254");
    expect(outcome.stremio).toBe(outcome.https);
    expect(outcome.stremio).not.toBe("ok");
  });

  it("refuses embedded credentials identically through both", async () => {
    const outcome = await bothSpellings("addons.example.com@evil.test");
    expect(outcome.stremio).toBe(outcome.https);
    expect(outcome.stremio).not.toBe("ok");
  });

  it("refuses a name that RESOLVES into the private range, through both", async () => {
    /*
     * The rebinding case, and the reason this feature could be written at all:
     * the host literal is public and only the resolver's answer is hostile.
     * Without PL-0710's resolve-and-pin in `http.ts` this would pass.
     */
    const resolver: HostResolver = async () => ["10.0.0.5"];
    const viaHttps = await previewStremioAddon(MANIFEST_URL, rig(resolver).options);
    const viaStremio = await previewStremioAddon(
      "stremio://addons.example.com/manifest.json",
      rig(resolver).options
    );
    expect(viaHttps.ok).toBe(false);
    expect(viaStremio.ok).toBe(false);
    expect(!viaStremio.ok && viaStremio.reason).toBe(!viaHttps.ok && viaHttps.reason);
  });

  it("opens no socket at all when the gate refuses", async () => {
    const r = rig();
    await previewStremioAddon("stremio://169.254.169.254/manifest.json", r.options);
    expect(r.pins).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ */
/* 3. THE PREVIEW                                                            */
/* ------------------------------------------------------------------------ */

describe("the preview describes what the addon SAYS", () => {
  it("reports name, version and declared resources", async () => {
    const result = await previewStremioAddon("stremio://addons.example.com/manifest.json", rig().options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.name).toBe("Example Public Domain Films");
    expect(result.preview.version).toBe("1.4.2");
    expect(result.preview.declaredResources).toEqual(["stream", "catalog"]);
    expect(result.preview.declaredTypes).toEqual(["movie"]);
    expect(result.preview.catalogCount).toBe(1);
  });

  it("reports the URL the body CAME FROM, not the one that was pasted", async () => {
    /*
     * A directory link that redirects is exactly the case a person needs to
     * see before declaring rights over it, and showing them their own paste
     * would hide it.
     */
    const r = rig(undefined, (target) =>
      target.url.includes("/redirected/")
        ? json(MANIFEST)
        : json(null, { status: 302, headers: { location: "https://addons.example.com/redirected/manifest.json" } })
    );
    const result = await previewStremioAddon(MANIFEST_URL, r.options);
    expect(result.ok && result.preview.manifestUrl).toBe(
      "https://addons.example.com/redirected/manifest.json"
    );
  });

  it("a malformed manifest is a reason, not a throw", async () => {
    const r = rig(undefined, () => json({ id: "no-version-no-name" }));
    const result = await previewStremioAddon(MANIFEST_URL, r.options);
    expect(!result.ok && result.reason).toBe("manifest_malformed");
  });

  it("an addon that is down is a reason, not a throw", async () => {
    const r = rig(undefined, () => json(null, { status: 503 }));
    const result = await previewStremioAddon(MANIFEST_URL, r.options);
    expect(!result.ok && result.reason).toBe("http_status");
  });
});

/* ------------------------------------------------------------------------ */
/* 4. A PREVIEW IS NOT AN AUTHORIZATION                                      */
/* ------------------------------------------------------------------------ */

describe("A PREVIEW IS NOT AN AUTHORIZATION", () => {
  it("carries no rights, no basis, and says so inside the payload", async () => {
    const result = await previewStremioAddon(MANIFEST_URL, rig().options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const asRecord = result.preview as unknown as Record<string, unknown>;
    expect(asRecord["rights"]).toBeUndefined();
    expect(asRecord["rightsBasis"]).toBeUndefined();
    expect(result.preview.authorization).toBe("none");

    /*
     * The note travels in the OBJECT. A preview is serialised to JSON on its
     * way to a UI, where the branded type that makes this structural in
     * TypeScript does not exist -- so the statement has to be in the payload,
     * for the same reason the Windows qualification report carries its own
     * `notCovered` list rather than relying on a covering message.
     */
    const serialised = JSON.parse(JSON.stringify(result.preview)) as Record<string, unknown>;
    expect(serialised["authorization"]).toBe("none");
    expect(String(serialised["authorizationNote"])).toMatch(/not an authorization/i);
    expect(String(serialised["authorizationNote"])).toMatch(/defineStremioSource/);
  });

  it("does not survive a round trip as anything a provider would accept", async () => {
    /*
     * The type system already refuses this -- `AuthorizedStremioSource` carries
     * a unique-symbol brand a preview does not have, so
     * `createStremioProvider(preview)` does not compile. That is the real
     * control and it cannot be asserted at runtime. What CAN be asserted, and
     * is the thing a hand-written UI could get wrong, is that the serialised
     * preview contains none of the fields such a UI might copy across into a
     * source definition and believe it had one.
     */
    const result = await previewStremioAddon(MANIFEST_URL, rig().options);
    if (!result.ok) throw new Error("preview failed");
    const keys = Object.keys(JSON.parse(JSON.stringify(result.preview)) as object);
    expect(keys).not.toContain("rights");
    expect(keys).not.toContain("rightsBasis");
    expect(keys).not.toContain("allowLoopback");
    expect(keys).not.toContain("baseUrl");
  });
});
