import { describe, expect, it } from "vitest";
import type { CatalogItemRef, ProviderContext } from "../provider";
import { createStremioProvider, declaredStreamTypes, parseStremioItemId } from "./client";
import type { FetchLike } from "./http";
import { stableStreamKey } from "./mapping";
import {
  defineStremioSource,
  type AuthorizedStremioSource,
  type DeploymentContext
} from "./source";

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
function makeSource(
  over: Record<string, unknown> = {},
  deployment: DeploymentContext = {}
): AuthorizedStremioSource {
  const result = defineStremioSource(
    {
      id: "archive",
      manifestUrl: MANIFEST_URL,
      rights: "public-domain",
      rightsBasis: {
        rights: "public-domain",
        basis: "public-domain-determination",
        reference: "US public domain catalogue, verified 2026-01"
      },
      ...over
    },
    deployment
  );
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
  it("returns normalized authorized candidates that state what they do not know", async () => {
    /*
     * PL-0301's acceptance criterion, end to end. Two playable public-domain
     * URLs become two normalized candidates carrying the operator's declared
     * rights -- and `null` for every media fact the Stremio protocol does not
     * supply, rather than the 480/3600/h264/aac placeholders that used to make
     * an unmeasured stream look measured, or the blanket refusal that replaced
     * them and left this adapter unable to return anything at all.
     */
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
    expect(resolution.rejected).toEqual([]);
    expect(resolution.candidates).toHaveLength(2);

    for (const candidate of resolution.candidates) {
      expect(candidate.providerId).toBe("archive");
      // The operator's declaration, copied. Nothing in the response influenced it.
      expect(candidate.rights).toBe("public-domain");
      expect(candidate.videoCodec).toBeNull();
      expect(candidate.audioCodec).toBeNull();
      expect(candidate.height).toBeNull();
      expect(candidate.bitrateKbps).toBeNull();
      // Measured, not defaulted: a stopped clock gives 0, and health starts at
      // the floor plus the manifest fetch this resolution already made.
      expect(candidate.estimatedLatencyMs).toBe(0);
      expect(candidate.healthScore).toBeCloseTo(0.75, 4);
    }

    // Delivery IS stated by the URL, so it is read rather than left unknown.
    const byId = new Map(resolution.candidates.map((candidate) => [candidate.id, candidate] as const));
    expect(byId.get(`archive:${stableStreamKey("https://cdn.example.com/film.mp4")}`)?.protocol).toBe(
      "https"
    );
    expect(byId.get(`archive:${stableStreamKey("https://cdn.example.com/film.m3u8")}`)?.protocol).toBe(
      "hls"
    );

    expect(resolution.mapped.map((entry) => entry.unknownFacts)).toEqual([
      ["videoCodec", "audioCodec", "height", "bitrateKbps"],
      ["videoCodec", "audioCodec", "height", "bitrateKbps"]
    ]);
    expect(resolution.detail).toContain("2 playable of 2 offered, 2 with unstated media facts");
    expect(resolution.detail).toContain("public-domain via public-domain-determination");
    expect(resolution.rights).toBe("public-domain");
    expect(resolution.rightsBasis).toEqual({
      rights: "public-domain",
      basis: "public-domain-determination",
      reference: "US public domain catalogue, verified 2026-01"
    });
  });

  it("returns candidates in an order the addon cannot choose", async () => {
    /*
     * The same two streams, listed the other way round, resolve to an identical
     * candidate list. Preserving the addon's order would hand its own preference
     * to anything that reads `candidates[0]`, and would make two runs of the
     * same resolution diff as different outcomes.
     */
    const streams = [
      { url: "https://cdn.example.com/film.mp4", name: "Archive" },
      { url: "https://cdn.example.com/film.m3u8", name: "Archive HLS" }
    ];

    const resolve = async (order: typeof streams) => {
      const stub = stubFetch({
        [MANIFEST_URL]: () => json(manifestBody),
        [STREAM_URL]: () => json({ streams: order })
      });
      const provider = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
      return provider.resolve(item, requestContext);
    };

    const forwards = await resolve(streams);
    const backwards = await resolve([...streams].reverse());

    expect(backwards.candidates).toEqual(forwards.candidates);
    expect(backwards.mapped).toEqual(forwards.mapped);
    expect(backwards.rejected).toEqual(forwards.rejected);
    expect(backwards.detail).toEqual(forwards.detail);
  });

  it("measures elapsed time instead of asserting one", async () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [{ url: "https://cdn.example.com/film.mp4" }] })
    });

    const frozen = createStremioProvider(makeSource(), { fetch: stub.fetch, now: frozenClock() });
    const moving = createStremioProvider(makeSource(), { fetch: stub.fetch, now: steppingClock(50) });

    const stopped = await frozen.resolve(item, requestContext);
    const running = await moving.resolve(item, requestContext);

    // With a stopped clock the honest answer is zero. A hard-coded default would
    // report the same number under both clocks, and so would a candidate whose
    // `estimatedLatencyMs` was a placeholder rather than a measurement.
    expect(stopped.elapsedMs).toBe(0);
    expect(running.elapsedMs).toBeGreaterThan(0);
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
    // Ordered by ref, not by the addon: `(info hash)`, `(youtube id)`, then the
    // two whose refs start with their scheme.
    expect(resolution.rejected.map((entry) => entry.reason)).toEqual([
      "torrent_source_unsupported",
      "youtube_id_unsupported",
      "url_private_address",
      "magnet_source_unsupported"
    ]);
    expect(resolution.detail).toBe(
      "magnet_source_unsupported=1 torrent_source_unsupported=1 url_private_address=1 " +
        "youtube_id_unsupported=1"
    );
    // The refused torrent's info hash is named as a kind and never reproduced.
    expect(JSON.stringify(resolution)).not.toContain("0123456789abcdef");
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
    // The redirect was followed, the addon answered, and the stream it offered
    // became a candidate.
    expect(resolution.reason).toBe("resolved");
    expect(resolution.candidates).toHaveLength(1);
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL, moved, STREAM_URL]);
  });

  it("refuses a redirect onto loopback even for a source that opted into it", async () => {
    // `allowLoopback` on the source is not a second chance at the deployment
    // gate. A hosted instance following this redirect would be fetching its own
    // internal port on an addon's instruction.
    const stub = stubFetch({
      [MANIFEST_URL]: () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9200/manifest.json" } })
    });
    const provider = createStremioProvider(makeSource({ allowLoopback: true }), {
      fetch: stub.fetch,
      now: frozenClock()
    });

    const resolution = await provider.resolve(item, requestContext);
    expect(resolution.reason).toBe("manifest_unavailable");
    expect(resolution.detail).toContain("url_loopback_not_local_deployment");
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL]);
  });

  it("follows a redirect onto loopback when the deployment is a local one", async () => {
    // The other half of the same gate: both conditions, and the hop is allowed.
    const moved = "http://127.0.0.1:9200/manifest.json";
    const stub = stubFetch({
      [MANIFEST_URL]: () => new Response(null, { status: 302, headers: { location: moved } }),
      [moved]: () => json(manifestBody)
    });
    const provider = createStremioProvider(
      makeSource({ allowLoopback: true }, { localDeployment: true }),
      { fetch: stub.fetch, now: frozenClock() }
    );

    expect((await provider.health()).ok).toBe(true);
    expect(stub.calls.map((call) => call.url)).toEqual([MANIFEST_URL, moved]);
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
    // The inference succeeded: the unqualified id was addressed as a movie, the
    // addon was asked, and what came back resolved.
    expect(single.calls.map((call) => call.url)).toEqual([MANIFEST_URL, STREAM_URL]);
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

describe("a forged source is refused before a provider exists", () => {
  /*
   * The brand itself cannot be forged -- the symbol is module-private -- but
   * `AuthorizedStremioSource` is exported as a TYPE, so a cast produces a value
   * the compiler accepts and the rights gate never saw. `mapStremioStream`
   * already re-checks the rights VALUE for exactly this reason. Until
   * `createStremioProvider` did the same, the EVIDENCE for those rights was the
   * one thing nobody re-checked: a source without a `rightsBasis` was built into
   * a provider, made both of its requests, and only failed when
   * `describeRightsBasis` read `basis.rights` off `undefined` and threw an
   * uncaught `TypeError` while composing the detail line.
   */
  const forge = (over: Record<string, unknown>): AuthorizedStremioSource =>
    ({ ...makeSource(), ...over }) as unknown as AuthorizedStremioSource;

  it("refuses rights outside the playable allowlist", () => {
    expect(() => createStremioProvider(forge({ rights: "pirated" }))).toThrow(/playable allowlist/);
  });

  it("refuses a source that carries no evidence at all", () => {
    expect(() => createStremioProvider(forge({ rightsBasis: undefined }))).toThrow(/rightsBasis/);
    // Free text is what the structured basis replaced; a cast reintroduces it.
    expect(() => createStremioProvider(forge({ rightsBasis: "we are allowed, honestly" }))).toThrow(
      /rightsBasis/
    );
  });

  it("refuses evidence that classifies itself differently from the source", () => {
    expect(() =>
      createStremioProvider(
        forge({ rightsBasis: { rights: "licensed", basis: "direct-license", reference: "LIC-1" } })
      )
    ).toThrow(/refusing to choose between them/);
  });

  it("refuses a basis the compatibility table does not permit for those rights", () => {
    expect(() =>
      createStremioProvider(
        forge({
          rightsBasis: { rights: "public-domain", basis: "direct-license", reference: "LIC-1" }
        })
      )
    ).toThrow(/cannot rest on/);
  });

  it("refuses a basis with no reference behind it", () => {
    expect(() =>
      createStremioProvider(
        forge({
          rightsBasis: {
            rights: "public-domain",
            basis: "public-domain-determination",
            reference: "   "
          }
        })
      )
    ).toThrow(/reference is empty/);
  });

  it("fails closed at construction, so nothing is ever fetched on its behalf", () => {
    const stub = stubFetch({
      [MANIFEST_URL]: () => json(manifestBody),
      [STREAM_URL]: () => json({ streams: [{ url: "https://cdn.example.com/film.mp4" }] })
    });

    expect(() =>
      createStremioProvider(forge({ rightsBasis: undefined }), {
        fetch: stub.fetch,
        now: frozenClock()
      })
    ).toThrow();
    expect(stub.calls).toEqual([]);
  });

  it("still builds a provider from a source the gate actually produced", () => {
    expect(() => createStremioProvider(makeSource())).not.toThrow();
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
    const resolution = await provider.resolve(item, requestContext);

    // The contract method returns candidates and nothing else, so the refused
    // torrent is invisible through it. That is exactly why `resolve` exists and
    // why every refusal is named there.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rights).toBe("public-domain");
    expect(resolution.rejected.map((entry) => entry.reason)).toEqual(["torrent_source_unsupported"]);
  });
});
