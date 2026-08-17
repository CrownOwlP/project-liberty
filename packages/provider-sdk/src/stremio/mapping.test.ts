import { describe, expect, it } from "vitest";
import { unknownMediaFacts } from "@liberty/contracts";
import {
  deriveProtocol,
  mapStremioStream,
  mapStremioStreams,
  observedHealthScore,
  observeStreamMedia,
  resolveStreamMedia,
  stableStreamKey,
  streamRef,
  streamTarget,
  type KnownMedia,
  type ObservedMedia,
  type StreamMappingContext
} from "./mapping";
import { compareCodePoint } from "./order";
import type { StremioStream } from "./protocol";

const context: StreamMappingContext = {
  sourceId: "archive",
  rights: "public-domain",
  allowLoopback: false,
  localDeployment: false,
  acceptNotWebReady: false,
  observedLatencyMs: 120,
  healthScore: 0.6667
};

/** Both loopback conditions: a source declared local, on a local deployment. */
const local: StreamMappingContext = { ...context, allowLoopback: true, localDeployment: true };

const outcome = (stream: StremioStream, ctx: StreamMappingContext = context): string => {
  const result = mapStremioStream(stream, ctx);
  return result.ok ? "ok" : result.reason;
};

/** A stream with nothing wrong with it except everything the protocol omits. */
const directStream: StremioStream = { url: "https://cdn.example.com/film.mp4" };

/**
 * COMPILE-TIME regression for the null-widening defect, and the sharper half of
 * the two below.
 *
 * `ObservedMedia.videoCodec` and `KnownMedia.videoCodec` were declared as
 * `StreamCandidate["videoCodec"]`, so when PL-0205 made that candidate field
 * nullable both declarations silently widened to admit `null` -- including
 * `KnownMedia`, whose entire job is to promise the opposite. Nothing in the
 * runtime behaviour of the old code changed at that moment, which is exactly why
 * a runtime test alone is not enough to hold the fix: the type is the guarantee.
 *
 * `RefusesNull<T>` resolves to `never` when `T` admits `null`, so each of these
 * assignments stops compiling the moment a media-fact declaration is re-widened.
 * Against the pre-fix declarations all four fail `tsc`, which is the typecheck
 * gate, not a test that has to be run and read.
 */
type RefusesNull<T> = [null] extends [T] ? never : true;

const observedVideoCodecRefusesNull: RefusesNull<ObservedMedia["videoCodec"]> = true;
const observedAudioCodecRefusesNull: RefusesNull<ObservedMedia["audioCodec"]> = true;
const knownVideoCodecRefusesNull: RefusesNull<KnownMedia["videoCodec"]> = true;
const knownAudioCodecRefusesNull: RefusesNull<KnownMedia["audioCodec"]> = true;

describe("unknown media facts are emitted as null, never invented", () => {
  it("produces a real candidate that says what it does not know", () => {
    // The point of the whole task, in one assertion. A playable, public-domain,
    // reachable stream now becomes a candidate -- and every fact the Stremio
    // protocol does not carry arrives as `null`, which is the contract's word
    // for unknown, rather than as 480/3600/h264/aac wearing the shape of a
    // measurement.
    const result = mapStremioStream(directStream, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mapped.candidate).toEqual({
      id: `archive:${stableStreamKey("https://cdn.example.com/film.mp4")}`,
      providerId: "archive",
      rights: "public-domain",
      protocol: "https",
      height: null,
      bitrateKbps: null,
      estimatedLatencyMs: 120,
      healthScore: 0.6667,
      videoCodec: null,
      audioCodec: null
    });
    expect(result.mapped.unknownFacts).toEqual([
      "videoCodec",
      "audioCodec",
      "height",
      "bitrateKbps"
    ]);
  });

  it("emits the same nulls however flattering the addon's own title is", () => {
    // "2160p HDR REMUX" is advertising written by the party being ranked. It did
    // not move `height` when height was a placeholder, it did not create a known
    // resolution when the stream was refused outright, and it does not create
    // one now that unknown is representable.
    const result = mapStremioStream(
      { url: "https://cdn.example.com/a.mp4", title: "2160p HDR REMUX 80GB h264 aac" },
      context
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.mapped.candidate.height).toBeNull();
    expect(result.ok && result.mapped.candidate.videoCodec).toBeNull();
    expect(result.ok && result.mapped.candidate.audioCodec).toBeNull();
    expect(result.ok && result.mapped.candidate.bitrateKbps).toBeNull();
  });

  it("does not read a codec off the container extension either", () => {
    // `.mp4` carries h264, hevc or av1 indifferently, so a filename is the same
    // guess as a title with a more technical-looking hat. Only `protocol` is
    // read from the path, because delivery is what the extension actually
    // states.
    const hls = mapStremioStream({ url: "https://cdn.example.com/master.m3u8" }, context);
    expect(hls.ok && hls.mapped.candidate.protocol).toBe("hls");
    expect(hls.ok && hls.mapped.candidate.videoCodec).toBeNull();

    const mp4 = mapStremioStream(
      { url: "https://cdn.example.com/film.h264.mp4", behaviorHints: { filename: "film.x264.aac.mp4" } },
      context
    );
    expect(mp4.ok && mp4.mapped.candidate.videoCodec).toBeNull();
    expect(mp4.ok && mp4.mapped.candidate.audioCodec).toBeNull();
  });

  it("observes nothing about the media from any field the protocol offers", () => {
    expect(observeStreamMedia(directStream)).toEqual({});
    expect(
      observeStreamMedia({
        url: "https://cdn.example.com/film.mp4",
        name: "1080p",
        title: "H.264 / AAC 5.1",
        // A file size is not a bitrate without a duration, and no field carries
        // a duration.
        behaviorHints: { videoSize: 4_294_967_296, filename: "film.1080p.x264.mp4" }
      })
    ).toEqual({});
  });

  it("passes stated observations through unchanged", () => {
    // The day a probe can genuinely answer one of these, this is the path it
    // takes: the value is carried, not re-derived and not rounded.
    expect(
      resolveStreamMedia({
        videoCodec: "hevc",
        audioCodec: "opus",
        height: 2160,
        bitrateKbps: 16_200
      })
    ).toEqual({ videoCodec: "hevc", audioCodec: "opus", height: 2160, bitrateKbps: 16_200 });
  });

  it("reports an absent observation as null, one fact at a time", () => {
    const complete: ObservedMedia = {
      videoCodec: "h264",
      audioCodec: "aac",
      height: 1080,
      bitrateKbps: 8100
    };

    expect(unknownMediaFacts(resolveStreamMedia(complete))).toEqual([]);
    expect(unknownMediaFacts(resolveStreamMedia({ ...complete, videoCodec: undefined }))).toEqual([
      "videoCodec"
    ]);
    expect(unknownMediaFacts(resolveStreamMedia({ ...complete, height: undefined }))).toEqual([
      "height"
    ]);
    // In `MEDIA_FACTS` order, taken from the contract rather than assembled
    // here, so this list cannot disagree with the one media-engine publishes.
    expect(unknownMediaFacts(resolveStreamMedia({}))).toEqual([
      "videoCodec",
      "audioCodec",
      "height",
      "bitrateKbps"
    ]);
  });
});

describe("an unknown is never laundered into a known", () => {
  it("refuses null in the observation and known-media types", () => {
    // The compile-time half. These four constants only typecheck while the
    // declarations refuse `null`; see `RefusesNull` above for what re-widening
    // them breaks and why a runtime assertion cannot cover it.
    expect([
      observedVideoCodecRefusesNull,
      observedAudioCodecRefusesNull,
      knownVideoCodecRefusesNull,
      knownAudioCodecRefusesNull
    ]).toEqual([true, true, true, true]);
  });

  it("treats a null observation as unknown rather than as a stated fact", () => {
    /*
     * The runtime half, and a regression against the exact defect: the boundary
     * used to test `=== undefined` only, so a `null` observation -- which the
     * widened type quietly permitted -- was carried through as though someone
     * had measured it, into a shape that promises knownness.
     *
     * The cast is the point of the test. It forges an observation the current
     * types make unconstructible, which is how a value would actually arrive
     * here: from a future probe parsing JSON, or from a JavaScript caller.
     */
    const laundered = {
      videoCodec: null,
      audioCodec: "aac",
      height: null,
      bitrateKbps: 8100
    } as unknown as ObservedMedia;

    expect(resolveStreamMedia(laundered)).toEqual({
      videoCodec: null,
      audioCodec: "aac",
      height: null,
      bitrateKbps: 8100
    });
    expect(unknownMediaFacts(resolveStreamMedia(laundered))).toEqual(["videoCodec", "height"]);
  });

  it("does not turn a stated but invalid observation into an unknown", () => {
    // A probe reporting `height: 0` is broken, and answering "we have no idea"
    // on its behalf would hide the break behind a legitimate-looking value. The
    // 0 is carried, is not counted as an unknown fact, and is caught downstream
    // by `streamCandidateSchema`, which names the field.
    const zeroHeight = resolveStreamMedia({ height: 0 });
    expect(zeroHeight.height).toBe(0);
    expect(unknownMediaFacts(zeroHeight)).toEqual(["videoCodec", "audioCodec", "bitrateKbps"]);
  });
});

describe("rights fail closed", () => {
  it("emits nothing when the context's rights are not on the allowlist", () => {
    // Deliberately bypasses the type, simulating a forged or corrupted context.
    const forged = { ...context, rights: "unlicensed" as never };
    expect(outcome(directStream, forged)).toBe("rights_not_playable");
  });

  it("checks rights before anything technical about the stream", () => {
    const forged = { ...context, rights: "pirated" as never };
    expect(outcome({ infoHash: "0123456789abcdef0123456789abcdef01234567" }, forged)).toBe(
      "rights_not_playable"
    );
  });

  it("copies the declared rights onto the candidate, whichever they are", () => {
    for (const rights of ["licensed", "owned", "public-domain"] as const) {
      const result = mapStremioStream(directStream, { ...context, rights });
      expect(result.ok && result.mapped.candidate.rights).toBe(rights);
    }
    expect(outcome(directStream, { ...context, rights: "pirated" as never })).toBe(
      "rights_not_playable"
    );
  });
});

describe("non-playable sources are refused, with a reason that names them", () => {
  it("refuses torrents without ever looking one up", () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    expect(outcome({ infoHash: hash })).toBe("torrent_source_unsupported");
    expect(outcome({ infoHash: hash, fileIdx: 2 })).toBe("torrent_source_unsupported");
    expect(outcome({ fileIdx: 0 })).toBe("torrent_source_unsupported");
    expect(outcome({ sources: ["tracker:udp://tracker.example:1337", "dht:0123"] })).toBe(
      "torrent_source_unsupported"
    );
  });

  it("refuses a torrent even when a direct url is offered alongside it", () => {
    // "Take the url, ignore the hash" is how a torrent resolver gets built one
    // field at a time.
    expect(
      outcome({
        url: "https://cdn.example.com/film.mp4",
        infoHash: "0123456789abcdef0123456789abcdef01234567"
      })
    ).toBe("torrent_source_unsupported");
  });

  it("refuses magnet links", () => {
    expect(outcome({ url: "magnet:?xt=urn:btih:0123456789abcdef" })).toBe("magnet_source_unsupported");
    expect(outcome({ url: "  MAGNET:?xt=urn:btih:0123456789abcdef" })).toBe(
      "magnet_source_unsupported"
    );
  });

  it("refuses sources that would require extraction or a hand-off", () => {
    expect(outcome({ ytId: "dQw4w9WgXcQ" })).toBe("youtube_id_unsupported");
    expect(outcome({ externalUrl: "https://example.com/watch/1" })).toBe("external_url_not_playable");
    expect(outcome({ name: "nothing here" })).toBe("no_playable_url");
    expect(outcome({ url: "   " })).toBe("no_playable_url");
  });

  it("refuses a stream that only plays with replayed request headers", () => {
    // A stream whose origin enforces a Referer is a stream behind an access
    // control, and working around it is what CONTENT_RIGHTS.md forbids.
    expect(
      outcome({
        url: "https://cdn.example.com/film.mp4",
        behaviorHints: { proxyHeaders: { request: { Referer: "https://elsewhere.example" } } }
      })
    ).toBe("proxy_headers_unsupported");
  });

  it("refuses a stream the addon says a browser cannot play, unless the source opted in", () => {
    const stream: StremioStream = {
      url: "https://cdn.example.com/film.mkv",
      behaviorHints: { notWebReady: true }
    };
    expect(outcome(stream)).toBe("stream_not_web_ready");

    const accepted = mapStremioStream(stream, { ...context, acceptNotWebReady: true });
    expect(accepted.ok).toBe(true);
    // The opt-in retires that refusal and nothing else: the stream still states
    // no codec, so the candidate still says so.
    expect(accepted.ok && accepted.mapped.notWebReady).toBe(true);
    expect(accepted.ok && accepted.mapped.candidate.videoCodec).toBeNull();
  });
});

describe("stream URLs go through the same SSRF policy as everything else", () => {
  it("refuses private, loopback and non-http stream URLs", () => {
    expect(outcome({ url: "http://169.254.169.254/latest/meta-data/" })).toBe("url_private_address");
    expect(outcome({ url: "https://10.0.0.5/film.mp4" })).toBe("url_private_address");
    expect(outcome({ url: "http://127.0.0.1:8096/film.mp4" })).toBe("url_loopback_not_permitted");
    expect(outcome({ url: "file:///srv/media/film.mp4" })).toBe("url_scheme_not_http");
    expect(outcome({ url: "https://user:pw@cdn.example.com/film.mp4" })).toBe("url_credentials_present");
  });

  it("refuses a loopback stream URL when only the source opted in", () => {
    // An addon can put any URL in its response. If a source's own opt-in were
    // enough, a hosted Liberty server would fetch its own loopback ports on that
    // addon's say-so.
    const optedInButHosted: StreamMappingContext = { ...context, allowLoopback: true };
    expect(outcome({ url: "http://127.0.0.1:8096/film.mp4" }, optedInButHosted)).toBe(
      "url_loopback_not_local_deployment"
    );
  });

  it("admits a loopback stream URL only when both conditions hold", () => {
    expect(outcome({ url: "http://127.0.0.1:8096/film.mp4" }, local)).toBe("ok");
    // A local deployment is still a statement about THIS machine, never the LAN.
    expect(outcome({ url: "http://10.0.0.5/film.mp4" }, local)).toBe("url_private_address");
  });
});

describe("protocol is derived from the URL, not from the title", () => {
  it("recognises adaptive manifests by extension", () => {
    expect(deriveProtocol(new URL("https://cdn.example.com/a/master.m3u8"))).toBe("hls");
    expect(deriveProtocol(new URL("https://cdn.example.com/a/master.m3u8?token=abc"))).toBe("hls");
    expect(deriveProtocol(new URL("https://cdn.example.com/a/manifest.mpd"))).toBe("dash");
    expect(deriveProtocol(new URL("https://cdn.example.com/a/film.mp4"))).toBe("https");
    expect(deriveProtocol(new URL("https://cdn.example.com/a/HLS/MASTER.M3U8"))).toBe("hls");
  });
});

describe("a refused stream is named by what it is, not by where it sat", () => {
  it("reduces a URL to scheme, host and path", () => {
    expect(streamTarget({ url: "https://cdn.example.com/a.mp4?token=secret#x" })).toBe(
      "https://cdn.example.com/a.mp4"
    );
    expect(streamTarget({ url: "  magnet:?xt=urn:btih:0123456789abcdef" })).toBe("magnet:");
    expect(streamTarget({ url: "not a url" })).toBe("(unparseable url)");
  });

  it("names an indirect source by kind and never reproduces it", () => {
    expect(streamTarget({ infoHash: "0123456789abcdef0123456789abcdef01234567" })).toBe("(info hash)");
    expect(streamTarget({ sources: ["tracker:udp://tracker.example:1337"] })).toBe("(peer sources)");
    expect(streamTarget({ ytId: "dQw4w9WgXcQ" })).toBe("(youtube id)");
    expect(streamTarget({ externalUrl: "https://example.com/watch/1" })).toBe("(external url)");
    expect(streamTarget({ name: "nothing" })).toBe("(no source)");
  });

  it("keeps hashes and signed query strings out of the reason trail entirely", () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    const batch = mapStremioStreams(
      [
        { infoHash: hash, name: "T" },
        {
          url: "https://cdn.example.com/film.mkv?token=super-secret-token",
          name: "MKV",
          behaviorHints: { notWebReady: true }
        }
      ],
      context
    );

    const serialised = JSON.stringify(batch);
    expect(serialised).not.toContain(hash);
    expect(serialised).not.toContain("super-secret-token");
  });

  it("keeps a signed query string out of the trail even when the URL does not parse", () => {
    /*
     * The other half of the case above, and the one that leaked. `streamTarget`
     * reduces a PARSEABLE url to scheme, host and path, so the ref was always
     * clean -- but a protocol-relative url throws in `new URL()`, there is
     * nothing to reduce, and the url-policy `detail` this batch copies into the
     * trail used to be the addon's string echoed back with the token still in
     * it. Every character of that string is chosen by the addon.
     */
    const batch = mapStremioStreams(
      [{ url: "//cdn.example.com/film.mp4?token=super-secret-token", name: "protocol relative" }],
      context
    );

    expect(batch.mapped).toEqual([]);
    expect(batch.rejected.map((entry) => entry.reason)).toEqual(["url_unparseable"]);

    const serialised = JSON.stringify(batch);
    expect(serialised).not.toContain("super-secret-token");
    expect(serialised).not.toContain("cdn.example.com");
  });

  it("carries no positional marker", () => {
    expect(streamRef({ url: "https://cdn.example.com/a.mp4" }, "archive")).toBe(
      "archive:https://cdn.example.com/a.mp4 (untitled)"
    );
    for (const entry of mapStremioStreams([{ ytId: "abc" }, { ytId: "def" }], context).rejected) {
      expect(entry.ref).not.toMatch(/#\d/);
    }
  });
});

describe("mapping is deterministic and order-independent", () => {
  const streams: StremioStream[] = [
    { url: "https://cdn.example.com/b.m3u8", name: "B" },
    { url: "https://cdn.example.com/a.mp4", name: "A" },
    { infoHash: "0123456789abcdef0123456789abcdef01234567", name: "T" },
    { url: "https://cdn.example.com/a.mp4", name: "A, again under another title" },
    { ytId: "dQw4w9WgXcQ", name: "Y" }
  ];

  it("produces an identical result for identical input", () => {
    expect(mapStremioStreams(streams, context)).toEqual(mapStremioStreams(streams, context));
  });

  it("produces an identical result for reversed input", () => {
    /*
     * The whole batch, not merely the candidate list: `mapped`, `rejected`,
     * every `ref`, every `detail` and the surviving entry of the duplicate pair.
     * Anything left order-dependent -- a positional ref, a first-wins
     * deduplication, an unsorted list -- fails here, which is the point.
     */
    expect(mapStremioStreams([...streams].reverse(), context)).toEqual(
      mapStremioStreams(streams, context)
    );
  });

  it("orders both lists by a code-point comparator rather than by the addon", () => {
    const batch = mapStremioStreams(streams, context);

    const ids = batch.mapped.map((entry) => entry.candidate.id);
    expect(ids).toEqual([...ids].sort(compareCodePoint));
    expect(ids).toHaveLength(2);

    const refs = batch.rejected.map((entry) => entry.ref);
    expect(refs).toEqual([...refs].sort(compareCodePoint));
  });

  it("collapses duplicate URLs to the entry that sorts first, not the one that arrived first", () => {
    const batch = mapStremioStreams(streams, context);
    const duplicate = batch.rejected.find((entry) => entry.reason === "duplicate_stream_url");

    expect(duplicate).toBeDefined();
    // "A" sorts before "A, again under another title", so it survives whichever
    // order the addon lists them in -- which is what makes the reversed-input
    // assertion above hold.
    expect(
      batch.mapped.map((entry) => entry.label).includes("A")
    ).toBe(true);
    expect(duplicate?.ref).toContain("A, again under another title");
  });

  /*
   * Three duplicates of one URL, and all six orders they can arrive in.
   *
   * TWO was not enough, which is exactly how the defect survived a regression
   * that looked like it covered this: with two duplicates the incumbent at
   * rejection time is always the eventual survivor, so a fold that names the
   * incumbent and one that names the survivor are indistinguishable. With three
   * they diverge -- [A,B,C] produced two rejections reading "duplicate of A",
   * while [B,C,A] produced one reading "duplicate of B" -- and they diverge in
   * `rejected` while `mapped` stays identical, so an assertion about the
   * surviving candidates cannot see it either. Hence: whole batch, every order.
   */
  const DUPLICATE_URL = "https://cdn.example.com/one-file.mp4";
  const dupA: StremioStream = { url: DUPLICATE_URL, name: "A" };
  const dupB: StremioStream = { url: DUPLICATE_URL, name: "B" };
  const dupC: StremioStream = { url: DUPLICATE_URL, name: "C" };
  const arrivalOrders: ReadonlyArray<readonly StremioStream[]> = [
    [dupA, dupB, dupC],
    [dupA, dupC, dupB],
    [dupB, dupA, dupC],
    [dupB, dupC, dupA],
    [dupC, dupA, dupB],
    [dupC, dupB, dupA]
  ];

  it("reduces three duplicates to the same whole batch in every arrival order", () => {
    const canonical = mapStremioStreams([dupA, dupB, dupC], context);
    for (const order of arrivalOrders) {
      expect(mapStremioStreams(order, context)).toEqual(canonical);
    }
  });

  it("words every duplicate rejection after the survivor, not after an incumbent", () => {
    const canonical = mapStremioStreams([dupA, dupB, dupC], context);

    expect(canonical.mapped.map((entry) => entry.label)).toEqual(["A"]);
    expect(canonical.rejected.map((entry) => entry.reason)).toEqual([
      "duplicate_stream_url",
      "duplicate_stream_url"
    ]);
    // Both name A. "duplicate of B" appearing here would mean the trail is
    // describing a decision that depends on which stream the addon listed second.
    expect(canonical.rejected.map((entry) => entry.detail)).toEqual([
      "duplicate of A, which resolves to the same URL and the same candidate id",
      "duplicate of A, which resolves to the same URL and the same candidate id"
    ]);
  });

  it("hashes stably and only depends on the input string", () => {
    expect(stableStreamKey("https://cdn.example.com/a.mp4")).toBe(
      stableStreamKey("https://cdn.example.com/a.mp4")
    );
    expect(stableStreamKey("a")).not.toBe(stableStreamKey("b"));
    expect(stableStreamKey("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("observedHealthScore", () => {
  it("starts at the platform's health floor rather than crediting an unknown source", () => {
    expect(observedHealthScore(0, 0)).toBe(0.5);
  });

  it("does not award a perfect score for a single success", () => {
    expect(observedHealthScore(1, 0)).toBeCloseTo(0.6667, 4);
    expect(observedHealthScore(50, 0)).toBeLessThan(1);
  });

  it("moves monotonically with observations and stays inside (0, 1)", () => {
    expect(observedHealthScore(10, 0)).toBeGreaterThan(observedHealthScore(1, 0));
    expect(observedHealthScore(1, 5)).toBeLessThan(observedHealthScore(1, 0));
    expect(observedHealthScore(0, 100)).toBeGreaterThan(0);
    expect(observedHealthScore(-5, -5)).toBe(0.5);
  });
});
