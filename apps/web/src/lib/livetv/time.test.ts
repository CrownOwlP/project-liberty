/* -------------------------------------------------------------------------
 * EPG time: the three cases that break every other implementation
 * (Wave 132, Worker E).
 *
 * Midnight crossing, a DST transition, and offsets that are not a whole number
 * of hours. Each is asserted against a real zone through the runtime's own zone
 * database, because a hand-maintained offset table is the thing that goes stale
 * when a legislature moves a transition.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import { readXmltvTimestamp, type EpgInstant } from "@liberty/contracts/domains/live";

import {
  UTC_ZONE,
  crossesLocalMidnight,
  formatZonedClock,
  instantToMillis,
  millisToInstant,
  resolveViewerZone,
  spanMinutes,
  zoneOffsetMinutesAt,
  zonedDayKey,
  zonedParts
} from "./time";

function instant(raw: string): EpgInstant {
  const reading = readXmltvTimestamp(raw);
  if (!reading.ok) throw new Error(`fixture timestamp ${raw} was refused: ${reading.refusal}`);
  return reading.instant;
}

function zone(name: string) {
  const resolved = resolveViewerZone(name);
  if (!resolved.ok) throw new Error(`this runtime does not know the zone ${name}`);
  return resolved.zone;
}

describe("a zone is a parameter, and an unknown one is a refusal", () => {
  it("resolves a real zone and an alias", () => {
    expect(resolveViewerZone("Europe/London").ok).toBe(true);
    expect(resolveViewerZone("UTC").ok).toBe(true);
    /* An alias `Intl.supportedValuesOf` omits; a list-based check would reject it. */
    expect(resolveViewerZone("Asia/Calcutta").ok).toBe(true);
  });

  it("refuses an unknown zone by name instead of throwing", () => {
    for (const bad of ["", "   ", "Mars/Olympus", "Not A Zone", "../../etc"]) {
      const resolved = resolveViewerZone(bad);
      expect(resolved.ok, bad).toBe(false);
      if (!resolved.ok) expect(resolved.reason).toBe("unknown_time_zone");
    }
  });
});

describe("instants round-trip at the contract's fixed width", () => {
  it("keeps exactly three fractional digits, which is what makes string order chronological", () => {
    const value = millisToInstant(Date.UTC(2026, 9, 12, 19, 30, 0));
    expect(value).toBe("2026-10-12T19:30:00.000Z");
    expect(value).toHaveLength(24);
    expect(instantToMillis(value ?? "")).toBe(Date.UTC(2026, 9, 12, 19, 30, 0));
  });

  it("refuses a non-finite millisecond value rather than producing junk", () => {
    expect(millisToInstant(Number.NaN)).toBeNull();
    expect(millisToInstant(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("offsets that are not whole hours", () => {
  it("reads +0530 and -0330 from the data and stores UTC", () => {
    expect(instant("20261012090000 +0530")).toBe("2026-10-12T03:30:00.000Z");
    expect(instant("20261012140000 -0330")).toBe("2026-10-12T17:30:00.000Z");
  });

  it("renders a +0530 broadcast correctly in its own zone and in UTC", () => {
    const start = instant("20261012090000 +0530");
    expect(formatZonedClock(start, zone("Asia/Kolkata"))).toBe("09:00");
    expect(formatZonedClock(start, UTC_ZONE)).toBe("03:30");
    expect(zoneOffsetMinutesAt(start, zone("Asia/Kolkata"))).toBe(330);
  });

  it("renders a -0330 broadcast correctly in its own zone", () => {
    /* Newfoundland is -0330 in winter, so a January broadcast stated at 14:00
     * local reads back as 14:00 there. */
    const winter = instant("20260112140000 -0330");
    expect(formatZonedClock(winter, zone("America/St_Johns"))).toBe("14:00");
    expect(zoneOffsetMinutesAt(winter, zone("America/St_Johns"))).toBe(-210);
  });

  it("honours the offset the FEED stated even when the zone disagrees with it", () => {
    /*
     * THE DISAGREEMENT CASE, AND IT IS THE ONE WORTH PINNING. Newfoundland is
     * -0230 in October, so a feed stating `-0330` on 12 October is either a
     * generator bug or a deliberately fixed-offset feed. The instant is computed
     * from the OFFSET IN THE DATA regardless — 17:30Z — and rendering it in
     * `America/St_Johns` therefore shows 15:00, an hour later than the feed's own
     * wall clock. Both numbers are correct and neither is reconciled: silently
     * preferring the zone's rule would be the "guess a zone" inference
     * `readXmltvTimestamp` refuses, and it would move the broadcast by an hour.
     */
    const autumn = instant("20261012140000 -0330");
    expect(autumn).toBe("2026-10-12T17:30:00.000Z");
    expect(zoneOffsetMinutesAt(autumn, zone("America/St_Johns"))).toBe(-150);
    expect(formatZonedClock(autumn, zone("America/St_Johns"))).toBe("15:00");
  });
});

describe("a programme that crosses midnight", () => {
  const start = instant("20261012233000 +0000");
  const end = instant("20261013003000 +0000");

  it("is on two different days in UTC", () => {
    expect(zonedDayKey(start, UTC_ZONE)).toBe("2026-10-12");
    expect(zonedDayKey(end, UTC_ZONE)).toBe("2026-10-13");
    expect(crossesLocalMidnight(start, end, UTC_ZONE)).toBe(true);
  });

  it("is on ONE day for a viewer west of UTC, which slicing the instant gets wrong", () => {
    /*
     * THE BUG THIS PINS. `instant.slice(0, 10)` answers "2026-10-12" and
     * "2026-10-13" for these two, so a grid grouped that way splits a single
     * New York evening broadcast across two days — and only for programmes
     * after 00:00 UTC, so it looks intermittent.
     */
    const newYork = zone("America/New_York");
    expect(zonedDayKey(start, newYork)).toBe("2026-10-12");
    expect(zonedDayKey(end, newYork)).toBe("2026-10-12");
    expect(crossesLocalMidnight(start, end, newYork)).toBe(false);
    expect(start.slice(0, 10)).not.toBe(end.slice(0, 10));
  });

  it("is on two days for a viewer east of UTC whose evening has already ended", () => {
    const tokyo = zone("Asia/Tokyo");
    expect(zonedDayKey(start, tokyo)).toBe("2026-10-13");
    expect(zonedDayKey(end, tokyo)).toBe("2026-10-13");
    expect(crossesLocalMidnight(instant("20261012143000 +0000"), start, tokyo)).toBe(true);
  });
});

describe("a programme that crosses a DST boundary", () => {
  /* US spring forward 2026: 02:00 EST becomes 03:00 EDT on 8 March. */
  const start = instant("20260308013000 -0500");
  const end = instant("20260308031500 -0400");
  const newYork = zone("America/New_York");

  it("is 45 real minutes while its wall clock moves 1h45m", () => {
    expect(spanMinutes(start, end)).toBe(45);
    expect(formatZonedClock(start, newYork)).toBe("01:30");
    expect(formatZonedClock(end, newYork)).toBe("03:15");
  });

  it("reports the zone's offset changing across the transition, from the runtime's own database", () => {
    expect(zoneOffsetMinutesAt(start, newYork)).toBe(-300);
    expect(zoneOffsetMinutesAt(end, newYork)).toBe(-240);
  });

  it("does not report a day change for a transition that happens mid-morning-grid", () => {
    expect(crossesLocalMidnight(start, end, newYork)).toBe(false);
  });

  it("reports the autumn fall-back direction too, where a wall clock repeats", () => {
    /* 1 November 2026: 02:00 EDT becomes 01:00 EST, so 01:30 happens twice —
     * and the two spellings are distinguished only by the offset in the data,
     * which is the entire reason an offset-less timestamp is refused upstream. */
    const first = instant("20261101013000 -0400");
    const second = instant("20261101013000 -0500");
    expect(formatZonedClock(first, newYork)).toBe("01:30");
    expect(formatZonedClock(second, newYork)).toBe("01:30");
    expect(spanMinutes(first, second)).toBe(60);
  });
});

describe("the parts are read from a pinned locale, not the machine's", () => {
  it("reads midnight as hour 0 rather than 24 or 12", () => {
    const midnight = instant("20261012000000 +0000");
    expect(zonedParts(midnight, UTC_ZONE)?.hour).toBe(0);
    expect(formatZonedClock(midnight, UTC_ZONE)).toBe("00:00");
  });

  it("returns null rather than throwing for an unreadable instant", () => {
    expect(zonedParts("not-an-instant", UTC_ZONE)).toBeNull();
    expect(formatZonedClock("not-an-instant", UTC_ZONE)).toBeNull();
    expect(zonedDayKey("not-an-instant", UTC_ZONE)).toBeNull();
    expect(spanMinutes("not-an-instant", "also-not")).toBeNull();
  });
});
