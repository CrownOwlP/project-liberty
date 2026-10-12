/* -------------------------------------------------------------------------
 * Subtitle and audio synchronisation offsets: bounded, stepped, resettable,
 * and per CONTENT rather than global (W132-D, items 2 and 3)
 *
 * ==========================================================================
 * ONE MODULE FOR TWO CHANNELS, AND WHY THAT IS NOT OVER-GENERALISATION
 * ==========================================================================
 *
 * Subtitle timing and audio timing are the same arithmetic — a signed seconds
 * offset, clamped, nudged by a step, reset to zero — over two different bounds.
 * Writing them twice is the defect class here: two copies drift, and the copy
 * that drifts is always the one with fewer callers, so the bug surfaces as
 * "audio sync resets itself but subtitle sync doesn't" long after the change
 * that caused it. The two differ ONLY in their bounds, which is a value, so
 * they share a function and differ in an argument.
 *
 * ==========================================================================
 * THE BOUNDS ARE DIFFERENT, AND BOTH NUMBERS ARE ARGUED FOR
 * ==========================================================================
 *
 * SUBTITLES: +/- 30 seconds. A mis-timed subtitle file is a different artefact
 * from the video — a fan-made SRT cut for a release with a different intro
 * length is routinely tens of seconds out, and a viewer fixing one needs to be
 * able to reach it. The step is 0.25s, because the perceptible threshold for a
 * caption appearing early is a few hundred milliseconds.
 *
 * AUDIO: +/- 5 seconds, stepped by 0.05s. This is a LIP-SYNC control, not a
 * re-mux: a real A/V desynchronisation is a few frames to a few hundred
 * milliseconds, and the perceptible threshold is about 45ms for audio leading
 * video. A control that offered +/- 30s here would make the useful range a
 * sliver of the slider, so every drag would overshoot. The wider range is also
 * actively harmful: any audio offset is implemented by holding a buffer on one
 * side, and five seconds is already a lot of buffer to ask of a browser path.
 *
 * ==========================================================================
 * AN OFFSET BELONGS TO A TITLE, NOT TO A PROFILE
 * ==========================================================================
 *
 * This is the defect class that matters most and it is a *scoping* one, so it
 * is expressed in the types rather than in a comment alone. A viewer who nudges
 * subtitles 12 seconds later to fix one bad subtitle file, and then watches
 * anything else, must not get 12-second-late subtitles on the next title. A
 * global "subtitle delay" preference is therefore wrong, and `OffsetScope`
 * carries the content id so the store cannot be written without one.
 *
 * `isDefault` exists for the same reason: a zero offset must be storable as
 * "nothing to remember" so the store does not accumulate a row per title
 * watched, and so a caller can decide to DELETE rather than write a zero.
 *
 * ==========================================================================
 * WHAT THIS DOES NOT DO
 * ==========================================================================
 *
 * It computes an offset. It does not apply one. Applying a subtitle offset
 * means re-timing cues in the text display; applying an audio offset on the web
 * path has no `HTMLMediaElement` API at all and would need the engine's own
 * support. So the honest status of the audio channel is: the model is real and
 * tested, the ACTUATION is not implemented and is reported as such rather than
 * shipped as a slider that moves and does nothing.
 *
 * NOTHING HERE READS A BROWSER API, A CLOCK OR A STORE.
 * ---------------------------------------------------------------------- */

export type OffsetChannel = "subtitle" | "audio";

export interface OffsetBounds {
  /** Largest magnitude in either direction, in seconds. Always positive. */
  readonly limitSeconds: number;
  /** One nudge, in seconds. Every reachable offset is a multiple of this. */
  readonly stepSeconds: number;
}

export const OFFSET_BOUNDS: Readonly<Record<OffsetChannel, OffsetBounds>> = Object.freeze({
  subtitle: Object.freeze({ limitSeconds: 30, stepSeconds: 0.25 }),
  audio: Object.freeze({ limitSeconds: 5, stepSeconds: 0.05 })
});

/** No offset. The value every channel starts at and `resetOffset` returns. */
export const NO_OFFSET = 0;

/**
 * Which content an offset is remembered against.
 *
 * A struct of one field rather than a bare string, so a caller cannot pass a
 * profile id positionally where a content id belongs — the mistake that makes
 * an offset global.
 */
export interface OffsetScope {
  readonly contentId: string;
}

/**
 * Rounding to the step grid, done in INTEGER STEPS and not with a modulo on a
 * float.
 *
 * `-0.1 % 0.05` is not 0 in binary floating point, and a naive
 * `value - (value % step)` accumulates error across repeated nudges until the
 * displayed offset reads `0.15000000000000002`. Counting steps and multiplying
 * back keeps every stored value a clean multiple, which is also what makes
 * `isDefault` a reliable equality test against zero rather than an epsilon
 * comparison.
 */
function snapToStep(value: number, stepSeconds: number): number {
  const steps = Math.round(value / stepSeconds);
  const snapped = steps * stepSeconds;
  /* One decimal place more than the finest step, so 0.05 * 3 is 0.15 and not
   * 0.15000000000000002. The step grid is a multiple of 0.05, so three places
   * is lossless for every reachable value. */
  return Number(snapped.toFixed(3));
}

/**
 * An arbitrary number turned into a legal offset for a channel.
 *
 * CLAMPED AND NOT REJECTED, because this is where a slider drag, a held key and
 * a stored value from another build all arrive, and the right answer to "15
 * seconds of audio offset" is five, not zero. A non-finite input is `NO_OFFSET`:
 * `NaN` is not a request.
 */
export function clampOffset(seconds: number, channel: OffsetChannel): number {
  const { limitSeconds, stepSeconds } = OFFSET_BOUNDS[channel];
  if (!Number.isFinite(seconds)) return NO_OFFSET;
  const bounded = Math.min(limitSeconds, Math.max(-limitSeconds, seconds));
  /* Snap first, then re-clamp: snapping a value already at the limit can only
   * land on the limit itself, but snapping 29.9 upward must not produce 30.25. */
  return Math.min(limitSeconds, Math.max(-limitSeconds, snapToStep(bounded, stepSeconds)));
}

export type OffsetDirection = "later" | "earlier";

/**
 * One nudge, saturating at the bound.
 *
 * `later` is POSITIVE and that convention is written down here because it is
 * the one thing about this module a caller can get backwards and not notice
 * until a viewer reports that the fix button makes it worse: a positive
 * subtitle offset DELAYS the cue — the text appears later than the audio it
 * belongs to. Same sign convention for audio: positive delays the audio.
 */
export function nudgeOffset(
  seconds: number,
  channel: OffsetChannel,
  direction: OffsetDirection
): number {
  const { stepSeconds } = OFFSET_BOUNDS[channel];
  const from = clampOffset(seconds, channel);
  const delta = direction === "later" ? stepSeconds : -stepSeconds;
  return clampOffset(from + delta, channel);
}

/** Back to zero. A named function because "the reset button" is a requirement. */
export function resetOffset(): number {
  return NO_OFFSET;
}

/** Whether there is anything worth storing. See the header on scoping. */
export function isDefaultOffset(seconds: number): boolean {
  return seconds === NO_OFFSET;
}

/**
 * `In sync`, `+1.25s late`, `-0.40s early`.
 *
 * The sign is shown AND named. A bare `+1.25s` is ambiguous to the viewer
 * trying to fix the problem — they cannot tell whether the number describes the
 * correction or the error — and this control is only ever used by someone who
 * is already confused about which way round it goes.
 */
export function describeOffset(seconds: number, channel: OffsetChannel): string {
  const value = clampOffset(seconds, channel);
  if (value === NO_OFFSET) return "In sync";
  /* Two places for both channels: the finest step is 0.05s, so two places
   * render every reachable value exactly, and a fixed width stops the digits
   * jumping as a viewer holds the nudge key. */
  const magnitude = Math.abs(value).toFixed(2);
  return value > 0 ? `+${magnitude}s late` : `-${magnitude}s early`;
}

/** Fraction of the slider track, 0 at the negative bound and 1 at the positive. */
export function offsetSliderFraction(seconds: number, channel: OffsetChannel): number {
  const { limitSeconds } = OFFSET_BOUNDS[channel];
  const value = clampOffset(seconds, channel);
  return (value + limitSeconds) / (2 * limitSeconds);
}

/** The inverse, for a slider that reports a fraction. */
export function offsetFromSliderFraction(fraction: number, channel: OffsetChannel): number {
  const { limitSeconds } = OFFSET_BOUNDS[channel];
  if (!Number.isFinite(fraction)) return NO_OFFSET;
  const bounded = Math.min(1, Math.max(0, fraction));
  return clampOffset(bounded * 2 * limitSeconds - limitSeconds, channel);
}

/* ===========================================================================
 * PERSISTENCE
 * ======================================================================== */

export type OffsetDecodeReason =
  | "not_chosen"
  | "stored"
  | "unreadable"
  /** Stored, finite, and outside this channel's bounds — clamped, not dropped. */
  | "out_of_bounds";

export interface OffsetDecode {
  readonly seconds: number;
  readonly reason: OffsetDecodeReason;
  readonly storedValue: number | null;
}

export function encodeOffset(seconds: number, channel: OffsetChannel): string {
  return String(clampOffset(seconds, channel));
}

/**
 * A stored offset for one channel, with the reason.
 *
 * `out_of_bounds` is distinguished from `stored` because it is the signal that
 * the bounds in this file changed since the value was written, which is exactly
 * the moment someone needs to know that a viewer's saved 12-second subtitle fix
 * is now being clamped to a number they did not choose.
 */
export function decodeOffset(raw: unknown, channel: OffsetChannel): OffsetDecode {
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (trimmed === null || trimmed === undefined || trimmed === "") {
    return { seconds: NO_OFFSET, reason: "not_chosen", storedValue: null };
  }
  const value = typeof trimmed === "string" ? Number(trimmed) : trimmed;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { seconds: NO_OFFSET, reason: "unreadable", storedValue: null };
  }
  const clamped = clampOffset(value, channel);
  const limit = OFFSET_BOUNDS[channel].limitSeconds;
  return {
    seconds: clamped,
    reason: Math.abs(value) > limit ? "out_of_bounds" : "stored",
    storedValue: value
  };
}
