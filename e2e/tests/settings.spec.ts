import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

import { isRecord } from "../src/contract";
import { AUTH_BASE_URL_FOR_SIGN_IN, DATABASE_SESSION_SKIP_REASON } from "../src/env";

/* -------------------------------------------------------------------------
 * The settings screen (PW-0308)
 *
 * ==========================================================================
 * WHY THIS FILE EXISTS AND WHY IT HAS TO BE A BROWSER
 * ==========================================================================
 *
 * The acceptance's first REQUIRED clause is "preferred audio and subtitle
 * languages, PERSISTED PER PROFILE", and gpt-architect's round-110 instruction
 * for this task says it in the negative: "Do not fake persistence with local
 * component state." The only thing that tells persistence from component state
 * is a RELOAD, and `apps/web` runs vitest in a node environment with no DOM,
 * no fetch and no effects -- it cannot load the form, let alone save it and
 * ask for it again. `components/settings/settings.test.tsx` says so in its own
 * header and leaves this half here deliberately.
 *
 * ==========================================================================
 * WHAT THIS FILE DOES NOT CLAIM
 * ==========================================================================
 *
 * It does not assert that a stored language changes which audio track plays.
 * Nothing in this deployment has a multi-audio title to play -- the e2e
 * catalog is fixtures -- so a harness that reported an audible outcome would
 * be reporting an inference. What the stored preference actually reaches is
 * the playback SESSION REQUEST, and `apps/web/src/app/watch/watch-session.
 * test.ts` proves that end directly and deterministically: five cases over the
 * three states (`null`, a list, the empty list), with the request body parsed
 * by the route's own `.strict()` schema. The two halves meet at the page,
 * which calls `loadMediaPreferences` and hands the answer down.
 *
 * ==========================================================================
 * TWO GROUPS, BECAUSE TWO OF THESE SECTIONS NEED NOBODY AND ONE NEEDS A ROW
 * ==========================================================================
 *
 * Diagnostics and About are facts about THIS BUILD and are true in every
 * configuration, signed in or not. The language form needs a profile, which
 * needs an identity system and a database, so its group skips with a stated
 * reason rather than silently passing in a configuration that cannot hold it.
 * ---------------------------------------------------------------------- */

const SETTINGS = "/settings";
const PROFILES = "/api/v1/profiles";
const SELECTION = "/api/v1/profiles/selection";
const PREFERENCES = "/api/v1/profiles/preferences";

/* -------------------------------------------------------------------------
 * A. The sections that are true whatever the configuration
 * ---------------------------------------------------------------------- */

test.describe("facts about this build, which no sign-in changes", () => {
  test("the About section names the version package.json declares", async ({ page }) => {
    /*
     * READ FROM THE REAL FILE, NOT WRITTEN DOWN HERE. A literal would be a
     * third copy of a number that changes every release -- after the manifest
     * and the component -- and the copy that rotted would be the one failing
     * a gate for a reason that had nothing to do with the product.
     */
    const manifest: unknown = JSON.parse(
      /* `__dirname` rather than `import.meta.url`: `e2e/tsconfig.json`
       * compiles to CommonJS, where the meta-property is not available. */
      await readFile(path.resolve(__dirname, "../../apps/web/package.json"), "utf8")
    );
    const version = isRecord(manifest) ? manifest["version"] : undefined;
    expect(typeof version, "apps/web/package.json declares no version").toBe("string");

    await page.goto(SETTINGS);

    await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
    await expect(page.getByTestId("about-version")).toHaveText(String(version));
  });

  test("it names the notices file without claiming this install carries it", async ({ page }) => {
    /*
     * PW-0208 is the task that proves a packaged tree really carries
     * THIRD-PARTY-NOTICES.md, and it is still in review because inspecting a
     * real package is the hard part. A screen that cheerfully reported a
     * notices file it had never looked for would make the attribution problem
     * worse rather than better, so the hedge is part of the deliverable and is
     * asserted as such.
     */
    await page.goto(SETTINGS);

    await expect(page.getByText("THIRD-PARTY-NOTICES.md")).toBeVisible();
    await expect(page.getByText(/does not inspect your installation/i)).toBeVisible();
  });

  test("the diagnostics section states what this build would do, with its reasons", async ({
    page
  }) => {
    /*
     * THE SECTION'S WHOLE POINT IS THAT IT CANNOT DRIFT: it renders what
     * `decidePlaybackTelemetry` returns, codes and all. This asserts the codes
     * reached the page rather than a paragraph about them, and that the
     * collector path is named -- a viewer told diagnostics are "sent securely"
     * learns nothing; a viewer shown the path can check it.
     */
    await page.goto(SETTINGS);

    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
    await expect(page.getByText(/^\/api\//)).toBeVisible();

    /* A reason code is `lower_snake_case` in parentheses; at least one is
     * always produced, because the decision always has something to say. */
    await expect(page.getByText(/\([a-z][a-z_]+\)/).first()).toBeVisible();
  });

  test("offers no switch that could weaken a security or rights control", async ({ page }) => {
    /*
     * THE ACCEPTANCE'S LAST REQUIRED CLAUSE, ASSERTED AT THE SCREEN: "there is
     * no 'allow insecure sources' switch and no way to disable the transport
     * checks". Checked as an absence of the VOCABULARY rather than of a
     * particular control id, because the defect would arrive under a name
     * nobody has chosen yet.
     */
    await page.goto(SETTINGS);
    const text = (await page.locator("body").innerText()).toLowerCase();

    for (const forbidden of [
      "allow insecure",
      "disable transport",
      "skip verification",
      "ignore certificate",
      "developer mode",
      "unsafe"
    ]) {
      expect(text, `the settings screen offers "${forbidden}"`).not.toContain(forbidden);
    }
    /* Non-vacuity: the page under those assertions is the real one. */
    expect(text).toContain("diagnostics");
  });
});

/* -------------------------------------------------------------------------
 * B. The language form, against a real session and a real database
 *
 * ITS OWN ACCOUNT, NOT `src/identity.ts`'s. That helper memoises ONE session
 * per worker and shares it with the playback specs, and this group SELECTS A
 * PROFILE -- server-side state those specs did not ask for. `watchlist.spec.
 * ts` made the same call for the same reason and records that the shared form
 * of this belongs in `src/identity.ts`, in a task that owns that file. This is
 * not that task, so the duplication is deliberate and named rather than
 * smuggled in by widening a surface.
 * ---------------------------------------------------------------------- */

const WORKER = process.env["TEST_PARALLEL_INDEX"] ?? "0";
const RATE_LIMITED = 429;
const SIGN_IN_ATTEMPTS = 4;

const ACCOUNT = {
  email: `e2e-settings-${WORKER}@liberty.invalid`,
  password: "liberty-e2e-settings-password",
  name: `E2E Settings ${WORKER}`
} as const;

interface AuthAttempt {
  readonly what: string;
  readonly status: number;
  readonly body: string;
}

function retryDelayMs(header: string | undefined): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 2_000;
}

/**
 * One auth POST, retried only while the server says it is throttling.
 *
 * NOT A GENERAL RETRY. `playwright.config.ts` sets `retries: 0` and says this
 * repository "treats determinism as correctness"; re-sending on any other
 * status would be exactly the kind of retry that hides a defect. 429 is
 * different: it is the server stating a wait, and better-auth's own
 * `X-Retry-After` says how long. Every worker shares one client IP, so three
 * sign-ins per ten seconds is reached by arithmetic rather than by anything
 * being wrong.
 */
async function postAuth(
  request: APIRequestContext,
  url: string,
  data: unknown,
  what: string,
  log: AuthAttempt[]
): Promise<APIResponse> {
  const origin = AUTH_BASE_URL_FOR_SIGN_IN;
  for (let attempt = 1; ; attempt += 1) {
    const response = await request.post(url, {
      headers: { "content-type": "application/json", origin },
      data,
      failOnStatusCode: false
    });
    log.push({
      what: `${what} attempt ${attempt}`,
      status: response.status(),
      body: (await response.text()).slice(0, 300)
    });
    if (response.status() !== RATE_LIMITED || attempt === SIGN_IN_ATTEMPTS) return response;
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs(response.headers()["x-retry-after"]))
    );
  }
}

function cookieFrom(response: APIResponse): string | null {
  const pairs = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => header.value.split(";")[0])
    .filter((pair): pair is string => pair !== undefined && pair.length > 0);
  return pairs.length === 0 ? null : pairs.join("; ");
}

let SESSION: Promise<Readonly<Record<string, string>>> | null = null;

async function signInOnce(
  request: APIRequestContext
): Promise<Readonly<Record<string, string>>> {
  const origin = AUTH_BASE_URL_FOR_SIGN_IN;
  const log: AuthAttempt[] = [];
  const credentials = { email: ACCOUNT.email, password: ACCOUNT.password };

  /* SIGN IN FIRST. On a re-run against a database that already carries this
   * account -- which is every re-run -- this is the only request made, and the
   * sign-up that would contend for the same bucket never happens. */
  let signIn = await postAuth(
    request,
    `${origin}/api/auth/sign-in/email`,
    credentials,
    "sign-in before sign-up",
    log
  );

  if (!signIn.ok()) {
    const created = await postAuth(
      request,
      `${origin}/api/auth/sign-up/email`,
      ACCOUNT,
      "sign-up",
      log
    );
    const body = log[log.length - 1]?.body ?? "";
    const exists = /USER_ALREADY_EXISTS|already exists/i.test(body) || created.status() === 422;
    if (!created.ok() && !exists) {
      throw new Error(
        `the harness could not CREATE ${ACCOUNT.email}, so no credential failure below is ` +
          `about a password: the account does not exist. Attempts: ` +
          log.map((entry) => `${entry.what} -> ${entry.status} ${entry.body}`).join("; ")
      );
    }
    signIn = await postAuth(
      request,
      `${origin}/api/auth/sign-in/email`,
      credentials,
      "sign-in after sign-up",
      log
    );
  }

  const cookie = signIn.ok() ? cookieFrom(signIn) : null;
  if (cookie === null) {
    throw new Error(
      `the harness could not establish a session as ${ACCOUNT.email}. Liberty uses DATABASE ` +
        "sessions (PL-0401), so the cookie is the pointer to the row and there is no bearer " +
        "token to fall back on. Attempts: " +
        log.map((entry) => `${entry.what} -> ${entry.status} ${entry.body}`).join("; ")
    );
  }
  return { cookie };
}

function session(request: APIRequestContext): Promise<Readonly<Record<string, string>>> {
  SESSION = SESSION ?? signInOnce(request);
  return SESSION;
}

/**
 * Reuse a profile if the household has one, create one otherwise, select it.
 *
 * The reuse is not an optimisation: display names are unique across a
 * household INCLUDING archived profiles, deliberately, so a run that created a
 * fresh one each time would meet `display_name_already_used` on its second
 * execution against the same database -- and "fix" it by leaving a household
 * one profile per CI build. Selection is always a separate call, because
 * creating a profile does not select it and a profile left over from a
 * previous run is not necessarily this session's.
 */
async function selectAProfile(
  request: APIRequestContext,
  headers: Readonly<Record<string, string>>
): Promise<void> {
  const listed: unknown = await (await request.get(PROFILES, { headers })).json();
  const already = isRecord(listed) && Array.isArray(listed["profiles"]) ? listed["profiles"] : [];
  const reusable = already
    .map((entry) => (isRecord(entry) ? entry["id"] : undefined))
    .find((id): id is string => typeof id === "string");

  let profileId: string;
  if (reusable !== undefined) {
    profileId = reusable;
  } else {
    const created = await request.post(PROFILES, {
      headers,
      data: { displayName: "E2E settings viewer", avatarKey: null, maxRating: null }
    });
    const body: unknown = await created.json();
    const profile = isRecord(body) && isRecord(body["profile"]) ? body["profile"] : {};
    expect(typeof profile["id"], await created.text()).toBe("string");
    profileId = String(profile["id"]);
  }

  const selected = await request.post(SELECTION, { headers, data: { profileId } });
  const body: unknown = await selected.json();
  expect(isRecord(body) && body["outcome"], await selected.text()).toBe("selected");
}

/** Put this profile back to "has not chosen", so a test starts where it meant to. */
async function forgetPreferences(
  request: APIRequestContext,
  headers: Readonly<Record<string, string>>
): Promise<void> {
  const response = await request.delete(PREFERENCES, { headers });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * The Languages section, as a container to look inside.
 *
 * SCOPED, AND NOT FOR TIDINESS. `page.getByRole("alert")` matched TWO
 * elements on a later run of this file: the form's own refusal, and Next's
 * `__next-route-announcer__`, which is a `role="alert"` live region the
 * framework inserts and which is empty most of the time. Playwright's strict
 * mode failed the case, correctly -- an unscoped alert query was asserting
 * "some alert exists", which is not what this test means, and it passed the
 * first time only because of when the announcer happened to be in the DOM.
 * An order-dependent assertion is a CI failure waiting for a different
 * machine.
 */
function languages(page: Page) {
  return page.locator('section[aria-labelledby="settings-languages"]');
}

function audioField(page: Page) {
  return page.getByLabel("Preferred audio languages");
}

function subtitleField(page: Page) {
  return page.getByLabel("Preferred subtitle languages");
}

test.describe("the language form, against a real session and a real database", () => {
  test.skip(() => DATABASE_SESSION_SKIP_REASON !== null, DATABASE_SESSION_SKIP_REASON ?? "");

  test("a choice survives a reload, which is what tells persistence from state", async ({
    page
  }) => {
    const headers = await session(page.request);
    await selectAProfile(page.request, headers);
    await forgetPreferences(page.request, headers);
    await page.setExtraHTTPHeaders(headers);

    await page.goto(SETTINGS);

    /* IT STARTS AS "NOT CHOSEN", which the delete above made true rather than
     * assumed. A test that began from whatever the last run left would prove
     * nothing about the save. */
    await expect(page.getByText(/have not chosen yet/i)).toBeVisible();
    await expect(audioField(page)).toHaveValue("");

    await audioField(page).fill("ja, en");
    await subtitleField(page).fill("en");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText(/these are your choices/i)).toBeVisible();

    /*
     * THE RELOAD IS THE TEST. Everything before it would pass against a
     * component that remembered the typing and never spoke to a server, which
     * is the thing this task was told not to build.
     */
    await page.reload();

    await expect(audioField(page)).toHaveValue("ja, en");
    await expect(subtitleField(page)).toHaveValue("en");
    await expect(page.getByText(/these are your choices/i)).toBeVisible();
  });

  test("the order is kept, because the order is the preference", async ({ page }) => {
    /*
     * The contract says the list is "most-preferred first. Order is meaningful,
     * not a set". A store that round-tripped the MEMBERSHIP would satisfy a
     * careless test and hand the media engine a different answer, so this one
     * saves a deliberately non-alphabetical order and reads it back.
     */
    const headers = await session(page.request);
    await selectAProfile(page.request, headers);
    await forgetPreferences(page.request, headers);
    await page.setExtraHTTPHeaders(headers);

    await page.goto(SETTINGS);
    await audioField(page).fill("pt-BR, ja, en");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/these are your choices/i)).toBeVisible();

    await page.reload();
    await expect(audioField(page)).toHaveValue("pt-BR, ja, en");
  });

  test("clearing is not the same as leaving the lists empty", async ({ page }) => {
    /*
     * BOTH STATES HAVE EMPTY LISTS AND THEY MEAN OPPOSITE THINGS. A viewer who
     * saved two empty lists told playback not to prefer any language; a viewer
     * who cleared has no stored row and gets the product's default. The API
     * carries `stored` precisely so the screen can tell them apart, and this
     * is the test that makes the flag load-bearing rather than decorative.
     */
    const headers = await session(page.request);
    await selectAProfile(page.request, headers);
    await forgetPreferences(page.request, headers);
    await page.setExtraHTTPHeaders(headers);

    await page.goto(SETTINGS);

    /* First: CHOOSE NOTHING, deliberately, and reload. */
    await audioField(page).fill("");
    await subtitleField(page).fill("");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/these are your choices/i)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/these are your choices/i)).toBeVisible();
    await expect(audioField(page)).toHaveValue("");

    /* Then: CLEAR, and reload. Same empty fields, different sentence. */
    await page.getByRole("button", { name: /clear my choices/i }).click();
    await expect(page.getByText(/have not chosen yet/i)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/have not chosen yet/i)).toBeVisible();
    await expect(audioField(page)).toHaveValue("");
  });

  test("a language tag the contract refuses is reported, not silently dropped", async ({
    page
  }) => {
    /*
     * The endpoint owns what a language tag is, and the screen's job is to
     * show the refusal rather than to pre-empt it with a second validator the
     * viewer can never see the message from. This also pins that a refused
     * write does not render as a success, which is the shape of defect this
     * repository's harnesses have now caught five times.
     */
    const headers = await session(page.request);
    await selectAProfile(page.request, headers);
    await forgetPreferences(page.request, headers);
    await page.setExtraHTTPHeaders(headers);

    await page.goto(SETTINGS);
    await audioField(page).fill("english");
    await page.getByRole("button", { name: "Save" }).click();

    const refusal = languages(page).getByRole("alert");
    await expect(refusal).toBeVisible();
    /*
     * AND IT IS THE ENDPOINT'S OWN REASON, not any message the component
     * might show. The contract's `language_tag_unusable` is the one a viewer
     * can cause by typing and the one a UI must explain, so the text that
     * reaches the screen has to be that one rather than a generic failure.
     */
    await expect(refusal).toContainText(/BCP-47 language tag/i);
    await expect(page.getByText(/these are your choices/i)).toHaveCount(0);

    /* AND NOTHING WAS STORED. The alert could be shown by a client that wrote
     * anyway; the reload is what proves it did not. */
    await page.reload();
    await expect(page.getByText(/have not chosen yet/i)).toBeVisible();
  });

  test("a viewer who is not signed in is offered the way in, not a dead form", async ({ page }) => {
    /*
     * No session headers are set at all, so this is the signed-out branch of
     * the page rather than a simulated one. The panel carries `/settings` as
     * where to come back to -- a form a signed-out viewer could fill in and
     * never save would be worse than no form.
     */
    await page.goto(SETTINGS);

    await expect(page.getByRole("heading", { name: /sign in to/i })).toBeVisible();
    await expect(audioField(page)).toHaveCount(0);

    /* AND THE BUILD FACTS ARE STILL THERE. Hiding an attribution obligation
     * behind a sign-in would withhold it from the person least able to go
     * looking for it. */
    await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
  });
});
