import { expect, test } from "@playwright/test";
import {
  CATALOG_AVAILABILITY,
  MANAGES_SERVER,
  UNKNOWN_CATALOG_SKIP_REASON,
  WEB_MODE
} from "../src/env";
import { CATALOG_ARTEFACTS_ON_PAGE, DEMO, UNKNOWN_CONTENT_ID } from "../src/fixtures";

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
 * The rail-to-title step is still crossed by address below, and asserting the
 * link instead is coverage this file should gain. It was withheld once already,
 * in the round that diagnosed why the suite failed, on the grounds that an
 * unverified new assertion added beside a set of known failures is how a real
 * regression gets attributed to the wrong change. Those failures are repaired
 * now, so that particular reason has expired -- but nothing has RUN since, and
 * the same argument applies to any round that cannot execute the suite. Faking
 * the click with a `data-testid` remains forbidden; there is nothing left to
 * fake.
 *
 * AND THERE IS NOW A BUILD WITH NO RAIL TO CROSS FROM. The catalog reads through
 * a metadata port whose only implementation is gated on a
 * `NonDeploymentEnvironment`, so a hosted build has no metadata source: the home
 * page renders "We couldn't load the catalog" with the reason code
 * `catalog_source_not_configured`, and the demo titles are nowhere on it. That is
 * deliberate for the reason the playback fixtures are gated -- serving invented
 * titles from a deployment presents them to a reader as the product's catalog --
 * so the rail step, like the watch step below it, is TWO deployments and the
 * spec says which is which rather than asserting the one it prefers.
 *
 * EVERY STEP OF THIS JOURNEY IS NOW TWO DEPLOYMENTS. The paragraph above used to
 * be able to say the rail step alone was, because `app/title/demo-title-details.ts`
 * still held a direct import of the fixture array and the title and Play steps
 * were consequently fixture-backed on a hosted build. That import has moved to
 * the metadata port, so the title route refuses there too and the Play control it
 * would have carried is not rendered. The block above the title test sets out
 * exactly what it refuses WITH, and why that refusal is a 200 rather than the 404
 * the previous comment predicted. What has not moved is the WATCH step's identity
 * gate, which is a format check consulting nothing.
 *
 * PROGRESS -- the fourth leg of PL-0701's acceptance sentence -- is NOT asserted
 * in this file, and the absence is a statement rather than a gap. Nothing under
 * `components/**` fetches `/api/v1/progress` or `/api/v1/profiles`: the player is
 * handed a session and never asks for a resume point, and there is no profile
 * picker, so there is no click path from this journey to a progress write.
 * `progress.api.spec.ts` asserts the leg at the wire, where it exists, and says
 * the same thing from its end. Inventing a UI path for it would make a test pass
 * and a gap invisible.
 *
 * Every wait here is on a condition. Nothing sleeps, and nothing asserts on a
 * value that a slower machine could legitimately still be computing.
 * ---------------------------------------------------------------------- */

/**
 * Which build this run measured, recorded on every result in this file.
 *
 * THE MODE IS PART OF THE EVIDENCE. The watch tests below assert one thing under
 * `production` and a different thing under `development`, so "critical-journey
 * passed" is only half a statement, and the half that reaches a gate record is
 * whichever mode somebody happened to run. Annotating it puts the answer beside
 * each test in the HTML and GitHub reporters. `docs/E2E.md` states that both
 * runs together are the gate.
 */
test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
});

/**
 * Strings that only the fixture provider can put on this page.
 *
 * The file names are composed by `authorized-candidates.ts` and the ids are the
 * candidate ids it derives from the content id. On a build that resolves
 * candidates they reach the HTML whether or not the client hydrates: the session
 * is handed to `PlayerSurface`, a client component, so its props are serialised
 * into the streamed RSC payload that ships inside the document.
 *
 * `fixtures.invalid` is deliberately NOT in this list. It is the origin the
 * harness pins when no rig is configured, and a run with `LIBERTY_E2E_MEDIA_ORIGIN`
 * set legitimately produces a different one -- so asserting it would make this
 * check pass for the wrong reason exactly when a rig is in play.
 */
const FIXTURE_ARTEFACTS: readonly string[] = [
  "720p.mp4",
  "master.m3u8",
  "manifest.mpd",
  `${DEMO.movie.id}-progressive`,
  `${DEMO.movie.id}-hls`,
  `${DEMO.movie.id}-dash`
];

test("the home route is served, whatever it can put on it", async ({ page }) => {
  const response = await page.goto("/");

  /* Mode-independent, and the reason it is worth its own test: the hero is
   * static markup rendered by the page itself, ABOVE the boundary the catalog
   * load sits inside, so it is on screen on a build with no metadata source as
   * much as on one with fixtures. A home route that stopped answering at all
   * would fail here rather than inside a branch. */
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "One place. Fast playback. Clear decisions."
  );
});

test("which catalog the home route can serve is decided by the build, and both are asserted", async ({
  page
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  await page.goto("/");

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * NOT A DEGRADED PASS, and the distinction this branch exists to hold is
     * between two panels the page can render. `loadHomeCatalog` answers
     * `error` / `catalog_source_not_configured` on a deployment, NOT `empty` --
     * deliberately, because the empty branch tells the reader "No titles are
     * currently available in your region", which would be false. Asserting the
     * reason CODE rather than only "no rails" is what makes this test able to
     * tell a refused source from an empty catalog; they are different facts and
     * only one of them has an operator remedy.
     *
     * The heading is matched loosely rather than as a literal. `app/page.tsx`
     * writes the apostrophe as the `&apos;` entity, which is U+0027, while the
     * watch route's headings further down use a literal U+2019 -- and pinning
     * either character in a test file is how a locator silently stops matching
     * after somebody's editor normalises quotes.
     */
    await expect(page.getByRole("heading", { name: /couldn.t load the catalog/i })).toBeVisible();
    await expect(page.getByText("catalog_source_not_configured")).toBeVisible();

    /* The panel the reader must NOT get, named rather than implied. */
    await expect(page.getByRole("heading", { name: "Nothing to watch yet" })).toHaveCount(0);

    await expect(page.getByRole("region", { name: "Films" })).toHaveCount(0);

    /*
     * REFUSED RATHER THAN FABRICATED, asserted as the absence of the catalog and
     * not only as the presence of the refusal. Read off the DOCUMENT, so it holds
     * whether or not the client hydrated. The development branch below requires
     * every one of these same strings to be PRESENT -- the same array, iterated
     * whole -- which is what stops this being a check that would pass against a
     * page that failed to render anything at all.
     */
    const html = await page.content();
    const leaked = CATALOG_ARTEFACTS_ON_PAGE.filter((artefact) => html.includes(artefact));
    expect(leaked, "a deployment rendered something only the demo catalog can produce").toEqual([]);
    return;
  }

  /* Addressed by its accessible name rather than by class: `CatalogRail` binds
   * the section to its heading with `aria-labelledby`, so this asserts the
   * relationship a screen reader uses and not the one the stylesheet does. */
  const films = page.getByRole("region", { name: "Films" });
  await expect(films).toBeVisible();
  await expect(films.getByRole("heading", { name: DEMO.movie.title })).toBeVisible();
  await expect(page.getByRole("region", { name: "Series" })).toBeVisible();

  const html = await page.content();
  for (const artefact of CATALOG_ARTEFACTS_ON_PAGE) {
    expect(html, "a development build rendered no demo catalog").toContain(artefact);
  }
});

/* -------------------------------------------------------------------------
 * The title route joined the mode split, and the comment that said otherwise
 * was describing the migration one round too early
 *
 * WHAT USED TO STAND HERE. "MODE-INDEPENDENT TODAY, AND THAT IS A FACT ABOUT AN
 * UNFINISHED MIGRATION RATHER THAN A DESIGN. `app/title/demo-title-details.ts`
 * still imports the `demoCatalog` array directly instead of reading the metadata
 * port, so the title surface is fixture-backed on a deployment while the home
 * rails are not." That was true, it named the day the assertion would have to
 * change, and the day has arrived: `demo-title-details.ts` now reaches
 * `demoCatalogSource` through a `NonDeploymentEnvironment` witness and throws
 * `CatalogMetadataSourceNotConfiguredError` when it cannot get one.
 *
 * WHAT IT PREDICTED, AND WHERE THE PREDICTION WAS WRONG. It said `/title/<id>`
 * would answer 404 on a deployment. It does not, and the difference is worth
 * stating rather than papering over. `title-detail.ts` catches the throw and
 * reports `error`; `notFound()` is called only for the `not-found` status, which
 * a throwing source never produces. So a hosted build answers 200 with the "We
 * couldn't load this title" panel for EVERY well-formed id -- the ones the
 * fixtures define and the ones nothing defines alike.
 *
 * THAT IS THE HONEST ANSWER RATHER THAN A DEFECT, and it is the same argument
 * `catalog_source_not_configured` makes against `empty` on the home route. A 404
 * asserts that nothing has this address. A process with no catalog has not
 * established that and cannot: it did not look, because there was nothing to
 * look in. `TITLE_UNAVAILABLE_METADATA` carries `robots: index false` for
 * exactly this 200, so the page is not indexed as the content of a title that is
 * fine.
 *
 * WHAT WAS OWED HAS BEEN PAID, AND THIS SPEC MOVED WITH IT. The block here used
 * to record one outstanding gap: that the reason code a reader gets is the
 * loader's generic `title_source_unavailable` rather than the specific
 * `catalog_source_not_configured` the home rails and the search surface publish,
 * with the remedy named as a two-line branch in `title-detail.ts`'s catch. That
 * branch has landed. The catch tests
 * `error instanceof CatalogMetadataSourceNotConfiguredError` and republishes
 * `error.reason`, and `demo-title-details.ts` declares that reason on the class
 * itself as the literal `catalog_source_not_configured`. So the four discovery
 * surfaces -- the home API, the home page, search and this route -- now publish
 * ONE reason code, and the production branch below asserts it. The assertion that
 * "goes red on the day that lands" was the previous one; it has gone red, and
 * this is the correction rather than a relaxation.
 *
 * `title_source_unavailable` HAS NOT BEEN DELETED, and nothing here may be read
 * as saying so. It is still what the loader answers for a source that throws
 * anything OTHER than that class -- the generic branch below the `instanceof` --
 * which is the path an injected failing source takes and which `title-detail.ts`'s
 * own unit suite covers. It is simply unreachable from a deployment, because the
 * default source's only throw is the class above. Asserting it here would be
 * asserting a code this page cannot render.
 * ---------------------------------------------------------------------- */

/**
 * Strings only the demo catalog can put on `/title/<movie id>`.
 *
 * The id is deliberately NOT in the list, for the reason two artefacts are
 * excluded from `CATALOG_ARTEFACTS_ON_PAGE`: it is in the address, so Next's own
 * streamed router payload can carry it into the document on a build that
 * rendered no title at all, and requiring its absence would fail on a page that
 * correctly refused. The title and the genre are catalog data and appear nowhere
 * in this route's static copy.
 */
const TITLE_ARTEFACTS: readonly string[] = [DEMO.movie.title, DEMO.movie.genre];

/**
 * The reason `/title/<id>` publishes on a build with no catalog metadata source.
 *
 * Restated rather than imported, for the reason `e2e/src/fixtures.ts` restates
 * the content ids: this directory is outside the npm workspaces, and a harness
 * that read the server's own constant would follow a rename instead of noticing
 * one. There is a constant to have missed, unusually -- the reason is a field on
 * `CatalogMetadataSourceNotConfiguredError` -- and that is exactly why the value
 * is pinned here: it is the same string `catalog.api.spec.ts` asserts at the
 * wire, the home branch above asserts on the page, and `search.spec.ts` asserts
 * on the search panel. Four surfaces, one reason, and a rename that reached three
 * of them is a finding rather than a maintenance chore.
 */
const CATALOG_SOURCE_NOT_CONFIGURED = "catalog_source_not_configured";

/**
 * The machine-readable line the TITLE route's state panel publishes.
 *
 * Not every state panel in this app -- which is what this comment used to claim.
 * `title/[titleId]/page.tsx` renders a single `<p className="code state-detail">`
 * and `search/page.tsx` does the same, but `watch/[contentId]/page.tsx` renders
 * `<ol className="state-detail">` with a `<li className="code">` per reason,
 * because a playback refusal carries a trail and a metadata refusal carries one
 * reason. This selector matches the first two and deliberately not the third; the
 * watch route's refusal is addressed by its text further down.
 */
const REASON_LINE = "p.code.state-detail";

test("which title the title route can serve is decided by the build, and both are asserted", async ({
  page
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  const response = await page.goto(`/title/${DEMO.movie.id}`);

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * 200 AND NOT 404, asserted rather than skipped, for the reason set out
     * above: this build has established nothing about whether the title exists.
     * The status is checked because it is what every non-JS consumer reads, and
     * because a change that started answering 404 here would be claiming an
     * absence nobody verified.
     */
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /couldn.t load this title/i
    );
    await expect(page.locator(REASON_LINE)).toHaveText(CATALOG_SOURCE_NOT_CONFIGURED);

    /*
     * REFUSED RATHER THAN FABRICATED, read off the DOCUMENT so it holds whether
     * or not the client hydrated. The development branch below requires every one
     * of these same strings to be PRESENT -- the same array, iterated whole --
     * which is what stops this being a check that would pass against a page that
     * rendered nothing at all.
     */
    const html = await page.content();
    const leaked = TITLE_ARTEFACTS.filter((artefact) => html.includes(artefact));
    expect(leaked, "a deployment rendered a title only the demo catalog can produce").toEqual([]);
    return;
  }

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DEMO.movie.title);
  /* The genre is part of the catalog record, so matching it here is what makes
   * this "the same title", rather than "a page that happens to have that
   * heading". */
  await expect(page.getByText(DEMO.movie.genre).first()).toBeVisible();

  const html = await page.content();
  for (const artefact of TITLE_ARTEFACTS) {
    expect(html, "a development build rendered no title detail").toContain(artefact);
  }
});

/* -------------------------------------------------------------------------
 * THE TWO 404 ASSERTIONS, AND WHAT THEY ARE ALLOWED TO ASSERT
 *
 * THEY USED TO FAIL, IN BOTH MODES, AND PL-0704 IS THE REPAIR. The block that
 * stood here described that failure and named the fix as unlanded; it is
 * corrected rather than deleted, because the mechanism is the reason these
 * assertions are shaped the way they are and because a comment that outlives the
 * code it describes is how this repository keeps losing things.
 *
 * WHAT WAS WRONG. Neither route was deciding wrongly: `loadTitleDetail` answered
 * `not-found` for an id the catalog does not define, `loadPlaybackSession`
 * answered `not-found` for an id that is not normalized, and both called
 * `notFound()`. The status never reached the wire, because a response's status
 * line precedes the first byte of its body and React flushes the shell -- body
 * bytes -- as soon as it has a Suspense boundary to fall back to. Next sets a 404
 * from an access-fallback error in exactly one place, the catch around the render
 * in `app-render.tsx`, which runs only when that error ESCAPES the HTML render. A
 * root `app/loading.tsx` wrapped every route in the application and each of these
 * two segments added one of its own, so every dead address answered 200 with a
 * skeleton -- captured, on all four browser projects, by an executed run of this
 * file.
 *
 * WHAT IS TRUE NOW. The existence decision on each route runs ABOVE every
 * Suspense boundary on it. `title/[titleId]/page.tsx` awaits its load and calls
 * `notFound()` before rendering anything, and states why that route can have no
 * skeleton at all -- whether a title exists IS the load there, so there is
 * nothing that could honestly be streamed before the answer. `watch/[contentId]/page.tsx`
 * calls `isWatchableContentId` first and keeps its skeleton by moving the
 * `<Suspense>` INSIDE the page, below the decision and around the provider
 * round-trip. `app/loading.tsx`'s skeleton moved into `app/page.tsx`, around the
 * catalog load, which is the only thing on the home route that ever waited.
 *
 * THE ROUTES WERE ONLY HALF OF IT, AND THE OTHER HALF HAS NOW LANDED. The
 * decision being above the boundary is necessary and not sufficient: the three
 * `loading.tsx` files had to be GONE, because while any of them existed its
 * boundary won over anything the page declared and these two assertions failed at
 * 200. All three are gone from the tree this file is committed on --
 * `app/loading.tsx`, `title/[titleId]/loading.tsx` and
 * `watch/[contentId]/loading.tsx` were deleted ahead of `npm install` and ahead
 * of every check phase in the round that commits this file. No Suspense boundary
 * is left above either existence decision, so the access-fallback error escapes
 * the HTML render and `notFound()` reaches the wire.
 *
 * NOTHING WAS TRADED FOR THAT STATUS. The skeletons were RELOCATED rather than
 * lost, exactly as the paragraph above describes: the home one into a
 * `<Suspense>` inside `app/page.tsx`, the player one into a `<Suspense>` inside
 * `watch/[contentId]/page.tsx`, both BELOW the decision on their route. Only the
 * title route ends with no skeleton, deliberately and for the reason given there.
 *
 * BOTH ASSERTIONS BELOW ARE THEREFORE EXPECTED TO PASS, AND ARE UNVERIFIED, which
 * is not the same claim as "they pass". This suite runs at the very end of the
 * round, after the commit, so no execution has yet seen the repaired tree; the
 * status is the one `docs/E2E.md` files as fixed, unverified, and the first run of
 * these two lines is what turns the expectation into a result. They are not
 * relaxed to match either reading; "Neither is relaxed, in either direction" below
 * is the reason.
 *
 * `search/loading.tsx` is the one loading file that remains, and it is NOT one of
 * the three. `/search` never calls `notFound()`, so its boundary is above nothing
 * that decides a status. Reading its survival as a deletion that was left partway
 * would be its own error.
 *
 * So these tests are green exactly when the repository has no loading file above
 * either route -- which is not a claim this comment gets to keep making about a
 * directory listing, and is why the next paragraph matters.
 *
 * THE CONDITION IS ASSERTED IN THE UNIT GATE RATHER THAN TRUSTED HERE.
 * `apps/web/src/app/watch/route-loading-boundaries.test.ts` walks the whole
 * `app/` tree and fails while any loading file sits above a page that can call
 * `notFound()`, and separately requires each such page to call it above any
 * `<Suspense>` it declares itself. That matters because the illegal state is
 * created by ADDING a file, in a directory that need not be near the route it
 * breaks, and it is invisible to `tsc` and to a review of the diff that
 * introduces it. Three comments already stated the rule in prose and the defect
 * shipped anyway.
 *
 * WHAT THESE TESTS MAY THEREFORE ASSERT: THE STATUS, AND NOT THE COPY. The body
 * Next serves with a 404 is its own minimal error shell; `not-found.tsx` is a
 * CLIENT boundary and renders on hydration, so a crawler, a link checker or any
 * other non-JS consumer receives the status and none of the words. An assertion
 * on "We don't have that title" would therefore be asserting a browser
 * behaviour while claiming to assert the product property, and it would pass or
 * fail for reasons unrelated to the repair. The status is the property; it is
 * what every one of those consumers actually reads, and it is exactly what was
 * wrong before.
 *
 * Neither is relaxed, in either direction. A 404 for a dead address is a real
 * product property, and a spec lowered to 200 would have been a written licence
 * for the defect -- the same mechanism the block further down records for the
 * watch route's fixtures.
 *
 * ONE OF THE TWO IS NOW BUILD-DEPENDENT, AND THAT IS NOT A RELAXATION. The TITLE
 * 404 is reachable only on a build that has a catalog, because answering "nothing
 * has this address" requires having looked: since `demo-title-details.ts` started
 * reading the metadata port, a hosted build's source THROWS rather than answering
 * `null`, and `title-detail.ts` turns a throw into `error` and never into
 * `not-found`. The 404 is therefore asserted under `development` exactly as
 * before, and the production half asserts the refusal instead -- which is a
 * different claim, not a weaker one, and the block above the title test sets out
 * why it is the correct one. The WATCH 404 is unaffected: it is decided by
 * `isWatchableContentId`, a format check that consults nothing, so it stays
 * mode-independent.
 * ---------------------------------------------------------------------- */

test("what an unknown title gets is decided by the build, and both are asserted", async ({
  page
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  const response = await page.goto(`/title/${UNKNOWN_CONTENT_ID}`);

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * THE SAME PANEL A KNOWN ID GETS ON THIS BUILD, and that identity is the
     * assertion. A process with no metadata source cannot tell an id nothing
     * defines from an id it simply cannot look up, so it must not claim to: both
     * addresses answer 200 with `catalog_source_not_configured`. A build that
     * started distinguishing them would have found a catalog somewhere it should
     * not have, and a build that answered 404 here would be asserting an absence
     * it never established.
     *
     * The skeleton-signature check below is deliberately not repeated in this
     * branch. It names the PL-0704 defect -- a Suspense shell flushed above a
     * `notFound()` -- and `notFound()` is unreachable on this route on this
     * build, so there is nothing here for it to name.
     */
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /couldn.t load this title/i
    );
    await expect(page.locator(REASON_LINE)).toHaveText(CATALOG_SOURCE_NOT_CONFIGURED);
    return;
  }

  /* Invisible to a reader and load-bearing for everything else that consumes
   * the route -- crawlers, link checkers, the eventual native clients -- all of
   * which would otherwise record a dead title as a live one. */
  expect(response?.status()).toBe(404);

  /*
   * THE SIGNATURE OF THE DEFECT, checked in the SERVED BYTES rather than in the
   * DOM. `response.text()` is what was on the wire, so this is the same view the
   * consumers above have, and it is the one place the old failure was visible:
   * the captured run showed this address answering 200 with the "Loading title"
   * skeleton on screen. The status assertion above is what would catch the
   * regression; this one is what would NAME it, in a report read by somebody who
   * does not already know that a new `loading.tsx` three directories up can do
   * this.
   *
   * The ellipsis is deliberately not pinned -- the skeleton's live-region text
   * ends in U+2026, and matching a substring rather than the character is the
   * same rule the typographic apostrophe gets elsewhere in this file.
   */
  const served = (await response?.text()) ?? "";
  expect(served, "a Suspense boundary is flushing a shell above this route's notFound()").not.toContain(
    "Loading title"
  );
});

test("the play affordance is offered only where a rights basis can be read, and both are asserted", async ({
  page
}) => {
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  await page.goto(`/title/${DEMO.movie.id}`);

  /*
   * A link, and a link with a real href. `PlayCta` renders NO control when
   * playback is blocked -- not a disabled button -- because a disabled play
   * button still claims "this is a thing you play, later", and for a title with
   * no established rights basis that is a claim we have no basis to make. A
   * visible, enabled Play here is therefore itself a rights assertion.
   */
  const play = page.getByRole("link", { name: "Play", exact: true });

  if (CATALOG_AVAILABILITY === "refused") {
    /*
     * ASSERTED RATHER THAN SKIPPED, and it is the same rights argument the watch
     * route's production branch makes, one surface earlier. On a build with no
     * metadata source the page never reaches a title detail, so it has read no
     * rights basis for anything -- and a Play control here would be asserting one
     * it does not hold. The counterpart is the development branch below, which
     * requires the control to EXIST and to point at the right id, so this is not
     * a check satisfied by a page that failed to render.
     */
    await expect(play).toHaveCount(0);
    return;
  }

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

    /*
     * REFUSED RATHER THAN FABRICATED, asserted as the absence of the fabrication
     * and not only as the absence of the player. The two are different claims:
     * "no `liberty-video` element" is satisfied by a page that failed to
     * hydrate, while this one reads the DOCUMENT, so it holds whether or not the
     * client ran. Nothing on this build may carry a fixture URI or a fixture
     * candidate id, because on this build the provider that composes them cannot
     * be constructed at all -- `fixtureProvider` needs a `NonDeploymentEnvironment`
     * and `NODE_ENV=production` cannot produce one.
     *
     * The development branch below asserts that EVERY string in
     * `FIXTURE_ARTEFACTS` is PRESENT -- the same array, iterated whole, not a
     * hand-copied subset of it -- which is what keeps this from being a check
     * that would pass against a blank page.
     */
    const html = await page.content();
    const leaked = FIXTURE_ARTEFACTS.filter((artefact) => html.includes(artefact));
    expect(leaked, "a production build served something only the fixtures can produce").toEqual([]);
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

  /*
   * THE OTHER HALF OF THE PRODUCTION CHECK ABOVE, and it runs before the
   * hydration-dependent assertions on purpose: the candidate ids are in the
   * streamed RSC payload because the session is a prop of a client component, so
   * this holds even on the run where nothing hydrated. If a change ever stopped
   * the fixtures reaching this page, the production branch would go on passing
   * and would have stopped proving anything.
   *
   * THE WHOLE ARRAY, file names included, so the pairing is symmetric by
   * construction rather than by a second list somebody has to keep in step. The
   * file names belong here for the same reason the ids do: `fixtureUri` in
   * `authorized-candidates.ts` composes `<origin>/<contentId>/<file>` through
   * `URL`, so a configured rig changes the ORIGIN and never the three file
   * names, and all three candidates share one origin -- so `checkUrl` and
   * `checkPlaybackSource` admit all three or none, and a page that reached
   * `status: "ok"` carries all three URIs. `fixtures.invalid` is the origin
   * itself and is deliberately absent from the array above, which is what keeps
   * this true with or without `LIBERTY_E2E_MEDIA_ORIGIN`.
   */
  const html = await page.content();
  for (const artefact of FIXTURE_ARTEFACTS) {
    expect(html, "a development build resolved no fixture candidates").toContain(artefact);
  }

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

  /*
   * The same signature check as the title route's, and it is worth MORE here
   * than there, because this route still has a skeleton. `PlaybackLoading` lives
   * inside `[contentId]/page.tsx`, below the identity gate and around the
   * provider round-trip, and a valid id legitimately streams it. That ordering
   * is the entire repair: if the decision were ever to move below that boundary
   * -- or a `loading.tsx` were added above the page -- this address would answer
   * 200 with "Loading player" again, which is precisely what an executed run
   * captured before PL-0704. So the skeleton appearing HERE, on an address the
   * route refused, is the defect returning, while the same skeleton on a valid id
   * is the feature working.
   */
  const served = (await response?.text()) ?? "";
  expect(served, "the player skeleton was flushed for an id the route refused").not.toContain(
    "Loading player"
  );
});
