"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SEARCH_QUERY_MAX_LENGTH, normalizeSearchQuery } from "@liberty/contracts/domains/search";
import {
  buildSearchHref,
  createSearchSyncState,
  latestRequestedQuery,
  recordSearchCommit,
  reconcileSearchQuery,
  type SearchSyncState
} from "./search-sync";
import styles from "./search.module.css";

/**
 * Long enough that a typist does not push a navigation on every keystroke,
 * short enough that the results still feel attached to the typing. Exported so
 * the debounce is a documented number rather than a magic one buried in an
 * effect, and so a test can reason about it.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * How long a search must stay in flight before it is worth SAYING so.
 *
 * A `polite` live region queues; it does not replace. Flipping the region to
 * "Searching…" and back on every commit therefore does not overwrite the
 * previous message, it appends — so a few words of typing enqueue eight
 * utterances and the user spends the next several seconds listening to searches
 * they moved past before the sentence started. The region should only speak
 * about a wait the user is actually having.
 *
 * Longer than the debounce on purpose: a navigation that resolves in under this
 * has already been replaced by its result by the time anyone could have heard
 * about it. The VISIBLE indicator is deliberately not gated the same way — it
 * appears immediately, because a hint that shows for 80ms and disappears costs
 * the reader nothing, whereas an utterance cannot be taken back once it is in
 * the queue.
 */
export const SEARCH_BUSY_ANNOUNCE_MS = 500;

const INPUT_ID = "search-query";
const HINT_ID = "search-query-hint";

/**
 * What a screen reader hears while a search is in flight.
 *
 * `aria-busy` alone is not an announcement — it tells assistive technology that
 * a region is unstable, and most screen readers say nothing about it. A user
 * who cannot see the field would otherwise type, hear silence, and have no way
 * to tell a slow search from one that never started.
 */
const BUSY_MESSAGE = "Searching…";

/**
 * `useRef` with an initial value that is computed at most once.
 *
 * `useRef(createSearchSyncState(initialQuery))` looks like lazy initialisation
 * and is not: the argument is EVALUATED on every render and thrown away on all
 * but the first. That is a wasted allocation per keystroke here, and it is the
 * kind of line that becomes a real defect the moment the initialiser stops
 * being pure. React ships `useState`'s lazy form but not `useRef`'s, so the
 * idiom is written out.
 *
 * The one cast is contained here. `null` is never observable to a caller: the
 * line above the return runs during render, before anything can read `.current`,
 * and `Value extends object` keeps `null` from being a legitimate value that the
 * sentinel could collide with.
 */
function useLazyRef<Value extends object>(create: () => Value): { current: Value } {
  const ref = useRef<Value | null>(null);
  if (ref.current === null) ref.current = create();
  return ref as { current: Value };
}

export interface SearchFormProps {
  /** The normalised query the server rendered the current results for. */
  initialQuery: string;
  /**
   * One sentence describing the results rendered for `initialQuery`, from
   * `describeSearchState`. Passed in rather than derived here because the
   * server owns the results; this component only owns when they are settled.
   */
  statusMessage: string;
}

export function SearchForm({ initialQuery, statusMessage }: SearchFormProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [isPending, startTransition] = useTransition();

  /**
   * Whether the in-flight state has lasted long enough to be worth announcing.
   *
   * Separate from `isPending` because the two answer different questions: one
   * is "is a navigation running", which the visible hint wants immediately, and
   * one is "has the user been waiting", which is the only thing worth putting
   * into a queue that cannot be flushed. See `SEARCH_BUSY_ANNOUNCE_MS`.
   */
  const [announceBusy, setAnnounceBusy] = useState(false);

  /**
   * What this component has asked the URL to be, and which of those requests
   * have come back.
   *
   * A ref rather than state: nothing renders from it, and it has to be readable
   * and writable from inside an effect without scheduling a render of its own.
   * The rules it enforces — in particular which arriving `?q=` is a stale render
   * of a superseded request — live in `./search-sync`, where they are pure and
   * unit-tested; this file is only responsible for calling them at the right
   * moments.
   */
  const syncRef = useLazyRef<SearchSyncState>(() => createSearchSyncState(initialQuery));

  const commit = useCallback(
    (next: string) => {
      const normalized = normalizeSearchQuery(next);

      // Compared against what we last ASKED for, not against what is currently
      // rendered: the previous navigation may still be in flight, and
      // re-issuing it on every keystroke would be a navigation per keystroke
      // with extra steps.
      if (normalized === latestRequestedQuery(syncRef.current)) return;

      /*
       * THE ADDRESS IS BUILT BEFORE THE COMMIT IS RECORDED, and the order is
       * load-bearing rather than stylistic.
       *
       * `buildSearchHref` percent-encodes, and percent-encoding is the one step
       * on this path that can throw. Recorded first, a throw would leave the
       * reconciler believing it had asked for a query it never navigated to:
       * `latestRequestedQuery` would return that query forever, the guard above
       * and the debounce guard below would both compare equal on every
       * subsequent keystroke, and the field would go on accepting typing while
       * never navigating again — silently, and outside any error boundary,
       * because this runs in a timer callback or an event handler.
       *
       * `normalizeSearchQuery` now guarantees a well-formed argument, so the
       * throw this defends against should be unreachable. Both halves are kept:
       * the contract stops today's known input from reaching the encoder, and
       * this ordering stops any future encoder, normaliser or environment
       * difference from converting one failed keystroke into a dead search box.
       * Computing the effect's inputs before advancing the state machine costs
       * nothing and bounds the blast radius of being wrong about that.
       */
      const href = buildSearchHref(normalized);
      syncRef.current = recordSearchCommit(syncRef.current, normalized);

      startTransition(() => {
        /*
         * `replace`, not `push`: every debounced keystroke would otherwise
         * become a history entry and the back button would walk the user
         * backwards through their own typing instead of leaving the page.
         *
         * `scroll: false` because this navigation is a refinement of the page
         * the user is already reading; scrolling them to the top on every
         * debounced keystroke would move the results out from under them.
         */
        router.replace(href, { scroll: false });
      });
    },
    [router, syncRef]
  );

  /*
   * Debounce.
   *
   * The timer is cleared by the effect's own cleanup, which React runs both on
   * the next keystroke and on unmount — so a burst of typing produces one
   * navigation, and typing then immediately leaving the page produces none. A
   * `setTimeout` that outlived the component would fire `router.replace` at a
   * surface the user has already navigated away from.
   */
  useEffect(() => {
    if (normalizeSearchQuery(value) === latestRequestedQuery(syncRef.current)) return;
    const timer = setTimeout(() => commit(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, commit, syncRef]);

  /*
   * Promote the in-flight state to something worth saying, but only if it lasts.
   *
   * BOTH transitions are scheduled rather than applied inline, and the settle
   * side is the one that matters here. Clearing the flag straight from the
   * effect body is a synchronous setState during the effect flush, which
   * `react-hooks/set-state-in-effect` refuses -- correctly, because it makes the
   * commit that settled a navigation immediately schedule another render. It is
   * also the exact shape the rule's own guidance points away from: an effect
   * should synchronise with an external system, and the external system here is
   * the assistive technology reading the live region, which is driven by the
   * DOM text rather than by how promptly React re-rendered.
   *
   * A zero-delay timer defers the clear to the next macrotask, so the render it
   * causes is an ordinary update rather than a cascade, and the announcement it
   * withdraws was never spoken anyway -- nothing is queued until
   * SEARCH_BUSY_ANNOUNCE_MS has elapsed. Deferring it also has a small property
   * worth keeping: if a second navigation begins before the clear fires, its
   * cleanup cancels the clear, so a user typing continuously is not told
   * "Searching..." over and over as each keystroke's navigation settles.
   *
   * Rejected: deriving the flag from a ref holding a per-navigation id, which
   * removes the state entirely but requires READING that ref during render.
   * That is impure and can report the wrong run under concurrent rendering,
   * which is a worse defect than one deferred update.
   */
  useEffect(() => {
    if (!isPending) {
      const settle = setTimeout(() => setAnnounceBusy(false), 0);
      return () => clearTimeout(settle);
    }
    const timer = setTimeout(() => setAnnounceBusy(true), SEARCH_BUSY_ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isPending]);

  /*
   * Reconcile the query the server just rendered against the ones we asked for.
   *
   * Only a query that came from outside this form — a shared link, a bookmark,
   * the back button — is written back into the field. Our own renders leave the
   * input alone, because by the time one arrives the user has usually typed
   * further characters, and a render for a request that a newer one superseded
   * is dropped outright. The previous version of this effect guessed at that
   * distinction from `useTransition`'s `isPending`, which cannot tell WHICH
   * request a render belongs to; matching renders to requests can.
   *
   * `adopt` is the only branch that writes, and it cannot loop: the adopted
   * query is appended to the commit log, so `latestRequestedQuery` already
   * equals it and the debounce effect's guard returns before starting a timer.
   */
  useEffect(() => {
    const outcome = reconcileSearchQuery(syncRef.current, initialQuery);
    syncRef.current = outcome.state;
    if (outcome.decision.kind === "adopt") setValue(outcome.decision.query);
  }, [initialQuery, syncRef]);

  return (
    <>
      <form
        aria-busy={isPending}
        className={styles.form}
        onSubmit={(event) => {
          /*
           * Enter must not wait out the debounce: a user who types and
           * immediately submits has already told us they are done. Without this
           * the form would also do a full-page GET and throw away the client
           * navigation.
           */
          event.preventDefault();
          commit(value);
        }}
        role="search"
      >
        {/*
          No `action` and no `method`, so a browser submit defaults to GET
          against the current URL: if JavaScript never loads, submitting this
          field still lands on /search?q=… and still works. That is most of the
          value of keeping the query in the URL, and it costs nothing to
          preserve.
        */}
        <label className="visually-hidden" htmlFor={INPUT_ID}>
          Search the catalog
        </label>
        <input
          aria-describedby={HINT_ID}
          autoComplete="off"
          className={styles.input}
          enterKeyHint="search"
          id={INPUT_ID}
          // Mirrors the contract's cap so the bound is enforced before a request
          // is ever made, not just after one arrives. Both count UTF-16 code
          // units — `maxlength` is defined that way, which is why the contract
          // is too. It constrains TYPING only: a query arriving from the URL is
          // bounded by `normalizeSearchQuery`, never by this attribute.
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          name="q"
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search titles and genres"
          spellCheck={false}
          type="search"
          value={value}
        />
        <button className={`button button-secondary ${styles.submit}`} type="submit">
          Search
        </button>
        <div className={styles.formFoot}>
          <p className={styles.hint} id={HINT_ID}>
            Results update as you type. Press Enter to search straight away.
          </p>
          {/*
            The visible half of the busy state, always in the DOM and only made
            invisible, so a search starting does not reflow the line below the
            field. `aria-hidden` because the live region below is already
            saying it — two elements announcing the same fact is heard as the
            fact happening twice.
          */}
          <p aria-hidden="true" className={styles.busy} data-busy={isPending ? "true" : "false"}>
            {BUSY_MESSAGE}
          </p>
        </div>
      </form>

      {/*
        THE live region for this surface — one, singular, and the page must not
        add another. It is rendered in every state and never conditionally, so
        the browser has it before the text inside it changes; a region that
        appears together with its message is frequently not announced at all. It
        is the only way a screen-reader user learns that results changed under a
        search field they are still focused on.

        It lives here rather than in the page because it has to describe the
        in-flight state as well as the settled one, and only this component
        knows a navigation is running. The error panel in `page.tsx` deliberately
        does NOT carry `role="alert"`: an assertive region interrupts a polite
        one, so in the failure state the user was told the whole error panel —
        heading, apology and the raw machine reason code — over the top of the
        sentence that actually explains what happened.

        `polite` and not `assertive`: results arriving is not an interruption,
        and assertive here would cut off whatever the user was reading every
        time they paused typing. `role="status"` carries the same politeness for
        assistive technology that does not act on `aria-live` alone.

        `aria-atomic` because every message here is one whole sentence. Without
        it, assistive technology is free to announce only the changed text
        nodes, and "1 title matches “a”." becoming "12 titles match “au”." is
        then heard as a couple of disconnected fragments rather than as a result.
      */}
      <p aria-atomic="true" aria-live="polite" className="visually-hidden" role="status">
        {announceBusy ? BUSY_MESSAGE : statusMessage}
      </p>
    </>
  );
}
