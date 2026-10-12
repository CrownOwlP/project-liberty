/* -------------------------------------------------------------------------
 * Now and next: the six states, each at its own boundary instant
 * (Wave 132, Worker E).
 *
 * The clock is injected, so every boundary is an ordinary assertion rather than
 * a timing test. That is the whole reason the clock is injected.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import type { EpgListing } from "@liberty/contracts/domains/live";

import {
  currentProgress,
  fixedClock,
  nowAndNext,
  scheduleNowAndNext,
  systemClock,
  upcomingWindow
} from "./schedule";
import { sourceWithoutComments } from "./testing/fixtures";

function listing(
  id: string,
  startsAt: string,
  endsAt: string | null,
  title = id
): EpgListing {
  return {
    id,
    channelId: "aurora-news",
    startsAt,
    endsAt,
    title,
    episodeTitle: null,
    description: null,
    categories: null,
    seasonNumber: null,
    episodeNumber: null,
    isNew: null,
    isPreviouslyShown: null
  };
}

const first = listing("a", "2026-10-12T19:00:00.000Z", "2026-10-12T20:00:00.000Z", "First");
/* A deliberate 30-minute gap between `first` and `second`. */
const second = listing("b", "2026-10-12T20:30:00.000Z", "2026-10-12T21:30:00.000Z", "Second");
const grid = [first, second];

describe("the logic never reads the ambient clock", () => {
  it("names Date.now in exactly one adapter and nowhere in the logic", () => {
    const source = sourceWithoutComments(new URL("./schedule.ts", import.meta.url));
    /* `systemClock` is the one place, and it is four lines with no branch. */
    expect([...source.matchAll(/Date\.now\(\)/g)]).toHaveLength(1);
    expect(source).toContain("export function systemClock()");
  });

  it("gives a usable instant from the system clock", () => {
    expect(systemClock().now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("now and next", () => {
  it("reports no_listings for an empty schedule, which is an answer and not a failure", () => {
    expect(nowAndNext([], fixedClock("2026-10-12T19:30:00.000Z"))).toEqual({ state: "no_listings" });
  });

  it("reports before_schedule ahead of the grid, with the first entry as next", () => {
    const state = nowAndNext(grid, fixedClock("2026-10-12T18:00:00.000Z"));
    expect(state.state).toBe("before_schedule");
    if (state.state === "before_schedule") expect(state.next.id).toBe("a");
  });

  it("reports on_air inside a programme, with the following one as next", () => {
    const state = nowAndNext(grid, fixedClock("2026-10-12T19:30:00.000Z"));
    expect(state.state).toBe("on_air");
    if (state.state === "on_air") {
      expect(state.current.id).toBe("a");
      expect(state.next?.id).toBe("b");
    }
  });

  it("is half-open: a programme owns its start instant and not its end instant", () => {
    /*
     * WITH BOTH ENDS INCLUSIVE the instant one programme ends is inside two at
     * once, and which one is "on now" then depends on which the loop reached
     * first. Pinned at both boundaries.
     */
    const atStart = nowAndNext(grid, fixedClock("2026-10-12T19:00:00.000Z"));
    expect(atStart.state).toBe("on_air");
    if (atStart.state === "on_air") expect(atStart.current.id).toBe("a");

    const atEnd = nowAndNext(grid, fixedClock("2026-10-12T20:00:00.000Z"));
    expect(atEnd.state).toBe("in_gap");

    const atSecondStart = nowAndNext(grid, fixedClock("2026-10-12T20:30:00.000Z"));
    expect(atSecondStart.state).toBe("on_air");
    if (atSecondStart.state === "on_air") expect(atSecondStart.current.id).toBe("b");
  });

  it("REPORTS THE GAP AS A GAP, with what just ended and what is coming", () => {
    const state = nowAndNext(grid, fixedClock("2026-10-12T20:15:00.000Z"));
    expect(state.state).toBe("in_gap");
    if (state.state === "in_gap") {
      expect(state.previous?.id).toBe("a");
      expect(state.next.id).toBe("b");
    }
  });

  it("reports after_schedule once the grid has run out", () => {
    const state = nowAndNext(grid, fixedClock("2026-10-12T23:00:00.000Z"));
    expect(state.state).toBe("after_schedule");
    if (state.state === "after_schedule") expect(state.previous.id).toBe("b");
  });

  it("reports an indeterminate end rather than inferring one from the next start", () => {
    const open = listing("c", "2026-10-12T22:00:00.000Z", null, "Open Ended");
    const state = nowAndNext([open], fixedClock("2026-10-13T06:00:00.000Z"));
    expect(state.state).toBe("on_air_indeterminate_end");
    if (state.state === "on_air_indeterminate_end") expect(state.current.id).toBe("c");
  });

  it("resolves an overlap by the contract's order rather than by a second rule", () => {
    const early = listing("x", "2026-10-12T19:00:00.000Z", "2026-10-12T20:00:00.000Z", "Main");
    const optOut = listing("y", "2026-10-12T19:30:00.000Z", "2026-10-12T20:30:00.000Z", "Opt-out");
    for (const order of [[early, optOut], [optOut, early]]) {
      const state = nowAndNext(order, fixedClock("2026-10-12T19:45:00.000Z"));
      expect(state.state).toBe("on_air");
      if (state.state === "on_air") expect(state.current.id).toBe("x");
    }
  });

  it("unwraps a whole schedule", () => {
    const schedule = {
      channelId: "aurora-news",
      window: { startsAt: "2026-10-12T18:00:00.000Z", endsAt: "2026-10-12T23:00:00.000Z" },
      listings: grid,
      generatedAt: "2026-10-12T18:00:00.000Z"
    };
    expect(scheduleNowAndNext(schedule, fixedClock("2026-10-12T19:30:00.000Z")).state).toBe("on_air");
  });
});

describe("the upcoming window", () => {
  it("includes what starts inside it and excludes what starts at its far edge", () => {
    const window = upcomingWindow(grid, fixedClock("2026-10-12T20:00:00.000Z"), {
      minutes: 30,
      includeInProgress: false
    });
    /* `second` starts at exactly 20:30, which is the window's exclusive end. */
    expect(window.listings).toEqual([]);
    expect(window.empty).toBe(true);
    expect(window.until).toBe("2026-10-12T20:30:00.000Z");
  });

  it("includes a programme already in progress only when asked", () => {
    const clock = fixedClock("2026-10-12T19:30:00.000Z");
    const without = upcomingWindow(grid, clock, { minutes: 180, includeInProgress: false });
    expect(without.listings.map((item) => item.id)).toEqual(["b"]);
    const with_ = upcomingWindow(grid, clock, { minutes: 180, includeInProgress: true });
    expect(with_.listings.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("reports an empty window in a gap, which is the gap case at window scale", () => {
    const window = upcomingWindow(grid, fixedClock("2026-10-12T20:05:00.000Z"), {
      minutes: 10,
      includeInProgress: true
    });
    expect(window.empty).toBe(true);
  });

  it("treats a negative or zero span as zero rather than looking backwards", () => {
    const window = upcomingWindow(grid, fixedClock("2026-10-12T19:30:00.000Z"), {
      minutes: -120,
      includeInProgress: true
    });
    expect(window.until).toBe(window.from);
    expect(window.listings).toEqual([]);
  });
});

describe("progress", () => {
  it("is a ratio inside a programme with a stated end", () => {
    const state = nowAndNext(grid, fixedClock("2026-10-12T19:30:00.000Z"));
    expect(currentProgress(state, fixedClock("2026-10-12T19:30:00.000Z"))).toBeCloseTo(0.5, 6);
  });

  it("is null for an indeterminate end rather than zero, which would be a claim", () => {
    const open = listing("c", "2026-10-12T22:00:00.000Z", null);
    const state = nowAndNext([open], fixedClock("2026-10-13T06:00:00.000Z"));
    expect(currentProgress(state, fixedClock("2026-10-13T06:00:00.000Z"))).toBeNull();
  });

  it("is null in every state where nothing is on", () => {
    for (const now of ["2026-10-12T18:00:00.000Z", "2026-10-12T20:15:00.000Z", "2026-10-12T23:00:00.000Z"]) {
      const clock = fixedClock(now);
      expect(currentProgress(nowAndNext(grid, clock), clock)).toBeNull();
    }
    expect(currentProgress(nowAndNext([], fixedClock("2026-10-12T19:00:00.000Z")), fixedClock("2026-10-12T19:00:00.000Z"))).toBeNull();
  });

  it("clamps rather than reporting a ratio outside 0..1", () => {
    const state = nowAndNext(grid, fixedClock("2026-10-12T19:30:00.000Z"));
    expect(currentProgress(state, fixedClock("2026-10-12T18:00:00.000Z"))).toBe(0);
    expect(currentProgress(state, fixedClock("2026-10-12T22:00:00.000Z"))).toBe(1);
  });
});
