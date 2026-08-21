import { expect, test } from "@playwright/test";
import { DEMO, UNKNOWN_CONTENT_ID } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * PL-0701's acceptance journey: catalog -> title -> player
 *
 * ONE GAP IS DELIBERATE AND IS NOT PAPERED OVER. A catalog card is an
 * `<article>` with a heading and a metadata line; it is not a link, and neither
 * is a search result -- `search-results.tsx` states that search is discovery
 * and that a stream is resolved through authorized provider adapters at
 * playback time, never implied by a result being visible. So there is no
 * clickable path from a rail to a title today, and this journey crosses that
 * step by address while asserting that the id the catalog published is the id
 * the title route serves. Faking the click with a `data-testid` on a
 * non-existent link would have made the test pass and the gap invisible.
 *
 * Every wait here is on a condition. Nothing sleeps, and nothing asserts on a
 * value that a slower machine could legitimately still be computing.
 * ---------------------------------------------------------------------- */

test("the catalog surfaces the demo title on a named rail", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "One place. Fast playback. Clear decisions."
  );

  /* Addressed by its accessible name rather than by class: `CatalogRail` binds
   * the section to its heading with `aria-labelledby`, so this asserts the
   * relationship a screen reader uses and not the one the stylesheet does. */
  const films = page.getByRole("region", { name: "Films" });
  await expect(films).toBeVisible();
  await expect(films.getByRole("heading", { name: DEMO.movie.title })).toBeVisible();

  await expect(page.getByRole("region", { name: "Series" })).toBeVisible();
});

test("the title route serves the id the catalog published", async ({ page }) => {
  await page.goto(`/title/${DEMO.movie.id}`);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DEMO.movie.title);
  /* The genre is part of the catalog record, so matching it here is what makes
   * this "the same title", rather than "a page that happens to have that
   * heading". */
  await expect(page.getByText(DEMO.movie.genre).first()).toBeVisible();
});

test("an unknown title is a real 404, not a panel served at 200", async ({ page }) => {
  const response = await page.goto(`/title/${UNKNOWN_CONTENT_ID}`);

  /* Invisible to a reader and load-bearing for everything else that consumes
   * the route -- crawlers, link checkers, the eventual native clients -- all of
   * which would otherwise record a dead title as a live one. */
  expect(response?.status()).toBe(404);
});

test("the play affordance leads to the player for that same id", async ({ page }) => {
  await page.goto(`/title/${DEMO.movie.id}`);

  /*
   * A link, and a link with a real href. `PlayCta` renders NO control when
   * playback is blocked -- not a disabled button -- because a disabled play
   * button still claims "this is a thing you play, later", and for a title with
   * no established rights basis that is a claim we have no basis to make. A
   * visible, enabled Play here is therefore itself a rights assertion.
   */
  const play = page.getByRole("link", { name: "Play", exact: true });
  await expect(play).toBeVisible();
  await expect(play).toHaveAttribute("href", `/watch/${DEMO.movie.id}`);

  await play.click();
  await expect(page).toHaveURL(new RegExp(`/watch/${DEMO.movie.id}$`));
});

test("the player mounts, publishes a reason trail, and is never handed a src", async ({ page }) => {
  await page.goto(`/watch/${DEMO.movie.id}`);

  /* Server-rendered, so this holds with or without hydration and in every
   * engine. It is also the assertion that the id survived the whole journey. */
  await expect(page.getByText(`Content: ${DEMO.movie.id}`)).toBeVisible();

  const video = page.locator("liberty-video");
  await expect(video).toBeAttached();

  /*
   * THE INVARIANT THIS PAGE EXISTS TO PROTECT. `player-surface.tsx` sets
   * `controls` and `playsinline` as attributes and deliberately never `src`:
   * the element is driven through the controller, which is fed an
   * already-authorized session. A `src` on this node -- from a future refactor,
   * a stray attribute forward, a query parameter someone wired up -- would make
   * the player an open proxy for arbitrary media and relocate product invariant
   * 1 out of the code that enforces it and into whoever set the attribute.
   */
  expect(await video.getAttribute("src")).toBeNull();

  /*
   * Invariant 4 on the client. The machine records `session_resolved` when the
   * server-issued session is handed to it, which happens at mount and needs no
   * network -- so this is deterministic even with the default fixture origin
   * pointing at a host that resolves nowhere. A player that plays nothing and
   * explains nothing is the failure this assertion forbids.
   */
  await expect(page.getByText("Playback reason trail")).toBeVisible();
});

test("the player page offers a way back to the catalog", async ({ page }) => {
  await page.goto(`/watch/${DEMO.movie.id}`);
  await page.getByRole("link", { name: "Back to catalog" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "One place. Fast playback. Clear decisions."
  );
});

test("an unplayable content id does not reach the player", async ({ page }) => {
  /*
   * A non-normalized id is not-found rather than an error, and it is decided
   * BEFORE the candidate source is consulted -- which is what keeps raw URL
   * path input from reaching the provider boundary at all. `%2F` rather than a
   * literal slash so the router hands it to the segment instead of treating it
   * as another path segment.
   */
  const response = await page.goto("/watch/Not%20A%20Valid%20Id");
  expect(response?.status()).toBe(404);
});
