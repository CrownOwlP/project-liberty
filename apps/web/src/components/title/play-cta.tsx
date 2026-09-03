import Link from "next/link";
import type { PlayAvailability, PlayBlockedReason } from "../../app/title/title-detail";
import styles from "./title.module.css";

/**
 * Why a title cannot be played, in the reader's words and in the log's.
 *
 * The machine-readable reason is rendered alongside the sentence for the same
 * purpose it serves in a playback decision: a screenshot in a bug report has to
 * be enough to find the state in the code. `short` is the compact form used in
 * an episode row, where a full panel per episode would bury the list.
 */
export const PLAY_BLOCKED_COPY: Readonly<
  Record<PlayBlockedReason, { heading: string; body: string; short: string }>
> = {
  rights_not_declared: {
    heading: "Not available to play",
    body: "No rights basis has been recorded for this title yet, so it cannot be sent to playback. Nothing has failed — nothing has established that we are allowed to play it.",
    short: "Rights not declared"
  },
  rights_not_playable: {
    heading: "Not available to play",
    body: "The rights basis recorded for this title is not one Project Liberty may play from.",
    short: "Rights not playable"
  },
  no_playable_episode: {
    heading: "Nothing to play yet",
    body: "No episode of this series has a rights basis that clears playback. Individual episodes become playable here as soon as one is recorded.",
    short: "No playable episode"
  }
};

export interface PlayCtaProps {
  availability: PlayAvailability;
  /** What the control says when it exists. Blocked states never take a label. */
  label: string;
}

/**
 * The play affordance, or an explanation instead of one.
 *
 * When playback is blocked this renders NO control — not a disabled button, not
 * a greyed link. A disabled play button still says "this is a thing you play,
 * later"; for a title with no established rights basis that is a claim we have
 * no basis to make, and product invariant 1 puts the burden on the affordance
 * rather than on the reader to interpret it. The panel says what is missing
 * instead.
 */
export function PlayCta({ availability, label }: PlayCtaProps) {
  if (availability.status === "playable") {
    return (
      <div className="actions">
        {/*
         * `.focusRing` because this is the control the acceptance names, and
         * `globals.css` defines no focus indicator for it. The class is stated
         * here rather than inherited from a container in the hero so that moving
         * this component does not silently drop it.
         */}
        <Link className={`button button-primary ${styles.focusRing}`} href={availability.href}>
          {label}
        </Link>
      </div>
    );
  }

  const copy = PLAY_BLOCKED_COPY[availability.reason];

  return (
    <div className="state-panel" role="note">
      <h2>{copy.heading}</h2>
      <p>{copy.body}</p>
      <p className="code state-detail">{availability.reason}</p>
    </div>
  );
}
