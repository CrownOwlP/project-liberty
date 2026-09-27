import styles from "./continue-watching.module.css";

/* -------------------------------------------------------------------------
 * How far through a title a viewer is (PW-0305)
 *
 * TWO ELEMENTS FOR TWO AUDIENCES, and neither is a substitute for the other.
 * The bar is `aria-hidden` and the sentence beside it is visually hidden, so a
 * sighted reader gets a glanceable width and a screen-reader user gets a
 * number -- rather than one of them getting a `progressbar` role whose
 * accessible name has to be invented.
 *
 * WHY NOT `role="progressbar"`. It needs an accessible name, and every
 * candidate is worse than the sentence. A literal label ("Progress") is N
 * identical names in a rail of N cards, which is the defect `episode-list.tsx`
 * had to fix with `aria-label` and which `catalog-card.tsx` then declined to
 * reintroduce. Naming it after the title would announce the title twice.
 * Pointing `aria-labelledby` at the card's heading needs a per-card DOM id, and
 * `catalog-card.tsx` records why `item.id` is not safe to interpolate into one:
 * the catalog contract does not constrain it enough. The sentence has none of
 * those problems -- it is read in document order, immediately after the title
 * and the meta line it belongs to, so its context is its position.
 * ---------------------------------------------------------------------- */

export interface ProgressIndicatorProps {
  /**
   * How far through, or `null` when the runtime is unknown.
   *
   * `null` RENDERS NOTHING AT ALL, which is the honest answer and not a
   * degraded one. A source that never reported a runtime has not said the
   * viewer is near the beginning; a bar at 0% would say exactly that, and an
   * empty track with no bar would say it more quietly. The title still appears
   * on the rail and still resumes -- see `continueWatchingVerdict`, which keeps
   * an unknown runtime resumable and never finished.
   */
  readonly completedFraction: number | null;
}

export function ProgressIndicator({ completedFraction }: ProgressIndicatorProps) {
  if (completedFraction === null) return null;

  /*
   * Rounded for display only. The stored position is untouched -- resume uses
   * the exact seconds, and this percentage never travels back into a decision.
   */
  const percent = Math.round(completedFraction * 100);

  return (
    <>
      <div className={styles.progressTrack} aria-hidden="true">
        <div className={styles.progressBar} style={{ width: `${percent}%` }} />
      </div>
      {/*
        ONE INTERPOLATION, NOT TWO TEXT NODES. Written as `{percent}% watched`
        this renders as `77<!-- -->% watched` under the streaming server
        renderer, because React separates adjacent text nodes with a comment so
        hydration can tell where one ends. It is harmless -- a comment is not
        text and a screen reader reads "77% watched" either way -- but it also
        means `renderToStaticMarkup`, which inserts no separator, produces
        different bytes from production. A single template literal produces one
        text node in both, so the unit test and the page agree.
      */}
      <span className="visually-hidden">{`${percent}% watched`}</span>
    </>
  );
}
