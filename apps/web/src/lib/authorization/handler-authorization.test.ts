/* -------------------------------------------------------------------------
 * The guard over the profile-scoped handlers (PW-0402).
 *
 * WHAT THE AUDIT FOR THIS TASK ACTUALLY FOUND, WHICH IS NOT WHAT R4 SAYS.
 *
 * docs/SECURITY.md records that "no authentication or authorization exists on
 * any API route yet". Half of that is out of date and the half that is still
 * true is the more serious one.
 *
 *   AUTHORIZATION IS ENFORCED. Every profile-scoped handler resolves a request
 *   context, then calls `resolveActiveProfileScope`, which calls
 *   `authorizeProfileAccess` from `@liberty/auth` against a real ownership
 *   record and a minted `ProfileScope`. No handler reads a profile id from the
 *   caller. And the existence leak is already closed: `externalProfileAccessReason`
 *   collapses `profile_not_found` and `profile_not_owned_by_account` to one
 *   external `profile_unavailable`, through a total switch with no `default`, so
 *   extending the union fails to compile rather than leaking a new reason.
 *
 *   AUTHENTICATION IS NOT. `resolveRequestAccount` establishes an account from a
 *   plaintext development header in a non-deployment runtime, and refuses with
 *   `authentication_not_configured` in a deployment. So the routes are not
 *   anonymous -- they are unauthenticated in development and closed in
 *   production, which is a different and narrower gap than R4 describes.
 *
 * SO THIS FILE GUARDS WHAT IS ALREADY RIGHT, rather than rebuilding it. The
 * defect it exists to catch is a future handler that reads a profile id off the
 * request, or one that stops going through the shared decision and forms its own
 * opinion -- both of which are the shape of defect PL-0405 recorded when a
 * `ProfileScope` turned out to be forgeable.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HANDLERS = [
  "../../app/api/v1/progress/handler.ts",
  "../../app/api/v1/watchlist/handler.ts",
  "../../app/api/v1/profiles/handler.ts"
] as const;

function code(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("every profile-scoped handler goes through the shared decision", () => {
  it("reads the handlers it is guarding", () => {
    /* Non-vacuity, first: a bad path would satisfy every assertion below. */
    for (const handler of HANDLERS) {
      expect(code(handler).length, handler).toBeGreaterThan(1000);
    }
  });

  for (const handler of HANDLERS) {
    it(`${handler.split("/").slice(-2).join("/")} resolves a request context rather than trusting the caller`, () => {
      const source = code(handler);
      expect(source).toContain("resolveRequestContext");
    });

    it(`${handler.split("/").slice(-2).join("/")} never reads a profile id from the request`, () => {
      /*
       * The one that matters. A handler that accepted `?profileId=` or a body
       * field would make every profile-scoped row in this product readable by
       * anyone who could guess an id -- the cross-profile bypass PL-0405 found
       * one layer down.
       */
      const source = code(handler);
      for (const forbidden of [
        'searchParams.get("profileId")',
        'get("profileId")',
        "body.profileId",
        "request.profileId"
      ]) {
        expect(source, `${handler} reads ${forbidden}`).not.toContain(forbidden);
      }
    });
  }

  it("the profile-scoped data handlers authorize the ACTIVE profile", () => {
    /* `profiles/handler.ts` is exempt and named: the picker necessarily runs
     * before any profile is active, which is why `@liberty/auth` publishes a
     * separate selection decision rather than a flag on this one. */
    for (const handler of HANDLERS.filter((h) => !h.includes("/profiles/"))) {
      expect(code(handler), handler).toContain("resolveActiveProfileScope");
    }
  });
});

describe("the existence leak stays closed", () => {
  it("narrows every internal denial through the external vocabulary", () => {
    for (const handler of HANDLERS.filter((h) => !h.includes("/profiles/"))) {
      const source = code(handler);
      expect(source, handler).toContain("externalProfileAccessReason");
    }
  });

  it("the external vocabulary cannot name a missing profile", () => {
    /*
     * Asserted against the CONTRACT rather than the handler, because this is
     * where it would break: `profile_not_found` and `profile_not_owned_by_account`
     * must both narrow to one value, or a caller can walk the id space.
     */
    const authorization = code("../../../../../packages/auth/src/authorization.ts");
    /*
     * Bounded to the UNION DECLARATION, not to a character window. A window
     * reached into the narrowing function below, where both names legitimately
     * appear as switch cases -- which is the mapping working, not the leak. The
     * first version of this assertion failed on exactly that and is recorded
     * here rather than quietly widened.
     */
    const union = /export type ExternalProfileAccessReason =([\s\S]*?);/.exec(authorization);
    expect(union, "the external reason union was not found").not.toBeNull();
    const members = union?.[1] ?? "";
    expect(members).toContain("profile_unavailable");
    expect(members, "an external reason that names a missing profile is an enumeration oracle").not.toContain(
      "profile_not_found"
    );
    expect(members).not.toContain("profile_not_owned_by_account");
  });
});

describe("no handler treats the machine it is running on as a credential", () => {
  for (const handler of HANDLERS) {
    it(`${handler.split("/").slice(-2).join("/")} names no address and no launch token`, () => {
      const source = code(handler);
      for (const forbidden of [
        "127.0.0.1",
        "localhost",
        "x-forwarded-for",
        "remoteAddress",
        "sidecar"
      ]) {
        expect(source, `${handler} consults ${forbidden}`).not.toContain(forbidden);
      }
    });
  }
});
