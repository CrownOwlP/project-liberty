import Link from "next/link";

/**
 * The not-found boundary for the title route, reached when `loadTitleDetail`
 * reports that an id names nothing.
 *
 * Deliberately separate from the error panel on the page. The remedy is
 * different — there is nothing to retry here, the link itself is wrong — and a
 * reader told to "try again in a moment" about a title that will never exist
 * will keep trying. This boundary also carries the 404 status, which is the
 * part every non-human consumer of the route reads.
 */
export default function TitleNotFound() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <div className="status">Title detail</div>
      </header>

      <section className="section">
        <div className="state-panel">
          <h2>We don&apos;t have that title</h2>
          <p>
            Nothing in the catalog matches this address. The link may be out of date, or the title
            may never have been available here.
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
