/* -------------------------------------------------------------------------
 * Playback speed: what rates exist, what a stored one means, and what the
 * clock says while one is in force (W132-D, item 1)
 *
 * ==========================================================================
 * WHY A MODULE AND NOT A `<select>` BOUND TO `element.playbackRate`
 * ==========================================================================
 *
 * The defect class this removes is THE UNCLAMPED PASS-THROUGH. A rate control
 * written as a slider wired straight to the element accepts `0`, which is not
 * "slow" but "paused with the play button still lit"; it accepts `16`, past
 * every browser's audio-pitch-correction range, so the sound drops out and the
 * player looks broken; it accepts `-1`, which `HTMLMediaElement` rejects by
 * throwing `NotSupportedError` on assignment, and an exception out of an
 * `onChange` handler in a `"use client"` component is exactly the shape of the
 * Windows-only client TypeError the lead is chasing. A number is therefore
 * never handed to an element until this file has agreed it is one of a closed
 * set.
 *
 * SATURATING AND NOT WRAPPING, which is the second defect class. `<` and `>`
 * are held down. A list that wraps turns one extra keypress at the slow end
 * into 2x playback — a viewer stepping down to 0.25x to read a frame gets
 * double speed and full-volume audio instead. `rateStep` stops at both ends
 * and says so by returning the rate it was already at.
 *
 * ==========================================================================
 * THE TIME-REMAINING FIELD IS PART OF THE RATE MODEL, NOT OF THE SEEK BAR
 * ==========================================================================
 *
 * `controls-state.ts` formats a timecode; it has no opinion about rate, and
 * that is the bug a rate control introduces into a control bar that already
 * works. At 1.5x, the thirty minutes of MEDIA left are twenty minutes of
 * WALL CLOCK, and "40 minutes left" next to a 1.5x badge is a wrong number
 * rather than a stylistic choice — it is the number a viewer uses to decide
 * whether to start the episode before a meeting.
 *
 * `remainingMediaSeconds` and `remainingWallClockSeconds` are therefore two
 * named functions rather than one with a flag, because the two readings are
 * both legitimately wanted in the same bar (the seek bar is a media-time
 * scale; the "time left" label is a wall-clock promise) and a single function
 * would make the caller's choice invisible at the call site.
 *
 * NULL IS NOT ZERO here, for the reason `formatTimecode` already states: a
 * live stream has no duration and a VOD has none until metadata arrives, and
 * answering `0` tells a viewer the programme has finished.
 *
 * ==========================================================================
 * PERSISTENCE IS A CODEC WITH A REASON, NOT A CAST
 * ==========================================================================
 *
 * The stored value is read back from a store this file does not own, which
 * means it can be absent, a string from a querystring, a number from JSON, a
 * rate this build no longer offers, or junk. `decodeRate` answers all of them
 * with a REASON as well as a value (product invariant 4: a playback decision
 * exposes a trail sufficient to debug it). A silent `?? 1` is the defect:
 * a viewer whose stored 1.75 stopped being applied after a release, and a
 * viewer who never chose a rate, are indistinguishable in a log, so the bug
 * report reads "my speed setting doesn't stick sometimes" and nobody can
 * reproduce it.
 *
 * NOTHING HERE TOUCHES A BROWSER API, A CLOCK OR A STORE. Every value arrives
 * as an argument, so every branch below — including each end of the step
 * range and each decode reason — is reachable in `environment: "node"` with
 * no media element in existence. Module evaluation defines two frozen arrays
 * and some functions, so importing this file cannot throw in a WebView2
 * build that is missing anything.
 * ---------------------------------------------------------------------- */

/**
 * The rates this player offers, ascending.
 *
 * QUARTER STEPS, AND THAT IS AN ARITHMETIC DECISION as much as a product one:
 * every value is a multiple of 1/4, so each is exactly representable in binary
 * floating point and `===` against a parsed `"1.25"` is reliable. A list
 * containing 1/3 or 1.1 would make `isPlaybackRate(JSON.parse(stored))` fail
 * for a value the viewer really did choose, and the resulting bug — a stored
 * rate that is silently rejected on about half of reads — is the kind that
 * gets closed as unreproducible.
 *
 * The ceiling is 2x rather than 4x because browsers stop applying pitch
 * correction somewhere above 2x and the audio becomes unintelligible; offering
 * a rate whose audio does not work is offering a broken control.
 */
export const PLAYBACK_RATES = Object.freeze([
  0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2
] as const);

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/** The rate a session starts at, and the rate `reset` returns to. */
export const NORMAL_RATE: PlaybackRate = 1;

/** Membership, as a type guard, so a caller cannot forget the clamp. */
export function isPlaybackRate(value: unknown): value is PlaybackRate {
  return typeof value === "number" && (PLAYBACK_RATES as readonly number[]).includes(value);
}

/**
 * The offered rate closest to an arbitrary number.
 *
 * Used for a value that came from outside the closed set — a slider position, a
 * rate an older build offered, a configuration file. Out-of-range numbers CLAMP
 * to an end rather than falling back to 1x: someone who asked for 8x wants the
 * fastest thing available, and answering "normal speed" for an input that was
 * merely too large is a surprise in the opposite direction from the request.
 *
 * A non-finite input has no closest member and answers `NORMAL_RATE`, because
 * `NaN` is not a request for anything.
 */
export function nearestRate(value: number): PlaybackRate {
  if (!Number.isFinite(value)) return NORMAL_RATE;
  let best: PlaybackRate = PLAYBACK_RATES[0];
  let bestDistance = Math.abs(value - best);
  for (const rate of PLAYBACK_RATES) {
    const distance = Math.abs(value - rate);
    /* `<` and not `<=`, so a value exactly between two offered rates settles on
     * the SLOWER one deterministically rather than depending on array order
     * changing one day. Slower is the safer direction: it is the one a viewer
     * notices immediately and corrects. */
    if (distance < bestDistance) {
      best = rate;
      bestDistance = distance;
    }
  }
  return best;
}

export type RateDirection = "faster" | "slower";

/**
 * One step along the list, SATURATING at both ends.
 *
 * `current` is taken as a number rather than a `PlaybackRate` on purpose: the
 * value in hand may have come from a decode that reported a reason, and
 * `nearestRate` is the one place that turns an arbitrary number into a member.
 * Requiring the narrow type here would push that conversion out to every
 * keystroke handler, which is how two of them end up disagreeing.
 */
export function rateStep(current: number, direction: RateDirection): PlaybackRate {
  const from = isPlaybackRate(current) ? current : nearestRate(current);
  const index = PLAYBACK_RATES.indexOf(from);
  const next = direction === "faster" ? index + 1 : index - 1;
  if (next < 0 || next >= PLAYBACK_RATES.length) return from;
  /* `noUncheckedIndexedAccess` is on in this project, so an index read is
   * `T | undefined` even inside a bounds check tsc cannot follow. The fallback
   * is `from`, which keeps the saturating contract: a step that cannot be taken
   * leaves the rate alone rather than reaching for a default. */
  return PLAYBACK_RATES[next] ?? from;
}

/** `1×`, `1.25×`. The multiplication sign, not the letter x. */
export function describeRate(rate: number): string {
  return `${rate}×`;
}

/**
 * Seconds of MEDIA left — the seek bar's scale, unaffected by rate.
 *
 * `null` for an unknown duration, and clamped at zero so a position past a
 * duration the element has not yet revised (a live edge, or a seek to the very
 * end) cannot produce a negative "time left".
 */
export function remainingMediaSeconds(
  positionSeconds: number,
  durationSeconds: number | null
): number | null {
  if (durationSeconds === null || !Number.isFinite(durationSeconds)) return null;
  if (!Number.isFinite(positionSeconds)) return null;
  return Math.max(0, durationSeconds - positionSeconds);
}

/**
 * Seconds of WALL CLOCK left at a given rate — what a "time left" label owes
 * the viewer.
 *
 * A rate of 0 is not in `PLAYBACK_RATES` and cannot arrive from this module,
 * but it can arrive from a caller holding a raw number, and `x / 0` is
 * `Infinity` rather than an error. Answering `null` says "unknown", which is a
 * reading a label can render as `--:--`; `Infinity` is one it would print.
 */
export function remainingWallClockSeconds(
  positionSeconds: number,
  durationSeconds: number | null,
  rate: number
): number | null {
  const media = remainingMediaSeconds(positionSeconds, durationSeconds);
  if (media === null) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return media / rate;
}

/* ===========================================================================
 * PERSISTENCE
 * ======================================================================== */

export type RateDecodeReason =
  /** Nothing stored. A viewer who has never chosen, which is not a failure. */
  | "not_chosen"
  /** Stored, and one of the rates this build offers. */
  | "stored"
  /** Stored as something that is not a finite number at all. */
  | "unreadable"
  /** A finite number this build does not offer — an older or newer rate list. */
  | "not_offered";

export interface RateDecode {
  readonly rate: PlaybackRate;
  readonly reason: RateDecodeReason;
  /** What was actually stored, for the trail. `null` when nothing was. */
  readonly storedValue: number | null;
}

/** The canonical string form. Stable across builds; `1` and not `1.0`. */
export function encodeRate(rate: PlaybackRate): string {
  return String(rate);
}

/**
 * A stored rate, with the reason it is what it is.
 *
 * Accepts a number or a string, because a rate legitimately arrives from JSON
 * (number) and from a querystring (string), and forcing one shape on the caller
 * would put a `Number(...)` cast at every call site — each of which would turn
 * `""` into 0 and `"abc"` into `NaN` with no reason recorded. That cast IS the
 * defect this function replaces.
 *
 * `not_offered` snaps to the nearest offered rate rather than to 1x, so a
 * profile that stored 1.9 under a build with finer steps keeps approximately
 * the speed it asked for — and the reason says the value was migrated, so the
 * caller can choose to write the snapped value back.
 */
export function decodeRate(raw: unknown): RateDecode {
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  /* A blank string is NOT_CHOSEN and not `0`. `Number("")` and `Number(" ")`
   * are both 0, which is a rate no element accepts, so a store that round-trips
   * an unset field as an empty string would otherwise decode to the slowest
   * offered rate — a viewer who chose nothing getting 0.25x playback. */
  if (trimmed === null || trimmed === undefined || trimmed === "") {
    return { rate: NORMAL_RATE, reason: "not_chosen", storedValue: null };
  }
  const value = typeof trimmed === "string" ? Number(trimmed) : trimmed;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { rate: NORMAL_RATE, reason: "unreadable", storedValue: null };
  }
  if (isPlaybackRate(value)) {
    return { rate: value, reason: "stored", storedValue: value };
  }
  return { rate: nearestRate(value), reason: "not_offered", storedValue: value };
}
