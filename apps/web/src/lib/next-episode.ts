import type { TitleEpisodeSummary } from "@liberty/contracts/domains/title";

import { resolvePlayAvailability, sortEpisodes } from "../app/title/title-detail";

/* -------------------------------------------------------------------------
 * What plays after this episode (PW-0307)
 *
 * A PURE FUNCTION IN `lib/`, WHICH THE ACCEPTANCE ASKS FOR BY NAME: "the
 * next-episode selection rule is a pure function with its own tests, not logic
 * inside a component, because 'what plays next' is exactly the kind of decision
 * this project requires to be reconstructible." Same input, same answer, no
 * clock, no lookup, no I/O -- so a report saying "it played the wrong thing"
 * can be turned into a test rather than into a session anybody has to recreate.
 *
 * ==========================================================================
 * THE RIGHTS GATE IS THE SAME GATE, IMPORTED, NEVER RESTATED
 * ==========================================================================
 *
 * The acceptance is explicit that "an autoplay that skips the rights check
 * would be the rights breach PL-0703 was opened for, in a new place." The
 * defence against that is not care; it is that there is only one gate.
 * `resolvePlayAvailability` is the function `episode-list.tsx` already applies
 * to every row, it is where `rights_not_declared` and `rights_not_playable` are
 * told apart, and this module calls it rather than re-deriving anything from
 * `episode.rights`. A second spelling of a rights rule is the defect
 * `title-detail.ts` and `lib/catalog.ts` both already refuse to introduce.
 *
 * So the strongest statement this module can make is also the simplest: THERE
 * IS NO PATH THROUGH THIS FILE THAT PRODUCES AN `href` FOR AN EPISODE
 * `resolvePlayAvailability` DID NOT CALL PLAYABLE. The href it returns is the
 * one that function returned.
 *
 * WHAT THE IMPORT COSTS, STATED RATHER THAN HIDDEN. `lib/routes.ts` already
 * records this edge and the argument is unchanged: importing
 * `app/title/title-detail` pulls `./demo-title-details` and the title contract
 * into the module graph of everything that imports this. It is server-side
 * evaluation rather than client bytes, and a duplicated rights rule is the
 * worse defect. The removal is the same one-commit move that file names: a task
 * owning `app/title/**`, `components/title/**` and `lib/**` moves the shared
 * helpers down into `lib/` and the import disappears.
 *
 * ==========================================================================
 * TWO DECISIONS WORTH DISAGREEING WITH, MADE EXPLICITLY
 * ==========================================================================
 *
 * 1. IT CROSSES SEASON BOUNDARIES. The episode after the last of season 1 is
 *    the first of season 2. `sortEpisodes` is a TOTAL order over the series --
 *    season, then episode, then id -- so "next" means next in the order the
 *    list renders, and a viewer who finishes a season finale is offered the
 *    premiere rather than nothing. Stopping at the season boundary would make
 *    the affordance disappear exactly where a viewer most expects it.
 *
 * 2. IT SKIPS PAST AN EPISODE IT MAY NOT PLAY, AND SAYS SO. This is the
 *    decision to argue with. The alternative -- stop at the first blocked
 *    episode and offer nothing -- is defensible, and it was rejected because
 *    the product already made the opposite choice one layer up:
 *    `resolveSeriesPlayTarget` picks "the first episode that may actually be
 *    played", and `title-hero.tsx` labels the control "Play first available
 *    episode" precisely so the label never claims it is the first. Behaving
 *    differently here would mean the series CTA and the autoplay disagree about
 *    what the next thing is.
 *
 *    What makes it honest rather than silent is that the skip is REPORTED.
 *    `skipped` carries every episode that was passed over, so a surface can say
 *    which episode is actually next instead of letting a viewer assume the
 *    numbering continued. A caller that renders the outcome without reading
 *    `skipped` is making a claim this function did not make -- and that is
 *    visible in the caller rather than hidden in here.
 * ---------------------------------------------------------------------- */

/** Why there is nothing to play next. */
export type NextEpisodeAbsence =
  /**
   * The id playing now is not one of these episodes.
   *
   * NOT the same as "the series is over", and the distinction is the one that
   * catches a real defect: a watch route handed an episode id from a different
   * series, or a stale id after a provider renumbered, would otherwise present
   * as a finished series. A surface that renders both the same way is still
   * free to; what it must not do is be unable to tell them apart.
   */
  | "current_episode_not_in_series"
  /** It was the last episode in the order. Nothing follows it at all. */
  | "no_later_episode"
  /**
   * Later episodes exist and NOT ONE of them clears the rights gate.
   *
   * The reason this is its own code rather than folded into the one above: it
   * is the state an operator can fix, by recording a rights basis. "The series
   * ended" is not.
   */
  | "no_later_episode_is_playable";

export type NextEpisode =
  | {
      readonly kind: "next";
      readonly episode: TitleEpisodeSummary;
      /** Where it plays. Produced by the rights gate, never built here. */
      readonly href: string;
      /**
       * Episodes between the current one and this one that the gate refused.
       *
       * Empty in the ordinary case. Non-empty means the numbering a viewer can
       * see has a hole in it, and the surface is expected to say so rather than
       * let them infer that nothing was passed over.
       */
      readonly skipped: readonly TitleEpisodeSummary[];
    }
  | { readonly kind: "none"; readonly reason: NextEpisodeAbsence };

/**
 * The episode that follows `currentEpisodeId`, if one may be played.
 *
 * TAKES THE EPISODE LIST RATHER THAN A `TitleDetail`, so the rule can be
 * exercised against a handful of rows instead of a whole validated payload, and
 * so a caller holding a season's worth of episodes cannot accidentally be given
 * a different answer than a caller holding the series. The order is recomputed
 * here from `sortEpisodes`; passing a pre-sorted list changes nothing, and
 * passing an unsorted one still gets the order the list renders.
 */
export function resolveNextEpisode(
  episodes: readonly TitleEpisodeSummary[],
  currentEpisodeId: string
): NextEpisode {
  const ordered = sortEpisodes(episodes);
  const index = ordered.findIndex((episode) => episode.id === currentEpisodeId);
  if (index === -1) return { kind: "none", reason: "current_episode_not_in_series" };

  const later = ordered.slice(index + 1);
  if (later.length === 0) return { kind: "none", reason: "no_later_episode" };

  const skipped: TitleEpisodeSummary[] = [];
  for (const episode of later) {
    const availability = resolvePlayAvailability(episode);
    if (availability.status === "playable") {
      return { kind: "next", episode, href: availability.href, skipped };
    }
    skipped.push(episode);
  }

  return { kind: "none", reason: "no_later_episode_is_playable" };
}

/* ===========================================================================
 * WHAT THE PLAYER IS HANDED (PW-0307)
 * ======================================================================== */

/**
 * The next-episode answer, flattened to the few fields an affordance renders.
 *
 * A NARROW PROJECTION AND NOT THE `NextEpisode` ITSELF, for two reasons that
 * both matter at this boundary.
 *
 * It crosses from a server component into a client one, so everything in it
 * has to survive serialisation; a `TitleEpisodeSummary` would carry a rights
 * basis, a synopsis and an artwork reference into a browser bundle to render a
 * link and a number. The second reason is the one worth keeping: `href` IS THE
 * ONLY WAY TO REACH THE NEXT EPISODE FROM THE CLIENT, and it is produced by
 * `resolveNextEpisode`, which produces it only from `resolvePlayAvailability`.
 * Handing the client the episode instead of the href would let a component
 * build its own address — which is how a rights gate stops being a gate.
 *
 * `null` means "render nothing". Deliberately one value for every reason: the
 * series ended, nothing later is playable, the id was not in the series. A
 * viewer is owed an honest screen, not a taxonomy of why there is no next
 * episode, and the distinctions are kept where they are useful — in
 * `NextEpisodeAbsence`, on the server, where an operator can act on them.
 */
export interface NextUp {
  readonly contentId: string;
  readonly title: string;
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  /** Built by the rights gate. Never assembled by the surface that renders it. */
  readonly href: string;
  /**
   * How many episodes between this one and that one the gate refused.
   *
   * Carried because the numbering a viewer can see will have a hole in it, and
   * a prompt that silently jumps from 3 to 6 is a prompt that looks broken.
   * `resolveNextEpisode` already collects them; this keeps the count and drops
   * the rows, because the surface says "2 episodes were skipped" and does not
   * name them.
   */
  readonly skippedCount: number;
}

/**
 * `resolveNextEpisode`, projected — the one call a server surface makes.
 *
 * Deliberately not a second rule. It calls the rule and reshapes the answer;
 * every decision, including the rights gate, is still made in exactly one
 * place.
 */
export function nextUpFor(
  episodes: readonly TitleEpisodeSummary[],
  currentEpisodeId: string
): NextUp | null {
  const next = resolveNextEpisode(episodes, currentEpisodeId);
  if (next.kind !== "next") return null;
  return {
    contentId: next.episode.id,
    title: next.episode.title,
    seasonNumber: next.episode.seasonNumber,
    episodeNumber: next.episode.episodeNumber,
    href: next.href,
    skippedCount: next.skipped.length
  };
}
