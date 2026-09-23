import { AppShell } from "../components/shell/app-shell";
import Link from "next/link";
import { Suspense } from "react";
import { CatalogRail } from "../components/catalog-rail";
import { loadHomeCatalog, type CatalogEmptyCause } from "../lib/catalog";

/**
 * Rendered per request rather than prerendered at build time. The catalog is
 * request-scoped data, and a statically baked page would also mean the skeleton
 * below could never actually appear.
 */
export const revalidate = 0;

/* -------------------------------------------------------------------------
 * WHY THE HOME SKELETON IS INSIDE THIS FILE AND NOT IN `app/loading.tsx`
 *
 * A `loading.tsx` belongs to a SEGMENT and wraps that segment's child slots in
 * a `<Suspense>`. At the app root that is every route in the application, and
 * React flushes the shell — and therefore the HTTP status line — as soon as it
 * has a Suspense boundary to fall back to. So the root boundary put the home
 * route's skeleton above `/title/:id` and `/watch/:id`, and those two routes
 * decide whether the address exists at all: `notFound()` threw after the 200
 * was already on the wire, and Next can only set a status from an access
 * fallback error that ESCAPES the HTML render (`app-render.tsx` sets
 * `res.statusCode` in the catch around the render, nowhere else). Every dead
 * address answered 200 with a skeleton. That is PL-0704.
 *
 * The skeleton is not deleted to buy that status back; it is moved to the level
 * that actually wanted it. The boundary that replaces `app/loading.tsx` sits
 * INSIDE this page, around the one thing on the home route that waits — the
 * catalog load. Nothing above it can be affected by it, because there is
 * nothing above it but this page. `app/loading.tsx` itself is gone, deleted in the
 * same change that added the boundary below.
 *
 * REJECTED: a `(home)` route group holding a copy of `loading.tsx`. It reaches
 * the same scoping through an extra segment, and it is strictly worse here on
 * two counts. It replaces the WHOLE page while the catalog loads, so the topbar
 * and the hero — static markup that is ready immediately — get torn down and
 * rebuilt for a wait they are not part of; the arrangement below keeps them on
 * screen and skeletons only the rails. And it needs `app/page.tsx` moved into
 * the group, which is a second file that has to move in lockstep with the
 * first: miss one and `/` is declared twice and the build fails, rather than
 * simply keeping the old behaviour.
 *
 * The rule this file is one half of: NO SUSPENSE BOUNDARY MAY SIT ABOVE A
 * SEGMENT THAT CAN CALL `notFound()`. `watch/route-loading-boundaries.test.ts`
 * enforces it over the whole `app/` tree, so a future root `loading.tsx` fails
 * the unit gate rather than silently restoring the 200.
 * ---------------------------------------------------------------------- */

function CatalogUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel" role="alert">
        <h2>We couldn&apos;t load the catalog</h2>
        <p>
          The catalog service didn&apos;t return a usable response. Nothing is wrong with your
          account — try again in a moment.
        </p>
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------
 * THE EMPTY PANEL IS THREE PANELS, BECAUSE EMPTY IS THREE THINGS
 *
 * This used to be one component reading "No titles are currently available in
 * your region. New titles appear here as soon as they are licensed." Both
 * sentences were wrong, and in the two ways this task is about.
 *
 * THE FIRST SENTENCE ASSERTED A CAUSE NOTHING HAD ESTABLISHED. Nothing in this
 * application evaluates a reader's region on the home path, so "in your region"
 * was a guess rendered as a fact, and it is exactly the sentence
 * `lib/catalog-source-registry.ts` names as the failure mode of collapsing the
 * four states — the line that ends up on screen when nothing has ever been
 * ingested.
 *
 * THE SECOND SENTENCE MADE A PROMISE NOBODY HAD MADE. "New titles appear here as
 * soon as they are licensed" commits this operator to obtaining rights. In the
 * state this task is really about — records exist and every one of them was
 * withheld for want of a rights basis — that is the single most misleading thing
 * the page could say, because it reads as "coming soon" for works no one has
 * undertaken to license, or ever will. Nothing in the repository backs it, so
 * nothing on the page says it, for any of the three causes.
 *
 * WHAT THE COPY IS ALLOWED TO SAY. What is true of the catalog, what is not the
 * reader's fault, and nothing about the future. And NOT the withheld reasons:
 * `rights_basis_not_declared` and its siblings are `@liberty/catalog-ingestion`'s
 * internal policy vocabulary, meaningful to an operator reading a log and to
 * nobody else. They never leave `lib/catalog.ts` — the loader carries a cause,
 * not a reason list — so there is nothing here to leak even by accident.
 * ---------------------------------------------------------------------- */

const EMPTY_PANELS: Readonly<Record<CatalogEmptyCause, { heading: string; body: string }>> = {
  /*
   * The source listed nothing. A fact with no remedy, so the panel states it and
   * stops — no region, no timeline, no undertaking.
   */
  catalog_empty: {
    heading: "There is nothing in this catalog yet",
    body:
      "The catalog behind this service has no titles in it. Nothing is wrong with your account."
  },
  /*
   * Records exist and not one of them may be shown here. The reader is told that
   * much, told it is not about them, and told — plainly — that nobody can say
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

function CatalogEmpty({ cause }: { cause: CatalogEmptyCause }) {
  const panel = EMPTY_PANELS[cause];

  return (
    <section className="section">
      <div className="state-panel">
        <h2>{panel.heading}</h2>
        <p>{panel.body}</p>
      </div>
    </section>
  );
}

/**
 * The skeleton that used to be `app/loading.tsx`, minus the parts that no
 * longer wait.
 *
 * The topbar and the hero are gone from it on purpose rather than by oversight:
 * they are static markup rendered by the page itself and are on screen before
 * this fallback exists, so drawing grey boxes over them would be showing a wait
 * that is not happening. What is left mirrors the real rail geometry, which is
 * what the original skeleton was for — the layout does not jump when the rails
 * arrive.
 */
function CatalogSkeleton() {
  const placeholders = Array.from({ length: 5 }, (_, index) => index);

  return (
    <section className="section" aria-busy="true">
      <div className="section-head">
        <div className="skeleton skeleton-heading" />
      </div>
      <div className="rail">
        {placeholders.map((index) => (
          <div className="card" key={index}>
            <div className="skeleton skeleton-poster" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line-short" />
          </div>
        ))}
      </div>

      <span className="visually-hidden" role="status">
        Loading catalog…
      </span>
    </section>
  );
}

/**
 * The only part of this route that waits, so the only part inside the boundary.
 *
 * `loadHomeCatalog` converts every expected failure into a handled result, so
 * this component has no not-found path and no throw of its own — which is what
 * makes a Suspense boundary safe here and unsafe on the two routes that do.
 */
async function Catalog() {
  const result = await loadHomeCatalog();

  return (
    <>
      {result.status === "error" && <CatalogUnavailable reason={result.reason} />}
      {result.status === "empty" && <CatalogEmpty cause={result.cause} />}
      {result.status === "ok" &&
        result.response.rails.map((rail) => <CatalogRail key={rail.id} rail={rail} />)}
    </>
  );
}

export default function HomePage() {
  return (
    <AppShell pathname="/" badge="Foundation build">

      <section className="hero" id="featured">
        <div className="hero-copy">
          <div className="eyebrow">Project Liberty vertical slice</div>
          <h1>One place. Fast playback. Clear decisions.</h1>
          <p>
            This scaffold uses fictional catalog data while the authorized provider layer is implemented.
            Playback resolution is designed to rank healthy, compatible sources deterministically.
          </p>
          <div className="actions">
            <Link className="button button-primary" href="/watch/aurora-fall">Open demo player</Link>
            <a className="button button-secondary" href="#catalog">Browse catalog</a>
          </div>
        </div>
      </section>

      <div id="catalog">
        <Suspense fallback={<CatalogSkeleton />}>
          <Catalog />
        </Suspense>
      </div>
    </AppShell>
  );
}
