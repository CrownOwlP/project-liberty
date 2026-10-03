/* -------------------------------------------------------------------------
 * The end-of-playback next-episode prompt (PW-0307).
 *
 * `apps/web/vitest.config.ts` sets `environment: "node"`, so there is no DOM
 * here and no effect runs. `renderToStaticMarkup` produces exactly the markup
 * a browser receives before hydration, which is where the two things that
 * matter in this component live: the address, and the promise the markup makes
 * to a screen reader. Whether the prompt APPEARS when playback ends is a
 * browser question and is `e2e/tests/series-navigation.spec.ts`.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NextUp } from "../../lib/next-episode";
import { NextEpisodePrompt, episodeOrdinal, skippedNote } from "./next-episode-prompt";

function next(overrides: Partial<NextUp> = {}): NextUp {
  return {
    contentId: "northstar-s2e1",
    title: "The Long Dark",
    seasonNumber: 2,
    episodeNumber: 1,
    href: "/watch/northstar-s2e1",
    skippedCount: 0,
    ...overrides
  };
}

describe("what it says", () => {
  it("names the episode by season and number as well as by title", () => {
    /* `S2 E1` and the title are different facts and a viewer uses both: the
     * ordinal tells them where they are in the series, the title tells them
     * what it is. */
    const markup = renderToStaticMarkup(<NextEpisodePrompt next={next()} />);
    expect(markup).toContain("S2 E1");
    expect(markup).toContain("The Long Dark");
  });

  it("SAYS WHEN THE RIGHTS GATE SKIPPED SOMETHING, rather than jumping silently", () => {
    /* A viewer who finishes episode 3 and is offered episode 6 can see that
     * something is missing. A prompt that says nothing looks like a defect in
     * the product rather than a gap in the paperwork. */
    expect(skippedNote(0)).toBeNull();
    expect(skippedNote(1)).toMatch(/1 episode in between is not available/);
    expect(skippedNote(2)).toMatch(/2 episodes in between are not available/);
    const markup = renderToStaticMarkup(<NextEpisodePrompt next={next({ skippedCount: 2 })} />);
    expect(markup).toContain("2 episodes in between are not available here.");
  });

  it("does not say WHY they were skipped, because it does not know", () => {
    /* `rights_not_declared` and `rights_not_playable` are different facts and
     * this surface is handed neither. Claiming one would be a statement about
     * a contract. */
    const markup = renderToStaticMarkup(<NextEpisodePrompt next={next({ skippedCount: 2 })} />);
    expect(markup).not.toMatch(/rights|licen[cs]/i);
  });

  it("renders no note at all when nothing was skipped", () => {
    expect(renderToStaticMarkup(<NextEpisodePrompt next={next()} />)).not.toContain("in between");
  });

  it("formats the ordinal without padding, so S2 E10 is not S2 E010", () => {
    expect(episodeOrdinal(next({ seasonNumber: 2, episodeNumber: 10 }))).toBe("S2 E10");
    expect(episodeOrdinal(next({ seasonNumber: 1, episodeNumber: 1 }))).toBe("S1 E1");
  });
});

describe("the address, which is the part a rights gate depends on", () => {
  it("USES THE href IT WAS GIVEN AND BUILDS NOTHING", () => {
    /*
     * The whole defence. `href` comes from `nextUpFor` -> `resolveNextEpisode`
     * -> `resolvePlayAvailability`, the one gate every episode row is measured
     * by. If this component ever assembles an address it can reach an episode
     * the gate refused, which is the breach PL-0703 was opened for.
     */
    const markup = renderToStaticMarkup(
      <NextEpisodePrompt next={next({ href: "/watch/anything-the-gate-returned" })} />
    );
    expect(markup).toContain('href="/watch/anything-the-gate-returned"');
    /* And it does NOT fall back to the content id when the two differ. */
    expect(markup).not.toContain('href="/watch/northstar-s2e1"');
  });

  it("CONTAINS NO PATH CONSTRUCTION IN ITS SOURCE, checked mechanically", () => {
    /*
     * A rule about a module that is checked by review is a rule that holds
     * until the first hurried afternoon -- `player-adapter.ts` says the same
     * thing about its import graph and tests it the same way. Any `/watch`
     * literal in this file would be an address this component knows how to
     * build.
     */
    const source = readFileSync(new URL("./next-episode-prompt.tsx", import.meta.url), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/["'`]\/watch/);
    expect(code).not.toMatch(/watchHref|titleHref/);
  });

  it("is a LINK and not a button, because it navigates through the ordinary route", () => {
    /* A button wired to a bespoke "play next" would be the special playback
     * path that skips the session request and the authorization decision. */
    const markup = renderToStaticMarkup(<NextEpisodePrompt next={next()} />);
    expect(markup).toMatch(/<a [^>]*href=/);
    expect(markup).not.toContain("<button");
  });
});

describe("what it promises a screen reader", () => {
  it("is a named region, and NOT an alert", () => {
    /* An alert interrupts. A programme ending is not an emergency, and a
     * player that shouted at the end of every episode would be a player people
     * turn off. */
    const markup = renderToStaticMarkup(<NextEpisodePrompt next={next()} />);
    expect(markup).toContain('aria-labelledby="next-episode-heading"');
    expect(markup).toContain('id="next-episode-heading"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("aria-live");
  });

  it("gives the link an accessible name that says what it plays", () => {
    /* "Play" alone is the link text a screen-reader user meets out of context
     * in a list of links, and it tells them nothing. */
    const markup = renderToStaticMarkup(<NextEpisodePrompt next={next()} />);
    expect(markup).toContain("Play S2 E1");
  });

  it("COUNTS DOWN NOTHING AND AUTOPLAYS NOTHING, checked in the source", () => {
    /*
     * The acceptance forbids an autoplay that skips the rights check. This
     * component goes further and autoplays nothing at all, which is a
     * property worth protecting mechanically rather than by intention: a
     * timer added here later would start playback nobody asked for.
     */
    const source = readFileSync(new URL("./next-episode-prompt.tsx", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(code).not.toMatch(/router\.(push|replace)|location\.(assign|href)/);
  });
});
