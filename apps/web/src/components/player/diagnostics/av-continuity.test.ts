import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AV_LIP_SYNC_METRIC,
  AV_PROXY_METRICS,
  DEFAULT_AV_CONTINUITY_POLICY,
  PROHIBITED_AV_INSTRUMENTATION,
  lipSyncOffsetUnobservable,
  observeAvContinuity,
  summariseAvContinuity,
  type AvContinuityInput,
  type AvContinuityReport
} from "./index";
import type { BufferedRange, TrackBufferedReading, AvTrackKind } from "./buffered-ranges";
import type { VideoFrameReading } from "./frame-timing";

function reading<TTrack extends AvTrackKind>(
  track: TTrack,
  ranges: readonly (readonly [number, number])[]
): TrackBufferedReading<TTrack> {
  return {
    source: "source-buffer",
    track,
    ranges: ranges.map(([startSeconds, endSeconds]): BufferedRange => ({ startSeconds, endSeconds }))
  };
}

const FRAME: VideoFrameReading = {
  presentationTimeMs: 1_000,
  expectedDisplayTimeMs: 1_016,
  mediaTimeSeconds: 12,
  presentedFrames: 300,
  processingDurationMs: 4
};

/** The instant is an input everywhere. Nothing in this directory reads a clock. */
const OBSERVED_AT_MS = 1_755_000_000_000;

function input(overrides: Partial<AvContinuityInput> = {}): AvContinuityInput {
  return {
    observedAtMs: OBSERVED_AT_MS,
    policy: DEFAULT_AV_CONTINUITY_POLICY,
    buffered: {
      playheadSeconds: 10.1,
      video: reading("video", [
        [0, 10],
        [10.4, 30]
      ]),
      audio: reading("audio", [[0, 30]])
    },
    frames: { previous: FRAME, current: { ...FRAME, mediaTimeSeconds: 12.04, presentedFrames: 301 } },
    engineConfig: { manifest: { dash: { sequenceMode: false }, hls: { sequenceMode: false } } },
    ...overrides
  };
}

/** Every distinct property name appearing anywhere in a report. */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** A battery covering every branch the public API can take. */
const REPORTS: readonly AvContinuityReport[] = [
  observeAvContinuity(input()),
  observeAvContinuity(input({ buffered: null, frames: null, engineConfig: null })),
  observeAvContinuity(
    input({
      buffered: {
        playheadSeconds: 10.1,
        video: reading("video", [
          [0, 10],
          [25, 40]
        ]),
        audio: reading("audio", [[0, 40]])
      },
      frames: { previous: FRAME, current: { ...FRAME, presentedFrames: 305 } },
      engineConfig: { manifest: { hls: { sequenceMode: true } } }
    })
  ),
  observeAvContinuity(
    input({
      frames: {
        previous: { ...FRAME, mediaTimeSeconds: 0 },
        current: { ...FRAME, mediaTimeSeconds: 0, presentedFrames: 301 }
      }
    })
  )
];

describe("no proxy can be read as a measured A/V skew", () => {
  it("exposes no millisecond field anywhere in a report except the supplied instant", () => {
    /*
     * THE ACCEPTANCE CLAUSE, AS AN ASSERTION. A caller must not be able to pull
     * a millisecond number out of any finding and believe it is a sync offset.
     * `observedAtMs` is the instant the caller itself supplied, and it is the
     * only `*Ms` name a browser-produced report may contain.
     */
    for (const report of REPORTS) {
      const millisecondKeys = [...collectKeys(report)].filter((key) => /Ms$/.test(key));
      expect(millisecondKeys).toEqual(["observedAtMs"]);
    }
  });

  it("names no field after skew, drift, sync or offset", () => {
    for (const report of REPORTS) {
      const suspicious = [...collectKeys(report)].filter((key) =>
        /skew|drift|sync|offset/i.test(key)
      );
      expect(suspicious).toEqual([]);
    }
  });

  it("keeps every proxy magnitude in a tagged unit with no millisecond branch", () => {
    for (const report of REPORTS) {
      for (const finding of report.findings) {
        if (finding.evidenceBasis !== "proxy" || finding.magnitude === null) continue;
        expect(["seconds-of-media-timeline", "frames-presented"]).toContain(
          finding.magnitude.unit
        );
      }
    }
  });

  it("never produces an external measurement from a browser", () => {
    // `AvExternalMeasurement` is the only branch with `audioAheadMs`, and
    // nothing in this directory constructs one. It can only arrive from a rig.
    for (const report of REPORTS) {
      for (const finding of report.findings) {
        expect(finding.evidenceBasis).not.toBe("external-measurement");
      }
    }
  });

  it("gives every finding an evidence source and a non-empty reason trail", () => {
    for (const report of REPORTS) {
      for (const finding of report.findings) {
        expect(finding.evidenceSource).toBeTruthy();
        expect(finding.reasons.length).toBeGreaterThan(0);
        for (const reason of finding.reasons) {
          expect(reason.code).toBeTruthy();
          expect(reason.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("the signal a browser does not have is reported, not omitted", () => {
  it("puts the unobservable lip-sync entry first in every report", () => {
    for (const report of REPORTS) {
      const first = report.findings[0];
      expect(first?.metric).toBe(AV_LIP_SYNC_METRIC);
      expect(first?.evidenceBasis).toBe("unobservable");
    }
  });

  it("states all four reasons it cannot be measured here", () => {
    expect(lipSyncOffsetUnobservable().reasons.map((reason) => reason.code)).toEqual([
      "no_audio_clock_in_browser",
      "webaudio_reroute_prohibited",
      "proxy_not_measurement",
      "external_measurement_required"
    ]);
  });

  it("points at the external procedure rather than at a number", () => {
    const detail = lipSyncOffsetUnobservable()
      .reasons.map((reason) => reason.detail)
      .join(" ");
    expect(detail).toContain("docs/AV_SYNC_MEASUREMENT.md");
    expect(detail).toContain("flash-and-blip");
  });
});

describe("rerouting protected playback through Web Audio is prohibited", () => {
  it("does not reach for any prohibited instrumentation API", () => {
    /*
     * The prohibition is enforced rather than written down. Routing playback
     * through Web Audio to obtain a clock does not measure presented alignment
     * either, it makes the audio path of DRM-protected playback more invasive,
     * and W3C Bug 17347 is closed WONTFIX on that ground.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      // The declaration of the prohibition list necessarily names every API in
      // it, so that array literal — and only that array literal — is cut out
      // before the scan. Every other mention anywhere in the directory fails.
      const contents = readFileSync(join(here, name), "utf8").replace(
        /PROHIBITED_AV_INSTRUMENTATION[\s\S]*?\r?\n\];/,
        ""
      );
      for (const api of PROHIBITED_AV_INSTRUMENTATION) {
        expect(contents.includes(api), `${name} mentions ${api}`).toBe(false);
      }
    }
  });

  it("names the metrics under com.liberty-avs-*, since no standard name exists", () => {
    // Not CMCD v2, not CTA-2066, not ISO/IEC 23009-1 defines a drift metric.
    for (const metric of [...Object.values(AV_PROXY_METRICS), AV_LIP_SYNC_METRIC]) {
      expect(metric.startsWith("com.liberty-avs-")).toBe(true);
    }
  });
});

describe("the composed report", () => {
  it("is never empty and always covers all four arms", () => {
    for (const report of REPORTS) {
      expect(report.findings.length).toBe(5);
      expect(report.findings.map((finding) => finding.metric)).toEqual([
        AV_LIP_SYNC_METRIC,
        AV_PROXY_METRICS.videoHole,
        AV_PROXY_METRICS.mediaTimeAdvance,
        AV_PROXY_METRICS.presentedFrameGap,
        AV_PROXY_METRICS.sequenceModeAssertion
      ]);
    }
  });

  it("stamps the policy version and the caller's instant, and reads no clock", () => {
    const report = observeAvContinuity(input());
    expect(report.policyVersion).toBe(DEFAULT_AV_CONTINUITY_POLICY.version);
    expect(report.observedAtMs).toBe(OBSERVED_AT_MS);
    // Byte-identical for identical inputs, so a report can be reproduced from a
    // bug report rather than approximately re-observed.
    expect(JSON.stringify(observeAvContinuity(input()))).toBe(JSON.stringify(report));
  });

  it("says so out loud when there were no per-track SourceBuffers", () => {
    const report = observeAvContinuity(input({ buffered: null }));
    const hole = report.findings[1];
    expect(hole?.evidenceBasis).toBe("unobservable");
    expect(hole?.reasons.map((reason) => reason.code)).toContain(
      "element_buffered_is_intersection"
    );
  });

  it("counts findings without collapsing the distinction between them", () => {
    const summary = summariseAvContinuity(observeAvContinuity(input()));
    expect(summary.proxiesFired).toBe(1); // the video hole
    expect(summary.unobservable).toBe(1); // lip-sync offset
    expect(summary.externalMeasurements).toBe(0);
    expect(summary.proxiesFired + summary.proxiesQuiet + summary.unobservable).toBe(5);
  });
});
