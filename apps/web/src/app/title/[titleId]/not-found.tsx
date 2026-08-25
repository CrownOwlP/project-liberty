import Link from "next/link";
import styles from "../../../components/title/title.module.css";

/**
 * The not-found boundary for the title route, reached when `loadTitleDetail`
 * reports that an id names nothing.
 *
 * Deliberately separate from the error panel on the page. The remedy is
 * different — there is nothing to retry here, the link itself is wrong — and a
 * reader told to "try again in a moment" about a title that will never exist
 * will keep trying. This boundary also carries the 404 status, which is the
 * part every non-human consumer of the route reads.
 *
 * The panel heading is an `h1`: this boundary replaces the whole page, so
 * nothing else on it carries a top-level heading. It was an `h2`, which left the
 * document with no `h1` and an outline that started at level 2.
 *
 * The requested id is deliberately not echoed as a title. It is a URL segment,
 * not a name — printing it in the heading of a page that says we do not have
 * that title is exactly how an id becomes a title in a screenshot.
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
          <h1 className={styles.stateHeading}>We don&apos;t have that title</h1>
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
