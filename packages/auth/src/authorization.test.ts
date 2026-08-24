import { describe, expect, it } from "vitest";
import {
  PROFILE_ACCESS_CHECK_ORDER,
  authorizeProfileAccess,
  authorizeProfileSelection
} from "./authorization";
import type { LibertySession, ProfileOwnership } from "./session";
import { scopeBelongsToSession } from "./session";

/**
 * Profile authorization (PL-0402).
 *
 * The properties under test, and how each one goes quietly wrong:
 *
 *   - SCOPED. A `ProfileScope` may exist only where a grant happened. A denial
 *     that returns a scope anyway is the failure that makes every downstream
 *     repository check meaningless, so it is asserted on every denial branch
 *     rather than once.
 *   - PRECEDENCE-STABLE. Several checks can fail at once. Which one is REPORTED
 *     must be a stated policy, not an artefact of statement order, because the
 *     reason code is what a support engineer acts on.
 *   - EXPLAINED. Both branches carry a trail. A grant with no reason is as
 *     unusable as a denial with no reason when the question is "why did this
 *     account get in".
 *   - PURE. No clock is read, so the same inputs give the same decision. There
 *     is no instant parameter to vary, and its ABSENCE is the assertion.
 */

const HOUSEHOLD = "user_household";
const OTHER_HOUSEHOLD = "user_someone_else";

const session = (activeProfileId: string | null): LibertySession => ({
  account: { userId: HOUSEHOLD, sessionId: "session_tv_lounge" },
  activeProfileId
});

const ownership = (over: Partial<ProfileOwnership> = {}): ProfileOwnership => ({
  profileId: "profile_adult",
  ownerUserId: HOUSEHOLD,
  archivedAt: null,
  ...over
});

describe("authorizeProfileAccess", () => {
  it("grants the active profile of the session and mints a scope bound to the account", () => {
    const decision = authorizeProfileAccess({
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership()
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.reason).toBe("active_profile_of_session");
    expect(decision.scope.profileId).toBe("profile_adult");
    expect(scopeBelongsToSession(decision.scope, session("profile_adult"))).toBe(true);
  });

  it("refuses a scope to a session belonging to a different account", () => {
    const decision = authorizeProfileAccess({
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership()
    });
    if (!decision.allowed) throw new Error("expected a grant");

    const otherSession: LibertySession = {
      account: { userId: OTHER_HOUSEHOLD, sessionId: "session_elsewhere" },
      activeProfileId: "profile_adult"
    };
    // A scope is not a bearer token. Carrying it across a session boundary must
    // not silently work, because "the scope was already validated" is exactly
    // the reasoning that produces a cross-account read.
    expect(scopeBelongsToSession(decision.scope, otherSession)).toBe(false);
  });

  it.each([
    {
      name: "no profile selected yet",
      session: session(null),
      requestedProfileId: "profile_adult",
      ownership: ownership(),
      reason: "no_active_profile_selected"
    },
    {
      name: "profile id names nothing",
      session: session("profile_ghost"),
      requestedProfileId: "profile_ghost",
      ownership: null,
      reason: "profile_not_found"
    },
    {
      name: "profile belongs to another household",
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership({ ownerUserId: OTHER_HOUSEHOLD }),
      reason: "profile_not_owned_by_account"
    },
    {
      name: "profile is archived",
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership({ archivedAt: "2026-01-01T00:00:00.000Z" }),
      reason: "profile_archived"
    },
    {
      name: "stale tab asks for a profile the session has since switched away from",
      session: session("profile_kids"),
      requestedProfileId: "profile_adult",
      ownership: ownership(),
      reason: "requested_profile_is_not_active"
    }
  ])("denies with $reason when $name", (testCase) => {
    const decision = authorizeProfileAccess({
      session: testCase.session,
      requestedProfileId: testCase.requestedProfileId,
      ownership: testCase.ownership
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe(testCase.reason);
    // The denial names itself in the trail, and the trail's last entry is the
    // check that failed -- otherwise a caller cannot tell how far it got.
    expect(decision.trail.at(-1)).toEqual({ check: testCase.reason, passed: false });
    expect(decision).not.toHaveProperty("scope");
  });

  it("reports the most serious failure when several are true at once", () => {
    // Archived AND somebody else's. Ownership must win: "not yours" is a
    // security finding and "archived" is a lifecycle one, and collapsing the
    // first into the second is how a cross-account probe looks like a UI bug.
    const decision = authorizeProfileAccess({
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership({ ownerUserId: OTHER_HOUSEHOLD, archivedAt: "2026-01-01T00:00:00.000Z" })
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("profile_not_owned_by_account");
  });

  it("runs its checks in the published precedence order", () => {
    const decision = authorizeProfileAccess({
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership()
    });

    // The grant path runs every check, so its trail is the order itself. This
    // is the assertion that keeps PROFILE_ACCESS_CHECK_ORDER honest as
    // documentation rather than letting it drift into decoration.
    expect(decision.trail.map((entry) => entry.check)).toEqual([...PROFILE_ACCESS_CHECK_ORDER]);
    expect(decision.trail.every((entry) => entry.passed)).toBe(true);
  });

  it("produces an identical decision when called repeatedly with identical input", () => {
    const input = {
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership({ archivedAt: "2026-01-01T00:00:00.000Z" })
    };
    // Determinism, stated as a test rather than as a comment: nothing in the
    // decision reads a clock, a counter or a random source, so two calls
    // separated in time must be indistinguishable.
    expect(authorizeProfileAccess(input)).toEqual(authorizeProfileAccess(input));
  });
});

describe("authorizeProfileSelection", () => {
  it("grants selection of an owned live profile even though no profile is active yet", () => {
    // The profile picker's whole situation. If selection required an active
    // profile, a freshly signed-in session could never acquire one.
    const decision = authorizeProfileSelection({
      session: session(null),
      ownership: ownership({ profileId: "profile_kids" })
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.scope.profileId).toBe("profile_kids");
  });

  it("still refuses another household's profile at selection time", () => {
    const decision = authorizeProfileSelection({
      session: session(null),
      ownership: ownership({ ownerUserId: OTHER_HOUSEHOLD })
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("profile_not_owned_by_account");
  });

  it("refuses to reselect an archived profile", () => {
    const decision = authorizeProfileSelection({
      session: session(null),
      ownership: ownership({ archivedAt: "2026-02-02T00:00:00.000Z" })
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("profile_archived");
  });
});
