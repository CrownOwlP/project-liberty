import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { EpisodeList } from "../../../components/title/episode-list";
import styles from "../../../components/title/title.module.css";
import { TitleFacts } from "../../../components/title/title-facts";
import { TitleHero } from "../../../components/title/title-hero";
import { describeTitleMetadata, loadTitleDetail } from "../title-detail";

/**
 * Rendered per request rather than prerendered. The title surface is
 * request-scoped data, and a statically baked page would also mean the loading
 * state could never actually appear.
 */
export const revalidate = 0;

interface TitlePageProps {
  params: Promise<{ titleId: string }>;
}

/**
 * One load per request, shared by the metadata and the body.
 *
 * Next runs `generateMetadata` and the component for the same request. Without
 * `cache` the source — fixtures today, a provider adapter after PL-0301 — would
 * be asked twice for every title view, and the two answers are not required to
 * agree: a source that failed between them would title the tab after a title the
 * page below says it could not load. `cache` keys on the arguments, so both call
 * sites pass exactly one.
 *
 * Wrapped here rather than inside `title-detail.ts` so the loader stays a plain
 * function with no React request scope, which is what lets its unit tests call
 * it directly.
 */
const loadTitleOnce = cache((titleId: string) => loadTitleDetail(titleId));

/**
 * Without this every title in the catalog shared the root layout's "Project
 * Liberty" — the same tab, the same bookmark name and the same link preview for
 * a movie, a series and a 404. The head is derived from the load RESULT rather
 * than from the URL, so a title we do not have cannot be named after its id.
 */
export async function generateMetadata({ params }: TitlePageProps): Promise<Metadata> {
  const { titleId } = await params;
  return describeTitleMetadata(await loadTitleOnce(titleId));
}

/**
 * The heading is an `h1`, not the `h2` the catalog's equivalent panel uses.
 *
 * On the home route that panel sits below a hero that already carries the page's
 * `h1`. Here it REPLACES the hero, so it is the only heading in the document —
 * as an `h2` the page had no top-level heading at all and its outline began at
 * level 2.
 */
function TitleUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel" role="alert">
        <h1 className={styles.stateHeading}>We couldn&apos;t load this title</h1>
        <p>
          The title service didn&apos;t return a usable response. This title may still exist — try
          again in a moment.
        </p>
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

export default async function TitlePage({ params }: TitlePageProps) {
  const { titleId } = await params;
  const result = await loadTitleOnce(titleId);

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
