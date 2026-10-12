import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAVOURITES_NOT_IMPLEMENTED,
  PORT_THREW,
  noProfileSnapshot,
  type HistoryEntry,
  type LibraryEntry,
  type LibraryFacet,
  type ProfileLibrarySnapshot
} from "./profile-library";
import {
  actionableSteps,
  blockedSteps,
  emptyWatchlistCopy,
  onboardingFor
} from "./onboarding";

/* -------------------------------------------------------------------------
 * First-run onboarding (W132-F)
 *
 * THE RULES WORTH TESTING ARE THE ONES ABOUT WHEN IT MUST NOT APPEAR, and
 * about what it must not invite somebody to do. Copy that reads well is not
 * assertable; copy that fires over a failed read, or points at a feature this
 * build does not have, is.
 * ---------------------------------------------------------------------- */

const SNAPSHOT = (
  over: Partial<ProfileLibrarySnapshot> = {}
): ProfileLibrarySnapshot => ({
  profileId: "profile-a",
  watchlist: { status: "ok", entries: [] },
  favourites: FAVOURITES_NOT_IMPLEMENTED,
  history: { status: "ok", entries: [] },
  ...over
});

const ENTRY: LibraryEntry = { contentId: "film-a", addedAt: "2026-01-01T00:00:00.000Z" };
const HISTORY: HistoryEntry = {
  contentId: "film-a",
  positionSeconds: 120,
  runtimeSeconds: 3600,
  updatedAt: "2026-01-01T00:00:00.000Z"
};
const BROKEN: LibraryFacet<never> = { status: "unavailable", reason: PORT_THREW };

describe("it appears exactly when a profile is genuinely empty", () => {
  it("appears for a new profile", () => {
    const onboarding = onboardingFor(SNAPSHOT());
    expect(onboarding).not.toBeNull();
    expect((onboarding as NonNullable<typeof onboarding>).steps.length).toBeGreaterThan(0);
  });

  it("does not appear once there is anything at all", () => {
    expect(onboardingFor(SNAPSHOT({ watchlist: { status: "ok", entries: [ENTRY] } }))).toBeNull();
    expect(onboardingFor(SNAPSHOT({ history: { status: "ok", entries: [HISTORY] } }))).toBeNull();
  });

  it("DOES NOT APPEAR OVER A FAILED READ", () => {
    /*
     * THE DEFECT THIS PREVENTS: cheerful onboarding on top of a real failure,
     * with the failure hidden. A household with forty titles and a database
     * that is down must not be told to add their first one.
     */
    expect(onboardingFor(SNAPSHOT({ watchlist: BROKEN }))).toBeNull();
    expect(onboardingFor(SNAPSHOT({ history: BROKEN }))).toBeNull();
  });

  it("does not appear with no profile in use", () => {
    /* There is nobody whose first run it is, and the screen's own answer is
     * "choose who is watching" rather than an explanation of the product. */
    expect(onboardingFor(noProfileSnapshot())).toBeNull();
  });
});

describe("it never invites somebody to use a feature this build lacks", () => {
  it("marks favourites blocked while there is no favourites storage", () => {
    const onboarding = onboardingFor(SNAPSHOT());
    if (onboarding === null) throw new Error("expected onboarding");
    const ids = actionableSteps(onboarding).map((step) => step.id);
    expect(ids).not.toContain("favourites");
    expect(blockedSteps(onboarding).map((step) => step.id)).toEqual(["favourites"]);
  });

  it("gives every blocked step a reason a person can read", () => {
    const onboarding = onboardingFor(SNAPSHOT());
    if (onboarding === null) throw new Error("expected onboarding");
    for (const step of blockedSteps(onboarding)) {
      expect(step.blocked, step.id).not.toBeNull();
      expect((step.blocked as string).length, step.id).toBeGreaterThan(20);
    }
  });

  it("stops blocking favourites the moment the storage exists", () => {
    /* The step is wired, not hard-coded as impossible: when the facet starts
     * answering `ok`, the invitation appears with no edit here. */
    const onboarding = onboardingFor(
      SNAPSHOT({ favourites: { status: "ok", entries: [] } })
    );
    if (onboarding === null) throw new Error("expected onboarding");
    expect(actionableSteps(onboarding).map((step) => step.id)).toContain("favourites");
    expect(blockedSteps(onboarding)).toEqual([]);
  });

  it("offers browsing before configuring, in that order", () => {
    /*
     * A new viewer has nothing to configure a preference FOR, and a product
     * whose first instruction is "choose your preferred audio languages" is
     * asking a question whose answer cannot be checked against anything.
     */
    const onboarding = onboardingFor(SNAPSHOT());
    if (onboarding === null) throw new Error("expected onboarding");
    const ids = actionableSteps(onboarding).map((step) => step.id);
    expect(ids.indexOf("browse")).toBeLessThan(ids.indexOf("settings"));
    expect(ids[0]).toBe("browse");
  });

  it("every destination is an app-relative path, never an absolute URL", () => {
    /*
     * A full URL in an `href` is an open redirect waiting for somebody to make
     * one of these strings dynamic. `avatar.ts` records the same refusal about
     * `avatarKey`.
     */
    const onboarding = onboardingFor(SNAPSHOT());
    if (onboarding === null) throw new Error("expected onboarding");
    for (const step of onboarding.steps) {
      if (step.href === null) continue;
      expect(step.href, step.id).toMatch(/^\//);
      expect(step.href, step.id).not.toMatch(/^\/\//);
      expect(step.href, step.id).not.toContain(":");
    }
  });

  it("promises no media that may not exist", () => {
    /*
     * THE REPOSITORY RULE, APPLIED TO COPY: the installed desktop has no
     * catalog metadata source, so a list can legitimately be empty. Onboarding
     * must not name a title, and the browse step says so in terms -- an empty
     * catalog is a fact about the files on the machine.
     */
    const onboarding = onboardingFor(SNAPSHOT());
    if (onboarding === null) throw new Error("expected onboarding");
    const browse = onboarding.steps.find((step) => step.id === "browse");
    expect(browse?.detail).toContain("nothing has been added to this library yet");
  });
});

describe("the empty-shelf copy is a narrower question than onboarding", () => {
  it("tells a new profile and a long-standing one apart", () => {
    /*
     * A watchlist can be empty on a profile that is NOT new -- somebody removed
     * their last title -- and explaining the product to them would be the
     * product repeating itself to somebody who has been using it for months.
     */
    const fresh = emptyWatchlistCopy(SNAPSHOT());
    const used = emptyWatchlistCopy(SNAPSHOT({ history: { status: "ok", entries: [HISTORY] } }));
    expect(fresh?.detail).toContain("This profile is new");
    expect(used?.detail).not.toContain("This profile is new");
    expect(used).not.toBeNull();
  });

  it("answers null for a list that is not empty", () => {
    expect(emptyWatchlistCopy(SNAPSHOT({ watchlist: { status: "ok", entries: [ENTRY] } }))).toBeNull();
  });

  it("answers null for a list that could not be read", () => {
    /* An empty state is a claim about the viewer's data, and a failed read is
     * not evidence for one. The caller's failure panel owns that case. */
    expect(emptyWatchlistCopy(SNAPSHOT({ watchlist: BROKEN }))).toBeNull();
  });

  it("always offers somewhere to go", () => {
    const copy = emptyWatchlistCopy(SNAPSHOT());
    expect(copy?.actionHref).toBe("/");
    expect(copy?.actionLabel).not.toBeNull();
  });
});

describe("structural rules", () => {
  it("records nothing about having been seen", async () => {
    /*
     * A "seen it already" flag would need browser storage -- forbidden in this
     * repository by rule -- or a new column. The panel appears while the
     * profile is empty and stops when it is not, which needs nothing stored and
     * cannot get out of step with the thing it describes.
     */
    const raw = await readFile(new URL("./onboarding.ts", import.meta.url), "utf8");
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "document.cookie",
      "Date.now",
      "new Date",
      "fetch("
    ]) {
      expect(source, `must not use ${forbidden}`).not.toContain(forbidden);
    }
    expect(source).toContain("export function onboardingFor");
  });

  it("is pure, so the same snapshot always produces the same copy", () => {
    const snapshot = SNAPSHOT();
    expect(onboardingFor(snapshot)).toEqual(onboardingFor(snapshot));
  });
});
