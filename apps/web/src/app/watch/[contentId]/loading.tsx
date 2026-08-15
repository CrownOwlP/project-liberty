/**
 * Player-shaped loading state.
 *
 * Without this, the root `app/loading.tsx` catalog skeleton would leak onto
 * every watch route, because a segment's loading boundary wraps all nested
 * segments too. The nearest boundary wins, so this keeps the home skeleton
 * scoped to the home route.
 */
export default function WatchLoading() {
  return (
    <main className="shell player-shell" aria-busy="true">
      <section className="player-card">
        <div className="skeleton player-stage" />
        <div className="player-meta">
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line skeleton-line-short" />
        </div>
      </section>
      <span className="visually-hidden" role="status">Loading player…</span>
    </main>
  );
}
