import { describe, expect, it } from "vitest";
import {
  deriveProtocol,
  mapStremioStream,
  mapStremioStreams,
  observedHealthScore,
  observeStreamMedia,
  resolveStreamMedia,
  stableStreamKey,
  type ObservedMedia,
  type StreamMappingContext
} from "./mapping";
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

describe("media facts are refused, never invented", () => {
  it("refuses a direct stream because the protocol states no codec", () => {
    // This is the whole cost of the correction, stated in one assertion: a
    // Stremio stream that is playable, licensed and reachable still produces no
    // candidate, because `StreamCandidate` demands four facts the protocol does
    // not carry. Refusing is the honest outcome; the alternative was writing
    // 480/3600/h264/aac onto the candidate and calling them measurements.
    const result = mapStremioStream(directStream, context);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("unknown_video_codec");
    expect(!result.ok && result.detail).toContain("states no video codec");
  });

  it("refuses it the same way however flattering the addon's own title is", () => {
    // "2160p HDR REMUX" is advertising written by the party being ranked. It did
    // not move `height` when height was a placeholder and it does not create a
    // known resolution now.
    expect(
      outcome({ url: "https://cdn.example.com/a.mp4", title: "2160p HDR REMUX 80GB h264 aac" })
    ).toBe("unknown_video_codec");
    expect(outcome({ url: "https://cdn.example.com/b.mp4" })).toBe("unknown_video_codec");
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

  it("names each missing fact, most fundamental first", () => {
    const complete: ObservedMedia = {
      videoCodec: "h264",
      audioCodec: "aac",
      height: 1080,
      bitrateKbps: 8100
    };

    const reasonFor = (observed: ObservedMedia): string => {
      const result = resolveStreamMedia(observed);
      return result.ok ? "ok" : result.reason;
    };

    expect(reasonFor(complete)).toBe("ok");
    expect(reasonFor({ ...complete, videoCodec: undefined })).toBe("unknown_video_codec");
    expect(reasonFor({ ...complete, audioCodec: undefined })).toBe("unknown_audio_codec");
    expect(reasonFor({ ...complete, height: undefined })).toBe("unknown_resolution");
    expect(reasonFor({ ...complete, bitrateKbps: undefined })).toBe("unknown_bitrate");

    // Codecs decide whether the stream plays at all, so they are reported ahead
    // of the two fields that only decide how well it plays.
    const nothing = resolveStreamMedia({});
    expect(!nothing.ok && nothing.reason).toBe("unknown_video_codec");
  });

  it("passes observations through unchanged once every fact is known", () => {
    const observed: ObservedMedia = {
      videoCodec: "hevc",
      audioCodec: "opus",
      height: 2160,
      bitrateKbps: 16_200
    };
    const result = resolveStreamMedia(observed);

    expect(result.ok).toBe(true);
    expect(result.ok && result.media).toEqual({
      videoCodec: "hevc",
      audioCodec: "opus",
      height: 2160,
      bitrateKbps: 16_200
    });
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

  it("reports the rights failure ahead of the missing media facts", () => {
    // The same stream, refused for two different reasons depending only on the
    // declared rights: the most fundamental reason is the one reported.
    for (const rights of ["licensed", "owned", "public-domain"] as const) {
      expect(outcome(directStream, { ...context, rights })).toBe("unknown_video_codec");
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

    // Opting in retires this refusal specifically; the stream then falls through
    // to the media facts it still cannot supply, rather than becoming playable.
    const accepted = mapStremioStream(stream, { ...context, acceptNotWebReady: true });
    expect(accepted.ok).toBe(false);
    expect(!accepted.ok && accepted.reason).toBe("unknown_video_codec");
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

  it("lets a loopback stream URL past the URL policy only when both conditions hold", () => {
    // Past the URL gate, and refused further down for the media facts the
    // protocol still does not state -- not for anything about its address.
    expect(outcome({ url: "http://127.0.0.1:8096/film.mp4" }, local)).toBe("unknown_video_codec");
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

describe("mapping is deterministic", () => {
  const streams: StremioStream[] = [
    { url: "https://cdn.example.com/a.mp4", name: "A" },
    { url: "https://cdn.example.com/b.m3u8", name: "B" },
    { infoHash: "0123456789abcdef0123456789abcdef01234567", name: "T" }
  ];

  it("produces an identical result for identical input", () => {
    expect(mapStremioStreams(streams, context)).toEqual(mapStremioStreams(streams, context));
  });

  it("preserves the addon's ordering rather than ranking on its behalf", () => {
    const batch = mapStremioStreams(streams, context);

    // Nothing maps while the media facts are unavailable, so the ordering that
    // survives is the ordering of the reason trail. Each entry still names the
    // stream by its position in the addon's response.
    expect(batch.mapped).toEqual([]);
    expect(batch.rejected.map((entry) => entry.reason)).toEqual([
      "unknown_video_codec",
      "unknown_video_codec",
      "torrent_source_unsupported"
    ]);
    expect(batch.rejected.map((entry) => entry.ref)).toEqual([
      "archive:#0 A",
      "archive:#1 B",
      "archive:#2 T"
    ]);
  });

  it("reports duplicate URLs individually while nothing reaches deduplication", () => {
    /*
     * Deduplication collapses two streams that resolve to the same candidate id,
     * and no stream currently becomes a candidate at all -- so `duplicate_stream_url`
     * is unreachable today, for the same reason `unknown_audio_codec` is: the
     * first missing media fact refuses the stream before either check is
     * consulted. This asserts what the mapper actually does rather than a
     * behaviour it no longer has, and is the test to restore when the contract
     * can represent unknown metadata.
     */
    const batch = mapStremioStreams(
      [
        { url: "https://cdn.example.com/a.mp4", name: "First" },
        { url: "https://cdn.example.com/a.mp4", name: "Same file, different title" }
      ],
      context
    );

    expect(batch.mapped).toEqual([]);
    expect(batch.rejected.map((entry) => entry.reason)).toEqual([
      "unknown_video_codec",
      "unknown_video_codec"
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
