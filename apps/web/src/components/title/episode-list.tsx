import Link from "next/link";
import type { TitleEpisodeSummary } from "@liberty/contracts/domains/title";
import {
  formatEpisodeCount,
  formatEpisodeLabel,
  groupEpisodesBySeason,
  resolvePlayAvailability,
  titleHref
} from "../../app/title/title-detail";
import { formatRuntime } from "../../lib/catalog";
import { PLAY_BLOCKED_COPY } from "./play-cta";

/**
 * One episode row.
 *
 * The gate is applied per episode against the episode's own rights, not the
 * series': a licensed series can contain an episode nobody has cleared yet, and
 * offering play on that row would be the series' paperwork vouching for a work
 * it does not cover.
 */
function EpisodeCard({ episode }: { episode: TitleEpisodeSummary }) {
  const availability = resolvePlayAvailability(episode);

  return (
    <article className="card">
      <div className="poster" aria-hidden="true" />
      <h3>
        <Link href={titleHref(episode.id)}>
          {formatEpisodeLabel(episode)} {episode.title}
        </Link>
      </h3>
      <p>{formatRuntime(episode.runtimeMinutes)}</p>
      {availability.status === "playable" ? (
        <p>
          <Link href={availability.href}>Play</Link>
        </p>
      ) : (
        <p className="code">{PLAY_BLOCKED_COPY[availability.reason].short}</p>
      )}
    </article>
  );
}

export interface EpisodeListProps {
  episodes: readonly TitleEpisodeSummary[];
}

/**
 * A series with no episodes is a loaded title, not a failure.
 *
 * It gets its own state and its own remedy — wait, rather than retry or fix the
 * link — because the alternative is a heading followed by nothing, which looks
 * exactly like the page half-rendered.
 */
export function EpisodeList({ episodes }: EpisodeListProps) {
  const seasons = groupEpisodesBySeason(episodes);

  if (seasons.length === 0) {
    return (
      <section className="section">
        <div className="state-panel">
          <h2>No episodes listed yet</h2>
          <p>
            This series loaded correctly, but no episodes have been published for it. They appear
            here as soon as they are.
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
      {seasons.map((season) => (
        <section
          className="section"
          key={season.seasonNumber}
          aria-labelledby={`season-${season.seasonNumber}`}
        >
          <div className="section-head">
            <h2 id={`season-${season.seasonNumber}`}>Season {season.seasonNumber}</h2>
            <small>{formatEpisodeCount(season.episodes.length)}</small>
          </div>
          <div className="rail">
            {season.episodes.map((episode) => (
              <EpisodeCard episode={episode} key={episode.id} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
