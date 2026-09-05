import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { EpisodeList } from "../../../components/title/episode-list";
import styles from "../../../components/title/title.module.css";
import { TitleFacts } from "../../../components/title/title-facts";
import { TitleHero } from "../../../components/title/title-hero";
import type { CatalogMetadataSourceNotConfiguredError } from "../demo-title-details";
import { describeTitleMetadata, loadTitleDetail } from "../title-detail";

/**
 * Rendered per request rather than prerendered. The title surface is
 * request-scoped data, and a statically baked page could not answer a 404 for
 * an id the catalog does not define.
 */
export const revalidate = 0;

/* -------------------------------------------------------------------------
 * WHY THIS ROUTE HAS NO LOADING SKELETON, AND WHY THAT IS NOT A REGRESSION
 *
 * It had one — `[titleId]/loading.tsx` — and PL-0704 removes it along with the
 * root `app/loading.tsx` that wrapped every route in the application. Both are
 * Suspense boundaries sitting above the `notFound()` below, and a Suspense
 * boundary above an existence decision is the decision arriving too late:
 * React flushes the shell as soon as it has a fallback, the status line goes
 * out at 200, and Next can only set a status from an access-fallback error that
 * ESCAPES the HTML render. An executed Playwright run captured this route
 * answering 200 with "Loading title…" for an id nothing knows about.
 *
 * The watch route kept its skeleton through the same change, because its
 * existence decision is a format check it can make without asking anyone, so
 * the slow part could move below a boundary the decision sits above. THIS route
 * has no such split available, and saying why matters more than the file that
 * went away: whether a title exists IS the load. `/title/no-such-title-pl0701`
 * is a perfectly well-formed id, so nothing short of the catalog's answer
 * distinguishes it from a real one. A status line precedes the first byte of
 * the body, so no byte of this page may be sent before that answer arrives —
 * which is the definition of having nothing to stream, and a skeleton is a
 * promise that something is streaming.
 *
 * What removing it actually costs is therefore smaller than it looks. On a hard
 * request the skeleton could never have appeared without the status already
 * being wrong. On a client-side navigation the router keeps the previous page
 * on screen during the transition instead, which is React's behaviour when a
 * route declares no loading boundary — a different experience, not an absent
 * one.
 *
 * WHEN THIS BECOMES WORTH REVISITING: when the title page grows a section whose
 * data is independent of the title's existence — recommendations, a continue-
 * watching row, anything PL-0301's provider adapter fetches separately. That
 * section can have a `<Suspense>` of its own INSIDE this page, below the
 * decision, exactly as `watch/[contentId]/page.tsx` does. What must not come
 * back is a `loading.tsx`, in this segment or any segment above it;
 * `watch/route-loading-boundaries.test.ts` fails the unit gate if one does.
 * ---------------------------------------------------------------------- */

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
 * The reason code `CatalogMetadataSourceNotConfiguredError` publishes.
 *
 * Typed from the class rather than spelled independently, so the literal below
 * cannot drift from the one `loadTitleDetail` actually forwards: if that field's
 * value ever changes, this declaration stops compiling. The import is type-only,
 * so this file adds no runtime edge to `demo-title-details.ts` — but the class is
 * in this route's runtime module graph regardless: `title-detail.ts`, imported
 * above for `loadTitleDetail`, imports the class as a VALUE for the `instanceof`
 * in its catch.
 * `search/search.ts` exports the same string as a value for its own surface; the
 * title lane has no equivalent export to reach for, and adding a second one would
 * be a second spelling of the same code.
 */
const CATALOG_SOURCE_NOT_CONFIGURED_REASON: CatalogMetadataSourceNotConfiguredError["reason"] =
  "catalog_source_not_configured";

/**
 * The heading is an `h1`, not the `h2` the catalog's equivalent panel uses.
 *
 * On the home route that panel sits below a hero that already carries the page's
 * `h1`. Here it REPLACES the hero, so it is the only heading in the document —
 * as an `h2` the page had no top-level heading at all and its outline began at
 * level 2.
 *
 * TWO SENTENCES FOR TWO FAILURES, because "try again in a moment" is FALSE for
 * one of them. `catalog_source_not_configured` means this process has no catalog
 * metadata source at all — it is the reason EVERY title carries on a hosted
 * build, retrying produces the identical refusal forever, and the remedy belongs
 * to an operator rather than to the reader. `title-detail.ts` draws that line
 * where the two failures are separated, and `search/page.tsx` already renders it:
 * telling a reader to retry something that cannot succeed is the same defect as
 * telling them nothing matched a search that never ran. Only the explanation
 * branches — the heading and the reason line are shared, so this stays one panel,
 * and `critical-journey.spec.ts` reads that reason line as `p.code.state-detail`.
 */
function TitleUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel" role="alert">
        <h1 className={styles.stateHeading}>We couldn&apos;t load this title</h1>
        {reason === CATALOG_SOURCE_NOT_CONFIGURED_REASON ? (
          <p>
            This deployment has no catalog to read this title from — no metadata source is
            configured for it. Nothing is wrong with your account or with the address, and retrying
            will not change the answer until an operator configures one.
          </p>
        ) : (
          <p>
            The title service didn&apos;t return a usable response. This title may still exist — try
            again in a moment.
          </p>
        )}
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
   * THIS IS A 404 EXACTLY WHILE NOTHING SUSPENDS ABOVE IT. The awaited load is
   * the page's own, and the block at the top of this file records why no
   * `loading.tsx` may exist in this segment or in any segment above it. Given
   * that, the access-fallback error escapes the HTML render, which is the single
   * condition under which `app-render.tsx` sets `res.statusCode` — and
   * `[titleId]/not-found.tsx`, this segment's boundary, still renders the page a
   * reader sees. The condition is asserted by
   * `watch/route-loading-boundaries.test.ts` rather than left to this comment.
   *
   * `TITLE_NOT_FOUND_METADATA` keeps `robots: index false` regardless. A 404 is
   * the stronger signal and Next now emits a bare `noindex` of its own for any
   * status above 400, but the app's directive is the one that also says
   * `follow`, and it is the one that survives if this route ever has to answer
   * 200 again.
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
