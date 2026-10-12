import type { CatalogItem, CatalogItemKind, CatalogRail } from "@liberty/contracts/domains/catalog";

import { formatCatalogMeta, type CatalogEmptyCause } from "../../lib/catalog";

/* -------------------------------------------------------------------------
 * WHAT THE HOME HERO IS ALLOWED TO SAY ABOUT THE CATALOG (W132-B)
 *
 * ==========================================================================
 * THE DEFECT CLASS THIS MODULE REMOVES: A HERO THAT DESCRIBED A CATALOG IT
 * HAD NEVER READ
 * ==========================================================================
 *
 * `app/page.tsx` used to open with a hero whose every word was a constant:
 * "One place. Fast playback. Clear decisions.", a paragraph announcing that the
 * surface "uses fictional catalog data while the authorized provider layer is
 * implemented", and two buttons -- one of them hard-wired to
 * `/watch/aurora-fall`, a FICTIONAL TITLE FROM THE FIXTURE ARRAY.
 *
 * Every one of those is a claim, and on the installed desktop -- whose startup
 * log reads `catalog metadata source: none requested` -- all three were false at
 * once. There was no provider layer being waited on, there was no fictional
 * catalog to use because no source was configured at all, and the primary
 * button pointed at a work that does not exist, so the single largest control
 * on the first screen of the product was a link to a 404. Below it, the panel
 * that DID read the loader said, correctly, that there was no catalog. A page
 * that contradicts itself in two adjacent sections teaches a reader to trust
 * neither half.
 *
 * So the hero now says what the loader found and nothing else: a work the
 * catalog actually lists, or the reason there is none. Which means this module
 * -- not a component -- owns two decisions: WHICH work, and WHAT WORDS for each
 * state the loader can report. Both are plain data and plain functions over
 * plain values, because `apps/web/vitest.config.ts` is `environment: "node"`:
 * a rule that can only be exercised by rendering a page in a browser is a rule
 * that drifts, which is the same argument `lib/a11y/roving.ts` and
 * `lib/continue-watching.ts` make about their own policy constants.
 *
 * ==========================================================================
 * WHAT THIS MODULE REFUSES TO INVENT
 * ==========================================================================
 *
 * A `CatalogItem` carries `id`, `title`, `kind`, `rights`, `genre`,
 * `releaseYear`, `artwork` and ONE shape field (`runtimeMinutes` for a movie or
 * episode, `episodeCount` for a series). There is no synopsis, no tagline, no
 * rating, no "added on" and no popularity anywhere in
 * `@liberty/contracts/domains/catalog`, and `lib/catalog-source.ts` states
 * outright that "a record here carries no age". So the hero shows the fields
 * that exist and has no prose slot for the ones that do not. A placeholder
 * sentence under a real title -- "An epic journey begins" -- would be the same
 * defect as the old hero with the work's own name on it.
 * ---------------------------------------------------------------------- */

/**
 * What the eyebrow above the spotlight title says.
 *
 * A total `Record` over the contract's kind union rather than a lookup with a
 * fallback, so a fourth `CatalogItemKind` is a type error here instead of an
 * empty line on the first screen of the product.
 *
 * NOT IMPORTED FROM `components/title/title-hero.tsx`, which has a table that
 * reads identically. That one is keyed by `TitleDetailKind` from the TITLE
 * contract, which is a different union that happens to share three spellings
 * today, and that file is another task's write surface. Two tables over two
 * unions is the honest arrangement; one table over one union, used for both,
 * would be a shared vocabulary neither contract has agreed to.
 */
export const SPOTLIGHT_KIND_LABEL: Readonly<Record<CatalogItemKind, string>> = {
  movie: "Film",
  series: "Series",
  episode: "Episode"
};

/**
 * Which work the hero shows.
 *
 * DETERMINISTIC, AND THAT IS A REQUIREMENT RATHER THAN A PREFERENCE. This runs
 * inside a server render of `/`, so a rotating or randomised spotlight is a
 * first screen that differs between the document and any re-render of it, a
 * hero nobody can screenshot in a bug report, and a page whose hydration has to
 * agree with a choice made before it. Same rails in, same work out, no clock
 * and no entropy.
 *
 * THE RULE IS THE NEWEST RELEASE YEAR, tie-broken by title and then by id so
 * the order is total. Two alternatives were considered:
 *
 *   - THE FIRST ITEM OF THE FIRST RAIL. One line, and it makes the spotlight a
 *     property of RAIL ORDER -- which is merchandising. `RAIL_DEFINITIONS` in
 *     `lib/catalog.ts` lists films before series for reasons that have nothing
 *     to do with what deserves the hero, and inserting a rail would silently
 *     move the first screen of the product.
 *   - THE MOST RECENTLY ADDED WORK, which is what a streaming hero usually
 *     shows and which this catalog cannot express. Nothing in the contract
 *     carries an ingestion date; see the header. `releaseYear` is NOT that
 *     date, and no copy in this module or in `home-spotlight.tsx` calls the
 *     spotlight new, recent or added -- it is simply the newest work the
 *     catalog lists, and it is presented without any claim about when it
 *     arrived here.
 *
 * `null` WHEN THERE IS NOTHING TO SHOW. `loadHomeCatalog` cannot produce an
 * `ok` outcome with no items -- `buildHomeCatalog` drops empty rails and the
 * loader converts a railless response into the `empty` branch -- but
 * `catalogRailSchema` permits `items: []`, so the state is representable in the
 * type the caller holds. Answering `null` lets the component state the truthful
 * empty case instead of reaching into an empty array.
 */
export function selectSpotlight(rails: readonly CatalogRail[]): CatalogItem | null {
  let best: CatalogItem | null = null;
  for (const rail of rails) {
    for (const item of rail.items) {
      if (best === null || isBetterSpotlight(item, best)) best = item;
    }
  }
  return best;
}

/** Strictly "should the hero show `candidate` instead of `incumbent`". */
function isBetterSpotlight(candidate: CatalogItem, incumbent: CatalogItem): boolean {
  if (candidate.releaseYear !== incumbent.releaseYear) {
    return candidate.releaseYear > incumbent.releaseYear;
  }
  const byTitle = candidate.title.localeCompare(incumbent.title);
  if (byTitle !== 0) return byTitle < 0;
  /*
   * The id is the last resort and it is what makes the order TOTAL. Two works
   * can share a title and a year -- a remake is the ordinary case -- and
   * without this the winner would depend on the order the source happened to
   * list them in, which is the non-determinism the whole function exists to
   * avoid.
   */
  return candidate.id.localeCompare(incumbent.id) < 0;
}

/**
 * The line under the spotlight title: every structured fact the contract
 * carries, and no others.
 *
 * `formatCatalogMeta` IS REUSED RATHER THAN RESTATED, so the hero and the cards
 * below it describe a work the same way. The year is prepended here because the
 * cards do not show it and the hero has room for it; it is NOT folded into
 * `formatCatalogMeta`, which would change every card in the product from a file
 * that owns neither.
 */
export function spotlightFacts(item: CatalogItem): string {
  return `${String(item.releaseYear)} · ${formatCatalogMeta(item)}`;
}

/** One state of the catalog, stated in the hero. */
export interface CatalogStateCopy {
  readonly heading: string;
  readonly body: string;
}

/* -------------------------------------------------------------------------
 * THE EMPTY PANEL IS THREE PANELS, BECAUSE EMPTY IS THREE THINGS
 *
 * MOVED HERE FROM `app/page.tsx`, UNCHANGED IN WORDING, because the hero is now
 * where a catalog with nothing in it is reported and a page that stated it in
 * two places would state it twice. The argument below is the original one and
 * is still the whole justification for the table.
 *
 * This used to be one component reading "No titles are currently available in
 * your region. New titles appear here as soon as they are licensed." Both
 * sentences were wrong, and in the two ways this task is about.
 *
 * THE FIRST SENTENCE ASSERTED A CAUSE NOTHING HAD ESTABLISHED. Nothing in this
 * application evaluates a reader's region on the home path, so "in your region"
 * was a guess rendered as a fact, and it is exactly the sentence
 * `lib/catalog-source-registry.ts` names as the failure mode of collapsing the
 * four states -- the line that ends up on screen when nothing has ever been
 * ingested.
 *
 * THE SECOND SENTENCE MADE A PROMISE NOBODY HAD MADE. "New titles appear here as
 * soon as they are licensed" commits this operator to obtaining rights. In the
 * state this task is really about -- records exist and every one of them was
 * withheld for want of a rights basis -- that is the single most misleading thing
 * the page could say, because it reads as "coming soon" for works no one has
 * undertaken to license, or ever will. Nothing in the repository backs it, so
 * nothing on the page says it, for any of the three causes.
 *
 * WHAT THE COPY IS ALLOWED TO SAY. What is true of the catalog, what is not the
 * reader's fault, and nothing about the future. And NOT the withheld reasons:
 * `rights_basis_not_declared` and its siblings are `@liberty/catalog-ingestion`'s
 * internal policy vocabulary, meaningful to an operator reading a log and to
 * nobody else. They never leave `lib/catalog.ts` -- the loader carries a cause,
 * not a reason list -- so there is nothing here to leak even by accident.
 * ---------------------------------------------------------------------- */

export const CATALOG_EMPTY_COPY: Readonly<Record<CatalogEmptyCause, CatalogStateCopy>> = {
  /*
   * The source listed nothing. A fact with no remedy, so the panel states it and
   * stops -- no region, no timeline, no undertaking.
   */
  catalog_empty: {
    heading: "There is nothing in this catalog yet",
    body:
      "The catalog behind this service has no titles in it. Nothing is wrong with your account."
  },
  /*
   * Records exist and not one of them may be shown here. The reader is told that
   * much, told it is not about them, and told -- plainly -- that nobody can say
   * whether it changes. "We cannot say whether any of them will become
   * available" is the whole point of this panel: it is the honest answer, and
   * every softer phrasing of it ("yet", "for now", "check back") smuggles the
   * promise back in.
   */
  no_records_usable: {
    heading: "Nothing here can be shown right now",
    body:
      "This catalog has titles in it, but none of them can be shown on this service. " +
      "Nothing is wrong with your account and there is nothing for you to do. " +
      "We cannot say whether any of them will become available."
  },
  /*
   * The source cannot tell the two apart, so the panel claims neither. It does
   * not guess, and it does not describe the gap in the source to a reader who
   * has no use for it.
   */
  cause_not_stated: {
    heading: "Nothing to watch yet",
    body: "There are no titles to show right now. Nothing is wrong with your account."
  }
};

/* -------------------------------------------------------------------------
 * AND THE ERROR PANEL IS FOUR PANELS, FOR THE SAME REASON (W132-B)
 *
 * THE DEFECT CLASS: ONE SENTENCE READ OUT FOR THREE UNRELATED FAULTS, AND IT
 * WAS FALSE FOR THE ONLY ONE ANYBODY ACTUALLY HITS. The panel this replaces
 * read "The catalog service didn't return a usable response. Nothing is wrong
 * with your account - try again in a moment." under the heading "We couldn't
 * load the catalog", for every value of `CatalogLoadError.reason`.
 *
 * `loadHomeCatalog` produces exactly three of them, and they are three
 * different facts with three different remedies:
 *
 *   - `catalog_source_not_configured` -- no metadata source exists to ask. This
 *     is the state of the INSTALLED DESKTOP (`catalog metadata source: none
 *     requested`), so it is the sentence most readers of this product have
 *     actually seen, and it was the one the old copy got most wrong. No service
 *     failed to respond, because none was asked. "Try again in a moment" is a
 *     promise that the next render will differ, and it cannot: nothing a reader
 *     can do from this screen configures a source.
 *   - `catalog_response_failed_validation` -- a source answered and the payload
 *     did not parse against `catalogHomeResponseSchema`. Retrying reproduces it
 *     exactly until the source or this build changes.
 *   - `catalog_source_unavailable` -- the source threw. This is the ONE state
 *     where "try again" is a reasonable thing to tell somebody, and keeping
 *     that sentence out of the other two is what makes it worth anything here.
 *
 * THE FOURTH PANEL IS THE UNRECOGNISED CODE, AND IT KEEPS THE OLD HEADING.
 * `CatalogLoadError.reason` is typed `string`, not a union of the three above,
 * so a reason this table does not know is representable and a `Record` lookup
 * over it would render `undefined`. The fallback says that a reason was given
 * and this build does not recognise it -- which is the honest description of
 * that state -- rather than guessing at one of the three.
 *
 * THE REASON CODE IS STILL RENDERED, in every one of the four. It is the only
 * part of this panel an operator can act on, `e2e/tests/critical-journey.spec.ts`
 * reads it to tell a refused source from an empty catalog, and unlike the
 * catalog-ingestion withheld vocabulary it names a state of THIS application
 * rather than a policy decision about somebody's rights.
 * ---------------------------------------------------------------------- */

const CATALOG_ERROR_COPY: Readonly<Record<string, CatalogStateCopy>> = {
  catalog_source_not_configured: {
    heading: "No catalog source is configured",
    body:
      "This installation has no metadata source to read a catalog from, so there is nothing " +
      "to list. Nothing is wrong with your account, and nothing on this screen will change " +
      "it: configuring a source is an operator action."
  },
  catalog_response_failed_validation: {
    heading: "The catalog answered with something this build cannot read",
    body:
      "A source answered, and the response did not match the catalog contract this build " +
      "checks every payload against. Nothing is wrong with your account, and retrying will " +
      "produce the same answer until the source or this build changes."
  },
  catalog_source_unavailable: {
    heading: "The catalog source could not be reached",
    body:
      "Asking the catalog source for a listing failed. Nothing is wrong with your account, " +
      "and this one is worth trying again in a moment."
  }
};

/** The panel for a reason the loader reported, recognised or not. */
export function catalogErrorCopy(reason: string): CatalogStateCopy {
  return (
    CATALOG_ERROR_COPY[reason] ?? {
      heading: "We couldn't load the catalog",
      body:
        "The catalog did not return a usable response, and this build does not recognise the " +
        "reason it gave. Nothing is wrong with your account."
    }
  );
}

/** Every reason this module has specific copy for. Exported for its test. */
export const RECOGNISED_CATALOG_ERROR_REASONS: readonly string[] = Object.keys(CATALOG_ERROR_COPY);
