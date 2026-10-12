/* Synchronisation offsets (W132-D items 2 and 3). The boundary cases are the
 * point: both bounds, the step grid, and the float accumulation a naive modulo
 * implementation produces. */
import { describe, expect, it } from "vitest";

import {
  NO_OFFSET,
  OFFSET_BOUNDS,
  type OffsetChannel,
  clampOffset,
  decodeOffset,
  describeOffset,
  encodeOffset,
  isDefaultOffset,
  nudgeOffset,
  offsetFromSliderFraction,
  offsetSliderFraction,
  resetOffset
} from "./timing-offset";

const CHANNELS: readonly OffsetChannel[] = ["subtitle", "audio"];

describe("the bounds", () => {
  it("are frozen and positive, with a step that divides the limit exactly", () => {
    expect(Object.isFrozen(OFFSET_BOUNDS)).toBe(true);
    for (const channel of CHANNELS) {
      const { limitSeconds, stepSeconds } = OFFSET_BOUNDS[channel];
      expect(limitSeconds).toBeGreaterThan(0);
      expect(stepSeconds).toBeGreaterThan(0);
      expect(Number.isInteger(Math.round(limitSeconds / stepSeconds))).toBe(true);
      expect(Math.abs(Math.round(limitSeconds / stepSeconds) * stepSeconds - limitSeconds)).toBeLessThan(1e-9);
    }
  });

  it("gives audio a tighter range than subtitles, because it is a lip-sync control", () => {
    expect(OFFSET_BOUNDS.audio.limitSeconds).toBeLessThan(OFFSET_BOUNDS.subtitle.limitSeconds);
    expect(OFFSET_BOUNDS.audio.stepSeconds).toBeLessThan(OFFSET_BOUNDS.subtitle.stepSeconds);
  });

  it("keeps the audio step under the ~45ms perceptible threshold region", () => {
    expect(OFFSET_BOUNDS.audio.stepSeconds).toBeLessThanOrEqual(0.05);
  });
});

describe("clampOffset: both bounds, exactly", () => {
  it.each(CHANNELS)("holds a value at the positive limit for %s", (channel) => {
    const limit = OFFSET_BOUNDS[channel].limitSeconds;
    expect(clampOffset(limit, channel)).toBe(limit);
    expect(clampOffset(limit + 0.0001, channel)).toBe(limit);
    expect(clampOffset(limit * 1000, channel)).toBe(limit);
  });

  it.each(CHANNELS)("holds a value at the negative limit for %s", (channel) => {
    const limit = OFFSET_BOUNDS[channel].limitSeconds;
    expect(clampOffset(-limit, channel)).toBe(-limit);
    expect(clampOffset(-limit - 0.0001, channel)).toBe(-limit);
    expect(clampOffset(-limit * 1000, channel)).toBe(-limit);
  });

  it("never snaps past the limit: a value just inside the bound stays inside", () => {
    /* 29.9 snaps to 29.75 or 30 on a 0.25 grid; either way it must not exceed 30. */
    for (const channel of CHANNELS) {
      const limit = OFFSET_BOUNDS[channel].limitSeconds;
      const nearly = limit - OFFSET_BOUNDS[channel].stepSeconds / 3;
      expect(Math.abs(clampOffset(nearly, channel))).toBeLessThanOrEqual(limit);
      expect(Math.abs(clampOffset(-nearly, channel))).toBeLessThanOrEqual(limit);
    }
  });

  it("is zero at zero, and keeps zero signless", () => {
    for (const channel of CHANNELS) {
      expect(clampOffset(0, channel)).toBe(0);
      expect(clampOffset(-0, channel)).toBe(0);
      expect(Object.is(clampOffset(-0.0000001, channel), -0)).toBe(false);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "answers no offset for the non-finite %p, which is not a request",
    (value) => {
      for (const channel of CHANNELS) expect(clampOffset(value, channel)).toBe(NO_OFFSET);
    }
  );

  it("snaps onto the step grid", () => {
    expect(clampOffset(0.3, "subtitle")).toBe(0.25);
    expect(clampOffset(0.4, "subtitle")).toBe(0.5);
    expect(clampOffset(0.07, "audio")).toBe(0.05);
    expect(clampOffset(-0.07, "audio")).toBe(-0.05);
  });
});

describe("nudgeOffset saturates and accumulates no float error", () => {
  it("steps by exactly one step in each direction", () => {
    expect(nudgeOffset(0, "subtitle", "later")).toBe(0.25);
    expect(nudgeOffset(0, "subtitle", "earlier")).toBe(-0.25);
    expect(nudgeOffset(0, "audio", "later")).toBe(0.05);
    expect(nudgeOffset(0, "audio", "earlier")).toBe(-0.05);
  });

  it("stays on a clean grid across many nudges, which a modulo implementation does not", () => {
    let value = 0;
    for (let i = 0; i < 40; i += 1) value = nudgeOffset(value, "audio", "later");
    /* 40 * 0.05 = 2 exactly, and the printed form must not be 2.0000000000000004. */
    expect(value).toBe(2);
    expect(String(value)).toBe("2");
    for (let i = 0; i < 80; i += 1) value = nudgeOffset(value, "audio", "earlier");
    expect(value).toBe(-2);
  });

  it("stops at the bound rather than wrapping or overshooting", () => {
    for (const channel of CHANNELS) {
      const limit = OFFSET_BOUNDS[channel].limitSeconds;
      let value: number = limit;
      for (let i = 0; i < 5; i += 1) value = nudgeOffset(value, channel, "later");
      expect(value).toBe(limit);
      value = -limit;
      for (let i = 0; i < 5; i += 1) value = nudgeOffset(value, channel, "earlier");
      expect(value).toBe(-limit);
    }
  });

  it("reaches both bounds from zero by stepping, with no unreachable remainder", () => {
    for (const channel of CHANNELS) {
      const { limitSeconds, stepSeconds } = OFFSET_BOUNDS[channel];
      let value = 0;
      const steps = Math.round(limitSeconds / stepSeconds);
      for (let i = 0; i < steps; i += 1) value = nudgeOffset(value, channel, "later");
      expect(value).toBe(limitSeconds);
    }
  });

  it("snaps an off-grid current value before stepping", () => {
    expect(nudgeOffset(0.3, "subtitle", "later")).toBe(0.5);
  });

  it("recovers from a non-finite current value instead of propagating NaN", () => {
    expect(nudgeOffset(Number.NaN, "audio", "later")).toBe(0.05);
  });
});

describe("reset and the default", () => {
  it("resets to zero", () => {
    expect(resetOffset()).toBe(NO_OFFSET);
    expect(NO_OFFSET).toBe(0);
  });

  it("knows when there is nothing worth storing", () => {
    expect(isDefaultOffset(0)).toBe(true);
    expect(isDefaultOffset(resetOffset())).toBe(true);
    expect(isDefaultOffset(0.05)).toBe(false);
    expect(isDefaultOffset(clampOffset(0.0000001, "audio"))).toBe(true);
  });
});

describe("describeOffset names the direction, not just the sign", () => {
  it("says in sync at zero", () => {
    expect(describeOffset(0, "subtitle")).toBe("In sync");
  });

  it("says late for a positive offset and early for a negative one", () => {
    expect(describeOffset(1.25, "subtitle")).toBe("+1.25s late");
    expect(describeOffset(-0.5, "subtitle")).toBe("-0.50s early");
    expect(describeOffset(0.05, "audio")).toBe("+0.05s late");
  });

  it("clamps before describing, so a label can never show an impossible number", () => {
    expect(describeOffset(900, "audio")).toBe("+5.00s late");
  });

  it("keeps a fixed width so digits do not jump while a key is held", () => {
    const widths = new Set([
      describeOffset(0.05, "audio").length,
      describeOffset(0.1, "audio").length,
      describeOffset(1, "audio").length
    ]);
    expect(widths.size).toBe(1);
  });
});

describe("the slider projection round-trips", () => {
  it("puts zero in the middle and each bound at an end", () => {
    for (const channel of CHANNELS) {
      const limit = OFFSET_BOUNDS[channel].limitSeconds;
      expect(offsetSliderFraction(0, channel)).toBe(0.5);
      expect(offsetSliderFraction(limit, channel)).toBe(1);
      expect(offsetSliderFraction(-limit, channel)).toBe(0);
    }
  });

  it("maps a fraction back onto a legal offset", () => {
    for (const channel of CHANNELS) {
      const limit = OFFSET_BOUNDS[channel].limitSeconds;
      expect(offsetFromSliderFraction(0.5, channel)).toBe(0);
      expect(offsetFromSliderFraction(1, channel)).toBe(limit);
      expect(offsetFromSliderFraction(0, channel)).toBe(-limit);
      expect(offsetFromSliderFraction(5, channel)).toBe(limit);
      expect(offsetFromSliderFraction(-5, channel)).toBe(-limit);
      expect(offsetFromSliderFraction(Number.NaN, channel)).toBe(NO_OFFSET);
    }
  });

  it("round-trips every reachable offset through the slider", () => {
    for (const channel of CHANNELS) {
      const { limitSeconds, stepSeconds } = OFFSET_BOUNDS[channel];
      for (let steps = -Math.round(limitSeconds / stepSeconds); steps <= Math.round(limitSeconds / stepSeconds); steps += 1) {
        const offset = clampOffset(steps * stepSeconds, channel);
        expect(offsetFromSliderFraction(offsetSliderFraction(offset, channel), channel)).toBe(offset);
      }
    }
  });
});

describe("persistence reports why, and per channel", () => {
  it("round-trips through the string form", () => {
    expect(decodeOffset(encodeOffset(1.25, "subtitle"), "subtitle").seconds).toBe(1.25);
    expect(decodeOffset(encodeOffset(-0.15, "audio"), "audio").seconds).toBe(-0.15);
  });

  it.each([null, undefined, "", "  "])("calls %p not_chosen", (raw) => {
    const decoded = decodeOffset(raw, "subtitle");
    expect(decoded.reason).toBe("not_chosen");
    expect(decoded.seconds).toBe(NO_OFFSET);
    expect(decoded.storedValue).toBeNull();
  });

  it.each(["abc", {}, [], true, Number.NaN])("calls %p unreadable", (raw) => {
    expect(decodeOffset(raw, "audio").reason).toBe("unreadable");
    expect(decodeOffset(raw, "audio").seconds).toBe(NO_OFFSET);
  });

  it("flags a value the bounds no longer allow, and clamps rather than dropping it", () => {
    const decoded = decodeOffset(12, "audio");
    expect(decoded.reason).toBe("out_of_bounds");
    expect(decoded.seconds).toBe(5);
    expect(decoded.storedValue).toBe(12);
  });

  it("is channel-specific: 12 seconds is legal for subtitles and not for audio", () => {
    expect(decodeOffset(12, "subtitle").reason).toBe("stored");
    expect(decodeOffset(12, "subtitle").seconds).toBe(12);
    expect(decodeOffset(12, "audio").reason).toBe("out_of_bounds");
  });

  it("calls a value exactly at the limit stored and not out_of_bounds", () => {
    for (const channel of CHANNELS) {
      const limit = OFFSET_BOUNDS[channel].limitSeconds;
      expect(decodeOffset(limit, channel).reason).toBe("stored");
      expect(decodeOffset(-limit, channel).reason).toBe("stored");
    }
  });
});
