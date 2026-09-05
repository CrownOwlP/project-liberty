import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PlayerSurface } from "../../../components/player/player-surface";
import { isWatchableContentId, loadPlaybackSession } from "../watch-session";

/**
 * Rendered per request rather than prerendered.
 *
 * A playback session is request-scoped by definition — it carries authorization
 * and, once PL-0501 exists, credentials with a lifetime. A statically baked
 * watch page would either serve a stale session to everyone or serve one
 * viewer's to another, and it would also mean the skeleton below could never
 * appear.
 */
export const revalidate = 0;

/**
 * THIS ROUTE IS THIN ON PURPOSE.
 *
 * It resolves an already-authorized session on the server and hands it to a
 * client boundary. It accepts a content id from the URL and nothing else: there
 * is no query parameter, no header and no body that becomes a media URL here,
 * because a player that plays what the page asked for is an open proxy and
 * relocates product invariant 1 out of the code that enforces it.
 *
 * The state machine, the engine and the element all live behind
 * `<PlayerSurface>`, which is the only client code on this route.
 */
function PlaybackUnavailable({ heading, body, reasons }: {
  heading: string;
  body: string;
  reasons: readonly string[];
}) {
  return (
    <section className="section">
      <div className="state-panel" role="alert">
        <h2>{heading}</h2>
        <p>{body}</p>
        {/*
         * The machine-readable reasons are rendered beside the sentence for the
         * same purpose they serve in a playback decision: a screenshot in a bug
         * report has to be enough to find the state in the code. Product
         * invariant 4 applies to a denial exactly as much as to a grant.
         */}
        <ol className="state-detail">
          {reasons.map((reason, index) => (
            // Indexed because a reason list can legitimately repeat a string —
            // two candidates rejected for the same cause say the same thing.
            <li className="code" key={`${index}:${reason}`}>
              {reason}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * The player-shaped skeleton, which used to be `[contentId]/loading.tsx`.
 *
 * It is the same geometry as before — `player-surface.tsx` renders exactly this
 * `section.player-card` / `.player-stage` / `.player-meta` nesting, so the
 * layout does not jump when the session arrives — with one deliberate
 * reduction: it no longer redraws the page frame. The `<main>`, the topbar and
 * the back link are rendered by the page itself and are on screen before this
 * fallback exists, so the wait is drawn only over the part that is actually
 * waiting, and the way out of the page stays clickable throughout.
 */
function PlaybackLoading() {
  return (
    <section className="player-card" aria-busy="true">
      <div className="skeleton player-stage" />
      <div className="player-meta">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line skeleton-line-short" />
      </div>
      <span className="visually-hidden" role="status">
        Loading player…
      </span>
    </section>
  );
}

/**
 * Everything that waits on a provider, and nothing that decides an address.
 *
 * This component is INSIDE a `<Suspense>`, which is the whole reason the split
 * exists — see the page below — and that placement is a constraint on what it
 * may do, not just on where it renders: by the time it runs, the shell and the
 * HTTP 200 have been flushed. It therefore renders outcomes and never calls
 * `notFound()`.
 */
async function PlaybackBody({ contentId }: { contentId: string }) {
  const result = await loadPlaybackSession(contentId);

  if (result.status === "error") {
    return (
      <PlaybackUnavailable
        heading="We couldn’t set up playback"
        body="The playback service didn't return a usable response. Nothing is known to be wrong with this title — try again in a moment."
        reasons={[result.reason]}
      />
    );
  }

  if (result.status === "not-found") {
    /*
     * THE ONE NOT-FOUND THIS ROUTE ANSWERS AT 200, AND IT IS NOT THE ONE THE
     * E2E ASSERTS. `loadPlaybackSession` returns `not-found` from two places:
     * its own identity check, which the page has already run above the boundary
     * so it cannot reach here; and a resolver reporting that a WELL-FORMED id
     * names nothing, which nothing produces today —
     * `authorized-candidates.ts` has no catalog to answer it with.
     *
     * So this branch is currently unreachable, and it is written as a panel
     * rather than as `notFound()` because of what would happen on the day it
     * stops being: a `notFound()` here would render the right boundary under
     * the wrong status, silently, since the 200 left with the shell. A panel is
     * at least true about the situation it is served in.
     *
     * The remedy when a registry gains that ability is named rather than
     * implied: move the lookup into `isWatchableContentId`, which runs above
     * the boundary and can still set a status, and delete this branch. The copy
     * is deliberately about the DISAGREEMENT rather than about a dead link,
     * because the identity gate has already passed by this point — telling a
     * reader the address is wrong when the catalog linked them to it would send
     * them to correct something that is correct.
     */
    return (
      <PlaybackUnavailable
        heading="We couldn’t find that title to play"
        body="The address is well formed, but no authorized provider recognises this title. If you arrived from the catalog, the catalog and the provider disagree about what exists — this is not a problem with your link."
        reasons={[`${result.contentId}: no authorized provider recognises this id`]}
      />
    );
  }

  if (result.status === "not-configured") {
    /*
     * THE BRANCH A HOSTED DEPLOYMENT RENDERS, and the reason it needs its own
     * panel rather than reusing either neighbour. Until PL-0301, this route
     * served development fixtures in every environment, so a production build
     * showed a player aimed at candidates that declared `owned` rights over
     * files nobody had opened. It now says what is actually true.
     *
     * The copy names an OPERATOR remedy, deliberately. "Try again in a moment"
     * would send a viewer into a retry loop that no amount of waiting resolves,
     * and the denial copy beside it would blame this title's rights for a
     * deployment that simply has no provider wired in yet. `issue-session.ts`
     * splits `not-configured` from `provider-unavailable` for exactly this
     * reason.
     */
    return (
      <PlaybackUnavailable
        heading="Playback isn’t available on this deployment"
        body="No authorized media provider is configured here, so there is no stream to play. This is a configuration gap rather than a problem with this title or with your device."
        reasons={[
          `${result.contentId}: no authorized media provider is configured for this deployment`
        ]}
      />
    );
  }

  if (result.status === "denied") {
    return (
      <PlaybackUnavailable
        heading="This title can’t be played here"
        body="No stream for this title cleared the checks playback requires. That is a decision about rights or about what this player can decode, not a failure."
        reasons={result.reasons}
      />
    );
  }

  return <PlayerSurface session={result.session} policy={result.policy} />;
}

export default async function WatchPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;

  /*
   * THE EXISTENCE DECISION, TAKEN ABOVE EVERY SUSPENSE BOUNDARY ON THIS ROUTE.
   * This is PL-0704's fix, and the arrangement it replaced is worth stating
   * because the previous comment here recorded the defect without being able to
   * repair it.
   *
   * Next sets a 404 from `notFound()` in exactly one place: the catch around
   * the render in `app-render.tsx`, which runs only when the access-fallback
   * error ESCAPES the HTML render. React does not run error boundaries during
   * server rendering — inside a `<Suspense>` it flushes the shell, sends the
   * status line, and hands the error to the client to re-render at the
   * boundary. So a `notFound()` under a boundary can swap the CONTENT of the
   * page and can never change its STATUS. Two boundaries stood above this line:
   * the root `app/loading.tsx`, which wrapped every route in the application,
   * and this segment's own `[contentId]/loading.tsx`. An executed Playwright run
   * captured the result — `/watch/Not%20A%20Valid%20Id` answering 200 with the
   * "Loading player…" skeleton.
   *
   * NEITHER FILE MAY EXIST FOR THE LINE BELOW TO MEAN ANYTHING, and that is a
   * property of the repository rather than of this file — so it is asserted
   * rather than described here. Both were deleted in the change that moved the
   * skeleton inside this page, and `watch/route-loading-boundaries.test.ts`
   * fails the unit gate if any `loading.tsx` reappears above a page that can
   * call `notFound()`. The guard is what keeps this true; the deletion alone
   * would only have made it true once.
   *
   * The skeleton was not the price of the status. It moved INSIDE the page,
   * below this line, where it covers the provider round-trip and nothing else.
   * That split is the point rather than a side effect — identity is cheap and
   * decides a status, playback is slow and decides a body — and it is the split
   * `watch-session.ts` already argued for in prose.
   *
   * `notFound()` returns `never`, and this is the only call to it on the route.
   * `[contentId]/not-found.tsx` renders the page a reader sees; it is this
   * segment's boundary, so it still catches the throw.
   *
   * REJECTED: relaxing the spec — the 404 is a real product property, and
   * crawlers and link checkers are exactly the consumers that cannot see a
   * panel. Also rejected: `generateStaticParams` with `dynamicParams: false`,
   * which does 404 at the router before any render, but only by pinning the
   * playable ids to a build-time list. That answers a provider's question with
   * the catalog's data and would refuse ids a real registry knows. Also
   * rejected: hoisting the decision into a `[contentId]/layout.tsx`, which does
   * render outside its own segment's loading boundary. It works, and it costs
   * more than it buys: a layout's throw is caught by the PARENT segment's
   * boundary, so `not-found.tsx` would have to move up to `app/watch/` to keep
   * catching it, and the layout would have to run the load the page then needs
   * — either twice, or through a request-scoped cache added only to satisfy the
   * arrangement.
   */
  if (!isWatchableContentId(contentId)) notFound();

  return (
    <main className="shell player-shell">
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          <Link href="/">Home</Link>
        </nav>
        <div className="status">Player</div>
      </header>

      <Suspense fallback={<PlaybackLoading />}>
        <PlaybackBody contentId={contentId} />
      </Suspense>

      <div className="player-meta">
        <Link href="/">Back to catalog</Link>
      </div>
    </main>
  );
}
