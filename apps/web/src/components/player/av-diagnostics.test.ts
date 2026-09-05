import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectCmcdEventReport, isLibertyCustomKey } from "@liberty/observability";
import {
  AV_REPORT_KEYS,
  avContinuityCmcdEvent,
  avContinuityEmissionKey,
  avFindingViews,
  describeProxyMagnitude,
  findVideoFrameCallbackTarget,
  frameEvidenceFrom,
  observeAvDiagnostics,
  readAvBufferedEvidence,
  readEngineConfiguration,
  type AvDiagnosticsSnapshot
} from "./av-diagnostics";
import { AV_LIP_SYNC_METRIC, AV_PROXY_METRICS, type VideoFrameReading } from "./diagnostics";

/* -------------------------------------------------------------------------
 * The wiring, under test.
 *
 * `diagnostics/` has 77 tests about what the findings MEAN. What is pinned here
 * is the thing only the caller can get wrong: reading the per-track evidence
 * from the right place, telling the two frame absences apart, recording where
 * the evidence came from, and -- above all -- not producing a millisecond number
 * anywhere on the way to a panel or a collector.
 *
 * apps/web runs vitest with NO DOM. Nothing here mounts a component; every
 * decision the surface makes is a pure function in `av-diagnostics.ts` and this
 * file tests those, which is the pattern `playback-machine.test.ts` and
 * `search-sync.test.ts` already use.
 * ---------------------------------------------------------------------- */

const SESSION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const CONTENT_ID = "the-northstar-affair";

const FRAME: VideoFrameReading = {
  presentationTimeMs: 1_000,
  expectedDisplayTimeMs: 1_016,
  mediaTimeSeconds: 12,
  presentedFrames: 400,
  processingDurationMs: 3
};

/** A `shaka.extern.BufferedInfo`-shaped result with a real video hole. */
const BUFFERED_INFO = {
  total: [{ start: 0, end: 10 }],
  video: [
    { start: 0, end: 10 },
    { start: 12, end: 20 }
  ],
  audio: [{ start: 0, end: 20 }],
  text: []
};

function playerWith(info: unknown, configuration?: unknown): unknown {
  return {
    getBufferedInfo: () => info,
    getConfiguration: () => configuration
  };
}

function snapshotWith(player: unknown, playheadSeconds: number | null): AvDiagnosticsSnapshot {
  return observeAvDiagnostics({
    observedAtMs: 1_700_000_000_000,
    buffered: readAvBufferedEvidence(player, playheadSeconds),
    frames: frameEvidenceFrom([], true),
    engineConfig: readEngineConfiguration(player)
  });
}

describe("reading the per-track evidence", () => {
  it("reads the video and audio arrays and never the intersected total", () => {
    /*
     * `Player.getBufferedInfo` delegates to `MediaSourceEngine.getBufferedInfo`
     * under MSE, which builds `audio` and `video` from
     * `sourceBuffers_.get(contentType).buffered` -- one SourceBuffer per track.
     * `total` is the element's intersected view, which `buffered-ranges.ts`
     * explains is structurally incapable of showing a video-only gap.
     */
    const evidence = readAvBufferedEvidence(playerWith(BUFFERED_INFO), 11);

    expect(evidence?.video.ranges).toEqual([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 12, endSeconds: 20 }
    ]);
    expect(evidence?.audio.ranges).toEqual([{ startSeconds: 0, endSeconds: 20 }]);
    expect(evidence?.video.source).toBe("source-buffer");
    expect(evidence?.audio.track).toBe("audio");
  });

  it("answers null when nothing was read, from any source", () => {
    expect(readAvBufferedEvidence(playerWith(BUFFERED_INFO), null)).toBeNull();
    expect(readAvBufferedEvidence(null, 11)).toBeNull();
    expect(readAvBufferedEvidence({}, 11)).toBeNull();
    expect(readAvBufferedEvidence(playerWith("not an info object"), 11)).toBeNull();
    expect(
      readAvBufferedEvidence(
        {
          getBufferedInfo: () => {
            throw new Error("MediaSource is closed");
          }
        },
        11
      )
    ).toBeNull();
  });

  it("treats two empty tracks as no evidence rather than as two empty readings", () => {
    /*
     * `getBufferedInfo` returns empty `audio`/`video` arrays when content was
     * loaded through `src=` rather than MSE -- there are no SourceBuffers at all
     * -- and also before anything has been buffered. Neither is evidence, and
     * passing a pair of empty readings through would make `detectVideoHole` say
     * a track "reported no usable ranges", which asserts a reading that did not
     * happen. `total` is deliberately not a fallback.
     */
    expect(
      readAvBufferedEvidence(
        playerWith({ total: [{ start: 0, end: 30 }], video: [], audio: [], text: [] }),
        11
      )
    ).toBeNull();
  });

  it("passes one empty track through, because that is a real reading", () => {
    const evidence = readAvBufferedEvidence(
      playerWith({ total: [], video: [{ start: 0, end: 10 }], audio: [], text: [] }),
      5
    );
    expect(evidence?.video.ranges).toHaveLength(1);
    expect(evidence?.audio.ranges).toEqual([]);
  });

  it("drops a range member it cannot read rather than inventing a number", () => {
    const evidence = readAvBufferedEvidence(
      playerWith({
        video: [{ start: 0, end: 10 }, { start: "soon", end: 20 }, { start: 30 }],
        audio: [{ start: 0, end: 20 }]
      }),
      5
    );
    expect(evidence?.video.ranges).toEqual([{ startSeconds: 0, endSeconds: 10 }]);
  });

  it("reads the effective configuration, or says it could not", () => {
    const configuration = { manifest: { dash: { sequenceMode: false } } };
    expect(readEngineConfiguration(playerWith(null, configuration))).toEqual(configuration);
    expect(readEngineConfiguration(playerWith(null))).toBeNull();
    expect(readEngineConfiguration(null)).toBeNull();
    expect(
      readEngineConfiguration({
        getConfiguration: () => {
          throw new Error("destroyed");
        }
      })
    ).toBeNull();
  });
});

describe("the two frame absences are not the same fact", () => {
  it("says `callback-unsupported` only when the API is not there", () => {
    expect(frameEvidenceFrom([], false)).toBe("callback-unsupported");
    expect(frameEvidenceFrom([FRAME, FRAME], false)).toBe("callback-unsupported");
  });

  it("says `awaiting-second-callback` while the window is still filling", () => {
    // A statement about THIS INSTANT, which stops being true in about sixteen
    // milliseconds. Reporting it as missing browser support would be a claim
    // about a platform derived from a stopwatch.
    expect(frameEvidenceFrom([], true)).toBe("awaiting-second-callback");
    expect(frameEvidenceFrom([FRAME], true)).toBe("awaiting-second-callback");
  });

  it("pairs the two most recent readings, oldest first", () => {
    const older: VideoFrameReading = { ...FRAME, presentedFrames: 400 };
    const newer: VideoFrameReading = { ...FRAME, presentedFrames: 401 };
    expect(frameEvidenceFrom([older, newer], true)).toEqual({ previous: older, current: newer });
  });

  it("finds the frame callback on the host or on its inner element", () => {
    const callback = () => undefined;
    expect(findVideoFrameCallbackTarget({ requestVideoFrameCallback: callback })).not.toBeNull();
    expect(
      findVideoFrameCallbackTarget({ nativeEl: { requestVideoFrameCallback: callback } })
    ).not.toBeNull();
    expect(findVideoFrameCallbackTarget({ nativeEl: {} })).toBeNull();
    expect(findVideoFrameCallbackTarget(null)).toBeNull();
  });
});

describe("provenance travels beside the report", () => {
  it("records that the configuration was unreadable, which the finding cannot", () => {
    /*
     * `assertSegmentsMode(null)` fires with `sequence_mode_unstated`, whose
     * detail says the configuration does not state a value. That is true when
     * the configuration WAS read and was silent. It is a different fact from
     * "we could not read the configuration", and the finding never learns which
     * happened -- so a fired sequence-mode proxy is only readable against this.
     */
    const unreadable = snapshotWith(playerWith(BUFFERED_INFO), 11);
    expect(unreadable.engineConfigSource).toBe("not-readable");

    const read = snapshotWith(
      playerWith(BUFFERED_INFO, { manifest: { dash: { sequenceMode: false } } }),
      11
    );
    expect(read.engineConfigSource).toBe("player-configuration");
  });

  it("records whether per-track ranges were readable at all", () => {
    expect(snapshotWith(playerWith(BUFFERED_INFO), 11).bufferedSource).toBe(
      "per-track-source-buffer"
    );
    expect(snapshotWith(playerWith(BUFFERED_INFO), null).bufferedSource).toBe("not-readable");
  });

  it("keeps fired, quiet and unobservable apart in the summary", () => {
    // `proxiesFired === 0` is not "healthy": a browser that implements none of
    // the optional metrics produces zero fired and zero quiet.
    const snapshot = snapshotWith(playerWith(BUFFERED_INFO), 11);
    expect(snapshot.summary.proxiesFired).toBeGreaterThan(0);
    expect(snapshot.summary.unobservable).toBeGreaterThan(0);
    expect(snapshot.summary.externalMeasurements).toBe(0);
  });
});

describe("no millisecond sync claim can come out of here", () => {
  const snapshot = snapshotWith(playerWith(BUFFERED_INFO), 11);
  const views = avFindingViews(snapshot.report);

  it("always reports lip-sync offset as unobservable, with no magnitude", () => {
    const lipSync = views.find((view) => view.metric === AV_LIP_SYNC_METRIC);
    expect(lipSync?.state).toBe("unobservable");
    expect(lipSync?.magnitude).toBeNull();
    expect(lipSync?.reasonCodes).toContain("no_audio_clock_in_browser");
    expect(lipSync?.reasonCodes).toContain("external_measurement_required");
  });

  it("renders a magnitude with its unit in words, and has no millisecond branch", () => {
    // `AvProxyMagnitude` is a union of seconds-of-media-timeline and a frame
    // count. There is no third branch, so there is nothing here that could
    // render "ms".
    expect(describeProxyMagnitude({ unit: "seconds-of-media-timeline", seconds: 2 })).toBe(
      "2.000s of media timeline"
    );
    expect(describeProxyMagnitude({ unit: "frames-presented", frames: 3 })).toBe(
      "3 frames presented"
    );
    expect(describeProxyMagnitude(null)).toBeNull();

    const hole = views.find((view) => view.metric === AV_PROXY_METRICS.videoHole);
    expect(hole?.state).toBe("fired");
    expect(hole?.magnitude).toBe("2.000s of media timeline");
    for (const view of views) {
      expect(view.magnitude ?? "", view.metric).not.toContain("ms");
    }
  });

  it("does not mention audioAheadMs anywhere in its own code", () => {
    /*
     * A source scan, in the style `av-continuity.test.ts` uses for the
     * prohibited instrumentation APIs, and for the same reason: the rule is
     * enforced rather than written down. Comments are stripped first, because
     * the prose above necessarily discusses the field it forbids -- scanning
     * comments as though they were code is how a source-scan test earns a
     * reputation for false positives and then gets deleted.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["av-diagnostics.ts", "player-surface.tsx", "cmcd-beacon.ts"]) {
      const code = readFileSync(join(here, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/^[ \t]*\/\/[^\n]*$/gm, "");
      expect(code.includes("audioAheadMs"), name).toBe(false);
    }
  });
});

describe("the report that reaches the collector", () => {
  const snapshot = snapshotWith(playerWith(BUFFERED_INFO), 11);
  const event = avContinuityCmcdEvent({
    snapshot,
    identifiers: { contentId: CONTENT_ID, sessionId: SESSION_ID },
    // Deliberately fractional: CTA-5004-B types `ts` as an integer and the
    // collector rejects a non-integer rather than recording it.
    nowMs: 1_700_000_000_000.7
  });

  it("carries states, never magnitudes", () => {
    const states = ["fired", "quiet", "unobservable", "external-measurement"];
    for (const metric of [...Object.values(AV_PROXY_METRICS), AV_LIP_SYNC_METRIC]) {
      expect(states, metric).toContain(event[metric]);
    }
    expect(event[AV_LIP_SYNC_METRIC]).toBe("unobservable");
  });

  it("puts a number under nothing but the timestamp and the three counts", () => {
    const numeric = Object.keys(event).filter((key) => typeof event[key] === "number");
    expect(numeric.sort()).toEqual(
      [
        AV_REPORT_KEYS.proxiesFired,
        AV_REPORT_KEYS.proxiesQuiet,
        AV_REPORT_KEYS.unobservable,
        "ts"
      ].sort()
    );
    expect(event["ts"]).toBe(1_700_000_000_000);
  });

  it("uses key names CTA-5004-B and the collector both accept", () => {
    for (const key of Object.keys(event)) {
      if (!key.startsWith("com.liberty-")) continue;
      expect(isLibertyCustomKey(key), key).toBe(true);
    }
  });

  it("survives the collector as custom fields, with no rejections", () => {
    const collected = collectCmcdEventReport({
      payload: { events: [event] },
      receivedAtMs: 1_700_000_000_000,
      requestId: null
    });

    expect(collected.ok).toBe(true);
    expect(collected.rejections).toEqual([]);
    const fields = collected.logs[0]?.fields ?? {};
    expect(fields[`cmcd.custom.${AV_LIP_SYNC_METRIC}`]).toBe("unobservable");
    expect(fields[`cmcd.custom.${AV_PROXY_METRICS.videoHole}`]).toBe("fired");
    expect(fields["cmcd.sid"]).toBe(SESSION_ID);
    // `e: "t"` is the interval event type, which is what a periodic report is.
    expect(collected.logs[0]?.event).toBe("playback.cmcd.interval");
  });

  it("ignores the timestamp when deciding whether a report has changed", () => {
    const later = avContinuityCmcdEvent({
      snapshot,
      identifiers: { contentId: CONTENT_ID, sessionId: SESSION_ID },
      nowMs: 1_700_000_099_000
    });
    expect(avContinuityEmissionKey(later)).toBe(avContinuityEmissionKey(event));

    const different = avContinuityCmcdEvent({
      snapshot: snapshotWith(playerWith(BUFFERED_INFO), null),
      identifiers: { contentId: CONTENT_ID, sessionId: SESSION_ID },
      nowMs: 1_700_000_000_000
    });
    expect(avContinuityEmissionKey(different)).not.toBe(avContinuityEmissionKey(event));
  });

  it("is deterministic for an identical observation", () => {
    expect(JSON.stringify(event)).toBe(
      JSON.stringify(
        avContinuityCmcdEvent({
          snapshot: snapshotWith(playerWith(BUFFERED_INFO), 11),
          identifiers: { contentId: CONTENT_ID, sessionId: SESSION_ID },
          nowMs: 1_700_000_000_000.7
        })
      )
    );
  });
});
