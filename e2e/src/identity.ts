import type { APIRequestContext, APIResponse } from "@playwright/test";
import { AUTH_BASE_URL_FOR_SIGN_IN } from "./env";

/* -------------------------------------------------------------------------
 * Establishing a REAL signed-in session against the server under test
 * (PW-0312, gpt-architect's round-93 corrective)
 *
 * THE CLAUSE THIS FILE EXISTS FOR: "seeded or programmatically created verified
 * test account; sign-in/session establishment fixture; authenticated
 * cookie/header propagation into the relevant playback tests."
 *
 * PROGRAMMATICALLY CREATED, THROUGH THE APPLICATION'S OWN ENDPOINTS. The
 * account is made with POST /api/auth/sign-up/email and the session with POST
 * /api/auth/sign-in/email -- the same two routes a human uses, the same ones
 * `components/auth/auth-client.ts` calls. Nothing here writes to the database,
 * and nothing mints a cookie. A harness that inserted its own session row would
 * be testing a session this project's identity library never issued, and every
 * later assertion about "a signed-in caller" would be an assertion about the
 * harness.
 *
 * WHY A SEPARATE FILE FROM `fixtures.ts`. That one is about CONTENT -- demo
 * titles and device capability profiles. This is about IDENTITY. A file that
 * answered both would be the file nobody can state the purpose of, and the two
 * have different reasons to change.
 *
 * ---------------------------------------------------------------------------
 * THE ONE PRECONDITION THIS HARNESS RELAXES, STATED RATHER THAN BURIED
 * ---------------------------------------------------------------------------
 *
 * `playwright.config.ts` sets `LIBERTY_AUTH_REQUIRE_EMAIL_VERIFICATION=false`
 * on the server it starts for this axis. Without it, sign-up answers
 * `token: null` -- which is `requireEmailVerification` working exactly as
 * PW-0403 configured it -- and there are only two ways onward, both worse:
 *
 *   - a mail transport. The composition root REFUSES to fake one, deliberately,
 *     because a verification URL is a one-click account takeover and PW-0312's
 *     own acceptance forbids logging, displaying or otherwise exposing such a
 *     token to work around a missing transport. A harness that stood one up
 *     would be undoing the reason the placeholder throws.
 *   - a direct UPDATE on the `user` table. That needs a PostgreSQL driver this
 *     harness deliberately does not carry, and it would mean the suite reaching
 *     around the application it is measuring to set a fact the application owns.
 *
 * WHAT STAYS REAL, which is everything the playback cases actually measure: the
 * account row, the credential, the sign-in, the session row, the cookie, and
 * the verification of that cookie against the database on every subsequent
 * request. `createLibertyAuth` declines Better Auth's `cookieCache` (PL-0401),
 * so each request below is a real session read.
 *
 * The verification policy itself is not measured here and is not meant to be.
 * It is asserted where it belongs: `components/auth/auth-policy.ts` and
 * `auth-ui.test.tsx`.
 * ---------------------------------------------------------------------- */

/**
 * The account this harness signs in as.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, which is the same
 * reason `DEFAULT_FIXTURE_MEDIA_ORIGIN` uses it: no mail this suite could
 * accidentally cause to be sent has anywhere to go. The password is long enough
 * for `@liberty/auth`'s own minimum and is a throwaway for a loopback server
 * whose database is discarded with the run.
 */
/**
 * ONE ACCOUNT PER PLAYWRIGHT WORKER, NOT ONE PER RUN, and the reason is a
 * failure this harness actually produced rather than a precaution.
 *
 * With a single shared account, every worker raced to sign the same one up.
 * Serially the suite was green; in parallel one worker's sign-in failed
 * reproducibly and took the six tests behind its `beforeAll` with it. The
 * contended resource is a row, and the fix is not to retry until the contention
 * resolves -- `playwright.config.ts` sets `retries: 0` and states why -- it is
 * to stop contending. Per-worker accounts are independent by construction, so
 * there is no ordering between them to get wrong.
 *
 * `TEST_PARALLEL_INDEX` is Playwright's stable per-worker-slot index. Files that
 * share a worker share an account and run sequentially within it, which is fine:
 * what was racing was concurrent creation, not reuse.
 */
const WORKER = process.env["TEST_PARALLEL_INDEX"] ?? "0";

export const HARNESS_ACCOUNT = {
  email: `e2e-harness-${WORKER}@liberty.invalid`,
  password: "liberty-e2e-harness-password",
  name: `E2E Harness ${WORKER}`
} as const;

/** What a signed-in request carries. Spread into a Playwright `headers` bag. */
export type SessionHeaders = Readonly<Record<string, string>>;

/**
 * The `set-cookie` values Better Auth issued, as one `cookie` header.
 *
 * ALL OF THEM, NOT JUST THE ONE WHOSE NAME WE KNOW. Hard-coding
 * `better-auth.session_token` would be this harness asserting a cookie name the
 * library owns and may prefix differently under other configurations -- and the
 * failure mode is a suite that silently sends nothing and reports every
 * authenticated case as signed out.
 */
function cookieHeaderFrom(setCookie: readonly string[]): string | null {
  const pairs = setCookie
    .map((value) => value.split(";", 1)[0]?.trim())
    .filter((pair): pair is string => pair !== undefined && pair.includes("=") && !pair.endsWith("="));
  return pairs.length === 0 ? null : pairs.join("; ");
}

/**
 * Create the account if it is not there, sign in, and return the headers a
 * signed-in request carries.
 *
 * IDEMPOTENT ON SIGN-UP. Playwright workers run in parallel and each one calls
 * this; the second and later calls meet an account that already exists, which
 * the endpoint refuses. That refusal is expected and ignored -- what decides
 * success is the SIGN-IN below, because a session is what the caller asked for
 * and an account is only the way to get one.
 *
 * THROWS RATHER THAN RETURNING NULL on failure. A fixture that quietly handed
 * back empty headers would turn every authenticated case into a signed-out one
 * and report the whole set as passing, which is the failure this file would
 * most like to avoid being the cause of.
 */
/**
 * ONE SIGN-IN PER WORKER, MEMOISED AT MODULE SCOPE.
 *
 * Playwright gives each worker one module registry shared by every spec file it
 * runs, so this promise is created once per worker however many files call
 * `establishSession`. That is not an optimisation: four files each signing in
 * is four requests to a rate-limited endpoint within a second or two, and
 * Better Auth answered the fourth with 429. The limiter was right.
 */
let SESSION: Promise<SessionHeaders> | null = null;

const RATE_LIMITED = 429;

/**
 * How long to wait after a 429, from the server's own answer when it gives one.
 *
 * Better Auth sends `X-Retry-After` in seconds. A default is kept for the case
 * where it does not, and it is deliberately larger than the endpoint's 10-second
 * window is long rather than tuned to just clear it.
 */
function retryDelayMs(header: string | undefined): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 2_000;
}

/**
 * WHY THIS ONE WAIT IS NOT THE RETRY `playwright.config.ts` FORBIDS.
 *
 * That rule is about re-running a TEST until it passes, and it exists because a
 * retry converts an order-dependence defect into a green mark. This is neither:
 * a 429 is the server stating a protocol requirement -- "try again later" is
 * the literal body -- and obeying it is the correct client behaviour rather
 * than a second attempt at the same question. The number of attempts is small
 * and bounded, the failure after them is loud, and no ASSERTION is retried.
 *
 * The alternative would be to switch the rate limiter off for the harness
 * server, which would mean turning off a real security control in order to
 * measure a different one.
 */
const SIGN_IN_ATTEMPTS = 4;

/* -------------------------------------------------------------------------
 * PL-0715: A RATE-LIMITED SIGN-UP WAS BEING REPORTED AS A WRONG PASSWORD
 * -------------------------------------------------------------------------
 *
 * better-auth 1.7.5 enables rate limiting whenever the server is in
 * production -- `enabled: options.rateLimit?.enabled ?? isProduction` in
 * `dist/context/create-context.mjs` -- and `getDefaultSpecialRules` applies
 * THREE REQUESTS PER TEN SECONDS, per IP and path, to anything beginning
 * `/sign-in` or `/sign-up`. `packages/auth/src/better-auth.ts` passes no
 * `rateLimit` option, so that default is what the application runs with.
 *
 * Every Playwright worker shares one IP. The sign-up below was posted with
 * `failOnStatusCode: false` and its response was never read, so a refused
 * sign-up left no account, the sign-in that followed answered 401 -- correctly,
 * because better-auth does not distinguish an unknown user from a wrong
 * password -- and this function blamed the credentials. REPRODUCED: the full
 * suite in production mode at 4 workers against a real PostgreSQL, "the
 * harness could not sign in as e2e-harness-2@liberty.invalid: 401
 * INVALID_EMAIL_OR_PASSWORD".
 *
 * SIGN IN FIRST, so a database that already has this account costs one
 * request and no burst; create only if that fails; READ the creation's
 * answer; and obey a 429 on BOTH endpoints with the same bounded budget the
 * sign-in already had. The application's rate limiting is not touched -- it is
 * a security control, and a harness that trips it is the harness's problem.
 */
interface AuthAttempt {
  readonly what: string;
  readonly status: number;
  readonly body: string;
}

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
    const body = (await response.text()).slice(0, 300);
    log.push({ what: `${what} attempt ${attempt}`, status: response.status(), body });
    if (response.status() !== RATE_LIMITED || attempt === SIGN_IN_ATTEMPTS) return response;
    await new Promise((resolve) =>
      setTimeout(resolve, retryDelayMs(response.headers()["x-retry-after"]))
    );
  }
}

/** "Already exists" is a SUCCESS here: the account this harness needs is there. */
function alreadyExists(status: number, body: string): boolean {
  return /USER_ALREADY_EXISTS|already exists/i.test(body) || status === 422;
}

function describeAttempts(log: readonly AuthAttempt[]): string {
  return log.map((entry) => `${entry.what} -> ${entry.status} ${entry.body}`).join("; ");
}

async function signInOnce(request: APIRequestContext): Promise<SessionHeaders> {
  const origin = AUTH_BASE_URL_FOR_SIGN_IN;
  const log: AuthAttempt[] = [];
  const credentials = { email: HARNESS_ACCOUNT.email, password: HARNESS_ACCOUNT.password };

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
      HARNESS_ACCOUNT,
      "sign-up",
      log
    );
    const createdBody = log[log.length - 1]?.body ?? "";
    if (!created.ok() && !alreadyExists(created.status(), createdBody)) {
      throw new Error(
        `the harness could not CREATE ${HARNESS_ACCOUNT.email}, so nothing below is about a ` +
          "password: the account does not exist. " +
          (created.status() === RATE_LIMITED
            ? `The sign-up endpoint rate-limited all ${SIGN_IN_ATTEMPTS} attempts. better-auth ` +
              "applies 3 requests per 10 seconds per IP to /sign-up by default and enables it " +
              "in production only. This is a harness problem and must not be fixed by " +
              "weakening the application's limit. "
            : "") +
          describeAttempts(log)
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

  for (let once = 0; once < 1; once += 1) {
    if (signIn.ok()) {
      const cookie = cookieHeaderFrom(
        signIn
          .headersArray()
          .filter((header) => header.name.toLowerCase() === "set-cookie")
          .map((header) => header.value)
      );

      if (cookie === null) {
        throw new Error(
          "sign-in succeeded but set no cookie. Liberty uses DATABASE sessions (PL-0401), " +
            "so the cookie is the pointer to the row and there is no bearer token to fall " +
            "back on."
        );
      }

      return { cookie };
    }
  }

  /* The account exists -- created above or already there -- so this is a real
   * sign-in failure, which is now a claim this function has earned. */
  throw new Error(
    `the harness could not sign in as ${HARNESS_ACCOUNT.email} even though the account ` +
      "exists. The server under test was started with an identity system (see src/env.ts's " +
      "IDENTITY_MECHANISM), so this is a real failure rather than a missing configuration. " +
      `Attempts: ${describeAttempts(log)}`
  );
}

export function establishSession(request: APIRequestContext): Promise<SessionHeaders> {
  SESSION = SESSION ?? signInOnce(request);
  return SESSION;
}
