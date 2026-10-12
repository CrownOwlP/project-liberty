import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FAVOURITES_NOT_IMPLEMENTED,
  PORT_THREW,
  noProfileSnapshot,
  type LibraryEntry,
  type LibraryFacet,
  type ProfileLibrarySnapshot
} from "../profiles/profile-library";
import { LibraryOnboarding } from "./library-onboarding";

/* -------------------------------------------------------------------------
 * The two sections W132-F added to /settings
 *
 * ONLY `LibraryOnboarding` IS RENDERED HERE, AND THAT IS NOT AN OVERSIGHT.
 * `apps/web/vitest.config.ts` sets `environment: "node"`, and this repository
 * has already established what that costs: a `"use client"` component
 * rendering `next/link` cannot be rendered at all -- React throws "invariant
 * expected app router to be mounted". `DataResetSection` is a client component
 * with state, effects and `fetch`, so its BEHAVIOUR is not assertable here and
 * is not faked here either; its decisions all live in `data-reset.ts`, where
 * `data-reset.test.ts` tests them against a table. What is left for this file
 * is the server render, plus structural rules about the client component that a
 * later edit could quietly break -- the pattern `settings.test.tsx` and
 * `profile-ui.test.tsx` both use.
 * ---------------------------------------------------------------------- */

async function sourceOf(file: string): Promise<string> {
  const raw = await readFile(new URL(file, import.meta.url), "utf8");
  /* Comments stripped first: these components' headers discuss the things the
   * rules forbid, and a rule its own explanation can fail is not a rule. */
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const ENTRY: LibraryEntry = { contentId: "film-a", addedAt: "2026-01-01T00:00:00.000Z" };

const SNAPSHOT = (over: Partial<ProfileLibrarySnapshot> = {}): ProfileLibrarySnapshot => ({
  profileId: "profile-a",
  watchlist: { status: "ok", entries: [] },
  favourites: FAVOURITES_NOT_IMPLEMENTED,
  history: { status: "ok", entries: [] },
  ...over
});

const BROKEN: LibraryFacet<never> = { status: "unavailable", reason: PORT_THREW };

describe("the first-run panel", () => {
  it("explains what fills an empty profile instead of showing a blank space", () => {
    const html = renderToStaticMarkup(<LibraryOnboarding snapshot={SNAPSHOT()} />);
    expect(html).toContain("This profile is new");
    expect(html).toContain("Find something to watch");
    expect(html).toContain('href="/watchlist"');
  });

  it("disappears entirely once there is anything on the profile", () => {
    const html = renderToStaticMarkup(
      <LibraryOnboarding snapshot={SNAPSHOT({ watchlist: { status: "ok", entries: [ENTRY] } })} />
    );
    expect(html).toBe("");
  });

  it("DOES NOT APPEAR OVER A FAILED READ", () => {
    /*
     * The defect: cheerful onboarding on top of a real failure, with the
     * failure hidden. A household with forty titles and a database that is
     * down must not be told to add their first one.
     */
    expect(renderToStaticMarkup(<LibraryOnboarding snapshot={SNAPSHOT({ watchlist: BROKEN })} />)).toBe(
      ""
    );
    expect(renderToStaticMarkup(<LibraryOnboarding snapshot={SNAPSHOT({ history: BROKEN })} />)).toBe(
      ""
    );
  });

  it("does not appear when nobody has chosen a profile", () => {
    expect(renderToStaticMarkup(<LibraryOnboarding snapshot={noProfileSnapshot()} />)).toBe("");
  });

  it("names the favourites gap rather than inviting somebody to use it", () => {
    /*
     * A household that has used other players looks for favourites and, not
     * finding them, concludes it is using this one wrongly. The gap appears in
     * its own list under its own heading, never as a step with a missing link.
     */
    const html = renderToStaticMarkup(<LibraryOnboarding snapshot={SNAPSHOT()} />);
    expect(html).toContain("Not in this build");
    expect(html).toContain("no favourites storage");
    /* And it is not a link, because there is nowhere for it to go. */
    expect(html).not.toContain('href="/favourites"');
  });

  it("promises no title, because this installation may have none", () => {
    /*
     * THE REPOSITORY RULE APPLIED TO COPY. The installed desktop has no catalog
     * metadata source, so a list can legitimately be empty, and onboarding must
     * not stand in a placeholder title. The browse step says so in terms.
     */
    const html = renderToStaticMarkup(<LibraryOnboarding snapshot={SNAPSHOT()} />);
    expect(html).toContain("nothing has been added to this library yet");
  });

  it("stays a server component, so it remains testable at all", async () => {
    /*
     * The moment this gains `"use client"` and keeps its `next/link`, every
     * assertion above stops being possible -- React throws rather than
     * rendering. The rule is the reason the decisions live in `onboarding.ts`
     * and this file only draws them.
     */
    const source = await sourceOf("./library-onboarding.tsx");
    expect(source).not.toContain('"use client"');
    expect(source).not.toContain("useState");
    expect(source).not.toContain("useEffect");
    expect(source).not.toContain("fetch(");
  });

  it("chooses no copy of its own", async () => {
    /*
     * Every sentence comes from `profiles/onboarding.ts`, where it is unit
     * tested. A component that wrote its own would be copy nothing can check.
     */
    const source = await sourceOf("./library-onboarding.tsx");
    expect(source).toContain("onboardingFor(snapshot)");
    expect(source).toContain("actionableSteps(onboarding)");
    expect(source).toContain("blockedSteps(onboarding)");
  });
});

describe("the reset section's structural rules", () => {
  it("verifies against a fresh read and not against the delete responses", async () => {
    /*
     * THE ASSERTION THE WHOLE FEATURE TURNS ON. "Every DELETE answered 2xx, so
     * it worked" is the one verification that cannot catch an endpoint that
     * answers 200 and deletes nothing -- and a deletion is the version of that
     * defect with the highest cost, because the viewer's belief is
     * unfalsifiable from the screen.
     */
    const source = await sourceOf("./data-reset-section.tsx");
    expect(source).toContain("verifyWatchlistGone");
    expect(source).toContain("verifyPreferencesGone");
    expect(source).toContain("reReadWatchlist");
    /* And the verdict is NOT derived from a status code anywhere. */
    expect(source).not.toMatch(/response\.ok/);
    expect(source).not.toMatch(/status\s*===\s*200/);
  });

  it("uses no browser confirm dialog", async () => {
    /*
     * `confirm()` is unstyled, untranslatable, invisible to the page's own
     * assistive-technology affordances, and not guaranteed to appear at all in
     * a packaged WebView2 build. The confirmation is in the document.
     */
    const source = await sourceOf("./data-reset-section.tsx");
    for (const forbidden of ["window.confirm", "confirm(", "window.alert", "alert("]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("takes two presses: a confirming phase exists between the button and the request", async () => {
    const source = await sourceOf("./data-reset-section.tsx");
    expect(source).toContain('kind: "confirming"');
    expect(source).toContain("phase.plan.confirmation");
    /* The removal runs from the confirming phase's plan, never straight from
     * the first button. */
    const first = source.indexOf('setPhase({ kind: "confirming", plan })');
    expect(first).toBeGreaterThan(-1);
  });

  it("names no profile and reads no browser storage", async () => {
    /*
     * PL-0405. Every endpoint derives the scope from the session and
     * `resetPlan` builds URLs with no room for one, so this component could not
     * address another household's data if it tried. Browser storage is
     * forbidden in this repository by rule.
     */
    const source = await sourceOf("./data-reset-section.tsx");
    for (const forbidden of [
      "profileId",
      "localStorage",
      "sessionStorage",
      "document.cookie",
      "URLSearchParams"
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("builds every request from a plan rather than writing a URL", async () => {
    /*
     * The plan is what the confirmation sentence is generated from. A URL
     * written here would be a removal the viewer was never shown.
     */
    const source = await sourceOf("./data-reset-section.tsx");
    expect(source).toContain("request.url");
    expect(source).toContain("method: request.method");
    expect(source).not.toMatch(/fetch\("\/api\/v1\/watchlist\//);
  });

  it("reads the two endpoints it verifies with, and no third one", async () => {
    const source = await sourceOf("./data-reset-section.tsx");
    const urls = source.match(/fetch\(\s*"([^"]+)"/g) ?? [];
    expect(urls.sort()).toEqual([
      'fetch("/api/v1/profiles/preferences"',
      'fetch("/api/v1/watchlist"'
    ]);
  });

  it("the page reads the library once and hands it to both sections", async () => {
    /*
     * Reading it twice would be two queries that can disagree: a snapshot whose
     * watchlist is empty in the panel and holds three entries in the
     * confirmation sentence beside it.
     */
    const source = await sourceOf("../../app/settings/page.tsx");
    expect(source.match(/loadProfileLibrary\(/g) ?? []).toHaveLength(1);
    expect(source).toContain("<LibraryOnboarding snapshot={library} />");
    expect(source).toContain("<DataResetSection snapshot={library} />");
  });

  it("a signed-out viewer never reaches the repository", async () => {
    const source = await sourceOf("../../app/settings/page.tsx");
    expect(source).toContain('account.kind === "signed-out"');
    expect(source).toContain("noProfileSnapshot()");
  });
});
