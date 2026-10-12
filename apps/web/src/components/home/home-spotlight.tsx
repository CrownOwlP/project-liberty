import Link from "next/link";
import type { CatalogItem } from "@liberty/contracts/domains/catalog";

import type { CatalogLoadOutcome } from "../../lib/catalog";
import { resolveCatalogItemRoute } from "../../lib/routes";
import {
  CATALOG_EMPTY_COPY,
  SPOTLIGHT_KIND_LABEL,
  catalogErrorCopy,
  selectSpotlight,
  spotlightFacts,
  type CatalogStateCopy
} from "./spotlight";

/* -------------------------------------------------------------------------
 * THE HOME HERO, DRIVEN BY THE LOADER INSTEAD OF BY A CONSTANT (W132-B)
 *
 * `spotlight.ts` holds every decision -- which work, and what words for each
 * state -- and this file is the markup around them. See that module's header
 * for the defect class both of them exist to remove: a hero that described a
 * catalog it had never read, including a primary button hard-wired to a
 * fictional title.
 *
 * ==========================================================================
 * ONE `h1`, IN EVERY STATE, AND THAT IS WHY THE STATES SHARE THIS COMPONENT
 * ==========================================================================
 *
 * The obvious arrangement is a hero for the happy path and a panel lower down
 * for the failures, which is what the page did before: a static `h1` at the top
 * and a `.state-panel` with an `h2` below it. Making the hero itself
 * catalog-driven breaks that, because on a deployment with no source there is
 * no work to name -- and a document whose only heading was then an `h2` inside
 * a panel has no `h1` at all.
 *
 * So all three outcomes render through here and every one of them produces
 * exactly one `h1`. That is asserted in `home-ui.test.tsx` for all five
 * reachable states rather than left to inspection, because it is the kind of
 * property that holds until somebody adds a fourth branch.
 *
 * ==========================================================================
 * THE GEOMETRY IS THE SAME IN ALL THREE STATES, ON PURPOSE
 * ==========================================================================
 *
 * Every branch renders `section.hero`, so the slot is the same height before
 * the catalog resolves (`.skeleton-hero`, 430px), when a work is spotlit, and
 * when the panel explains why there is none. `.hero-state` changes only the
 * background and the heading size; it deliberately does NOT change
 * `min-height`, because that would make the Suspense boundary above this
 * component shift the whole page the moment it resolved -- which is the defect
 * the skeleton exists to prevent, reintroduced one level up.
 *
 * ==========================================================================
 * WHAT THIS HERO DELIBERATELY DOES NOT CARRY
 * ==========================================================================
 *
 * NO PLAY BUTTON. `components/title/play-cta.tsx` renders one from
 * `resolveTitlePlayAvailability`, which needs the title's stream candidates;
 * nothing on the home path has loaded those, so a Play control here would be a
 * promise made by a surface that has not checked it -- the same class of defect
 * as the `/watch/aurora-fall` link it replaces, which was a link to a work the
 * catalog may not even list. The spotlight opens the title's own page, and that
 * page decides whether it can be played.
 *
 * NO BACKDROP IMAGE, and this one is a boundary rather than a judgement.
 * `components/artwork/poster-artwork.tsx` states that it is "the only component
 * in the product that renders an image" and carries the argument for why --
 * every `src` on this surface comes from `artworkPathFor` and can only ever
 * name this origin. A second image renderer belongs beside it, under the
 * surface that owns that invariant, not here. `artworkForRole(artwork,
 * "backdrop")` is the call it would make; see the task report.
 * ---------------------------------------------------------------------- */

export interface HomeSpotlightProps {
  /**
   * What the loader found. The WHOLE outcome rather than an item, because this
   * component is also the page's one statement about a catalog it could not
   * read, and a caller that unwrapped the union first would have to decide what
   * to render for two of the three branches.
   */
  readonly outcome: CatalogLoadOutcome;
}

export function HomeSpotlight({ outcome }: HomeSpotlightProps) {
  if (outcome.status === "error") {
    return <CatalogStateHero copy={catalogErrorCopy(outcome.reason)} reason={outcome.reason} />;
  }
  if (outcome.status === "empty") {
    return <CatalogStateHero copy={CATALOG_EMPTY_COPY[outcome.cause]} reason={null} />;
  }

  const item = selectSpotlight(outcome.response.rails);
  /*
   * An `ok` outcome carrying no item at all. Unreachable through
   * `loadHomeCatalog` -- it converts a railless response into the `empty`
   * branch -- but representable in the type, and `cause_not_stated` is the
   * cause whose whole meaning is "nothing established which of the two this
   * is". Reaching into an empty array instead would crash the first screen of
   * the product for a state the compiler says can exist.
   */
  if (item === null) {
    return <CatalogStateHero copy={CATALOG_EMPTY_COPY.cause_not_stated} reason={null} />;
  }

  return <SpotlightHero item={item} />;
}

/**
 * A work the catalog actually lists.
 *
 * THE HEADING IS NOT A LINK, and the action below it is. That is the same
 * decision `catalog-card.tsx` argues at length for its own heading, pointed the
 * other way: on a card the title IS the only control, so making it the link
 * keeps the accessible name to the work's name. Here there is room for a named
 * action, and an `h1`-sized anchor spanning a 48-to-84px line is a click target
 * that reads as a banner rather than as a control.
 *
 * THE ACTION NAMES THE WORK -- "Open Aurora Fall", not "View details". Every
 * other link on this page is a title, so a links list full of "View details"
 * would be the one entry that does not say where it goes, and a speech-control
 * user has nothing visible to say. It is the rule `catalog-card.tsx` applies to
 * the card heading, which is why the label is built from the title rather than
 * from an `aria-label` that only some readers get.
 */
function SpotlightHero({ item }: { item: CatalogItem }) {
  const route = resolveCatalogItemRoute(item);

  return (
    <section className="hero">
      <div className="hero-copy">
        <div className="eyebrow">{SPOTLIGHT_KIND_LABEL[item.kind]}</div>
        <h1>{item.title}</h1>
        <p className="hero-facts">{spotlightFacts(item)}</p>
        <div className="actions">
          {/*
            NOTHING AT ALL FOR AN UNROUTABLE ITEM, not a disabled-looking
            control. `lib/routes.ts` refuses to build an address from an id the
            title route would reject, and `catalog-card.tsx` records the
            argument this follows: a link to nowhere looks clickable and does
            nothing, and styling one as unavailable asserts the title is coming
            -- a claim nothing here has checked. The work is still named and
            still described; only the promise is withheld.
          */}
          {route.status === "routable" ? (
            <Link className="button button-primary" href={route.href}>
              {`Open ${item.title}`}
            </Link>
          ) : null}
          {/*
            `/browse` RATHER THAN THE `#catalog` FRAGMENT THIS REPLACES. The
            four fragment anchors `components/shell/navigation.ts` deleted were
            dead links of the same kind -- `shell-usage.test.ts` still forbids
            them in the navigation -- and the rails are directly below this
            hero, so a jump link to them bought a reader nothing. `/browse` is
            a route with a `page.tsx`, which is the property that guard checks.
          */}
          <Link className="button button-secondary" href="/browse">
            Browse everything
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * The catalog's own condition, in the hero slot.
 *
 * NO `role="alert"`, WHICH IS A CHANGE FROM THE PANEL THIS REPLACES AND IS
 * DELIBERATE. That panel sat below an unrelated `h1` and was an interruption to
 * announce; this one IS the document's heading and its first content, so a
 * screen reader reaches it in document order with nothing before it. An alert
 * role on top of that reads the same two sentences twice in a row, and on the
 * `catalog_source_not_configured` state -- a permanent property of an
 * installation, not an event -- "alert" is the wrong word for what happened.
 *
 * THE REASON CODE IS RENDERED FOR THE ERROR STATES AND NOT FOR THE EMPTY ONES,
 * because there is no code to show for an empty catalog: `loadHomeCatalog`
 * carries a `cause` whose three values are already the three headings above,
 * and the ingestion vocabulary behind them never leaves `lib/catalog.ts`.
 */
function CatalogStateHero({
  copy,
  reason
}: {
  readonly copy: CatalogStateCopy;
  readonly reason: string | null;
}) {
  return (
    <section className="hero hero-state">
      <div className="hero-copy">
        <h1>{copy.heading}</h1>
        <p>{copy.body}</p>
        {reason === null ? null : <p className="code state-detail">{reason}</p>}
      </div>
    </section>
  );
}
