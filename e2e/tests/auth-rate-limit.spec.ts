import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

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
 * IT SHARES THE BUCKET IT IS MEASURING, AND THAT GOES BOTH WAYS
 * ==========================================================================
 *
 * The limiter keys by client IP and path. Every Playwright worker in this
 * suite shares one IP, and `playwright.config.ts` sets `fullyParallel` with no
 * worker cap, so every spec that signs in -- the watchlist cases, the
 * production-journey cases, `establishSession` itself -- draws from the SAME
 * `/sign-in/email` bucket this file is trying to measure.
 *
 * ON THE WAY OUT, that means this file can poison the ones after it, and
 * PL-0715 exists because a throttled sign-up in exactly that situation was
 * misread as a product failure. `afterAll` drains the window.
 *
 * ON THE WAY IN, IT MEANS THE BUCKET MAY ALREADY BE EMPTY OR MAY ALREADY BE
 * FULL, AND THE FIRST VERSION OF THIS FILE ASSUMED THE FIRST. It guarded the
 * exit and not the entrance. CI #180 failed on it: all four attempts came back
 * 429 because another worker had got there first, and the spec reported the
 * limiter working correctly as a defect. Reproduced here with `--workers=4`
 * against a real production build before it was repaired.
 *
 * So this file no longer assumes a starting state -- it OBSERVES its way to
 * one. `aCredentialRejection` below retries past any throttling, bounded, and
 * returns only when it has actually seen the endpoint examine a credential;
 * the burst then runs from a bucket known to have had room a moment earlier.
 * Nothing about the control changed. The measurement stopped pretending it
 * had the server to itself.
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

/** One answer from the credential endpoint. */
interface Observation {
  readonly status: number;
  readonly retryAfter: string | null;
}

/** One sign-in attempt with an address nobody registered. */
async function attemptSignIn(
  request: APIRequestContext,
  account: { email: string; password: string }
): Promise<Observation> {
  const response = await request.post(`${AUTH_BASE_URL_FOR_SIGN_IN}/api/auth${SIGN_IN_PATH}`, {
    data: { email: account.email, password: account.password },
    headers: { "content-type": "application/json" },
    failOnStatusCode: false
  });
  return {
    status: response.status(),
    retryAfter: response.headers()[RETRY_AFTER_HEADER.toLowerCase()] ?? null
  };
}

/** How many windows to wait for room before giving up. */
const PATIENCE = 4;

/**
 * Keep trying until the endpoint actually examines a credential.
 *
 * NOT A RETRY THAT HIDES A FAILURE, and the distinction is the one
 * `e2e/src/identity.ts` already draws for the same endpoint: a 429 is the
 * server stating a protocol requirement -- try again later -- rather than a
 * failed answer, so obeying it is participating in the protocol, not having
 * another go at the same question. A wrong password answered 401 returns
 * immediately and is never retried.
 *
 * BOUNDED, and the failure says what contended. An unbounded wait here would
 * turn a genuine "this endpoint is throttling everything forever" into a
 * timeout somebody has to go and diagnose.
 */
async function aCredentialRejection(request: APIRequestContext): Promise<Observation> {
  const seen: Observation[] = [];
  for (let window = 0; window < PATIENCE; window += 1) {
    const observation = await attemptSignIn(request, nobody());
    seen.push(observation);
    if (classifyAuthRefusal(observation.status) !== "rate_limited") return observation;
    /* The server's own number when it gives one; the policy's window when it
     * does not. Plus a second, because this clock is not the server's. */
    const waitSeconds =
      Number(observation.retryAfter) > 0
        ? Number(observation.retryAfter)
        : CREDENTIAL_RATE_LIMIT.windowSeconds;
    await new Promise((resolve) => setTimeout(resolve, (waitSeconds + 1) * 1000));
  }
  throw new Error(
    `The credential endpoint was throttled on all ${String(PATIENCE)} attempts spread over ` +
      `${String(PATIENCE)} windows, so this test never saw it examine a credential and cannot ` +
      "tell a throttled refusal from a rejected one. Every Playwright worker shares one IP and " +
      "therefore one bucket for this path, so the usual cause is sustained contention from the " +
      "rest of the suite rather than a product fault -- but it is reported rather than waited " +
      `out. Responses: ${JSON.stringify(seen)}`
  );
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
    /*
     * STEP ONE: SEE THE ENDPOINT EXAMINE A CREDENTIAL. Retrying past the
     * throttling rather than assuming its absence is the whole repair. When
     * this returns, the bucket had room a moment ago and one of the two facts
     * this test exists for has been observed.
     */
    const rejection = await aCredentialRejection(request);

    /*
     * STEP TWO: EMPTY THE BUCKET ON PURPOSE. A burst of `maxRequests + 1` in
     * one breath cannot be absorbed by a limit of `maxRequests` per window
     * however much room there was a moment ago, so at least one of these must
     * be refused without the credential being examined -- and that is true
     * whatever the other workers are doing, which is exactly the property the
     * first version of this test lacked.
     */
    const burst: Observation[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      burst.push(await attemptSignIn(request, nobody()));
    }

    /*
     * NOTHING SUCCEEDED, asserted first and over everything observed. If any
     * attempt had been accepted the rest of this test would be measuring
     * something else entirely, and a 200 here would be a far larger finding
     * than a missing rate limit.
     */
    expect(
      [rejection, ...burst].filter((entry) => entry.status < 400),
      `an attempt with an unregistered address and an invented password was ACCEPTED: ${JSON.stringify([rejection, ...burst])}`
    ).toEqual([]);

    /*
     * THE WHOLE CLAIM, AND IT IS STILL TWO DIFFERENT FACTS. One refusal
     * examined the credential and rejected it; the other refused without
     * looking. The ORDER is no longer asserted within a single array, because
     * under parallelism the array's first entry says more about another
     * worker's timing than about this product -- but the two facts are both
     * required, and `aCredentialRejection` is what establishes that the
     * throttling below is not simply the endpoint's only answer.
     */
    expect(classifyAuthRefusal(rejection.status)).toBe("credential_rejected");

    const throttled = burst.find(
      (entry) => classifyAuthRefusal(entry.status) === "rate_limited"
    );
    expect(
      throttled,
      `a burst of ${String(ATTEMPTS)} attempts in one window was never throttled, though a ` +
        `credential rejection moments earlier proved the endpoint was answering. The policy in ` +
        `packages/auth/src/rate-limit.ts says ${String(CREDENTIAL_RATE_LIMIT.maxRequests)} ` +
        `requests per ${String(CREDENTIAL_RATE_LIMIT.windowSeconds)}s; the server disagrees. ` +
        `Responses: ${JSON.stringify(burst)}`
    ).toBeDefined();

    /*
     * AND IT SAYS HOW LONG TO WAIT. A 429 with no retry hint leaves a client
     * guessing, and a client that guesses wrong spends the next window being
     * refused again. This is also the header `e2e/src/identity.ts` reads to
     * schedule its own retry, so a change here would surface as a mysterious
     * credential failure somewhere else entirely.
     */
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
