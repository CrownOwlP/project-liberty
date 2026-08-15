export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  event: string;
  requestId?: string;
  fields?: Record<string, string | number | boolean | null>;
}

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
