import { describe, expect, it } from "vitest";
import type { CatalogItemRef, ProviderContext } from "../provider";
import { createStremioProvider, declaredStreamTypes, parseStremioItemId } from "./client";
import type { FetchLike } from "./http";
import { defineStremioSource, type AuthorizedStremioSource } from "./source";

const MANIFEST_URL = "https://archive.example.com/manifest.json";
const STREAM_URL = "https://archive.example.com/stream/movie/tt0111161.json";

const manifestBody = {
  id: "org.archive.public-domain",
  version: "1.0.0",
  name: "Public Domain Archive",
  resources: ["catalog", "stream"],
  types: ["movie"],
  catalogs: []
};

/**
 * The only way to obtain an `AuthorizedStremioSource` is the rights gate, in the
 * tests as much as in production -- there is no exported constructor to forge
 * one with, which is the point of the brand.
 */
function makeSource(over: Record<string, unknown> = {}): AuthorizedStremioSource {
  const result = defineStremioSource({
    id: "archive",
    manifestUrl: MANIFEST_URL,
    rights: "public-domain",
    rightsBasis: "US public domain catalogue, verified 2026-01",
    ...over
  });
  if (!result.ok) throw new Error(`fixture source rejected: ${result.reason} (${result.detail})`);
  return result.source;
}

const item: CatalogItemRef = {
  providerId: "archive",
  externalId: "movie/tt0111161",
  rights: "public-domain"
};

const requestContext: ProviderContext = { requestId: "req-1", profileId: "profile-secret-42" };

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

interface Stub {
  readonly fetch: FetchLike;
  readonly calls: Array<{ url: string; headers: Record<string, string> }>;
}

/** Routes by exact URL; anything unrouted answers 404, as a stranger would. */
function stubFetch(routes: Record<string, () => Response | Promise<Response>>): Stub {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, string>)) headers[key] = value;
    }
    calls.push({ url, headers });
    const route = routes[url];
    return route ? route() : new Response("no such route", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

const frozenClock = (): (() => number) => () => 1_700_000_000_000;

const steppingClock = (step: number): (() => number) => {
  let value = 1_700_000_000_000;
  return () => (value += step);
};

describe("resolving candidates end to end", () => {
  it("returns candidates carrying the source's declared rights", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () =>
        json({
          streams: [
            { url: "https://cdn.example.com/film.mp4", name: "Archive", title: "1080p" },
            { url: "https://cdn.example.com/film.m3u8", name: "Archive HLS" }
          ]
        })
    });

    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    const resolution = await provider.resolve(item, requestContext);

    expect(resolution.reason).toBe("resolved");
    expect(resolution.candidates).toHaveLength(2);
    expect(resolution.candidates.every((candidate) => candidate.rights === "public-domain")).toBe(true);
    expect(resolution.candidates.every((candidate) => candidate.providerId === "archive")).toBe(true);
    expect(resolution.candidates.map((candidate) => candidate.protocol)).toEqual(["https", "hls"]);
    expect(resolution.rightsBasis).toContain("public domain");
    // Two successful requests, no failures: Laplace, not a flattering constant.
    expect(resolution.candidates[0]?.healthScore).toBe(0.75);
  });

  it("measures latency instead of asserting one", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [{ url: "https://cdn.example.com/film.mp4" }] })
    });

    const frozen = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    const moving = createStremioProvider(makeSource(), { fetch: stub.fetch, now: steppingClock(50) });

    const stopped = await frozen.resolve(item, requestContext);
    const running = await moving.resolve(item, requestContext);

    // With a stopped clock the honest answer is zero. A hard-coded default would
    // report the same number under both clocks.
    expect(stopped.candidates[0]?.estimatedLatencyMs).toBe(0);
    expect(running.candidates[0]?.estimatedLatencyMs).toBeGreaterThan(0);
  });

  it("never sends the viewer's profile or request id to the addon", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [] })
    });

    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    await provider.resolve(item, requestContext);

    const serialised = JSON.stringify(stub.calls);
    expect(serialised).not.toContain("profile-secret-42");
    expect(serialised).not.toContain("req-1");
    expect(stub.calls[0]?.headers["accept"]).toBe("application/json");
  });

  it("caches the manifest between resolutions but not the stream lookup", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [{ url: "https://cdn.example.com/film.mp4" }] })
    });

    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    await provider.resolve(item, requestContext);
    await provider.resolve(item, requestContext);

    expect(stub.calls.filter((call) => call.url === MANIFEST_URL)).toHaveLength(1);
    expect(stub.calls.filter((call) => call.url === STREAM_URL)).toHaveLength(2);
  });

  it("reports a health probe from a fresh manifest fetch, never from cache", async () => {
    const stub = stubFetch({ [MANIFEST_URL]: () => json(manifestBody) });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: steppingClock(5) });

    expect(await provider.health()).toEqual({ ok: true, latencyMs: expect.any(Number) });
    await provider.health();
    expect(stub.calls).toHaveLength(2);
  });
});

describe("nothing indirect is ever fetched", () => {
  it("refuses torrent and magnet streams and requests neither", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () =>
        json({
          streams: [
            { infoHash: "0123456789abcdef0123456789abcdef01234567", fileIdx: 0, name: "1080p torrent" },
            { url: "magnet:?xt=urn:btih:0123456789abcdef", name: "magnet" },
            { ytId: "dQw4w9WgXcQ", name: "youtube" },
            { url: "http://169.254.169.254/latest/meta-data/", name: "metadata service" }
          ]
        })
    });

    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    const resolution = await provider.resolve(item, requestContext);

    expect(resolution.candidates).toEqual([]);
    expect(resolution.reason).toBe("no_playable_streams");
    expect(resolution.rejected.map((entry) => entry.reason)).toEqual([
      "torrent_source_unsupported",
      "magnet_source_unsupported",
      "youtube_id_unsupported",
      "url_private_address"
    ]);
    // Only the manifest and the stream endpoint were contacted. Nothing was
    // resolved, unlocked, or looked up on behalf of a refused stream.
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL, STREAM_URL]);
  });

  it("reports an empty stream list distinctly from an unplayable one", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [] })
    });

    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    expect((await provider.resolve(item, requestContext)).reason).toBe("no_streams_offered");
  });
});

describe("malformed and hostile responses are handled, never thrown", () => {
  it("handles a manifest that does not match the protocol", async () => {
    const stub = stubFetch({ [MANIFEST_URL]: () => json({ id: 5, version: null }) });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("manifest_unavailable");
    expect(resolution.detail).toContain("malformed_manifest");
    expect(resolution.candidates).toEqual([]);
  });

  it("handles a manifest that is not JSON at all", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => new Response("<html>upstream proxy error</html>", { status: 200 })
    });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("manifest_unavailable");
    expect(resolution.detail).toContain("malformed_json");
  });

  it("handles a stream response whose shape is wrong", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: { url: "https://cdn.example.com/film.mp4" } })
    });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("stream_request_failed");
    expect(resolution.detail).toContain("malformed stream response");
  });

  it("handles an error status", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => new Response("nope", { status: 503 })
    });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("stream_request_failed");
    expect(resolution.detail).toContain("http_status");
  });

  it("gives up on an addon that never answers", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
        });
      });

    const provider = createStremioProvider(makeSource(), { fetch: hanging, timeoutMs: 20 });
    const resolution = await provider.resolve(item, requestContext);

    expect(resolution.reason).toBe("manifest_unavailable");
    expect(resolution.detail).toContain("timeout");
  });

  it("abandons a response that exceeds the size cap", async () => {
    const stub = stubFetch({ [MANIFEST_URL]: () => json(manifestBody) });
    const provider = createStremioProvider(makeSource(), {
      fetch: stub.fetch,
      maxResponseBytes: 16,
      now: frozenClock()
    });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("manifest_unavailable");
    expect(resolution.detail).toContain("response_too_large");
  });
});

describe("redirects are re-validated, not followed blindly", () => {
  it("refuses a redirect into the private network", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () =>
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/manifest.json" } })
    });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("manifest_unavailable");
    expect(resolution.detail).toContain("url_private_address");
    // The redirect target was never contacted.
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL]);
  });

  it("follows a permitted redirect", async () => {
    const moved = "https://cdn.archive.example.com/manifest.json";
    const stub = stubFetch({
      [MANIFEST_URL]: () => new Response(null, { status: 301, headers: { location: moved } }),
      [moved]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [{ url: "https://cdn.example.com/film.mp4" }] })
    });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("resolved");
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL, moved, STREAM_URL]);
  });

  it("stops following a redirect loop", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => new Response(null, { status: 302, headers: { location: MANIFEST_URL } })
    });
    const provider = createStremioProvider(makeSource(), {
      fetch: stub.fetch,
      maxRedirects: 2,
      now: frozenClock()
    });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.detail).toContain("too_many_redirects");
    expect(stub.calls).toHaveLength(3);
  });
});

describe("the item and the source must agree", () => {
  it("refuses an item routed to another provider", async () => {
    const stub = stubFetch({ [MANIFEST_URL]: () => json(manifestBody) });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve({ ...item, providerId: "somewhere-else" }, requestContext);
    expect(resolution.reason).toBe("item_provider_mismatch");
    expect(stub.calls).toEqual([]);
  });

  it("refuses to choose between two disagreeing rights claims", async () => {
    const stub = stubFetch({ [MANIFEST_URL]: () => json(manifestBody) });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve({ ...item, rights: "licensed" }, requestContext);
    expect(resolution.reason).toBe("item_rights_conflict");
    expect(resolution.candidates).toEqual([]);
    // Not one request was made: the disagreement is fatal before any I/O.
    expect(stub.calls).toEqual([]);
  });

  it("skips a request the manifest says the addon cannot answer", async () => {
    const stub = stubFetch({ [MANIFEST_URL]: () => json(manifestBody) });
    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });

    const resolution = await provider.resolve({ ...item, externalId: "series/tt1254207:1:1" }, requestContext);
    expect(resolution.reason).toBe("item_not_served_by_source");
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL]);
  });

  it("infers the type only when the manifest leaves no ambiguity", async () => {
    const ambiguous = stubFetch({
      [MANIFEST_URL]: () => json({ ...manifestBody, types: ["movie", "series"] })
    });
    const ambiguousProvider = createStremioProvider(makeSource(), {
      fetch: ambiguous.fetch,
      now: frozenClock()
    });
    const unresolved = await ambiguousProvider.resolve({ ...item, externalId: "tt0111161" }, requestContext);
    expect(unresolved.reason).toBe("item_type_ambiguous");

    // A bad id is a different fault from an ambiguous one, and says so.
    const malformed = await ambiguousProvider.resolve({ ...item, externalId: "../admin" }, requestContext);
    expect(malformed.reason).toBe("item_id_malformed");

    const single = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [{ url: "https://cdn.example.com/film.mp4" }] })
    });
    const singleProvider = createStremioProvider(makeSource(), { fetch: single.fetch, now: frozenClock() });
    const resolved = await singleProvider.resolve({ ...item, externalId: "tt0111161" }, requestContext);
    expect(resolved.reason).toBe("resolved");
  });
});

describe("item id parsing", () => {
  it("splits an explicit type prefix", () => {
    expect(parseStremioItemId("movie/tt0111161", [])).toEqual({ type: "movie", id: "tt0111161" });
    // Series ids carry their own colon-separated structure, which survives.
    expect(parseStremioItemId("series/tt1254207:1:1", [])).toEqual({
      type: "series",
      id: "tt1254207:1:1"
    });
  });

  it("refuses ids that would build a surprising URL", () => {
    expect(parseStremioItemId("/etc/passwd", ["movie"])).toBeNull();
    expect(parseStremioItemId("../../admin/x", ["movie"])).toBeNull();
    expect(parseStremioItemId("", ["movie"])).toBeNull();
    expect(parseStremioItemId("tt1", ["movie", "series"])).toBeNull();
  });

  it("reads declared stream types from the resource entry when it narrows them", () => {
    expect(
      declaredStreamTypes({
        id: "a",
        version: "1",
        name: "a",
        types: ["movie", "series", "tv"],
        resources: [{ name: "stream", types: ["movie"] }],
        catalogs: []
      })
    ).toEqual(["movie"]);
  });
});

describe("resolveAuthorizedCandidates", () => {
  it("returns only the candidates, with the trail available separately", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () =>
        json({
          streams: [
            { url: "https://cdn.example.com/film.mp4" },
            { infoHash: "0123456789abcdef0123456789abcdef01234567" }
          ]
        })
    });

    const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    const candidates = await provider.resolveAuthorizedCandidates(item, requestContext);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rights).toBe("public-domain");
  });
});
