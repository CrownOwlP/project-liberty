import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PRIMARY_NAVIGATION, activeEntryId, isReachable } from "../shell/navigation";
import { AppShell } from "../shell/app-shell";
import { WatchlistControl } from "./watchlist-control";
import { watchlistRequest } from "./watchlist-state";

/* -------------------------------------------------------------------------
 * The watchlist control's FIRST PAINT, and the rules a later edit could break
 * (PW-0304)
 *
 * WHY `react-dom/server` AND SOURCE READING. There is no DOM and no
 * testing-library in this workspace -- `apps/web/vitest.config.ts` sets
 * `environment: "node"` -- so an effect never runs here and no click can be
 * dispatched. `watchlist-state.test.ts` already covers every decision the
 * control makes once an answer arrives, which is where the acceptance's central
 * demand lives ("a refused write must not render as a success"), and
 * `e2e/tests/watchlist.spec.ts` drives the real clicks in a real browser.
 *
 * What is left for this file is the two things neither of those can see: what
 * the control looks like BEFORE any of it happens, and structural rules about
 * the files involved. This is the same division `profile-ui.test.tsx`
 * established, down to the comment-stripping in `sourceOf` -- a rule whose own
 * explanation can fail it is not a rule.
 * ---------------------------------------------------------------------- */

async function sourceOf(file: string): Promise<string> {
  const raw = await readFile(new URL(file, import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the first paint does not guess", () => {
  it("renders an unpressable control that claims nothing about the list", () => {
    const html = renderToStaticMarkup(<WatchlistControl contentId="aurora-fall" />);

    /*
     * `unknown` IS A REAL STATE. These controls mount on server components, so
     * the control exists before its answer does. "Add to My List" at first
     * paint would be a lie to anyone whose list already holds the title, and
     * "Remove" would be the opposite lie. "My List" asserts neither.
     */
    expect(html).toContain("My List");
    expect(html).not.toContain("Add to My List");
    expect(html).not.toContain("Remove from My List");

    /* And it cannot be pressed: a toggle with no state has no meaningful
     * press, and an optimistic flip from `unknown` would be a guess. */
    expect(html).toContain("disabled");
    expect(html).toContain('aria-pressed="false"');
  });

  it("renders the live region EMPTY rather than omitting it", () => {
    /*
     * A live region inserted at the moment it gains content is one some screen
     * readers never announce, because they were not watching the node when it
     * appeared. So the element is unconditional and only its class is
     * conditional -- the class carries a border, and an empty notice must not
     * draw an empty box.
     */
    const html = renderToStaticMarkup(<WatchlistControl contentId="aurora-fall" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/data-testid="watchlist-notice"[^>]*>(<\/p>)/);
  });

  it("marks the compact variant without changing what it says", () => {
    const plain = renderToStaticMarkup(<WatchlistControl contentId="aurora-fall" />);
    const compact = renderToStaticMarkup(<WatchlistControl contentId="aurora-fall" compact />);

    /* The card variant is quieter, not different. A control whose LABEL
     * changed with its surface would be two controls. */
    expect(compact).toContain("My List");
    expect(compact).not.toBe(plain);
  });
});

describe("the control reconciles against the ENVELOPE, not the status", () => {
  it("reads the body whatever the response status was", async () => {
    /*
     * A refusal is a 4xx carrying an envelope that says why, and the envelope
     * is what the control rolls back against. A `if (!response.ok)` early
     * return would throw that away and render every refusal as the same
     * generic failure -- losing `not_authenticated` ("sign in"),
     * `no_active_profile_selected` ("choose a profile") and the rest, which
     * the acceptance requires be surfaced honestly.
     *
     * Asserted against source because an effect cannot run in this
     * environment. The e2e spec exercises the behaviour itself.
     */
    const source = await sourceOf("./watchlist-control.tsx");
    expect(source).not.toMatch(/response\.ok/);
    expect(source).not.toMatch(/response\.status/);
    /* Non-vacuity: the body IS read, so the two absences above are a rule
     * about how, not a file that never calls fetch. */
    expect(source).toContain("response.json()");
    expect(source).toContain("settleState(before");
  });

  it("decides nothing itself -- every rule is imported from the tested module", async () => {
    const source = await sourceOf("./watchlist-control.tsx");
    for (const decision of [
      "controlAffordance",
      "optimisticState",
      "parseWatchlistAnswer",
      "settleState",
      "watchlistRequest"
    ]) {
      expect(source, `${decision} should come from watchlist-state.ts`).toContain(decision);
    }
    /* The route is built by `watchlistRequest`, so the component states no
     * address of its own -- two spellings of one URL is the drift
     * `lib/routes.ts` was created to stop. */
    expect(source).not.toContain("/api/v1/watchlist");
  });
});

describe("the client's verbs are the route's verbs", () => {
  /*
   * THIS SUITE EXISTS BECAUSE THE UNIT LAYER CONFIRMED A MISTAKE INSTEAD OF
   * FINDING IT. `watchlistRequest` sent `POST` for an add; the route exports
   * `PUT` and `DELETE` and answers 405 to a POST. `watchlist-state.test.ts`
   * asserted `POST` right beside the implementation, so the gate was green
   * while the control could not add anything, and it cost a browser run to
   * discover. A test that restates the implementation's belief is not a check
   * on it.
   *
   * THE FIX IS TO READ THE OTHER SIDE. `apps/web/src/app/api/v1/watchlist` is
   * a reviewDependency of PW-0304 -- read-only, and read is exactly what this
   * does. The route module is the authority on which verbs exist, so a rename
   * there fails here instead of in a browser.
   */
  const ROUTE = "../../app/api/v1/watchlist/[contentId]/route.ts";

  it("every verb the client can send is one the route exports", async () => {
    const source = await sourceOf(ROUTE);
    const exported = [...source.matchAll(/export async function ([A-Z]+)\s*\(/g)].map(
      (match) => match[1]
    );

    /* Non-vacuity: a regex that matched nothing would make the loop below
     * pass for every possible verb. */
    expect(exported.length, "no handlers found -- the regex or the route moved").toBeGreaterThan(0);

    for (const intent of ["add", "remove"] as const) {
      const { method } = watchlistRequest("aurora-fall", intent);
      expect(exported, `the route exports no ${method} for "${intent}"`).toContain(method);
    }
  });

  it("the two intents do not collapse onto one verb", async () => {
    /* Both being `DELETE` would satisfy the check above and would make the
     * control unable to add. */
    expect(watchlistRequest("aurora-fall", "add").method).not.toBe(
      watchlistRequest("aurora-fall", "remove").method
    );
  });

  it("the address it builds is the one the route is mounted at", async () => {
    /*
     * The segment name is the route's, read from its own signature rather
     * than from this file's memory of it -- two spellings of one route is the
     * drift `lib/routes.ts` was created to stop.
     */
    const source = await sourceOf(ROUTE);
    expect(source).toMatch(/params:\s*Promise<\{\s*contentId:\s*string\s*\}>/);
    expect(watchlistRequest("aurora-fall", "add").url).toBe("/api/v1/watchlist/aurora-fall");
  });
});

describe("the screen is reachable", () => {
  it("the navigation entry for the watchlist is a LINK now, not a plan", () => {
    /*
     * PW-0301 built the nav with this entry as `planned`, carrying the reason
     * "the watchlist API is complete; its screen is PW-0304". This task is
     * PW-0304. An entry still describing the screen as unbuilt, beside a
     * screen that is built, is the dead end PW-0301 exists to remove --
     * `/search` was "the most finished screen in this application, reachable
     * from no link anywhere".
     */
    const entry = PRIMARY_NAVIGATION.find((candidate) => candidate.id === "watchlist");
    expect(entry).toBeDefined();
    expect(entry?.href).toBe("/watchlist");
    expect(entry?.plannedReason).toBeNull();
    expect(isReachable(entry!)).toBe(true);
  });

  it("the shell renders it as an anchor and marks it current on the route", () => {
    const html = renderToStaticMarkup(<AppShell pathname="/watchlist">content</AppShell>);
    expect(html).toContain('href="/watchlist"');
    expect(html).toContain('aria-current="page"');
    expect(activeEntryId("/watchlist")).toBe("watchlist");
  });

  it("the page the nav points at renders the shell with the matching pathname", async () => {
    /*
     * TWO SPELLINGS OF ONE ROUTE IS THE DRIFT THIS REPOSITORY HAS BEEN BITTEN
     * BY. `activeEntryId` matches the shell's `pathname` prop against the nav's
     * href, so a page that passed anything else would render a nav with
     * nothing highlighted -- a silent failure nobody would see in a diff.
     */
    const source = await sourceOf("../../app/watchlist/page.tsx");
    expect(source).toContain('pathname="/watchlist"');
    const entry = PRIMARY_NAVIGATION.find((candidate) => candidate.id === "watchlist");
    expect(source).toContain(`pathname="${entry?.href ?? "<no href>"}"`);
  });

  it("the page is never prerendered: one profile's list must not reach a shared cache", async () => {
    const source = await sourceOf("../../app/watchlist/page.tsx");
    expect(source).toContain('export const dynamic = "force-dynamic"');
  });
});
