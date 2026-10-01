import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SeasonNavigation, type SeasonPanel } from "./season-navigation";

/* -------------------------------------------------------------------------
 * The season selector's FIRST RENDER, and the rules a later edit could break
 * (PW-0307)
 *
 * THE PROPERTY THIS FILE EXISTS FOR IS THE FALLBACK. `season-navigation.tsx`
 * shows a tab strip only after an effect has run, so a browser that did not
 * execute the bundle keeps every season on screen instead of being left with
 * one. That is the whole argument for the component's shape, it is invisible in
 * a diff, and a later edit that moved the tab strip into the first render would
 * silently turn a progressive enhancement into a regression for anyone without
 * JavaScript.
 *
 * AND THE ENVIRONMENT IS WHAT MAKES IT ASSERTABLE. `apps/web/vitest.config.ts`
 * sets `environment: "node"`: there is no DOM, so an effect never runs here,
 * so `renderToStaticMarkup` produces exactly the markup a browser receives
 * before hydration. The thing that makes a component test weak in this
 * workspace is the thing that makes this one possible.
 *
 * WHAT IT THEREFORE CANNOT SEE: anything after hydration. No click, no arrow
 * key, no `hidden` panel. Those belong to the e2e layer, and the spec that
 * covers them is named in this task's surface amendment and not yet written.
 * This file does not pretend otherwise -- the post-hydration rules below are
 * asserted against SOURCE, stated as rules, with a non-vacuity check beside
 * each, which is the pattern `shell-usage.test.ts` established and
 * `profile-ui.test.tsx` follows.
 * ---------------------------------------------------------------------- */

async function sourceOf(file: string): Promise<string> {
  const raw = await readFile(new URL(file, import.meta.url), "utf8");
  /* Comments are stripped first: this file's own prose names the things the
   * rules forbid, and a rule that its own explanation can fail is not a rule.
   * The same applies to the component, whose header quotes them too. */
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function panel(seasonNumber: number, episodes: number): SeasonPanel {
  return {
    seasonNumber,
    heading: `Season ${String(seasonNumber)}`,
    summary: `${String(episodes)} episodes`,
    content: <ul data-testid={`episodes-${String(seasonNumber)}`} />
  };
}

const THREE_SEASONS = [panel(1, 8), panel(2, 10), panel(3, 6)];

describe("the first render is the flat stack, not a tab strip", () => {
  const html = renderToStaticMarkup(<SeasonNavigation panels={THREE_SEASONS} />);

  it("shows EVERY season", () => {
    /*
     * The regression this file exists to prevent, stated positively. A browser
     * with no JavaScript gets this markup and nothing else, and before PW-0307
     * it got every season -- so every season is what it must still get.
     */
    for (const season of [1, 2, 3]) {
      expect(html, `season ${String(season)} is missing`).toContain(`Season ${String(season)}`);
      expect(html).toContain(`episodes-${String(season)}`);
    }
  });

  it("offers no control it cannot operate", () => {
    /*
     * A tab strip rendered before hydration is a row of buttons that do
     * nothing, and an `aria-selected` that is a claim about state no script is
     * maintaining. Worse than absent.
     */
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("hidden");
  });

  it("keeps the heading structure the stack already had", () => {
    /* `<h2>` per season, which is what a reader skipping by heading has been
     * navigating this page with since PW-0301. */
    expect(html).toContain('<h2 id="season-1">Season 1</h2>');
    expect(html).toContain("8 episodes");
  });
});

describe("a single-season series is never given a selector", () => {
  it("renders the one season and no strip, even after hydration", () => {
    /*
     * Asserted here AND as a source rule below, because this is the only one of
     * the component's two "no strip" branches that survives hydration: the
     * condition is `!interactive || panels.length <= 1`. A tablist with one tab
     * is a control whose every state is the current state.
     */
    const html = renderToStaticMarkup(<SeasonNavigation panels={[panel(1, 8)]} />);
    expect(html).toContain("Season 1");
    expect(html).not.toContain('role="tablist"');
  });

  it("the length condition is in the source and not only in this test", async () => {
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toContain("panels.length <= 1");
    /* Non-vacuity: `interactive` is the other half of the same condition, and
     * a source check that matched only the length would pass for a component
     * that had dropped the fallback. */
    expect(source).toContain("!interactive");
  });
});

describe("an empty series does not render an empty control", () => {
  it("produces nothing rather than a strip with no tabs", () => {
    /*
     * `EpisodeList` returns its own "No episodes listed yet" panel before
     * reaching this component, so this is defence in depth rather than a
     * reachable state -- and the reason to assert it is that `panels[0]` is
     * what seeds the selection, so an empty list is the input most likely to
     * produce an exception rather than a render.
     */
    expect(() => renderToStaticMarkup(<SeasonNavigation panels={[]} />)).not.toThrow();
    expect(renderToStaticMarkup(<SeasonNavigation panels={[]} />)).not.toContain("role=");
  });
});

describe("the rules the browser enforces and this environment cannot", () => {
  it("uses a ROVING tabindex rather than one stop per season", async () => {
    /*
     * A ten-season series would otherwise cost ten tab presses to get past --
     * the same toll PW-0301 removed from the header with a skip link. The
     * pattern is one stop for the strip, arrows to move within it.
     */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toMatch(/tabIndex=\{panel\.seasonNumber === selected \? 0 : -1\}/);
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(source, `${key} is not handled`).toContain(`"${key}"`);
    }
  });

  it("moves focus with the selection, because the unselected tabs are not focusable", async () => {
    /* Roving tabindex without a focus move leaves focus on an element that has
     * just left the tab order, which in most browsers means focus falls to the
     * document body. */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toContain(".focus()");
  });

  it("does not swallow keys it has not claimed", async () => {
    /*
     * `preventDefault` before the switch would have eaten Home and End for the
     * whole page, and a tab strip that swallowed Tab would trap a keyboard
     * user. The call must come AFTER the key has matched -- asserted by
     * position, which is crude and is the only thing a source read can do.
     */
    const source = await sourceOf("./season-navigation.tsx");
    const switchAt = source.indexOf("switch (event.key)");
    const preventAt = source.indexOf("event.preventDefault()");
    expect(switchAt).toBeGreaterThan(-1);
    expect(preventAt).toBeGreaterThan(switchAt);
    /* And there is exactly one, so a second call before the switch could not
     * hide behind the one after it. */
    expect(source.split("event.preventDefault()").length - 1).toBe(1);
  });

  it("HIDES the unselected panels rather than unmounting them", async () => {
    /*
     * Find-in-page is the reason. A viewer searching a series for an episode
     * title is searching the whole series; a browser can only find what is in
     * the document, and mounting one panel at a time would make every season
     * but the open one invisible to the one search somebody actually performs
     * on this page.
     */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toMatch(/hidden=\{panel\.seasonNumber !== selected\}/);
  });

  it("binds every tab to a panel that exists, in both directions", async () => {
    /*
     * `aria-controls` pointing at an id nothing renders is a relationship a
     * screen reader announces and cannot follow. The two id builders are the
     * only places either string is spelled, which is what makes them agree --
     * asserted rather than assumed, because two literals would be two things to
     * keep in step.
     */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toContain("aria-controls={panelId(panel.seasonNumber)}");
    expect(source).toContain("id={panelId(panel.seasonNumber)}");
    expect(source).toContain("aria-labelledby={tabId(panel.seasonNumber)}");
    expect(source).toContain("id={tabId(panel.seasonNumber)}");
    /* Non-vacuity: the builders exist and are the only spelling. */
    expect(source).toMatch(/function panelId\(/);
    expect(source).toMatch(/function tabId\(/);
  });

  it("DERIVES the selection rather than repairing it, so a stale season cannot blank the page", async () => {
    /*
     * `panels` comes from a server render and a navigation to another series
     * reuses this component. A selection left pointing at a season the new
     * series does not have would hide every panel -- a blank page that reads
     * as a load failure.
     *
     * The first draft fixed that up in an effect. This asserts the stronger
     * arrangement that replaced it: `chosen` is what the viewer asked for and
     * `selected` is what the component can honour, computed during render, so
     * the broken state is unrepresentable rather than corrected one render
     * late. `react-hooks/set-state-in-effect` is what forced the question and
     * it was right to.
     */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toContain("panels.some((panel) => panel.seasonNumber === chosen)");
    /* And there is no effect left to repair anything with -- which is the
     * property, not a stylistic preference. */
    expect(source).not.toContain("useEffect");
  });

  it("asks React whether it has hydrated instead of sniffing the environment", async () => {
    /*
     * `typeof window !== "undefined"` evaluates differently on the server and
     * on the client's first render, which is a hydration mismatch by
     * construction. `useSyncExternalStore` has a server snapshot for exactly
     * this question and React reconciles the two itself.
     */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).toContain("useSyncExternalStore");
    expect(source).not.toContain("typeof window");
  });
});

describe("the episode list still owns the cards", () => {
  it("passes rendered content, so no title module reaches the client bundle", async () => {
    /*
     * THE BUNDLE BOUNDARY, WHICH ONLY `next build` ENFORCES. If this client
     * component took `TitleEpisodeSummary[]` and rendered the cards itself it
     * would import `app/title/title-detail` -- and with it `demo-title-details`
     * and the title contract -- into the browser, to re-decide a rights gate
     * the server has already decided. `components/auth/account-state.ts`
     * records what that costs and why no unit suite can see it.
     *
     * So: this component imports nothing from the title surface, and the
     * episode list hands it a node.
     */
    const source = await sourceOf("./season-navigation.tsx");
    expect(source).not.toContain("title-detail");
    expect(source).not.toContain("@liberty/contracts");
    expect(source).toContain("ReactNode");

    const list = await sourceOf("./episode-list.tsx");
    expect(list).toContain("<SeasonNavigation panels={panels} />");
    /*
     * And the card is still built there, by the same component as before.
     *
     * MATCHED AS TWO FACTS RATHER THAN AS ONE LITERAL. This used to assert the
     * exact string `<EpisodeCard episode={episode}` and it broke the moment
     * PW-0307 added a second prop and the element wrapped onto several lines
     * -- a test that fails because a formatter moved a newline is asserting
     * the formatting, not the property. The property is that the episode list
     * is what renders the card.
     */
    expect(list).toContain("<EpisodeCard");
    expect(list).toContain("episode={episode}");
    /* And the state it draws comes from the loader, not from anything this
     * component decided: the index is read, and the card is handed one
     * episode's entry out of it. */
    expect(list).toContain("progress={progress.get(episode.id)}");
    expect(list).toContain("loadEpisodeProgress(");
  });
});
