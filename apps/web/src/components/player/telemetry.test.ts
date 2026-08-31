/* -------------------------------------------------------------------------
 * The CMCD configuration seam, under test (PL-0503)
 *
 * This file had no tests. That mattered more than it usually does, because
 * every control in `telemetry.ts` is a control over what leaves the browser and
 * none of them is visible in the type of what it returns: `EngineConfig` is
 * `Readonly<Record<string, unknown>>`, so a configuration that requested `url`
 * would type-check exactly as well as one that does not.
 *
 * THE ASSERTIONS ARE WRITTEN AGAINST THE REGISTRY, NOT AGAINST A REMEMBERED
 * KEY LIST. `CMCD_V2_URL_BEARING_KEYS` is the same derivation `includeKeys`
 * excludes by, so adding a URL-bearing key to `@liberty/observability` extends
 * this test in the same edit. A test that spelled out "url, nor, h" would keep
 * passing after the fourth one was added and would be the exact failure it
 * exists to prevent.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: transport, batching, retry and the
 * queue. All four belong to shaka-player's vendored `CmcdReporter`, this file
 * configures them and cannot observe them, and asserting them from here would
 * be asserting a mock of somebody else's code. What the reporter does when the
 * sink fails is recorded in the audit for this task, not simulated here.
 * ---------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CMCD_V2_CLIENT_SAFE_KEYS, CMCD_V2_URL_BEARING_KEYS } from "@liberty/observability";
import {
  CMCD_DISABLED,
  PLAYBACK_TELEMETRY_DEFAULTS,
  PLAYBACK_TELEMETRY_EVENTS,
  isFirstPartyCollectorPath,
  isTransmittableIdentifier,
  playbackTelemetryConfig,
  type PlaybackTelemetryOptions
} from "./telemetry";
import type { EngineConfig } from "./engine";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "telemetry.ts"), "utf8");

/**
 * The source with its comments removed.
 *
 * The clock scan below would otherwise read the prose: the header explains that
 * Shaka mints a `crypto.randomUUID()` when handed an empty session id, which is
 * exactly the sentence a naive search for `randomUUID` would trip on. Scanning
 * the comments as though they were code is how a source-scan test earns a
 * reputation for false positives and then gets deleted.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");

/** A real `crypto.randomUUID()` shape, because that is what the session issues. */
const SESSION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** A lowercase-kebab slug, which is what `normalizedContentIdSchema` permits. */
const CONTENT_ID = "the-northstar-affair";

const OPTIONS: PlaybackTelemetryOptions = {
  enabled: true,
  contentId: CONTENT_ID,
  sessionId: SESSION_ID,
  collectorPath: "/api/v1/telemetry/cmcd",
  ...PLAYBACK_TELEMETRY_DEFAULTS
};

function config(overrides: Partial<PlaybackTelemetryOptions> = {}): EngineConfig {
  return playbackTelemetryConfig({ ...OPTIONS, ...overrides });
}

function record(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${what} to be a record`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Validates a string array and returns THE SAME ARRAY, not a copy.
 *
 * The identity matters for the mutation test: Shaka stores `includeKeys` by
 * reference and mutates its own configuration tree, so the question that test
 * asks is whether the array it was handed is reachable from the shared
 * derivation in `@liberty/observability`. A defensive copy here would answer a
 * different question and pass regardless.
 */
function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`expected ${what} to be an array`);
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`expected ${what} to hold strings`);
  }
  return value as string[];
}

function cmcd(engineConfig: EngineConfig): Readonly<Record<string, unknown>> {
  return record(record(engineConfig, "the engine config").cmcd, "the cmcd block");
}

function eventTarget(engineConfig: EngineConfig): Readonly<Record<string, unknown>> {
  const targets = cmcd(engineConfig).eventTargets;
  if (!Array.isArray(targets) || targets.length !== 1) {
    throw new Error("expected exactly one event target");
  }
  return record(targets[0], "the event target");
}

describe("nothing URL-bearing is ever requested", () => {
  it("excludes every key the registry classifies as URL-bearing, in both modes", () => {
    const enabled = config();
    const requestMode = strings(cmcd(enabled).includeKeys, "includeKeys");
    const eventMode = strings(eventTarget(enabled).includeKeys, "the target's includeKeys");

    expect(CMCD_V2_URL_BEARING_KEYS.length).toBeGreaterThan(0);
    for (const key of CMCD_V2_URL_BEARING_KEYS) {
      expect(requestMode, key).not.toContain(key);
      expect(eventMode, key).not.toContain(key);
    }
    expect(requestMode).toEqual([...CMCD_V2_CLIENT_SAFE_KEYS]);
    expect(eventMode).toEqual([...CMCD_V2_CLIENT_SAFE_KEYS]);
  });

  it("requests a non-empty allowlist, because empty means ALL keys to Shaka", () => {
    /*
     * `CmcdManager.toReporterConfig_` substitutes `allKeysForVersion_(2)` for an
     * empty `includeKeys`, and that expansion contains `url` and `nor`. So this
     * is not a check that the list is populated, it is a check that the config
     * never fails open.
     */
    expect(strings(cmcd(config()).includeKeys, "includeKeys").length).toBeGreaterThan(0);
    expect(strings(eventTarget(config()).includeKeys, "target includeKeys").length)
      .toBeGreaterThan(0);
  });

  it("does not subscribe to the one event that carries a media URL", () => {
    /*
     * `CmcdReporter.recordResponseReceived` builds `url` from the requested URI
     * with only the CMCD query parameter removed — a CDN signature survives it.
     * `rr` is the event that carries it, and it is absent from `events`, so the
     * report is never even queued. The `includeKeys` filter above would strip
     * `url` anyway; this is the second, independent control.
     */
    expect(PLAYBACK_TELEMETRY_EVENTS).not.toContain("rr");
    expect(strings(eventTarget(config()).events, "events")).toEqual(["ps", "bc", "e", "t"]);
  });

  it("requests no URL-bearing key anywhere in the configuration", () => {
    /*
     * Searches every string VALUE in the config, at any depth, rather than the
     * serialised text.
     *
     * The first version searched the JSON for `"url"` and failed on the config
     * it was written to protect: the event target's own `url` PROPERTY names our
     * collector endpoint. A CMCD key and a configuration field can share a
     * spelling, and a text search cannot tell a key being requested from a field
     * being set -- so it reported a leak that was not there, which costs exactly
     * as much trust as missing one that is.
     *
     * Walking values keeps the property this test exists for. CMCD keys are only
     * ever REQUESTED as strings in a list, so a key arriving through some future
     * nested option is still caught wherever it appears, while a field named
     * `url` whose value is a path is not a key request and is left alone.
     */
    const values: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") values.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === "object" && node !== null) Object.values(node).forEach(walk);
    };
    walk(config());

    for (const key of CMCD_V2_URL_BEARING_KEYS) {
      expect(values, key).not.toContain(key);
    }
  });

  it("hands Shaka copies, so it cannot mutate the shared registry derivation", () => {
    const before = [...CMCD_V2_CLIENT_SAFE_KEYS];
    const enabled = config();
    const requestMode = strings(cmcd(enabled).includeKeys, "includeKeys");
    const eventMode = strings(eventTarget(enabled).includeKeys, "target includeKeys");

    expect(requestMode).not.toBe(CMCD_V2_CLIENT_SAFE_KEYS);
    expect(eventMode).not.toBe(requestMode);

    requestMode.push("url");
    expect([...CMCD_V2_CLIENT_SAFE_KEYS]).toEqual(before);
    expect(eventMode).toEqual(before);
    expect(strings(eventTarget(config()).includeKeys, "a fresh target")).toEqual(before);
  });
});

describe("the identifiers that reach the CDN", () => {
  it("accepts the opaque correlation id the playback session actually issues", () => {
    expect(isTransmittableIdentifier(SESSION_ID, "sid")).toBe(true);
    expect(isTransmittableIdentifier(CONTENT_ID, "cid")).toBe(true);
  });

  it("refuses a URL, which is how a signed manifest would ride out under a safe key", () => {
    const signed = "https://cdn.example.com/northstar/1080p.m3u8?Signature=SECRET";
    expect(isTransmittableIdentifier(signed, "cid")).toBe(false);
    expect(config({ contentId: signed })).toEqual(CMCD_DISABLED);
    expect(config({ sessionId: signed })).toEqual(CMCD_DISABLED);
  });

  it("refuses a locator with no scheme, which `looksLikeUrl` alone does not see", () => {
    // A protocol-relative URL and a bare signed path are both ordinary ways to
    // write a manifest reference, and neither carries a scheme.
    expect(isTransmittableIdentifier("//cdn.example.com/northstar.m3u8", "cid")).toBe(false);
    expect(isTransmittableIdentifier("northstar/1080p.m3u8", "cid")).toBe(false);
    expect(isTransmittableIdentifier("northstar?Signature=SECRET", "cid")).toBe(false);
    expect(config({ contentId: "//cdn.example.com/northstar.m3u8" })).toEqual(CMCD_DISABLED);
  });

  it("refuses anything longer than CTA-5004-B's own bound for the key", () => {
    // 64 for `sid`, 128 for `cid`, both read from the registry rather than
    // restated — which is why the two bounds differ here.
    expect(isTransmittableIdentifier("x".repeat(64), "sid")).toBe(true);
    expect(isTransmittableIdentifier("x".repeat(65), "sid")).toBe(false);
    expect(isTransmittableIdentifier("x".repeat(128), "cid")).toBe(true);
    expect(isTransmittableIdentifier("x".repeat(129), "cid")).toBe(false);
    expect(config({ sessionId: "x".repeat(65) })).toEqual(CMCD_DISABLED);
  });

  it("refuses the empty string rather than letting Shaka mint an uncorrelatable id", () => {
    expect(isTransmittableIdentifier("", "sid")).toBe(false);
    expect(config({ contentId: "" })).toEqual(CMCD_DISABLED);
    expect(config({ sessionId: "" })).toEqual(CMCD_DISABLED);
  });
});

describe("the collector target can only be our own origin", () => {
  it("accepts an absolute same-origin path", () => {
    expect(isFirstPartyCollectorPath("/api/v1/telemetry/cmcd")).toBe(true);
    expect(eventTarget(config()).url).toBe("/api/v1/telemetry/cmcd");
  });

  it("refuses a full URL, a protocol-relative URL, a backslash and a relative path", () => {
    for (const path of [
      "https://collector.example.com/cmcd",
      "//collector.example.com/cmcd",
      "/\\collector.example.com/cmcd",
      "api/v1/telemetry/cmcd",
      ""
    ]) {
      expect(isFirstPartyCollectorPath(path), path).toBe(false);
      expect(config({ collectorPath: path }), path).toEqual(CMCD_DISABLED);
    }
  });
});

describe("a telemetry misconfiguration cannot take playback down", () => {
  it("returns a disabled block rather than throwing, for every rejection", () => {
    expect(() => config({ collectorPath: "https://evil.example.com" })).not.toThrow();
    expect(() => config({ sessionId: "" })).not.toThrow();
    expect(config({ enabled: false })).toEqual(CMCD_DISABLED);
  });

  it("states `enabled: false` rather than omitting the block", () => {
    // `PlaybackController` replays its configuration history onto every player
    // it builds, so an ABSENT `cmcd` block leaves a previous call's value in
    // force. Only a stated `false` actually turns CMCD off.
    expect(CMCD_DISABLED).toEqual({ cmcd: { enabled: false } });
    expect(record(config({ enabled: false }), "disabled").cmcd).toEqual({ enabled: false });
  });
});

describe("the protocol version and the unit that is not milliseconds", () => {
  it("states version 2, because Shaka's default is 1 and v1 has no Event Mode", () => {
    expect(cmcd(config()).version).toBe(2);
  });

  it("passes the interval in SECONDS, which Shaka multiplies by 1000 itself", () => {
    // `CmcdReporter.start()` arms `setInterval(fn, config.interval * 1000)`.
    // This is the one number in this task that is not milliseconds, and the
    // field name is where that is recorded.
    expect(PLAYBACK_TELEMETRY_DEFAULTS.intervalSeconds).toBe(30);
    expect(eventTarget(config()).interval).toBe(30);
    expect(eventTarget(config({ intervalSeconds: 5 })).interval).toBe(5);
  });

  it("sends CMCD as a query parameter, never as a preflighting header", () => {
    expect(cmcd(config()).useHeaders).toBe(false);
  });
});

describe("determinism", () => {
  it("returns an identical configuration for identical options", () => {
    expect(JSON.stringify(config())).toBe(JSON.stringify(config()));
  });

  it("reads no clock and no random source", () => {
    // A session id nobody chose is a session id nobody can correlate a
    // server-side log against, so `sessionId` is an input and this file has no
    // way to invent one.
    for (const forbidden of ["Date.now", "new Date", "Math.random", "randomUUID", "performance."]) {
      expect(CODE, forbidden).not.toContain(forbidden);
    }
  });
});
