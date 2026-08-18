"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SEARCH_QUERY_MAX_LENGTH, normalizeSearchQuery } from "@liberty/contracts/domains/search";
import styles from "./search.module.css";

/**
 * Long enough that a typist does not push a navigation on every keystroke,
 * short enough that the results still feel attached to the typing. Exported so
 * the debounce is a documented number rather than a magic one buried in an
 * effect, and so a test can reason about it.
 */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * The route this form addresses.
 *
 * Written as a literal instead of `usePathname()` so the URL it produces has a
 * statically known prefix: if typed routes are ever switched on, a `string`
 * built from a hook is not assignable to a route type and this breaks at build
 * time. The form belongs to the search surface, so the coupling is honest.
 */
const SEARCH_ROUTE = "/search";

const INPUT_ID = "search-query";
const HINT_ID = "search-query-hint";

export interface SearchFormProps {
  /** The normalised query the server rendered the current results for. */
  initialQuery: string;
}

export function SearchForm({ initialQuery }: SearchFormProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [isPending, startTransition] = useTransition();

  /**
   * The last query THIS component wrote into the URL.
   *
   * Needed because the input is controlled while the URL is the source of
   * truth, and the two are only eventually consistent across a debounce. Without
   * it there is no way to tell "the URL changed because we just changed it"
   * from "the URL changed under us", and the sync effect below would fight the
   * user's typing.
   */
  const committedRef = useRef(initialQuery);

  const commit = useCallback(
    (next: string) => {
      const normalized = normalizeSearchQuery(next);
      if (normalized === committedRef.current) return;
      committedRef.current = normalized;

      /*
       * The query is user input on its way into a URL, so it is encoded by
       * `URLSearchParams` and never concatenated into the string by hand — the
       * one boundary on this path where a raw "&" or "#" would otherwise stop
       * being part of the query and start being structure.
       *
       * `replace`, not `push`: every debounced keystroke would otherwise become
       * a history entry and the back button would walk the user backwards
       * through their own typing instead of leaving the page.
       */
      const params = new URLSearchParams();
      if (normalized !== "") params.set("q", normalized);
      const queryString = params.toString();

      startTransition(() => {
        // `scroll: false` because this navigation is a refinement of the page
        // the user is already reading; scrolling them to the top on every
        // debounced keystroke would move the results out from under them.
        router.replace(queryString === "" ? SEARCH_ROUTE : `${SEARCH_ROUTE}?${queryString}`, {
          scroll: false
        });
      });
    },
    [router]
  );

  // Debounce. Cleared on every keystroke, so only the pause at the end of a
  // burst of typing reaches the router.
  useEffect(() => {
    if (normalizeSearchQuery(value) === committedRef.current) return;
    const timer = setTimeout(() => commit(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, commit]);

  /*
   * Adopt a query that changed somewhere other than this input — the back
   * button, a shared link, a bookmark. That is what makes the URL, and not this
   * component's state, the addressable thing.
   *
   * Skipped while a navigation we started is still settling: mid-transition the
   * rendered `?q=` can briefly be an older query than the one we last committed,
   * and adopting it would pull characters back out of the field under the
   * user's cursor. Once the transition settles the effect re-runs against the
   * final query, which is the one we committed, so it is a no-op.
   */
  useEffect(() => {
    if (isPending) return;
    if (initialQuery === committedRef.current) return;
    committedRef.current = initialQuery;
    setValue(initialQuery);
  }, [initialQuery, isPending]);

  return (
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
        No `action` and no `method`, so a browser submit defaults to GET against
        the current URL: if JavaScript never loads, submitting this field still
        lands on /search?q=… and still works. That is most of the value of
        keeping the query in the URL, and it costs nothing to preserve.
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
        // is ever made, not just after one arrives.
        maxLength={SEARCH_QUERY_MAX_LENGTH}
        name="q"
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search titles and genres"
        spellCheck={false}
        type="search"
        value={value}
      />
      <button className="button button-secondary" type="submit">
        Search
      </button>
      <p className={styles.hint} id={HINT_ID}>
        Results update as you type. Press Enter to search straight away.
      </p>
    </form>
  );
}
