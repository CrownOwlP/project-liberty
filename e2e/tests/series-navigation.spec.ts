import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { CATALOG_AVAILABILITY, UNKNOWN_CATALOG_SKIP_REASON, WEB_MODE } from "../src/env";
import { DEMO } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * Moving through a series without going back to the catalog (PW-0307)
 *
 * ==========================================================================
 * WHY THIS FILE DID NOT EXIST UNTIL NOW, WHICH IS THE INTERESTING PART
 * ==========================================================================
 *
 * PW-0307 shipped the season selector, the per-episode progress badges and
 * `resolveNextEpisode` three rounds ago, with 47 unit tests between them. It
 * could not ship a browser test of the selector, because **every series in
 * the demo catalog had exactly one season**, and a tab strip with one tab is
 * a tab strip nobody can be shown to operate. The handoffs carried that as a
 * stated limitation each round rather than hiding it.
 *
 * The gap was in the fixture, not the code. `app/title/demo-title-details.ts`
 * now divides `northstar`'s eight episodes into five and three — a layout
 * that divides the advertised `episodeCount` and cannot change it, enforced
 * by a throw in that module — so the second tab exists and this file is what
 * it is for.
 *
 * ==========================================================================
 * WHAT THIS LAYER PROVES THAT THE UNIT SUITE CANNOT
 * ==========================================================================
 *
 * `apps/web` runs Vitest in a `node` environment: no DOM, no effects, no
 * clicks. `season-navigation.test.tsx` therefore asserts the FIRST PAINT —
 * the flat stack a browser without the bundle keeps — and source rules about
 * the pattern. Whether a viewer can actually reach season 2, with a mouse and
 * with a keyboard, is a question only a browser answers, and until this round
 * no browser had a second season to answer it with.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. The end-of-playback next-episode
 * affordance is PW-0307's fourth clause and it is **not built**: it lives in
 * `player-surface.tsx`, which gpt-architect's round-103 ruling puts out of
 * bounds until PW-0306 completes, and PW-0306 is behind a chain that bottoms
 * out in the Windows compositing experiment. `resolveNextEpisode`'s
 * cross-season behaviour is proved instead at the unit layer **against the
 * real catalog** in `demo-title-details.test.ts` — which is a smaller claim
 * than a browser clicking "next episode", and it is the honest one to make
 * while nothing renders that control.
 * ---------------------------------------------------------------------- */

test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);
  test.skip(
    CATALOG_AVAILABILITY !== "fixtures",
    "This build serves no catalog metadata, so there is no series to navigate. The refusal " +
      "itself is asserted in critical-journey.spec.ts, which is where it belongs."
  );
});

/** The series with two seasons. One tab per season, in order. */
const tabs = (page: Page) => page.getByTestId("season-tab");
const panels = (page: Page) => page.getByTestId("season-panel");
const panel = (page: Page, season: number) =>
  page.locator(`[data-testid="season-panel"][data-season="${String(season)}"]`);

/**
 * Wait until the client component has taken over.
 *
 * NOT A CONVENIENCE. `SeasonNavigation` renders every panel OPEN on the
 * server — that is the flat stack a browser without the bundle keeps — and
 * only hides the unselected ones once its own `useSyncExternalStore` reports
 * that hydration happened. So "one panel is visible" is the post-hydration
 * state and asserting anything about tabs before it is a race. Waiting on the
 * product's own observable transition is what makes the assertions below
 * statements rather than coin flips.
 */
async function hydrated(page: Page): Promise<void> {
  await expect(panels(page)).toHaveCount(2);
  await expect(panel(page, 2)).toBeHidden();
}

test("a two-season series offers one tab per season, and opens on the first", async ({ page }) => {
  await page.goto(`/title/${DEMO.series.id}`);
  await hydrated(page);

  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).nth(0)).toHaveText("Season 1");
  await expect(tabs(page).nth(1)).toHaveText("Season 2");

  /* The ARIA state, not just the appearance: a sighted viewer reads the
   * highlight and a screen reader reads this, and a refactor can lose one
   * while keeping the other. */
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "false");

  await expect(panel(page, 1)).toBeVisible();
  await expect(panel(page, 2)).toBeHidden();
});

test("the seasons hold DIFFERENT episodes, which is what makes the selector worth having", async ({
  page
}) => {
  await page.goto(`/title/${DEMO.series.id}`);
  await hydrated(page);

  /*
   * THE CONTENT CHECK, AND IT IS NOT PEDANTRY. A selector that switched a
   * highlight and showed the same list either way would pass every assertion
   * about tabs in this file. Season 1 has five episodes and season 2 has
   * three — the uneven split `demo-title-details.ts` chose on purpose, so an
   * off-by-one at the boundary cannot pass in both directions.
   */
  await expect(panel(page, 1).getByRole("listitem")).toHaveCount(5);
  /*
   * `locator("li")` AND NOT `getByRole("listitem")` FOR THE CLOSED SEASON,
   * and the reason is a fact worth asserting rather than stepping around:
   * `hidden` removes a subtree from the ACCESSIBILITY TREE, so the closed
   * season's episodes have no role at all. The next block turns that
   * obstacle into the statement it should be.
   */
  await expect(panel(page, 2).locator("li")).toHaveCount(3);

  /* Eight in total: the layout divides the catalog's advertised count, it
   * does not change it, and this is that invariant seen from the outside. */
  await expect(page.getByTestId("season-panel").locator("li")).toHaveCount(8);

  /*
   * AND THE CLOSED SEASON IS NOT ANNOUNCED. A screen reader walking this page
   * finds five episodes, not eight. That is the whole point of hiding the
   * panel rather than styling it away, and it is the assertion a refactor to
   * `opacity: 0` or an off-screen class would fail while looking identical.
   */
  await expect(panel(page, 2).getByRole("listitem")).toHaveCount(0);
  await expect(page.getByTestId("season-panel").getByRole("listitem")).toHaveCount(5);
});

test("clicking the second season shows it and hides the first", async ({ page }) => {
  await page.goto(`/title/${DEMO.series.id}`);
  await hydrated(page);

  await tabs(page).nth(1).click();

  await expect(panel(page, 2)).toBeVisible();
  await expect(panel(page, 1)).toBeHidden();
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "false");

  /* And back, because a selector you can only move one way is half a
   * selector. */
  await tabs(page).nth(0).click();
  await expect(panel(page, 1)).toBeVisible();
  await expect(panel(page, 2)).toBeHidden();
});

test("THE KEYBOARD WORKS, which is the half a mouse test would never notice", async ({ page }) => {
  /*
   * `season-navigation.tsx` implements the WAI-ARIA tab pattern with a roving
   * tabindex and automatic activation, and its header says why: "a ten-season
   * series would otherwise cost ten tab presses to get past". None of that
   * can be exercised without a real browser, and PW-0306's acceptance records
   * that this application has "not one keyboard handler" today — so this is
   * the first keyboard interaction in the product with a test behind it.
   */
  await page.goto(`/title/${DEMO.series.id}`);
  await hydrated(page);

  await tabs(page).nth(0).focus();
  await expect(tabs(page).nth(0)).toBeFocused();

  /* ROVING TABINDEX: the unselected tab is -1, so it is not a tab stop. */
  await expect(tabs(page).nth(1)).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("ArrowRight");
  /* AUTOMATIC ACTIVATION: moving focus moves the panel, no Enter required. */
  await expect(tabs(page).nth(1)).toBeFocused();
  await expect(panel(page, 2)).toBeVisible();
  await expect(panel(page, 1)).toBeHidden();

  await page.keyboard.press("Home");
  await expect(tabs(page).nth(0)).toBeFocused();
  await expect(panel(page, 1)).toBeVisible();

  await page.keyboard.press("End");
  await expect(tabs(page).nth(1)).toBeFocused();
  await expect(panel(page, 2)).toBeVisible();
});

test("a ONE-season series gets no tab strip at all", async ({ page }) => {
  /*
   * NON-VACUITY FOR EVERY TEST ABOVE, and a real product rule rather than a
   * test convenience. A tab strip offering one choice is furniture: it costs
   * a screen reader a landmark and a keyboard user a stop, and it tells the
   * viewer nothing they could act on. `harbor-lights` is deliberately left
   * single-season so this case keeps a real series behind it.
   */
  await page.goto("/title/harbor-lights");

  await expect(page.getByRole("heading", { name: "Season 1" })).toBeVisible();

  /*
   * AND IT IS THE FLAT STACK, not a tab strip with the strip hidden. The
   * single-season branch of `season-navigation.tsx` returns the arrangement
   * `episode-list.tsx` produced before PW-0307 existed -- a plain `section`
   * with a real `h2` -- so there is no tablist, no tab, and no panel element
   * to be `hidden`. Asserting the absence of all three is what distinguishes
   * "the control was never built for one season" from "the control was built
   * and styled away", which look identical to a viewer and are not the same
   * thing at all to a screen reader.
   */
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.getByTestId("season-tab")).toHaveCount(0);
  await expect(page.getByTestId("season-panel")).toHaveCount(0);
});

test("the episode whose rights are not established still withholds its play link", async ({
  page
}) => {
  /*
   * THE FIXTURE GUARD. `harbor-lights-s1e6` is the only exercise this product
   * has, in a running build, of an episode the series is licensed for and the
   * EPISODE is not. Re-numbering `harbor-lights` into two seasons would have
   * changed that id and quietly retired it, which is why only `northstar`
   * gained a season. This test is what would have caught that.
   */
  await page.goto("/title/harbor-lights");

  const season = page.getByRole("region", { name: "Season 1" });
  await expect(season.getByRole("listitem")).toHaveCount(6);

  /*
   * FIVE PLAY CONTROLS FOR SIX EPISODES. Counted by the control's accessible
   * name rather than by episode id, which keeps this about the RULE -- an
   * episode whose rights basis is not established gets no play affordance --
   * instead of about one fixture. A bare link count would not do it: every
   * card carries a title link too, so six episodes with five playable is
   * eleven links, and eleven is a number that tells you nothing.
   */
  await expect(season.getByRole("link", { name: /^Play / })).toHaveCount(5);

  /* And the sixth says why, rather than silently offering nothing. */
  await expect(season.getByRole("listitem").filter({ hasText: "Episode 6" })).toHaveCount(1);
  await expect(
    season.getByRole("listitem").filter({ hasText: "Episode 6" }).getByRole("link", {
      name: /^Play /
    })
  ).toHaveCount(0);
});
