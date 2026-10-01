import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { isRecord } from "../src/contract";
import {
  AUTH_BASE_URL_FOR_SIGN_IN,
  CATALOG_AVAILABILITY,
  DATABASE_SESSION_SKIP_REASON,
  DEPLOYMENT_PREAMBLE_REFUSAL,
  IDENTITY_MECHANISM,
  UNKNOWN_CATALOG_SKIP_REASON,
  WEB_MODE
} from "../src/env";
import { DEMO, developmentIdentity, type DevelopmentIdentity } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * The watchlist leg (PW-0304)
 *
 * WHY THIS FILE EXISTS AND WHY IT IS IN THE BROWSER PROJECT. `/api/v1/watchlist`
 * and its mutation route have been complete, tested and reviewed since PL-0404,
 * and until PW-0304 nothing in the application rendered them: no add control, no
 * remove control and no list. `progress.api.spec.ts` says the same thing about
 * its own leg from the other end -- "nothing under components/** fetches
 * /api/v1/progress or /api/v1/profiles ... inventing a UI path for it would make
 * a test pass and a gap invisible". For the watchlist the UI path now exists, so
 * it is asserted where it exists: in a browser, through real clicks.
 *
 * THE ONE THING THIS FILE IS FOR, above all the rest, is the acceptance's own
 * sentence: "a refused write must not render as a success, which is the shape of
 * defect the harnesses in this repository have caught four times." An optimistic
 * control is exactly where that defect lives -- the button flips the instant it
 * is pressed, and nothing but a reconciliation against the answer tells a
 * refusal from an acceptance. `apps/web` runs Vitest in a `node` environment with
 * no DOM, so no unit test in this repository can press a button. This is the only
 * layer that can.
 *
 * NO REFUSAL HERE IS SIMULATED. The refusal case does not intercept the network,
 * does not stub a response and does not plant a `data-testid` for a state the
 * server never produced. It changes the development identity the PAGE sends --
 * which is what a sign-out in another tab does to a page already on screen -- and
 * the server then refuses the write on its own, with its own envelope, for its
 * own reason. The rollback that follows is the product's.
 *
 * ==========================================================================
 * THE FILE IS IN FOUR GROUPS BECAUSE THE PRODUCT HAS FOUR CONFIGURATIONS, AND
 * ONE OF THEM CANNOT SHOW THE LIST PAGE AT ALL
 * ==========================================================================
 *
 * A DEFECT FOUND WHILE WRITING THIS FILE, REPRODUCED TWICE, AND RECORDED IN THE
 * CONTROL PLANE AS `defect.found` RATHER THAN WORKED AROUND HERE.
 *
 * `lib/db/index.ts` caches the chosen repository in a module-level binding and
 * `lib/db/in-memory-repository.ts` builds its Maps at construction. Next's app
 * router compiles the React Server Components graph and the route-handler graph
 * separately, so on a build with NO `DATABASE_URL` each graph gets its own
 * store: a profile selected through `/api/v1/profiles/selection` is invisible to
 * every server component, and an entry written through `/api/v1/watchlist/:id`
 * is invisible to `/watchlist`. It is PRE-EXISTING -- PW-0305's
 * continue-watching rail is affected identically and SILENTLY, which is why
 * nobody had seen it -- and it disappears entirely on any deployment with a
 * database, because PostgreSQL is state outside the process.
 *
 * SO THE LIST PAGE IS ASSERTED WHERE IT CAN BE ASSERTED, and the groups say
 * which is which rather than quietly asserting the half that happens to pass:
 *
 *   A. REACHABILITY -- any configuration. The nav entry and the route itself.
 *   B. NO IDENTITY -- the signed-out rendering of a hosted build with no
 *      identity system.
 *   C. DEVELOPMENT HEADERS -- everything the ROUTE-HANDLER layer owns, which is
 *      the add control, the optimistic flip, the real refusal and the rollback.
 *      It deliberately verifies what was written by READING THE API rather than
 *      the list page, because on this configuration the list page cannot see it.
 *   D. A DATABASE SESSION -- the LIST PAGE, against real PostgreSQL and a real
 *      signed-in session. This is the only configuration in which a server
 *      component and a route handler share a store, and therefore the only one
 *      in which "a person can add a title and SEE THE LIST" is observable end to
 *      end.
 *
 * Every wait is on a condition. Nothing sleeps.
 * ---------------------------------------------------------------------- */

test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
  test.info().annotations.push({ type: "identity-mechanism", description: IDENTITY_MECHANISM });
});

const WATCHLIST = "/watchlist";
const WATCHLIST_API = "/api/v1/watchlist";
const PROFILES = "/api/v1/profiles";
const SELECTION = "/api/v1/profiles/selection";

const ADD = "Add to My List";
const REMOVE = "Remove from My List";
/** The first paint, before the list has been read. Neither of the two above. */
const UNRESOLVED = "My List";

/** The one control on a page. */
function control(page: Page) {
  return page.getByTestId("watchlist-control");
}

function notice(page: Page) {
  return page.getByTestId("watchlist-notice");
}

/**
 * Press a control and wait for the write it starts to have ANSWERED.
 *
 * WHY THIS IS NOT A CONVENIENCE. The control is optimistic: the label flips to
 * the asked-for state the instant it is pressed, before anything has been sent.
 * So `click()` followed by `toHaveText("Remove from My List")` is satisfied by
 * the OPTIMISTIC state and says nothing about the server at all -- and the first
 * version of this file did exactly that. It then reloaded while the write was
 * still in flight (the first PUT of a `next dev` process compiles the route and
 * took ~400ms), read a list the write had not reached yet, and failed. The test
 * was wrong, not the product: it had asserted a state the product publishes
 * precisely in order to say "I have not finished".
 *
 * So the wait is on the RESPONSE, which is the only event that distinguishes an
 * optimistic flip from a settled one, and the status is returned so the caller
 * can state which it expected. `aria-busy` is then asserted false by the
 * callers, because the control's own account of whether it is finished must
 * agree with the network's.
 *
 * Nothing sleeps. `waitForResponse` is a condition, and it is armed BEFORE the
 * click so a fast answer cannot be missed.
 */
async function pressAndAwaitWrite(page: Page, press: () => Promise<void>): Promise<number> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes(`${WATCHLIST_API}/`) &&
      ["PUT", "DELETE"].includes(response.request().method())
  );
  await press();
  return (await answered).status();
}

/** A control that has finished talking to the server, whatever it concluded. */
async function expectSettled(page: Page) {
  await expect(control(page)).toHaveAttribute("aria-busy", "false");
  await expect(control(page)).toBeEnabled();
}

/** The content ids on a profile's list, read at the wire. */
async function listedContentIds(
  request: APIRequestContext,
  headers: Readonly<Record<string, string>>
): Promise<readonly string[]> {
  const response = await request.get(WATCHLIST_API, { headers });
  const body: unknown = await response.json();
  if (!isRecord(body) || body["outcome"] !== "listed") return [];
  const entries = body["entries"];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (isRecord(entry) ? entry["contentId"] : undefined))
    .filter((id): id is string => typeof id === "string");
}

/**
 * Create a profile for a set of request headers and select it.
 *
 * TWO CALLS, because creating a profile does not select it -- the server says so
 * in the creation reason, and `progress.api.spec.ts` sets out why selection is a
 * property of the session rather than of the profile. Asserted step by step for
 * the reason that file gives too: a silent failure here would surface as a
 * watchlist refusal several requests later and would read as a defect in the
 * watchlist.
 *
 * TAKES HEADERS RATHER THAN AN IDENTITY, so the same helper serves the
 * development-header groups and the signed-in one. The two differ only in what
 * identifies the caller.
 */
async function selectAProfile(
  request: APIRequestContext,
  headers: Readonly<Record<string, string>>
): Promise<string> {
  /*
   * REUSED IF ONE IS ALREADY THERE, CREATED OTHERWISE, AND THE ORDER IS NOT
   * STYLE. A development identity is new on every test, so it never has a
   * profile. A SIGNED-IN account is not: it lives in PostgreSQL and survives
   * the run, so the second execution of this suite against the same database
   * met `display_name_already_used` -- the uniqueness constraint deliberately
   * spans archived profiles "so that household history stays unambiguous", and
   * it was right to refuse. Creating a uniquely-named profile per run instead
   * would leave a household accumulating one profile per CI build, which is
   * tidier for the test and worse for the data.
   */
  const existing = await request.get(PROFILES, { headers });
  const listed: unknown = await existing.json();
  const already =
    isRecord(listed) && Array.isArray(listed["profiles"]) ? listed["profiles"] : [];
  const reusable = already
    .map((entry) => (isRecord(entry) ? entry["id"] : undefined))
    .find((id): id is string => typeof id === "string");

  let profileId: string;
  if (reusable !== undefined) {
    profileId = reusable;
  } else {
    const created = await request.post(PROFILES, {
      headers,
      /*
       * `avatarKey` and `maxRating` are REQUIRED AND NULLABLE rather than
       * optional, which is this repository's rule for an unknown fact: `null`
       * says "this profile has no avatar", an absent key says only that
       * somebody did not think about it. Sending them is what a correct client
       * does.
       */
      data: { displayName: "E2E viewer", avatarKey: null, maxRating: null }
    });
    const createdBody: unknown = await created.json();
    expect(isRecord(createdBody) && createdBody["outcome"], await created.text()).toBe("created");

    const profile =
      isRecord(createdBody) && isRecord(createdBody["profile"]) ? createdBody["profile"] : {};
    const id = profile["id"];
    /* Typed rather than coerced: `String(undefined)` is a five-character
     * string, so a length check on the coerced value would pass for a response
     * that published no id at all. */
    expect(typeof id, "the created profile carries no id").toBe("string");
    profileId = String(id);
  }

  /*
   * SELECTION IS ALWAYS A SEPARATE CALL, even for a profile that already
   * existed: creating a profile does not select it -- the server says so in
   * the creation reason -- and a profile that exists from a previous run is
   * not necessarily the one this session is acting as.
   */
  const selected = await request.post(SELECTION, { headers, data: { profileId } });
  const selectedBody: unknown = await selected.json();
  expect(isRecord(selectedBody) && selectedBody["outcome"], await selected.text()).toBe("selected");

  return profileId;
}

/**
 * Empty this profile's list, so a test starts from a state it chose.
 *
 * ONLY GROUP D NEEDS IT, and only because its account is a row in PostgreSQL
 * that outlives the run: a second execution would otherwise meet the entry the
 * first one left. The development-header groups get a brand-new identity per
 * test and need nothing.
 *
 * It removes exactly what it finds rather than guessing, and `DELETE` on this
 * route is idempotent by design -- removing something absent answers
 * `not_present` and a 200 -- so this cannot fail for having been run twice.
 */
async function emptyTheList(
  request: APIRequestContext,
  headers: Readonly<Record<string, string>>
): Promise<void> {
  for (const contentId of await listedContentIds(request, headers)) {
    const removed = await request.delete(`${WATCHLIST_API}/${contentId}`, {
      headers: { ...headers, "content-type": "application/json" },
      data: {}
    });
    expect(removed.status(), await removed.text()).toBe(200);
  }
  expect(await listedContentIds(request, headers)).toEqual([]);
}

/* -------------------------------------------------------------------------
 * A. Reachability: the screen exists and the navigation says so
 * ---------------------------------------------------------------------- */

test("the watchlist is reachable from the primary navigation", async ({ page }) => {
  /*
   * NOT A COSMETIC CHECK. `components/shell/navigation.ts` carried this entry as
   * `planned` with the reason "the watchlist API is complete; its screen is
   * PW-0304" -- rendered as an `aria-disabled` span, not a link. PW-0301 built
   * that mechanism precisely because "/search, which is the most finished screen
   * in this application, was reachable from no link anywhere", and shipping
   * /watchlist while the nav still described it as unbuilt would reproduce that
   * defect with this task's own name on it.
   *
   * Addressed by role inside the navigation landmark, so this asserts the thing
   * a keyboard and a screen reader can actually reach rather than the presence
   * of a string in the HTML.
   */
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav.getByRole("link", { name: "Watchlist" })).toHaveAttribute("href", WATCHLIST);
});

test("the watchlist route is served and names itself, whatever this build can put on it", async ({
  page
}) => {
  /*
   * Mode-independent, and worth its own test for the reason the home route's
   * first assertion is: the heading is static markup rendered by the page above
   * everything that could fail, so a route that stopped answering at all fails
   * here rather than inside a branch.
   */
  const response = await page.goto(WATCHLIST);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("My List");
});

/* -------------------------------------------------------------------------
 * B. A deployment with no identity system
 * ---------------------------------------------------------------------- */

test("a deployment with no identity system refuses honestly rather than showing an empty list", async ({
  page
}) => {
  test.skip(
    IDENTITY_MECHANISM !== "none",
    "This run can identify a caller, so it does not render the unconfigured-deployment branch."
  );

  await page.goto(WATCHLIST);

  /*
   * WHY THIS IS A REFUSAL AND NOT A "SIGN IN" PANEL, which is what the first
   * draft of this test asserted and was wrong about.
   *
   * `components/auth/account-state.ts` draws three states and the distinction
   * is load-bearing: `signed-out` means "there is an identity system and you
   * are not in it", `unavailable` means "there is no identity system here".
   * A deployment with no DATABASE_URL and no auth secret is the SECOND, and
   * offering it a "Sign in" link would be "a link to a screen that can only
   * apologise" -- that module's own words. `/watchlist` therefore falls
   * through to the list, which cannot be read either, and says so.
   *
   * THE ASSERTION THE ACCEPTANCE CARES ABOUT IS THE NEGATIVE ONE. An
   * unconfigured deployment must NOT render "Nothing on your list yet": that
   * would tell a household their list is empty on the strength of never having
   * read it, which is the substitution `app/page.tsx` refuses when it answers
   * `catalog_source_not_configured` instead of `empty`.
   */
  await expect(page.getByRole("heading", { name: /couldn.t load your list/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /nothing on your list yet/i })).toHaveCount(0);

  /*
   * AND THE REASON IS THE ONE THIS CONFIGURATION PRODUCES, not merely "a
   * reason". `src/env.ts` derives it from the variables the harness pinned, so
   * which refusal is correct is something this run knows rather than guesses --
   * and a page that had started answering a different one would fail here
   * rather than pass on the strength of having rendered any error at all.
   */
  await expect(page.locator("p.code.state-detail")).toHaveText(DEPLOYMENT_PREAMBLE_REFUSAL);
});

/* -------------------------------------------------------------------------
 * C. The controls, on a build that identifies a caller from headers
 * ---------------------------------------------------------------------- */

const CONTROLS_SKIP_REASON: string | null =
  IDENTITY_MECHANISM === "development-headers"
    ? null
    : IDENTITY_MECHANISM === "none"
      ? "This run has no identity mechanism, so there is no profile to own a list. The " +
        "signed-out rendering IS asserted above; set LIBERTY_E2E_WEB_MODE=development to " +
        "exercise the controls."
      : "This run authenticates through a database session, where the catalog metadata source " +
        "is refused by design -- there is no title page or card to press an add control on. " +
        "Group D asserts the list page on that configuration instead.";

test.describe("the add control, where a title page exists to carry it", () => {
  test.skip(() => CONTROLS_SKIP_REASON !== null, CONTROLS_SKIP_REASON ?? "");
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  test("the control claims nothing until it has been told", async ({ page }) => {
    /*
     * AN IDENTITY WITH NO PROFILE SELECTED. The list read is refused, so the
     * control has no answer -- and the honest first paint of a toggle with no
     * state is neither "Add" nor "Remove". "Add to My List" here would be a lie
     * to anyone whose list already holds the title, and a press would be a guess
     * about which way to flip, which is why the control is also unpressable.
     */
    const identity = developmentIdentity("wl-unknown");
    await page.setExtraHTTPHeaders(identity.headers);

    await page.goto(`/title/${DEMO.movie.id}`);
    await expect(control(page)).toHaveText(UNRESOLVED);
    await expect(control(page)).toBeDisabled();
    await expect(control(page)).toHaveAttribute("aria-pressed", "false");
    /* Nothing has gone wrong, so nothing is announced. */
    await expect(notice(page)).toHaveText("");
  });

  test("adding from the title page writes the row, and the control still says so after a reload", async ({
    page
  }) => {
    const identity = developmentIdentity("wl-add");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity.headers);

    await page.goto(`/title/${DEMO.movie.id}`);

    /*
     * THE CONTROL RESOLVES TO A KNOWN STATE FIRST. This is the read PW-0304 put
     * behind one shared request per page; until it lands the control says
     * `UNRESOLVED`, and pressing it then would be pressing something that had
     * not yet decided what it does.
     */
    await expect(control(page)).toHaveText(ADD);
    await expect(control(page)).toBeEnabled();

    expect(await pressAndAwaitWrite(page, () => control(page).click())).toBe(200);

    /* The optimistic flip settles into the server's answer. `aria-pressed` is
     * the state a screen reader hears, so it is asserted beside the label
     * rather than instead of it, and `aria-busy` is asserted false so that none
     * of this can be the in-flight state wearing the finished state's clothes. */
    await expectSettled(page);
    await expect(control(page)).toHaveText(REMOVE);
    await expect(control(page)).toHaveAttribute("aria-pressed", "true");
    await expect(notice(page)).toHaveText("");

    /*
     * THE ASSERTION THAT SEPARATES A WRITE FROM AN OPTIMISTIC LIE. A control
     * that flipped and never sent anything, and a control whose write was
     * refused and which rendered the refusal as a success, both look exactly
     * like the three assertions above. Neither survives a reload: what the
     * control says afterwards comes from the server's own list.
     */
    await page.reload();
    await expect(control(page)).toHaveText(REMOVE);

    /* And the row is really there, read at the wire. The reload above proves
     * the control agrees with the server; this proves the server agrees with
     * the row. */
    expect(await listedContentIds(page.request, identity.headers)).toEqual([DEMO.movie.id]);
  });

  test("removing takes the row away again", async ({ page }) => {
    const identity = developmentIdentity("wl-remove");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity.headers);

    await page.goto(`/title/${DEMO.movie.id}`);
    await expect(control(page)).toHaveText(ADD);
    expect(await pressAndAwaitWrite(page, () => control(page).click())).toBe(200);
    await expectSettled(page);
    await expect(control(page)).toHaveText(REMOVE);

    expect(await pressAndAwaitWrite(page, () => control(page).click())).toBe(200);
    await expectSettled(page);
    await expect(control(page)).toHaveText(ADD);
    await expect(control(page)).toHaveAttribute("aria-pressed", "false");
    await expect(notice(page)).toHaveText("");

    await page.reload();
    await expect(control(page)).toHaveText(ADD);
    expect(await listedContentIds(page.request, identity.headers)).toEqual([]);
  });

  test("a catalog card carries the control, and it writes the card's own title", async ({
    page
  }) => {
    test.skip(
      CATALOG_AVAILABILITY !== "fixtures",
      "This build serves no catalog, so there are no cards to carry a control."
    );

    const identity = developmentIdentity("wl-card");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity.headers);

    await page.goto("/");

    /*
     * ADDRESSED THROUGH THE RAIL AND THE CARD, not by index into every control
     * on the page. The home screen carries one control per routable card, and a
     * test that pressed `.first()` would be asserting about whichever card the
     * rail happened to order first.
     */
    const films = page.getByRole("region", { name: "Films" });
    const card = films.locator("article.card").filter({ hasText: DEMO.movie.title });
    await expect(card.getByTestId("watchlist-control")).toHaveText(ADD);

    expect(
      await pressAndAwaitWrite(page, () => card.getByTestId("watchlist-control").click())
    ).toBe(200);
    await expect(card.getByTestId("watchlist-control")).toHaveAttribute("aria-busy", "false");
    await expect(card.getByTestId("watchlist-control")).toHaveText(REMOVE);

    /* THE TITLE IT WROTE IS THE TITLE ON THE CARD, and nothing else. A control
     * that posted the wrong id would pass every assertion above and put a
     * stranger's film on the list. */
    expect(await listedContentIds(page.request, identity.headers)).toEqual([DEMO.movie.id]);
  });

  test("A REFUSED WRITE ROLLS BACK AND SAYS WHY -- it does not render as a success", async ({
    page
  }) => {
    /*
     * THE ACCEPTANCE'S CENTRAL CASE, AND THE REFUSAL IS REAL.
     *
     * HOW IT IS PRODUCED, since this is the part worth distrusting. The page
     * loads as an identity that HAS selected a profile, so the control resolves
     * to a known `Add to My List` -- a precondition, asserted before anything
     * else, because a rollback from `unknown` would be meaningless. Then the
     * identity the PAGE sends is changed to one that has selected nothing. That
     * is not a stub: it is what a sign-out in another tab does to a page already
     * on screen, and every byte of what follows comes from the server. The route
     * authorises the request, finds no active profile, and answers its own 4xx
     * `refused` envelope with the real reason code.
     *
     * NOTHING IS INTERCEPTED. No `page.route`, no fulfilled response, no planted
     * attribute. `critical-journey.spec.ts` records the rule this follows --
     * faking a step "would make a test pass and a gap invisible".
     */
    const identity = developmentIdentity("wl-refused");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity.headers);

    await page.goto(`/title/${DEMO.movie.id}`);
    await expect(control(page)).toHaveText(ADD);

    const stranger = developmentIdentity("wl-stranger");
    await page.setExtraHTTPHeaders(stranger.headers);

    /* THE SERVER'S OWN 4xx, NOT A STUBBED ONE. Asserting the status here is what
     * makes the three UI assertions below statements about a refusal rather
     * than about a request that never happened. */
    expect(await pressAndAwaitWrite(page, () => control(page).click())).toBe(403);
    await expectSettled(page);

    /* 1. ROLLED BACK -- the defect this repository has caught four times. The
     *    optimistic flip is undone, and `aria-pressed` with it: a control that
     *    announced "pressed" to a screen reader while showing "Add" to everyone
     *    else would be the same lie in one channel only. */
    await expect(control(page)).toHaveText(ADD);
    await expect(control(page)).toHaveAttribute("aria-pressed", "false");

    /* 2. THE REASON IS THE SERVER'S, IN WORDS. The API answers a reason code
     *    rather than a boolean, and the acceptance requires that vocabulary be
     *    surfaced honestly. `no_active_profile_selected` has a remedy the viewer
     *    can perform, so they are told it rather than "something went wrong". */
    await expect(notice(page)).toHaveText("Choose a profile first.");

    /* 3. AND NOTHING WAS WRITTEN. The strongest form of "it did not render as a
     *    success" is that the list the refusal was about is still empty -- read
     *    back as the ORIGINAL identity, whose profile is the one that would have
     *    gained the row. */
    expect(await listedContentIds(page.request, identity.headers)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * D. The list page, on the only configuration that can show one
 * ---------------------------------------------------------------------- */

/**
 * An account of this spec file's own, signed in once per worker.
 *
 * WHY NOT `src/identity.ts`'s `establishSession`. That helper memoises ONE
 * session per worker and shares it with the four playback specs. This group has
 * to SELECT A PROFILE on the session it uses, which is server-side state those
 * specs did not ask for and do not expect; `playwright.config.ts` says this
 * repository has had six order-dependence defects and "treats determinism as
 * correctness", and quietly mutating a shared fixture is how the seventh would
 * arrive. A separate account costs one sign-up and one sign-in for the whole
 * file.
 *
 * WHY IT IS HERE AND NOT ADDED TO `src/identity.ts`. That module is not on
 * PW-0304's write surface. Put the shared form of this there in a task that owns
 * it, and delete this.
 *
 * ONE SIGN-IN PER WORKER, MEMOISED AT MODULE SCOPE, for the reason that file
 * gives: Better Auth rate-limits the endpoint, and it was right to.
 */
const WORKER = process.env["TEST_PARALLEL_INDEX"] ?? "0";

/**
 * TWO ACCOUNTS, NOT ONE, AND THE SECOND IS NOT A LUXURY.
 *
 * The two tests in this group need opposite server state: one needs a session
 * that HAS selected a profile, the other needs one that has not. Sharing an
 * account made the second test skip itself whenever the first had already run,
 * which under `fullyParallel` is "usually" -- and a test that usually skips is a
 * test that does not exist while still appearing in the report. A slot each
 * makes both deterministic and costs one extra sign-up.
 *
 * `slot` is in the address, so two accounts never collide, and `WORKER` is
 * there for the reason `src/identity.ts` puts it there: Playwright workers run
 * in parallel and must not race on one account's creation.
 */
type AccountSlot = "owner" | "unchosen";

function accountFor(slot: AccountSlot) {
  return {
    email: `e2e-watchlist-${slot}-${WORKER}@liberty.invalid`,
    password: "liberty-e2e-watchlist-password",
    name: `E2E Watchlist ${slot} ${WORKER}`
  } as const;
}

/**
 * One sign-in per slot per worker, memoised at module scope.
 *
 * WHY NOT `src/identity.ts`'s `establishSession`. That helper memoises ONE
 * session per worker and shares it with the four playback specs. This group has
 * to SELECT A PROFILE on the session it uses, which is server-side state those
 * specs did not ask for and do not expect; `playwright.config.ts` says this
 * repository has had six order-dependence defects and "treats determinism as
 * correctness", and quietly mutating a shared fixture is how the seventh would
 * arrive.
 *
 * WHY IT IS HERE AND NOT ADDED TO `src/identity.ts`. That module is not on
 * PW-0304's write surface. Put the shared form of this there in a task that
 * owns it, and delete this.
 */
const SIGNED_IN = new Map<AccountSlot, Promise<Readonly<Record<string, string>>>>();

const RATE_LIMITED = 429;
const SIGN_IN_ATTEMPTS = 4;

function retryDelayMs(header: string | undefined): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 2_000;
}

async function signIn(
  request: APIRequestContext,
  slot: AccountSlot
): Promise<Readonly<Record<string, string>>> {
  const origin = AUTH_BASE_URL_FOR_SIGN_IN;
  const account = accountFor(slot);

  /* Idempotent: a second worker meets an account that exists, and the endpoint
   * refuses. What decides success is the SIGN-IN, because a session is what the
   * caller asked for and an account is only the way to get one. */
  await request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { "content-type": "application/json", origin },
    data: account,
    failOnStatusCode: false
  });

  let last = "";
  for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
    const response = await request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { "content-type": "application/json", origin },
      data: { email: account.email, password: account.password },
      failOnStatusCode: false
    });

    if (response.ok()) {
      /* ALL the set-cookie values, not just the one whose name we know:
       * hard-coding `better-auth.session_token` would assert a name the library
       * owns, and the failure mode is a suite that sends nothing and reports
       * every authenticated case as signed out. */
      const cookie = response
        .headersArray()
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value.split(";", 1)[0]?.trim())
        .filter(
          (pair): pair is string => pair !== undefined && pair.includes("=") && !pair.endsWith("=")
        )
        .join("; ");

      if (cookie === "") {
        throw new Error(
          "sign-in succeeded but set no cookie. Liberty uses DATABASE sessions (PL-0401), so " +
            "the cookie is the pointer to the row and there is no bearer token to fall back on."
        );
      }
      return { cookie };
    }

    last = `${response.status()} ${await response.text()}`;
    if (response.status() !== RATE_LIMITED || attempt === SIGN_IN_ATTEMPTS) break;

    /* Obeying a 429 is correct client behaviour, not the retry
     * `playwright.config.ts` forbids: no ASSERTION is retried. */
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs(response.headers()["x-retry-after"]))
    );
  }

  throw new Error(
    `the harness could not sign in as ${account.email}: ${last}. This run was started with ` +
      "an identity system (src/env.ts's IDENTITY_MECHANISM), so this is a real failure rather " +
      "than a missing configuration."
  );
}

function establishWatchlistSession(
  request: APIRequestContext,
  slot: AccountSlot
): Promise<Readonly<Record<string, string>>> {
  const existing = SIGNED_IN.get(slot);
  if (existing !== undefined) return existing;
  const started = signIn(request, slot);
  SIGNED_IN.set(slot, started);
  return started;
}

test.describe("the list page, against a real session and a real database", () => {
  test.skip(() => DATABASE_SESSION_SKIP_REASON !== null, DATABASE_SESSION_SKIP_REASON ?? "");

  test("an entry written through the API is on the page, and can be taken off it there", async ({
    page
  }) => {
    /*
     * THE ACCEPTANCE'S "SEE THE LIST", AND THIS IS THE ONLY CONFIGURATION IN
     * WHICH IT IS OBSERVABLE -- see the defect described at the top of this
     * file. Here the server component and the route handler read the same
     * PostgreSQL rows, so what one writes the other can see.
     *
     * THE ENTRY IS WRITTEN AT THE WIRE RATHER THAN BY CLICKING, because this
     * build has no catalog metadata source and therefore no title page and no
     * card to click. Group C presses the buttons; this group renders the list.
     * Between them every step of the journey is exercised, and neither pretends
     * to have done the other's half.
     */
    const headers = await establishWatchlistSession(page.request, "owner");
    await selectAProfile(page.request, headers);
    await emptyTheList(page.request, headers);
    await page.setExtraHTTPHeaders(headers);

    const added = await page.request.put(`${WATCHLIST_API}/${DEMO.movie.id}`, {
      headers: { ...headers, "content-type": "application/json" },
      data: {}
    });
    expect(added.status(), await added.text()).toBe(200);

    await page.goto(WATCHLIST);

    /*
     * THE ENTRY IS THERE AND IS NOT NAMED, and both halves are the correct
     * answer on this build. The row exists, so the page must show it -- dropping
     * it would give a household a list shorter than their list with no way to
     * remove what is not shown. The catalog is refused
     * (`catalog_source_not_configured`), so the page has nothing to name it
     * with, and it says that rather than inventing a title.
     */
    await expect(page.getByRole("heading", { name: /can.t name right now/i })).toBeVisible();
    await expect(page.getByText(DEMO.movie.id)).toBeVisible();
    await expect(page.getByRole("heading", { name: /nothing on your list yet/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /couldn.t load your list/i })).toHaveCount(0);

    /* ONE ENTRY, ONE CONTROL. Addressing it by index would hide a page that
     * rendered the list twice. */
    await expect(control(page)).toHaveCount(1);
    await expect(control(page)).toHaveText(REMOVE);

    expect(await pressAndAwaitWrite(page, () => control(page).click())).toBe(200);
    await expectSettled(page);
    await expect(control(page)).toHaveText(ADD);

    /*
     * THE ROW STAYS ON SCREEN UNTIL THE PAGE IS ASKED AGAIN, DELIBERATELY. A
     * removed entry that vanished under the cursor would take its own undo with
     * it, and the control is a toggle -- the viewer can put it straight back.
     * What must not survive is the stored row, which the reload proves.
     */
    await page.reload();
    await expect(page.getByRole("heading", { name: /nothing on your list yet/i })).toBeVisible();
    expect(await listedContentIds(page.request, headers)).toEqual([]);
  });

  test("a viewer who is NOT signed in is offered the way in, carrying where they were", async ({
    page
  }) => {
    /*
     * THE `signed-out` BRANCH, AND THIS IS THE ONLY CONFIGURATION THAT HAS ONE.
     * It needs an identity system that the caller is not inside: a deployment
     * with no identity system answers `unavailable` instead (asserted above,
     * and the two must not be confused -- PW-0312 exists because they were).
     *
     * This page sends no cookie, so the server has an auth instance and no
     * session for this request. Nothing is stubbed; the state is produced by
     * not signing in.
     */
    await page.goto(WATCHLIST);

    await expect(page.getByRole("heading", { name: /sign in to keep a list/i })).toBeVisible();

    /* NOT the empty-list panel, and not the failure panel. A signed-out viewer
     * has not been told anything about their list, so neither claim may be
     * made. */
    await expect(page.getByRole("heading", { name: /nothing on your list yet/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /couldn.t load your list/i })).toHaveCount(0);

    /* AND IT CARRIES THE DESTINATION, so a viewer refused at /watchlist lands
     * back at /watchlist rather than on the home page having to find their way
     * again. */
    /* SCOPED TO `main`. The topbar carries its own "Sign in" link on every
     * screen -- `AccountRegion`, which has no destination to carry because it
     * is not about this page -- so an unscoped locator matches two elements and
     * would be asserting about whichever one came first. */
    await expect(page.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      /next=%2Fwatchlist|next=\/watchlist/
    );
  });

  test("a signed-in viewer with no profile selected is sent to the picker, not to an error", async ({
    page
  }) => {
    /*
     * `no_active_profile_selected` is the one refusal on this path with a remedy
     * the viewer can perform, and PW-0303 built the screen to perform it on.
     * Rendering it as "we couldn't load your list" would hand somebody a dead
     * end one click from the fix.
     *
     * This test deliberately does NOT select a profile -- and deliberately runs
     * in this group rather than in C, because on a development build the page
     * reaches this branch for the wrong reason (the defect at the top of this
     * file), and a test that passed for the wrong reason would go on passing
     * after the right one was fixed. Here it reaches it for the only reason
     * available: PostgreSQL holds no `active_profile_selection` row for this
     * session.
     */
    const headers = await establishWatchlistSession(page.request, "unchosen");
    await page.setExtraHTTPHeaders(headers);

    /*
     * THE PRECONDITION IS ASSERTED, NOT ASSUMED, AND IT IS AN `expect` RATHER
     * THAN A `skip`. The `unchosen` account exists so that nothing ever selects
     * a profile on this session; if something has, the assertion below would be
     * measuring a different branch and must fail rather than quietly pass.
     */
    const profiles = await page.request.get(PROFILES, { headers });
    const body: unknown = await profiles.json();
    expect(
      isRecord(body) ? body["activeProfileId"] : undefined,
      "the `unchosen` account must never have a profile selected; something in this run did"
    ).toBeNull();

    await page.goto(WATCHLIST);
    await expect(page.getByRole("heading", { name: /choose who is watching/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "Choose a profile" })).toHaveAttribute(
      "href",
      "/profiles"
    );
  });
});
