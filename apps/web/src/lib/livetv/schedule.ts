/* -------------------------------------------------------------------------
 * NOW, NEXT, AND THE UPCOMING WINDOW — FROM AN INJECTED CLOCK (Wave 132, Worker E).
 *
 * THE DEFECT CLASS REMOVED: `Date.now()` INSIDE THE LOGIC. There is no reading
 * of the ambient clock anywhere in this module, and that is not a style
 * preference — it is what makes the cases that actually break testable. "What is
 * on now" has boundary behaviour at exactly the instant a programme starts, at
 * exactly the instant it ends, in the gap between two programmes, before the
 * grid begins, after it ends, and when the only entry has no stated end time. A
 * function that reads the clock itself can be tested for none of those without
 * either faking global time or waiting, and this repository tests that
 * scheduling logic does not read it.
 *
 * `LiveClock` is therefore a one-method interface and every function takes one.
 * Production passes `systemClock()`, which is the single place `Date.now()`
 * appears in this layer, and which is excluded from nothing: it is a four-line
 * adapter with no branches in it.
 *
 * SECOND DEFECT CLASS REMOVED: `null` AS AN ANSWER. "Nothing is on" has five
 * genuinely different causes — the grid is empty, the grid has not started, the
 * grid has finished, we are in a gap between two programmes, and we are inside a
 * programme whose end the feed never stated — and they have five different
 * renderings. A `EpgListing | null` collapses all five into "no listing", and a
 * surface that receives it has to guess, which is how a channel in a 20-minute
 * off-air block comes to say "this channel has no schedule". `NowAndNext` below
 * is a discriminated union over those states; the UI is total over it or it does
 * not compile.
 *
 * THIRD: AN END TIME THAT WAS NEVER STATED IS NEVER INFERRED. `epgListingSchema`
 * and `docs/LIVE_TV.md` both say it at length: the gap to the next entry is only
 * the duration if the grid is gapless, and grids have gaps, off-air blocks and
 * overlapping regional variants. A listing with `endsAt: null` that has started
 * is reported as `on_air_indeterminate_end` — a distinct state, so a progress
 * bar can decline to draw itself rather than draw a fabricated one.
 * ---------------------------------------------------------------------- */
import {
  sortEpgListings,
  type EpgInstant,
  type EpgListing,
  type EpgSchedule
} from "@liberty/contracts/domains/live";

import { millisToInstant } from "./time";

/** The clock, as a port. One method, so a test can be a literal. */
export interface LiveClock {
  /** The present, as the contract's fixed-width UTC instant. */
  now(): EpgInstant;
}

/**
 * The only `Date.now()` in this layer.
 *
 * Returns `null` from `millisToInstant` only if a runtime emitted an ISO string
 * of an unexpected width, which would break every comparison downstream; the
 * fallback is the epoch instant rather than a throw, because a clock that
 * throws turns a rendering problem into a 500.
 */
export function systemClock(): LiveClock {
  return {
    now: () => millisToInstant(Date.now()) ?? "1970-01-01T00:00:00.000Z"
  };
}

/** A clock pinned to one instant. For tests, and for one consistent render pass. */
export function fixedClock(instant: EpgInstant): LiveClock {
  return { now: () => instant };
}

export const NOW_AND_NEXT_STATES = [
  "no_listings",
  "before_schedule",
  "after_schedule",
  "in_gap",
  "on_air",
  "on_air_indeterminate_end"
] as const;
export type NowAndNextState = (typeof NOW_AND_NEXT_STATES)[number];

export type NowAndNext =
  /** The channel's schedule is empty. Not a failure: `epgScheduleSchema` says so. */
  | { readonly state: "no_listings" }
  /** The grid starts later. The viewer is early, which is a different message from a gap. */
  | { readonly state: "before_schedule"; readonly next: EpgListing }
  /** The grid has run out. The remedy is a refresh, not a wait. */
  | { readonly state: "after_schedule"; readonly previous: EpgListing }
  /** Between two programmes, or after one that ended with more to come. */
  | { readonly state: "in_gap"; readonly previous: EpgListing | null; readonly next: EpgListing }
  | { readonly state: "on_air"; readonly current: EpgListing; readonly next: EpgListing | null }
  /** Started, and the feed stated no end. Nothing is inferred; the state says so. */
  | {
      readonly state: "on_air_indeterminate_end";
      readonly current: EpgListing;
      readonly next: EpgListing | null;
    };

/**
 * Is `now` inside this listing?
 *
 * HALF-OPEN: start inclusive, end exclusive. Stated because the alternative is a
 * real bug rather than a quibble — with both ends inclusive, the instant one
 * programme ends is inside two programmes at once, and "what is on now" then
 * depends on which the loop reached first, which is order dependence again.
 */
function covers(listing: EpgListing, now: EpgInstant): boolean {
  if (now < listing.startsAt) return false;
  if (listing.endsAt === null) return true;
  return now < listing.endsAt;
}

/**
 * What is on now and what is next, for one channel's listings.
 *
 * The listings are sorted through the CONTRACT's comparator rather than here, so
 * there is one ordering in the system; `sortEpgListings` is cheap and
 * non-mutating and calling it unconditionally is better than a precondition
 * somebody has to honour.
 *
 * OVERLAP IS RESOLVED BY THE CONTRACT'S ORDER, NOT BY A SECOND RULE. Simulcasts,
 * corrected re-issues and regional opt-outs produce genuine overlap, which
 * `epgScheduleSchema` deliberately permits. When two listings cover `now`, the
 * one that sorts FIRST is reported as current — earliest start, then earliest
 * end, then id. Any other choice would be a second ordering opinion, and
 * `docs/LIVE_TV.md` is explicit that a grid sorting in the component and a cache
 * sorting elsewhere is how two surfaces disagree.
 */
export function nowAndNext(listings: readonly EpgListing[], clock: LiveClock): NowAndNext {
  const sorted = sortEpgListings(listings);
  if (sorted.length === 0) return { state: "no_listings" };

  const now = clock.now();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return { state: "no_listings" };

  const current = sorted.find((listing) => covers(listing, now)) ?? null;
  const next = sorted.find((listing) => listing.startsAt > now) ?? null;
  const previous =
    [...sorted].reverse().find((listing) => (listing.endsAt ?? listing.startsAt) <= now) ?? null;

  if (current !== null) {
    if (current.endsAt === null) return { state: "on_air_indeterminate_end", current, next };
    return { state: "on_air", current, next };
  }

  if (now < first.startsAt) return { state: "before_schedule", next: first };

  if (next === null) {
    /*
     * Nothing covers now and nothing starts later. The grid is behind us. The
     * `previous` reported is the last listing rather than the one that ended most
     * recently, which are the same thing here by construction.
     */
    return { state: "after_schedule", previous: previous ?? last };
  }

  /* THE GAP CASE: inside the grid's span, between two entries. A real state. */
  return { state: "in_gap", previous, next };
}

/** `nowAndNext` for a whole `EpgSchedule`, so a caller need not unwrap it. */
export function scheduleNowAndNext(schedule: EpgSchedule, clock: LiveClock): NowAndNext {
  return nowAndNext(schedule.listings, clock);
}

export interface UpcomingWindowOptions {
  /** How far ahead to look. Required: a default would be this module choosing a product rule. */
  readonly minutes: number;
  /**
   * Whether a listing already in progress is included.
   *
   * `true` for a "what's on" strip, which must show the row the viewer is
   * watching; `false` for a "coming up" list, where the current programme is
   * already shown above it. Required and explicit, because the two surfaces mean
   * different things by "upcoming" and a default would silently give one of them
   * the other's answer.
   */
  readonly includeInProgress: boolean;
}

export interface UpcomingWindow {
  readonly from: EpgInstant;
  readonly until: EpgInstant;
  readonly listings: readonly EpgListing[];
  /** True when nothing at all falls in the window. The gap case, at window scale. */
  readonly empty: boolean;
}

/**
 * Listings that begin (or, optionally, are in progress) within the next N minutes.
 *
 * HALF-OPEN AT THE FAR END for the same reason `covers` is: a programme starting
 * at exactly `until` belongs to the next window, not to both.
 */
export function upcomingWindow(
  listings: readonly EpgListing[],
  clock: LiveClock,
  options: UpcomingWindowOptions
): UpcomingWindow {
  const from = clock.now();
  const until = millisToInstant(Date.parse(from) + Math.max(0, options.minutes) * 60_000) ?? from;
  /*
   * A ZERO-WIDTH WINDOW SELECTS NOTHING, including a programme in progress.
   * `minutes: 0` (or a negative value, clamped to 0) describes an interval with
   * no extent, and "what is on now" is `nowAndNext`'s question rather than this
   * one. Returning the current programme here would make a caller that passed 0
   * — a mis-read configuration value, say — receive a plausible non-empty answer
   * and never find out.
   */
  if (until <= from) return { from, until, listings: [], empty: true };
  const sorted = sortEpgListings(listings);
  const selected = sorted.filter((listing) => {
    if (listing.startsAt >= until) return false;
    if (listing.startsAt >= from) return true;
    return options.includeInProgress && covers(listing, from);
  });
  return { from, until, listings: selected, empty: selected.length === 0 };
}

/**
 * How far through the current programme we are, 0..1, or `null`.
 *
 * `null` for every case where the answer is not known — no current programme, or
 * a current programme with no stated end — rather than `0`. A progress bar at 0%
 * is a claim that the programme just started, and a listing with no end time
 * supports no such claim. This is the single place that refusal is expressed, so
 * no component recomputes it from `endsAt` and gets the null case wrong.
 */
export function currentProgress(state: NowAndNext, clock: LiveClock): number | null {
  if (state.state !== "on_air") return null;
  const endsAt = state.current.endsAt;
  if (endsAt === null) return null;
  const start = Date.parse(state.current.startsAt);
  const end = Date.parse(endsAt);
  const now = Date.parse(clock.now());
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now)) return null;
  if (end <= start) return null;
  const ratio = (now - start) / (end - start);
  return Math.min(1, Math.max(0, ratio));
}
