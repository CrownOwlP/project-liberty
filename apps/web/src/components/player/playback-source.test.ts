import { describe, expect, it } from "vitest";
import { checkPlaybackSource, describeSourceRejection } from "./playback-source";

const check = (uri: string) => checkPlaybackSource({ uri });

describe("transport backstop", () => {
  it("accepts https", () => {
    expect(check("https://cdn.example.com/title/manifest.mpd")).toEqual({ ok: true });
    expect(check("https://cdn.example.com/title/master.m3u8?token=abc")).toEqual({ ok: true });
  });

  it("rejects plaintext http to a real host", () => {
    // A mixed-content or plaintext source fails inside Shaka as a generic
    // network error, which looks identical to a dead CDN.
    expect(check("http://cdn.example.com/manifest.mpd")).toEqual({
      ok: false,
      reason: "insecure_transport"
    });
  });

  it("allows loopback so local DASH and HLS fixtures are playable", () => {
    expect(check("http://localhost:8080/fixtures/gap.mpd")).toEqual({ ok: true });
    expect(check("http://127.0.0.1:8080/fixtures/gap.mpd")).toEqual({ ok: true });
    expect(check("http://[::1]:8080/fixtures/gap.mpd")).toEqual({ ok: true });
  });

  it("gives no plaintext exemption to anything that merely looks local", () => {
    // A private-range or `.local` carve-out would let a misconfigured
    // deployment believe it was fine.
    expect(check("http://10.0.0.5/manifest.mpd").ok).toBe(false);
    expect(check("http://media.local/manifest.mpd").ok).toBe(false);
    expect(check("http://localhost.evil.example.com/manifest.mpd").ok).toBe(false);
  });

  it("rejects every scheme that is not a fetched https resource", () => {
    for (const uri of [
      "data:application/dash+xml,<MPD/>",
      "blob:https://app.example.com/8f0e",
      "file:///tmp/movie.mp4",
      "javascript:alert(1)",
      "magnet:?xt=urn:btih:0000000000000000000000000000000000000000"
    ]) {
      expect(check(uri)).toEqual({ ok: false, reason: "insecure_transport" });
    }
  });

  it("will not resolve a relative URL against whichever page is mounted", () => {
    expect(check("/media/manifest.mpd")).toEqual({ ok: false, reason: "unparsable_uri" });
    expect(check("manifest.mpd")).toEqual({ ok: false, reason: "unparsable_uri" });
  });

  it("distinguishes an empty source from an unparsable one", () => {
    expect(check("")).toEqual({ ok: false, reason: "empty_uri" });
    expect(check("   ")).toEqual({ ok: false, reason: "empty_uri" });
  });

  it("says something for every rejection reason", () => {
    for (const reason of ["empty_uri", "unparsable_uri", "insecure_transport"] as const) {
      expect(describeSourceRejection(reason)).not.toBe("");
    }
  });
});
