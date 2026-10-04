import { NO_MEDIA_PREFERENCES } from "@liberty/contracts/domains/preferences";
import { describe, expect, it } from "vitest";

import { loadMediaPreferences } from "./viewer-preferences";

/* -------------------------------------------------------------------------
 * WHAT THIS SUITE CAN HONESTLY ASSERT, AND WHAT IT LEAVES TO THE E2E
 *
 * `loadMediaPreferences` resolves the REAL environment -- the repository
 * adapter this deployment is configured with, the real identity system, the
 * real profile authorization -- exactly as `loadResumePosition` does, and for
 * the same reason: it is the thing a server render actually calls, and a
 * version of it with a store injected would be a different function from the
 * one that ships.
 *
 * So this suite does not fake a database to watch a stored row come back. It
 * asserts the property that holds in EVERY environment and is the one a
 * playback page depends on: a read that cannot be satisfied answers "nobody
 * has chosen" rather than throwing, and the value it answers with is the
 * neutral one. Under the unit environment there is no identity system
 * configured, so every call here takes a failure path -- which is precisely
 * the path worth pinning, because it is the one that runs when something is
 * wrong and the one a viewer must not notice.
 *
 * The success path -- a profile with a stored row getting its own languages
 * into the session request -- is proven where it can be proven for real: the
 * handler suite for the endpoint that writes the row, the watch-session suite
 * for what the page does with the answer, and the e2e against a real database.
 * ---------------------------------------------------------------------- */

describe("a viewer whose preferences cannot be read", () => {
  it("is reported as not having chosen, rather than as having chosen nothing", async () => {
    /*
     * THE DIRECTION IS THE WHOLE TEST. `stored: false` sends the watch page
     * down the "use the conservative default" branch; `stored: true` with
     * empty lists would send it down the "this viewer prefers no language"
     * branch. A failed read must land on the behaviour the product already
     * had, not on an opt-out the viewer never expressed.
     */
    const answer = await loadMediaPreferences(new Headers());

    expect(answer.stored).toBe(false);
    expect(answer.preferences).toEqual(NO_MEDIA_PREFERENCES);
  });

  it("does not throw on a header bag it cannot make sense of", async () => {
    /*
     * This runs inside the watch page's render. A page whose failure mode is a
     * stack trace is a page with no player on it, which is the trade this
     * loader refuses to make for a settings lookup.
     */
    const headers = new Headers({
      cookie: "liberty_session=not-a-session",
      "x-liberty-development-account": "",
      "x-not-yet-invented": "carried"
    });

    await expect(loadMediaPreferences(headers)).resolves.toMatchObject({ stored: false });
  });

  it("hands back a value a caller cannot mutate for the next caller", async () => {
    /*
     * Every failure answers the same shared constant. If it were mutable, one
     * caller pushing a language onto the list it was given would change what
     * every later render saw -- a cross-request leak through a module-level
     * object, which is the kind of bug that only appears under load.
     */
    const first = await loadMediaPreferences(new Headers());

    expect(() => {
      (first.preferences.preferredAudioLanguages as string[]).push("en");
    }).toThrow();

    const second = await loadMediaPreferences(new Headers());
    expect(second.preferences.preferredAudioLanguages).toEqual([]);
  });
});
