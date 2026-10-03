/* -------------------------------------------------------------------------
 * The authentication rate-limit policy (PL-0719).
 *
 * WHAT THESE CAN AND CANNOT PROVE. This file loads no library and starts no
 * server, so it proves what the policy SAYS: which rule governs which path,
 * that the values are the ones argued for, and that a throttled refusal is a
 * different fact from a rejected credential. That a request is actually
 * refused with 429 after the third attempt is a statement about a running
 * server and is `e2e/tests/auth-rate-limit.spec.ts`.
 *
 * Both halves are needed and neither substitutes for the other. A unit test
 * alone would be this repository agreeing with itself; the e2e test alone
 * would leave the numbers unexplained and unpinned.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import {
  AUTH_RATE_LIMIT_KEY,
  AUTH_RATE_LIMIT_RULES,
  AUTH_RATE_LIMIT_STORAGE,
  CREDENTIAL_RATE_LIMIT,
  DEFAULT_RATE_LIMIT,
  RATE_LIMITED_STATUS,
  RECOVERY_RATE_LIMIT,
  classifyAuthRefusal,
  rateLimitFor
} from "./rate-limit";

describe("which rule governs which path", () => {
  it("the credential endpoints, by their real paths", () => {
    /* `/sign-in/email` and `/sign-up/email` are the two this product's own
     * harness posts to, which is why they are named rather than assumed. */
    expect(rateLimitFor("/sign-in/email")).toBe(CREDENTIAL_RATE_LIMIT);
    expect(rateLimitFor("/sign-up/email")).toBe(CREDENTIAL_RATE_LIMIT);
    expect(rateLimitFor("/change-password")).toBe(CREDENTIAL_RATE_LIMIT);
    expect(rateLimitFor("/change-email")).toBe(CREDENTIAL_RATE_LIMIT);
  });

  it("MATCHES BOTH SPELLINGS, because the library matches globs by segment", () => {
    /* A custom rule key is matched exactly unless it contains `*`, and the
     * glob treats `/` as a separator -- so `/sign-in/*` does not match
     * `/sign-in`. Listing both is what makes the rule apply however the
     * endpoint is reached. */
    expect(rateLimitFor("/sign-in")).toBe(CREDENTIAL_RATE_LIMIT);
    expect(rateLimitFor("/sign-in/email")).toBe(CREDENTIAL_RATE_LIMIT);
  });

  it("one segment and not two, so a glob cannot swallow a deeper path", () => {
    expect(rateLimitFor("/sign-in/email/extra")).toBeNull();
  });

  it("the message-sending endpoints, which are a different abuse", () => {
    expect(rateLimitFor("/request-password-reset")).toBe(RECOVERY_RATE_LIMIT);
    expect(rateLimitFor("/send-verification-email")).toBe(RECOVERY_RATE_LIMIT);
    expect(rateLimitFor("/forget-password")).toBe(RECOVERY_RATE_LIMIT);
  });

  it("and nothing else, which is what the backstop is for", () => {
    /* `/get-session` is asked for by every page. A rule here would be a
     * security control over ordinary traffic, which is not what these are. */
    expect(rateLimitFor("/get-session")).toBeNull();
    expect(rateLimitFor("/sign-out")).toBeNull();
    expect(rateLimitFor("/")).toBeNull();
  });
});

describe("the values, pinned so a change is deliberate", () => {
  it("THREE CREDENTIAL ATTEMPTS IN TEN SECONDS", () => {
    /*
     * Pinned rather than merely present. These two numbers are the product's
     * brute-force posture, and the entire reason this task exists is that
     * they were a dependency's default with nothing here to change if the
     * dependency changed. A test that only checked they were numbers would
     * reintroduce exactly that.
     */
    expect(CREDENTIAL_RATE_LIMIT.windowSeconds).toBe(10);
    expect(CREDENTIAL_RATE_LIMIT.maxRequests).toBe(3);
  });

  it("three message sends in sixty seconds", () => {
    expect(RECOVERY_RATE_LIMIT.windowSeconds).toBe(60);
    expect(RECOVERY_RATE_LIMIT.maxRequests).toBe(3);
  });

  it("and a backstop that is looser than both, which is the point of it", () => {
    /* If the backstop were ever tightened below a credential limit it would
     * silently become the binding control on `/get-session`, which every page
     * of this application asks for. */
    expect(DEFAULT_RATE_LIMIT.maxRequests).toBeGreaterThan(CREDENTIAL_RATE_LIMIT.maxRequests);
    expect(DEFAULT_RATE_LIMIT.maxRequests).toBeGreaterThan(RECOVERY_RATE_LIMIT.maxRequests);
  });

  it("THE CREDENTIAL LIMIT IS THE STRICTEST THING HERE", () => {
    /* A guard against loosening by accident: whatever else is added, the
     * endpoint where a password is guessed must not become the lenient one. */
    for (const rule of AUTH_RATE_LIMIT_RULES) {
      expect(rule.maxRequests).toBeLessThanOrEqual(DEFAULT_RATE_LIMIT.maxRequests);
    }
    expect(CREDENTIAL_RATE_LIMIT.maxRequests).toBeLessThanOrEqual(RECOVERY_RATE_LIMIT.maxRequests);
  });

  it("every rule says what it protects, because a 429 needs an explanation", () => {
    for (const rule of AUTH_RATE_LIMIT_RULES) {
      expect(rule.describe.length).toBeGreaterThan(10);
      expect(rule.paths.length).toBeGreaterThan(0);
    }
  });
});

describe("the key and the store, written down rather than discovered", () => {
  it("names the key, so the shared-bucket hazard is searchable", () => {
    /* The library falls back to one literal key for every client when it
     * cannot resolve an IP. That hazard is argued in `rate-limit.ts`; this is
     * the handle a reader greps for. */
    expect(AUTH_RATE_LIMIT_KEY).toBe("client-ip+path");
  });

  it("names the store, so per-process counters are a stated cost", () => {
    expect(AUTH_RATE_LIMIT_STORAGE).toBe("memory");
  });
});

describe("telling the two refusals apart, which is why this task exists", () => {
  it("A THROTTLED REQUEST IS NOT A WRONG PASSWORD", () => {
    /*
     * The confusion that cost a round. PL-0715 was opened because the
     * watchlist harness read a throttled sign-up as a credential failure and
     * reported a product defect that did not exist. They are different facts
     * about different things: one says the credential is wrong, the other
     * says this client asked too often and the credential was never examined.
     */
    expect(classifyAuthRefusal(RATE_LIMITED_STATUS)).toBe("rate_limited");
    expect(classifyAuthRefusal(401)).toBe("credential_rejected");
    expect(classifyAuthRefusal(403)).toBe("credential_rejected");
    expect(classifyAuthRefusal(429)).not.toBe(classifyAuthRefusal(401));
  });

  it("does not quietly classify a server failure as either of them", () => {
    /* A 500 is neither. Folding it into "credential_rejected" is how an
     * unreachable database comes to look like a user typing the wrong
     * password -- which is precisely what a production run of this suite
     * showed when PostgreSQL had stopped. */
    expect(classifyAuthRefusal(500)).toBe("other");
    expect(classifyAuthRefusal(503)).toBe("other");
    expect(classifyAuthRefusal(200)).toBe("other");
  });
});
