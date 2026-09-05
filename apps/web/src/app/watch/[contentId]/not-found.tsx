import Link from "next/link";

/**
 * The not-found boundary for the watch route, reached when
 * `loadPlaybackSession` reports that an id names nothing.
 *
 * Deliberately separate from the panels the page renders for `error` and
 * `denied`. All three look similar and all three have different remedies: there
 * is nothing to retry here because the link itself is wrong, whereas a playback
 * error is worth another try and a denial never will be. A reader told to "try
 * again in a moment" about a title that does not exist will keep trying.
 *
 * THIS BOUNDARY IS SERVED WITH A 404, and for a while it was not. Next sets
 * that status only when the access-fallback error escapes the HTML render, and
 * this route used to render inside the Suspense boundaries that
 * `app/loading.tsx` and `[contentId]/loading.tsx` created, so the shell had
 * already been flushed at 200 by the time `notFound()` threw. PL-0704 removes
 * both and moves the call above the page's own boundary. The status is decided
 * by WHERE that call sits, in `page.tsx`, which records the mechanism; nothing
 * in this file affects it, and the arrangement is asserted by
 * `watch/route-loading-boundaries.test.ts`.
 *
 * This boundary is reached for an id that could never name anything. The route
 * has a second, currently unreachable not-found state, for a well-formed id a
 * provider reports nothing for; `page.tsx` renders that one as a panel, and
 * says why it is not sent here.
 */
export default function WatchNotFound() {
  return (
    <main className="shell player-shell">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <div className="status">Player</div>
      </header>

      <section className="section">
        <div className="state-panel">
          <h2>We don&apos;t have that title</h2>
          <p>
            Nothing in the catalog matches this address, so there is nothing to play. The link may be
            out of date, or the title may never have been available here.
          </p>
          <div className="actions">
            <Link className="button button-primary" href="/">
              Browse the catalog
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
