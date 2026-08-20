import { describe, expect, it } from "vitest";
import { readDeclaredCodecs } from "./codecs";

describe("recognised identifiers map onto the contracts vocabulary", () => {
  it.each([
    ["avc1.640028", "h264"],
    ["avc3.42c01e", "h264"],
    ["hvc1.1.6.L93.B0", "hevc"],
    ["hev1.2.4.L120.B0", "hevc"],
    ["av01.0.05M.08", "av1"],
    ["vp09.00.10.08", "vp9"]
  ])("reads %s as %s", (identifier, expected) => {
    expect(readDeclaredCodecs(identifier).videoCodec).toBe(expected);
  });

  it.each([
    ["mp4a.40.2", "aac"],
    ["mp4a.40.5", "aac"],
    ["mp4a.40.29", "aac"],
    ["ac-3", "ac3"],
    ["ec-3", "eac3"],
    ["opus", "opus"],
    ["Opus", "opus"]
  ])("reads %s as %s", (identifier, expected) => {
    expect(readDeclaredCodecs(identifier).audioCodec).toBe(expected);
  });

  it("splits a mixed declaration into its two families", () => {
    const declared = readDeclaredCodecs("avc1.4d401f,mp4a.40.2");
    expect(declared.videoDeclared).toBe("avc1.4d401f");
    expect(declared.audioDeclared).toBe("mp4a.40.2");
    expect(declared.otherDeclared).toEqual([]);
  });

  it("tolerates whitespace around identifiers", () => {
    expect(readDeclaredCodecs(" avc1.4d401f , mp4a.40.2 ").videoCodec).toBe("h264");
  });
});

describe("an identifier outside the vocabulary is unknown, never the nearest guess", () => {
  it.each([
    // HEVC bitstream, but not decodable by a plain HEVC decoder. Mapping it to
    // `hevc` would tell a device it can play something it renders as garbage.
    ["dvhe.05.06"],
    ["dvh1.05.01"],
    // MPEG-1 Layer 3 wearing the `mp4a.40` prefix that three AAC object types
    // also wear. A prefix match on `mp4a.40` would have called this AAC.
    ["mp4a.40.34"],
    // AC-3 and E-AC-3 wearing an `mp4a` prefix, which is why a bare `mp4a` is
    // never read as AAC.
    ["mp4a"],
    ["vp08.00.10.08"],
    ["vvc1.1.L51.CQA"],
    ["mp4v.20.9"]
  ])("keeps %s raw and normalises it to null", (identifier) => {
    const declared = readDeclaredCodecs(identifier);
    expect(declared.videoCodec).toBeNull();
    expect(declared.audioCodec).toBeNull();
    // The publisher said something and it is not thrown away.
    expect(`${declared.videoDeclared ?? ""}${declared.audioDeclared ?? ""}`).toBe(identifier);
  });

  it("reads mp4a.a5 and mp4a.a6 as the AC-3 family they actually are", () => {
    expect(readDeclaredCodecs("mp4a.a5").audioCodec).toBe("ac3");
    expect(readDeclaredCodecs("mp4a.a6").audioCodec).toBe("eac3");
  });

  it("refuses to pick when two identifiers in one family disagree", () => {
    const declared = readDeclaredCodecs("avc1.4d401f,hvc1.1.6.L93.B0");
    expect(declared.videoCodec).toBeNull();
    expect(declared.videoDeclared).toBe("avc1.4d401f,hvc1.1.6.L93.B0");
  });

  it("accepts two identifiers that agree", () => {
    expect(readDeclaredCodecs("avc1.4d401f,avc3.4d401f").videoCodec).toBe("h264");
  });

  it("refuses when one of two identifiers is unrecognised", () => {
    expect(readDeclaredCodecs("avc1.4d401f,dvav.09.01").videoCodec).toBeNull();
  });
});

describe("identifiers in neither family are kept rather than dropped", () => {
  it("collects timed-text sample entries", () => {
    const declared = readDeclaredCodecs("stpp.ttml.im1t,wvtt");
    expect(declared.videoDeclared).toBeNull();
    expect(declared.audioDeclared).toBeNull();
    expect(declared.otherDeclared).toEqual(["stpp.ttml.im1t", "wvtt"]);
  });
});

describe("no declaration is not an empty declaration", () => {
  it.each([[null], [""], ["   "], [",,"]])("reads %j as nothing declared", (declaration) => {
    const declared = readDeclaredCodecs(declaration);
    expect(declared.videoDeclared).toBeNull();
    expect(declared.audioDeclared).toBeNull();
    expect(declared.otherDeclared).toEqual([]);
  });
});
