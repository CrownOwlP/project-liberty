/* -------------------------------------------------------------------------
 * The five proofs gpt-architect's ruling requires, each as a REFUSAL (PW-0402).
 *
 * Every one of these is a negative. That is deliberate: an authorization suite
 * that mostly shows permitted callers being permitted proves the happy path and
 * nothing about the boundary.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  authorizeRoute,
  routeRefusalStatus,
  type RouteAuthorizationInputs
} from "./route-authorization";

const IDENTIFIED: RouteAuthorizationInputs["account"] = {
  ok: true,
  account: { accountId: "account-a", sessionId: "session-a" } as never,
  detail: "from the development account header"
};

const ANONYMOUS: RouteAuthorizationInputs["account"] = {
  ok: false,
  reason: "authentication_not_configured",
  detail: "no authentication instance is constructed in this app"
};

const GRANTED = { allowed: true, reason: "active_profile_of_session" } as never;
const DENIED_NOT_OWNED = { allowed: false, reason: "profile_not_owned_by_session" } as never;
const DENIED_NO_RECORD = { allowed: false, reason: "profile_ownership_unknown" } as never;

describe("proof 1 — a protected route requires an authenticated account", () => {
  it("refuses an account route with no account", () => {
    const decision = authorizeRoute("account", { account: ANONYMOUS, profile: null });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("unauthenticated");
  });

  it("refuses a profile route with no account, BEFORE looking at the profile", () => {
    /* Order matters. Evaluating the profile first would let "no such profile" be
     * observable to somebody who is not logged in at all. */
    const decision = authorizeRoute("profile", { account: ANONYMOUS, profile: GRANTED });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("unauthenticated");
      expect(decision.internalDetail).not.toContain("profile access");
    }
  });

  it("admits an identified caller, with a reason on the granting branch", () => {
    const decision = authorizeRoute("account", { account: IDENTIFIED, profile: null });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.reason).not.toBe("");
  });
});

describe("proof 2 — a profile route authorizes the ACTIVE profile, never a supplied id", () => {
  it("takes no profile id at all", () => {
    /* The strongest form of this proof is structural: there is no parameter a
     * caller-supplied id could arrive through. PL-0405 recorded a forgeable
     * ProfileScope as a cross-profile data-access bypass; this is the route-level
     * half of the same defect, and the fix is the same shape -- the decision is
     * fed a DECISION about the active profile, not an identifier to trust. */
    const source = readFileSync(new URL("./route-authorization.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toMatch(/requestedProfileId|profileId\s*:/);
  });

  it("refuses when no active profile was named", () => {
    const decision = authorizeRoute("profile", { account: IDENTIFIED, profile: null });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("not_permitted");
  });

  it("admits an authorized active profile", () => {
    expect(authorizeRoute("profile", { account: IDENTIFIED, profile: GRANTED }).allowed).toBe(true);
  });
});

describe("proof 3 — the desktop launch token is not application authentication", () => {
  it("cannot read it, because it is never given the request", () => {
    /*
     * The type signature is the proof. `authorizeRoute` takes two resolutions
     * and no `Request`, so there is no path by which a header could be consulted
     * -- which is a stronger guarantee than a test that passes one and checks it
     * was ignored, because that test only covers the header it thought of.
     */
    const source = readFileSync(new URL("./route-authorization.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(code).not.toContain("sidecar");
    expect(code).not.toContain("x-liberty-sidecar-token");
    expect(code).not.toContain("headers");
    /*
     * The bare `Request` type, which is the only way a header could arrive.
     * `RequestAccountResolution` and `RouteAuthorizationInputs` legitimately
     * contain the word, so they are removed first rather than the assertion
     * being weakened to a phrase that happens not to match -- the same reason
     * the comment-stripping above is done properly instead of by hoping.
     */
    const withoutKnownNames = code
      .replaceAll("RequestAccountResolution", "")
      .replaceAll("RouteAuthorizationInputs", "");
    expect(withoutKnownNames).not.toContain("Request");
    /* Non-vacuity: the two names really were in there. */
    expect(code).toContain("RequestAccountResolution");
  });

  it("refuses a caller whose ONLY credential is a valid launch token", () => {
    /*
     * The behavioural half. A request that satisfied PW-0101's listener guard
     * completely -- correct token, correct Host -- and carries no account is
     * modelled here by exactly what such a request produces: an account
     * resolution that failed. It is refused.
     */
    const decision = authorizeRoute("profile", { account: ANONYMOUS, profile: GRANTED });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("unauthenticated");
  });
});

describe("proof 4 — refusals do not leak whether a resource exists", () => {
  it("answers 'not yours' and 'not there' identically on the wire", () => {
    const notYours = authorizeRoute("profile", { account: IDENTIFIED, profile: DENIED_NOT_OWNED });
    const notThere = authorizeRoute("profile", { account: IDENTIFIED, profile: DENIED_NO_RECORD });
    const noneNamed = authorizeRoute("profile", { account: IDENTIFIED, profile: null });

    expect(notYours.allowed).toBe(false);
    expect(notThere.allowed).toBe(false);
    if (!notYours.allowed && !notThere.allowed && !noneNamed.allowed) {
      const wire = new Set([notYours.wireDetail, notThere.wireDetail, noneNamed.wireDetail]);
      const codes = new Set([notYours.code, notThere.code, noneNamed.code]);
      expect(
        wire.size,
        "distinguishable refusals let a caller walk the id space and learn which profiles exist"
      ).toBe(1);
      expect(codes.size).toBe(1);
      expect(routeRefusalStatus(notYours.code)).toBe(routeRefusalStatus(notThere.code));
    }
  });

  it("keeps the distinction for the operator, in the internal detail only", () => {
    /* Hiding it from the log too would make an authorization failure
     * indistinguishable from a routing bug in every dashboard this project has. */
    const notYours = authorizeRoute("profile", { account: IDENTIFIED, profile: DENIED_NOT_OWNED });
    const notThere = authorizeRoute("profile", { account: IDENTIFIED, profile: DENIED_NO_RECORD });
    if (!notYours.allowed && !notThere.allowed) {
      expect(notYours.internalDetail).not.toBe(notThere.internalDetail);
    }
  });

  it("does not answer 404 for a profile the caller may not see", () => {
    /* 404 hides existence from the operator too. The hiding is done by making
     * every not_permitted cause produce the same 403 body instead. */
    expect(routeRefusalStatus("not_permitted")).toBe(403);
    expect(routeRefusalStatus("unauthenticated")).toBe(401);
  });
});

describe("proof 5 — a loopback origin is never treated as authentication", () => {
  it("names no address, no forwarded header and no remote-address concept", () => {
    const source = readFileSync(new URL("./route-authorization.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const forbidden of ["127.0.0.1", "::1", "localhost", "x-forwarded-for", "remoteAddress"]) {
      expect(code, `${forbidden} must not influence an authorization decision`).not.toContain(
        forbidden
      );
    }
    /* Non-vacuity: the stripper is not eating the file. */
    expect(code).toContain("authorizeRoute");
  });

  it("refuses a caller from this machine with no application credential", () => {
    /*
     * There is no OS boundary between a game launcher, a browser tab's helper and
     * this server. Modelled the only way it can be, because this function is not
     * given an address: such a caller produces an account resolution that failed,
     * and the answer is a refusal.
     */
    expect(authorizeRoute("account", { account: ANONYMOUS, profile: null }).allowed).toBe(false);
  });
});

describe("one decision point", () => {
  it("is the only export that decides, so a handler cannot form a second opinion", () => {
    const source = readFileSync(new URL("./route-authorization.ts", import.meta.url), "utf8");
    const exported = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
    expect(exported).toEqual(["authorizeRoute", "routeRefusalStatus"]);
  });
});
