import { describe, expect, it } from "vitest";
import { parseDashLadder } from "./dash";
import { DEFAULT_INSPECTION_LIMITS } from "./inspect";
import { renderDashMpd, variant } from "./testing/fixtures";
import { INSPECTED_FACTS, type ManifestParseContext } from "./types";

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const context: ManifestParseContext = {
  observedAt: OBSERVED_AT,
  baseUrl: "https://cdn.example.test/media/manifest.mpd",
  egress: null,
  classifyHost: null,
  maxRenditions: DEFAULT_INSPECTION_LIMITS.maxRenditions
};

function mpd(body: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">',
    "  <Period>",
    body,
    "  </Period>",
    "</MPD>",
    ""
  ].join("\n");
}

describe("the whole ladder comes back, not one Representation", () => {
  it("returns every Representation, ordered by declared bandwidth", () => {
    const text = renderDashMpd([
      variant({ bandwidthBps: 5_000_000, width: 1920, height: 1080 }),
      variant({ bandwidthBps: 800_000, width: 640, height: 360 }),
      variant({ bandwidthBps: 2_400_000, width: 1280, height: 720 })
    ]);

    const { renditions } = parseDashLadder(text, context);

    expect(renditions).toHaveLength(3);
    expect(renditions.map((rendition) => rendition.bandwidthBps)).toEqual([800_000, 2_400_000, 5_000_000]);
    expect(renditions.map((rendition) => rendition.height)).toEqual([360, 720, 1080]);
  });

  it("reads video and audio AdaptationSets as separate renditions with declared kinds", () => {
    const text = mpd(
      [
        '    <AdaptationSet contentType="video" mimeType="video/mp4">',
        '      <Representation bandwidth="2400000" width="1280" height="720" codecs="avc1.4d401f"/>',
        "    </AdaptationSet>",
        '    <AdaptationSet contentType="audio" mimeType="audio/mp4">',
        '      <Representation bandwidth="128000" codecs="mp4a.40.2"/>',
        "    </AdaptationSet>"
      ].join("\n")
    );

    const { renditions } = parseDashLadder(text, context);

    expect(renditions).toHaveLength(2);
    const audio = renditions.find((rendition) => rendition.kind === "audio");
    const video = renditions.find((rendition) => rendition.kind === "video");
    expect(audio?.audioCodec).toBe("aac");
    // The audio set declares no geometry, so the geometry is unknown -- not
    // borrowed from the video set that happens to sit beside it.
    expect(audio?.height).toBeNull();
    expect(video?.videoCodec).toBe("h264");
    expect(video?.audioCodec).toBeNull();
  });

  it("never publishes a URL for a DASH rendition", () => {
    // A refusal, not an absence: constructing segment URLs from BaseURL and
    // SegmentTemplate would make this service a generator of attacker-specified
    // URLs on an attacker's behalf.
    const text = mpd(
      [
        '    <AdaptationSet contentType="video">',
        "      <BaseURL>https://evil.test/</BaseURL>",
        '      <Representation bandwidth="2400000">',
        '        <SegmentTemplate media="$Number$.m4s" initialization="init.mp4"/>',
        "      </Representation>",
        "    </AdaptationSet>"
      ].join("\n")
    );

    const { renditions } = parseDashLadder(text, context);
    expect(renditions).toHaveLength(1);
    expect(renditions[0]?.location).toEqual({ kind: "not_applicable" });
    expect(JSON.stringify(renditions)).not.toContain("evil.test");
  });
});

describe("AdaptationSet attributes are inherited, and the trail says so", () => {
  it("falls back to the set and cites which element answered", () => {
    const text = mpd(
      [
        '    <AdaptationSet contentType="video" width="1920" height="1080" frameRate="30000/1001" codecs="avc1.640028">',
        '      <Representation bandwidth="5000000"/>',
        '      <Representation bandwidth="3000000" height="720"/>',
        "    </AdaptationSet>"
      ].join("\n")
    );

    const { renditions } = parseDashLadder(text, context);
    const lower = renditions.find((rendition) => rendition.bandwidthBps === 3_000_000);
    const upper = renditions.find((rendition) => rendition.bandwidthBps === 5_000_000);

    expect(upper?.height).toBe(1080);
    expect(upper?.mediaEvidence.height?.detail).toBe("AdaptationSet@height");
    // The rendition overrode the set, and the citation has to say so: "every
    // rendition here is 1080p because the set says so" and "this one says it is
    // 720p" are different claims.
    expect(lower?.height).toBe(720);
    expect(lower?.mediaEvidence.height?.detail).toBe("Representation@height");
    expect(lower?.width).toBe(1920);
    expect(lower?.mediaEvidence.width?.detail).toBe("AdaptationSet@width");
  });

  it("evaluates a frame rate expressed as a ratio", () => {
    const text = mpd(
      [
        '    <AdaptationSet contentType="video">',
        '      <Representation bandwidth="1" frameRate="30000/1001"/>',
        "    </AdaptationSet>"
      ].join("\n")
    );

    const [rendition] = parseDashLadder(text, context).renditions;

    // Asserted exactly rather than against a rounded 29.97, because the ratio
    // IS the fact the publisher declared. 30000/1001 is 29.97002997..., and the
    // familiar "29.97" is a colloquialism for it -- so an approximate assertion
    // here would be pinning our rounding rather than their declaration, and
    // would quietly tolerate a parser that returned the wrong thing to five
    // decimal places. The whole package exists to avoid substituting a
    // plausible value for a stated one.
    expect(rendition?.frameRate).toBe(30000 / 1001);
  });

  it("bandwidth is never inherited from the set", () => {
    const text = mpd(
      [
        '    <AdaptationSet contentType="video" bandwidth="9999999">',
        '      <Representation width="1280" height="720"/>',
        "    </AdaptationSet>"
      ].join("\n")
    );

    const [rendition] = parseDashLadder(text, context).renditions;
    expect(rendition?.bandwidthBps).toBeNull();
    expect(rendition?.unknownFacts).toContain("bandwidthBps");
  });
});

describe("unknown stays unknown", () => {
  it("reports omitted geometry as null rather than inferring it from bandwidth", () => {
    const text = renderDashMpd([variant({ width: null, height: null, bandwidthBps: 5_000_000 })]);
    const [rendition] = parseDashLadder(text, context).renditions;

    expect(rendition?.width).toBeNull();
    expect(rendition?.height).toBeNull();
    expect(rendition?.unreadableDeclarations).toEqual([]);
  });

  it("keeps unknownFacts and mediaEvidence as exact complements", () => {
    const text = renderDashMpd([variant({ frameRate: null, codecs: null })]);
    const [rendition] = parseDashLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    const stated = Object.keys(rendition.mediaEvidence);
    expect([...stated, ...rendition.unknownFacts].sort()).toEqual([...INSPECTED_FACTS].sort());
  });

  it("does not derive the kind from the codec when neither contentType nor mimeType is declared", () => {
    const text = mpd(
      ['    <AdaptationSet>', '      <Representation bandwidth="1" codecs="avc1.4d401f"/>', "    </AdaptationSet>"].join(
        "\n"
      )
    );

    const [rendition] = parseDashLadder(text, context).renditions;
    // `avc1` obviously means video. Saying so would be inference, and the same
    // inference one layer up is how a codec gets derived from a file extension.
    expect(rendition?.kind).toBe("unknown");
    expect(rendition?.videoCodec).toBe("h264");
  });
});

describe("provenance says a manifest declared it", () => {
  it("labels every stated fact manifest_declared with the inspection's instant", () => {
    const text = renderDashMpd([variant()]);
    const [rendition] = parseDashLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    expect(rendition.mediaEvidence.bandwidthBps).toEqual({
      source: "manifest_declared",
      observedAt: OBSERVED_AT,
      detail: "Representation@bandwidth"
    });
    for (const fact of INSPECTED_FACTS) {
      expect(rendition.mediaEvidence[fact]?.source ?? "manifest_declared").toBe("manifest_declared");
    }
  });
});

describe("malformed and hostile MPDs are handled rather than thrown", () => {
  it("treats a nonsensical attribute as unreadable and cites where it was declared", () => {
    const text = mpd(
      [
        '    <AdaptationSet contentType="video">',
        '      <Representation bandwidth="lots" width="-1" height="720" frameRate="30/0"/>',
        "    </AdaptationSet>"
      ].join("\n")
    );

    const [rendition] = parseDashLadder(text, context).renditions;

    expect(rendition?.bandwidthBps).toBeNull();
    expect(rendition?.width).toBeNull();
    expect(rendition?.frameRate).toBeNull();
    expect(rendition?.height).toBe(720);
    expect(rendition?.unreadableDeclarations).toEqual([
      "Representation@bandwidth",
      "Representation@frameRate",
      "Representation@width"
    ]);
  });

  it("reads a Representation that a namespace prefix would otherwise hide", () => {
    // Matching on the qualified name would let a publisher make its ladder
    // invisible to us by binding a prefix, which is a choice no publisher should
    // have.
    const text = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<dash:MPD xmlns:dash="urn:mpeg:dash:schema:mpd:2011" type="static">',
      "  <dash:Period>",
      '    <dash:AdaptationSet contentType="video">',
      '      <dash:Representation bandwidth="2400000" width="1280" height="720"/>',
      "    </dash:AdaptationSet>",
      "  </dash:Period>",
      "</dash:MPD>",
      ""
    ].join("\n");

    const { renditions } = parseDashLadder(text, context);
    expect(renditions).toHaveLength(1);
    expect(renditions[0]?.height).toBe(720);
  });

  it("reads a Representation that sits outside any AdaptationSet", () => {
    const text = mpd('    <Representation bandwidth="2400000" height="720"/>');
    const { renditions } = parseDashLadder(text, context);

    expect(renditions).toHaveLength(1);
    expect(renditions[0]?.height).toBe(720);
    expect(renditions[0]?.kind).toBe("unknown");
  });

  it("collapses a ladder restated in every Period rather than reporting it six times", () => {
    const period = [
      "  <Period>",
      '    <AdaptationSet contentType="video">',
      '      <Representation bandwidth="2400000" width="1280" height="720"/>',
      "    </AdaptationSet>",
      "  </Period>"
    ].join("\n");
    const text = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">',
      period,
      period,
      period,
      "</MPD>",
      ""
    ].join("\n");

    expect(parseDashLadder(text, context).renditions).toHaveLength(1);
  });

  it.each([
    [""],
    ["not xml at all"],
    ['<?xml version="1.0"?><MPD></MPD>'],
    ['<?xml version="1.0"?><MPD><Period><AdaptationSet/></Period></MPD>'],
    ["<MPD><Period><AdaptationSet><Representation bandwidth=</AdaptationSet></Period></MPD>"]
  ])("returns a reasoned result for %j rather than throwing", (text) => {
    const parsed = parseDashLadder(text, context);
    // A result, never an exception -- and never an empty result with no
    // explanation, which would be the outcome that tells a caller nothing.
    expect(parsed.renditions.length + parsed.reasons.length).toBeGreaterThan(0);
  });

  it("refuses a declared ladder larger than the cap before building any of it", () => {
    const representations = Array.from(
      { length: 5 },
      (_unused, index) => `      <Representation bandwidth="${400_000 * (index + 1)}"/>`
    ).join("\n");
    const text = mpd(
      ['    <AdaptationSet contentType="video">', representations, "    </AdaptationSet>"].join("\n")
    );

    const parsed = parseDashLadder(text, { ...context, maxRenditions: 4 });

    // No rungs at all. The count is taken from the `Representation` elements
    // themselves, before one is read and long before the ladder is sorted by a
    // comparator that stringifies several fields per comparison -- which is the
    // work a 2 MiB MPD of minimal elements would otherwise buy for the price of
    // one request.
    expect(parsed.renditions).toEqual([]);
    expect(parsed.reasons).toEqual([
      { code: "too_many_renditions", detail: "5 declared renditions exceeds the cap of 4" }
    ]);
  });

  it("counts a ladder restated in every Period, because that is what the work is proportional to", () => {
    // Three Periods of two rungs collapse to two rungs, so a cap applied to the
    // parsed ladder would never fire here -- having first done the work for six.
    // The consequence is stated rather than hidden: this cap is a work budget,
    // not a ladder-width budget, and a many-period catalogue needs a larger one.
    const period = [
      "  <Period>",
      '    <AdaptationSet contentType="video">',
      '      <Representation bandwidth="2400000" width="1280" height="720"/>',
      '      <Representation bandwidth="800000" width="640" height="360"/>',
      "    </AdaptationSet>",
      "  </Period>"
    ].join("\n");
    const text = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">',
      period,
      period,
      period,
      "</MPD>",
      ""
    ].join("\n");

    expect(parseDashLadder(text, context).renditions).toHaveLength(2);

    const capped = parseDashLadder(text, { ...context, maxRenditions: 4 });
    expect(capped.renditions).toEqual([]);
    expect(capped.reasons[0]?.code).toBe("too_many_renditions");
    expect(capped.reasons[0]?.detail).toContain("6 declared");
  });

  it("admits a declared ladder exactly at the cap, so the boundary is not off by one", () => {
    const text = renderDashMpd([
      variant({ bandwidthBps: 800_000 }),
      variant({ bandwidthBps: 2_400_000 }),
      variant({ bandwidthBps: 5_000_000 })
    ]);

    const parsed = parseDashLadder(text, { ...context, maxRenditions: 3 });

    expect(parsed.renditions).toHaveLength(3);
    expect(parsed.reasons).toEqual([]);
  });

  it("does not expand an external entity", () => {
    // xmldom does not resolve external entities, and this pins that: an XXE that
    // resolved would put the file's contents into an attribute we report.
    const text = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE MPD [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">',
      "  <Period>",
      '    <AdaptationSet contentType="video">',
      '      <Representation bandwidth="1" codecs="&xxe;"/>',
      "    </AdaptationSet>",
      "  </Period>",
      "</MPD>",
      ""
    ].join("\n");

    const parsed = parseDashLadder(text, context);
    expect(JSON.stringify(parsed)).not.toContain("root:");
  });
});
