import {
  CLIENT_FAILURE_LOG_PREFIX,
  formatClientFailureLine,
  readClientFailure
} from "../../../../../lib/diagnostics/client-failure";

/* -------------------------------------------------------------------------
 * The route that turns a caught render failure into a line in the log the
 * operator already reads (PL-0759).
 *
 * WHY A ROUTE AND NOT A NEW TRANSPORT. The Rust shell already captures the
 * sidecar's stdout and stderr, redacts tokens, budget-caps the volume and
 * writes it to `%LOCALAPPDATA%\app.projectliberty.desktop\logs\sidecar.log`.
 * That file is the one the operator pastes. A browser-side failure had no way
 * into it; `console.error` in the page goes to the webview's console, which
 * nothing captures. One POST closes the gap and adds no file, no port and no
 * place to look.
 *
 * IT ANSWERS 204 WHETHER OR NOT IT LOGGED. The caller is a render boundary with
 * nothing useful to do about a refusal, and a status that distinguished
 * "logged" from "rejected" would make this endpoint an oracle for what the
 * server accepts. A body that is not a report is the one exception, because a
 * caller sending nonsense should be told it is nonsense -- and nothing on that
 * path is logged, so the refusal cannot be used to write to the log either.
 * ---------------------------------------------------------------------- */

/**
 * The most a report may weigh.
 *
 * Generous against the five bounded fields the contract defines and small
 * enough that a crafted POST cannot make the server read a megabyte before
 * refusing it. The body is read as text first for exactly that reason: a
 * `request.json()` on an unbounded body parses whatever arrives.
 */
export const MAX_CLIENT_FAILURE_BYTES = 2048;

/**
 * How many reports may reach the log per window.
 *
 * A RENDER LOOP IS THE EXPECTED CASE, NOT AN ATTACK. `global-error` offers a
 * "Try again" button, and a failure that reproduces will be reported again
 * every time it is pressed; a component in a remount loop could report
 * continuously. `sidecar_log.rs` has its own byte budget, so the log cannot be
 * filled -- but it can be drowned, and the line that matters is the first one.
 * This keeps the first few and drops the rest, which is the opposite of the
 * usual choice and the right one here: the tenth copy of a failure says nothing
 * the first did not.
 */
export const CLIENT_FAILURE_BUDGET = 8;
export const CLIENT_FAILURE_WINDOW_MS = 60_000;

/** The budget state. Module-scoped, because the process is the sidecar. */
interface Budget {
  windowStartedAt: number;
  used: number;
  suppressed: number;
}

const budget: Budget = { windowStartedAt: 0, used: 0, suppressed: 0 };

/**
 * May this report be logged, and if a window just closed, how many were lost?
 *
 * Returns the decision plus a one-off note so the log can say that it stopped
 * recording rather than appearing to have stopped happening. Exported for the
 * tests, which drive the clock rather than waiting on it.
 */
export function admitReport(now: number): { log: boolean; suppressedSinceLast: number } {
  if (now - budget.windowStartedAt >= CLIENT_FAILURE_WINDOW_MS) {
    const lost = budget.suppressed;
    budget.windowStartedAt = now;
    budget.used = 1;
    budget.suppressed = 0;
    return { log: true, suppressedSinceLast: lost };
  }
  if (budget.used < CLIENT_FAILURE_BUDGET) {
    budget.used += 1;
    return { log: true, suppressedSinceLast: 0 };
  }
  budget.suppressed += 1;
  return { log: false, suppressedSinceLast: 0 };
}

/** Reset the budget. Tests only; nothing in the application calls it. */
export function resetClientFailureBudget(): void {
  budget.windowStartedAt = 0;
  budget.used = 0;
  budget.suppressed = 0;
}

export interface ClientFailureOutcome {
  readonly status: 204 | 400 | 413;
  /** The exact lines written to stderr. Empty when nothing was logged. */
  readonly logged: readonly string[];
}

/**
 * The whole decision, as a pure function of the body text and the clock.
 *
 * Pure so the budget, the bounds and the log line are testable without a
 * `Request`, a server or a captured console -- the route below is the thin part
 * and this is the part with rules in it.
 */
export function handleClientFailureReport(
  bodyText: string,
  now: number
): ClientFailureOutcome {
  if (bodyText.length > MAX_CLIENT_FAILURE_BYTES) {
    return { status: 413, logged: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, logged: [] };
  }
  const report = readClientFailure(parsed);
  if (report === null) return { status: 400, logged: [] };

  const admission = admitReport(now);
  if (!admission.log) return { status: 204, logged: [] };

  const lines = [formatClientFailureLine(report)];
  if (admission.suppressedSinceLast > 0) {
    lines.push(
      `${CLIENT_FAILURE_LOG_PREFIX} ${JSON.stringify({
        suppressedInPreviousWindow: admission.suppressedSinceLast
      })}`
    );
  }
  return { status: 204, logged: lines };
}
