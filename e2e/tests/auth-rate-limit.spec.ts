import { expect, test } from "@playwright/test";

import {
  CREDENTIAL_RATE_LIMIT,
  RATE_LIMITED_STATUS,
  RETRY_AFTER_HEADER,
  classifyAuthRefusal,
  rateLimitFor
} from "../../packages/auth/src/rate-limit";
import { AUTH_BASE_URL_FOR_SIGN_IN, DATABASE_SESSION_SKIP_REASON } from "../src/env";

/* -------------------------------------------------------------------------
 * The credential endpoint is throttled, and a throttled refusal is not a
 * wrong password (PL-0719)
 *
 * ==========================================================================
 * WHAT THIS PROVES THAT A UNIT TEST CANNOT
 * ==========================================================================
 *
 * `packages/auth/src/rate-limit.ts` states the policy and
 * `rate-limit.test.ts` checks what it SAYS. Neither can check that a running
 * server refuses the fourth attempt, because the enforcement is inside
 * `better-auth` and the whole point of this task is that the enforcement was
 * the library's and nobody here had written down what it did. A test that
 * asserted our own constants against our own constants would be this
 * repository agreeing with itself.
 *
 * So this file does the one thing only a real server can do: it presents a
 * credential more times than the policy allows and reads what comes back.
 *
 * ==========================================================================
 * IT WRITES NOTHING AND CREATES NOTHING
 * ==========================================================================
 *
 * Every request below is a SIGN-IN with an address that does not exist and a
 * password that is not anybody's. No account is created, no row is written,
 * no existing account is touched, and no password is ever guessed correctly --
 * the refusals are the subject, not a side effect. Sign-UP is governed by the
 * same rule and is deliberately not exercised, because exercising it would
 * mean creating accounts to prove a point about refusals.
 *
 * ==========================================================================
 * IT PUTS THE BUCKET BACK, WHICH IS NOT POLITENESS
 * ==========================================================================
 *
 * The limiter keys by client IP and path, and every Playwright worker in this
 * suite shares one IP. Exhausting `/sign-in/email` therefore exhausts it for
 * the watchlist specs too, which sign in for real -- and PL-0715 exists
 * because a throttled sign-up in exactly that situation was misread as a
 * product failure. Draining the window before this file finishes is what
 * stops this test from manufacturing the defect it was written about.
 * ---------------------------------------------------------------------- */

test.describe.configure({ mode: "serial" });

/** The path the limiter sees, relative to the auth base path. */
const SIGN_IN_PATH = "/sign-in/email";

/** One more than the policy allows, so the last one must be refused. */
const ATTEMPTS = CREDENTIAL_RATE_LIMIT.maxRequests + 1;

/**
 * An address nobody has registered, with a password nobody set.
 *
 * `.invalid` is reserved by RFC 2606 and can never be delivered to, which is
 * the same reason the rest of this suite uses it. Unique per run so a
 * previous run cannot have left anything behind that would change the answer.
 */
function nobody(): { email: string; password: string } {
  return {
    email: `e2e-rate-limit-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}@liberty.invalid`,
    password: "not-anybody-s-password-and-never-will-be"
  };
}

test.describe("the credential endpoint under repeated attempts", () => {
  test.skip(
    DATABASE_SESSION_SKIP_REASON !== null,
    DATABASE_SESSION_SKIP_REASON ??
      "this run has no identity system, so there is no credential endpoint to throttle"
  );

  test.afterAll(async () => {
    /*
     * Wait out the window so the next spec file finds an empty bucket. A
     * second of margin because the window is measured from the last request
     * and the clock here is not the server's.
     */
    await new Promise((resolve) =>
      setTimeout(resolve, (CREDENTIAL_RATE_LIMIT.windowSeconds + 1) * 1000)
    );
  });

  test("THE FOURTH ATTEMPT IS REFUSED AS THROTTLED, NOT AS A WRONG PASSWORD", async ({
    request
  }) => {
    const account = nobody();
    const seen: { status: number; retryAfter: string | null }[] = [];

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const response = await request.post(`${AUTH_BASE_URL_FOR_SIGN_IN}/api/auth${SIGN_IN_PATH}`, {
        data: { email: account.email, password: account.password },
        headers: { "content-type": "application/json" },
        failOnStatusCode: false
      });
      seen.push({
        status: response.status(),
        retryAfter: response.headers()[RETRY_AFTER_HEADER.toLowerCase()] ?? null
      });
    }

    const classified = seen.map((entry) => classifyAuthRefusal(entry.status));

    /*
     * NOTHING SUCCEEDED, asserted first. If any attempt had been accepted the
     * rest of this test would be measuring something else entirely, and a
     * 200 here would be a far larger finding than a missing rate limit.
     */
    expect(
      seen.filter((entry) => entry.status < 400),
      `an attempt with an unregistered address and an invented password was ACCEPTED: ${JSON.stringify(seen)}`
    ).toEqual([]);

    /*
     * THE WHOLE CLAIM. Both kinds of refusal appear, in that order: the
     * credential is examined and rejected until the bucket empties, and then
     * the request is refused without the credential being examined at all.
     */
    expect(
      classified,
      `expected credential rejections followed by a throttled refusal, got ${JSON.stringify(seen)}`
    ).toContain("credential_rejected");
    expect(
      classified,
      `after ${String(ATTEMPTS)} attempts in one window the endpoint was never throttled. The ` +
        `policy in packages/auth/src/rate-limit.ts says ${String(CREDENTIAL_RATE_LIMIT.maxRequests)} ` +
        `requests per ${String(CREDENTIAL_RATE_LIMIT.windowSeconds)}s; the server disagrees. ` +
        `Responses: ${JSON.stringify(seen)}`
    ).toContain("rate_limited");

    /* The throttled one comes AFTER the rejections, never before: a limiter
     * that fired on the first attempt would be a denial of service. */
    expect(classified.indexOf("credential_rejected")).toBeLessThan(
      classified.indexOf("rate_limited")
    );

    /*
     * AND IT SAYS HOW LONG TO WAIT. A 429 with no retry hint leaves a client
     * guessing, and a client that guesses wrong spends the next window being
     * refused again. This is also the header the harness in `e2e/src/
     * identity.ts` reads, so a change here would surface as a mysterious
     * credential failure somewhere else.
     */
    const throttled = seen[classified.indexOf("rate_limited")];
    expect(throttled?.retryAfter, `the 429 carried no ${RETRY_AFTER_HEADER}`).not.toBeNull();
    expect(Number(throttled?.retryAfter)).toBeGreaterThan(0);
    expect(Number(throttled?.retryAfter)).toBeLessThanOrEqual(
      CREDENTIAL_RATE_LIMIT.windowSeconds
    );
  });

  test("the policy module and the server agree about WHICH rule applies", async () => {
    /*
     * The two readings meeting. `rateLimitFor` is this repository's statement
     * about the endpoint the test above actually exercised; if the path ever
     * changes, the behavioural test would keep passing against whatever the
     * library's own default rule covers while the written policy quietly
     * described nothing.
     */
    expect(rateLimitFor(SIGN_IN_PATH)).toBe(CREDENTIAL_RATE_LIMIT);
    expect(RATE_LIMITED_STATUS).toBe(429);
  });
});
