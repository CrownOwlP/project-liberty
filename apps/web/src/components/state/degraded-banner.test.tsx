import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DegradedBanner } from "./degraded-banner";
import { AppShell } from "../shell/app-shell";

/* -------------------------------------------------------------------------
 * The degraded banner's FIRST PAINT, and the rules a later edit could break
 * (PW-0309)
 *
 * WHAT THIS ENVIRONMENT CAN AND CANNOT SEE. `apps/web/vitest.config.ts` sets
 * `environment: "node"`: there is no DOM, no `navigator`, no `window`, and an
 * effect never runs. So nothing here can take a page offline -- that is
 * `e2e/tests/degraded-states.spec.ts`, which uses a real browser and
 * `context.setOffline(true)`.
 *
 * What it CAN assert is the half that matters most for a banner: what a server
 * render produces. A degraded banner that appeared in server-rendered HTML
 * would be a claim about a network the server cannot observe, and -- worse --
 * a claim that could be served from a cache to somebody whose connection is
 * fine. The post-hydration rules below are source rules with a non-vacuity
 * check beside each, the pattern `shell-usage.test.ts` established.
 * ---------------------------------------------------------------------- */

/* `useRouter` throws outside a mounted app router; the banner calls it so it
 * can refresh on recovery. The same stub `profile-ui.test.tsx` carries. */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

async function sourceOf(file: string): Promise<string> {
  const raw = await readFile(new URL(file, import.meta.url), "utf8");
  /* Comments stripped first: this file's prose names what the rules forbid,
   * and so does the component's header. A rule its own explanation can fail
   * is not a rule. */
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the server renders the region and says nothing in it", () => {
  const html = renderToStaticMarkup(<DegradedBanner />);

  it("claims nothing about a network it cannot observe", () => {
    /*
     * `serverSnapshot` is always `reachable`, which is not a measurement --
     * it is the only honest answer from a process with no browser. The
     * consequence asserted here is that no degraded copy can ever reach a
     * cached document.
     */
    expect(html).toContain('data-reachability="reachable"');
    /*
     * AND IT SAYS SO. `reachable` from a server is an assumption, not a
     * measurement, and until this round nothing distinguished it from a
     * measured one. `data-observing="false"` is that distinction, published
     * where a test -- and `e2e/tests/degraded-states.spec.ts` -- can wait on
     * it rather than hope hydration has happened.
     */
    expect(html).toContain('data-observing="false"');
    expect(html).not.toContain("You&#x27;re offline");
    expect(html).not.toContain("stopped responding");
    expect(html).not.toContain("Try again");
  });

  it("renders the live region EMPTY rather than omitting it", () => {
    /* A live region inserted at the moment it gains content is one some
     * screen readers never announce, because they were not watching the node
     * when it appeared. The ELEMENT is unconditional; only its class and its
     * children are not. */
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/data-testid="degraded-banner"[^>]*>(<\/div>)/);
  });

  it("is POLITE, not an alert", () => {
    /*
     * Two reasons, and the second is the one a later edit is likely to forget.
     * Losing a network is a fact about what the viewer will be able to do
     * next, not an interruption of what they are doing. And an assertive
     * region interrupts a polite one -- `search-form.tsx` records what that
     * cost the error panel: "the user was told the whole error panel ... over
     * the top of the sentence that actually explains what happened."
     */
    expect(html).not.toContain('role="alert"');
  });

  it("does not render as a heading, so it cannot be mistaken for the page's own", () => {
    /* A reader skipping by heading is looking for the page's content. A
     * banner that announced itself as an `h2` would put a transient fact into
     * the document outline. */
    expect(html).not.toMatch(/<h[1-6]/);
  });
});

describe("it is on every route, because the fact is about the whole application", () => {
  it("the shell renders it without being asked to", () => {
    /*
     * The same property `profile-ui.test.tsx` asserts about the profile badge
     * and for the same reason: a degraded state that appeared on some screens
     * and not others would be a worse lie than none. `AppShell` takes no prop
     * for it, so a route cannot opt out by forgetting an argument.
     */
    const shell = renderToStaticMarkup(<AppShell pathname="/">content</AppShell>);
    expect(shell).toContain('data-testid="degraded-banner"');
  });

  it("sits inside `main`, above the content", async () => {
    /*
     * Not in the topbar: it is prose a viewer has to read and must not
     * compete with the navigation for one line of chrome. First inside the
     * main region means a screen reader reaches it before the page's own
     * heading, which is the right order for "nothing below here can load".
     */
    const source = await sourceOf("../shell/app-shell.tsx");
    const mainAt = source.indexOf("<main");
    const bannerAt = source.indexOf("<DegradedBanner />");
    const childrenAt = source.indexOf("{children}");
    expect(mainAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeGreaterThan(mainAt);
    expect(bannerAt).toBeLessThan(childrenAt);
  });
});

describe("the rules a browser enforces and this environment cannot", () => {
  it("DECIDES NOTHING ITSELF -- the copy and the policy are imported", async () => {
    const source = await sourceOf("./degraded-banner.tsx");
    expect(source).toContain("describeDegradation");
    /* No hand-written sentence in the component: every string a viewer reads
     * comes from the tested module. */
    expect(source).not.toMatch(/offline/i);
    expect(source).not.toMatch(/unreachable/i);
  });

  it("offers a retry ONLY where the copy says one could help", async () => {
    /*
     * A configuration problem does not change until an operator acts, and a
     * button that cannot succeed is a worse answer than no button.
     * `describeDegradation` owns that decision; this asserts the component
     * reads it rather than deciding for itself.
     */
    const source = await sourceOf("./degraded-banner.tsx");
    expect(source).toContain("copy.retryable");
    expect(source).toContain("checkLiveness()");
  });

  it("REFRESHES ON RECOVERY, and not on the first reachable state", async () => {
    /*
     * The acceptance's "recovery on reconnect without a manual reload". Every
     * server component on screen was rendered while something was unreachable
     * -- a refused catalog, an empty rail -- and leaving them is the manual
     * reload. Refreshing on MOUNT instead would re-render every route in the
     * application on every navigation, so the transition is what triggers it.
     */
    const source = await sourceOf("./degraded-banner.tsx");
    expect(source).toContain("router.refresh()");
    expect(source).toContain("if (!wasDegraded.current) return;");
  });

  it("NEVER REFRESHES INTO A DEAD LINK, because Next's fallback is a full navigation", async () => {
    /*
     * The most expensive thing this component can do. Next cannot fetch an RSC
     * payload with no network and falls back to a browser navigation by
     * design; on a desktop application that replaces the product with the
     * browser's error page. An instrumented run printed the whole sequence --
     * a late answer read as recovery, the refresh, the fallback, and
     * `chrome-error://chromewebdata/`.
     *
     * The guard lives in the store, where the state and the browser's opinion
     * both are; this asserts the component consults it and that the deferral
     * keeps the flag, so a recovery delayed is not a recovery lost.
     */
    const source = await sourceOf("./degraded-banner.tsx");
    expect(source).toContain("if (!safeToRefresh()) return;");
    expect(
      source.indexOf("if (!safeToRefresh()) return;"),
      "the guard must come BEFORE the refresh, not after it"
    ).toBeLessThan(source.indexOf("router.refresh()"));
    expect(
      source.indexOf("if (!safeToRefresh()) return;"),
      "and before the flag is cleared, or a deferred recovery is a dropped one"
    ).toBeLessThan(source.indexOf("wasDegraded.current = false;"));
  });

  it("does not render the refresh during a render", () => {
    /* A `router.refresh()` reached from a render body is an infinite loop in
     * waiting. It is in an effect, which never runs here -- so this asserts
     * the stub was never called by the server render above. */
    expect(refresh).not.toHaveBeenCalled();
  });

  it("POLLS NOTHING, and the one schedule it has is reachable only from a failure", async () => {
    /*
     * A background request every N seconds is traffic a desktop application
     * pays for forever to answer a question nobody asked -- and a poll that
     * succeeded ten seconds ago says nothing about the request that just
     * failed. Liveness is checked on three events instead, each a moment the
     * answer can genuinely have changed.
     *
     * ======================================================================
     * THIS RULE WAS SHARPENED, NOT RELAXED, AND THE DIFFERENCE IS THE POINT
     * ======================================================================
     *
     * It used to forbid `setTimeout` outright in both files. That banned a
     * poller and it also banned the fix for a defect a browser caught: one
     * rejected probe was published as "Project Liberty stopped responding"
     * and never revisited, while the next request fifteen milliseconds later
     * returned 200. Confirming a rejection needs a pause.
     *
     * So the rule now says what it always meant. `setInterval` -- a schedule
     * that repeats until something cancels it -- is forbidden in both files
     * with no exception. A one-shot pause is permitted in the STORE only, and
     * only as the bounded confirmation `lib/network-state.ts` decides: the
     * delays are a finite list there, `confirmationDelay` returns `null` once
     * it is exhausted, and `network-state.test.ts` walks fifty inputs to prove
     * the walk terminates. `reachability-store.test.ts` then asserts the
     * behaviour itself -- that a healthy call leaves nothing outstanding --
     * which is the check a source rule can only approximate.
     */
    const store = await sourceOf("./reachability-store.ts");
    const banner = await sourceOf("./degraded-banner.tsx");

    for (const file of [store, banner]) {
      expect(file, "setInterval is a poller and there is no exception").not.toContain(
        "setInterval"
      );
    }
    /* The banner schedules nothing at all: it renders a sentence. */
    expect(banner, "the view layer has no business holding a timer").not.toContain("setTimeout");

    /* And the store's single pause is the bounded one, named from the pure
     * module rather than invented here. */
    expect(store).toContain("confirmationDelay");
    expect(store.match(/setTimeout/g) ?? []).toHaveLength(1);

    /* Non-vacuity: the three events ARE wired. */
    for (const event of ['"online"', '"offline"', '"visibilitychange"']) {
      expect(store).toContain(event);
    }
  });

  it("ABANDONS a check that a newer one superseded", async () => {
    /*
     * Waking a laptop fires `online` and `visibilitychange` within a few
     * milliseconds, so two checks overlap in practice. Without this the
     * slowest one decides the state. Asserted as behaviour in
     * `reachability-store.test.ts`; asserted here as the mechanism, so a
     * rewrite that drops the guard fails in both places.
     */
    const store = await sourceOf("./reachability-store.ts");
    expect(store).toContain("generation");
    expect(store).toContain("mine !== generation");
  });

  it("reads the browser's opinion at BOTH ends of a probe", async () => {
    /* The other half of the same fix: a request that straddled a transition
     * is a link problem, and one reading cannot see a straddle. */
    const store = await sourceOf("./reachability-store.ts");
    expect(store).toContain("onLineWhenIssued");
    expect(store).toContain("onLineWhenFailed");
  });

  it("asks `/api/health` and adds nothing to it", async () => {
    /*
     * The endpoint is liveness only, deliberately: "every fact added to it is
     * a fact published to everyone". Asking "did this process answer" is what
     * it exists for. The BACKEND's reachability is not asked of it -- that
     * arrives on the reason trail of a real request, through `report`.
     */
    const store = await sourceOf("./reachability-store.ts");
    expect(store).toContain('"/api/health"');
    expect(store).toContain('cache: "no-store"');
    expect(store).toContain("unavailableReasonCode");
  });
});
