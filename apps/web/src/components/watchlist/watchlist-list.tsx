import Link from "next/link";
import { headers } from "next/headers";

import { CatalogCard } from "../catalog-card";
import { RovingGroup } from "../../lib/a11y/roving-group";
import { WatchlistControl } from "./watchlist-control";
import { loadWatchlistPage, type WatchlistPageEntry } from "./watchlist-page-data";
import styles from "./watchlist.module.css";

/* -------------------------------------------------------------------------
 * The list at /watchlist (PW-0304)
 *
 * AN ASYNC SERVER COMPONENT, for the reason `watchlist-page-data.ts` sets out
 * at length: the API publishes `contentId` and `addedAt` and no title, so a
 * client that fetched it would hold a page of opaque ids with no endpoint to
 * name them. The page is already `force-dynamic` and already exists only for
 * this profile, so there is nothing a server read costs here that is not
 * already being paid.
 *
 * THE CARD IS THE SAME CARD. `CatalogCard`, not a copy of it -- the same
 * argument `continue-watching-rail.tsx` makes: two hand-maintained renderings
 * of one title is how the rails and the source come to disagree about what a
 * title looks like. Everything the browse surface knows about a card is
 * therefore true here, including the remove control, which `CatalogCard`
 * already mounts for a routable item.
 *
 * FOUR STATES, ALL FOUR RENDERED. The load answers `ok` (possibly with no
 * entries), `no-profile`, or `unavailable`, and this component draws a
 * different thing for each. A watchlist screen that showed "nothing on your
 * list" for an unreachable database would be telling a household their list is
 * empty on the strength of never having read it; `app/page.tsx` refuses the
 * same substitution for the catalog and says why.
 *
 * NOTHING HERE IS A CLIENT COMPONENT except the controls, which are the only
 * part that mutates. The page needs no JavaScript to be READ -- the list, the
 * posters, the links and the dates are all in the document.
 * ---------------------------------------------------------------------- */

export async function WatchlistList() {
  const result = await loadWatchlistPage(await headers());

  if (result.status === "no-profile") {
    /*
     * THE ONE REFUSAL WITH A REMEDY THE VIEWER CAN PERFORM, and there is a
     * screen to perform it on. Rendering it as the generic failure panel would
     * hand somebody a dead end one click from the fix -- which is the defect
     * PW-0312 was created to remove on the sign-in path, pointing the other
     * way. Not an `alert`: nothing has gone wrong.
     */
    return (
      <section className="section">
        <div className="state-panel">
          <h2>Choose who is watching</h2>
          <p>
            A list belongs to a profile, not to the household, so there is no list to show until
            one is selected.
          </p>
          <p>
            <Link className="button button-primary" href="/profiles">
              Choose a profile
            </Link>
          </p>
        </div>
      </section>
    );
  }

  if (result.status === "unavailable") {
    return (
      <section className="section">
        <div className="state-panel" role="alert">
          <h2>We couldn&apos;t load your list</h2>
          <p>
            Nothing was changed. Your list is still whatever it was — this page could not read it.
          </p>
          {/*
            THE REASON CODE IS PUBLISHED, as every other state panel in this
            application publishes one. `loadWatchlistPage` never puts a thrown
            value's text in it, so there is no path by which a connection
            string reaches this element.
          */}
          <p className="code state-detail">{result.reason}</p>
        </div>
      </section>
    );
  }

  if (result.entries.length === 0) {
    return (
      <section className="section">
        <div className={`state-panel ${styles.empty}`}>
          <h2>Nothing on your list yet</h2>
          <p>
            Add a title from its page or from a card on the home screen, and it will be here.
          </p>
          <p>
            <Link className="button button-primary" href="/">
              Browse the catalog
            </Link>
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="section" aria-labelledby="watchlist-entries">
      <div className="section-head">
        <h2 id="watchlist-entries">On your list</h2>
        {/*
          A COUNT, UNLIKE THE CONTINUE-WATCHING RAIL, and the difference is the
          same one that rail states about itself. Its length is a fact about the
          reader's own viewing that nobody asked to be told, sitting above a
          catalog. This page's length IS what the page is for, and a household
          deciding whether something is missing needs to know how many the
          screen is claiming to show.
        */}
        <p className="code">{result.entries.length}</p>
      </div>
      {/*
        ARROW KEYS THROUGH THE LIST (PW-0310). This page is the one a household
        scrolls, and a forty-entry list was eighty tab stops. `RovingGroup`
        renders this same `ul` and changes nothing until it has hydrated.

        A tile for a title the catalog cannot name has NO controls, and it is
        still a position the arrows move through: see `tabIndexPlan` in
        `lib/a11y/roving.ts` for why an empty card is not a skipped index.
      */}
      <RovingGroup as="ul" className={styles.list} itemNoun="titles on your list">
        {result.entries.map((entry) => (
          <li key={entry.contentId}>
            <WatchlistEntryTile entry={entry} />
            {/*
              WHEN IT WENT ON THE LIST, AS THE CALENDAR DATE AND NOTHING ELSE.
              The list's order is `addedAt` descending and nothing else on the
              page says so, which leaves a household looking at forty tiles with
              no account of why they are in that order.

              THE FORMAT IS THE ISO DATE, DELIBERATELY, AND IT IS NOT A STYLE
              CHOICE. `toLocaleDateString` reads the running process's locale
              and time zone; this element is rendered on the server and
              hydrated in the browser, which are two processes that routinely
              disagree about both, and the symptom is a hydration mismatch that
              appears only for viewers outside the server's zone. A `slice` of
              the stored ISO string is the same bytes in both. The cost is
              stated rather than hidden: the date is UTC, so an entry added late
              in the evening west of Greenwich reads as the following day. The
              `dateTime` attribute carries the full instant, so nothing is lost
              to a consumer that wants it.
            */}
            <p className={styles.added}>
              Added <time dateTime={entry.addedAt}>{entry.addedAt.slice(0, 10)}</time>
            </p>
          </li>
        ))}
      </RovingGroup>
    </section>
  );
}

/**
 * One row.
 *
 * TWO RENDERINGS, AND THE SECOND ONE IS THE POINT. A title the catalog will
 * name is the ordinary card. A title it will not -- unknown id, no metadata
 * source, or a work withheld for want of a rights basis -- is still the
 * viewer's own stored entry, and dropping it would give them a list shorter
 * than their list with no way to remove the row that is not being shown.
 *
 * WHAT THE SECOND RENDERING DOES NOT DO is describe the work. It prints the id
 * the viewer's own row holds, which `/api/v1/watchlist` already returns to
 * them, and reads no metadata at all. There is no link: `resolveCatalogItemRoute`
 * is what decides whether an address is safe to build and there is no item here
 * to put through it, so an anchor would be a link this page cannot promise
 * resolves.
 */
function WatchlistEntryTile({ entry }: { entry: WatchlistPageEntry }) {
  if (entry.item !== null) return <CatalogCard item={entry.item} />;

  return (
    <article className="card">
      <h3>A title we can&apos;t name right now</h3>
      <p>
        It is still on your list. This screen could not look it up, so it is shown by the
        identifier your list holds.
      </p>
      <p className="code">{entry.contentId}</p>
      <WatchlistControl contentId={entry.contentId} compact />
    </article>
  );
}
