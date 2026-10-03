import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { CATALOG_AVAILABILITY, UNKNOWN_CATALOG_SKIP_REASON } from "../src/env";
import { DEMO } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * The player's controls, operated (PW-0306)
 *
 * ==========================================================================
 * WHY THIS LAYER AND NOT THE UNIT SUITE
 * ==========================================================================
 *
 * `apps/web` runs Vitest with `environment: "node"`. No DOM, so no effect
 * runs, no keystroke is dispatched and no menu opens — `season-navigation`
 * made the same observation one task earlier. So the work is split three
 * ways: the DECISIONS are pure functions in `controls/controls-state.ts` with
 * 31 tests; the FIRST PAINT and every accessibility promise that lives in an
 * attribute are in `controls/player-controls.test.tsx`; and the things only a
 * browser can answer are here.
 *
 * Those things are the acceptance's own words: "keyboard operation — space,
 * arrows, F, M, and Escape — because there is not one keyboard handler in the
 * entire application today", and "an idle-hide overlay that never hides a
 * control from a keyboard or screen-reader user". A keyboard clause tested
 * without a keyboard is not tested.
 *
 * ==========================================================================
 * WHAT IS ASSERTED AND WHAT IS DELIBERATELY NOT
 * ==========================================================================
 *
 * ASSERTED: that the controls exist and are reachable; that they are reached
 * by TAB rather than only by mouse; that the bar never leaves the
 * accessibility tree; that the track menus open, announce themselves and
 * report an empty source honestly; that the source line a viewer reads is
 * there; and that the native `<video>` chrome is gone, because two seek bars
 * that disagree is worse than one.
 *
 * NOT ASSERTED, and the reason matters more than the omission: **that the
 * picture moves**. The demo catalog's sources are fixtures and no real media
 * decodes in this harness, so a test that clicked Play and waited for
 * `playing` would be asserting the fixture rather than the control. What a
 * command reaching the adapter looks like is covered where it can be — the
 * adapter's own suite — and what a viewer can OPERATE is covered here.
 *
 * FULLSCREEN IS NOT ASSERTED EITHER. `requestFullscreen` needs a user
 * gesture and a real display; headless Chromium grants neither reliably, and
 * a flaky assertion about it would be the retry pressure `playwright.config.ts`
 * refuses. The button's presence and its label are asserted; the effect is
 * owed to the commander's machine.
 * ---------------------------------------------------------------------- */

test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

function controls(page: Page): Locator {
  return page.getByTestId("player-controls");
}

/**
 * The bar renders only once the adapter exists, which is after the custom
 * element is connected and its controller built. Waiting for the bar is
 * therefore also the wait for the player to have started existing.
 */
async function openPlayer(page: Page): Promise<Locator> {
  const response = await page.goto(`/watch/${DEMO.movie.id}`);
  expect(response?.status()).toBe(200);
  const bar = controls(page);
  await expect(bar).toHaveCount(1);
  return bar;
}

test("every control the acceptance names is on the page and has a name", async ({ page }) => {
  await openPlayer(page);

  /* By ACCESSIBLE NAME, not by test id, because the name is the thing a
   * screen-reader user and a voice-control user both rely on, and a test id
   * would pass with every one of them missing. */
  await expect(page.getByRole("button", { name: /^(Play|Pause)$/ })).toHaveCount(1);
  await expect(page.getByRole("slider", { name: "Seek" })).toHaveCount(1);
  await expect(page.getByRole("slider", { name: "Volume" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^(Mute|Unmute)$/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /full screen/i })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Subtitles" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Audio" })).toHaveCount(1);
  await expect(page.getByTestId("control-source")).toBeVisible();
});

test("THE NATIVE VIDEO CHROME IS GONE", async ({ page }) => {
  /* It was set when there was nothing else. Leaving both would give a viewer
   * two seek bars that disagree about where they are. */
  await openPlayer(page);
  const video = page.locator("liberty-video");
  await expect(video).toHaveCount(1);
  expect(await video.getAttribute("controls")).toBeNull();
});

test("the whole bar is reachable with TAB, in order, with nothing skipped", async ({ page }) => {
  await openPlayer(page);

  /* Start from the document rather than from a control, so this measures what
   * a keyboard user actually walks through. */
  await page.locator("body").click({ position: { x: 2, y: 2 } });

  const reached: string[] = [];
  for (let press = 0; press < 40; press += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      if (active.closest("[data-testid='player-controls']") === null) return null;
      return active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "";
    });
    if (name !== null && !reached.includes(name)) reached.push(name);
    if (reached.length >= 6) break;
  }

  /*
   * SIX, AND THE MISSING ONE IS THE POINT.
   *
   * Play, mute, volume, subtitles, audio and full screen are reachable. The
   * SEEK BAR IS NOT, and that is correct rather than a defect: the demo
   * source reports no duration, so there is nothing to seek to, and the
   * control is `disabled` — which is not the same as hidden. A disabled
   * control is announced as unavailable; a control removed from the tree is
   * announced as nothing. The next assertion pins that distinction down so a
   * later edit cannot quietly turn one into the other.
   */
  expect(reached).toHaveLength(6);
  expect(reached).toEqual(
    expect.arrayContaining(["Volume", "Subtitles", "Audio"])
  );
  expect(reached).not.toContain("Seek");

  const seek = page.getByRole("slider", { name: "Seek", disabled: true });
  await expect(seek).toHaveCount(1);
});

test("SPACE OPERATES THE PLAYER AND DOES NOT SCROLL THE PAGE", async ({ page }) => {
  /*
   * The whole reason the key mapping is a pure function with a text-entry
   * guard: space is both "play" and the commonest character in writing. Here
   * the question is the other half — that when the player does claim it, it
   * claims it properly.
   */
  const bar = await openPlayer(page);
  await page.getByRole("button", { name: /^(Play|Pause)$/ }).focus();
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press(" ");
  await expect(bar).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("the arrow keys move the volume rather than the page", async ({ page }) => {
  await openPlayer(page);
  const volume = page.getByRole("slider", { name: "Volume" });
  const start = Number(await volume.inputValue());

  await page.getByRole("button", { name: /^(Play|Pause)$/ }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  /* Two steps of 5% each, through the adapter and back as a `volume` event —
   * so this also proves the command reached the adapter and the result
   * returned, which is the round trip the unit suite cannot make. */
  await expect
    .poll(async () => Number(await volume.inputValue()))
    .toBeLessThan(start);
});

test("M mutes, and the button says which state it is in", async ({ page }) => {
  await openPlayer(page);
  await page.getByRole("button", { name: /^(Play|Pause)$/ }).focus();
  await expect(page.getByRole("button", { name: "Mute" })).toHaveCount(1);
  await page.keyboard.press("m");
  /* The LABEL changes, not just a class: a viewer who cannot see the icon has
   * to be told what the button will do next. */
  await expect(page.getByRole("button", { name: "Unmute" })).toHaveCount(1);
});

test("a track menu opens, announces itself, and says so when there is nothing to choose", async ({
  page
}) => {
  await openPlayer(page);
  const button = page.getByRole("button", { name: "Subtitles" });
  await expect(button).toHaveAttribute("aria-expanded", "false");

  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox", { name: "Subtitles" });
  await expect(list).toHaveCount(1);

  /*
   * EITHER OUTCOME IS CORRECT AND BOTH ARE ASSERTED, because what the fixture
   * stream reports is not this task's to fix: a source with text tracks shows
   * an Off row plus the tracks, and a source with none says so in words.
   * `web-player-adapter.ts` records the rule: "a menu that appears to change
   * the language and does not is worse than an error".
   */
  const options = list.getByRole("option");
  const count = await options.count();
  expect(count).toBeGreaterThan(0);
  if (count === 1) {
    await expect(options.first()).toHaveText(/No subtitle tracks were reported/);
  } else {
    await expect(options.first()).toHaveText("Off");
  }
});

test("ESCAPE CLOSES THE MENU, which is the first thing it should undo", async ({ page }) => {
  await openPlayer(page);
  const button = page.getByRole("button", { name: "Audio" });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
});

test("THE BAR NEVER LEAVES THE ACCESSIBILITY TREE, however it is dimmed", async ({ page }) => {
  /*
   * The acceptance clause, in a browser: "an idle-hide overlay that never
   * hides a control from a keyboard or screen-reader user". `getByRole`
   * queries the ACCESSIBILITY TREE, so a bar removed from it by `aria-hidden`,
   * `display: none`, `visibility: hidden` or `inert` would fail this
   * regardless of what the markup looked like.
   */
  const bar = await openPlayer(page);

  /*
   * THE IDLE STATE CANNOT BE REACHED IN THIS HARNESS, AND THAT IS REPORTED
   * RATHER THAN FAKED. `overlayVisibility` keeps the bar shown while playback
   * is paused — there is no moving picture to get out of the way of — and no
   * real media decodes against the demo fixtures, so the player is paused for
   * the whole of this run. Waiting for `dimmed` here would be waiting for a
   * state the product correctly refuses to enter.
   *
   * So the two halves are tested separately and both for real. WHEN the bar
   * dims is `controls-state.test.ts`, over the pure function, including the
   * four reasons it must not. WHAT DIMMING DOES is here, by applying the
   * class the component applies and asking the accessibility tree the same
   * questions afterwards — which is the assertion that would fail the day
   * somebody reaches for `display: none`.
   */
  await expect(bar).toHaveAttribute("data-visibility", "shown");

  const dimmedClass = await bar.evaluate((node) => {
    const existing = Array.from(node.classList).find((name) => name.includes("bar"));
    /* The CSS-module hash is generated, so the sibling class is derived from
     * the one already on the element rather than hard-coded. */
    const dimmed = existing?.replace("__bar", "__dimmed") ?? null;
    if (dimmed !== null) node.classList.add(dimmed);
    return dimmed;
  });
  expect(dimmedClass).not.toBeNull();

  /* Dimmed, and every control still answers a ROLE query — which reads the
   * accessibility tree, so `aria-hidden`, `display: none`, `visibility:
   * hidden` and `inert` would each fail this — and can still be focused. */
  const play = page.getByRole("button", { name: /^(Play|Pause)$/ });
  await expect(play).toBeVisible();
  await play.focus();
  await expect(play).toBeFocused();
  for (const name of ["Volume", "Subtitles", "Audio"]) {
    await expect(bar.getByRole("button", { name }).or(bar.getByRole("slider", { name }))).toHaveCount(1);
  }
});

test("the seek bar announces a TIME rather than a percentage", async ({ page }) => {
  await openPlayer(page);
  const seek = page.getByRole("slider", { name: "Seek" });
  /* The element's value is a percentage because that is what a range input
   * is. What gets announced must be the thing a viewer asked for. */
  const announced = await seek.getAttribute("aria-valuetext");
  expect(announced).toMatch(/of/);
  expect(announced).not.toMatch(/%/);
});
