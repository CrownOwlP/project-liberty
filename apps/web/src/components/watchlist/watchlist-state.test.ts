/* -------------------------------------------------------------------------
 * A refused write must not render as a success (PW-0304).
 *
 * The acceptance names this as "the shape of defect the harnesses in this
 * repository have caught four times", so the cases below are organised around
 * it rather than around the happy path: every outcome the API can return is
 * driven through `settleState` and checked for what the control would DRAW,
 * not for what the function returns in the abstract.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import {
  controlAffordance,
  optimisticState,
  parseWatchlistAnswer,
  restingState,
  settleState,
  watchlistRequest,
  presenceFromList,
  type WatchlistPresence
} from "./watchlist-state";

const answer = (outcome: string, code?: string) =>
  parseWatchlistAnswer({
    outcome,
    reasons: code === undefined ? [] : [{ code, detail: "d" }]
  });

describe("the optimistic flip", () => {
  it("shows the asked-for state immediately and marks itself pending", () => {
    expect(optimisticState("add")).toEqual({
      presence: "on-list",
      pending: "add",
      notice: null
    });
    expect(optimisticState("remove")).toEqual({
      presence: "off-list",
      pending: "remove",
      notice: null
    });
  });

  it("clears a previous notice, so a stale refusal does not read as a fresh one", () => {
    const stale = settleState("off-list", answer("refused", "not_authenticated"));
    expect(stale.notice).not.toBeNull();
    expect(optimisticState("add").notice).toBeNull();
  });
});

describe("a mutation settles from the SERVER'S reason, never from `changed`", () => {
  const cases: ReadonlyArray<readonly [string, WatchlistPresence]> = [
    ["added", "on-list"],
    ["already_present", "on-list"],
    ["removed", "off-list"],
    ["not_present", "off-list"]
  ];

  for (const [code, presence] of cases) {
    it(`${code} leaves the control ${presence} with no notice`, () => {
      /* `already_present` and `not_present` carry `changed: false` and are
       * SUCCESSES -- the API is idempotent because the client is a button
       * behind an unreliable network, and a retry that converges must not read
       * as a failure. */
      expect(settleState("off-list", answer("mutated", code))).toEqual({
        presence,
        pending: null,
        notice: null
      });
    });
  }

  it("believes the server over the intent when the two disagree", () => {
    /* An `add` that comes back `removed` means the list holds what the server
     * says it holds. Drawing the intent instead would be the control lying
     * about state it does not own. */
    expect(settleState("off-list", answer("mutated", "removed")).presence).toBe("off-list");
  });
});

describe("a refusal rolls back and says something true", () => {
  it("restores the presence the list had BEFORE the optimistic flip", () => {
    const settled = settleState("off-list", answer("refused", "not_authenticated"));
    expect(settled.presence).toBe("off-list");
    expect(settled.pending).toBeNull();
    expect(settled.notice).toBe("Sign in to use your list.");
  });

  it("rolls a remove back to on-list, which is the other direction of the same bug", () => {
    const settled = settleState("on-list", answer("refused", "no_active_profile_selected"));
    expect(settled.presence).toBe("on-list");
    expect(settled.notice).toBe("Choose a profile first.");
  });

  it("falls back to a generic sentence rather than inventing one per code", () => {
    const settled = settleState("off-list", answer("refused", "request_malformed"));
    expect(settled.presence).toBe("off-list");
    expect(settled.notice).toBe("Your list could not be updated. Nothing changed.");
  });

  it("distinguishes 'we will not' from 'we could not'", () => {
    expect(settleState("off-list", answer("unavailable", "unexpected_repository_failure")).notice).toBe(
      "Your list is unavailable right now. Nothing changed."
    );
  });

  it("NEVER leaves a refusal looking like a success", () => {
    for (const outcome of ["refused", "unavailable"]) {
      for (const before of ["on-list", "off-list"] as const) {
        const settled = settleState(before, answer(outcome, "profile_archived"));
        expect(settled.presence, `${outcome} from ${before} must not move the control`).toBe(before);
        expect(settled.notice, `${outcome} must say something`).not.toBeNull();
      }
    }
  });
});

describe("an answer this client cannot read is not a success either", () => {
  it("rolls back on a body that is not an envelope", () => {
    for (const body of [null, undefined, 42, "ok", [], {}, { outcome: "surprise" }]) {
      expect(parseWatchlistAnswer(body)).toBeNull();
      expect(settleState("on-list", null)).toEqual({
        presence: "on-list",
        pending: null,
        notice: "Your list could not be updated: the server's answer was not understood."
      });
    }
  });

  it("rolls back on `mutated` carrying a reason this client does not know", () => {
    /* A fifth mutation outcome would fail to compile in `watchlist-state.ts`,
     * but an OLDER client talking to a NEWER server is a real deployment and
     * cannot be type-checked. It must not guess from the intent. */
    const settled = settleState("off-list", answer("mutated", "relocated_to_another_list"));
    expect(settled.presence).toBe("off-list");
    expect(settled.notice).not.toBeNull();
  });

  it("treats a `listed` answer to a mutation as a contract violation", () => {
    const settled = settleState("on-list", answer("listed", "watchlist_listed"));
    expect(settled.presence).toBe("on-list");
    expect(settled.notice).not.toBeNull();
  });

  it("reads a well-formed envelope", () => {
    expect(answer("mutated", "added")).toEqual({ outcome: "mutated", firstReason: "added" });
    expect(answer("refused")).toEqual({ outcome: "refused", firstReason: null });
  });
});

describe("the request and the affordance", () => {
  it("adds with PUT and removes with DELETE, on the published route", () => {
    /*
     * THIS ASSERTION SAID `POST` AND WAS WRONG, which is worth leaving a note
     * about rather than quietly correcting. The route exports PUT and DELETE
     * and answers 405 to a POST; this test restated the implementation's
     * assumption instead of checking it, so the unit gate was green while the
     * control could not add anything. The e2e gate found it. The structural
     * guard that would have found it here lives in `watchlist-ui.test.tsx`,
     * which reads the route module rather than this file's opinion of it.
     */
    expect(watchlistRequest("tt-1", "add")).toEqual({
      url: "/api/v1/watchlist/tt-1",
      method: "PUT"
    });
    expect(watchlistRequest("tt-1", "remove").method).toBe("DELETE");
  });

  it("encodes a content id rather than interpolating it raw", () => {
    expect(watchlistRequest("a/b?c", "add").url).toBe("/api/v1/watchlist/a%2Fb%3Fc");
  });

  it("offers the action that is NOT the current state", () => {
    expect(controlAffordance("off-list")).toEqual({
      label: "Add to My List",
      intent: "add",
      actionable: true
    });
    expect(controlAffordance("on-list")).toEqual({
      label: "Remove from My List",
      intent: "remove",
      actionable: true
    });
  });

  it("is not pressable while the list is unknown, and says nothing it cannot know", () => {
    /* The first paint of a control on a server-rendered card happens before
     * anyone has asked what the list holds. "Add to My List" there would be a
     * lie to a viewer whose list already holds it. */
    const unknown = controlAffordance("unknown");
    expect(unknown.actionable).toBe(false);
    expect(unknown.label).toBe("My List");
  });

  it("derives a starting presence from a list, and `unknown` from no list", () => {
    expect(presenceFromList(["a", "b"], "b")).toBe("on-list");
    expect(presenceFromList(["a", "b"], "c")).toBe("off-list");
    expect(presenceFromList([], "c")).toBe("off-list");
    expect(presenceFromList(null, "c")).toBe("unknown");
  });

  it("rolls a refusal back to `unknown` when that is what it rolled forward from", () => {
    const settled = settleState("unknown", answer("refused", "not_authenticated"));
    expect(settled.presence).toBe("unknown");
    expect(settled.notice).toBe("Sign in to use your list.");
  });

  it("starts at rest with no notice", () => {
    expect(restingState("on-list")).toEqual({ presence: "on-list", pending: null, notice: null });
  });
});
