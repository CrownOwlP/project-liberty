import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { BASE_URL, CATALOG_AVAILABILITY, DATABASE_SESSION_SKIP_REASON } from "../src/env";
import { DEMO, sessionRequest } from "../src/fixtures";
import { establishSession, type SessionHeaders } from "../src/identity";

/* -------------------------------------------------------------------------
 * The journey, joined: a real sign-in, in a browser, on a production build
 * (PL-0720)
 *
 * ==========================================================================
 * THE GAP THIS CLOSES, ESTABLISHED BY READING THE SUITE
 * ==========================================================================
 *
 * `establishSession` performs a real sign-up and sign-in against a production
 * build, and before this file it was imported by exactly four specs --
 * playback-session.api, playback-session.cross-target.api,
 * playback-session.desktop.api and rights-boundary.api. EVERY ONE OF THEM IS
 * AN API SPEC. No browser spec in this suite had ever signed in for real.
 *
 * Meanwhile every browser spec that reaches a player skips on a production
 * build, because a deployment with no catalog source serves a refusal; and
 * round 108 found that PW-0306's own e2e had only ever run in development,
 * where the watch route answers without an identity at all.
 *
 * So the product's central journey was proven in two halves that never met:
 * the API knew an authenticated session could obtain a playback decision, and
 * the browser knew a player could be operated by someone who never signed in.
 * The join is where a rights or session regression would actually land --
 * PL-0703, re-run as PL-0706, was a production rights-invariant breach in
 * exactly this route.
 *
 * ==========================================================================
 * HOW FAR THE JOURNEY GETS ON THIS DEPLOYMENT, AND WHY IT STOPS THERE
 * ==========================================================================
 *
 * Not to a playing picture, and the reason is two real external dependencies
 * rather than a gap in this file.
 *
 *   NO CATALOG. A production build refuses to serve the demo catalog on
 *   purpose: presenting invented titles from a hosted build would present them
 *   to a reader as the product's catalog. The only licensed source is a live
 *   query to a CC0 provider, which is a network dependency a gate should not
 *   have.
 *
 *   NO PROVIDER. The playback route answers `unavailable` /
 *   `provider_not_configured`, because no authorized media provider is
 *   configured. PL-0302 is the task that changes that and it is BLOCKED on
 *   "a confirmed licensed API/provider and credentials" -- a purchase and an
 *   authorization, neither of which is an engineering step.
 *
 * WHAT IS PROVEN IS THEREFORE EVERY RUNG UP TO THAT BOUNDARY, AND THE
 * BOUNDARY ITSELF. The last two tests PIN it: they fail the day a catalog or
 * a provider becomes configured, which is the day this journey can be
 * extended to an operable player and the day somebody needs to be told to
 * extend it. A pin that fails on success is the opposite of a test that
 * quietly stops meaning anything.
 *
 * ==========================================================================
 * WHAT IT DOES NOT DO
 * ==========================================================================
 *
 * It disables nothing. CONTENT_RIGHTS_ENFORCEMENT stays strict, the identity
 * system is the real one, the session is a real row in PostgreSQL, and no
 * address is constructed that the rights gate did not return. A journey that
 * passed because a control was switched off would prove the opposite of what
 * it claims.
 * ---------------------------------------------------------------------- */

test.describe.configure({ mode: "serial" });

/** The refusal an unauthenticated viewer meets: an account is missing. */
const NEEDS_AN_ACCOUNT = /sign in to watch this/i;

/** The refusal an AUTHENTICATED viewer meets: the deployment has no provider. */
const NEEDS_A_PROVIDER = /playback isn.t available on this deployment/i;

/**
 * Wait for the watch route to have decided something.
 *
 * The page is server-rendered as "Loading player…" and the decision arrives
 * on the client, so asserting immediately after `goto` would assert the
 * placeholder. Waiting on either OUTCOME rather than on a timeout means this
 * neither races nor sleeps, and a third outcome -- an actual player -- fails
 * the `expect` below rather than hanging.
 */
async function watchDecided(page: Page): Promise<string> {
  const main = page.locator("#main");
  await expect(main).toContainText(/sign in to watch this|playback isn.t available/i, {
    timeout: 15_000
  });
  return (await main.innerText()).replace(/\s+/g, " ").trim();
}

/** What the playback API answers, as the pair a reason trail is read from. */
async function playbackDecision(
  request: APIRequestContext,
  headers: SessionHeaders | Record<string, never>
): Promise<{ status: number; outcome: string; codes: string[] }> {
  const response = await request.post(`${BASE_URL}/api/v1/playback/session`, {
    headers: { ...headers, "content-type": "application/json" },
    data: sessionRequest(DEMO.movie.id),
    failOnStatusCode: false
  });
  const body = (await response.json()) as {
    outcome?: string;
    reasons?: { code?: string }[];
  };
  return {
    status: response.status(),
    outcome: body.outcome ?? "(none)",
    codes: (body.reasons ?? []).map((reason) => reason.code ?? "(none)")
  };
}

test.describe("a signed-in viewer, in a browser, on a production build", () => {
  test.skip(
    DATABASE_SESSION_SKIP_REASON !== null,
    DATABASE_SESSION_SKIP_REASON ??
      "this run has no identity system, so there is no sign-in to perform"
  );

  test("AN UNAUTHENTICATED VIEWER IS REFUSED FOR WANT OF AN ACCOUNT, and shown no player", async ({
    page
  }) => {
    /*
     * The fail-closed half, and the baseline the next test is measured
     * against. Asserted as a REFUSAL -- the page says what is missing and
     * offers the way in -- rather than as the absence of a player, because
     * "no player appeared" is also what a crashed route looks like.
     */
    await page.goto(`${BASE_URL}/watch/${DEMO.movie.id}`);
    const text = await watchDecided(page);
    expect(text).toMatch(NEEDS_AN_ACCOUNT);
    expect(text).not.toMatch(NEEDS_A_PROVIDER);
    await expect(page.locator("#main").getByRole("link", { name: /^sign in$/i })).toBeVisible();
    await expect(page.getByTestId("player-controls")).toHaveCount(0);
  });

  test("THE SAME ROUTE, SIGNED IN, GETS PAST THE ACCOUNT GATE -- which is the join", async ({
    page,
    request
  }) => {
    /*
     * THE WHOLE POINT OF THIS FILE. A real sign-up and sign-in through the
     * same two routes a human uses, carried into a BROWSER, against a
     * production build. Nothing in this suite did that before.
     *
     * The evidence that the gate was crossed is the CHANGE OF REFUSAL. The
     * playback API answers the same 503 to everybody on this deployment --
     * the provider check precedes the identity check -- so the API alone
     * cannot show that authentication did anything. The page can: an
     * anonymous viewer is told to sign in, and this one is told the
     * deployment has no provider, which is a sentence only reachable after
     * the account gate.
     */
    const headers = await establishSession(request);
    await page.setExtraHTTPHeaders(headers);

    await page.goto(`${BASE_URL}/watch/${DEMO.movie.id}`);
    const text = await watchDecided(page);

    expect(
      text,
      "a signed-in viewer was still asked to sign in, so the session established through the " +
        "API did not carry into the browser"
    ).not.toMatch(NEEDS_AN_ACCOUNT);
    expect(text).toMatch(NEEDS_A_PROVIDER);

    /* And the chrome agrees: the account is named where the shell shows it. */
    await expect(page.getByText(/signed in as/i)).toBeVisible();
  });

  test("the refusal NAMES ITS REASON rather than failing blankly", async ({ page, request }) => {
    /*
     * Product invariant 4: "playback decisions expose a reason trail
     * sufficient to debug candidate selection." A dead end that says nothing
     * sends a household to support and an operator to a log.
     */
    const headers = await establishSession(request);
    await page.setExtraHTTPHeaders(headers);
    await page.goto(`${BASE_URL}/watch/${DEMO.movie.id}`);
    await watchDecided(page);

    const main = (await page.locator("#main").innerText()).replace(/\s+/g, " ");
    expect(main).toMatch(/no authorized media provider is configured/i);
    /* It says whose fault it is NOT, which is the difference between an
     * honest refusal and one a viewer reads as their own mistake. */
    expect(main).toMatch(/configuration gap rather than a problem with this title/i);
  });

  test("THE BROWSER AND THE API AGREE ABOUT THIS DEPLOYMENT", async ({ request }) => {
    /*
     * The cross-check that makes the two halves one journey rather than two
     * coincidences. If the page ever reported a reason the route did not
     * give, one of them would be inventing it.
     */
    const headers = await establishSession(request);
    const authenticated = await playbackDecision(request, headers);
    expect(authenticated.status).toBe(503);
    expect(authenticated.outcome).toBe("unavailable");
    expect(authenticated.codes).toContain("provider_not_configured");
  });

  test("a signed-in viewer with no profile is sent to the PICKER, not to an error", async ({
    page,
    request
  }) => {
    /* A profile is a property of this browser rather than of the account, so
     * a fresh session has none. Being told to choose one is the correct next
     * step; an error would be a product that forgot its own model. */
    const headers = await establishSession(request);
    await page.setExtraHTTPHeaders(headers);
    await page.goto(`${BASE_URL}/watchlist`);
    await expect(page.locator("#main")).toContainText(/choose who is watching|choose a profile/i, {
      timeout: 15_000
    });
  });
});

test.describe("the boundary this journey stops at, pinned so it cannot be forgotten", () => {
  test.skip(
    DATABASE_SESSION_SKIP_REASON !== null,
    DATABASE_SESSION_SKIP_REASON ?? "this run has no identity system"
  );

  test("NO PROVIDER IS CONFIGURED -- and when one is, EXTEND THIS JOURNEY", async ({ request }) => {
    /*
     * A PIN THAT FAILS ON SUCCESS, deliberately. The day PL-0302 lands a
     * licensed provider, this assertion breaks and whoever broke it reads
     * this message. The alternative -- a journey that stops at the provider
     * boundary and never notices the boundary moved -- is how a test quietly
     * stops meaning what its name says.
     */
    const decision = await playbackDecision(request, await establishSession(request));
    expect(
      decision.codes,
      "This deployment now reaches a playback decision that is not " +
        "`provider_not_configured`, which means a media provider has been configured and the " +
        "journey above can finally go further than a refusal. EXTEND IT: a signed-in viewer " +
        "should now reach an authorized title, obtain a session through the ordinary route, " +
        "land on the player and operate a control, and THAT is what PL-0720 was written for. " +
        "Do not simply update this expectation."
    ).toContain("provider_not_configured");
  });

  test("NO CATALOG IS CONFIGURED -- and when one is, EXTEND THIS JOURNEY", async ({ page }) => {
    /*
     * The other half of the same boundary, and the one that keeps this file
     * honest about WHY it never reaches a title page with a real work on it.
     */
    expect(
      CATALOG_AVAILABILITY,
      "the harness no longer reports this production build as refusing its catalog; if a " +
        "metadata source is now configured, the journey above should reach a real title " +
        "rather than a fixture id, and this pin should be replaced by that assertion"
    ).toBe("refused");

    await page.goto(`${BASE_URL}/title/${DEMO.series.id}`);
    await expect(page.locator("#main")).toContainText(/no catalog|no metadata source/i, {
      timeout: 15_000
    });
  });
});
