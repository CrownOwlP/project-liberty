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
   * Not-found is routed to the boundary rather than rendered as a panel here,
   * because the two states have different remedies and the boundary replaces the
   * whole page. `notFound()` returns `never`, so the narrowing below is the
   * compiler's.
   *
   * WHAT THIS DOES NOT CURRENTLY ACHIEVE: a 404 on the wire. This comment used to
   * claim it did, and that was wrong. A segment's `loading.tsx` puts the page
   * inside Suspense, and React flushes the shell at HTTP 200 the moment it has
   * one — before the loader has decided anything — so the status is already sent
   * by the time `notFound()` runs. An executed Playwright run captured the
   * "Loading title…" skeleton at 200 for an id nothing knows about.
   *
   * The fix belongs to the ROOT `apps/web/src/app/loading.tsx`, which wraps every
   * segment and is outside this task's allowed paths; it is filed as PL-0704.
   * Deleting this segment's own `loading.tsx` would not recover the status —
   * the root boundary still wraps this route, so it only changes which skeleton
   * is flushed.
   *
   * Until PL-0704 lands, every consumer that reads status — crawlers, link
   * checkers, the eventual native clients — sees a live page at a dead address,
   * and the supply of such addresses is unbounded. `TITLE_NOT_FOUND_METADATA`
   * therefore carries `robots: index false`, which is the part of the damage this
   * task's own surface can contain.
   */
  if (result.status === "not-found") notFound();

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          {/* Stated focus indicator; `globals.css` defines none. */}
          <Link className={styles.focusRing} href="/">
            Home
          </Link>
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
