import Link from "next/link";
import { notFound } from "next/navigation";
import { PlayerSurface } from "../../../components/player/player-surface";
import { loadPlaybackSession } from "../watch-session";

/**
 * Rendered per request rather than prerendered.
 *
 * A playback session is request-scoped by definition — it carries authorization
 * and, once PL-0501 exists, credentials with a lifetime. A statically baked
 * watch page would either serve a stale session to everyone or serve one
 * viewer's to another, and it would also mean `loading.tsx` could never appear.
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

export default async function WatchPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;
  const result = await loadPlaybackSession(contentId);

  /*
   * IDENTITY IS SETTLED BEFORE THE PROVIDER IS CONSULTED, and that part is
   * right: `loadPlaybackSession` refuses an id that is not normalized before it
   * calls the resolver, so a malformed id is `not-found` in every environment
   * and never reaches the provider boundary to be misreported as a
   * configuration gap.
   *
   * WHAT IS NOT RIGHT IS THE STATUS, AND THE COMMENT THAT STOOD HERE ASSERTED IT
   * AS A FACT. It read "a real 404 rather than a panel served at 200". This
   * route has never produced one, and the first real run of the harness is what
   * found it: `critical-journey.spec.ts`, "an unplayable content id does not
   * reach the player", requests `/watch/Not%20A%20Valid%20Id` and receives 200,
   * with a page snapshot showing the watch skeleton — the `loading.tsx`
   * fallback — rather than the not-found boundary. Named rather than cited by
   * line: a line number in another package is a reference that rots on the next
   * edit to that file.
   *
   * The mechanism is Next's, not this file's. `app-render.tsx` sets
   * `res.statusCode` from an access-fallback error in exactly one place: the
   * catch around `renderToStream`, which only runs when the error ESCAPES the
   * HTML render. Every segment in this app renders inside a `<Suspense>` —
   * `app/loading.tsx` wraps the root layout's child slots, which is every route,
   * and `[contentId]/loading.tsx` wraps this page — so React completes the shell
   * (the root layout, and nothing else) and flushes it at 200 while this loader
   * is still pending. By the time `notFound()` throws, the status is on the
   * wire; React hands the error to the boundary and the client renders
   * `not-found.tsx` under a 200.
   *
   * THE FIX IS TO REMOVE THE SUSPENSE BOUNDARIES ABOVE THIS DECISION, and the
   * one that decides the outcome is `apps/web/src/app/loading.tsx`, which is
   * outside PL-0703's allowed paths. Deleting only `[contentId]/loading.tsx`
   * changes which skeleton is shown and changes no status, so it is not done
   * here: half of a fix that is indistinguishable from a regression is worse
   * than a recorded finding. The arrangement that keeps a player skeleton AND
   * the status is to scope the root loading file to the home route (a `(home)`
   * route group) and move this identity decision into
   * `watch/[contentId]/layout.tsx`, which renders OUTSIDE its own segment's
   * loading boundary.
   *
   * REJECTED: relaxing the spec — the 404 is a real product property, and
   * crawlers and link checkers are exactly the consumers that cannot see the
   * panel. Also rejected: `generateStaticParams` with `dynamicParams: false`,
   * which does 404 at the router before any render, but only by pinning the
   * playable ids to a build-time list. That answers a provider's question with
   * the catalog's data and would refuse ids a real registry knows.
   *
   * `notFound()` returns `never`, so the narrowing below is the compiler's.
   */
  if (result.status === "not-found") notFound();

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

      {result.status === "error" ? (
        <PlaybackUnavailable
          heading="We couldn’t set up playback"
          body="The playback service didn't return a usable response. Nothing is known to be wrong with this title — try again in a moment."
          reasons={[result.reason]}
        />
      ) : result.status === "not-configured" ? (
        /*
         * THE BRANCH A HOSTED DEPLOYMENT RENDERS, and the reason it needs its
         * own panel rather than reusing either neighbour. Until PL-0301, this
         * route served development fixtures in every environment, so a
         * production build showed a player aimed at candidates that declared
         * `owned` rights over files nobody had opened. It now says what is
         * actually true.
         *
         * The copy names an OPERATOR remedy, deliberately. "Try again in a
         * moment" would send a viewer into a retry loop that no amount of
         * waiting resolves, and the denial copy beside it would blame this
         * title's rights for a deployment that simply has no provider wired in
         * yet. `issue-session.ts` splits `not-configured` from
         * `provider-unavailable` for exactly this reason.
         */
        <PlaybackUnavailable
          heading="Playback isn’t available on this deployment"
          body="No authorized media provider is configured here, so there is no stream to play. This is a configuration gap rather than a problem with this title or with your device."
          reasons={[
            `${result.contentId}: no authorized media provider is configured for this deployment`
          ]}
        />
      ) : result.status === "denied" ? (
        <PlaybackUnavailable
          heading="This title can’t be played here"
          body="No stream for this title cleared the checks playback requires. That is a decision about rights or about what this player can decode, not a failure."
          reasons={result.reasons}
        />
      ) : (
        <PlayerSurface session={result.session} policy={result.policy} />
      )}

      <div className="player-meta">
        <Link href="/">Back to catalog</Link>
      </div>
    </main>
  );
}
