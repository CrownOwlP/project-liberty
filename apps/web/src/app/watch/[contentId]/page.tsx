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
   * A real 404 rather than a panel served at 200. The distinction is invisible
   * to a reader and load-bearing for everything else that consumes the route.
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
