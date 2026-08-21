import { expect, test } from "@playwright/test";
import { DEMO } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * Search - three states that must stay three states
 *
 * The single most common way a search UI ships broken is collapsing "no query
 * has been asked yet" into "your query matched nothing", so the user is told
 * there are no results for a search they never ran. Each state is addressed by
 * URL rather than by typing, which keeps the 250ms debounce out of every test
 * that is not about the debounce -- a suite that waits out a timer is a suite
 * that gets slower and flakier every time somebody tunes the timer.
 * ---------------------------------------------------------------------- */

test("no query is idle, not empty", async ({ page }) => {
  await page.goto("/search");
  await expect(page.getByRole("heading", { name: "Search the catalog" })).toBeVisible();
  await expect(page.getByText(/No titles match/)).toHaveCount(0);
});

test("a matching query lists the title and says why it matched", async ({ page }) => {
  await page.goto("/search?q=aurora");

  await expect(page.getByRole("heading", { name: /Results for/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: DEMO.movie.title })).toBeVisible();

  /* `matchedOn` is the reason this result is in the list and in this position.
   * Rendering it means a result that looks wrong is explainable on the page
   * instead of only in a bug report -- the same argument the playback reason
   * trail makes, on the discovery surface. */
  await expect(page.getByText("Title starts with your search")).toBeVisible();
});

test("a non-matching query is empty, and echoes the query as text", async ({ page }) => {
  await page.goto("/search?q=nothingmatchesthis");
  await expect(page.getByRole("heading", { name: /No titles match/ })).toBeVisible();
});

test("the query is escaped rather than interpreted", async ({ page }) => {
  /*
   * The query is a React text node on every surface that shows it, so it is
   * escaped on render, and nothing on this path reaches
   * `dangerouslySetInnerHTML`. Asserted from outside because that is where an
   * injection would be observable: if the markup were ever built by
   * concatenation, this heading would contain an element instead of a string.
   */
  await page.goto(`/search?q=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);

  const heading = page.getByRole("heading", { name: /No titles match/ });
  await expect(heading).toBeVisible();
  await expect(heading.locator("img")).toHaveCount(0);
});

test("typing commits the query to the address bar", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("searchbox", { name: "Search the catalog" }).fill(DEMO.series.title);

  /*
   * Waits on the URL, not on the debounce. `toHaveURL` retries until the
   * navigation lands, so this asserts the behaviour ("the query becomes
   * addressable") without encoding SEARCH_DEBOUNCE_MS anywhere -- the number
   * can be retuned without touching this file.
   */
  await expect(page).toHaveURL(/[?&]q=Northstar\b/i);
  await expect(page.getByRole("heading", { name: DEMO.series.title })).toBeVisible();
});
