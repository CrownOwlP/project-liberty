import { describe, expect, it } from "vitest";
import { CMCD_DISABLED, isFirstPartyCollectorPath } from "./telemetry";
import {
  CMCD_COLLECTOR_PATH,
  PLAYBACK_TELEMETRY_DEFAULTS,
  decidePlaybackTelemetry,
  mintTelemetrySessionId,
  type PlaybackTelemetryInput,
  type PlaybackTelemetryReasonCode
} from "./telemetry-decision";

/* -------------------------------------------------------------------------
 * The decision, under test.
 *
 * `telemetry.test.ts` already pins what the configuration seam PRODUCES: that
 * no URL-bearing key is ever requested, that an empty allowlist fails closed,
 * that the identifiers are validated. What is pinned here is the thing that
 * file deliberately does not have -- WHICH refusal happened -- because
 * `playbackTelemetryConfig` answers every one of them with the identical
 * disabled block, and an operator cannot tell a deliberate opt-out from a
 * misconfiguration by looking at it.
 * ---------------------------------------------------------------------- */

/** A real `crypto.randomUUID()` shape, which is what a session id is. */
const SESSION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** A lowercase-kebab slug, which is what `normalizedContentIdSchema` permits. */
const CONTENT_ID = "the-northstar-affair";

const INPUT: PlaybackTelemetryInput = {
  enabled: true,
  contentId: CONTENT_ID,
  sessionId: SESSION_ID,
  collectorPath: CMCD_COLLECTOR_PATH,
  ...PLAYBACK_TELEMETRY_DEFAULTS
};

function decide(overrides: Partial<PlaybackTelemetryInput> = {}) {
  return decidePlaybackTelemetry({ ...INPUT, ...overrides });
}

function codeOf(overrides: Partial<PlaybackTelemetryInput>): PlaybackTelemetryReasonCode {
  return decide(overrides).reasons[0].code;
}

describe("the enabled decision", () => {
  it("turns CMCD on and says so", () => {
    const decision = decide();

    expect(decision.enabled).toBe(true);
    expect(decision.reasons[0].code).toBe("cmcd_configured");
    expect(decision.config).not.toEqual(CMCD_DISABLED);
  });

  it("publishes the identifiers only once both have been validated", () => {
    // This is the only place in the player that has decided `cid` and `sid` are
    // safe to send. PL-0504's emitter takes them from here rather than from the
    // props, so there is no second, unguarded path for an identifier to leave.
    expect(decide().identifiers).toEqual({ contentId: CONTENT_ID, sessionId: SESSION_ID });
    expect(decide({ sessionId: null }).identifiers).toBeNull();
    expect(decide({ contentId: "https://cdn.example.com/x.m3u8" }).identifiers).toBeNull();
  });

  it("points at a path that can only resolve to our own origin", () => {
    expect(isFirstPartyCollectorPath(CMCD_COLLECTOR_PATH)).toBe(true);
  });
});

describe("every refusal names itself", () => {
  it("distinguishes the five ways telemetry ends up off", () => {
    expect(codeOf({ enabled: false })).toBe("telemetry_disabled");
    expect(codeOf({ sessionId: null })).toBe("session_id_unavailable");
    expect(codeOf({ sessionId: "x".repeat(65) })).toBe("session_id_not_transmittable");
    expect(codeOf({ contentId: "https://cdn.example.com/northstar.m3u8?Signature=SECRET" })).toBe(
      "content_id_not_transmittable"
    );
    expect(codeOf({ collectorPath: "https://collector.example.com/cmcd" })).toBe(
      "collector_path_not_first_party"
    );
  });

  it("applies a stated `enabled: false` rather than an absent block", () => {
    // `PlaybackController` replays its configuration history onto every player,
    // so an absent `cmcd` block leaves a previous value in force. Only a stated
    // false actually turns CMCD off.
    for (const overrides of [
      { enabled: false },
      { sessionId: null },
      { contentId: "" },
      { collectorPath: "//evil.example.com/cmcd" }
    ] satisfies Partial<PlaybackTelemetryInput>[]) {
      const decision = decide(overrides);
      expect(decision.enabled, JSON.stringify(overrides)).toBe(false);
      expect(decision.config, JSON.stringify(overrides)).toEqual(CMCD_DISABLED);
    }
  });

  it("never returns an empty reason trail, on any branch", () => {
    for (const overrides of [
      {},
      { enabled: false },
      { sessionId: null },
      { sessionId: "" },
      { contentId: "" },
      { contentId: "northstar/1080p.m3u8" },
      { collectorPath: "" },
      { collectorPath: "/\\evil.example.com" }
    ] satisfies Partial<PlaybackTelemetryInput>[]) {
      const decision = decide(overrides);
      expect(decision.reasons.length, JSON.stringify(overrides)).toBeGreaterThan(0);
      expect(decision.reasons[0].detail.length, JSON.stringify(overrides)).toBeGreaterThan(0);
    }
  });

  it("does not leak the value it refused into the reason it gives", () => {
    // A content id that is a signed URL is refused; the refusal says which
    // check failed and does not quote the URL back into a panel or a log.
    const signed = "https://cdn.example.com/northstar/1080p.m3u8?Signature=SECRET-SIGNATURE";
    expect(JSON.stringify(decide({ contentId: signed }))).not.toContain("SECRET-SIGNATURE");
  });
});

describe("a telemetry misconfiguration cannot take playback down", () => {
  it("returns a decision rather than throwing, for every input", () => {
    for (const overrides of [
      { contentId: "" },
      { sessionId: null },
      { collectorPath: "https://evil.example.com" },
      { batchSize: Number.NaN },
      { intervalSeconds: -1 }
    ] satisfies Partial<PlaybackTelemetryInput>[]) {
      expect(() => decide(overrides), JSON.stringify(overrides)).not.toThrow();
    }
  });
});

describe("minting a session id", () => {
  it("uses the supplied source", () => {
    expect(mintTelemetrySessionId({ randomUUID: () => SESSION_ID })).toBe(SESSION_ID);
  });

  it("returns null rather than inventing one, for every unusable source", () => {
    /*
     * `crypto.randomUUID` exists only in a secure context, so a page served over
     * plain HTTP to something that is not localhost genuinely has no source of
     * one. Every alternative is worse: `Math.random` is not a fleet-unique
     * correlation id, and an empty string is what shaka-player reads as an
     * instruction to invent one -- which produces an id no server-side log can
     * be joined against.
     */
    expect(mintTelemetrySessionId(undefined)).toBeNull();
    expect(mintTelemetrySessionId(null)).toBeNull();
    expect(mintTelemetrySessionId({})).toBeNull();
    expect(mintTelemetrySessionId({ randomUUID: "not a function" })).toBeNull();
    expect(mintTelemetrySessionId({ randomUUID: () => "" })).toBeNull();
    expect(mintTelemetrySessionId({ randomUUID: () => 42 })).toBeNull();
    expect(
      mintTelemetrySessionId({
        randomUUID: () => {
          throw new Error("no entropy available");
        }
      })
    ).toBeNull();
  });

  it("calls the method on its own receiver", () => {
    // `crypto.randomUUID` is a method, and detaching it from its receiver is
    // not portable across engines.
    const source = {
      id: SESSION_ID,
      randomUUID(this: { id: string }): string {
        return this.id;
      }
    };
    expect(mintTelemetrySessionId(source)).toBe(SESSION_ID);
  });
});
