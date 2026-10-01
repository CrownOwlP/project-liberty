import { readFileSync } from "node:fs";

import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CatalogCard } from "../catalog-card";
import { ProgressIndicator } from "./progress-indicator";
import {
  RESTART_PARAM,
  RESTART_VALUE,
  isRestartRequested,
  startOverHref
} from "../../lib/continue-watching";

/**
 * The continue-watching surface (PW-0305).
 *
 * Rendered with `react-dom/server` and checked against source, the pattern
 * `profile-ui.test.tsx` and `poster-artwork.test.tsx` established: this
 * workspace's vitest environment is `node`, so there is no DOM and no effect
 * runs. What a server render CAN see is the markup a reader's browser is
 * handed, which is all of this surface -- nothing here is interactive.
 */

const ITEM: CatalogItem = {
  id: "aurora-fall",
  title: "Aurora Fall",
  kind: "movie",
  rights: "owned",
  genre: "Sci-fi",
  releaseYear: 2024,
  runtimeMinutes: 128,
  episodeCount: null
};

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), "utf8")
    /* This suite's subjects explain in prose what they forbid; a rule its own
     * explanation can fail is not a rule. */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("a card without a resume is the card the browse surface already had", () => {
  it("renders no bar, no hidden percentage and no second control", () => {
    /*
     * The compatibility property. Every rail but this one passes no `resume`,
     * so the browse surface is unchanged by this task rather than being a
     * version of a card with its extras switched off.
     */
    const html = renderToStaticMarkup(<CatalogCard item={ITEM} />);
    expect(html).not.toContain("Start over");
    expect(html).not.toContain("watched");
    expect(html).toContain("Aurora Fall");
  });
});

describe("a card with a resume", () => {
  const html = renderToStaticMarkup(
    <CatalogCard
      item={ITEM}
      resume={{ completedFraction: 0.28, startOverHref: "/watch/aurora-fall?restart=1" }}
    />
  );

  it("draws the bar at the watched fraction", () => {
    expect(html).toContain("width:28%");
  });

  it("says the percentage for a reader who cannot see the bar", () => {
    /*
     * Two elements for two audiences. The bar is `aria-hidden` and this
     * sentence is visually hidden, so neither audience gets the other's
     * artefact -- and no `progressbar` role has to invent an accessible name.
     * See `progress-indicator.tsx` for why every candidate name was worse.
     */
    expect(html).toContain("visually-hidden");
    expect(html).toContain("28% watched");
  });

  it("hides the bar itself from assistive technology", () => {
    expect(html).toMatch(/aria-hidden="true"[^>]*>\s*<div[^>]*width:28%/);
  });

  it("offers start over as an ANCHOR -- not a form, and not a button", () => {
    /*
     * A link because it navigates and because it works with no JavaScript --
     * which matters on a rail that is otherwise entirely server-rendered. A
     * form would also have implied that following it writes something; it does
     * not. The stored position is untouched until the player's next heartbeat.
     *
     * THIS ASSERTION WAS REWRITTEN BY PW-0304, AND IT WAS STRENGTHENED RATHER
     * THAN RELAXED. It used to end `expect(html).not.toContain("<button")`,
     * which was a correct shorthand for the property above only while a card
     * had exactly one affordance. PW-0304 mounts the "My List" toggle inside
     * `CatalogCard` -- a button, and a legitimate one that `catalog-card.tsx`
     * has predicted by name since PL-0104 -- so the shorthand began failing for
     * a card that was behaving correctly. It asserted an implementation (this
     * card has no buttons) rather than the property (start over navigates).
     *
     * The three lines that replace it are each sharper than what they replace.
     * The href and the text are now matched as ONE ELEMENT, where before they
     * were two independent `toContain`s that would have passed for an anchor
     * somewhere on the card plus a "Start over" button somewhere else. The
     * button rule now names what it forbids. And the last line states which
     * button the card is allowed to carry, so this file tolerates one named
     * control rather than tolerating any button at all.
     */
    expect(html).toMatch(/<a[^>]*href="\/watch\/aurora-fall\?restart=1"[^>]*>Start over<\/a>/);
    expect(html).not.toContain("<form");
    expect(html, "start over must navigate, not submit").not.toMatch(
      /<button[^>]*>[^<]*Start over/
    );
    expect(html, "the only button a resume card carries is the watchlist toggle").toContain(
      'data-testid="watchlist-control"'
    );
  });

  it("does not repeat the title in any of the additions", () => {
    /*
     * `catalog-card.tsx` argues that the heading IS the accessible name. A
     * start-over control labelled "Start Aurora Fall over" would announce the
     * title twice in a links list, which is the defect that file already
     * refused once for the poster.
     */
    const additions = html.slice(html.indexOf("Sci-fi"));
    expect(additions).not.toContain("Aurora Fall");
  });
});

describe("an unknown runtime renders nothing rather than an empty bar", () => {
  it("omits the track entirely", () => {
    /*
     * `null` is not zero. A bar at 0% would state "barely started" about a
     * title this code cannot measure, and an empty track says it more quietly.
     * The title still appears on the rail and still resumes.
     */
    const html = renderToStaticMarkup(<ProgressIndicator completedFraction={null} />);
    expect(html).toBe("");
  });

  it("still renders the rest of the card", () => {
    const html = renderToStaticMarkup(
      <CatalogCard
        item={ITEM}
        resume={{ completedFraction: null, startOverHref: "/watch/aurora-fall?restart=1" }}
      />
    );
    expect(html).toContain("Start over");
    expect(html).not.toContain("watched");
  });
});

describe("start over is one spelling, read at both ends", () => {
  it("builds the href from the constants the page reads", () => {
    expect(startOverHref("/watch/aurora-fall")).toBe(
      `/watch/aurora-fall?${RESTART_PARAM}=${RESTART_VALUE}`
    );
  });

  it("matches the value exactly rather than testing for presence", () => {
    /*
     * `?restart=0` and `?restart=false` both read as "no" to a person and would
     * both read as "yes" to a truthiness check. The cost of getting that
     * backwards is a viewer losing their place.
     */
    expect(isRestartRequested(RESTART_VALUE)).toBe(true);
    expect(isRestartRequested("0")).toBe(false);
    expect(isRestartRequested("false")).toBe(false);
    expect(isRestartRequested("")).toBe(false);
    expect(isRestartRequested(undefined)).toBe(false);
    expect(isRestartRequested(["0", RESTART_VALUE])).toBe(true);
    expect(isRestartRequested(["0"])).toBe(false);
  });
});

describe("structural rules the rail must keep", () => {
  it("renders the same CatalogCard rather than a copy of it", () => {
    /*
     * Two hand-maintained renderings of one card is how the rails and the
     * source come to disagree about what a title looks like -- the defect
     * `demo-catalog.ts` derives its own rails to avoid. It is asserted over
     * source because the rail is an async server component that reads
     * `headers()`, which a node-environment render cannot supply.
     */
    const rail = source("./continue-watching-rail.tsx");
    expect(rail).toContain("CatalogCard");
    expect(rail).not.toContain("<article");
    expect(rail).not.toContain("PosterArtwork");
  });

  it("renders nothing rather than an error panel", () => {
    /*
     * The asymmetry with the catalog rails, which DO render their failure. This
     * one is supplementary: a viewer who has watched nothing legitimately has
     * no rail, and a panel above the catalog reading "we could not load your
     * progress" would turn that normal case into an alarming message.
     */
    const rail = source("./continue-watching-rail.tsx");
    expect(rail).toMatch(/status !== "ok"\)\s*return null/);
    expect(rail).toMatch(/length === 0\)\s*return null/);
    expect(rail).not.toContain("state-panel");
  });

  it("is mounted in its own Suspense boundary, with no skeleton", () => {
    /*
     * Its own boundary because it reads the identity store and the progress
     * table, and browse must not wait on either -- a shared boundary would make
     * an unreachable database into a slow catalog. `fallback={null}` because a
     * skeleton is a promise that something is coming, and this rail very often
     * resolves to nothing.
     */
    const page = source("../../app/page.tsx");
    expect(page).toContain("<ContinueWatchingRail />");
    expect(page).toContain("<Suspense fallback={null}>");
    /* Non-vacuity: the catalog's own boundary still has its skeleton. */
    expect(page).toContain("<Suspense fallback={<CatalogSkeleton />}>");
  });

  it("does not add a loading.tsx anywhere, which PL-0704 forbids above a notFound", () => {
    /* Asserted here as well as in `route-loading-boundaries.test.ts`, because
     * adding a rail with a wait is exactly the change that tempts somebody to
     * reach for one. */
    const page = source("../../app/page.tsx");
    expect(page).not.toContain("loading.tsx");
  });
});
