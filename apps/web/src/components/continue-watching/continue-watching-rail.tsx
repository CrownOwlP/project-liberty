import { headers } from "next/headers";

import { CatalogCard } from "../catalog-card";
import { loadContinueWatching, startOverHref } from "../../lib/continue-watching";
import { watchHref } from "../../app/title/title-detail";

/* -------------------------------------------------------------------------
 * The continue-watching rail (PW-0305)
 *
 * AN ASYNC SERVER COMPONENT WITH ITS OWN SUSPENSE BOUNDARY, mounted by
 * `app/page.tsx` ABOVE the catalog's. The separation is the point: this rail
 * reads the identity store and the progress table, and browse must not wait on
 * either. A single boundary around both would make an unreachable database into
 * a slow catalog, which is the wrong failure attributed to the wrong subsystem.
 *
 * IT RENDERS NOTHING RATHER THAN AN ERROR, and `lib/continue-watching.ts`
 * carries the whole argument: this rail is supplementary, a viewer who has
 * watched nothing legitimately has no rail, and a panel reading "we could not
 * load your progress" above the catalog would turn an unconfigured database, a
 * signed-out session and a brand-new profile into three alarming messages about
 * a feature the reader may not use. The catalog rails below DO render their
 * failure, because the catalog is what the page is for.
 *
 * THE CARD IS THE SAME CARD. `CatalogCard` with a `resume` prop, not a copy of
 * it: two hand-maintained renderings of one thing is how the rails and the
 * source come to disagree about what a title looks like, which is the defect
 * `demo-catalog.ts` derives its own rails to avoid. Everything the browse
 * surface knows about a card -- the poster, the heading-is-the-link rule, the
 * meta line -- is unchanged here because it is the same component.
 * ---------------------------------------------------------------------- */

/**
 * How many entries the rail shows.
 *
 * Five, matching `.rail`'s five-column grid in `globals.css`, so the rail is
 * one row and not a ragged second one. It is smaller than
 * `CONTINUE_WATCHING_QUERY_LIMIT` on purpose: exclusions are applied after the
 * read, so asking for exactly five would show fewer than five whenever anything
 * was finished or barely started.
 */
const VISIBLE_ENTRIES = 5;

export async function ContinueWatchingRail() {
  const result = await loadContinueWatching(await headers());
  if (result.status !== "ok") return null;

  const entries = result.entries.slice(0, VISIBLE_ENTRIES);
  if (entries.length === 0) return null;

  return (
    <section className="section" aria-labelledby="rail-continue-watching">
      <div className="section-head">
        <h2 id="rail-continue-watching">Continue watching</h2>
        {/*
          NO COUNT HERE, unlike the catalog rails. Theirs states how many titles
          a rail holds, which is a fact about the catalog. This rail's length is
          a fact about the reader's own viewing, and "3 titles" next to a
          household's half-finished films is a number nobody asked to be told.
        */}
      </div>
      <div className="rail">
        {entries.map((entry) => (
          <CatalogCard
            key={entry.item.id}
            item={entry.item}
            resume={{
              completedFraction: entry.completedFraction,
              startOverHref: startOverHref(watchHref(entry.item.id))
            }}
          />
        ))}
      </div>
    </section>
  );
}
