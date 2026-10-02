"use client";

import {
  confirmationDelay,
  nextReachability,
  unavailableReasonCode,
  type Reachability,
  type ReachabilityObservation
} from "../../lib/network-state";

/* -------------------------------------------------------------------------
 * Where the application's reachability observations go (PW-0309)
 *
 * THE POLICY IS NOT HERE. `lib/network-state.ts` decides what an observation
 * means, what the viewer is told, how observations fold together, and how many
 * times a failure is confirmed before it is published; it is pure and tested.
 * This file is the browser half: it holds one value, lets React subscribe to
 * it, and turns three real browser events into observations. It decides
 * nothing.
 *
 * A STORE RATHER THAN A HOOK'S OWN `useState`, because the banner is rendered
 * once in the shell and the things that learn about failures are everywhere
 * else. A hook-local state could only ever report what the banner itself
 * observed, which is the smallest possible fraction of what the application
 * knows.
 *
 * ==========================================================================
 * WHAT IT CHECKS, AND THE ONE THING IT DELIBERATELY DOES NOT DO
 * ==========================================================================
 *
 * NO POLLING. There is no `setInterval` anywhere in this file and no schedule
 * of any kind while the application is healthy. A background request every N
 * seconds is traffic a desktop application pays for forever to answer a
 * question nobody asked, and `lib/network-state.ts` argues the sharper
 * version: a poll that succeeded ten seconds ago says nothing about the
 * request the viewer just made and that failed.
 *
 * A FAILED PROBE IS CONFIRMED BEFORE IT IS PUBLISHED, which is a different
 * thing and arrived after a browser caught the first version being wrong --
 * see `LIVENESS_CONFIRMATION_DELAYS_MS`. The re-attempts are reachable only
 * from a rejection, are finite, and are abandoned the moment a newer check
 * starts.
 *
 * LIVENESS IS CHECKED ON EVENTS, and only three, each of which is a moment
 * when the answer can genuinely have changed:
 *
 *   - MOUNT. The page may have been restored from the back/forward cache, or
 *     served from the Next client cache after the sidecar died.
 *   - `online`. The browser believes a network came back. `navigator.onLine`
 *     is famously optimistic -- true on a captive portal, true on an interface
 *     with no route -- so this is the moment to find out rather than to
 *     declare victory.
 *   - `visibilitychange` to visible. On a desktop this is the laptop waking or
 *     the window coming back to the front, which is exactly when a sidecar
 *     that died in the background becomes worth knowing about.
 *
 * `/api/health` IS THE RIGHT ENDPOINT FOR THIS AND THE WRONG ONE FOR ANYTHING
 * ELSE. It is liveness only, deliberately -- "A health endpoint is the one
 * route that is reachable unauthenticated from everywhere by design, so every
 * fact added to it is a fact published to everyone." Asking it "did this
 * process answer" is the question it exists for. Nothing is added to it, and
 * the backend's reachability is NOT asked of it; that arrives on the reason
 * trail of a real request, through `report` below.
 * ---------------------------------------------------------------------- */

const HEALTH = "/api/health";

/** The one value a server render ever sees; see `serverSnapshot`. */
const SERVER_REACHABLE: Reachability = Object.freeze({ kind: "reachable" as const });

let state: Reachability = SERVER_REACHABLE;
/**
 * HOW MANY MOUNTED BANNERS ARE WATCHING, not whether one is.
 *
 * A COUNT RATHER THAN A FLAG, because during a client-side navigation Next
 * renders the outgoing and incoming trees at the same time -- each one mounts
 * its own `AppShell`, and therefore its own banner. With a boolean, the
 * OUTGOING banner's teardown ran after the incoming one's setup and published
 * `observing: false` while a banner was very much observing. A Playwright run
 * caught it exactly that way: two banners in the document, both claiming not
 * to be watching.
 */
let observers = 0;
const listeners = new Set<() => void>();

/**
 * Which `checkLiveness` call is the current one.
 *
 * A LATE ANSWER FROM A SUPERSEDED CHECK IS NOT NEWS, IT IS NOISE. Three events
 * can each start a check and they overlap in practice -- waking a laptop fires
 * `online` and `visibilitychange` within the same few milliseconds. Without
 * this, the slowest of them decides the state, which is the opposite of what
 * anyone wants: the most recent question deserves the answer.
 */
let generation = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(next: Reachability): void {
  /*
   * Compared by VALUE, not by reference. `nextReachability` builds a fresh
   * object every call, so a reference check would notify every subscriber on
   * every observation and re-render the shell for nothing.
   */
  if (
    next.kind === state.kind &&
    (next.kind !== "service-unavailable" || next.code === (state as { code?: string }).code)
  ) {
    return;
  }
  state = next;
  notify();
}

/**
 * Report something the application learned by trying.
 *
 * THE PRODUCER SIDE OF THIS FEATURE, and the honest statement about it is that
 * almost nothing calls it yet. The fetchers that could -- the watchlist
 * snapshot, the profiles client, the playback session client -- each belong to
 * a different completed task's surface, so wiring them is a follow-up this
 * task names rather than performs. Until then the live producers are the three
 * browser events below, which is enough to make `offline` and
 * `sidecar-unreachable` real and leaves `service-unavailable` modelled,
 * described and unproduced. That gap is stated in the handoff rather than
 * hidden behind a state nobody can reach.
 */
export function report(observation: ReachabilityObservation): void {
  publish(nextReachability(state, observation));
}

/** Report whatever a route answered, without the caller reading the envelope. */
export function reportAnswer(body: unknown): void {
  report({ kind: "answered", reasonCode: unavailableReasonCode(body) });
}

/** The browser's current opinion, read defensively so a non-browser cannot throw. */
function browserOnLine(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/**
 * Whether a `router.refresh()` is safe to issue at this instant.
 *
 * NEXT'S ROUTER FALLS BACK TO A FULL BROWSER NAVIGATION when it cannot fetch
 * an RSC payload -- it says so in the console: "Failed to fetch RSC payload
 * ... Falling back to browser navigation." In a web page that is a reasonable
 * last resort. In a desktop application with no network it replaces the entire
 * product with the browser's error page, which is the most complete version of
 * the failure this task exists to prevent: the acceptance's "an offline home
 * shows what it has and says so" becomes an offline home that shows nothing at
 * all.
 *
 * This is the narrowest honest guard. It cannot close the window completely --
 * a link can drop in the millisecond after the check -- and the residual
 * hazard applies to every `router.refresh()` in this application, not only
 * this one, which is a finding for review rather than something this task can
 * fix inside its own surface.
 */
export function safeToRefresh(): boolean {
  return state.kind === "reachable" && browserOnLine();
}

function pause(ms: number): Promise<void> {
  /*
   * THE ONLY SCHEDULING IN THIS FILE, and it exists solely between a rejected
   * probe and its re-attempt. `confirmationDelay` is what bounds it -- it
   * answers `null` once the list is exhausted, so this cannot be reached
   * again. `setInterval` is forbidden here and `degraded-banner.test.tsx`
   * enforces that.
   */
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask whether this application's own server is answering.
 *
 * `no-store`, AND THE RESULT IS AN OBSERVATION RATHER THAN A VERDICT --
 * `classifyObservation` decides what a failure means, using the browser's own
 * opinion of the network to tell a dead sidecar from a dead link.
 *
 * A NON-2xx IS NOT A FAILURE HERE. If the process answered at all it is alive,
 * which is the only thing this check is about; a 500 from a liveness route is
 * a different defect and not a reachability one.
 *
 * ==========================================================================
 * WHY THIS IS A LOOP AND NOT A SINGLE REQUEST
 * ==========================================================================
 *
 * The first version was a single request, and a browser caught it being wrong
 * within the same round it was written. `setOffline(false)` fires `online`;
 * the probe issued on that event rejected because the network stack had not
 * finished coming back; `navigator.onLine` was already `true` by the time the
 * rejection was caught; and the application told the viewer it had stopped
 * responding -- permanently, because nothing retried. The very next request,
 * fifteen milliseconds later, returned 200.
 *
 * Two independent corrections apply, and both are needed:
 *
 *   - the browser's opinion is captured when the request is ISSUED as well as
 *     when it fails, so a probe that straddled a transition is reported as the
 *     link problem it was rather than as a dead process;
 *   - a rejection is CONFIRMED before it is published, for a bounded number of
 *     attempts the pure module decides.
 *
 * Neither one alone is enough. The first still misreports a sidecar that was
 * briefly busy; the second still misreports a link that dropped and returned
 * inside the confirmation window.
 */
export async function checkLiveness(): Promise<void> {
  const mine = ++generation;

  for (let failures = 0; ; ) {
    const onLineWhenIssued = browserOnLine();

    try {
      await fetch(HEALTH, { cache: "no-store", headers: { accept: "application/json" } });
      /* Superseded while in flight: a newer check is the one that counts. */
      if (mine !== generation) return;
      report({ kind: "answered" });
      return;
    } catch {
      if (mine !== generation) return;

      failures += 1;
      const delay = confirmationDelay(failures);
      if (delay === null) {
        report({
          kind: "transport-failed",
          onLineWhenIssued,
          onLineWhenFailed: browserOnLine()
        });
        return;
      }

      await pause(delay);
      if (mine !== generation) return;
    }
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function snapshot(): Reachability {
  return state;
}

/**
 * The value a SERVER render sees.
 *
 * Always `reachable`, and it has to be: the server has no browser to be
 * offline, and `useSyncExternalStore` requires the two to agree on the first
 * render or hydration mismatches. It also means the banner is never in the
 * server-rendered HTML, which is correct -- a degraded banner baked into a
 * document could be served from a cache to somebody whose network is fine.
 */
export function serverSnapshot(): Reachability {
  /*
   * ONE FROZEN VALUE, RETURNED EVERY TIME, AND THIS IS NOT A MICRO-OPTIMISATION.
   * The first version built a fresh object per call and React said so in the
   * console of every development page load: "The result of getServerSnapshot
   * should be cached to avoid an infinite loop." `useSyncExternalStore`
   * compares the snapshot by identity, so a new object each call is a new
   * value each call.
   */
  return SERVER_REACHABLE;
}

/**
 * Whether anything is actually WATCHING the network yet.
 *
 * `reachable` BEFORE THE LISTENERS ARE WIRED IS AN ASSUMPTION, NOT A
 * MEASUREMENT, and until this round nothing in the DOM told the two apart. A
 * server-rendered document says `reachable` because a server has no browser;
 * so does a document whose bundle has not finished hydrating. The distinction
 * is real -- in the second case an `offline` event fired in that window is
 * simply missed -- and publishing it costs one attribute.
 */
export function isObserving(): boolean {
  return observers > 0;
}

/** The server is never observing: there is nothing there to observe with. */
export function notObserving(): boolean {
  return false;
}

/** Test seam: the store outlives a single test otherwise. */
export function resetReachability(): void {
  state = SERVER_REACHABLE;
  observers = 0;
  /* Abandons any confirmation loop still running from a previous test. */
  generation += 1;
  listeners.clear();
}

/**
 * Wire the browser's own events, and check liveness at the three moments the
 * answer can have changed.
 *
 * RETURNS ITS OWN TEARDOWN, so a component can register it in an effect
 * without this module knowing about React.
 */
export function observeBrowser(): () => void {
  const onOffline = () => {
    report({ kind: "browser-offline" });
  };
  const onOnline = () => {
    /* The event first, so the banner clears immediately and the application
     * is allowed to try; then the check, which is what actually decides. */
    report({ kind: "browser-online" });
    void checkLiveness();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void checkLiveness();
  };

  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);

  observers += 1;
  notify();

  /*
   * THE STARTING STATE IS READ RATHER THAN ASSUMED. A page restored from the
   * back/forward cache, or rendered from Next's client cache after the sidecar
   * died, can mount with no event ever firing.
   */
  if (!navigator.onLine) report({ kind: "browser-offline" });
  else void checkLiveness();

  return () => {
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    observers = Math.max(0, observers - 1);
    /* Anything still confirming belongs to a component that is gone. */
    generation += 1;
    notify();
  };
}
