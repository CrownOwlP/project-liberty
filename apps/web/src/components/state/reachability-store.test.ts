import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_LIVENESS_ATTEMPTS } from "../../lib/network-state";
import {
  checkLiveness,
  isObserving,
  observeBrowser,
  report,
  resetReachability,
  safeToRefresh,
  snapshot,
  subscribe
} from "./reachability-store";

/* -------------------------------------------------------------------------
 * The liveness probe itself, in the environment that can actually drive it
 * (PW-0309)
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A SOURCE-RULE SUITE. `apps/web` runs
 * Vitest in a `node` environment, so there is no DOM -- but `checkLiveness` is
 * not a DOM function. It is a loop over `fetch` and two readings of
 * `navigator.onLine`, both of which this environment can supply for real. The
 * behaviour that mattered most in this task turned out to live exactly there,
 * so it is tested there rather than inferred from the shape of the source.
 *
 * ==========================================================================
 * THE DEFECT THESE CASES WERE WRITTEN FROM, STATED PLAINLY
 * ==========================================================================
 *
 * The first implementation made ONE request and published whatever happened.
 * `e2e/tests/degraded-states.spec.ts` failed twice -- once in development,
 * once against a production build -- with the banner reading "Project Liberty
 * stopped responding" for the whole ten-second assertion window. The two
 * Playwright traces agree on the mechanism: the probe was issued around the
 * instant `setOffline(false)` restored the connection, it rejected,
 * `navigator.onLine` was already `true` when the rejection was caught, and the
 * very next request -- fifteen milliseconds later in one trace, twenty-three
 * in the other -- returned 200. A working application told the viewer it had
 * died, and kept saying so, because nothing was scheduled to ask again.
 *
 * It would have been possible to make that spec green by giving the assertion
 * a longer timeout or a retry. Both would have preserved the defect and hidden
 * it; `playwright.config.ts` states the rule -- "If a test here is not
 * deterministic it is a defect in the test and it gets fixed, not retried" --
 * and this was not a defect in the test.
 * ---------------------------------------------------------------------- */

const REAL_NAVIGATOR = globalThis.navigator;

afterEach(() => {
  resetReachability();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** `navigator.onLine` as a value this process controls. */
function browserSays(onLine: boolean | (() => boolean)): void {
  vi.stubGlobal("navigator", {
    ...REAL_NAVIGATOR,
    get onLine() {
      return typeof onLine === "function" ? onLine() : onLine;
    }
  });
}

/** A `fetch` whose outcome is decided per call by the test. */
function fetchThat(outcomes: ReadonlyArray<"ok" | "reject">): ReturnType<typeof vi.fn> {
  let call = -1;
  const mock = vi.fn(async () => {
    call += 1;
    const outcome = outcomes[call] ?? outcomes.at(-1) ?? "ok";
    if (outcome === "reject") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("one rejected probe is a hypothesis, not a verdict", () => {
  it("DOES NOT ACCUSE THE SIDECAR when the next attempt answers", async () => {
    /*
     * THE REGRESSION TEST FOR THE SHIPPED DEFECT. Exactly the observed
     * sequence: a rejection at the instant of recovery, then an answer. The
     * old implementation published `sidecar-unreachable` here and never left
     * it.
     */
    browserSays(true);
    const fetchMock = fetchThat(["reject", "ok"]);

    await checkLiveness();

    expect(snapshot()).toEqual({ kind: "reachable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still accuses it when EVERY attempt fails with the link up throughout", async () => {
    /*
     * NON-VACUITY, and the whole reason the case above is a narrowing rather
     * than a removal. A sidecar that is genuinely dead must still be named --
     * the acceptance's "the three have different remedies" cuts both ways.
     */
    browserSays(true);
    const fetchMock = fetchThat(["reject"]);

    await checkLiveness();

    expect(snapshot()).toEqual({ kind: "sidecar-unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_LIVENESS_ATTEMPTS);
  });

  it("asks a BOUNDED number of times -- it is a confirmation, not a poll", async () => {
    browserSays(true);
    const fetchMock = fetchThat(["reject"]);

    await checkLiveness();
    const afterFirst = fetchMock.mock.calls.length;

    /* Nothing is outstanding: a poller would keep going after the call
     * settled, and this is the assertion that says it does not. */
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    expect(afterFirst).toBe(MAX_LIVENESS_ATTEMPTS);
  });
});

describe("the browser's opinion is read at both ends of the request", () => {
  it("NEVER accuses the sidecar while the link is down", async () => {
    /*
     * An offline machine told "Project Liberty stopped responding" is the
     * exact collapse the acceptance forbids -- "the three have different
     * remedies" -- and it sends somebody to reinstall working software
     * instead of looking at their connection. Every attempt fails here and
     * the verdict is still the link.
     */
    browserSays(false);
    fetchThat(["reject"]);

    await checkLiveness();

    expect(snapshot()).toEqual({ kind: "offline" });
  });

  it("THE TRACED SEQUENCE: issued at the instant of recovery, confirmed, cleared", async () => {
    /*
     * What the two Playwright traces caught, reproduced without a browser.
     * The link is down when the probe goes out, it returns while that probe
     * is failing, and the confirming attempt answers. The old implementation
     * published `sidecar-unreachable` on the first rejection and stayed
     * there; nothing here is allowed to.
     */
    let onLine = false;
    browserSays(() => onLine);
    const fetchMock = fetchThat(["reject", "ok"]);

    const checking = checkLiveness();
    onLine = true;
    await checking;

    expect(snapshot()).toEqual({ kind: "reachable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a probe issued online is the LINK if the link drops before it rejects", async () => {
    let onLine = true;
    browserSays(() => onLine);
    const fetchMock = vi.fn(async () => {
      onLine = false;
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await checkLiveness();

    expect(snapshot()).toEqual({ kind: "offline" });
  });
});

describe("a superseded check keeps its answer to itself", () => {
  it("a late rejection from an abandoned probe does not overwrite a newer answer", async () => {
    /*
     * Waking a laptop fires `online` and `visibilitychange` within a few
     * milliseconds of each other, so two checks genuinely overlap. Without a
     * generation guard the SLOWEST of them decides the state, which is the
     * opposite of what anyone wants.
     */
    browserSays(true);
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          await gate;
          throw new TypeError("Failed to fetch");
        }
        return new Response("{}", { status: 200 });
      })
    );

    const abandoned = checkLiveness();
    await Promise.resolve();
    await checkLiveness();

    expect(snapshot()).toEqual({ kind: "reachable" });

    releaseFirst();
    await abandoned;

    /* The abandoned probe's rejection arrived last and said nothing. */
    expect(snapshot()).toEqual({ kind: "reachable" });
  });
});

describe("`observing` is a fact about this document, not a decoration", () => {
  it("is false until the listeners are wired, and false again after teardown", () => {
    /*
     * WHY IT IS PUBLISHED AT ALL. A server-rendered document says `reachable`
     * because a server has no browser; a document whose bundle has not
     * hydrated says `reachable` for a completely different reason -- nothing
     * is watching, and an `offline` event fired in that window is simply lost.
     * `e2e/tests/degraded-states.spec.ts` waits on this attribute before it
     * cuts the network, which is what makes that spec's precondition real
     * rather than hopeful.
     */
    const events: string[] = [];
    browserSays(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    vi.stubGlobal("window", {
      addEventListener: (name: string) => events.push(`+${name}`),
      removeEventListener: (name: string) => events.push(`-${name}`)
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: (name: string) => events.push(`+${name}`),
      removeEventListener: (name: string) => events.push(`-${name}`)
    });

    expect(isObserving()).toBe(false);

    const notified: boolean[] = [];
    const unsubscribe = subscribe(() => notified.push(isObserving()));

    const teardown = observeBrowser();
    expect(isObserving()).toBe(true);
    expect(events).toContain("+offline");
    expect(events).toContain("+online");
    expect(events).toContain("+visibilitychange");

    teardown();
    expect(isObserving()).toBe(false);
    expect(events).toContain("-online");

    /* Subscribers are told, or `useSyncExternalStore` would never re-read it. */
    expect(notified.length).toBeGreaterThanOrEqual(2);
    unsubscribe();
  });
});

describe("THE TRACED CATASTROPHE: a late answer must not look like a recovery", () => {
  /* -----------------------------------------------------------------------
   * Reproduced from the instrumented browser run, which printed exactly this:
   *
   *   report {"kind":"browser-offline"} : reachable -> offline
   *   report {"kind":"answered"}        : offline   -> reachable
   *   banner router.refresh()
   *   Failed to fetch RSC payload ... Falling back to browser navigation.
   *   NAV chrome-error://chromewebdata/
   *
   * The probe was issued while the link was up and resolved after it dropped.
   * Three milliseconds of staleness cost the whole application.
   * -------------------------------------------------------------------- */

  it("a probe that resolves after the link drops leaves the state `offline`", async () => {
    let onLine = true;
    browserSays(() => onLine);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        /* The link goes while this request is in flight -- which is what
         * `context.setOffline(true)` does to a page mid-probe. */
        onLine = false;
        report({ kind: "browser-offline" });
        return new Response("{}", { status: 200 });
      })
    );

    await checkLiveness();

    expect(snapshot()).toEqual({ kind: "offline" });
  });

  it("refuses to call a refresh safe while the browser says there is no link", () => {
    browserSays(false);
    report({ kind: "browser-offline" });
    expect(safeToRefresh()).toBe(false);
  });

  it("calls it safe once the browser retracts that", () => {
    /* NON-VACUITY: the guard is a condition, not a permanent no. */
    browserSays(true);
    report({ kind: "browser-online" });
    expect(safeToRefresh()).toBe(true);
  });
});

describe("two mounted banners are one observer each, not one flag between them", () => {
  it("stays `observing` while a second banner is still mounted", () => {
    /* -------------------------------------------------------------------
     * THE NAVIGATION CASE, FROM A REAL FAILURE. Next renders the outgoing and
     * incoming trees together during a client-side navigation, and each one
     * mounts its own `AppShell` and therefore its own banner. With a boolean
     * the outgoing teardown ran last and published "nothing is watching"
     * while the incoming banner was watching -- two banners in the document,
     * both saying `data-observing="false"`.
     * ----------------------------------------------------------------- */
    browserSays(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const noop = () => {};
    vi.stubGlobal("window", { addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: noop,
      removeEventListener: noop
    });

    const incoming = observeBrowser();
    const outgoing = observeBrowser();
    expect(isObserving()).toBe(true);

    outgoing();
    expect(isObserving(), "one banner left, and it is watching").toBe(true);

    incoming();
    expect(isObserving(), "and now none is").toBe(false);
  });
});
