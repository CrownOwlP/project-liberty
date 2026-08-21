import type { LogEvent } from "./log-event";

export type { LogEvent, LogField, LogLevel } from "./log-event";
export * from "./redaction";
export * from "./cmcd-keys";
export * from "./cmcd-report";
export * from "./cmcd-collect";

/**
 * Write a structured record to the process log.
 *
 * The clock read here is why this is a SINK and not part of the CMCD
 * collection boundary: `collectCmcdEventReport` is a pure mapping so that its
 * output can be compared across permuted inputs, and a timestamp minted inside
 * it would make that comparison impossible. Time enters at the edge, once.
 */
export function log(event: LogEvent): void {
  const record = {
    timestamp: new Date().toISOString(),
    ...event
  };

  const output = JSON.stringify(record);
  if (event.level === "error") console.error(output);
  else if (event.level === "warn") console.warn(output);
  else console.log(output);
}
