import { describe, expect, it } from "vitest";
import { parseHlsLadder } from "./hls";
import { DEFAULT_INSPECTION_LIMITS } from "./inspect";
import { permissiveEgress, renderHlsMaster, testClassifyHost, variant } from "./testing/fixtures";
import { INSPECTED_FACTS, type ManifestParseContext } from "./types";

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const context: ManifestParseContext = {
  observedAt: OBSERVED_AT,
  baseUrl: "https://cdn.example.test/media/master.m3u8",
  egress: permissiveEgress,
  classifyHost: testClassifyHost,
  maxRenditions: DEFAULT_INSPECTION_LIMITS.maxRenditions
};

const unpolicedContext: ManifestParseContext = {
  observedAt: OBSERVED_AT,
  baseUrl: null,
  egress: null,
  classifyHost: null,
  maxRenditions: DEFAULT_INSPECTION_LIMITS.maxRenditions
};

describe("the whole ladder comes back, not one variant", () => {
  it("returns every #EXT-X-STREAM-INF, ordered by declared bandwidth", () => {
    const text = renderHlsMaster([
      variant({ bandwidthBps: 5_000_000, width: 1920, height: 1080, uri: "v/1080.m3u8" }),
      variant({ bandwidthBps: 800_000, width: 640, height: 360, uri: "v/360.m3u8" }),
      variant({ bandwidthBps: 2_400_000, width: 1280, height: 720, uri: "v/720.m3u8" })
    ]);

    const { renditions } = parseHlsLadder(text, context);

    expect(renditions).toHaveLength(3);
    expect(renditions.map((rendition) => rendition.bandwidthBps)).toEqual([800_000, 2_400_000, 5_000_000]);
    expect(renditions.map((rendition) => rendition.height)).toEqual([360, 720, 1080]);
  });

  it("resolves each variant URI against the manifest URL and reports it as needing revalidation", () => {
    const text = renderHlsMaster([variant({ uri: "v/720.m3u8" })]);
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.location.kind).toBe("declared");
    if (rendition?.location.kind !== "declared") return;
    expect(rendition.location.declaredUri).toBe("v/720.m3u8");
    expect(rendition.location.resolvedUrl).toBe("https://cdn.example.test/media/v/720.m3u8");
    // Not a clearance. Whoever fetches it re-runs the full gate at that moment,
    // because a DNS answer taken now is not the answer taken then.
    expect(rendition.location.verdict).toEqual({ allowed: true, obligation: "revalidate_before_fetch" });
  });

  it("emits no usable URL at all when no policy was supplied", () => {
    const text = renderHlsMaster([variant({ uri: "https://cdn.example.test/v/720.m3u8" })]);
    const [rendition] = parseHlsLadder(text, unpolicedContext).renditions;

    if (rendition?.location.kind !== "declared") throw new Error("expected a declared location");
    expect(rendition.location.resolvedUrl).toBeNull();
    expect(rendition.location.verdict).toEqual({ allowed: false, reason: "not_evaluated" });
  });
});

describe("a variant URI is untrusted input and goes back through the policy", () => {
  it.each([
    ["javascript:alert(1)", "url_scheme_not_allowed"],
    ["file:///etc/passwd", "url_scheme_not_allowed"],
    ["http://169.254.169.254/latest/meta-data/", "url_host_private_literal"],
    ["https://evil.test/v/720.m3u8", "url_host_not_on_egress_allowlist"]
  ])("refuses %s with %s and publishes no resolved URL", (uri, reason) => {
    const [rendition] = parseHlsLadder(renderHlsMaster([variant({ uri })]), context).renditions;

    if (rendition?.location.kind !== "declared") throw new Error("expected a declared location");
    expect(rendition.location.resolvedUrl).toBeNull();
    expect(rendition.location.verdict).toEqual({ allowed: false, reason });
    // The refused URI is still reported verbatim: a consumer building a reason
    // trail needs to know what was offered, and this field is data rather than a
    // log line.
    expect(rendition.location.declaredUri).toBe(uri);
  });
});

describe("unknown stays unknown", () => {
  it("reports an omitted RESOLUTION as null rather than deriving one from bandwidth", () => {
    const text = renderHlsMaster([variant({ width: null, height: null, bandwidthBps: 5_000_000 })]);
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.width).toBeNull();
    expect(rendition?.height).toBeNull();
    expect(rendition?.unknownFacts).toEqual(["width", "height"]);
    expect(rendition?.mediaEvidence.height).toBeUndefined();
    // Silence is not malformation.
    expect(rendition?.unreadableDeclarations).toEqual([]);
  });

  it("reports an omitted CODECS as null rather than reading the file extension", () => {
    const text = renderHlsMaster([variant({ codecs: null, uri: "v/720.mp4" })]);
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.videoCodec).toBeNull();
    expect(rendition?.videoCodecDeclared).toBeNull();
    expect(rendition?.audioCodec).toBeNull();
    expect(rendition?.unknownFacts).toContain("videoCodec");
    expect(rendition?.unknownFacts).toContain("audioCodec");
  });

  it("reports an omitted FRAME-RATE as null", () => {
    const text = renderHlsMaster([variant({ frameRate: null })]);
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.frameRate).toBeNull();
    expect(rendition?.unknownFacts).toContain("frameRate");
  });

  it("keeps unknownFacts and mediaEvidence as exact complements", () => {
    const text = renderHlsMaster([variant({ frameRate: null, width: null, height: null })]);
    const [rendition] = parseHlsLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    const stated = Object.keys(rendition.mediaEvidence);
    expect([...stated, ...rendition.unknownFacts].sort()).toEqual([...INSPECTED_FACTS].sort());
    for (const fact of rendition.unknownFacts) expect(stated).not.toContain(fact);
  });
});

describe("provenance says a manifest declared it, not that we measured it", () => {
  it("labels every stated fact manifest_declared and cites the tag it came from", () => {
    const text = renderHlsMaster([variant()]);
    const [rendition] = parseHlsLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    expect(rendition.mediaEvidence.bandwidthBps).toEqual({
      source: "manifest_declared",
      observedAt: OBSERVED_AT,
      detail: "#EXT-X-STREAM-INF:BANDWIDTH"
    });
    expect(rendition.mediaEvidence.height?.detail).toBe("#EXT-X-STREAM-INF:RESOLUTION");
    expect(rendition.mediaEvidence.videoCodec?.detail).toBe("#EXT-X-STREAM-INF:CODECS");
    // Never "probe". The distinction is the point of the package.
    for (const fact of INSPECTED_FACTS) {
      expect(rendition.mediaEvidence[fact]?.source ?? "manifest_declared").toBe("manifest_declared");
    }
  });

  it("keeps the raw RFC 6381 identifier beside the vocabulary value", () => {
    const text = renderHlsMaster([variant({ codecs: "avc1.640028,mp4a.40.2" })]);
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.videoCodec).toBe("h264");
    // The profile and level are the part the four-value enum cannot express, and
    // the part a later capability check needs.
    expect(rendition?.videoCodecDeclared).toBe("avc1.640028");
    expect(rendition?.audioCodec).toBe("aac");
    expect(rendition?.audioCodecDeclared).toBe("mp4a.40.2");
  });
});

describe("malformed and hostile manifests are handled rather than thrown", () => {
  it("treats a non-numeric BANDWIDTH as unreadable, not as a number", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=fast,RESOLUTION=1280x720,CODECS="avc1.4d401f"',
      "v/720.m3u8",
      ""
    ].join("\n");

    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.bandwidthBps).toBeNull();
    expect(rendition?.unknownFacts).toContain("bandwidthBps");
    // The difference between a terse publisher and a broken one.
    expect(rendition?.unreadableDeclarations).toEqual(["BANDWIDTH"]);
    expect(rendition?.height).toBe(720);
  });

  it("treats a half-written RESOLUTION as one fact and one malformed declaration", () => {
    const text = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x", "v/x.m3u8", ""].join("\n");
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.width).toBe(1920);
    expect(rendition?.height).toBeNull();
    expect(rendition?.unreadableDeclarations).toEqual(["RESOLUTION"]);
  });

  it("refuses a negative or zero geometry rather than passing it downstream", () => {
    const text = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=0,RESOLUTION=0x0", "v/x.m3u8", ""].join("\n");
    const [rendition] = parseHlsLadder(text, context).renditions;

    expect(rendition?.bandwidthBps).toBeNull();
    expect(rendition?.width).toBeNull();
    expect(rendition?.height).toBeNull();
  });

  it("does not mistake an inherited property for a declared attribute", () => {
    // `m3u8-parser` writes publisher-chosen keys straight onto a plain object,
    // so a prototype-chain read would report `constructor` and `toString` as
    // declared attributes on every manifest ever written.
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:constructor=1,__proto__=polluted,toString=x",
      "v/x.m3u8",
      ""
    ].join("\n");

    const parsed = parseHlsLadder(text, context);
    expect(parsed.renditions).toHaveLength(1);
    expect(parsed.renditions[0]?.unknownFacts).toEqual([...INSPECTED_FACTS]);
    expect(parsed.renditions[0]?.unreadableDeclarations).toEqual([]);
  });

  it("survives an attribute list the parser itself chokes on", () => {
    /*
     * `m3u8-parser`'s attribute-list splitter assumes every fragment contains an
     * `=` and calls `.slice(1)` on the result of an `exec` that returns `null`
     * when it does not -- so `#EXT-X-STREAM-INF:garbage` makes the library throw
     * a TypeError from inside `push()`. That is the whole reason the parse is
     * wrapped: an unexpected throw on hostile input is the shape a parser CVE
     * takes, and it must be an outcome with a reason rather than an exception
     * escaping into a playback request.
     */
    const text = ["#EXTM3U", "#EXT-X-STREAM-INF:garbage", "v/x.m3u8", ""].join("\n");

    expect(() => parseHlsLadder(text, context)).not.toThrow();
    const parsed = parseHlsLadder(text, context);
    expect(parsed.renditions.length + parsed.reasons.length).toBeGreaterThan(0);
  });

  it("returns an empty ladder with a reason for a media playlist, and does not throw", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-VERSION:3",
      "#EXTINF:6.0,",
      "segment0.ts",
      "#EXTINF:6.0,",
      "segment1.ts",
      "#EXT-X-ENDLIST",
      ""
    ].join("\n");

    const parsed = parseHlsLadder(text, context);
    expect(parsed.renditions).toEqual([]);
    expect(parsed.reasons.map((reason) => reason.code)).toEqual(["media_playlist_declares_no_ladder"]);
  });

  it.each([[""], ["not a manifest at all"], ["#EXTM3U"], ["#EXTM3U\n#EXT-X-STREAM-INF:\n"]])(
    "returns a reasoned empty ladder for %j rather than throwing",
    (text) => {
      const parsed = parseHlsLadder(text, context);
      expect(parsed.renditions).toEqual([]);
      expect(parsed.reasons.length).toBeGreaterThan(0);
    }
  );

  it("drops a #EXT-X-STREAM-INF with no URI entirely rather than reporting a rung with none", () => {
    // The behaviour `RenditionLocation.not_declared` used to be documented as
    // producing. `m3u8-parser` appends a playlist only from its `uri` handler
    // and emits no `uri` event for a blank line, so the tag yields NO entry --
    // which is why that member is a fallback for a different parser rather than
    // a description of this one. Pinned so the doc and the library cannot drift
    // apart silently again.
    const text = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=100", "", "#EXT-X-STREAM-INF:BANDWIDTH=200", "v/b.m3u8", ""].join(
      "\n"
    );

    const parsed = parseHlsLadder(text, context);

    // Two tags, one URI, one rung -- and that rung's location is `declared`.
    // The URI-less tag contributed nothing, rather than contributing a rung
    // whose location is `not_declared`.
    expect(parsed.renditions).toHaveLength(1);
    expect(parsed.renditions.map((rendition) => rendition.location.kind)).toEqual(["declared"]);
  });
});

describe("a ladder larger than the cap is refused before it is built", () => {
  function ladderOf(count: number) {
    return Array.from({ length: count }, (_unused, index) =>
      variant({ bandwidthBps: 400_000 * (index + 1), uri: `v/${index}.m3u8` })
    );
  }

  it("refuses on the declared count and constructs no rungs at all", () => {
    const parsed = parseHlsLadder(renderHlsMaster(ladderOf(5)), { ...context, maxRenditions: 4 });

    // Not a truncated ladder, and not a full one that was then rejected:
    // nothing was constructed. The cap exists so that a publisher cannot choose
    // how much CPU this process spends, and a refusal issued after five rungs
    // were built and sorted would not have bounded anything.
    expect(parsed.renditions).toEqual([]);
    expect(parsed.reasons).toEqual([
      { code: "too_many_renditions", detail: "5 declared renditions exceeds the cap of 4" }
    ]);
  });

  it("counts what the publisher declared, not what would survive collapsing", () => {
    // Eight identical variants canonicalise to one rung. A cap applied to the
    // parsed ladder would therefore report this as a one-rung success -- having
    // already done all of the work the cap is there to bound.
    const parsed = parseHlsLadder(renderHlsMaster(Array.from({ length: 8 }, () => variant())), {
      ...context,
      maxRenditions: 4
    });

    expect(parsed.renditions).toEqual([]);
    expect(parsed.reasons[0]?.code).toBe("too_many_renditions");
    expect(parsed.reasons[0]?.detail).toContain("8 declared");
  });

  it("admits a ladder exactly at the cap, so the boundary is not off by one", () => {
    const parsed = parseHlsLadder(renderHlsMaster(ladderOf(4)), { ...context, maxRenditions: 4 });

    expect(parsed.renditions).toHaveLength(4);
    expect(parsed.reasons).toEqual([]);
  });
});
