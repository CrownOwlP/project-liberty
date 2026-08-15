import Link from "next/link";
import { CatalogCard } from "../components/catalog-card";
import { demoCatalog } from "../lib/demo-catalog";

export default function HomePage() {
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

      <section className="section" id="catalog">
        <div className="section-head">
          <h2>Continue building</h2>
          <small>Fictional development fixtures</small>
        </div>
        <div className="rail">
          {demoCatalog.map((item) => <CatalogCard key={item.id} title={item.title} meta={item.meta} />)}
        </div>
      </section>
    </main>
  );
}
