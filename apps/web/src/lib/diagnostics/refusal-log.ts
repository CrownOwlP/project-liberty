import { sanitisePathname } from "./client-failure";

/* -------------------------------------------------------------------------
 * What the request guard writes down when it refuses something (PL-0759).
 *
 * THE QUESTION THIS ANSWERS, AND IT WAS UNANSWERABLE FOR THREE ROUNDS: does
 * the installed WebView get 200, 403, or nothing? The guard in `proxy.ts`
 * answers a refusal with a bare 403, no body and no reason -- deliberately, so
 * the wire cannot be used as an oracle for which check failed. The consequence
 * nobody accounted for is that a refusal left NO TRACE ANYWHERE. PL-0753 was
 * diagnosed from an operator's screenshot of a browser error page.
 *
 * A LOG LINE IS NOT AN ORACLE. The wire still says one thing for every
 * failure; this writes to the sidecar's stderr, which the Rust shell captures
 * into a file on the machine that is already running the server. Anyone who
 * can read it can read the token environment too.
 *
 * WHAT IT RECORDS AND WHY IT IS NOT THE REFUSAL REASON. `policy.ts` returns a
 * single code by design and this module does not reach past it to find out
 * more. It records three FACTS ABOUT THE REQUEST that are visible to the
 * caller anyway -- the method, the path, and whether a token header and a Host
 * header were present at all. Between them they separate the cases that matter:
 * a webview that never attaches the token (PL-0753's defect) from one that
 * attaches it to some requests and not others, from a Host mismatch, from a
 * request that is not ours at all. No header VALUE is recorded.
 * ---------------------------------------------------------------------- */

export const REFUSAL_LOG_PREFIX = "liberty-request-refused";

/**
 * How many refusals reach the log per window, and the window.
 *
 * A REFUSED PAGE LOAD IS DOZENS OF REFUSALS. One document, then every chunk,
 * every font and every fetch it would have made -- so an unbudgeted line per
 * refusal turns one failed navigation into a log an operator cannot read. The
 * first few carry the diagnosis; the rest are the same fact again.
 */
export const REFUSAL_BUDGET = 12;
export const REFUSAL_WINDOW_MS = 60_000;

export interface RefusalFacts {
  readonly method: string;
  readonly pathname: string;
  readonly tokenHeaderPresent: boolean;
  readonly hostHeaderPresent: boolean;
}

/** A method, as a closed shape. Anything unusual is recorded as `OTHER`. */
const METHOD_PATTERN = /^[A-Z]{3,10}$/;

export function describeRefusal(input: {
  method: string;
  pathname: string;
  tokenHeaderPresent: boolean;
  hostHeaderPresent: boolean;
}): RefusalFacts {
  const method = input.method.toUpperCase();
  return {
    method: METHOD_PATTERN.test(method) ? method : "OTHER",
    pathname: sanitisePathname(input.pathname),
    tokenHeaderPresent: input.tokenHeaderPresent,
    hostHeaderPresent: input.hostHeaderPresent
  };
}

export function formatRefusalLine(facts: RefusalFacts): string {
  return `${REFUSAL_LOG_PREFIX} ${JSON.stringify(facts)}`;
}

interface RefusalBudget {
  windowStartedAt: number;
  used: number;
  suppressed: number;
}

const budget: RefusalBudget = { windowStartedAt: 0, used: 0, suppressed: 0 };

/**
 * May this refusal be logged, and how many were dropped since the last window?
 *
 * The same shape as the client-failure budget and for the same reason: the
 * suppressed count is surfaced once per window so the log says it stopped
 * recording rather than appearing to say the refusals stopped.
 */
export function admitRefusal(now: number): { log: boolean; suppressedSinceLast: number } {
  if (now - budget.windowStartedAt >= REFUSAL_WINDOW_MS) {
    const lost = budget.suppressed;
    budget.windowStartedAt = now;
    budget.used = 1;
    budget.suppressed = 0;
    return { log: true, suppressedSinceLast: lost };
  }
  if (budget.used < REFUSAL_BUDGET) {
    budget.used += 1;
    return { log: true, suppressedSinceLast: 0 };
  }
  budget.suppressed += 1;
  return { log: false, suppressedSinceLast: 0 };
}

/** Tests only. */
export function resetRefusalBudget(): void {
  budget.windowStartedAt = 0;
  budget.used = 0;
  budget.suppressed = 0;
}

/**
 * The lines a refusal produces, or none. Pure, so `proxy.ts` stays a thin
 * caller and the budget is exercised without a server.
 */
export function refusalLogLines(facts: RefusalFacts, now: number): readonly string[] {
  const admission = admitRefusal(now);
  if (!admission.log) return [];
  const lines = [formatRefusalLine(facts)];
  if (admission.suppressedSinceLast > 0) {
    lines.push(
      `${REFUSAL_LOG_PREFIX} ${JSON.stringify({
        suppressedInPreviousWindow: admission.suppressedSinceLast
      })}`
    );
  }
  return lines;
}
