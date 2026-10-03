/* -------------------------------------------------------------------------
 * The next episode, offered when this one ends (PW-0307)
 *
 * ==========================================================================
 * WHAT THIS COMPONENT IS NOT
 * ==========================================================================
 *
 * IT IS NOT AN AUTOPLAY. Nothing here counts down, and nothing navigates on a
 * timer. The acceptance asks for "a next-episode affordance at the end of
 * playback, honouring the SAME per-episode rights gate the episode list
 * already applies -- an autoplay that skips the rights check would be the
 * rights breach PL-0703 was opened for, in a new place." A countdown would
 * not itself skip the gate, but it would make the product start playback
 * nobody asked for, and the first time that ships over a title whose rights
 * basis has lapsed is the incident. A viewer continues because they chose to.
 *
 * IT IS NOT A CONTROL, which is why it lives in `components/title/` beside
 * `episode-list.tsx` rather than in `components/player/controls/`. It makes a
 * statement about a SERIES. The controls layer does not know what a series is
 * and must not learn.
 *
 * IT BUILDS NO ADDRESS. `href` arrives already made, from `nextUpFor`, which
 * gets it from `resolveNextEpisode`, which gets it from
 * `resolvePlayAvailability` -- the one gate `episode-list.tsx` applies to every
 * row. There is no string concatenation in this file and there must never be
 * one: a component that can assemble `/watch/<id>` can reach an episode the
 * gate refused.
 *
 * ==========================================================================
 * IT IS RENDERED, NOT MOUNTED, WHEN PLAYBACK ENDS
 * ==========================================================================
 *
 * `player-surface.tsx` renders it only in the machine's `ended` phase, so the
 * element does not exist before then -- a hidden affordance that a screen
 * reader can find while the programme is still playing would announce the
 * ending early.
 * ---------------------------------------------------------------------- */
import Link from "next/link";

import type { NextUp } from "../../lib/next-episode";

import styles from "./next-episode-prompt.module.css";

export interface NextEpisodePromptProps {
  readonly next: NextUp;
}

/**
 * `S2 E1` — the short form, because the long one is already in the link text.
 *
 * Not localised, and that is a known limitation rather than an oversight: this
 * product has no localisation layer at all, and inventing one here would put
 * a second translation mechanism in a component.
 */
export function episodeOrdinal(next: NextUp): string {
  return `S${next.seasonNumber} E${next.episodeNumber}`;
}

/**
 * What to say about the episodes the rights gate refused.
 *
 * SAID RATHER THAN HIDDEN. A viewer who finishes episode 3 and is offered
 * episode 6 can see that something is missing; a prompt that says nothing
 * looks like a bug in the product rather than a gap in the paperwork. It does
 * NOT name them or say why -- "we do not have the rights to episodes 4 and 5"
 * is a claim about a contract, and this surface does not know which of
 * `rights_not_declared` or `rights_not_playable` applied.
 */
export function skippedNote(skippedCount: number): string | null {
  if (skippedCount <= 0) return null;
  return skippedCount === 1
    ? "1 episode in between is not available here."
    : `${skippedCount} episodes in between are not available here.`;
}

export function NextEpisodePrompt({ next }: NextEpisodePromptProps) {
  const note = skippedNote(next.skippedCount);
  return (
    <aside
      className={styles.prompt}
      data-testid="next-episode-prompt"
      /*
       * A REGION WITH A NAME, so a screen-reader user arriving by landmark
       * knows what it is. Not `role="alert"`: an alert interrupts, and the
       * programme ending is not an emergency.
       */
      aria-labelledby="next-episode-heading"
    >
      <h2 id="next-episode-heading" className={styles.heading}>
        Next episode
      </h2>
      <p className={styles.episode}>
        <span className={styles.ordinal}>{episodeOrdinal(next)}</span>{" "}
        <span className={styles.title}>{next.title}</span>
      </p>
      {note === null ? null : <p className={styles.note}>{note}</p>}
      {/*
       * A LINK AND NOT A BUTTON, because it navigates. The whole point of this
       * affordance is that the next episode goes through `/watch/:id` like any
       * other — the same route, the same session request, the same
       * authorization decision, the same refusal screen if it is denied. A
       * button wired to a bespoke "play next" path would be the special
       * playback path that bypasses the ordinary machinery.
       */}
      <Link className={styles.play} href={next.href} data-testid="next-episode-play">
        Play {episodeOrdinal(next)}
      </Link>
    </aside>
  );
}
