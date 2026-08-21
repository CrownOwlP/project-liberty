/* -------------------------------------------------------------------------
 * The structured record every sink in this package emits
 *
 * Split out of `index.ts` so that modules which only PRODUCE log events —
 * `cmcd-collect.ts` is the first — can import the shape without importing the
 * barrel that re-exports them. A `import type` from the barrel would erase
 * cleanly today, but the first non-type import would close the cycle silently,
 * and a module cycle in a boundary that runs on every request is not a thing to
 * discover in production.
 *
 * `LogField` is deliberately flat and scalar. `docs/RESEARCH_PLAYBACK.md` rules
 * that CMCD is converted to OpenTelemetry at the SERVER boundary rather than in
 * the player bundle, so this record is the shape an OTel log exporter attaches
 * to: dotted names, no nesting, no arrays, and `null` meaning "known to be
 * unavailable" rather than "zero". Anything richer would have to be flattened
 * again by whoever wires the exporter, and the flattening is exactly where the
 * unit and redaction guarantees would be re-litigated.
 * ---------------------------------------------------------------------- */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * `null` is a VALUE here, not an absence: it asserts that the producer looked
 * and the number was not available. Dropping the field instead would be a
 * weaker claim, and emitting `0` would be a false one — see `cmcd-collect.ts`,
 * where an unavailable `NaN` becomes `null` for precisely this reason.
 */
export type LogField = string | number | boolean | null;

export interface LogEvent {
  level: LogLevel;
  event: string;
  requestId?: string;
  fields?: Record<string, LogField>;
}
