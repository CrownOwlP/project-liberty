import { readFileSync } from "node:fs";

import type { CatalogItem, CatalogRail } from "@liberty/contracts/domains/catalog";
import { describe, expect, it } from "vitest";

import {
  CATALOG_EMPTY_COPY,
  RECOGNISED_CATALOG_ERROR_REASONS,
  SPOTLIGHT_KIND_LABEL,
  catalogErrorCopy,
  selectSpotlight,
  spotlightFacts
} from "./spotlight";

/**
 * What the home hero is allowed to say (W132-B).
 *
 * Every assertion here is over plain values, which is the whole reason the
 * decisions live in `spotlight.ts` and not inside the component:
 * `apps/web/vitest.config.ts` is `environment: "node"`, so a rule that could
 * only be exercised by rendering a page in a browser is a rule nothing would
 * check. `home-ui.test.tsx` renders the markup around these answers.
 */

function movie(
  id: string,
  title: string,
  releaseYear: number,
  runtimeMinutes = 100
): CatalogItem {
  return {
    id,
    title,
    kind: "movie",
    rights: "owned",
    genre: "Sci-fi",
    releaseYear,
    runtimeMinutes,
    episodeCount: null
  };
}

function series(id: string, title: string, releaseYear: number, episodeCount = 8): CatalogItem {
  return {
    id,
    title,
    kind: "series",
    rights: "owned",
    genre: "Drama",
    releaseYear,
    runtimeMinutes: null,
    episodeCount
  };
}

const rail = (id: string, items: readonly CatalogItem[]): CatalogRail => ({
  id,
  title: id,
  items: [...items]
});

describe("which work the hero spotlights", () => {
  it("takes the newest release year, across rails rather than within one", () => {
    /*
     * The property that rules out "the first item of the first rail". Films are
     * listed before series in `RAIL_DEFINITIONS`, so a rail-order rule would
     * answer the 1998 film here and the hero would be decided by
     * merchandising.
     */
    const chosen = selectSpotlight([
      rail("movies", [movie("old-film", "Old Film", 1998)]),
      rail("series", [series("new-show", "New Show", 2024)])
    ]);

    expect(chosen?.id).toBe("new-show");
  });

  it("does not depend on the order the source listed anything in", () => {
    const items = [
      movie("a", "A", 2020),
      movie("b", "B", 2024),
      series("c", "C", 2011),
      movie("d", "D", 2024)
    ];
    const forwards = selectSpotlight([rail("movies", items)]);
    const backwards = selectSpotlight([rail("movies", [...items].reverse())]);

    /* Same works in, same hero out, whatever order they arrived in. */
    expect(forwards?.id).toBe(backwards?.id);
    expect(forwards?.id).toBe("b");
  });

  it("breaks a shared year on the title, and a shared title on the id", () => {
    const byTitle = selectSpotlight([
      rail("movies", [movie("z", "Zodiac", 2024), movie("a", "Arrival", 2024)])
    ]);
    expect(byTitle?.id).toBe("a");

    /* A remake is the ordinary case of one title in two years -- and of one
     * title in ONE year, when nobody recorded the second one's properly. */
    const byId = selectSpotlight([
      rail("movies", [movie("remake-2", "Solaris", 2024), movie("remake-1", "Solaris", 2024)])
    ]);
    expect(byId?.id).toBe("remake-1");
  });

  it("answers null when there is nothing to show, rather than reaching into an empty rail", () => {
    expect(selectSpotlight([])).toBeNull();
    /* `catalogRailSchema` permits `items: []` even though `buildHomeCatalog`
     * never emits one, so the state is representable in the type the component
     * holds. */
    expect(selectSpotlight([rail("movies", []), rail("series", [])])).toBeNull();
  });
});

describe("the facts line under the title", () => {
  it("states the year and reuses the card's own meta formatting", () => {
    expect(spotlightFacts(movie("f", "F", 2024, 128))).toBe("2024 · Sci-fi · 2h 08m");
  });

  it("describes a series by its episode count, because it has no runtime", () => {
    expect(spotlightFacts(series("s", "S", 2019, 12))).toBe("2019 · Drama · 12 episodes");
  });

  it("names every kind the contract has", () => {
    /* A total record over the kind union; a fourth kind is a type error in
     * `spotlight.ts` rather than a blank eyebrow on the first screen. */
    expect(Object.values(SPOTLIGHT_KIND_LABEL).filter((label) => label === "")).toEqual([]);
    expect(SPOTLIGHT_KIND_LABEL.movie).toBe("Film");
    expect(SPOTLIGHT_KIND_LABEL.series).toBe("Series");
    expect(SPOTLIGHT_KIND_LABEL.episode).toBe("Episode");
  });
});

/* -------------------------------------------------------------------------
 * The copy
 * ---------------------------------------------------------------------- */

/**
 * Sentences that are forbidden in every panel, and each one is a line this
 * surface has actually rendered or nearly rendered.
 *
 * The first two are the pair `spotlight.ts`'s own header records: a region
 * nothing evaluates, and an undertaking to license works nobody has undertaken
 * to license. The rest are the softer phrasings of the same promise -- the
 * comment on `no_records_usable` names them explicitly as the ways the promise
 * gets smuggled back in.
 */
const FORBIDDEN = [
  "in your region",
  "as soon as they are licensed",
  "coming soon",
  "check back",
  "stay tuned"
];

const everyPanel = [
  ...Object.values(CATALOG_EMPTY_COPY),
  ...RECOGNISED_CATALOG_ERROR_REASONS.map((reason) => catalogErrorCopy(reason)),
  catalogErrorCopy("a_reason_no_build_has_ever_produced")
];

describe("every panel the hero can render", () => {
  it("promises nothing about the future and asserts nothing about the reader", () => {
    for (const panel of everyPanel) {
      const text = `${panel.heading} ${panel.body}`.toLowerCase();
      for (const forbidden of FORBIDDEN) {
        expect(text, `"${forbidden}" reached a catalog panel`).not.toContain(forbidden);
      }
    }
  });

  it("tells the reader it is not their fault, which is the one thing they can act on", () => {
    for (const panel of everyPanel) {
      expect(panel.body).toContain("Nothing is wrong with your account");
    }
  });

  it("says something different in each one", () => {
    /* Four reasons collapsed into one sentence is the defect the error table
     * exists to remove; identical copy under different headings would be the
     * same defect with more code. */
    const headings = everyPanel.map((panel) => panel.heading);
    expect(new Set(headings).size).toBe(headings.length);
    const bodies = everyPanel.map((panel) => panel.body);
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});

describe("the error panels", () => {
  it("does not tell a reader to retry a state that cannot change", () => {
    /*
     * THE SENTENCE THIS TASK DELETED. `catalog_source_not_configured` is the
     * state of the installed desktop, and the panel it used to get read "try
     * again in a moment" -- a promise that the next render will differ, when
     * nothing a reader can do from this screen configures a metadata source.
     */
    const notConfigured = catalogErrorCopy("catalog_source_not_configured");
    expect(notConfigured.body.toLowerCase()).not.toContain("try again in a moment");
    expect(notConfigured.body).toContain("operator action");

    const failedValidation = catalogErrorCopy("catalog_response_failed_validation");
    expect(failedValidation.body).toContain("same answer");
  });

  it("does tell a reader to retry the one state that is worth retrying", () => {
    expect(catalogErrorCopy("catalog_source_unavailable").body.toLowerCase()).toContain(
      "trying again in a moment"
    );
  });

  it("does not claim to recognise a reason it does not", () => {
    const unknown = catalogErrorCopy("catalog_source_ate_the_homework");
    expect(unknown.heading).toBe("We couldn't load the catalog");
    expect(unknown.body).toContain("does not recognise");
  });

  it("has copy for exactly the reasons the loader can produce", () => {
    /*
     * NON-VACUITY, AND THE GUARD THAT MAKES THIS TABLE MAINTAINABLE.
     * `CatalogLoadError.reason` is typed `string`, so a fourth reason added to
     * `lib/catalog.ts` would compile here, fall through to the unrecognised
     * panel, and read "this build does not recognise the reason it gave" about
     * a reason this build had just introduced. Read off that module's source
     * rather than restated, so adding one fails HERE and names itself.
     */
    const loader = readFileSync(new URL("../../lib/catalog.ts", import.meta.url), "utf8");
    const produced = [...loader.matchAll(/reason:\s*"([a-z_]+)"/g)].map((match) => match[1]);

    expect(produced.length, "found no reason literals; the regex has gone stale").toBeGreaterThan(
      0
    );
    expect([...new Set(produced)].sort()).toEqual([...RECOGNISED_CATALOG_ERROR_REASONS].sort());
  });
});
