import Link from "next/link";
import styles from "../../../components/title/title.module.css";

/**
 * The not-found boundary for the title route, reached when `loadTitleDetail`
 * reports that an id names nothing.
 *
 * Deliberately separate from the error panel on the page. The remedy is
 * different — there is nothing to retry here, the link itself is wrong — and a
 * reader told to "try again in a moment" about a title that will never exist
 * will keep trying.
 *
 * This boundary is SUPPOSED to carry the 404 status, and today it does not. An
 * earlier version of this comment asserted that it did. React flushes the shell
 * at HTTP 200 while the route's Suspense boundary — installed by a `loading.tsx`
 * — is still pending, so the status is on the wire before this component is ever
 * reached; an executed Playwright run captured the loading skeleton at 200 for an
 * unknown id. The fix is in the root `apps/web/src/app/loading.tsx`, outside this
 * task's allowed paths, and is filed as PL-0704. What this surface can do
 * meanwhile is refuse to be indexed, which `TITLE_NOT_FOUND_METADATA` now does.
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
            {/*
             * The only control on this page. Without a stated focus indicator a
             * keyboard user has nothing telling them they are on the one thing
             * that leaves — see `title.module.css`.
             */}
            <Link className={`button button-primary ${styles.focusRing}`} href="/">
              Browse the catalog
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
