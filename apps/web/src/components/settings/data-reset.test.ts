import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAVOURITES_NOT_IMPLEMENTED,
  PORT_THREW,
  noProfileSnapshot,
  type LibraryEntry,
  type LibraryFacet,
  type ProfileLibrarySnapshot
} from "../profiles/profile-library";
import {
  RESET_TARGETS,
  confirmationSentence,
  hasAnythingToReset,
  resetPlan,
  resetTarget,
  verifyPreferencesGone,
  verifyWatchlistGone
} from "./data-reset";

/* -------------------------------------------------------------------------
 * Data reset and deletion (W132-F)
 *
 * THE CLAIM UNDER TEST IS HONESTY, NOT BEHAVIOUR. A delete button is trivially
 * easy to ship dishonestly: it is one request, it returns 200, and the thing a
 * viewer cannot check is the only thing they wanted. So the assertions here are
 * about what the product SAYS matching what it CAN DO -- including a suite that
 * reads the route files, because prose about deletion drifting from the
 * deletion that exists is the defect, and it drifts silently.
 * ---------------------------------------------------------------------- */

const ENTRY = (contentId: string): LibraryEntry => ({
  contentId,
  addedAt: "2026-01-01T00:00:00.000Z"
});

const SNAPSHOT = (
  watchlist: LibraryFacet<LibraryEntry> = { status: "ok", entries: [] },
  profileId: string | null = "profile-a"
): ProfileLibrarySnapshot => ({
  profileId,
  watchlist,
  favourites: FAVOURITES_NOT_IMPLEMENTED,
  history: { status: "ok", entries: [] }
});

describe("what the screen claims it can delete is what the API can delete", () => {
  it("every target marked available has a DELETE behind it", async () => {
    /*
     * THE ASSERTION THIS WHOLE MODULE IS ABOUT. A target that says "available"
     * and has no endpoint is a button that clears the screen and nothing else,
     * and no other test in this repository would notice.
     */
    const routes: Record<string, string> = {
      preferences: "../../app/api/v1/profiles/preferences/route.ts",
      watchlist: "../../app/api/v1/watchlist/[contentId]/route.ts"
    };

    for (const target of RESET_TARGETS) {
      if (target.availability !== "available") continue;
      const path = routes[target.id];
      expect(path, `no route recorded for the available target ${target.id}`).toBeDefined();
      const source = await readFile(new URL(path as string, import.meta.url), "utf8");
      expect(source, `${target.id} claims to be deletable`).toMatch(
        /export async function DELETE/
      );
    }
  });

  it("history and profiles are marked unavailable, and their routes really have no DELETE", async () => {
    /*
     * THE OTHER DIRECTION, and the one that goes stale the moment somebody
     * ships the endpoint: a target still reported as impossible after it became
     * possible is a product telling a household their history cannot be
     * deleted when it can. This test fails when that happens, which is the
     * point -- the fix is to flip the target, not to delete the test.
     */
    const progress = await readFile(
      new URL("../../app/api/v1/progress/[contentId]/route.ts", import.meta.url),
      "utf8"
    );
    expect(progress).not.toMatch(/export async function DELETE/);
    expect(progress).toMatch(/export async function PUT/);

    const profiles = await readFile(
      new URL("../../app/api/v1/profiles/route.ts", import.meta.url),
      "utf8"
    );
    expect(profiles).not.toMatch(/export async function DELETE/);

    for (const id of ["history", "profile", "everything"] as const) {
      const target = resetTarget(id);
      expect(target.availability, id).toBe("no-endpoint");
      expect(target.unavailableBecause, id).not.toBeNull();
      expect((target.unavailableBecause as string).length, id).toBeGreaterThan(40);
    }
  });

  it("an unavailable target offers no removals to confirm", () => {
    /* The structural half of the same rule: there is no code path by which a
     * viewer is shown a list of things that will be deleted for a target that
     * will delete nothing. */
    for (const target of RESET_TARGETS) {
      if (target.availability === "available") continue;
      expect(target.removes, target.id).toEqual([]);
    }
  });

  it("the table is exhaustive over the closed id type", () => {
    const ids = RESET_TARGETS.map((target) => target.id).sort();
    expect(ids).toEqual(["everything", "history", "preferences", "profile", "watchlist"]);
  });

  it("the catalogue cannot be edited for the next caller", () => {
    /* A module-level mutable table is a cross-request leak: one render pushing
     * a target changes what every later render offers. */
    expect(() => {
      (RESET_TARGETS as ResetTargetArray).push(resetTarget("preferences"));
    }).toThrow();
  });
});

type ResetTargetArray = ReturnType<typeof resetTarget>[];

describe("a plan enumerates real requests or refuses to exist", () => {
  it("plans one request for preferences", () => {
    const plan = resetPlan("preferences", SNAPSHOT());
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.requests).toEqual([
      {
        method: "DELETE",
        url: "/api/v1/profiles/preferences",
        describes: "your playback settings"
      }
    ]);
  });

  it("plans one request per watchlist entry, because there is no bulk delete", () => {
    const plan = resetPlan("watchlist", SNAPSHOT({ status: "ok", entries: [ENTRY("a"), ENTRY("b")] }));
    expect(plan.kind).toBe("plan");
    if (plan.kind !== "plan") return;
    expect(plan.requests.map((request) => request.url)).toEqual([
      "/api/v1/watchlist/a",
      "/api/v1/watchlist/b"
    ]);
    expect(plan.confirmation).toContain("2 separate removals");
  });

  it("encodes a content id, because a stored row can hold anything a past build wrote", () => {
    const plan = resetPlan("watchlist", SNAPSHOT({ status: "ok", entries: [ENTRY("a/b?c=1")] }));
    if (plan.kind !== "plan") throw new Error("expected a plan");
    expect(plan.requests[0]?.url).toBe("/api/v1/watchlist/a%2Fb%3Fc%3D1");
  });

  it("REFUSES TO PLAN AGAINST A LIST IT COULD NOT READ", () => {
    /*
     * THE SHARPEST CASE. A failed read must not become a plan with zero
     * requests: that plan would report "done" and leave everything in place,
     * which is the over-promise with a success message attached.
     */
    const plan = resetPlan("watchlist", SNAPSHOT({ status: "unavailable", reason: PORT_THREW }));
    expect(plan.kind).toBe("unavailable");
    if (plan.kind !== "unavailable") return;
    expect(plan.detail).toContain("will not guess");
  });

  it("says there is nothing to do for an empty list rather than planning nothing", () => {
    /* `nothing-to-do` and a zero-request plan look the same to a `.length`
     * check and are completely different to a viewer: one is "your list is
     * already empty", the other is a button that appears to work. */
    const plan = resetPlan("watchlist", SNAPSHOT({ status: "ok", entries: [] }));
    expect(plan.kind).toBe("nothing-to-do");
  });

  it("plans nothing at all with no profile in use", () => {
    for (const id of ["preferences", "watchlist"] as const) {
      const plan = resetPlan(id, noProfileSnapshot());
      expect(plan.kind, id).toBe("unavailable");
    }
  });

  it("never produces a plan for a target with no endpoint", () => {
    for (const id of ["history", "profile", "everything"] as const) {
      const plan = resetPlan(id, SNAPSHOT({ status: "ok", entries: [ENTRY("a")] }));
      expect(plan.kind, id).toBe("unavailable");
    }
  });

  it("no request anywhere in a plan carries a profile id", () => {
    /* PL-0405. Every endpoint derives the scope from the session, so a plan
     * naming a profile would be a client-held scope with a plausible shape. */
    const plan = resetPlan("watchlist", SNAPSHOT({ status: "ok", entries: [ENTRY("a")] }));
    expect(JSON.stringify(plan)).not.toContain("profile-a");
    expect(JSON.stringify(plan)).not.toContain("profileId");
  });
});

describe("the confirmation names what goes, what stays, and how much", () => {
  it("names what will NOT be removed", () => {
    /*
     * AN OMISSION HERE IS A FALSE STATEMENT. A list of removals alone reads as
     * "and nothing else survives", which is how a viewer comes to believe their
     * history went with their watchlist.
     */
    const sentence = confirmationSentence(resetTarget("watchlist"), 3);
    expect(sentence).toContain("does not remove");
    expect(sentence).toContain("where you got to");
    expect(sentence).toContain("this profile itself");
  });

  it("scopes itself to the profile in use and says so", () => {
    const sentence = confirmationSentence(resetTarget("preferences"), 1);
    expect(sentence).toContain("for the profile in use and no other");
  });

  it("says it cannot be undone, because it cannot", () => {
    for (const target of RESET_TARGETS) {
      if (target.availability !== "available") continue;
      expect(confirmationSentence(target, 1), target.id).toContain("cannot be undone");
    }
  });

  it("states the count only when there is more than one removal", () => {
    /* "This is 1 separate removals" is the kind of generated sentence that
     * makes a household distrust the rest of the screen. */
    expect(confirmationSentence(resetTarget("watchlist"), 1)).not.toContain("separate removals");
    expect(confirmationSentence(resetTarget("watchlist"), 37)).toContain("37 separate removals");
  });

  it("is generated from the target, so it cannot describe a removal that will not happen", () => {
    /* Every clause in the sentence comes from `removes`; nothing is written
     * beside the plan. */
    const target = resetTarget("preferences");
    const sentence = confirmationSentence(target, 1);
    for (const clause of target.removes) expect(sentence).toContain(clause);
  });
});

describe("verification asks the store, never the responses", () => {
  it("confirms gone only from a successful fresh read showing nothing", () => {
    expect(verifyWatchlistGone(SNAPSHOT({ status: "ok", entries: [] }))).toEqual({ status: "gone" });
  });

  it("reports partial with a count when something survived", () => {
    const verdict = verifyWatchlistGone(SNAPSHOT({ status: "ok", entries: [ENTRY("a"), ENTRY("b")] }));
    expect(verdict.status).toBe("partial");
    if (verdict.status !== "partial") return;
    expect(verdict.remaining).toBe(2);
    expect(verdict.detail).toContain("2 titles are still on your list");
  });

  it("UNVERIFIED IS NOT GONE", () => {
    /*
     * THE CLAIM THIS MODULE EXISTS TO STOP. A post-reset read that failed
     * proves nothing, and a screen saying "your data is gone" on the strength
     * of a failed read is the one false statement a deletion control must never
     * make -- the viewer cannot check it, so it is unfalsifiable from the
     * screen.
     */
    const verdict = verifyWatchlistGone(SNAPSHOT({ status: "unavailable", reason: PORT_THREW }));
    expect(verdict.status).toBe("unverified");
    expect(verdict.status).not.toBe("gone");
  });

  it("verifies preferences from the stored flag, which is the only thing that can", () => {
    /*
     * "Never chosen" and "chose nothing" have IDENTICAL VALUES -- empty lists
     * either way -- so a verification comparing values could not tell a
     * successful delete from a write of empty lists. `stored` is the proof, and
     * that is why `storedMediaPreferencesSchema` carries it.
     */
    expect(verifyPreferencesGone(false)).toEqual({ status: "gone" });
    expect(verifyPreferencesGone(true).status).toBe("partial");
    expect(verifyPreferencesGone(null).status).toBe("unverified");
  });
});

describe("hasAnythingToReset reads availability, not a length", () => {
  it("is false for a genuinely empty list", () => {
    expect(hasAnythingToReset(SNAPSHOT({ status: "ok", entries: [] }))).toBe(false);
  });

  it("is true for an unreadable list, because 'nothing to delete' would be a guess", () => {
    expect(hasAnythingToReset(SNAPSHOT({ status: "unavailable", reason: PORT_THREW }))).toBe(true);
  });

  it("is true when there is something, and false with no profile", () => {
    expect(hasAnythingToReset(SNAPSHOT({ status: "ok", entries: [ENTRY("a")] }))).toBe(true);
    expect(hasAnythingToReset(noProfileSnapshot())).toBe(false);
  });
});

describe("structural rules", () => {
  it("performs no request and reads no browser storage", async () => {
    /*
     * This module builds plans and verdicts; the component sends them. That
     * split is what lets every rule above be a unit test in a `node`
     * environment with no DOM -- the only place logic in this application can
     * be tested at all.
     */
    const raw = await readFile(new URL("./data-reset.ts", import.meta.url), "utf8");
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "document.cookie", "XMLHttpRequest"]) {
      expect(source, `must not use ${forbidden}`).not.toContain(forbidden);
    }
    expect(source).toContain("export function resetPlan");
  });

  it("names no post-ES5 built-in, because the settings screen ships to the same WebView2", async () => {
    const raw = await readFile(new URL("./data-reset.ts", import.meta.url), "utf8");
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "Object.hasOwn",
      "structuredClone",
      ".toSorted(",
      ".findLast(",
      ".at(",
      "Object.groupBy",
      ".replaceAll(",
      "Array.fromAsync",
      "Promise.withResolvers"
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
