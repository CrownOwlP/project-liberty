import { describe, expect, it } from "vitest";
import { NON_DEPLOYMENT_ENVIRONMENTS } from "../../app/api/deployment-environment";
import {
  DEFAULT_DEVELOPMENT_ACCOUNT_ID,
  DEVELOPMENT_ACCOUNT_HEADER,
  DEVELOPMENT_SESSION_HEADER,
  resolveRequestAccount
} from "./account";

/*
 * The identity gate.
 *
 * The property that matters is the first one: a deployment gets an explanation,
 * never an account. Everything else here is about the development branch being
 * usable without being sloppy -- a malformed header is refused rather than
 * quietly falling back, because a silent fallback would make two "different"
 * households share one identity and make a cross-household isolation test pass
 * for the wrong reason.
 */

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://liberty.test/api/v1/profiles", { method: "GET", headers });
}

describe("a deployment gets an explanation, not an account", () => {
  it("refuses on every NODE_ENV outside the allowlist", () => {
    /*
     * `""` stands for an UNSET `NODE_ENV`, and it is the faithful stand-in
     * rather than a compromise: `classify` collapses both with `?? ""`, so this
     * exercises the same branch. `undefined` cannot be used, because passing it
     * explicitly triggers the parameter's default -- a read of `process.env` --
     * which in this worker is `test` and would assert the opposite of what the
     * case means.
     */
    for (const nodeEnv of ["production", "staging", "preview", "Production", ""]) {
      const resolved = resolveRequestAccount(request(), nodeEnv);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      /*
       * Not "unauthenticated", which would tell an operator to go and sign in,
       * and not a credential prompt: this deployment has no way to issue one.
       * The remedy is to wire the auth instance, and the reason names it.
       */
      expect(resolved.reason).toBe("authentication_not_configured");
      expect(resolved.detail).toContain("@liberty/auth/server");
    }
  });

  it("cannot be talked into an account by a header", () => {
    const resolved = resolveRequestAccount(
      request({ [DEVELOPMENT_ACCOUNT_HEADER]: "household-b" }),
      "production"
    );
    /* The header is read only after the witness is obtained, so in a deployment
     * it is not read at all. */
    expect(resolved.ok).toBe(false);
  });
});

describe("outside a deployment", () => {
  it("produces a stable default account on every allowlisted environment", () => {
    for (const nodeEnv of NON_DEPLOYMENT_ENVIRONMENTS) {
      const resolved = resolveRequestAccount(request(), nodeEnv);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.account.userId).toBe(DEFAULT_DEVELOPMENT_ACCOUNT_ID);
      /*
       * The session id is DERIVED from the account rather than a constant, so two
       * development accounts do not share one row in `active_profile_selection`
       * -- which is keyed by session, and would otherwise make one household's
       * profile choice reselect the other's.
       */
      expect(resolved.account.sessionId).toBe(`${DEFAULT_DEVELOPMENT_ACCOUNT_ID}-session`);
      expect(resolved.detail).toContain(nodeEnv);
    }
  });

  it("lets a developer name two households, with distinct sessions", () => {
    const first = resolveRequestAccount(
      request({ [DEVELOPMENT_ACCOUNT_HEADER]: "household-a" }),
      "test"
    );
    const second = resolveRequestAccount(
      request({ [DEVELOPMENT_ACCOUNT_HEADER]: "household-b" }),
      "test"
    );

    expect(first.ok && first.account.userId).toBe("household-a");
    expect(second.ok && second.account.userId).toBe("household-b");
    expect(first.ok && second.ok && first.account.sessionId === second.account.sessionId).toBe(
      false
    );
  });

  it("lets one account hold two sessions, which is what two devices are", () => {
    const television = resolveRequestAccount(
      request({
        [DEVELOPMENT_ACCOUNT_HEADER]: "household-a",
        [DEVELOPMENT_SESSION_HEADER]: "television"
      }),
      "test"
    );
    expect(television.ok && television.account.userId).toBe("household-a");
    expect(television.ok && television.account.sessionId).toBe("television");
  });

  it("refuses a malformed header rather than falling back to the default", () => {
    for (const value of ["Household A", "household_a", "../etc/passwd", "a".repeat(65)]) {
      const resolved = resolveRequestAccount(
        request({ [DEVELOPMENT_ACCOUNT_HEADER]: value }),
        "test"
      );
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("development_identifier_malformed");
      /* The LENGTH and the header name, never the value: echoing an unbounded
       * header into a refusal moves the unbounded string into the logs. */
      expect(resolved.detail).toContain(DEVELOPMENT_ACCOUNT_HEADER);
      expect(resolved.detail).not.toContain(value);
    }
  });
});
