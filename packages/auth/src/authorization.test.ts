import { describe, expect, it } from "vitest";
import {
  PROFILE_ACCESS_CHECK_ORDER,
  PROFILE_ACCESS_GRANT_REASONS,
  authorizeProfileAccess,
  authorizeProfileSelection,
  externalProfileAccessReason
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

  it("does not claim the profile was already active, because on this path none is", () => {
    // The defect this asserts against was a lie a type could not catch:
    // selection granted with `active_profile_of_session` on the ONE path where,
    // by construction, no profile is active. It compiled because that was the
    // only grant reason in the union, and the string is what a support engineer
    // reads while asking why a session that had selected nothing was recorded as
    // acting on its active profile.
    const decision = authorizeProfileSelection({
      session: session(null),
      ownership: ownership({ profileId: "profile_kids" })
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.reason).toBe("selectable_profile_of_account");
    expect(decision.reason).not.toBe("active_profile_of_session");
    // The precondition that makes the old reason false, stated so the assertion
    // above cannot be "fixed" by making the fixture select a profile first.
    expect(session(null).activeProfileId).toBeNull();
  });

  it("still grants selection when a DIFFERENT profile is already active", () => {
    // Switching profiles mid-session. The reason must not become
    // `active_profile_of_session` here either: the profile being selected is not
    // the active one -- it is the one about to be.
    const decision = authorizeProfileSelection({
      session: session("profile_adult"),
      ownership: ownership({ profileId: "profile_kids" })
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.reason).toBe("selectable_profile_of_account");
    expect(decision.scope.profileId).toBe("profile_kids");
  });
});

describe("the grant vocabulary", () => {
  it("has one reason per decision function, and they are different", () => {
    const access = authorizeProfileAccess({
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership()
    });
    const selection = authorizeProfileSelection({
      session: session(null),
      ownership: ownership()
    });

    if (!access.allowed || !selection.allowed) throw new Error("expected two grants");
    // Two grants with two preconditions. Collapsing them into one string is
    // what makes a count of `active_profile_of_session` unusable, because half
    // of them would be sessions that had no active profile.
    expect(access.reason).not.toBe(selection.reason);
    expect([...PROFILE_ACCESS_GRANT_REASONS].sort()).toEqual(
      [access.reason, selection.reason].sort()
    );
  });

  it("shares no member with the denial order", () => {
    // The two lists partition the vocabulary. An overlap would mean a reason
    // that both grants and denies -- and `externalProfileAccessReason`, which is
    // total over the denial half, would then be asked what a GRANT looks like on
    // the way out to a caller.
    const grants: readonly string[] = PROFILE_ACCESS_GRANT_REASONS;
    for (const denial of PROFILE_ACCESS_CHECK_ORDER) {
      expect(grants).not.toContain(denial);
    }
  });
});

describe("externalProfileAccessReason", () => {
  /**
   * The enumeration oracle, closed.
   *
   * The internal vocabulary stays sharp -- support and alerting both need
   * `profile_not_owned_by_account` to be a different finding from
   * `profile_not_found`, because only the first is somebody probing another
   * household. What must not happen is that distinction reaching the caller,
   * where it answers "does a profile with this id exist anywhere in the
   * product" one request at a time.
   */
  it("cannot tell a profile that does not exist from one that is not yours", () => {
    const invented = authorizeProfileAccess({
      session: session("profile_ghost"),
      requestedProfileId: "profile_ghost",
      ownership: null
    });
    const somebodyElses = authorizeProfileAccess({
      session: session("profile_adult"),
      requestedProfileId: "profile_adult",
      ownership: ownership({ ownerUserId: OTHER_HOUSEHOLD })
    });

    if (invented.allowed || somebodyElses.allowed) throw new Error("expected two denials");

    // Different findings internally...
    expect(invented.reason).not.toBe(somebodyElses.reason);
    // ...and one indistinguishable answer on the way out. This is the assertion
    // that fails if somebody "improves" the error message.
    expect(externalProfileAccessReason(invented.reason)).toBe("profile_unavailable");
    expect(externalProfileAccessReason(somebodyElses.reason)).toBe(
      externalProfileAccessReason(invented.reason)
    );
  });

  it.each([
    // Reached only for a profile this account already owns, so it reveals
    // nothing the caller did not already have.
    { reason: "profile_archived", external: "profile_archived" },
    { reason: "requested_profile_is_not_active", external: "requested_profile_is_not_active" },
    // A fact about this session. The profile picker cannot be built without it.
    { reason: "no_active_profile_selected", external: "no_active_profile_selected" }
  ] as const)("passes $reason through unchanged", ({ reason, external }) => {
    expect(externalProfileAccessReason(reason)).toBe(external);
  });

  it("has an answer for every denial the decision can reach", () => {
    // Walks PROFILE_ACCESS_CHECK_ORDER rather than an enumerated list, so a
    // reason added to the union without being classified here is caught by this
    // test as well as by the compiler's exhaustiveness check.
    for (const reason of PROFILE_ACCESS_CHECK_ORDER) {
      expect(typeof externalProfileAccessReason(reason)).toBe("string");
    }
  });

  it("never emits a reason that names ownership", () => {
    // The property stated negatively, which is the version that catches the
    // regression: any external vocabulary containing the word "owned" is one
    // that has told the caller whose profile it is.
    const external = PROFILE_ACCESS_CHECK_ORDER.map(externalProfileAccessReason);
    expect(external.filter((reason) => reason.includes("owned"))).toEqual([]);
    expect(external.filter((reason) => reason.includes("not_found"))).toEqual([]);
  });
});
