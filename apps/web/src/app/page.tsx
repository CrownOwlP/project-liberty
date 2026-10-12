import { Suspense } from "react";

import { AppShell } from "../components/shell/app-shell";
import { CatalogRail } from "../components/catalog-rail";
import { ContinueWatchingRail } from "../components/continue-watching/continue-watching-rail";
import { HomeSpotlight } from "../components/home/home-spotlight";
import { RailStack } from "../components/home/rail-stack";
import { loadHomeCatalogOnce } from "../components/home/home-catalog";
import { HOME_RAIL_KINDS } from "../lib/catalog";

/**
 * Rendered per request rather than prerendered at build time. The catalog is
 * request-scoped data, and a statically baked page would also mean the skeletons
 * below could never actually appear.
 */
export const revalidate = 0;

/* -------------------------------------------------------------------------
 * WHY THE HOME SKELETONS ARE INSIDE THIS FILE AND NOT IN `app/loading.tsx`
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
 * that actually wanted it. The boundaries that replace `app/loading.tsx` sit
 * INSIDE this page, around the two things on the home route that wait. Nothing
 * above them can be affected by them, because there is nothing above them but
 * this page. `app/loading.tsx` itself is gone, deleted in the same change that
 * added the first boundary.
 *
 * REJECTED: a `(home)` route group holding a copy of `loading.tsx`. It reaches
 * the same scoping through an extra segment, and it is strictly worse here on
 * two counts. It replaces the WHOLE page while the catalog loads, so the topbar
 * — markup that is ready immediately — gets torn down and rebuilt for a wait it
 * is not part of; the arrangement below keeps the chrome on screen and
 * skeletons only what waits. And it needs `app/page.tsx` moved into the group,
 * which is a second file that has to move in lockstep with the first: miss one
 * and `/` is declared twice and the build fails, rather than simply keeping the
 * old behaviour.
 *
 * The rule this file is one half of: NO SUSPENSE BOUNDARY MAY SIT ABOVE A
 * SEGMENT THAT CAN CALL `notFound()`. `watch/route-loading-boundaries.test.ts`
 * enforces it over the whole `app/` tree, so a future root `loading.tsx` fails
 * the unit gate rather than silently restoring the 200.
 *
 * ==========================================================================
 * WHAT CHANGED HERE IN W132-B: THE HERO WAITS NOW, AND IT HAS ITS OWN BOUNDARY
 * ==========================================================================
 *
 * The paragraph above used to end by saying the topbar and the hero were
 * excluded from the skeleton because they were "static markup that is ready
 * immediately". That was true and it was the problem: a hero made of constants
 * described a catalog nobody had read, right above a panel that had read it —
 * see `components/home/spotlight.ts` for the three false claims it made and
 * which of them was the primary button on the first screen of the product.
 *
 * The hero is now `HomeSpotlight` over the loader's outcome, so it waits, so it
 * is skeletoned, and the skeleton is `.skeleton-hero` at exactly
 * `.hero`'s `min-height` — the slot does not move when the catalog arrives in
 * any of its states, which is the property `.hero-state` not overriding
 * `min-height` exists to keep.
 *
 * TWO BOUNDARIES OVER ONE LOAD, which is what `loadHomeCatalogOnce` is for. The
 * continue-watching rail has to sit BETWEEN the hero and the catalog rails — a
 * viewer who left something half-watched came back for it — and it keeps its own
 * boundary, so the three slots cannot share one. See
 * `components/home/home-catalog.ts` for why that costs one catalog read rather
 * than two.
 * ---------------------------------------------------------------------- */

/**
 * The hero's skeleton.
 *
 * ONE BOX, AND IT IS THE RIGHT ONE. `.skeleton-hero` has been in `globals.css`
 * since the deleted `app/loading.tsx` put it there, unused in between, sized
 * 430px to match `.hero`'s `min-height`. Every state `HomeSpotlight` can render
 * is a `section.hero`, so this fallback is the same height as whatever replaces
 * it and the rails below it do not move.
 */
function SpotlightSkeleton() {
  return (
    <>
      <div className="skeleton skeleton-hero" aria-hidden="true" />
      <span className="visually-hidden" role="status">
        Loading the catalog…
      </span>
    </>
  );
}

/**
 * The rails' skeleton: the real rail geometry, repeated once per rail the home
 * surface can build.
 *
 * `HOME_RAIL_KINDS.length` RATHER THAN THE `1` IT USED TO HARD-CODE. This
 * skeleton drew a single rail while a populated catalog renders one per kind in
 * `RAIL_DEFINITIONS` — two today — so the page grew by a whole rail's height at
 * the moment the catalog arrived. A skeleton that shifts the layout is a
 * skeleton doing the one thing it exists to prevent. Derived from the loader's
 * own exported list so adding a rail cannot leave this behind.
 *
 * IT CAN STILL BE ONE RAIL TOO MANY, and that is stated rather than hidden:
 * `buildHomeCatalog` omits a rail with no surfaceable items, so a catalog of
 * films and no series resolves to one rail where this drew two. Nothing on this
 * side of the load can know which, and over-reserving by a rail is the smaller
 * error — the content settles upward into space that was already there instead
 * of pushing the page down.
 *
 * THE NAME IS LOAD-BEARING AND IS NOT TO BE "TIDIED". Two guards outside this
 * file read it out of this source rather than rendering anything:
 * `watch/route-loading-boundaries.test.ts` requires that `function
 * CatalogSkeleton(` and `<Suspense fallback={<CatalogSkeleton />}>` both still
 * exist here, because PL-0704 MOVED this skeleton out of a `loading.tsx` and
 * deleting it is the shortcut that acceptance forbids; and
 * `continue-watching/continue-watching-ui.test.tsx` reads the same string as its
 * non-vacuity check for `fallback={null}` on the rail above. Renaming it to
 * `RailsSkeleton` -- which is what it draws now that there is also a hero
 * skeleton -- fails both, in two files this task does not own.
 */
function CatalogSkeleton() {
  const placeholders = Array.from({ length: 5 }, (_, index) => index);

  return (
    <>
      {HOME_RAIL_KINDS.map((kind) => (
        <section className="section" aria-busy="true" key={kind}>
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
        </section>
      ))}

      <span className="visually-hidden" role="status">
        Loading catalog…
      </span>
    </>
  );
}

/**
 * The hero, over whatever the loader found.
 *
 * `loadHomeCatalog` converts every expected failure into a handled result, so
 * this component has no not-found path and no throw of its own — which is what
 * makes a Suspense boundary safe here and unsafe on the two routes that do.
 */
async function Spotlight() {
  return <HomeSpotlight outcome={await loadHomeCatalogOnce()} />;
}

/**
 * The catalog rails, and NOTHING when there are none.
 *
 * The panel that used to live here is gone rather than moved twice: the hero
 * above has already stated whether the catalog is empty, which of the three
 * empty states it is in, or which of the four failures it hit. Rendering a
 * second copy of that sentence under it would be the same fact asserted twice
 * on one screen, which is what this page did before W132-B in the other
 * direction.
 */
async function Rails() {
  const outcome = await loadHomeCatalogOnce();
  if (outcome.status !== "ok") return null;

  return (
    <>
      {outcome.response.rails.map((rail) => (
        <CatalogRail key={rail.id} rail={rail} />
      ))}
    </>
  );
}

export default function HomePage() {
  return (
    <AppShell pathname="/" badge="Foundation build">
      <Suspense fallback={<SpotlightSkeleton />}>
        <Spotlight />
      </Suspense>

      {/*
        THE RAILS ARE ONE KEYBOARD STACK, ACROSS BOTH BOUNDARIES (W132-B).

        `RailStack` wraps the continue-watching boundary AND the catalog
        boundary rather than sitting inside either, because the arrangement it
        adds is Up and Down BETWEEN rails and continue watching is one of them.
        It renders `display: contents`, so the rails keep the exact geometry
        they had as direct children of `main.shell` and nothing about this
        surface is laid out differently; see `components/home/rail-stack.tsx`.

        Within a rail, Left/Right/Home/End were already answered by
        `lib/a11y/roving-group.tsx` on every rail in the product. Nothing here
        restates any of it.
      */}
      <RailStack>
        {/*
          THE CONTINUE-WATCHING RAIL HAS ITS OWN BOUNDARY, AND IT IS NOT THE
          CATALOG'S (PW-0305).

          Two separate `Suspense` boundaries rather than one around both, because
          the two loads fail and stall for completely different reasons. The
          catalog comes from a metadata source; this rail reads the identity
          store and the progress table. Sharing a boundary would make an
          unreachable database into a slow catalog -- the wrong failure,
          attributed to the wrong subsystem, in front of the thing the page is
          actually for.

          `fallback={null}` RATHER THAN A SKELETON, and that is the difference
          between this rail and the one below it. A skeleton is a promise that
          something is coming, and it is the right promise for the catalog:
          `loadHomeCatalog` always produces a rail, a panel or an error. This rail
          very often resolves to NOTHING -- a viewer who has watched nothing, a
          session with no profile selected yet, a deployment with no database --
          and a row of grey boxes that vanishes is a promise broken every time the
          normal case happens.

          ABOVE THE CATALOG in document order because a viewer who left something
          half-watched came back for it, and below the hero because the hero is
          where this page says what the catalog holds.
        */}
        <Suspense fallback={null}>
          <ContinueWatchingRail />
        </Suspense>

        <Suspense fallback={<CatalogSkeleton />}>
          <Rails />
        </Suspense>
      </RailStack>
    </AppShell>
  );
}
