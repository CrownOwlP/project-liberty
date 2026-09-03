import { expect, test } from "@playwright/test";
import { MANAGES_SERVER, WEB_MODE } from "../src/env";
import { DEMO, UNKNOWN_CONTENT_ID } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * PL-0701's acceptance journey: catalog -> title -> player
 *
 * THE GAP THIS BLOCK USED TO DESCRIBE HAS BEEN CLOSED, and the description is
 * corrected rather than quietly deleted. It said a catalog card "is an
 * `<article>` with a heading and a metadata line; it is not a link", so there
 * was "no clickable path from a rail to a title today" and the journey had to
 * cross that step by address. PL-0104 landed `lib/routes.ts`, and
 * `catalog-card.tsx` now renders the heading as a `<Link href="/title/:id">`
 * whenever the item resolves to one -- on the home rails and in the search
 * results alike, and `routes.ts` records that no item from either surface
 * reaches the unrouted branch today. A sentence that outlives the code it
 * describes is how this repository keeps losing things: left in place, it would
 * go on justifying not testing a link that exists.
 *
 * WHAT HAS NOT CHANGED is why there is still no click into PLAYBACK from a
 * card. A card carries no play affordance, because `search-results.tsx` states
 * that search is discovery and that a stream is resolved through authorized
 * provider adapters at playback time, never implied by a result being visible.
 * So the title-to-watch step is asserted through the Play link on the title
 * page, which is the only control making that claim.
 *
 * The rail-to-title step is still crossed by address below. Asserting the new
 * link is coverage this file should gain, and it is deliberately NOT added in
 * the same round that diagnosed why the suite fails: it is a new assertion,
 * this round could not run the suite, and an unverified assertion added beside
 * a set of known failures is how a real regression gets attributed to the
 * wrong change. Faking the click with a `data-testid` remains forbidden -- but
 * there is nothing left to fake.
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

/* -------------------------------------------------------------------------
 * THE TWO 404 ASSERTIONS FAIL TODAY, IN BOTH MODES, AND NEITHER IS RELAXED
 *
 * This one and "an unplayable content id does not reach the player" both
 * receive 200. They are the same defect and it is not in either route's
 * decision: `loadTitleDetail` returns `not-found` for an id the catalog does
 * not define, `loadPlaybackSession` returns `not-found` for an id that is not
 * normalized -- and it does so BEFORE the resolver is consulted, so the reading
 * that blamed the rights repair's `not-configured` branch is refuted by the
 * order of the code. Both routes then call `notFound()`, and the status never
 * reaches the wire.
 *
 * Next sets the 404 in exactly one place: the catch around `renderToStream` in
 * `app-render.tsx`, which runs only when the access-fallback error ESCAPES the
 * HTML render. `app/loading.tsx` puts every route in this app inside a
 * `<Suspense>` (a segment's loading file wraps that segment's child slots, so
 * the root one wraps everything), and each of these two routes adds its own on
 * top. React therefore completes the shell -- the root layout, and nothing else
 * -- and flushes it at 200 while the loader is still pending; the throw lands
 * in the boundary afterwards. The captured page snapshots say it outright: the
 * failure for this test is the "Loading title..." skeleton at 200, and for the
 * watch one it is "Loading player...".
 *
 * The fix lives in `apps/web/src/app/loading.tsx` (scope it to the home route
 * with a `(home)` route group) plus the two segment loading files; only
 * `watch/[contentId]/loading.tsx` is inside PL-0703's allowed paths, and
 * removing it alone changes which skeleton appears and no status at all.
 * `watch/[contentId]/page.tsx` carries the full argument and the rejected
 * alternatives.
 *
 * Left failing on purpose. A 404 for a dead address is a product property that
 * crawlers, link checkers and the eventual native clients read, and a spec
 * lowered to 200 would be a written licence for the defect -- which is the
 * exact mechanism the block further down records for the watch route's
 * fixtures.
 * ---------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------
 * The watch route is TWO deployments now, and the harness has to say which
 *
 * WHAT THE TEST HERE USED TO ASSERT, AND WHY IT WAS ASSERTING A DEFECT. One
 * test claimed that `<liberty-video>` attaches and a "Playback reason trail"
 * renders on `/watch/<id>` in every mode. It passed because
 * `watch/watch-session.ts` carried its OWN copy of the fixture provider under
 * no environment guard at all, so a production `next start` rendered a player
 * aimed at candidates declaring `owned` rights over files nobody had opened.
 * That duplicate is gone: the route consumes `resolveAuthorizedCandidates`,
 * which answers `not-configured` outside `development` and `test`, so under the
 * DEFAULT `LIBERTY_E2E_WEB_MODE=production` this route renders an explanation
 * and no player. The old assertion described the rights defect, not the
 * product, and a spec that asserts the wrong thing is worse than a missing one.
 *
 * The split below is the one `playback-session.api.spec.ts` already uses for
 * the session API rather than a second idiom invented here: assert BOTH
 * branches, and treat a production build that produces a player as the rights
 * incident it would be, not as a test that needs relaxing.
 *
 * `docs/E2E.md` USED TO STATE that "the watch page does not share that switch --
 * so the browser journey runs in both", which described the defect rather than
 * the product. PL-0703 owns that file and has corrected it: the doc now says the
 * watch page shares the switch, records that the divergence was blessed IN
 * WRITING -- which is how one copy of a rights-asserting fixture set got gated
 * while the other shipped -- and marks the player and granted-session coverage
 * rows as reachable only under a `development` build. Keep the two in step: a
 * doc that re-blesses a split is what let this defect survive a review.
 * ---------------------------------------------------------------------- */

test("the watch route answers with the id it was asked about, and never with a src", async ({
  page
}) => {
  const response = await page.goto(`/watch/${DEMO.movie.id}`);

  /* Deliberately NOT guarded on the mode, so it still means something when the
   * harness is aimed at a deployment whose build it was not told about. */
  expect(response?.status()).toBe(200);

  /*
   * The assertion that the id survived the whole journey, in the one form both
   * branches share: the player prints `Content: <id>` and the unavailable panel
   * prints `<id>: no authorized media provider ...`. Matching the id itself
   * rather than either sentence is what keeps this mode-independent without
   * making it a copy check on marketing text.
   */
  await expect(page.getByText(DEMO.movie.id).first()).toBeVisible();

  /*
   * THE INVARIANT THIS PAGE EXISTS TO PROTECT. `player-surface.tsx` sets
   * `controls` and `playsinline` as attributes and deliberately never `src`:
   * the element is driven through the controller, which is fed an
   * already-authorized session. A `src` on this node -- from a future refactor,
   * a stray attribute forward, a query parameter someone wired up -- would make
   * the player an open proxy for arbitrary media and relocate product invariant
   * 1 out of the code that enforces it and into whoever set the attribute.
   *
   * Counted rather than read off a single element, because on a production
   * build there is no element to read and `getAttribute` on a locator that
   * matches nothing is a timeout, not a null. Stated plainly: on that build
   * this line is satisfied by the absence of a player and proves nothing on its
   * own -- it is the development branch below, which requires the element to
   * EXIST before making the same check, that stops the pair being vacuous.
   */
  expect(await page.locator("liberty-video[src]").count()).toBe(0);
});

test("which branch the watch route takes is decided by the build, and both are asserted", async ({
  page
}) => {
  test.skip(!MANAGES_SERVER, "Only this harness knows how a server it started was built.");

  await page.goto(`/watch/${DEMO.movie.id}`);

  if (WEB_MODE === "production") {
    /*
     * NOT A DEGRADED PASS, and the same argument the session API's mode split
     * makes: a production build resolves no candidates because no provider
     * registry is wired in yet, and serving fixtures from a hosted deployment
     * would publish fabricated `owned` rights for files that do not exist.
     *
     * Addressed by accessible name, and by a regex because the heading uses a
     * typographic apostrophe -- pinning U+2019 in a test file is how a locator
     * silently stops matching after somebody's editor normalises quotes.
     */
    await expect(
      page.getByRole("heading", { name: /available on this deployment/i })
    ).toBeVisible();

    /* Product invariant 4 applies to a refusal exactly as much as to a grant:
     * the panel publishes a machine-readable line naming the title, so a
     * screenshot in a bug report is enough to find this state in the code. */
    await expect(
      page.getByText(`${DEMO.movie.id}: no authorized media provider is configured`)
    ).toBeVisible();

    /*
     * THE RIGHTS ASSERTION, and the reason this branch is asserted rather than
     * skipped. If a production build ever mounts a player here, a fixture has
     * escaped into a shipped artifact -- that is a rights incident rather than
     * a test failure, and it is exactly the defect PL-0703 exists to correct.
     * Safe to count without waiting: this branch never renders `PlayerSurface`,
     * so there is no effect that could append the element after the heading
     * above has been observed.
     */
    expect(await page.locator("liberty-video").count()).toBe(0);
    await expect(page.getByText("Playback reason trail")).toHaveCount(0);
    return;
  }

  /*
   * The development build, where fixtures may resolve and the player is the
   * correct answer. This is the branch the old single-mode test was really
   * describing, kept intact rather than deleted.
   *
   * IT FAILED ON THE FIRST REAL RUN BECAUSE THE DEV SERVER REFUSED TO SERVE ITS
   * OWN JAVASCRIPT, which was a config defect rather than anything this branch
   * asserts. Next 16's dev server refuses `/_next` requests whose host is not in
   * `allowedDevOrigins`; `src/env.ts` points every browser at
   * `http://127.0.0.1:3100`, which is not on the default list, so the server log
   * (`apps/web/.next/dev/logs/next-development.log`) records every client chunk
   * and the HMR endpoint being blocked. Nothing hydrated, so `PlayerSurface`'s
   * effect never ran, `<liberty-video>` was never created -- it is built with
   * `document.createElement` in that effect, not rendered as JSX -- and the
   * server-rendered `State: idle / Candidate: none` line was all there was. The
   * same blockage is why `search.spec.ts`'s debounce test failed on every
   * browser project, which is the tell that it was one cause wearing the
   * costume of several unrelated product defects.
   *
   * `allowedDevOrigins: ["127.0.0.1"]` is now set in `apps/web/next.config.ts`,
   * so this branch is no longer blocked -- it is merely UNPROVEN, because no run
   * has happened since. Rejected as the fix: pointing `BASE_URL` at `localhost`
   * instead. That would have made the symptom go away without the app ever
   * declaring which dev origins it trusts, and would silently re-break for
   * anyone who sets `LIBERTY_E2E_BASE_URL` to a numeric host. `docs/E2E.md`
   * records both.
   *
   * Everything up to hydration is already proven by the same failed run: the
   * page reached `status: "ok"`, so under this build `resolveAuthorizedCandidates`
   * resolved, `checkUrl` admitted the pinned `LIBERTY_FIXTURE_MEDIA_ORIGIN`, and
   * `rankStreamCandidates` selected. Only the client half is missing.
   */
  await expect(page.getByText(`Content: ${DEMO.movie.id}`)).toBeVisible();

  const video = page.locator("liberty-video");
  await expect(video).toBeAttached();
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
