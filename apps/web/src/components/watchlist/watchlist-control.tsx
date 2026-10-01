"use client";

import { useEffect, useState } from "react";

import {
  controlAffordance,
  optimisticState,
  parseWatchlistAnswer,
  restingState,
  settleState,
  presenceFromList,
  watchlistRequest
} from "./watchlist-state";
import { readWatchlistSnapshot } from "./watchlist-source";
import styles from "./watchlist.module.css";

/* -------------------------------------------------------------------------
 * Add to / remove from My List (PW-0304).
 *
 * THIS FILE DECIDES NOTHING. Every rule about what the control shows -- the
 * optimistic flip, which outcomes are successes, which roll back, what the
 * notice says -- is in `watchlist-state.ts`, which has tests. `apps/web` runs
 * Vitest in a `node` environment with no DOM, so logic left in here is logic no
 * unit test can reach; the acceptance's central demand, that "a refused write
 * must not render as a success", is therefore enforced where it can be checked
 * rather than where it is drawn.
 *
 * A CLIENT COMPONENT, for the reason `account-region.tsx` already records: the
 * surfaces this mounts on are server components on purpose, and reading a
 * profile's list on the server would make every page that renders a card
 * dynamic. The initial presence is passed IN by whoever renders it, so the
 * first paint is not a guess.
 *
 * `aria-pressed` RATHER THAN TWO BUTTONS. The control is a toggle and announces
 * itself as one, so a screen reader says the state without the label having to
 * change meaning underneath it -- and the label still changes, because a
 * sighted viewer should not have to infer state from a pressed appearance.
 * ---------------------------------------------------------------------- */

export interface WatchlistControlProps {
  readonly contentId: string;
  /** `true` on a catalog card, where the control is quieter. */
  readonly compact?: boolean;
}

export function WatchlistControl({ contentId, compact = false }: WatchlistControlProps) {
  const [state, setState] = useState(() => restingState("unknown"));

  /*
   * THE FIRST PAINT DOES NOT GUESS. The control renders `unknown` and asks;
   * `readWatchlistSnapshot` makes ONE request per page however many controls
   * are on it. A failed or signed-out read stays `unknown`, which keeps the
   * control unpressable rather than offering "Add" to someone whose list
   * already holds the title.
   *
   * It never overwrites a presence the viewer has already changed: the guard
   * is on `unknown`, not on a mounted flag, so a snapshot that resolves after
   * a fast tap cannot undo the tap.
   */
  useEffect(() => {
    let live = true;
    void readWatchlistSnapshot().then((snapshot) => {
      if (!live) return;
      setState((current) =>
        current.presence === "unknown" && current.pending === null
          ? restingState(presenceFromList(snapshot, contentId))
          : current
      );
    });
    return () => {
      live = false;
    };
  }, [contentId]);

  const { label, intent, actionable } = controlAffordance(state.presence);

  async function act() {
    if (state.pending !== null || !actionable) return;
    const before = state.presence;
    setState(optimisticState(intent));

    const { url, method } = watchlistRequest(contentId, intent);
    try {
      const response = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        /* The route's request schema is `.strict()` on an empty object: an
         * absent body parses as `{}`, and sending a field would be refused
         * rather than silently dropped. */
        body: "{}"
      });
      /*
       * THE STATUS IS NOT THE ANSWER. A refusal is a 4xx carrying an envelope
       * that says WHY, and the envelope is what the control reconciles against
       * -- so the body is read whatever the status, and a body that cannot be
       * read is handled as unreadable rather than as the status's opinion.
       */
      const body: unknown = await response.json().catch(() => null);
      setState(settleState(before, parseWatchlistAnswer(body)));
    } catch {
      /* Offline, DNS, a dropped socket. Nothing reached the server, so the
       * list is whatever it was. */
      setState(settleState(before, null));
    }
  }

  return (
    <div>
      <button
        type="button"
        className={compact ? `${styles.control} ${styles.onCard}` : styles.control}
        onClick={() => void act()}
        aria-pressed={state.presence === "on-list"}
        aria-busy={state.pending !== null}
        disabled={state.pending !== null || !actionable}
        data-testid="watchlist-control"
        data-presence={state.presence}
      >
        {label}
      </button>
      {/*
        * ALWAYS PRESENT, EMPTY WHEN THERE IS NOTHING TO SAY. A live region
        * that is inserted at the moment it gains content is a live region some
        * screen readers never announce, because they were not watching the
        * node when it appeared.
        */}
      <p
        /* The class carries a border, so an empty notice would draw an empty
         * box. The ELEMENT is always present -- a live region inserted at the
         * moment it gains content is one some screen readers never announce,
         * because they were not watching the node when it appeared. */
        className={state.notice === null ? undefined : styles.notice}
        role="status"
        aria-live="polite"
        data-testid="watchlist-notice"
      >
        {state.notice ?? ""}
      </p>
    </div>
  );
}
