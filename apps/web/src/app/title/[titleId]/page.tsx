import Link from "next/link";
import { notFound } from "next/navigation";
import { EpisodeList } from "../../../components/title/episode-list";
import { TitleFacts } from "../../../components/title/title-facts";
import { TitleHero } from "../../../components/title/title-hero";
import { loadTitleDetail } from "../title-detail";

/**
 * Rendered per request rather than prerendered. The title surface is
 * request-scoped data, and a statically baked page would also mean the loading
 * state could never actually appear.
 */
export const revalidate = 0;

function TitleUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel" role="alert">
        <h2>We couldn&apos;t load this title</h2>
        <p>
          The title service didn&apos;t return a usable response. This title may still exist — try
          again in a moment.
        </p>
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

export default async function TitlePage({ params }: { params: Promise<{ titleId: string }> }) {
  const { titleId } = await params;
  const result = await loadTitleDetail(titleId);

  /*
   * Not-found is answered with a real 404 rather than a panel rendered at 200.
   * The distinction is invisible to a reader and load-bearing for everything
   * else that consumes the route — crawlers, link checkers, the eventual native
   * clients — all of which would otherwise record a dead title as a live one.
   * `notFound()` returns `never`, so the narrowing below is the compiler's.
   */
  if (result.status === "not-found") notFound();

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          <Link href="/">Home</Link>
        </nav>
        <div className="status">Title detail</div>
      </header>

      {result.status === "error" ? (
        <TitleUnavailable reason={result.reason} />
      ) : (
        <>
          <TitleHero detail={result.response.detail} />
          <TitleFacts technical={result.response.detail.technical} />
          {result.response.detail.kind === "series" ? (
            <EpisodeList episodes={result.response.detail.episodes} />
          ) : null}
        </>
      )}
    </main>
  );
}
