import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { CATALOG_AVAILABILITY, UNKNOWN_CATALOG_SKIP_REASON, WEB_MODE } from "../src/env";
import { DEMO } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * Search - four states that must stay four states
 *
 * The single most common way a search UI ships broken is collapsing "no query
 * has been asked yet" into "your query matched nothing", so the user is told
 * there are no results for a search they never ran. `app/search/search.ts` keeps
 * a third and a fourth apart for the same reason: "this deployment has no
 * catalog to search" is not "your query matched nothing" either, and neither of
 * them is "the search service broke". Each state is addressed by URL rather than
 * by typing, which keeps the 250ms debounce out of every test that is not about
 * the debounce -- a suite that waits out a timer is a suite that gets slower and
 * flakier every time somebody tunes the timer.
 *
 * A RESULT CARD IS ADDRESSED BY ITS EXACT NAME. `getByRole`'s `name` option
 * matches a SUBSTRING by default, and the results section is headed
 * `Results for "<query>"` -- so for any query equal to a title, the card's own
 * heading and the section heading above it both match and the locator resolves
 * to two elements. Under strict mode that is a thrown error, and it is a defect
 * in the spec rather than in the page: it says "the title is on screen" and
 * measures "the query appears in some heading". `exact: true` asks the question
 * the test means. It still trims whitespace, so it is not brittle about markup.
 * ---------------------------------------------------------------------- */

/**
 * Which build this run measured, recorded on every result in this file.
 *
 * THIS FILE BRANCHES ON THE MODE, AND WHICH WAY IT BRANCHES CHANGED. It used to
 * say that on a hosted build every non-empty query "settles on `empty`", and
 * that a production branch finding the demo title would mean
 * `app/search/search.ts` was still importing the `demoCatalog` array directly.
 * Both sentences described a surface that has since migrated. `search.ts` now
 * calls `resolveCatalogMetadataSource`, answers `null` when there is none, and
 * `loadSearchResults` maps that `null` to `error` /
 * `catalog_source_not_configured` -- ahead of the emptiness test, and
 * deliberately, because "No titles match" is a statement about the catalog and a
 * deployment with no metadata source consulted none.
 *
 * So on a hosted build every NON-EMPTY query reaches the REFUSAL panel, not the
 * empty one. `/search` with no `q` still reaches the idle panel there, because
 * `loadSearchResults` decides `idle` before the source is consulted at all: a
 * search that was never run cannot have been refused.
 *
 * That gate is the one the home rails already answer to, and it is deliberate
 * for the reason `docs/CATALOG_SOURCE.md` gives: serving invented titles from a
 * hosted build presents them to a reader as the product's catalog.
 *
 * So the annotation is load-bearing here rather than a courtesy, and both runs
 * together are the gate. `docs/E2E.md` says so.
 */
test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
});

/**
 * "Search the catalog", which names TWO different things on this page and is
 * therefore never addressed by text.
 *
 * It is the `<h2>` of the idle panel -- the state this whole file exists to keep
 * distinct from every other one -- and it is also the visually-hidden `<label>`
 * that gives the search field its accessible name. Every use below picks the
 * role it means, `heading` or `searchbox`, so the two can never be confused for
 * each other by a locator that matched the wrong one.
 */
const IDLE_HEADING = "Search the catalog";

/**
 * The refusal panel's heading, matched loosely.
 *
 * `app/search/page.tsx` writes the apostrophe as the `&apos;` entity, which is
 * U+0027, while the watch route's headings use a literal U+2019. Pinning either
 * character in a test file is how a locator silently stops matching after
 * somebody's editor normalises quotes, so the class is matched instead.
 */
const REFUSAL_HEADING = /couldn.t run that search/i;

/**
 * The machine-readable line the refusal panel publishes.
 *
 * `page.tsx` renders it as `<p className="code state-detail">{reason}</p>`, and
 * it is the only element with those two classes on this surface. Product
 * invariant 4's argument applies to a discovery refusal as much as to a playback
 * one: a screenshot in a bug report has to be enough to find this state in the
 * code.
 */
const REASON_LINE = "p.code.state-detail";

/**
 * The reason a build with no catalog metadata source refuses with.
 *
 * Restated rather than imported, for the reason `e2e/src/fixtures.ts` restates
 * the content ids: this directory is outside the npm workspaces, and a harness
 * that read the server's own constant would follow a rename instead of noticing
 * one. It is the same string `catalog.api.spec.ts` asserts at the wire and
 * `critical-journey.spec.ts` asserts BOTH on the home page and -- since
 * `title-detail.ts`'s catch learned to republish
 * `CatalogMetadataSourceNotConfiguredError`'s `reason` field -- on the title
 * route. FOUR surfaces, one reason, and a rename that reached three of them is a
 * finding. This comment said "three" while the title route was still publishing
 * the loader's generic `title_source_unavailable`.
 */
const CATALOG_SOURCE_NOT_CONFIGURED = "catalog_source_not_configured";

/**
 * The sentence `describeSearchState` derives for each state, spoken by the ONE
 * live region on this surface.
 *
 * Asserted rather than left to the visible panel because the region is the only
 * thing a screen-reader user gets, and it is derived on the server -- so it is
 * in the document whether or not the client hydrated. A panel that rendered
 * correctly above a region that still said "Type to search the catalog." would
 * pass every visible assertion in this file.
 */
const IDLE_ANNOUNCEMENT = "Type to search the catalog.";
const REFUSED_ANNOUNCEMENT = "Search is currently unavailable.";

/**
 * The query the mode-split tests use, and the strings only the demo catalog can
 * put on the page for it.
 *
 * A PER-QUERY ARRAY RATHER THAN `CATALOG_ARTEFACTS_ON_PAGE`, and that is a fact
 * about search rather than a weakening of the pairing. That array is every
 * string the whole catalog can produce; a search for `aurora` legitimately
 * returns one title, so requiring `Northstar` to be present under `development`
 * would be false and requiring it absent under `production` would be trivially
 * true. The pairing here is over the strings this query's single match produces:
 * the title, which `catalog-card.tsx` renders as the card heading, and the id,
 * which the same heading carries inside `href="/title/aurora-fall"`.
 *
 * Neither string is in this page's static copy on any build -- `search/page.tsx`
 * has no navigation entry naming a rail and no demo-player link, which is why
 * `CATALOG_ARTEFACTS_ON_PAGE` has to carve two strings out for the HOME page and
 * this array does not. The query itself (`aurora`) is echoed into the field's
 * `value` on every build and is deliberately not in the array: it is a string the
 * READER supplied, not one the catalog produced.
 */
const MATCHING_QUERY = "aurora";
const MATCHED_ARTEFACTS: readonly string[] = [DEMO.movie.id, DEMO.movie.title];

/** The one live region on this surface. `search-form.tsx` renders exactly one. */
function announcement(page: Page): Locator {
  return page.getByRole("status");
}

/**
 * The refusal a build with no metadata source renders for any non-empty query.
 *
 * All three assertions fail separately and none implies another: the heading is
 * what a reader sees, the reason line is what a bug report can be searched for,
 * and the announcement is the entire experience for anybody using a screen
 * reader. A page that rendered the panel and left the live region saying
 * something else would be a real defect and is caught here.
 */
async function expectRefusedSearch(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: REFUSAL_HEADING })).toBeVisible();
  await expect(page.locator(REASON_LINE)).toHaveText(CATALOG_SOURCE_NOT_CONFIGURED);
  await expect(announcement(page)).toHaveText(REFUSED_ANNOUNCEMENT);
}

/**
 * Assert the page SETTLED for `query`, into whichever settled state this build
 * can reach, and never into the idle panel.
 *
 * THREE SETTLED STATES AND NOT TWO, which is what changed when search started
 * reading the metadata port. `Results for "<query>"` and `No titles match
 * "<query>"` both quote the query, so on a build with a catalog this proves a
 * search was run FOR THIS QUERY and reached an answer. The refusal does not
 * quote it -- there is nothing to quote, because no catalog was consulted -- so
 * on a build without one the strongest available statement is the refusal
 * itself, asserted in full by `expectRefusedSearch`. Which build is which is
 * pinned by the two mode-split tests below; this helper deliberately does not
 * re-decide it.
 *
 * The idle panel is excluded on every build, and that exclusion is the part that
 * carries across all three: a page still showing "Search the catalog" has not
 * run the search that was typed, which is the confusion this whole file exists
 * to prevent.
 *
 * `query` is interpolated into a `RegExp`, which is safe for the demo titles --
 * they are alphanumeric -- and would not be for an arbitrary one. Nothing calls
 * this with user input, and the one test in this file whose query carries regex
 * metacharacters deliberately does not use it.
 */
async function expectSettledSearch(page: Page, query: string): Promise<void> {
  if (CATALOG_AVAILABILITY === "refused") {
    await expectRefusedSearch(page);
  } else if (CATALOG_AVAILABILITY === "fixtures") {
    await expect(
      page.getByRole("heading", { name: new RegExp(`(Results for|No titles match).*${query}`) })
    ).toBeVisible();
  } else {
    /* An external deployment whose build this harness was not told about. All
     * three settled states are correct there, so the alternation admits all
     * three rather than guessing -- and the idle exclusion below still holds. */
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`(Results for|No titles match).*${query}|couldn.t run that search`, "i")
      })
    ).toBeVisible();
  }

  await expect(page.getByRole("heading", { name: IDLE_HEADING })).toHaveCount(0);
}

test("no query is idle on every build, and neither empty nor refused", async ({ page }) => {
  await page.goto("/search");

  await expect(page.getByRole("heading", { name: IDLE_HEADING })).toBeVisible();
  await expect(page.getByText(/No titles match/)).toHaveCount(0);

  /*
   * MODE-INDEPENDENT, AND IT IS AN ASSERTION ABOUT ORDERING RATHER THAN ABOUT
   * COPY. `loadSearchResults` returns `idle` for an empty query BEFORE it
   * consults the source, so a deployment with no metadata source reaches this
   * panel too. If that order were ever reversed, `/search` would greet every
   * reader on a hosted build with a refusal for a search they had not asked for
   * -- and every other test in this file would go on passing. The reason line is
   * checked as well as the heading because they are different elements: a page
   * that published a machine-readable failure code under an idle panel would be
   * caught here and by nothing else.
   */
  await expect(page.getByRole("heading", { name: REFUSAL_HEADING })).toHaveCount(0);
  await expect(page.locator(REASON_LINE)).toHaveCount(0);
  await expect(announcement(page)).toHaveText(IDLE_ANNOUNCEMENT);
});

test("what a matching query finds is decided by the build, and both are asserted", async ({
  page
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  await page.goto(`/search?q=${MATCHING_QUERY}`);

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * NOT A DEGRADED PASS, and the branch this file used to get WRONG. A query a
     * demo title starts with must find nothing on a build that can construct no
     * metadata source -- and the state it reaches is `error`, not `empty`. The
     * previous version of this test asserted the opposite, on the reasoning that
     * "the search ran, over the rows there are, and there are none". That
     * reasoning stopped being true when `search.ts` migrated off the fixture
     * array: no search runs at all now, no catalog is consulted, and "No titles
     * match" would be a statement about a catalog nobody looked at.
     *
     * The panel says so in the two ways it can, and `expectRefusedSearch` checks
     * both plus the sentence the live region speaks.
     */
    await expectRefusedSearch(page);

    /* The three other states this surface can render, each named rather than
     * implied and each wrong here. The results state is excluded twice, once by
     * its card and once by its reason label, because a regression that rendered
     * one without the other is still a catalog reaching a hosted build. */
    await expect(page.getByRole("heading", { name: /No titles match/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: IDLE_HEADING })).toHaveCount(0);
    await expect(page.getByRole("heading", { exact: true, name: DEMO.movie.title })).toHaveCount(0);
    await expect(page.getByText("Title starts with your search")).toHaveCount(0);

    /*
     * REFUSED RATHER THAN FABRICATED, read off the DOCUMENT so it holds whether
     * or not the client hydrated. The development branch below requires every one
     * of these same strings to be PRESENT -- the same array, iterated whole --
     * which is what stops this being a check that would pass against a page that
     * rendered nothing at all.
     */
    const html = await page.content();
    const leaked = MATCHED_ARTEFACTS.filter((artefact) => html.includes(artefact));
    expect(leaked, "a deployment searched and returned something only the fixtures hold").toEqual(
      []
    );
    return;
  }

  await expect(page.getByRole("heading", { name: /Results for/ })).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: DEMO.movie.title })).toBeVisible();

  /* `matchedOn` is the reason this result is in the list and in this position.
   * Rendering it means a result that looks wrong is explainable on the page
   * instead of only in a bug report -- the same argument the playback reason
   * trail makes, on the discovery surface. */
  await expect(page.getByText("Title starts with your search")).toBeVisible();

  /*
   * The count and the query, from the live region. Written as a shape rather
   * than as the exact sentence so the assertion does not pin the typographic
   * quotation marks `describeSearchState` wraps the query in -- a literal U+201C
   * in a test file is one editor normalisation away from a silent non-match. It
   * is still non-vacuous: "0 titles match", the refusal sentence and an empty
   * region all fail it.
   */
  await expect(announcement(page)).toHaveText(/^[1-9]\d* titles? match(es)?\b/);
  await expect(announcement(page)).toContainText(MATCHING_QUERY);

  const html = await page.content();
  for (const artefact of MATCHED_ARTEFACTS) {
    expect(html, "a development build searched and found no demo catalog").toContain(artefact);
  }
});

test("a query that matches nothing is empty on a build with a catalog, refused on one without", async ({
  page
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  await page.goto("/search?q=nothingmatchesthis");

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * THE SAME REFUSAL A MATCHING QUERY GETS, and that identity is the point of
     * asserting it twice. On a build with no metadata source the answer cannot
     * depend on the query, because the query is never compared against anything
     * -- so a build that started distinguishing these two would have found a
     * catalog somewhere it should not have.
     */
    await expectRefusedSearch(page);
    await expect(page.getByRole("heading", { name: /No titles match/ })).toHaveCount(0);
    return;
  }

  /*
   * THE ONLY BUILD WHERE `empty` IS REACHABLE AT ALL, which is why this test is
   * mode-split rather than mode-independent as it used to be. "No titles match"
   * is a statement about a catalog, so it can only be made by a process that has
   * one -- and it must not be crowded out by the refusal on the build that does.
   */
  await expect(page.getByRole("heading", { name: /No titles match/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: REFUSAL_HEADING })).toHaveCount(0);
  await expect(announcement(page)).toHaveText(/^No titles match\b/);
  await expect(announcement(page)).toContainText("nothingmatchesthis");
});

test("the query is escaped rather than interpreted", async ({ page }) => {
  /*
   * The query is a React text node or an attribute value on every surface that
   * shows it, so it is escaped on render, and nothing on this path reaches
   * `dangerouslySetInnerHTML`. Asserted from outside because that is where an
   * injection would be observable: if the markup were ever built by
   * concatenation, this would be an element rather than a string.
   */
  const injection = "<img src=x onerror=alert(1)>";
  await page.goto(`/search?q=${encodeURIComponent(injection)}`);

  /*
   * THE FIELD, RATHER THAN THE RESULTS HEADING THIS USED TO READ. On a build
   * with no metadata source the settled panel is the refusal, which does not
   * quote the query at all, so a heading-scoped check would silently have
   * nothing to look at there. The input echoes the query on EVERY build -- it is
   * `initialQuery`, the normalised `q`, rendered as `value` -- so this is the one
   * place the round trip is observable in both modes.
   *
   * `normalizeSearchQuery` replaces well-formedness violations, collapses runs
   * of whitespace to one space, trims, and truncates at 128 code units. This
   * string holds no surrogate, no run of whitespace longer than one character,
   * nothing to trim, and is 28 code units long -- so normalisation is the
   * identity on it and it may be compared literally.
   */
  await expect(page.getByRole("searchbox", { name: IDLE_HEADING })).toHaveValue(injection);

  /*
   * Scoped to `main` rather than to the whole document: under
   * `LIBERTY_E2E_WEB_MODE=development` Next injects its own dev-tools overlay
   * outside the page's root, a CSS locator pierces shadow roots, and an `img`
   * belonging to the framework would fail this for a reason that has nothing to
   * do with the product. Everything this page renders is inside `<main>`, and
   * the only image-shaped thing on it is the card poster, which is a `<div>`.
   */
  await expect(page.locator("main img")).toHaveCount(0);

  /*
   * The page settled rather than staying idle, so the two assertions above are
   * about a rendered answer and not about a page that never ran the search.
   * Asserted as the ABSENCE of the idle panel rather than through
   * `expectSettledSearch`, because that helper interpolates the query into a
   * `RegExp` and this query is made of metacharacters.
   */
  await expect(page.getByRole("heading", { name: IDLE_HEADING })).toHaveCount(0);
});

test("typing commits the query to the address bar", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("searchbox", { name: IDLE_HEADING }).fill(DEMO.series.title);

  /*
   * Waits on the URL, not on the debounce. `toHaveURL` retries until the
   * navigation lands, so this asserts the behaviour ("the query becomes
   * addressable") without encoding SEARCH_DEBOUNCE_MS anywhere -- the number
   * can be retuned without touching this file.
   */
  await expect(page).toHaveURL(/[?&]q=Northstar\b/i);
  /*
   * THE SETTLED STATE, rather than the result card this used to require.
   *
   * The card is only on the page when the build can resolve a catalog, and this
   * test is not about that -- it is about a keystroke becoming an addressable
   * query. Requiring the card here would have made a test named for the address
   * bar fail on a deployment for a catalog reason, which is the failure mode
   * where somebody deletes the wrong assertion. What "settled" means is now
   * build-dependent -- see `expectSettledSearch` -- and on every build it
   * excludes the idle panel, which is the half of the claim that follows the URL.
   *
   * It also removes the strict-mode violation the old locator needed `exact` to
   * dodge: `getByRole`'s `name` matches a substring by default, so for a query
   * equal to a title the card's heading and the section heading above it both
   * matched.
   */
  await expectSettledSearch(page, DEMO.series.title);
});

/* -------------------------------------------------------------------------
 * The window before the field is a React component (PL-0705)
 *
 * The search input is server-rendered HTML that a client bundle later hydrates
 * into a controlled component. Between those two moments the field is live: it
 * can be focused and typed into, and the characters live only in the DOM node.
 * The loss that follows cannot be reproduced from a unit test: it is entirely a
 * property of the gap between the markup arriving and the script running, and
 * `apps/web`'s Vitest suite has no DOM and no load order. So it is asserted
 * here, from outside, where that gap is real.
 * ---------------------------------------------------------------------- */

/**
 * Every request that delivers client JavaScript.
 *
 * A RegExp rather than a glob because `development` serves these with a
 * cache-busting query string (`.../main-app.js?v=1`), and a glob is matched
 * against the whole URL including that suffix.
 *
 * `/_next/` and not `/_next/static/`: every byte of this application's client
 * JavaScript comes from the framework's own asset routes, and pinning the
 * narrower path would silently stop matching if a framework upgrade moved the
 * chunks. Widening costs nothing here -- there is no third-party script on this
 * page to catch by accident.
 *
 * SCRIPTS ONLY, deliberately. Holding the stylesheet back as well would stop the
 * browser rendering the document at all, and every actionability check below
 * would then wait out its timeout against a field that exists and has no box --
 * a failure that looks nothing like the one this test is for.
 */
const CLIENT_SCRIPT = /\/_next\/.*\.js(\?|$)/;

test("text typed before hydration survives it", async ({ page }) => {
  /*
   * The pre-hydration window, held open rather than waited for.
   *
   * Every request for a client script parks in this handler until the test
   * releases it, so while the typing below happens the code that would hydrate
   * the field has provably not run: it has not been delivered. That is a
   * structural guarantee, not a timing one -- there is no sleep here and no race
   * to lose, which is what the no-retries rule in playwright.config.ts demands
   * of a spec about a load-order defect.
   */
  let heldScripts = 0;
  /*
   * The initialiser is never the function that gets called: a Promise executor
   * runs synchronously, so `release` refers to `resolve` before the constructor
   * returns. It exists so the variable has a callable type without a `null`
   * that TypeScript would then have to be argued out of.
   */
  let release: () => void = () => {};
  const bundleGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(CLIENT_SCRIPT, async (route) => {
    heldScripts += 1;
    await bundleGate;
    await route.continue();
  });

  const field = page.getByRole("searchbox", { name: IDLE_HEADING });

  try {
    // `commit`, because the default `load` would wait for exactly the scripts
    // this test is holding back.
    await page.goto("/search", { waitUntil: "commit" });

    await expect(field).toBeVisible();

    /*
     * THE GUARD THAT STOPS THIS TEST PASSING VACUOUSLY. If the asset path ever
     * changes and the pattern matches nothing, nothing is held back, the page
     * is hydrated by the time the field is visible, and everything below
     * becomes ordinary post-hydration typing that cannot fail. This turns that
     * into a red result instead of a green one that proves nothing.
     */
    await expect.poll(() => heldScripts).toBeGreaterThan(0);

    // Real key events rather than `fill`, because the claim is about what a
    // person typing into unhydrated HTML gets back.
    await field.pressSequentially(DEMO.series.title);
    await expect(field).toHaveValue(DEMO.series.title);
  } finally {
    // In a `finally` so that a failure above cannot leave a route handler
    // parked on a promise nothing will ever resolve.
    release();
  }

  /*
   * The instrumentation comes off before anything is measured through it.
   *
   * Releasing the gate lets the held requests continue, but the handler is still
   * installed, so every script the page fetches from here -- the rest of the
   * chunks, and anything a client-side navigation asks for -- would still be
   * routed through it. The assertions below are about the hydrated page, and they
   * should see the same network the other tests in this file see.
   *
   * After the `finally` rather than inside it, deliberately: `release()` must run
   * even when the block above throws, and an `unroute` that rejected in the same
   * `finally` would replace that failure with its own and hide which assertion
   * actually failed. On the failing path the handler is left installed and the
   * context is discarded at the end of the test, which costs nothing because the
   * gate is already open.
   */
  await page.unroute(CLIENT_SCRIPT);

  /*
   * What the defect destroyed. React mounted with the query the server rendered
   * -- the empty one -- and the first commit to touch the input wrote it over
   * the top, so the characters vanished and no search was ever run for them.
   *
   * Both facts are asserted because they fail separately and either one is the
   * bug: the value proves the text survived, and the URL proves it was carried
   * on as typing rather than left as decoration in a field the form no longer
   * believes in. The URL is waited on rather than the debounce, as in the test
   * above, so SEARCH_DEBOUNCE_MS stays out of this file.
   */
  await expect(field).toHaveValue(DEMO.series.title);
  await expect(page).toHaveURL(/[?&]q=Northstar\b/i);
  /* The settled state for the typed query, for the reason given at the same
   * assertion in the test above: which settled panel appears is a catalog fact
   * and this test is about a hydration one. What it does assert on every build
   * is that the page left the idle state, which is what the typed query bought. */
  await expectSettledSearch(page, DEMO.series.title);
});
