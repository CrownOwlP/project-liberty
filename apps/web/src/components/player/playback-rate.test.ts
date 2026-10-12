/* The rate model (W132-D item 1). Every branch here runs with no media element
 * in existence, which is the point of the module: `environment: "node"`. */
import { describe, expect, it } from "vitest";

import {
  NORMAL_RATE,
  PLAYBACK_RATES,
  decodeRate,
  describeRate,
  encodeRate,
  isPlaybackRate,
  nearestRate,
  rateStep,
  remainingMediaSeconds,
  remainingWallClockSeconds
} from "./playback-rate";

/* `Math.min`/`Math.max` rather than an index read: `noUncheckedIndexedAccess`
 * makes `PLAYBACK_RATES[0]` a `number | undefined`, and a `!` in a test is how
 * a test starts asserting something other than what it says. */
const SLOWEST: number = Math.min(...PLAYBACK_RATES);
const FASTEST: number = Math.max(...PLAYBACK_RATES);

describe("the offered set", () => {
  it("is ascending, deduplicated, and includes normal speed", () => {
    const rates = [...PLAYBACK_RATES];
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(new Set(rates).size).toBe(rates.length);
    expect(rates).toContain(NORMAL_RATE);
  });

  it("holds only exactly-representable quarter steps, so `===` on a parsed value is reliable", () => {
    for (const rate of PLAYBACK_RATES) {
      expect(Number.isInteger(rate * 4)).toBe(true);
      expect(Number(String(rate))).toBe(rate);
    }
  });

  it("offers nothing that would pause playback or lose pitch correction", () => {
    for (const rate of PLAYBACK_RATES) {
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(2);
    }
  });

  it("is frozen, so no caller can add a rate the element would reject", () => {
    expect(Object.isFrozen(PLAYBACK_RATES)).toBe(true);
  });
});

describe("isPlaybackRate refuses everything an element would throw on", () => {
  it.each([0, -1, 2.5, 16, Number.NaN, Number.POSITIVE_INFINITY, 1.1, 1 / 3])(
    "rejects %p",
    (value) => {
      expect(isPlaybackRate(value)).toBe(false);
    }
  );

  it.each(["1", null, undefined, {}, [], true])("rejects the non-number %p", (value) => {
    expect(isPlaybackRate(value)).toBe(false);
  });

  it("accepts every offered rate", () => {
    for (const rate of PLAYBACK_RATES) expect(isPlaybackRate(rate)).toBe(true);
  });
});

describe("nearestRate clamps rather than falling back to normal speed", () => {
  it("clamps above the ceiling to the fastest offered rate, not to 1x", () => {
    expect(nearestRate(8)).toBe(2);
    expect(nearestRate(2.01)).toBe(2);
  });

  it("clamps below the floor to the slowest offered rate", () => {
    expect(nearestRate(0)).toBe(0.25);
    expect(nearestRate(-4)).toBe(0.25);
  });

  it("settles a value exactly between two rates on the slower one", () => {
    /* 1.125 is equidistant from 1 and 1.25. */
    expect(nearestRate(1.125)).toBe(1);
  });

  it("answers normal speed for a non-finite request, which asks for nothing", () => {
    expect(nearestRate(Number.NaN)).toBe(NORMAL_RATE);
    expect(nearestRate(Number.POSITIVE_INFINITY)).toBe(NORMAL_RATE);
  });

  it("is the identity on an offered rate", () => {
    for (const rate of PLAYBACK_RATES) expect(nearestRate(rate)).toBe(rate);
  });
});

describe("rateStep saturates and never wraps", () => {
  it("walks the whole list upward and stops at the ceiling", () => {
    let rate: number = SLOWEST;
    const walked = [rate];
    for (let i = 0; i < PLAYBACK_RATES.length + 3; i += 1) {
      const next = rateStep(rate, "faster");
      if (next !== rate) walked.push(next);
      rate = next;
    }
    expect(walked).toEqual([...PLAYBACK_RATES]);
    expect(rate).toBe(2);
  });

  it("walks downward and stops at the floor rather than jumping to 2x", () => {
    let rate: number = FASTEST;
    for (let i = 0; i < PLAYBACK_RATES.length + 3; i += 1) rate = rateStep(rate, "slower");
    expect(rate).toBe(0.25);
  });

  it("returns the rate it was already at when it cannot move, so a held key is a no-op", () => {
    expect(rateStep(2, "faster")).toBe(2);
    expect(rateStep(0.25, "slower")).toBe(0.25);
  });

  it("snaps an off-list current value onto the list before stepping", () => {
    /* 1.9 is nearest 2, so one step slower is 1.75 and not 1.65. */
    expect(rateStep(1.9, "slower")).toBe(1.75);
    expect(rateStep(Number.NaN, "faster")).toBe(1.25);
  });
});

describe("describeRate", () => {
  it("uses the multiplication sign and no trailing zeroes", () => {
    expect(describeRate(1)).toBe("1×");
    expect(describeRate(1.25)).toBe("1.25×");
    expect(describeRate(1)).not.toContain("x");
  });
});

describe("time remaining distinguishes media time from wall clock", () => {
  it("reports media time unchanged by rate", () => {
    expect(remainingMediaSeconds(600, 1800)).toBe(1200);
  });

  it("divides wall clock by the rate, which is the whole reason the field exists", () => {
    expect(remainingWallClockSeconds(600, 1800, 1)).toBe(1200);
    expect(remainingWallClockSeconds(600, 1800, 1.5)).toBe(800);
    expect(remainingWallClockSeconds(600, 1800, 0.5)).toBe(2400);
  });

  it("answers null for an unknown duration rather than zero", () => {
    expect(remainingMediaSeconds(600, null)).toBeNull();
    expect(remainingWallClockSeconds(600, null, 1.5)).toBeNull();
  });

  it("clamps at zero past the end instead of reporting negative time left", () => {
    expect(remainingMediaSeconds(1801, 1800)).toBe(0);
    expect(remainingWallClockSeconds(1801, 1800, 2)).toBe(0);
  });

  it("answers null rather than Infinity for a rate of zero a raw caller might hold", () => {
    expect(remainingWallClockSeconds(0, 1800, 0)).toBeNull();
    expect(remainingWallClockSeconds(0, 1800, -1)).toBeNull();
    expect(remainingWallClockSeconds(0, 1800, Number.NaN)).toBeNull();
  });

  it("answers null for a non-finite position", () => {
    expect(remainingMediaSeconds(Number.NaN, 1800)).toBeNull();
  });
});

describe("the persistence codec reports a reason and never casts silently", () => {
  it("round-trips every offered rate", () => {
    for (const rate of PLAYBACK_RATES) {
      const decoded = decodeRate(encodeRate(rate));
      expect(decoded.rate).toBe(rate);
      expect(decoded.reason).toBe("stored");
      expect(decoded.storedValue).toBe(rate);
    }
  });

  it("encodes 1 as \"1\", not \"1.0\"", () => {
    expect(encodeRate(1)).toBe("1");
  });

  it.each([null, undefined, "", "   "])(
    "calls %p not_chosen and NOT the 0.25x that `Number(\"\")` would produce",
    (raw) => {
      const decoded = decodeRate(raw);
      expect(decoded.reason).toBe("not_chosen");
      expect(decoded.rate).toBe(NORMAL_RATE);
      expect(decoded.storedValue).toBeNull();
    }
  );

  it.each(["abc", "1,5", {}, [], true, Number.NaN, Number.POSITIVE_INFINITY])(
    "calls %p unreadable, which is a different fact from not_chosen",
    (raw) => {
      expect(decodeRate(raw).reason).toBe("unreadable");
      expect(decodeRate(raw).rate).toBe(NORMAL_RATE);
    }
  );

  it("migrates a rate an older build offered and says so", () => {
    const decoded = decodeRate(1.9);
    expect(decoded.reason).toBe("not_offered");
    expect(decoded.rate).toBe(2);
    expect(decoded.storedValue).toBe(1.9);
  });

  it("migrates an out-of-range stored rate to an end, keeping the direction asked for", () => {
    expect(decodeRate("8").rate).toBe(2);
    expect(decodeRate("0.05").rate).toBe(0.25);
    expect(decodeRate("0").reason).toBe("not_offered");
  });

  it("distinguishes all four reasons, which is what makes a stuck setting debuggable", () => {
    expect(
      [decodeRate(null), decodeRate(1.5), decodeRate("abc"), decodeRate(1.9)].map((d) => d.reason)
    ).toEqual(["not_chosen", "stored", "unreadable", "not_offered"]);
  });
});
