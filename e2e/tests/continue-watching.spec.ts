import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { isRecord } from "../src/contract";
import {
  CATALOG_AVAILABILITY,
  IDENTITY_MECHANISM,
  UNKNOWN_CATALOG_SKIP_REASON,
  WEB_MODE
} from "../src/env";
import { DEMO, developmentIdentity, type DevelopmentIdentity } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * The continue-watching rail, which has never worked (PW-0313, for PW-0305)
 *
 * WHY A TASK ABOUT THE STORAGE ADAPTER IS WRITING A SPEC FOR SOMEBODY ELSE'S
 * FEATURE. PW-0305 shipped the rail and was marked DONE. It did not work: on
 * any build with no `DATABASE_URL`, Next compiles the React Server Components
 * graph and the route-handler graph separately, the in-memory store was a
 * module-level binding, and so a progress row written through
 * `/api/v1/progress/:id` was invisible to `loadContinueWatching`. The rail
 * answered `unavailable` and rendered NOTHING -- which is its documented
 * behaviour for a refusal, so there was no error, no empty state and no reason
 * code. A developer saw a product with no continue-watching and nothing to
 * explain it.
 *
 * It survived its own review because nothing could see it. The unit suite
 * tests `selectContinueWatching` against rows handed to it directly;
 * `progress.api.spec.ts` is route-handler-to-route-handler and says so in
 * terms ("IT IS NOT REACHED THROUGH THE UI, AND THAT IS STATED RATHER THAN
 * FAKED"); and `critical-journey.spec.ts` has no progress leg for the same
 * reason. There was no test anywhere that wrote progress and then LOOKED AT
 * THE PAGE, and that is the single test that would have caught it.
 *
 * This is that test. gpt-architect's round-101 ruling required it by name:
 * "PW-0305 continue-watching rail gets an end-to-end regression."
 *
 * WHAT IT DOES NOT COVER. The rail's own policy -- the finished tail, the
 * resumable minimum, the fraction -- belongs to `lib/continue-watching.test.ts`
 * and is not re-asserted here; this file would pass with those constants set
 * to anything. What it pins is the thing no unit test can: that a write
 * through the API is visible to a server component rendering in the same
 * process.
 * ---------------------------------------------------------------------- */

test.beforeEach(() => {
  test.info().annotations.push({ type: "web-mode", description: WEB_MODE });
  test.info().annotations.push({ type: "identity-mechanism", description: IDENTITY_MECHANISM });
});

const PROFILES = "/api/v1/profiles";
const SELECTION = "/api/v1/profiles/selection";

/**
 * Why this file can only run on a development build, stated rather than left
 * as a bare `test.skip`.
 *
 * It needs an identity (a rail is per-profile), a catalog (the rail renders a
 * `CatalogCard` and resolves the title through the metadata source), and the
 * in-memory adapter (which is the configuration the defect existed in). A
 * production run has the catalog refused by design, so there would be no card
 * to find even with a database.
 */
const SKIP_REASON: string | null =
  IDENTITY_MECHANISM === "development-headers"
    ? null
    : "The rail needs a profile AND a catalog in one build, which is the development " +
      "configuration. A production run refuses the catalog metadata source by design, so the " +
      "rail has nothing to render whatever the storage is. Set LIBERTY_E2E_WEB_MODE=development.";

async function selectAProfile(
  request: APIRequestContext,
  identity: DevelopmentIdentity
): Promise<void> {
  const created = await request.post(PROFILES, {
    headers: identity.headers,
    data: { displayName: "E2E viewer", avatarKey: null, maxRating: null }
  });
  const createdBody: unknown = await created.json();
  expect(isRecord(createdBody) && createdBody["outcome"], await created.text()).toBe("created");

  const profile =
    isRecord(createdBody) && isRecord(createdBody["profile"]) ? createdBody["profile"] : {};
  const profileId = profile["id"];
  expect(typeof profileId, "the created profile carries no id").toBe("string");

  const selected = await request.post(SELECTION, {
    headers: identity.headers,
    data: { profileId: String(profileId) }
  });
  const selectedBody: unknown = await selected.json();
  expect(isRecord(selectedBody) && selectedBody["outcome"], await selected.text()).toBe("selected");
}

/**
 * Record a resume point through the API the player would use.
 *
 * TWO CALLS, AND THE LEASE IS NOT CEREMONY. `progressWriteRequestSchema`
 * requires `lease: { epoch, writerId }`, and the epoch has to be one the
 * server issued -- that is the writer-epoch rule PL-0403 exists for, and a
 * test that invented an epoch would be asserting against a path the product
 * refuses. So the lease is taken first and its epoch is echoed back.
 */
async function recordProgress(
  request: APIRequestContext,
  identity: DevelopmentIdentity,
  contentId: string,
  positionSeconds: number,
  runtimeSeconds: number
): Promise<void> {
  const leased = await request.post(`/api/v1/progress/${contentId}/lease`, {
    headers: identity.headers,
    data: { writerId: "e2e-continue-watching" }
  });
  const leaseBody: unknown = await leased.json();
  expect(isRecord(leaseBody) && leaseBody["outcome"], await leased.text()).toBe("leased");
  const lease = isRecord(leaseBody) && isRecord(leaseBody["lease"]) ? leaseBody["lease"] : {};
  const epoch = lease["epoch"];
  expect(typeof epoch, "the lease carries no epoch").toBe("number");

  const written = await request.put(`/api/v1/progress/${contentId}`, {
    headers: identity.headers,
    data: {
      lease: { epoch, writerId: "e2e-continue-watching" },
      writeSeq: 1,
      positionSeconds,
      runtimeSeconds
    }
  });
  const writeBody: unknown = await written.json();
  expect(isRecord(writeBody) && writeBody["outcome"], await written.text()).toBe("written");
}

function rail(page: Page) {
  return page.getByRole("region", { name: "Continue watching" });
}

test.describe("a viewer returns and the rail shows what they were watching", () => {
  test.skip(() => SKIP_REASON !== null, SKIP_REASON ?? "");
  test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

  test("a profile that has watched nothing gets no rail at all", async ({ page }) => {
    /*
     * THE PRECONDITION, AND IT IS NOT A FORMALITY. Before PW-0313 the rail was
     * absent in EVERY case, so the positive test below would have been the
     * only thing separating "fixed" from "still broken" -- and a test suite
     * whose negative case is also its broken case cannot tell them apart. This
     * establishes that absence here means absence, so presence below means
     * presence.
     */
    const identity = developmentIdentity("cw-empty");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity);

    await page.goto("/");
    /* The browse rails ARE there, so this is not a page that failed to
     * render. */
    await expect(page.getByRole("region", { name: "Films" })).toBeVisible();
    await expect(rail(page)).toHaveCount(0);
  });

  test("PROGRESS WRITTEN THROUGH THE API IS ON THE PAGE -- the regression PW-0313 fixed", async ({
    page
  }) => {
    /*
     * THE WHOLE POINT OF THIS FILE, and the exact sequence that failed before
     * PW-0313: a route handler writes, a SERVER COMPONENT reads. On the old
     * code the final assertion found nothing, with no error anywhere.
     *
     * 600 of 7680 seconds is comfortably `resumable` -- past
     * RESUMABLE_MINIMUM_SECONDS, nowhere near FINISHED_FRACTION or the
     * finished tail -- so a failure here is about visibility rather than about
     * the rail's policy.
     */
    const identity = developmentIdentity("cw-resume");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity);
    await recordProgress(page.request, identity, DEMO.movie.id, 600, 7680);

    await page.goto("/");

    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByRole("heading", { name: DEMO.movie.title })).toBeVisible();
  });

  test("the card on the rail carries what a resume card carries and nothing else does", async ({
    page
  }) => {
    /*
     * That it is the RESUME rendering of the card, not merely the title
     * appearing somewhere. `CatalogCard` draws the progress indicator and the
     * start-over link only when it is given a `resume` prop, so their presence
     * is evidence the rail passed one -- which it can only do from a row it
     * actually read.
     */
    const identity = developmentIdentity("cw-card");
    await page.setExtraHTTPHeaders(identity.headers);
    await selectAProfile(page.request, identity);
    await recordProgress(page.request, identity, DEMO.movie.id, 600, 7680);

    await page.goto("/");

    const card = rail(page).locator("article.card").filter({ hasText: DEMO.movie.title });
    await expect(card).toHaveCount(1);

    /* The spoken half of the indicator, which is the half a test can read
     * without asserting a pixel width. 600/7680 is 7%. */
    await expect(card.getByText(/\d+% watched/)).toBeVisible();

    /* Start over is a LINK carrying the restart parameter, not a control that
     * writes anything -- `lib/continue-watching.ts` argues that at length and
     * this is the assertion that keeps it true. */
    await expect(card.getByRole("link", { name: "Start over" })).toHaveAttribute(
      "href",
      `/watch/${DEMO.movie.id}?restart=1`
    );
  });

  test("one household's resume point is not another's", async ({ page }) => {
    /*
     * A PROCESS-GLOBAL STORE IS SHARED STATE, and the first question to ask of
     * shared state is whether it leaked. PW-0313 made every module graph in
     * one process read the same maps; it must NOT have made every profile read
     * the same rows. The scoping is the repository's and predates this task --
     * which is exactly why it is worth one assertion now that the store is
     * shared more widely than it was.
     */
    const watcher = developmentIdentity("cw-mine");
    await page.setExtraHTTPHeaders(watcher.headers);
    await selectAProfile(page.request, watcher);
    await recordProgress(page.request, watcher, DEMO.movie.id, 600, 7680);

    await page.goto("/");
    await expect(rail(page)).toBeVisible();

    const stranger = developmentIdentity("cw-theirs");
    await page.setExtraHTTPHeaders(stranger.headers);
    await selectAProfile(page.request, stranger);

    await page.goto("/");
    await expect(page.getByRole("region", { name: "Films" })).toBeVisible();
    await expect(rail(page), "another household's viewing reached this profile").toHaveCount(0);
  });
});
