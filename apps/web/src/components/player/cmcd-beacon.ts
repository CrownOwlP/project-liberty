/* -------------------------------------------------------------------------
 * The one place the player posts a report itself (PL-0503 / PL-0504)
 *
 * shaka-player owns the CMCD transport: batching, sequence numbers, retry and
 * the once-per-session `msd` gate are all in its vendored reporter, which is why
 * `telemetry.ts` is configuration and nothing else. This file does NOT duplicate
 * that. It exists for the one report the reporter structurally cannot carry --
 * PL-0504's `com.liberty-avs-*` proxies, which are CTA-5004-B CUSTOM keys, and
 * shaka-player 5.2.6's CMCD configuration is an allowlist over the registry
 * rather than an extension point: `shaka.extern.CmcdConfiguration` and
 * `shaka.extern.CmcdTarget` have no custom-data member, and `CmcdManager`'s
 * `applyToRequest_` hands the vendored reporter a hardcoded `customData: {}`.
 *
 * TELEMETRY MUST NOT BE ABLE TO BREAK PLAYBACK, AND HERE IS WHY IT CANNOT.
 * The argument is structural rather than a `try`/`catch` bolted on afterwards:
 *
 *   - THERE IS NO RETURN PATH. `postCmcdEvent` returns `void`. It has no result
 *     for a caller to wait on, so no code that starts, loads or recovers
 *     playback can be sequenced behind it. The response body is never read; the
 *     status code is never inspected. A collector that refuses, 500s or vanishes
 *     produces exactly the same effect on the player as one that accepts.
 *   - IT IS CALLED FROM A TIMER, NEVER FROM A MEDIA EVENT HANDLER. Playback is
 *     driven by the engine and by media events; this runs in its own task, after
 *     the caller has already updated everything it was going to update. An
 *     exception in this task cannot interrupt one of those.
 *   - THE PROMISE IS SETTLED, ONCE. A rejected `fetch` with no handler is an
 *     unhandled rejection, which some environments treat as fatal. The `catch`
 *     below is that hygiene and NOT the safety mechanism -- the safety mechanism
 *     is that nothing depends on the promise at all.
 *   - THE FEATURE DETECTION IS A GUARD, NOT AN ASSUMPTION. A runtime with no
 *     `fetch` returns without doing anything, rather than throwing a
 *     `ReferenceError` into a timer.
 *
 * NO CREDENTIALS. `credentials: "omit"` means this request carries no cookie,
 * so the collector cannot join a report to a signed-in user even if a later
 * change gave it somewhere to write one down. CMCD's `sid` and `cid` are the
 * only identifiers it receives, which is exactly what CTA-5004-B defines them
 * for. This is a claim about THIS request only: shaka-player's own event-mode
 * POSTs go through its `NetworkingEngine`, which this file does not configure.
 * ---------------------------------------------------------------------- */

/**
 * The JSON spelling of a CMCD event report.
 *
 * The collector accepts `application/cmcd` -- newline-delimited RFC 8941
 * dictionaries -- and this envelope. Both enter the identical allowlist,
 * redaction and unit path; the second spelling exists because encoding a
 * structured field here would mean shipping an encoder to the browser to
 * produce something the route immediately decodes again.
 */
export const CMCD_JSON_MEDIA_TYPE = "application/json";

export interface CmcdEventPost {
  readonly path: string;
  readonly event: Readonly<Record<string, unknown>>;
}

/**
 * Post one event, and forget it.
 *
 * Returns `true` if a request was ISSUED, which is not a claim that it
 * succeeded -- nothing here can know that, and nothing here needs to. The
 * boolean exists so a test can assert the guard rather than the network.
 */
export function postCmcdEvent(request: CmcdEventPost): boolean {
  const send = globalThis.fetch;
  if (typeof send !== "function") return false;

  let body: string;
  try {
    body = JSON.stringify({ events: [request.event] });
  } catch {
    /* A record that will not serialise is a bug in whoever built it, and it is
     * still not a reason to interrupt a playing video. */
    return false;
  }

  send(request.path, {
    method: "POST",
    headers: { "content-type": CMCD_JSON_MEDIA_TYPE },
    body,
    /* No cookie, at any layer. See the file header. */
    credentials: "omit",
    cache: "no-store",
    /* The report for the last ten seconds of a session is the one worth having,
     * and it is the one a page unload would otherwise cancel. */
    keepalive: true
  }).catch(() => {
    /* Hygiene, not the safety mechanism: an unhandled rejection is a process
     * event in some runtimes, and there is nothing to do about a telemetry POST
     * that failed except not care. */
  });

  return true;
}
