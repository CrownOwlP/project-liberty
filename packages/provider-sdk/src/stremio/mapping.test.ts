import { describe, expect, it } from "vitest";
import { streamCandidateSchema } from "@liberty/contracts";
import {
  deriveProtocol,
  mapStremioStream,
  mapStremioStreams,
  observedHealthScore,
  stableStreamKey,
  UNKNOWN_AUDIO_CODEC,
  UNKNOWN_BITRATE_KBPS,
  UNKNOWN_HEIGHT,
  UNKNOWN_VIDEO_CODEC,
  type StreamMappingContext
} from "./mapping";
import type { StremioStream } from "./protocol";

const context: StreamMappingContext = {
  sourceId: "archive",
  rights: "public-domain",
  allowLoopback: false,
  acceptNotWebReady: false,
  observedLatencyMs: 120,
  healthScore: 0.6667
};

const local: StreamMappingContext = { ...context, allowLoopback: true };

const outcome = (stream: StremioStream, ctx: StreamMappingContext = context): string => {
  const result = mapStremioStream(stream, ctx);
  return result.ok ? "ok" : result.reason;
};

describe("mapping a direct stream", () => {
  it("produces a contract-valid candidate carrying the source's declared rights", () => {
    const result = mapStremioStream(
      { url: "https://cdn.example.com/film.mp4", name: "Archive", title: "1080p" },
      context
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mapped.candidate).toEqual({
      id: `archive:${stableStreamKey("https://cdn.example.com/film.mp4")}`,
      providerId: "archive",
      rights: "public-domain",
      protocol: "https",
      height: UNKNOWN_HEIGHT,
      bitrateKbps: UNKNOWN_BITRATE_KBPS,
      estimatedLatencyMs: 120,
      healthScore: 0.6667,
      videoCodec: UNKNOWN_VIDEO_CODEC,
      audioCodec: UNKNOWN_AUDIO_CODEC
    });

    expect(streamCandidateSchema.safeParse(result.mapped.candidate).success).toBe(true);
  });

  it("declares which of the candidate's fields are placeholders", () => {
    const result = mapStremioStream({ url: "https://cdn.example.com/film.mp4" }, context);
    expect(result.ok && result.mapped.unknownFields).toEqual([
      "height",
      "bitrateKbps",
      "videoCodec",
      "audioCodec"
    ]);
  });

  it("never reads quality from the addon's own free text", () => {
    // "2160p HDR REMUX" is advertising written by the party being ranked. If it
    // moved `height`, any addon could outrank every other source by renaming.
    const flattering = mapStremioStream(
      { url: "https://cdn.example.com/a.mp4", title: "2160p HDR REMUX 80GB" },
      context
    );
    const plain = mapStremioStream({ url: "https://cdn.example.com/b.mp4" }, context);

    expect(flattering.ok && flattering.mapped.candidate.height).toBe(UNKNOWN_HEIGHT);
    expect(plain.ok && plain.mapped.candidate.height).toBe(UNKNOWN_HEIGHT);
  });

  it("keeps the placeholder bitrate consistent with the placeholder height", () => {
    // media-engine scores bitrate as a distance from height * 7.5 and penalises
    // both directions, so an independently chosen bitrate would add a second
    // meaningless penalty on top of the resolution one.
    expect(UNKNOWN_BITRATE_KBPS).toBe(UNKNOWN_HEIGHT * 7.5);
  });
});

describe("rights fail closed", () => {
  it("emits nothing when the context's rights are not on the allowlist", () => {
    // Deliberately bypasses the type, simulating a forged or corrupted context.
    const forged = { ...context, rights: "unlicensed" as never };
    expect(outcome({ url: "https://cdn.example.com/film.mp4" }, forged)).toBe("rights_not_playable");
  });

  it("checks rights before anything technical about the stream", () => {
    const forged = { ...context, rights: "pirated" as never };
    expect(outcome({ infoHash: "0123456789abcdef0123456789abcdef01234567" }, forged)).toBe(
      "rights_not_playable"
    );
  });

  it("copies the declared rights verbatim rather than deriving anything", () => {
    for (const rights of ["licensed", "owned", "public-domain"] as const) {
      const result = mapStremioStream({ url: "https://cdn.example.com/film.mp4" }, { ...context, rights });
      expect(result.ok && result.mapped.candidate.rights).toBe(rights);
    }
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
    expect(accepted.ok && accepted.mapped.notWebReady).toBe(true);
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

  it("permits a loopback stream URL for a source declared local", () => {
    expect(outcome({ url: "http://127.0.0.1:8096/film.mp4" }, local)).toBe("ok");
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

  it("gives the same stream the same candidate id regardless of its position", () => {
    const forward = mapStremioStreams(streams, context);
    const reversed = mapStremioStreams([...streams].reverse(), context);

    const ids = (batch: ReturnType<typeof mapStremioStreams>): string[] =>
      batch.mapped.map((entry) => entry.candidate.id).sort();

    expect(ids(reversed)).toEqual(ids(forward));
  });

  it("preserves the addon's ordering rather than ranking on its behalf", () => {
    const batch = mapStremioStreams(streams, context);
    expect(batch.mapped.map((entry) => entry.url)).toEqual([
      "https://cdn.example.com/a.mp4",
      "https://cdn.example.com/b.m3u8"
    ]);
    expect(batch.rejected.map((entry) => entry.reason)).toEqual(["torrent_source_unsupported"]);
  });

  it("collapses duplicate URLs so two candidates never share an id", () => {
    const batch = mapStremioStreams(
      [
        { url: "https://cdn.example.com/a.mp4", name: "First" },
        { url: "https://cdn.example.com/a.mp4", name: "Same file, different title" }
      ],
      context
    );

    expect(batch.mapped).toHaveLength(1);
    expect(batch.rejected.map((entry) => entry.reason)).toEqual(["duplicate_stream_url"]);
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
