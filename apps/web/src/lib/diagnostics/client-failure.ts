/* -------------------------------------------------------------------------
 * What the browser says when a render boundary catches something (PL-0759).
 *
 * THE DEFECT THIS EXISTS FOR, AND IT IS A DEFECT IN A COMMENT AS MUCH AS IN
 * CODE. The installed Windows application showed `global-error.tsx`:
 *
 *     Project Liberty could not start this page
 *     Something failed before the application frame could render. Reloading
 *     usually clears it. If it does not, THE APPLICATION LOG HAS THE DETAIL.
 *
 * The log did not have the detail. `global-error.tsx` took only `reset` -- it
 * never received Next's `error` argument -- logged nothing, and showed no
 * digest, with a comment explaining that the log had it. So the one screen the
 * operator was looking at was the only screen in this application that cannot
 * say what went wrong, and three rounds of Windows work were spent guessing at
 * a failure that was reporting itself to nobody.
 *
 * WHAT THIS MODULE IS. A description of a caught render failure, sanitised, and
 * a fire-and-forget way to send it to the local server -- whose stdout and
 * stderr the Rust shell already captures, redacts and writes to
 * `%LOCALAPPDATA%\app.projectliberty.desktop\logs\sidecar.log`. No new log
 * file, no new transport, no new place for an operator to look: the one place
 * they already paste from gains the thing it was missing.
 *
 * IT IMPORTS NOTHING, and that is a requirement rather than a coincidence.
 * `global-error.tsx` replaces the whole document and must not import the shell,
 * the stylesheet, or anything else that could be what just failed. This module
 * pulls in no React, no CSS, no contract package and no other application
 * module; it uses `fetch` and string operations. A reporter that could itself
 * throw inside the last-resort boundary would turn a diagnosable failure into a
 * blank page, which is the state that boundary was built to remove.
 *
 * WHAT IS DELIBERATELY NOT SENT. The error MESSAGE and the STACK. A message
 * from a server component can carry a file path, a connection string, a query
 * or a token; a stack carries build paths and, in a dev build, source. The
 * boundary's existing comment is right that a digest is the only thing safe to
 * surface, and the correction is to actually surface it rather than to omit it
 * and claim the log has it. `errorName` is sent because a constructor name is
 * a closed vocabulary in practice and is checked against a strict pattern
 * before it leaves; `hadMessage` is sent as a BOOLEAN so a reader can tell an
 * error that said nothing from one whose text was withheld here.
 * ---------------------------------------------------------------------- */

/** Where a report is posted. One path, named once, so the route and the client agree. */
export const CLIENT_FAILURE_PATH = "/api/v1/diagnostics/client-failure";

/**
 * Which boundary caught it. A closed set, because the value is written into a
 * log line an operator reads and a free-form string would let any future caller
 * invent a vocabulary nobody has to explain.
 */
export const FAILURE_BOUNDARIES = ["global-error", "route-error"] as const;
export type FailureBoundary = (typeof FAILURE_BOUNDARIES)[number];

/**
 * Bounds. Every field crossing this boundary is length-capped before it is
 * logged, because the log is a file the shell budget-caps and an operator
 * pastes: one unbounded field is how a diagnostic becomes a denial of service
 * against its own log.
 */
export const MAX_DIGEST_LENGTH = 64;
export const MAX_ERROR_NAME_LENGTH = 64;
export const MAX_PATHNAME_LENGTH = 256;

/** A digest is Next's own correlation id: lowercase hex, nothing else. */
const DIGEST_PATTERN = /^[0-9a-f]+$/;
/** A constructor name. Deliberately narrower than JavaScript allows. */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_$]*$/;

export interface ClientFailureReport {
  readonly boundary: FailureBoundary;
  /** Path only. Query and fragment are removed before this is built. */
  readonly pathname: string;
  readonly digest: string | null;
  readonly errorName: string | null;
  /** Whether the error carried a message, NOT the message. */
  readonly hadMessage: boolean;
}

/**
 * A path with no query and no fragment, bounded.
 *
 * THE QUERY IS DROPPED RATHER THAN TRUNCATED. `/search?q=...` carries what the
 * viewer typed, and a diagnostic has no business recording that. `/browse`'s
 * filters are lost with it, which is a real cost and the right one: the route
 * is what identifies the failing boundary.
 */
export function sanitisePathname(raw: string): string {
  const withoutFragment = raw.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const path = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return path.slice(0, MAX_PATHNAME_LENGTH);
}

/** A value that matches `pattern` within `limit`, or `null`. Never a truncation. */
function constrained(value: unknown, pattern: RegExp, limit: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > limit) return null;
  return pattern.test(value) ? value : null;
}

/**
 * Describe a caught failure.
 *
 * Total: anything may be thrown in JavaScript, including a string, `null` or an
 * object with a throwing getter, and this is called from the last-resort
 * boundary. Every field access is guarded, and a value that does not match its
 * pattern becomes `null` rather than being coerced -- a report saying "no
 * digest" is honest, and one carrying a laundered half-digest is not.
 */
export function describeClientFailure(
  boundary: FailureBoundary,
  error: unknown,
  pathname: string
): ClientFailureReport {
  let digest: unknown;
  let name: unknown;
  let message: unknown;
  try {
    const bag = error as { digest?: unknown; name?: unknown; message?: unknown } | null;
    digest = bag?.digest;
    name = bag?.name;
    message = bag?.message;
  } catch {
    /* A throwing getter is not a reason to lose the report. */
  }
  return {
    boundary,
    pathname: sanitisePathname(pathname),
    digest: constrained(digest, DIGEST_PATTERN, MAX_DIGEST_LENGTH),
    errorName: constrained(name, ERROR_NAME_PATTERN, MAX_ERROR_NAME_LENGTH),
    hadMessage: typeof message === "string" && message.length > 0
  };
}

/**
 * Re-validate a report that arrived over the wire.
 *
 * THE SERVER DOES NOT TRUST THE CLIENT THAT SHARES ITS ORIGIN. The body reaches
 * a line in a log file an operator pastes into a conversation, so it is
 * re-sanitised with the same rules that produced it rather than being believed
 * because it came from our own page. Returns `null` for anything that is not a
 * report, which the route answers with a refusal.
 */
export function readClientFailure(body: unknown): ClientFailureReport | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const bag = body as Record<string, unknown>;
  const boundary = FAILURE_BOUNDARIES.find((candidate) => candidate === bag.boundary);
  if (boundary === undefined) return null;
  if (typeof bag.pathname !== "string" || bag.pathname.length === 0) return null;
  return {
    boundary,
    pathname: sanitisePathname(bag.pathname),
    digest: constrained(bag.digest, DIGEST_PATTERN, MAX_DIGEST_LENGTH),
    errorName: constrained(bag.errorName, ERROR_NAME_PATTERN, MAX_ERROR_NAME_LENGTH),
    hadMessage: bag.hadMessage === true
  };
}

/**
 * The one line that reaches the log.
 *
 * A PREFIX AND ONE JSON OBJECT, because the consumer is `sidecar_log.rs` and an
 * operator's eye. The prefix is greppable and the payload is a single line, so
 * a failure that repeats does not become a wall. Built from the re-validated
 * report, never from the request body.
 */
export const CLIENT_FAILURE_LOG_PREFIX = "liberty-client-failure";

export function formatClientFailureLine(report: ClientFailureReport): string {
  return `${CLIENT_FAILURE_LOG_PREFIX} ${JSON.stringify(report)}`;
}

/**
 * Send a report, and never let sending it become the failure.
 *
 * `void`, not a promise: the caller is a render boundary and must not await
 * anything. `keepalive` so a report survives the navigation a "Try again"
 * causes. Every failure path is swallowed -- on a deployment there is no
 * sidecar token, so this POST is answered 403 by the request guard and that is
 * the correct outcome rather than an error to surface.
 */
export function reportClientFailure(report: ClientFailureReport): void {
  try {
    void fetch(CLIENT_FAILURE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
      cache: "no-store"
    }).catch(() => undefined);
  } catch {
    /* No global fetch, a blocked request, a CSP refusal: all non-events here. */
  }
}
