/* -------------------------------------------------------------------------
 * Defensive readers shared by the A/V continuity proxies
 *
 * The same three helpers `playback-stats.ts` keeps private, restated here
 * rather than exported from there, because this directory is additive to
 * PL-0504 and must not require an edit to a file three other lanes own. They
 * behave identically on purpose — an unavailable number is `null`, never `0`
 * and never `NaN`, for exactly the reason that file gives: `NaN` survives
 * arithmetic and `JSON.stringify` without ever failing, so a `NaN` gap span
 * becomes a gap span of zero somewhere downstream.
 *
 * Nothing here reads a clock. See `av-continuity.ts` for why that is a rule
 * rather than a preference.
 * ---------------------------------------------------------------------- */

export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * Seconds to milliseconds, for the ONE field in the
 * `requestVideoFrameCallback` metadata dictionary that is a duration in
 * seconds. See `frame-timing.ts` for the full unit table; this conversion
 * exists in one place for the same reason `secondsToMs` does in
 * `playback-stats.ts`.
 */
export function secondsToMs(value: unknown): number | null {
  const seconds = finiteOrNull(value);
  return seconds === null ? null : seconds * 1000;
}

/**
 * A media-timeline duration or position, formatted for a reason string.
 *
 * Fixed to three decimals so the same inputs always produce the same reason
 * text. A reason trail that differs run to run is not a reason trail a bug
 * report can be compared against, and the determinism rule in this project
 * covers the explanation as much as the verdict.
 */
export function formatSeconds(value: number): string {
  return `${value.toFixed(3)}s`;
}
