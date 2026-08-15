/**
 * Route-segment loading state. Rendered while the home route's catalog load is
 * in flight. The skeleton mirrors the real rail geometry so the layout does not
 * jump when the content arrives.
 */
export default function HomeLoading() {
  const placeholders = Array.from({ length: 5 }, (_, index) => index);

  return (
    <main className="shell" aria-busy="true" aria-live="polite">
      <header className="topbar">
        <div className="brand">PROJECT <span>LIBERTY</span></div>
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

      <span className="visually-hidden">Loading catalog…</span>
    </main>
  );
}
