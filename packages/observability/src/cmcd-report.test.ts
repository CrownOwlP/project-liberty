import { describe, expect, it } from "vitest";
import {
  CMCD_REPORT_LIMITS,
  mergeRejections,
  readCmcdEventReport,
  type CmcdEventReportRead
} from "./cmcd-report";

/** Narrows the accepted branch without `!`, and reports the reasons when it cannot. */
function accepted(read: CmcdEventReportRead) {
  if (!read.ok) throw new Error(`expected an accepted report: ${JSON.stringify(read.rejections)}`);
  return read;
}

describe("the envelope", () => {
  it("refuses a payload that is not an object, and returns rather than throws", () => {
    // Anyone who can reach the player can reach the collector, so a thrown
    // parse error here is a way to spend an error budget with someone else's
    // malformed body.
    for (const payload of [null, undefined, 42, "events", true, [], () => undefined]) {
      expect(() => readCmcdEventReport(payload)).not.toThrow();
      expect(readCmcdEventReport(payload).ok, JSON.stringify(payload) ?? "undefined").toBe(false);
    }
  });

  it("names which structural rule failed instead of collapsing both into false", () => {
    expect(readCmcdEventReport(42).rejections).toEqual([
      { reason: "payload_not_an_object", key: null, count: 1 }
    ]);
    expect(readCmcdEventReport({ events: "one" }).rejections).toEqual([
      { reason: "events_not_an_array", key: null, count: 1 }
    ]);
  });

  it("drops a malformed event without discarding the batch around it", () => {
    // Losing thirty real measurements to one bad entry is the failure mode
    // that makes people turn telemetry off.
    const read = accepted(readCmcdEventReport({ events: [{ msd: 1 }, "nope", null, { msd: 2 }] }));
    expect(read.events).toHaveLength(2);
    expect(read.rejections).toEqual([{ reason: "event_not_an_object", key: null, count: 2 }]);
  });

  it("truncates an oversized batch and counts the overflow, not the fact of it", () => {
    const overflow = 5;
    const events = Array.from({ length: CMCD_REPORT_LIMITS.maxEvents + overflow }, () => ({
      msd: 1
    }));

    const read = accepted(readCmcdEventReport({ events }));
    expect(read.events).toHaveLength(CMCD_REPORT_LIMITS.maxEvents);
    expect(read.rejections).toEqual([
      { reason: "event_batch_truncated", key: null, count: overflow }
    ]);
  });

  it("accepts an empty batch, which is what a session with nothing to say sends", () => {
    expect(accepted(readCmcdEventReport({ events: [] })).events).toEqual([]);
  });
});

describe("rejection tallies", () => {
  it("aggregates rather than listing, ordered by reason then key", () => {
    expect(
      mergeRejections(
        [{ reason: "wrong_type", key: "url", count: 1 }],
        [{ reason: "not_finite", key: "msd", count: 2 }],
        [{ reason: "wrong_type", key: "url", count: 3 }]
      )
    ).toEqual([
      { reason: "not_finite", key: "msd", count: 2 },
      { reason: "wrong_type", key: "url", count: 4 }
    ]);
  });

  it("does not depend on the order the lists were merged in", () => {
    const a = [{ reason: "unknown_key", key: null, count: 2 }] as const;
    const b = [{ reason: "not_an_integer", key: "msd", count: 1 }] as const;
    const c = [{ reason: "unknown_key", key: null, count: 5 }] as const;

    expect(mergeRejections(a, b, c)).toEqual(mergeRejections(c, a, b));
    expect(mergeRejections(a, b, c)).toEqual(mergeRejections(b, c, a));
  });

  it("keeps a null key distinct from a named one under the same reason", () => {
    // The two mean different things: a named key is a registry key that failed,
    // a null key is a failure whose key was attacker-controlled and therefore
    // not written down.
    expect(
      mergeRejections(
        [{ reason: "wrong_type", key: null, count: 1 }],
        [{ reason: "wrong_type", key: "msd", count: 1 }]
      )
    ).toEqual([
      { reason: "wrong_type", key: null, count: 1 },
      { reason: "wrong_type", key: "msd", count: 1 }
    ]);
  });
});
