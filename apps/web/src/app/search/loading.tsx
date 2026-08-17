import styles from "../../components/search/search.module.css";

/**
 * Route-segment loading state for the first load of /search.
 *
 * Typing does NOT land here: the form drives the URL inside a transition, so
 * React keeps the previous results on screen and reports progress through the
 * form's `aria-busy` instead of tearing the page down to a skeleton on every
 * keystroke. This is the cold-start case — arriving on the URL directly, or
 * from a shared link — where there is nothing to keep.
 *
 * The skeleton mirrors the real field and result-grid geometry so the layout
 * does not jump when the content arrives.
 */
export default function SearchLoading() {
  const placeholders = Array.from({ length: 5 }, (_, index) => index);

  return (
    <main className="shell" aria-busy="true">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <div className="status">Loading…</div>
      </header>

      <section className="section">
        <div className="section-head">
          <div className="skeleton skeleton-heading" />
        </div>
        <div className={styles.form}>
          <div className={`skeleton ${styles.fieldSkeleton}`} />
        </div>
      </section>

      <section className="section">
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

      <span className="visually-hidden" role="status">
        Loading search…
      </span>
    </main>
  );
}
