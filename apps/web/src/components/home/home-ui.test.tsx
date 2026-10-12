import { readFileSync } from "node:fs";

import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CatalogEmptyCause, CatalogLoadOutcome } from "../../lib/catalog";
import { HomeSpotlight } from "./home-spotlight";
import { CATALOG_EMPTY_COPY, catalogErrorCopy } from "./spotlight";

/**
 * The home hero's markup (W132-B).
 *
 * Rendered with `react-dom/server` and checked against source, the pattern
 * `continue-watching-ui.test.tsx`, `profile-ui.test.tsx` and
 * `poster-artwork.test.tsx` established: this workspace's vitest environment is
 * `node`, so there is no DOM and no effect runs. What a server render CAN see is
 * the markup a reader's browser is handed, and `HomeSpotlight` is a server
 * component with no interactive part -- all of it is in the document.
 */

const FILM: CatalogItem = {
  id: "aurora-fall",
  title: "Aurora Fall",
  kind: "movie",
  rights: "owned",
  genre: "Sci-fi",
  releaseYear: 2024,
  runtimeMinutes: 128,
  episodeCount: null
};

const ok = (items: readonly CatalogItem[]): CatalogLoadOutcome => ({
  status: "ok",
  response: {
    rails: [{ id: "movies", title: "Films", items: [...items] }],
    generatedAt: "2026-10-12T00:00:00.000Z"
  }
});

/**
 * A heading as the server renderer writes it.
 *
 * React escapes `'` in a text node to `&#x27;`, which a browser parses back to
 * U+0027 -- so the rendered page and the accessible name are unaffected, and
 * only a byte-level assertion like the ones below has to know. Applied to the
 * copy rather than hard-coded into the expectation, so a heading that gains an
 * apostrophe does not need this test edited.
 * `e2e/tests/critical-journey.spec.ts` matches the same heading loosely for the
 * related reason: pinning a quote character in a locator is how one silently
 * stops matching after somebody's editor normalises it.
 */
function asRendered(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

const EMPTY_CAUSES: readonly CatalogEmptyCause[] = [
  "catalog_empty",
  "no_records_usable",
  "cause_not_stated"
];

const ERROR_REASONS: readonly string[] = [
  "catalog_source_not_configured",
  "catalog_response_failed_validation",
  "catalog_source_unavailable",
  "a_reason_this_build_does_not_know"
];

/** Every state the hero can be in, which is what the invariants below quantify over. */
const EVERY_STATE: ReadonlyArray<{ name: string; outcome: CatalogLoadOutcome }> = [
  { name: "a spotlit work", outcome: ok([FILM]) },
  {
    name: "an ok outcome with no items, which only the type allows",
    outcome: ok([])
  },
  ...EMPTY_CAUSES.map((cause) => ({
    name: `empty: ${cause}`,
    outcome: { status: "empty", generatedAt: "2026-10-12T00:00:00.000Z", cause } as const
  })),
  ...ERROR_REASONS.map((reason) => ({
    name: `error: ${reason}`,
    outcome: { status: "error", reason } as const
  }))
];

describe("the hero over a catalog that has something in it", () => {
  const html = renderToStaticMarkup(<HomeSpotlight outcome={ok([FILM])} />);

  it("names the work the loader actually returned", () => {
    expect(html).toContain("<h1>Aurora Fall</h1>");
  });

  it("states only facts the contract carries", () => {
    expect(html).toContain("2024 · Sci-fi · 2h 08m");
    expect(html).toContain(">Film<");
  });

  it("opens the title's own page, and does not offer to play anything", () => {
    /*
     * The defect this replaces: a primary button hard-wired to
     * `/watch/aurora-fall`, which on a build with no metadata source pointed at
     * a work the catalog does not list. Whether a title can be played is
     * decided by `resolveTitlePlayAvailability` from the title's stream
     * candidates, which nothing on the home path has loaded.
     */
    expect(html).toMatch(/<a[^>]*href="\/title\/aurora-fall"[^>]*>Open Aurora Fall<\/a>/);
    expect(html, "the home hero must not promise playback it has not checked").not.toContain(
      "/watch/"
    );
  });

  it("offers browse by address rather than by fragment", () => {
    /* The `#catalog` anchor this replaces was one of the dead fragment links
     * `components/shell/navigation.ts` removed from the nav; `/browse` is a
     * route with a `page.tsx`. */
    expect(html).toContain('href="/browse"');
    expect(html).not.toContain('href="#');
  });

  it("does not describe the work in prose nobody wrote", () => {
    /* There is no synopsis, tagline or rating anywhere in the catalog
     * contract. The old hero filled that space with a sentence about an
     * "authorized provider layer" being implemented. */
    expect(html).not.toContain("authorized provider layer");
    expect(html).not.toContain("fictional");
    expect(html).not.toContain("scaffold");
  });
});

describe("the hero over a work it cannot build an address for", () => {
  /*
   * `CatalogItem.id` is `z.string().min(1)`, not a normalized content id, so
   * `resolveCatalogItemRoute` legitimately refuses one. The work is still named
   * and still described; only the promise is withheld.
   */
  const html = renderToStaticMarkup(
    <HomeSpotlight outcome={ok([{ ...FILM, id: "Not A Valid Id" }])} />
  );

  it("still names the work", () => {
    expect(html).toContain("<h1>Aurora Fall</h1>");
  });

  it("renders no primary action at all, rather than a dead or disabled one", () => {
    expect(html).not.toContain("Open Aurora Fall");
    expect(html).not.toContain("disabled");
    expect(html).toContain('href="/browse"');
  });
});

describe("the hero over a catalog with nothing to show", () => {
  for (const cause of EMPTY_CAUSES) {
    it(`states the ${cause} panel and no reason code`, () => {
      const html = renderToStaticMarkup(
        <HomeSpotlight
          outcome={{ status: "empty", generatedAt: "2026-10-12T00:00:00.000Z", cause }}
        />
      );

      expect(html).toContain(`<h1>${asRendered(CATALOG_EMPTY_COPY[cause].heading)}</h1>`);
      /* The ingestion withheld vocabulary never leaves `lib/catalog.ts`, and
       * there is no code to show for an empty catalog. */
      expect(html).not.toContain("state-detail");
    });
  }
});

describe("the hero over a catalog it could not read", () => {
  for (const reason of ERROR_REASONS) {
    it(`states the ${reason} panel, with the code an operator needs`, () => {
      const html = renderToStaticMarkup(<HomeSpotlight outcome={{ status: "error", reason }} />);

      expect(html).toContain(`<h1>${asRendered(catalogErrorCopy(reason).heading)}</h1>`);
      /* `e2e/tests/critical-journey.spec.ts` reads this code to tell a refused
       * source from an empty catalog. */
      expect(html).toContain(reason);
      expect(html).toContain("state-detail");
    });
  }

  it("does not tell the installed desktop to try again", () => {
    const html = renderToStaticMarkup(
      <HomeSpotlight outcome={{ status: "error", reason: "catalog_source_not_configured" }} />
    );
    expect(html).toContain("No catalog source is configured");
    expect(html.toLowerCase()).not.toContain("try again in a moment");
  });
});

describe("what holds in every state", () => {
  for (const { name, outcome } of EVERY_STATE) {
    it(`${name}: exactly one h1, in a hero-shaped slot`, () => {
      const html = renderToStaticMarkup(<HomeSpotlight outcome={outcome} />);

      /*
       * ONE `h1`, ALWAYS. The page's only heading used to be a constant above
       * the boundary, so making the hero catalog-driven is what put this at
       * risk: a document whose sole heading was an `h2` inside a state panel
       * has no `h1` at all. Four branches render through this component and
       * every one of them has to produce exactly one.
       */
      expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
      /*
       * AND THE SLOT IS THE SAME BOX IN ALL OF THEM, which is what makes
       * `.skeleton-hero` a non-shifting fallback: `.hero` fixes the height and
       * `.hero-state` deliberately does not override it.
       */
      expect(html).toMatch(/<section class="hero(\s|")/);
    });
  }
});

/* -------------------------------------------------------------------------
 * The two stylesheet facts the markup above depends on
 *
 * Asserted rather than trusted because both are ORDER-sensitive, and order is
 * the one property of a stylesheet that nothing else in this repository checks
 * -- a later rule with equal specificity silently wins, which is a cascade bug
 * that looks like a markup bug.
 * ---------------------------------------------------------------------- */

describe("globals.css", () => {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

  it("defines .hero-state after .hero, which is the only reason it wins", () => {
    const hero = css.indexOf(".hero {");
    const state = css.indexOf(".hero-state {");
    expect(hero).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(hero);
  });

  it("floors the four-column rail rule above the two-column one", () => {
    /*
     * THE BUG THIS ASSERTION IS ABOUT. `@media (max-width: 900px)` sets `.rail`
     * to two columns and sits earlier in the file. An unfloored
     * `@media (max-width: 1100px)` rule has the same specificity and comes
     * later, so it would win below 900px as well and quietly restore four
     * columns to the narrowest window the product supports.
     */
    expect(css).toContain("@media (min-width: 901px) and (max-width: 1100px)");
  });

  it("keeps the rail hover inside a reduced-motion guard", () => {
    const hover = css.indexOf(".rail .card:hover");
    const guard = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    expect(hover).toBeGreaterThan(-1);
    /* The guard that turns it off has to come after the rule that turns it on,
     * and has to actually turn it off. */
    expect(guard).toBeGreaterThan(hover);
    expect(css.slice(guard)).toContain("transform: none");
  });

  it("keeps the rail stack out of the layout", () => {
    expect(css).toMatch(/\.rail-stack\s*\{\s*display:\s*contents;/);
  });
});
