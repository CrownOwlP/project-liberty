/* -------------------------------------------------------------------------
 * Failure reporting: the class is named and nothing else survives
 * (Wave 132, Worker E).
 *
 * The redaction block is an attack list, not an example list. Every string in it
 * is a shape a real playback error arrives in.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import {
  STREAM_FAILURE_CLASSES,
  classifyStreamFailure,
  describeStreamFailure,
  redactStreamDetail
} from "./stream-errors";

describe("redaction", () => {
  const hostile = [
    "GET https://edge.example.invalid/live/aurora/index.m3u8?hdnts=exp=1760000000~hmac=deadbeefcafebabe1234 failed",
    "https://user:s3cr3tpassword@edge.example.invalid/a.m3u8 refused",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpayloadpayload.signature",
    "token=abcdefghijklmnopqrstuvwxyz0123456789",
    "connect ECONNREFUSED 203.0.113.17:8443",
    "licence request to https://drm.example.invalid/licence?keyid=0123456789abcdef0123 failed",
    "manifest at edge.example.invalid/live/aurora/index.m3u8 is unsupported"
  ];

  it("leaves no scheme, host, address, query or long opaque token behind", () => {
    for (const detail of hostile) {
      const redacted = redactStreamDetail(detail);
      expect(redacted, detail).not.toMatch(/[a-z]+:\/\//i);
      expect(redacted, detail).not.toContain("example.invalid");
      expect(redacted, detail).not.toContain("?");
      expect(redacted, detail).not.toContain("@");
      expect(redacted, detail).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(redacted, detail).not.toMatch(/[A-Za-z0-9_-]{20,}/);
      expect(redacted, detail).not.toContain("s3cr3tpassword");
      expect(redacted, detail).not.toContain("deadbeefcafebabe1234");
    }
  });

  it("keeps the part of the message a human can act on", () => {
    expect(redactStreamDetail("manifest at edge.example.invalid/a.m3u8 is unsupported")).toContain(
      "unsupported"
    );
    expect(redactStreamDetail("connect ECONNREFUSED 203.0.113.17:8443")).toContain("ECONNREFUSED");
  });

  it("is total: it returns a string for every degenerate input", () => {
    for (const input of ["", "   ", "?", "://", "@", "a".repeat(5000)]) {
      expect(typeof redactStreamDetail(input)).toBe("string");
    }
  });

  it("bounds its own output", () => {
    expect(redactStreamDetail("x ".repeat(5000)).length).toBeLessThanOrEqual(400);
  });
});

describe("classification", () => {
  it("honours a class this codebase decided rather than inferring one from text", () => {
    const feed = classifyStreamFailure({ knownClass: "feed_not_configured" });
    expect(feed.failureClass).toBe("feed_not_configured");
    expect(feed.retryable).toBe(false);
    expect(feed.operatorAction).toBe(true);

    const rights = classifyStreamFailure({ knownClass: "channel_not_authorized" });
    expect(rights.failureClass).toBe("channel_not_authorized");
    expect(rights.retryable).toBe(false);
  });

  it("reports offline ahead of everything else", () => {
    expect(classifyStreamFailure({ offline: true, status: 500 }).failureClass).toBe("network_offline");
  });

  it("maps the statuses that mean different things", () => {
    expect(classifyStreamFailure({ status: 403 }).failureClass).toBe("manifest_rejected");
    expect(classifyStreamFailure({ status: 404 }).failureClass).toBe("manifest_unreachable");
    expect(classifyStreamFailure({ status: 504 }).failureClass).toBe("timed_out");
    expect(classifyStreamFailure({ status: 503 }).retryable).toBe(true);
  });

  it("falls back to the redacted text, never the raw text", () => {
    const report = classifyStreamFailure({
      detail: "https://edge.example.invalid/a.m3u8 timed out after 30s"
    });
    expect(report.failureClass).toBe("timed_out");
    expect(report.redactedDetail).not.toContain("example.invalid");
  });

  it("reports unclassified rather than guessing", () => {
    expect(classifyStreamFailure({ detail: "something odd happened" }).failureClass).toBe(
      "unclassified"
    );
    expect(classifyStreamFailure({}).failureClass).toBe("unclassified");
  });

  it("never carries an address onto the report, whatever it was handed", () => {
    const report = classifyStreamFailure({
      status: 403,
      detail: "https://edge.example.invalid/live/a.m3u8?hdnts=exp=1760000000~hmac=deadbeefcafebabe"
    });
    expect(JSON.stringify(report)).not.toContain("example.invalid");
    expect(JSON.stringify(report)).not.toContain("hmac");
  });
});

describe("the viewer-facing sentences", () => {
  it("has one for every class, and none of them is empty or an address", () => {
    for (const failureClass of STREAM_FAILURE_CLASSES) {
      const sentence = describeStreamFailure(failureClass);
      expect(sentence.length, failureClass).toBeGreaterThan(20);
      expect(sentence).not.toContain("http");
    }
  });

  it("says plainly that no licensed feed is configured, and that retrying will not help", () => {
    const sentence = describeStreamFailure("feed_not_configured");
    expect(sentence).toContain("no licensed live feed configured");
    expect(sentence).toContain("retrying will not change the answer");
  });
});
