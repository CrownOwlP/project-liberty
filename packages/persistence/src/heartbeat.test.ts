import { describe, expect, it } from "vitest";
import {
  UNDECIDED_PROGRESS_REPORTING_POLICY,
  type ProgressReportingPolicy,
  planProgressWrite
} from "./heartbeat";

/**
 * Progress reporting policy (PL-0403).
 *
 * The most important test in this file is the first one, and it asserts an
 * ABSENCE: no heartbeat interval has been chosen. The research leaves it open as
 * a product decision and asks that a number be picked deliberately with its
 * reason recorded. A default of 30 would look like that decision had been made,
 * and would be quoted back as settled within a month. So the shipped policy
 * refuses heartbeats outright and says why, which is a state somebody has to
 * resolve rather than one they can inherit.
 */

const decided: ProgressReportingPolicy = { heartbeatSeconds: 30, minimumPositionDeltaSeconds: 5 };

describe("UNDECIDED_PROGRESS_REPORTING_POLICY", () => {
  it("has not invented a heartbeat interval", () => {
    expect(UNDECIDED_PROGRESS_REPORTING_POLICY.heartbeatSeconds).toBeNull();
  });

  it("refuses heartbeats with a reason that names the missing decision", () => {
    const decision = planProgressWrite({
      policy: UNDECIDED_PROGRESS_REPORTING_POLICY,
      event: "heartbeat",
      positionSeconds: 900,
      lastWrittenPositionSeconds: 0,
      secondsSinceLastWrite: 100000
    });

    expect(decision).toEqual({ write: false, reason: "heartbeat_interval_not_configured" });
  });

  it("still writes on the events a viewer would notice losing", () => {
    // The interval being undecided must not mean progress is not saved at all.
    // Pause, settled seek and end are unconditional, so an undecided interval
    // degrades reporting granularity and nothing else.
    for (const event of ["pause", "seek_settled", "playback_ended"] as const) {
      expect(
        planProgressWrite({
          policy: UNDECIDED_PROGRESS_REPORTING_POLICY,
          event,
          positionSeconds: 900,
          lastWrittenPositionSeconds: 900,
          secondsSinceLastWrite: 0
        })
      ).toEqual({ write: true, reason: "viewer_visible_event" });
    }
  });
});

describe("planProgressWrite once an interval has been decided", () => {
  it("writes when the interval has elapsed and the position has moved", () => {
    expect(
      planProgressWrite({
        policy: decided,
        event: "heartbeat",
        positionSeconds: 130,
        lastWrittenPositionSeconds: 100,
        secondsSinceLastWrite: 30
      })
    ).toEqual({ write: true, reason: "heartbeat_due" });
  });

  it("distinguishes 'too soon' from 'nothing moved'", () => {
    // Two different remedies. `heartbeat_not_due` means the interval is working;
    // `position_delta_below_threshold` means the interval fired against a
    // player that was not advancing, which is a coalescing win worth counting
    // separately.
    expect(
      planProgressWrite({
        policy: decided,
        event: "heartbeat",
        positionSeconds: 130,
        lastWrittenPositionSeconds: 100,
        secondsSinceLastWrite: 5
      }).reason
    ).toBe("heartbeat_not_due");

    expect(
      planProgressWrite({
        policy: decided,
        event: "heartbeat",
        positionSeconds: 101,
        lastWrittenPositionSeconds: 100,
        secondsSinceLastWrite: 60
      }).reason
    ).toBe("position_delta_below_threshold");
  });

  it("writes a heartbeat that moved BACKWARDS past the threshold", () => {
    // A signed comparison would drop this. A viewer who rewound and then left
    // the player alone would have their new position discarded, and the film
    // would resume where they rewound FROM.
    expect(
      planProgressWrite({
        policy: decided,
        event: "heartbeat",
        positionSeconds: 40,
        lastWrittenPositionSeconds: 100,
        secondsSinceLastWrite: 60
      })
    ).toEqual({ write: true, reason: "heartbeat_due" });
  });

  it("writes the first heartbeat of a session, when there is nothing to compare against", () => {
    expect(
      planProgressWrite({
        policy: decided,
        event: "heartbeat",
        positionSeconds: 0,
        lastWrittenPositionSeconds: null,
        secondsSinceLastWrite: 30
      })
    ).toEqual({ write: true, reason: "heartbeat_due" });
  });

  it("does not treat buffering as progress", () => {
    // Buffering is a playback-quality signal and belongs to
    // `@liberty/observability`. Writing a progress row for it would record a
    // position the viewer is stalled at as though they had watched to it.
    expect(
      planProgressWrite({
        policy: decided,
        event: "buffering_started",
        positionSeconds: 500,
        lastWrittenPositionSeconds: 100,
        secondsSinceLastWrite: 600
      })
    ).toEqual({ write: false, reason: "event_does_not_report_progress" });
  });

  it("is a pure function of its inputs", () => {
    const input = {
      policy: decided,
      event: "heartbeat" as const,
      positionSeconds: 130,
      lastWrittenPositionSeconds: 100,
      secondsSinceLastWrite: 30
    };
    // No timer, no clock, no accumulated state. A viewing session is a list of
    // events, which is what makes it testable at all.
    expect(planProgressWrite(input)).toEqual(planProgressWrite(input));
  });
});
