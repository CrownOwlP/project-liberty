/* Where a session starts (W132-D item 4). The boundaries are the test: each
 * threshold is checked at the value, one step below and one step above, because
 * "resumes a title it should have restarted" is an off-by-one a viewer feels. */
import { describe, expect, it } from "vitest";

import {
  FINISHED_FRACTION as RAIL_FINISHED_FRACTION,
  FINISHED_TAIL_SECONDS as RAIL_FINISHED_TAIL_SECONDS,
  RESUMABLE_MINIMUM_SECONDS as RAIL_RESUMABLE_MINIMUM_SECONDS,
  continueWatchingVerdict
} from "../../lib/continue-watching";
import {
  FINISHED_FRACTION,
  FINISHED_TAIL_SECONDS,
  RESUMABLE_MINIMUM_SECONDS,
  describeResumeDecision,
  resumeDecision
} from "./resume-decision";

/* ===========================================================================
 * THE MIRROR
 *
 * This is the test the module's header promises. It imports the rail's module,
 * which a browser bundle may not, and asserts the mirrored constants are the
 * same numbers. If somebody tunes one threshold, this fails rather than the
 * rail and the player quietly disagreeing about one title.
 * ======================================================================== */
describe("the mirrored thresholds are the rail's thresholds", () => {
  it("matches FINISHED_TAIL_SECONDS", () => {
    expect(FINISHED_TAIL_SECONDS).toBe(RAIL_FINISHED_TAIL_SECONDS);
  });
  it("matches FINISHED_FRACTION", () => {
    expect(FINISHED_FRACTION).toBe(RAIL_FINISHED_FRACTION);
  });
  it("matches RESUMABLE_MINIMUM_SECONDS", () => {
    expect(RESUMABLE_MINIMUM_SECONDS).toBe(RAIL_RESUMABLE_MINIMUM_SECONDS);
  });

  it("agrees with the rail wherever the rail resumes, and plays where the rail excludes", () => {
    const rows = [
      { positionSeconds: null, runtimeSeconds: 3600 },
      { positionSeconds: 5, runtimeSeconds: 3600 },
      { positionSeconds: 29.999, runtimeSeconds: 3600 },
      { positionSeconds: 30, runtimeSeconds: 3600 },
      { positionSeconds: 1800, runtimeSeconds: 3600 },
      { positionSeconds: 3510, runtimeSeconds: 3600 },
      { positionSeconds: 3600, runtimeSeconds: 3600 },
      { positionSeconds: 1800, runtimeSeconds: null }
    ];
    for (const row of rows) {
      const rail = continueWatchingVerdict(row);
      const player = resumeDecision({
        storedPositionSeconds: row.positionSeconds,
        durationSeconds: row.runtimeSeconds
      });
      if (rail.kind === "resumable") {
        /* Same position, to the second. */
        expect(player.kind).toBe("resume");
        expect(player.startAtSeconds).toBe(rail.resumeAtSeconds);
      } else {
        /* The player NEVER refuses. It starts over or abstains, and both play. */
        expect(player.kind === "restart" || player.kind === "ignore").toBe(true);
        expect(player.kind).not.toBe("resume");
      }
    }
  });
});

describe("an explicit restart outranks everything", () => {
  it("restarts over a perfectly good stored position", () => {
    const decision = resumeDecision({
      storedPositionSeconds: 1800,
      durationSeconds: 3600,
      restartRequested: true
    });
    expect(decision).toEqual({ kind: "restart", startAtSeconds: 0, reason: "restart_requested" });
  });

  it("restarts even with nothing stored, asserting the beginning rather than abstaining", () => {
    const decision = resumeDecision({
      storedPositionSeconds: null,
      durationSeconds: null,
      restartRequested: true
    });
    expect(decision.kind).toBe("restart");
    expect(decision.startAtSeconds).toBe(0);
  });

  it("treats an absent flag and false the same way", () => {
    const base = { storedPositionSeconds: 1800, durationSeconds: 3600 };
    expect(resumeDecision(base)).toEqual(resumeDecision({ ...base, restartRequested: false }));
  });
});

describe("nothing usable is an abstention, never an assertion of zero", () => {
  it("abstains with a null start when nothing is stored", () => {
    const decision = resumeDecision({ storedPositionSeconds: null, durationSeconds: 3600 });
    expect(decision).toEqual({
      kind: "ignore",
      startAtSeconds: null,
      reason: "nothing_stored"
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -3600])(
    "abstains for the unusable stored position %p rather than seeking to it",
    (stored) => {
      const decision = resumeDecision({ storedPositionSeconds: stored, durationSeconds: 3600 });
      expect(decision.kind).toBe("ignore");
      expect(decision.startAtSeconds).toBeNull();
      expect(decision.reason).toBe("position_unusable");
    }
  );

  it("never hands a caller a non-finite start position", () => {
    for (const stored of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const start = resumeDecision({
        storedPositionSeconds: stored,
        durationSeconds: 3600
      }).startAtSeconds;
      expect(start === null || Number.isFinite(start)).toBe(true);
    }
  });
});

describe("the near-start boundary, exactly", () => {
  it("restarts one step below the threshold", () => {
    const decision = resumeDecision({
      storedPositionSeconds: RESUMABLE_MINIMUM_SECONDS - 0.001,
      durationSeconds: 3600
    });
    expect(decision).toEqual({ kind: "restart", startAtSeconds: 0, reason: "near_start" });
  });

  it("resumes AT the threshold, which is the inclusive side the rail uses", () => {
    const decision = resumeDecision({
      storedPositionSeconds: RESUMABLE_MINIMUM_SECONDS,
      durationSeconds: 3600
    });
    expect(decision.kind).toBe("resume");
    expect(decision.startAtSeconds).toBe(RESUMABLE_MINIMUM_SECONDS);
  });

  it("restarts at a stored position of exactly zero", () => {
    const decision = resumeDecision({ storedPositionSeconds: 0, durationSeconds: 3600 });
    expect(decision.reason).toBe("near_start");
    expect(decision.kind).toBe("restart");
  });

  it("checks near-start before it checks the duration, so a live stream glanced at restarts", () => {
    expect(resumeDecision({ storedPositionSeconds: 4, durationSeconds: null }).reason).toBe(
      "near_start"
    );
  });
});

describe("the near-end boundaries, by tail and by fraction", () => {
  it("restarts when exactly the tail remains", () => {
    const duration = 3600;
    const decision = resumeDecision({
      storedPositionSeconds: duration - FINISHED_TAIL_SECONDS,
      durationSeconds: duration
    });
    expect(decision).toEqual({ kind: "restart", startAtSeconds: 0, reason: "near_end" });
  });

  it("resumes one second before the tail fires, on a runtime where the tail binds", () => {
    /*
     * THE DURATION IS CHOSEN, NOT ARBITRARY, and the first draft of this test
     * got it wrong in a way worth recording: at a one-hour runtime, 91 seconds
     * from the end is 97.5% watched, so the FRACTION fires and the title is
     * finished for a reason that has nothing to do with the tail — the test
     * "one second before the tail" would have been asserting the fraction rule
     * while claiming to assert the tail rule.
     *
     * The tail binds only while 90s is more than 5% of the runtime, i.e. below
     * 1800s. At 1800s exactly, 91 seconds from the end is 94.94% — just under
     * the fraction — so this is the boundary case the tail alone decides.
     */
    const duration = 1800;
    const position = duration - FINISHED_TAIL_SECONDS - 1;
    expect(position / duration).toBeLessThan(FINISHED_FRACTION);
    const decision = resumeDecision({
      storedPositionSeconds: position,
      durationSeconds: duration
    });
    expect(decision.kind).toBe("resume");
    expect(decision.startAtSeconds).toBe(position);
  });

  it("restarts at a one-hour runtime where the fraction fires before the tail", () => {
    /* The case the draft above confused itself with, kept as its own assertion:
     * whichever rule fires first wins, and on a long title that is the fraction. */
    const decision = resumeDecision({ storedPositionSeconds: 3509, durationSeconds: 3600 });
    expect(decision.reason).toBe("near_end");
    expect(3509 / 3600).toBeGreaterThan(FINISHED_FRACTION);
  });

  it("restarts at exactly the finished fraction, for a runtime the tail is too small for", () => {
    /* Four hours: 95% is 12 minutes from the end, far outside the 90s tail, so
     * only the fraction can fire. */
    const duration = 4 * 3600;
    const decision = resumeDecision({
      storedPositionSeconds: duration * FINISHED_FRACTION,
      durationSeconds: duration
    });
    expect(decision.reason).toBe("near_end");
  });

  it("resumes just under the finished fraction on that same long runtime", () => {
    const duration = 4 * 3600;
    const decision = resumeDecision({
      storedPositionSeconds: duration * FINISHED_FRACTION - 60,
      durationSeconds: duration
    });
    expect(decision.kind).toBe("resume");
  });

  it("restarts a stored position past the duration, which two devices can produce", () => {
    expect(resumeDecision({ storedPositionSeconds: 4000, durationSeconds: 3600 }).reason).toBe(
      "near_end"
    );
  });

  it("restarts a title stored at exactly its duration", () => {
    expect(resumeDecision({ storedPositionSeconds: 3600, durationSeconds: 3600 })).toEqual({
      kind: "restart",
      startAtSeconds: 0,
      reason: "near_end"
    });
  });

  it("restarts a short episode on the tail rule where the fraction would not fire", () => {
    /* A 100-second clip at 20s: the fraction is 0.2, nowhere near finished, but
     * 80s remain — inside the credits tail. Tail-first is the rail's rule too. */
    const decision = resumeDecision({ storedPositionSeconds: 40, durationSeconds: 100 });
    expect(decision.reason).toBe("near_end");
  });
});

describe("an unknown duration resumes and is never finished", () => {
  it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "resumes with duration %p, reporting that the end could not be measured",
    (duration) => {
      const decision = resumeDecision({
        storedPositionSeconds: 1800,
        durationSeconds: duration as number | null
      });
      expect(decision.kind).toBe("resume");
      expect(decision.startAtSeconds).toBe(1800);
      expect(decision.reason).toBe("stored_position_unmeasurable");
    }
  );
});

describe("the ordinary case", () => {
  it("resumes at the stored position exactly, with no rounding", () => {
    const decision = resumeDecision({ storedPositionSeconds: 1234.567, durationSeconds: 3600 });
    expect(decision).toEqual({
      kind: "resume",
      startAtSeconds: 1234.567,
      reason: "stored_position"
    });
  });
});

describe("every reason is reachable, and the trail carries the numbers", () => {
  it("covers all seven reasons from real inputs", () => {
    const cases: readonly { readonly input: Parameters<typeof resumeDecision>[0] }[] = [
      { input: { storedPositionSeconds: 1800, durationSeconds: 3600 } },
      { input: { storedPositionSeconds: 1800, durationSeconds: null } },
      { input: { storedPositionSeconds: 1800, durationSeconds: 3600, restartRequested: true } },
      { input: { storedPositionSeconds: 5, durationSeconds: 3600 } },
      { input: { storedPositionSeconds: 3599, durationSeconds: 3600 } },
      { input: { storedPositionSeconds: null, durationSeconds: 3600 } },
      { input: { storedPositionSeconds: Number.NaN, durationSeconds: 3600 } }
    ];
    const reasons = cases.map(({ input }) => resumeDecision(input).reason);
    expect(new Set(reasons).size).toBe(7);
    expect(reasons).toEqual([
      "stored_position",
      "stored_position_unmeasurable",
      "restart_requested",
      "near_start",
      "near_end",
      "nothing_stored",
      "position_unusable"
    ]);
  });

  it("describes a restart with both numbers that produced it", () => {
    const input = { storedPositionSeconds: 3599, durationSeconds: 3600 };
    const line = describeResumeDecision(input, resumeDecision(input));
    expect(line).toContain("near_end");
    expect(line).toContain("3599s");
    expect(line).toContain("3600s");
    expect(line).toContain("restart at 0s");
  });

  it("names the session default rather than printing null when it abstains", () => {
    const input = { storedPositionSeconds: null, durationSeconds: null };
    const line = describeResumeDecision(input, resumeDecision(input));
    expect(line).toBe("ignore at session default: nothing_stored (stored none, duration unknown)");
  });
});
