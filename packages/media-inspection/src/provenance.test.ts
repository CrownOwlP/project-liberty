import { describe, expect, it } from "vitest";
import { parseHlsLadder } from "./hls";
import { DEFAULT_INSPECTION_LIMITS } from "./inspect";
import { FACT_SOURCE_STRENGTH, observationsFromRendition, reconcileFact, type FactObservation } from "./provenance";
import { renderHlsMaster, variant } from "./testing/fixtures";
import type { ManifestParseContext } from "./types";

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const context: ManifestParseContext = {
  observedAt: OBSERVED_AT,
  baseUrl: null,
  egress: null,
  classifyHost: null,
  maxRenditions: DEFAULT_INSPECTION_LIMITS.maxRenditions
};

function providerClaim<Value>(value: Value): FactObservation<Value> {
  return {
    fact: "height",
    value,
    source: "provider_declared",
    observedAt: "2026-08-19T00:00:00.000Z",
    detail: "catalogue.stream.quality"
  };
}

function manifestFact<Value>(value: Value): FactObservation<Value> {
  return {
    fact: "height",
    value,
    source: "manifest_declared",
    observedAt: OBSERVED_AT,
    detail: "#EXT-X-STREAM-INF:RESOLUTION"
  };
}

describe("the three epistemic states are ranked and none of them collapse", () => {
  it("ranks a probe above a manifest above a provider", () => {
    expect(FACT_SOURCE_STRENGTH.probe).toBeGreaterThan(FACT_SOURCE_STRENGTH.manifest_declared);
    expect(FACT_SOURCE_STRENGTH.manifest_declared).toBeGreaterThan(FACT_SOURCE_STRENGTH.provider_declared);
  });

  it("prefers the manifest's value and keeps the provider's claim beside it", () => {
    const reconciled = reconcileFact("height", [providerClaim(1080), manifestFact(720)]);

    expect(reconciled.value).toBe(720);
    expect(reconciled.evidence?.source).toBe("manifest_declared");
    expect(reconciled.agreement).toBe("divergent");
    // The losing observation is still there. A provider whose catalogue says
    // 1080p for a 720p stream is wrong about every other title it lists too,
    // and that signal only exists if the disagreement is preserved.
    expect(reconciled.observations).toHaveLength(2);
    expect(reconciled.observations[1]).toEqual(providerClaim(1080));
  });

  it("reports corroboration when the two agree, without discarding either", () => {
    const reconciled = reconcileFact("height", [providerClaim(720), manifestFact(720)]);

    expect(reconciled.value).toBe(720);
    expect(reconciled.agreement).toBe("corroborated");
    expect(reconciled.observations).toHaveLength(2);
  });

  it("reports a single observation as a sole source rather than as corroborated", () => {
    expect(reconcileFact("height", [manifestFact(720)]).agreement).toBe("sole_source");
  });

  it("calls three sources divergent when any one disagrees, not corroborated by majority", () => {
    const probe: FactObservation<number> = {
      fact: "height",
      value: 720,
      source: "probe",
      observedAt: OBSERVED_AT,
      detail: "stream.height"
    };
    const reconciled = reconcileFact("height", [providerClaim(1080), manifestFact(720), probe]);

    expect(reconciled.value).toBe(720);
    expect(reconciled.evidence?.source).toBe("probe");
    expect(reconciled.agreement).toBe("divergent");
  });

  it("reports no observations as unobserved with a null value, never a default", () => {
    const reconciled = reconcileFact<number>("height", []);
    expect(reconciled.value).toBeNull();
    expect(reconciled.evidence).toBeNull();
    expect(reconciled.agreement).toBe("unobserved");
  });

  it("accepts a tolerance so that 30000/1001 and 29.97 are not a false divergence", () => {
    const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
    const reconciled = reconcileFact(
      "frameRate",
      [
        { ...manifestFact(30000 / 1001), fact: "frameRate" },
        { ...providerClaim(29.97), fact: "frameRate" }
      ],
      close
    );
    expect(reconciled.agreement).toBe("corroborated");
  });
});

describe("reconciliation is a function of its observations and not of their order", () => {
  it("returns the same result whichever way round the observations arrive", () => {
    const forwards = reconcileFact("height", [providerClaim(1080), manifestFact(720)]);
    const backwards = reconcileFact("height", [manifestFact(720), providerClaim(1080)]);
    expect(backwards).toEqual(forwards);
  });

  it("does not mutate the array it was given", () => {
    const input = [manifestFact(720), providerClaim(1080)];
    const snapshot = [...input];
    reconcileFact("height", input);
    expect(input).toEqual(snapshot);
  });
});

describe("observations built from a rendition", () => {
  it("carries the manifest_declared source and the citation through", () => {
    const text = renderHlsMaster([variant({ height: 720, width: 1280 })]);
    const [rendition] = parseHlsLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    const observations = observationsFromRendition(rendition);
    const height = observations.find((observation) => observation.fact === "height");

    expect(height).toEqual({
      fact: "height",
      value: 720,
      source: "manifest_declared",
      observedAt: OBSERVED_AT,
      detail: "#EXT-X-STREAM-INF:RESOLUTION"
    });
  });

  it("contributes nothing at all for a fact the manifest did not state", () => {
    // An observation of "I do not know" is not evidence, and letting one in
    // would make `sole_source` reachable for a fact nobody stated.
    const text = renderHlsMaster([variant({ frameRate: null })]);
    const [rendition] = parseHlsLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    const observations = observationsFromRendition(rendition);
    expect(observations.some((observation) => observation.fact === "frameRate")).toBe(false);
    expect(reconcileFact("frameRate", []).agreement).toBe("unobserved");
  });

  it("uses the raw RFC 6381 identifier for the codec facts", () => {
    // Comparing normalised values would report "the provider said hevc, the
    // manifest said nothing" for a manifest that plainly said dvhe.05.06.
    const text = renderHlsMaster([variant({ codecs: "dvhe.05.06" })]);
    const [rendition] = parseHlsLadder(text, context).renditions;
    if (rendition === undefined) throw new Error("expected a rendition");

    const observations = observationsFromRendition(rendition);
    const videoCodec = observations.find((observation) => observation.fact === "videoCodec");
    expect(videoCodec?.value).toBe("dvhe.05.06");
    expect(rendition.videoCodec).toBeNull();
  });
});
