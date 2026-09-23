import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_ACCOUNT_HEADER,
  DEVELOPMENT_SESSION_HEADER,
  deploymentSessionAccount,
  type SessionReadResult,
  type SessionReaderResolution
} from "./account";

/* -------------------------------------------------------------------------
 * The deployment authentication branch (PW-0403)
 *
 * `account.test.ts` covers the development branch and the capability forgeries.
 * This file covers the branch a DEPLOYMENT takes, which before PW-0403 did not
 * exist: every deployment request answered `authentication_not_configured`
 * because no auth instance was constructed anywhere in the application.
 *
 * NO DATABASE AND NO AUTH LIBRARY. `deploymentSessionAccount` takes the session
 * reader as an argument, so every case below -- including expired and revoked,
 * which are states of a row -- is exercised as the ANSWER the store gives,
 * which is the only thing this function can observe anyway. A suite that stood
 * up PostgreSQL to prove that a null answer produces a refusal would be testing
 * Better Auth.
 * ---------------------------------------------------------------------- */

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://liberty.example/api/v1/profiles", { headers });
}

function reader(answer: SessionReadResult | null | undefined): () => SessionReaderResolution {
  return () => ({ ok: true, read: async () => answer });
}

function throwing(error: unknown): () => SessionReaderResolution {
  return () => ({
    ok: true,
    read: async () => {
      throw error;
    }
  });
}

const VALID: SessionReadResult = {
  user: { id: "user-1" },
  session: { id: "session-1" }
};

describe("a verified session produces an account", () => {
  it("publishes the account and session ids and nothing else", async () => {
    const resolved = await deploymentSessionAccount(request(), reader(VALID));

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.account).toEqual({ userId: "user-1", sessionId: "session-1" });
  });

  it("keeps both ids out of the reason trail", async () => {
    /*
     * A reason trail is logged. A session id in a log aggregator is a
     * credential-shaped value, and an account id is the one `profileViewSchema`
     * already refuses to publish. The detail says where the identity came from.
     */
    const resolved = await deploymentSessionAccount(request(), reader(VALID));

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.detail).not.toContain("user-1");
    expect(resolved.detail).not.toContain("session-1");
    expect(resolved.detail).toContain("verified");
  });
});

describe("the four ways a session fails are one answer", () => {
  /*
   * THE CENTRAL SECURITY PROPERTY OF THIS MODULE. Absent, malformed, expired
   * and revoked reach this function as different store answers and must leave
   * as the same one. Separating them would tell an attacker holding a stolen
   * cookie whether the session it came from still exists, and separating
   * "malformed" from "absent" is a cheap oracle for whether a cookie name is
   * right. PW-0402's review required the indistinguishable-refusal behaviour to
   * be preserved, and this is that requirement on the authentication side.
   *
   * Each case is named for the STATE it represents, and the comment says how
   * that state arrives here, so the table is not four spellings of null.
   */
  const cases: readonly (readonly [string, SessionReadResult | null | undefined])[] = [
    /* No cookie at all: the library finds nothing to look up. */
    ["absent", null],
    /* Some libraries answer `undefined` rather than `null`; both are nothing. */
    ["absent, spelled undefined", undefined],
    /*
     * A cookie that does not decode, or decodes to no row. Better Auth answers
     * the same way it answers an absent one, which is itself the correct
     * behaviour and is why this case looks identical from here.
     */
    ["malformed", null],
    /*
     * EXPIRED. The row existed and its expiry has passed, so the lookup finds
     * nothing. This is a state of the database, and the only thing this function
     * can observe about it is the answer.
     */
    ["expired", null],
    /*
     * REVOKED. The row was deleted -- sign-out elsewhere, or an operator ending
     * a session. It stops working IMMEDIATELY, which is the property database
     * sessions were chosen for and the reason `createLibertyAuth` declines
     * `cookieCache`.
     */
    ["revoked", null]
  ];

  for (const [name, answer] of cases) {
    it(`refuses a ${name} session identically`, async () => {
      const resolved = await deploymentSessionAccount(request(), reader(answer));

      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.reason).toBe("not_authenticated");
      expect(resolved.detail).toBe("this request carried no valid session; sign in to continue");
    });
  }

  it("uses one wording for every case, so the details cannot drift apart", async () => {
    const details = new Set<string>();
    for (const [, answer] of cases) {
      const resolved = await deploymentSessionAccount(request(), reader(answer));
      if (!resolved.ok) details.add(resolved.detail);
    }
    expect(details.size).toBe(1);
  });
});

describe("a session that is present but unusable is not an identity", () => {
  /*
   * The library should never produce these. The assertion exists because an
   * empty string in either position would be an identity that compares EQUAL to
   * another empty one -- so a defect upstream would silently merge households
   * rather than fail.
   */
  const unusable: readonly (readonly [string, SessionReadResult])[] = [
    ["no user", { session: { id: "s" } }],
    ["no session", { user: { id: "u" } }],
    ["an empty user id", { user: { id: "" }, session: { id: "s" } }],
    ["an empty session id", { user: { id: "u" }, session: { id: "" } }],
    ["a non-string user id", { user: { id: 7 }, session: { id: "s" } }],
    ["a null user", { user: null, session: { id: "s" } }]
  ];

  for (const [name, answer] of unusable) {
    it(`refuses ${name}`, async () => {
      const resolved = await deploymentSessionAccount(request(), reader(answer));
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      /* Fails CLOSED as not-authenticated, not as a server error: the caller
       * cannot tell the difference and must not be able to. */
      expect(resolved.reason).toBe("not_authenticated");
    });
  }
});

describe("what cannot substitute for a session", () => {
  /*
   * These are the three substitutions gpt-architect's acceptance names, and each
   * is asserted as an ABSENCE: the request carries the thing, and the answer is
   * unchanged. Asserting the absence is the only form that stays true when
   * somebody later adds a header read "just for the desktop case".
   */
  it("a desktop launch token does not authenticate", async () => {
    const withToken = request({
      authorization: "Bearer a-desktop-launch-token",
      "x-liberty-desktop-token": "a-desktop-launch-token"
    });
    const resolved = await deploymentSessionAccount(withToken, reader(null));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_authenticated");
  });

  it("a loopback origin does not authenticate", async () => {
    const loopback = new Request("http://127.0.0.1:41999/api/v1/profiles", {
      headers: {
        origin: "http://127.0.0.1:41999",
        host: "127.0.0.1:41999",
        "x-forwarded-for": "127.0.0.1"
      }
    });
    const resolved = await deploymentSessionAccount(loopback, reader(null));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_authenticated");
  });

  it("a development header does not authenticate", async () => {
    /*
     * The development headers are honoured only on the branch a minted
     * non-deployment capability admits, and this function is the other branch.
     * It never reads them; this proves it by sending them.
     */
    const spoofed = request({
      [DEVELOPMENT_ACCOUNT_HEADER]: "household-b",
      [DEVELOPMENT_SESSION_HEADER]: "session-b"
    });
    const resolved = await deploymentSessionAccount(spoofed, reader(null));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("not_authenticated");
  });

  it("reads the headers and nothing else about the request", async () => {
    /*
     * Stated positively: the reader is handed the request's headers, by
     * identity, and the function has no other channel into it. A later edit that
     * passed the URL or the body would fail this.
     */
    const seen: Headers[] = [];
    const probe = request({ cookie: "liberty.session_token=abc" });
    await deploymentSessionAccount(probe, () => ({
      ok: true,
      read: async (headers) => {
        seen.push(headers);
        return null;
      }
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(probe.headers);
  });
});

describe("the store failing is not the viewer being signed out", () => {
  it("reports a thrown read as a configuration problem, not as not-authenticated", async () => {
    const resolved = await deploymentSessionAccount(
      request(),
      throwing(new Error("connection terminated unexpectedly"))
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    /* "Retry later" is true here and false for a signed-out viewer; the reason
     * is what carries that difference to the status code. */
    expect(resolved.reason).toBe("authentication_not_configured");
    expect(resolved.detail).toContain("connection terminated unexpectedly");
  });

  it("survives a thrown non-Error without putting undefined on the screen", async () => {
    const resolved = await deploymentSessionAccount(request(), throwing("pool exhausted"));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.detail).toContain("pool exhausted");
    expect(resolved.detail).not.toContain("undefined");
  });

  it("reports an unresolvable instance with the resolver's own detail", async () => {
    const resolved = await deploymentSessionAccount(request(), () => ({
      ok: false,
      detail: "no authentication instance: configuration is invalid (secret: too short)"
    }));

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("authentication_not_configured");
    expect(resolved.detail).toContain("configuration is invalid");
  });
});
