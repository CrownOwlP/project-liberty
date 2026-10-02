"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import { describeDegradation } from "../../lib/network-state";
import {
  checkLiveness,
  isObserving,
  notObserving,
  observeBrowser,
  safeToRefresh,
  serverSnapshot,
  snapshot,
  subscribe
} from "./reachability-store";
import styles from "./degraded.module.css";

/* -------------------------------------------------------------------------
 * The visible half of degraded mode (PW-0309)
 *
 * IT DECIDES NOTHING. What is unreachable is `reachability-store.ts`; what the
 * viewer is told is `lib/network-state.ts`, which is pure and tested. This
 * file subscribes, renders a sentence somebody else wrote, and offers a retry
 * only where that sentence says one could help.
 *
 * ==========================================================================
 * IT IS A LIVE REGION, AND IT IS THE SECOND ONE ON SOME PAGES
 * ==========================================================================
 *
 * `role="status"` with `aria-live="polite"`, always present and empty when
 * there is nothing to say -- the rule `watchlist-control.tsx` records: a
 * region inserted at the moment it gains content is one some screen readers
 * never announce, because they were not watching the node when it appeared.
 *
 * `search-form.tsx` states "THE live region for this surface -- one, singular,
 * and the page must not add another", and PW-0304 already added one per
 * catalog card. That tension is an open finding for gpt-architect rather than
 * something this task resolves quietly, and it is the reason this banner is
 * `polite` rather than `alert`: an assertive region interrupts a polite one,
 * and `search-form.tsx` records what that cost the error panel -- "the user
 * was told the whole error panel ... over the top of the sentence that
 * actually explains what happened."
 *
 * NOT `role="alert"` FOR A SECOND REASON. Losing a network is not an
 * interruption of what the viewer is doing; it is a fact about what they will
 * be able to do next. Assertive would speak over them mid-sentence every time
 * a flaky connection blinked.
 *
 * ==========================================================================
 * RECOVERY WITHOUT A MANUAL RELOAD, WHICH THE ACCEPTANCE REQUIRES
 * ==========================================================================
 *
 * `router.refresh()` when the state returns to reachable, and ONLY then. Every
 * server component on screen was rendered while something was unreachable --
 * the catalog may have refused, the continue-watching rail may have rendered
 * nothing -- and leaving them is the "manual reload" the acceptance forbids.
 * It is not called on the first reachable state, because that is the ordinary
 * case and refreshing on mount would re-render every route in the application
 * on every navigation.
 * ---------------------------------------------------------------------- */

export function DegradedBanner() {
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  /*
   * PUBLISHED SO THE DIFFERENCE BETWEEN "NOTHING IS WRONG" AND "NOTHING HAS
   * LOOKED YET" IS VISIBLE. Both render `reachable`, and they are not the same
   * claim: before the effect below has run, an `offline` event would be missed
   * entirely. Read from the store through `useSyncExternalStore` rather than
   * set from the effect, because a `setState` in an effect is what
   * `react-hooks/set-state-in-effect` refuses and what
   * `season-navigation.tsx` had to be rewritten to avoid.
   */
  const observing = useSyncExternalStore(subscribe, isObserving, notObserving);
  const router = useRouter();

  /* Wired in an effect so it only ever runs in a browser that executed the
   * bundle, and torn down with the component. */
  useEffect(() => observeBrowser(), []);

  /*
   * WAS IT DEGRADED A MOMENT AGO? A REF, AND NOT A `useState`.
   *
   * Two reasons, and the second is the one that decided it. Nothing renders
   * this flag -- it exists only to tell a transition from a steady state --
   * so holding it in state would schedule a render that changes no output.
   * And `react-hooks/set-state-in-effect` refuses the `useState` form
   * outright: this component was written with one and the lint gate rejected
   * it, the same correction `season-navigation.tsx` took in PW-0307.
   *
   * The effect's dependency is the TRANSITION's input, `degraded`, so it runs
   * exactly when the answer can have changed and never because the flag it
   * writes changed.
   */
  const wasDegraded = useRef(false);
  const degraded = state.kind !== "reachable";

  useEffect(() => {
    if (degraded) {
      wasDegraded.current = true;
      return;
    }
    if (!wasDegraded.current) return;
    /*
     * AND ONLY IF A REFRESH CANNOT DESTROY THE PAGE. Next falls back to a full
     * browser navigation when it cannot fetch an RSC payload, which with no
     * network lands on the browser's error page and takes the whole
     * application with it -- see `safeToRefresh`. The flag is deliberately
     * LEFT SET: this is a deferral, not a cancellation, so the next transition
     * still delivers the recovery the acceptance requires.
     */
    if (!safeToRefresh()) return;
    wasDegraded.current = false;
    /* THE RECOVERY. Re-render the server components that were rendered while
     * something was unreachable, without the viewer reloading anything. */
    router.refresh();
  }, [degraded, router]);

  const copy = describeDegradation(state);

  return (
    <div
      /* ALWAYS IN THE DOM, EMPTY WHEN THERE IS NOTHING TO SAY -- see the
       * header. The class, and therefore everything visible, is conditional;
       * the element is not. */
      className={copy === null ? undefined : styles.banner}
      role="status"
      aria-live="polite"
      data-testid="degraded-banner"
      data-reachability={state.kind}
      data-observing={observing ? "true" : "false"}
    >
      {copy === null ? null : (
        <>
          <p className={styles.heading}>{copy.heading}</p>
          <p className={styles.body}>{copy.body}</p>
          {copy.retryable ? (
            <p>
              {/*
                OFFERED ONLY WHERE RETRYING COULD WORK. `describeDegradation`
                decides that, not this file: a configuration problem does not
                change until an operator acts, and a button that cannot
                succeed is a worse answer than no button.
              */}
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void checkLiveness()}
                data-testid="degraded-retry"
              >
                Try again
              </button>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
