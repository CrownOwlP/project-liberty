import Link from "next/link";
import { CatalogRail } from "../components/catalog-rail";
import { loadHomeCatalog } from "../lib/catalog";

function CatalogUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section" id="catalog">
      <div className="state-panel" role="alert">
        <h2>We couldn&apos;t load the catalog</h2>
        <p>
          The catalog service didn&apos;t return a usable response. Nothing is wrong with your
          account — try again in a moment.
        </p>
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

function CatalogEmpty() {
  return (
    <section className="section" id="catalog">
      <div className="state-panel">
        <h2>Nothing to watch yet</h2>
        <p>
          No titles are currently available in your region. New titles appear here as soon as
          they are licensed.
        </p>
      </div>
    </section>
  );
}

export default async function HomePage() {
  const result = await loadHomeCatalog();

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">PROJECT <span>LIBERTY</span></div>
        <nav className="nav" aria-label="Primary navigation">
          <a href="#featured">Home</a>
          <a href="#catalog">Movies</a>
          <a href="#catalog">Series</a>
          <a href="#catalog">Live</a>
        </nav>
        <div className="status">Foundation build</div>
      </header>

      <section className="hero" id="featured">
        <div className="hero-copy">
          <div className="eyebrow">Project Liberty vertical slice</div>
          <h1>One place. Fast playback. Clear decisions.</h1>
          <p>
            This scaffold uses fictional catalog data while the authorized provider layer is implemented.
            Playback resolution is designed to rank healthy, compatible sources deterministically.
          </p>
          <div className="actions">
            <Link className="button button-primary" href="/watch/aurora-fall">Open demo player</Link>
            <a className="button button-secondary" href="#catalog">Browse catalog</a>
          </div>
        </div>
      </section>

      <div id="catalog">
        {result.status === "error" && <CatalogUnavailable reason={result.reason} />}
        {result.status === "empty" && <CatalogEmpty />}
        {result.status === "ok" &&
          result.response.rails.map((rail) => <CatalogRail key={rail.id} rail={rail} />)}
      </div>
    </main>
  );
}
