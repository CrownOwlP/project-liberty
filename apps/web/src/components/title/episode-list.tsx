import Link from "next/link";
import { headers } from "next/headers";
import type { TitleEpisodeSummary } from "@liberty/contracts/domains/title";
import {
  formatEpisodeCount,
  formatEpisodeLabel,
  groupEpisodesBySeason,
  resolvePlayAvailability,
  titleHref
} from "../../app/title/title-detail";
import { formatRuntime } from "../../lib/catalog";
import {
  episodeProgressLabel,
  loadEpisodeProgress,
  type EpisodeProgress,
  type EpisodeProgressIndex
} from "../../lib/episode-progress";
import { PLAY_BLOCKED_COPY } from "./play-cta";
import { SeasonNavigation, type SeasonPanel } from "./season-navigation";
import styles from "./title.module.css";

/**
 * One episode row.
 *
 * The gate is applied per episode against the episode's own rights, not the
 * series': a licensed series can contain an episode nobody has cleared yet, and
 * offering play on that row would be the series' paperwork vouching for a work
 * it does not cover.
 *
 * An `li` rather than an `article` inside a `div`: this is a list item and only
 * ever renders inside the list below. Carrying `.card` on the `li` itself, in
 * place of a wrapper, also keeps the global `.card:nth-child(2n) .poster` rules
 * matching — an inner wrapper is always its parent's first child, so the poster
 * variation would have silently collapsed to one gradient.
 *
 * The poster is a decorative gradient block, not an image: there is no `img` on
 * this surface and therefore no alt text to get wrong. `aria-hidden` is correct
 * for it precisely because it carries no information — an empty `alt` on a
 * MEANINGFUL image would be the defect, and this is the other case.
 */
function EpisodeCard({
  episode,
  progress
}: {
  episode: TitleEpisodeSummary;
  /** Undefined when nothing is known -- see the badge below. */
  progress: EpisodeProgress | undefined;
}) {
  const availability = resolvePlayAvailability(episode);
  const progressLabel = episodeProgressLabel(progress);

  /*
   * `episode.title` is `z.string().min(1)`, so an untitled episode cannot reach
   * here: it fails `titleDetailResponseSchema` and the route renders the error
   * state instead of a row whose link text is the season label alone.
   */
  const name = `${formatEpisodeLabel(episode)} ${episode.title}`;

  return (
    <li className="card">
      <div className="poster" aria-hidden="true" />
      <h3>
        <Link href={titleHref(episode.id)}>{name}</Link>
      </h3>
      <p>{formatRuntime(episode.runtimeMinutes)}</p>
      {/*
        WATCHED AND IN-PROGRESS STATE (PW-0307), AND THE ABSENT CASE IS THE
        ONE WORTH READING.

        `episodeProgressLabel` answers `null` for BOTH "nothing was watched"
        and "nothing was read", and nothing is rendered for either. The two
        are different facts and only one of them could be drawn: a badge is a
        claim, and a request that failed to read a profile's progress -- no
        session, no profile chosen, no database -- has not earned one. Marking
        such an episode "not watched" would tell a household they have not
        seen it on the strength of never having looked, which is the
        substitution `app/page.tsx` refuses for the catalog and
        `watchlist-source.ts` refuses for the list.

        TEXT, NOT A COLOUR OR AN ICON. The same rule `title.module.css`
        records for the episode row's Play link: `--accent` and `--muted`
        differ by 1.20:1 in luminance, so a recoloured row is the same row on
        a greyscale display or to a reader with a colour deficiency. The
        percentage is also the figure a screen reader can speak, which a
        progress bar is not.
      */}
      {progressLabel === null ? null : <p className="code">{progressLabel}</p>}
      {availability.status === "playable" ? (
        <p>
          {/*
           * Named, not just labelled "Play". Every row's control says the same
           * visible word, so a reader pulling up the page's links — or moving
           * between form controls — otherwise gets N identical "Play" entries
           * pointing at N different episodes. The accessible name still begins
           * with the visible text, which is what speech control depends on.
           *
           * And styled as a control. With no class it inherited `.card p`'s
           * colour and size and `globals.css`'s `text-decoration: none`, which
           * made the only actionable element in the card identical to the static
           * runtime line above it. `title.module.css` records why the cue chosen
           * for it does not rest on colour.
           */}
          <Link
            aria-label={`Play ${name}`}
            className={styles.episodePlay}
            href={availability.href}
          >
            Play
          </Link>
        </p>
      ) : (
        <p className="code">{PLAY_BLOCKED_COPY[availability.reason].short}</p>
      )}
    </li>
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
/*
 * AN ASYNC SERVER COMPONENT SINCE PW-0307, and the read is here rather than in
 * the page for the reason `continue-watching-rail.tsx` gives about its own: the
 * page should not have to know that this list needs the progress table, and a
 * prop threaded down from `app/title/[titleId]/page.tsx` would make every
 * caller of this component responsible for a read only this component uses.
 *
 * ONE READ FOR THE WHOLE SERIES, not one per episode -- `lib/episode-progress.ts`
 * argues the query shape and owns the page size. It never throws, and a failure
 * renders the list with no badges rather than an error: the episodes are still
 * listed and still playable, and the state is supplementary.
 *
 * WHAT THIS COSTS, STATED. The title route is already dynamic for a signed-in
 * viewer; this read makes the episode list depend on the identity store as well
 * as the metadata source. That is the same dependency the continue-watching
 * rail already took on the home page, and it is why the failure is silent here
 * too.
 */
export async function EpisodeList({ episodes }: EpisodeListProps) {
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

  /*
   * THE SEASONS ARE HANDED TO A CLIENT COMPONENT AS RENDERED CONTENT (PW-0307).
   *
   * WHAT CHANGED AND WHAT DID NOT. Every card below this line is still built
   * here, on the server, by the same `EpisodeCard` as before -- the rights
   * gate, the per-episode link, the blocked copy. What moved is only which
   * season is on screen, and that is a question about the viewer rather than
   * about the series, so it belongs on the client.
   *
   * WHY `content` IS A RENDERED NODE RATHER THAN THE EPISODES THEMSELVES. If
   * `SeasonNavigation` took `TitleEpisodeSummary[]` and rendered the cards, it
   * would be a client component importing `app/title/title-detail` -- and with
   * it `demo-title-details` and the whole title contract -- into the browser
   * bundle, to decide a rights gate that has already been decided on the
   * server. `components/auth/account-state.ts` records what that class of
   * mistake costs: "a bundle boundary a unit suite cannot see and only
   * `next build` enforces". Passing the rendered node keeps every one of those
   * modules server-side; the client component receives markup and a season
   * number and knows nothing else.
   *
   * THE FLAT STACK IS NOT GONE, IT IS THE FALLBACK. `SeasonNavigation` renders
   * exactly the arrangement this function used to return -- a `section` per
   * season, all of them open -- until its own effect has run, so a browser that
   * did not execute the bundle keeps the page it had. Its header argues the
   * point at length.
   */
  /*
   * READ AFTER THE EMPTY CHECK ABOVE, so a series with no episodes costs no
   * query -- and `loadEpisodeProgress` refuses an empty id list for the same
   * reason, which is belt and braces rather than duplication: this component
   * is not the only possible caller.
   */
  const read = await loadEpisodeProgress(
    await headers(),
    episodes.map((episode) => episode.id)
  );
  /*
   * A FAILED READ IS `unknown` FOR EVERY EPISODE, NOT AN EMPTY INDEX.
   *
   * The two render identically -- neither draws a badge -- so this looks like
   * a distinction without a difference, and it is not. An empty index says
   * "no episode has a row"; `unknown` says "this request did not find out".
   * Writing the first when the second is true is the lie the badge rule is
   * about, it would be invisible here and visible the moment anything else
   * consumed this index, and it would leave `EpisodeProgress["state"]`
   * carrying a member nothing produces -- which is how a state stops being
   * handled.
   */
  const progress: EpisodeProgressIndex =
    read.status === "ok"
      ? read.byContentId
      : new Map<string, EpisodeProgress>(
          episodes.map((episode) => [episode.id, { state: "unknown" }])
        );

  const panels: readonly SeasonPanel[] = seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    heading: `Season ${String(season.seasonNumber)}`,
    summary: formatEpisodeCount(season.episodes.length),
    content: (
      /*
        A list, not a grid of divs -- see `title.module.css` for why the
        `role` is stated rather than left implicit.
      */
      <ul className={`rail ${styles.episodeGrid}`} role="list">
        {season.episodes.map((episode) => (
          <EpisodeCard
            episode={episode}
            key={episode.id}
            progress={progress.get(episode.id)}
          />
        ))}
      </ul>
    )
  }));

  return <SeasonNavigation panels={panels} />;
}
