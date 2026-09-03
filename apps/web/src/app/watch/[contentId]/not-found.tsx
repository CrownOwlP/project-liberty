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
 * WHAT THIS BOUNDARY DOES NOT CARRY IS THE 404 STATUS, and it used to claim it
 * did. Next sets that status only when the access-fallback error escapes the
 * HTML render, and this route renders inside the Suspense boundaries that
 * `app/loading.tsx` and `[contentId]/loading.tsx` create, so the shell has
 * already been flushed at 200 by the time `notFound()` throws. The panel below
 * is the right panel; the status beside it is wrong, and the status is the part
 * every non-human consumer of the route reads. `[contentId]/page.tsx` records
 * the mechanism, the evidence and where the fix lives.
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
