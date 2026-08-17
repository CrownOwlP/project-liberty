/**
 * Title-shaped loading state.
 *
 * Without this the root `app/loading.tsx` catalog skeleton would leak onto
 * every title route, because a segment's loading boundary wraps all nested
 * segments too. The nearest boundary wins, so this keeps the home skeleton
 * scoped to the home route and shows a skeleton whose geometry matches what
 * actually arrives.
 */
export default function TitleLoading() {
  const placeholders = Array.from({ length: 5 }, (_, index) => index);

  return (
    <main className="shell" aria-busy="true">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <div className="status">Loading…</div>
      </header>

      <div className="skeleton skeleton-hero" />

      <section className="section">
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

      <span className="visually-hidden" role="status">
        Loading title…
      </span>
    </main>
  );
}
