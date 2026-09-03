import { normalizeSearchQuery } from "@liberty/contracts/domains/search";

/* -------------------------------------------------------------------------
 * Keeping the input and the URL in agreement (PL-0102)
 *
 * The search surface is server-rendered: the query lives in `?q=`, the results
 * are whatever the server rendered for it, and the client field is a controlled
 * input that has to end up saying the same thing. Those two are only EVENTUALLY
 * consistent — a debounce, then a navigation, then a render come between a
 * keystroke and the results it produced — and every interesting bug on this
 * surface lives in that gap.
 *
 * All of it is pure and lives here rather than inside the component, for two
 * reasons. The reconciliation rule below is the part that is genuinely easy to
 * get wrong, and `apps/web` runs Vitest under the `node` environment with no
 * DOM, so a rule expressed as `useEffect` bodies could not be tested at all —
 * it would be reviewed once and then trusted forever. Expressed as a
 * transition function it is tested directly, including the out-of-order case
 * that is otherwise only reachable on a slow network.
 * ---------------------------------------------------------------------- */

/**
 * The route this surface addresses.
 *
 * Written as a literal instead of `usePathname()` so the URL it produces has a
 * statically known prefix: if typed routes are ever switched on, a `string`
 * built from a hook is not assignable to a route type and this breaks at build
 * time. This module belongs to the search surface, so the coupling is honest.
 */
export const SEARCH_ROUTE = "/search";

/**
 * The address a query is shareable at.
 *
 * The query is user input on its way into a URL, so it is percent-encoded and
 * never concatenated in by hand — this is the one boundary on this path where a
 * raw `&`, `#` or `=` would otherwise stop being part of the query and start
 * being structure.
 *
 * `encodeURIComponent` rather than `URLSearchParams.toString()`: the latter
 * renders a space as `+`, which only means a space under
 * `application/x-www-form-urlencoded` and therefore depends on whatever reads
 * the URL back agreeing to decode it that way. `%20` means a space to every
 * parser, which is what a link a user pastes somewhere else needs. Both spellings
 * still decode to the same normalized query, so the no-JavaScript fallback —
 * where the browser submits the form itself and produces `q=the+fall` — remains
 * the same search as the client path's `q=the%20fall`.
 *
 * THE ONE THING `encodeURIComponent` DOES THAT `URLSearchParams` DOES NOT is
 * throw. It raises `URIError` on a lone surrogate, where `URLSearchParams`
 * substitutes U+FFFD and carries on. This function is therefore only total
 * because `normalizeSearchQuery` is documented and tested to emit well-formed
 * UTF-16 — including at its own truncation boundary, which used to cut surrogate
 * pairs in half. If that guarantee is ever weakened, this line throws, and
 * `search-sync.property.test.ts` exists so that it fails there instead of in a
 * `setTimeout` callback on a user's machine.
 *
 * An empty query addresses `/search` with no parameter at all, not `?q=`. The
 * idle state is "no query has been asked yet", and a bare `?q=` in the address
 * bar reads like a search that was run and returned nothing.
 */
export function buildSearchHref(rawQuery: string): string {
  const normalized = normalizeSearchQuery(rawQuery);
  if (normalized === "") return SEARCH_ROUTE;
  return `${SEARCH_ROUTE}?q=${encodeURIComponent(normalized)}`;
}

/**
 * One query this form asked the URL to become, and when it asked.
 *
 * `spent` records that a render carrying this exact query has already been
 * matched to this commit. It is the only thing that distinguishes "a render of
 * a request I made" from "a navigation somebody else caused" when the two carry
 * the same string, and it is what makes going BACK to an earlier query — by
 * link, bookmark or back button — reachable at all: see `reconcileSearchQuery`.
 */
export interface SearchCommit {
  readonly query: string;
  readonly epoch: number;
  readonly spent: boolean;
}

/** `trimmedThroughEpoch` when the log still holds every commit ever made. */
export const NOTHING_TRIMMED = -1;

/**
 * What the form knows about its own outstanding navigations.
 *
 * `epoch` is a monotonic counter, not a timestamp: it exists to order this
 * form's own requests against each other, and nothing else compares it to a
 * clock.
 */
export interface SearchSyncState {
  /** Every query committed this visit, oldest first, bounded below. */
  readonly commits: readonly SearchCommit[];
  /** The epoch of the newest commit whose render has actually arrived. */
  readonly appliedEpoch: number;
  /**
   * The query that render carried — i.e. what is on screen right now.
   *
   * Kept beside `appliedEpoch` rather than looked up from `commits`, because
   * the commit it belongs to can be trimmed out of the log while it is still
   * the query the page is displaying.
   */
  readonly appliedQuery: string;
  /**
   * The highest epoch dropped by the history bound, or `NOTHING_TRIMMED`.
   *
   * This is what stops the bound from silently becoming a correctness hole. Once
   * anything has been trimmed, "this query is not in the log" no longer proves
   * "nobody here asked for it", and `reconcileSearchQuery` has to stop treating
   * the two as the same statement.
   */
  readonly trimmedThroughEpoch: number;
  /** The epoch the next commit will take. */
  readonly nextEpoch: number;
}

/**
 * What a render carrying `?q=` means, and therefore what the field should do.
 *
 * - `unchanged` — this is the query already on screen. Nothing to do.
 * - `acknowledged` — a navigation this form started has landed. The URL now
 *   says what we asked it to say, so the field is already correct and must NOT
 *   be written to; the user may have typed further characters since.
 * - `stale` — a render this form must not act on: either the render of a commit
 *   that a newer commit has already superseded, or a render we can no longer
 *   attribute because its commit fell off the bounded log. The only correct
 *   response is to ignore it: adopting it would pull characters back out of the
 *   field under the user's cursor and leave the input disagreeing with the
 *   address bar permanently, because the form would then believe it had nothing
 *   left to commit.
 *
 *   KNOWN LIMITATION, deliberately not papered over. `stale` describes the
 *   field and the URL, not the RESULTS. By the time this is returned React has
 *   already committed the page with the superseded `initialQuery`, so the result
 *   list and the announced sentence describe a query the user has moved past,
 *   and nothing here re-fetches. In the common ordering the newer commit's
 *   render is still to come and repairs it; in the ordering where the newer
 *   render arrived FIRST, the results stay wrong until the user asks again.
 *
 *   Both AUTOMATIC repairs were tried on paper and rejected. Calling
 *   `router.refresh()` from the stale branch loops if the commit is left unspent
 *   (the refetched render matches the same commit and asks for another refresh)
 *   and ADOPTS a superseded query if it is spent (the refetched render matches
 *   nothing and looks external) — so the recovery would reintroduce the exact
 *   defect this module exists to prevent, in a retry loop. Re-issuing
 *   `router.replace` for `latestRequestedQuery` has the same shape. A wrong
 *   result list that one further request corrects is a better failure than a
 *   self-sustaining navigation loop; `search-sync.test.ts` pins the limitation
 *   so it stays a decision rather than an oversight.
 *
 *   "Until the user asks again" is not only the next keystroke. Everything in
 *   the paragraph above is an argument about a trigger this module pulls by
 *   itself; a SUBMIT is pulled by the user and costs one gesture per attempt, so
 *   it cannot sustain a loop no matter what the server sends back. That is what
 *   `decideSearchSubmit` is for, and it is the reason the hint under the field
 *   can honestly go on saying that Enter searches straight away.
 * - `adopt` — the query changed somewhere other than this input: a shared link,
 *   a bookmark, the back button. That is what makes the URL, rather than this
 *   component's state, the addressable thing, so the field follows it.
 */
export type SearchSyncDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "acknowledged"; readonly epoch: number }
  | { readonly kind: "stale"; readonly epoch: number }
  | { readonly kind: "adopt"; readonly query: string };

/**
 * How many commits stay recognisable as our own.
 *
 * A commit is normally acknowledged within one round trip, so this only has to
 * span the navigations that can be in flight at once. It is a bound rather than
 * an unbounded log because a long typing session would otherwise grow one entry
 * per pause, forever, for no benefit: a render older than the last 32 commits is
 * not a response anyone is still waiting for.
 *
 * "Not a response anyone is still waiting for" is an assumption, not a proof,
 * which is why `trimmedThroughEpoch` records that the bound has bitten. The
 * bound decides how much MEMORY this keeps; it must never decide whether a
 * render is treated as external.
 */
export const SEARCH_SYNC_HISTORY_LIMIT = 32;

/** The log and its trim watermark, which only ever move together. */
type CommitLog = Pick<SearchSyncState, "commits" | "trimmedThroughEpoch">;

function appendCommit(state: SearchSyncState, commit: SearchCommit): CommitLog {
  const next = [...state.commits, commit];
  if (next.length <= SEARCH_SYNC_HISTORY_LIMIT) {
    return { commits: next, trimmedThroughEpoch: state.trimmedThroughEpoch };
  }

  const dropped = next.length - SEARCH_SYNC_HISTORY_LIMIT;
  const lastDropped = next[dropped - 1];
  return {
    commits: next.slice(dropped),
    // `Math.max` rather than assignment: epochs only increase, so this is
    // already monotonic, but stating it means a future change to the trim rule
    // cannot make the watermark move backwards without someone noticing.
    trimmedThroughEpoch:
      lastDropped === undefined
        ? state.trimmedThroughEpoch
        : Math.max(state.trimmedThroughEpoch, lastDropped.epoch)
  };
}

/**
 * The LATEST UNSPENT commit of a given query, searched newest-first.
 *
 * Latest and not first: a user who types "aur", deletes back to "au" and types
 * "aur" again has committed the same string twice, and the render that arrives
 * belongs to the newer of the two. Matching the older one would classify a
 * current render as stale and freeze the field.
 *
 * Unspent and not merely present: one commit produces at most one render, so a
 * commit whose render has already been matched cannot explain a second one.
 * Without that, a user who typed "a" then "au" could never be sent back to
 * `/search?q=a` by a link or the back button — the already-answered commit for
 * "a" would match, its epoch would be below `appliedEpoch`, and a real external
 * navigation would be discarded as a stale render forever.
 */
function findUnspentCommit(
  commits: readonly SearchCommit[],
  query: string
): { readonly commit: SearchCommit; readonly index: number } | null {
  for (let index = commits.length - 1; index >= 0; index -= 1) {
    const commit = commits[index];
    if (commit !== undefined && !commit.spent && commit.query === query) return { commit, index };
  }
  return null;
}

/** A copy of the log with one entry marked answered. Never mutates the input. */
function spendCommit(commits: readonly SearchCommit[], index: number): readonly SearchCommit[] {
  return commits.map((commit, at) => (at === index ? { ...commit, spent: true } : commit));
}

/**
 * Initial state, seeded with the query the server rendered.
 *
 * The seed is a commit at epoch 0 so that first render is `unchanged` rather
 * than `adopt` — arriving on `/search?q=aurora` is not an external navigation
 * away from something, it is where the form started.
 *
 * It is seeded SPENT, because its render is the one already on screen. Leaving
 * it unspent would mean a later navigation back to the initial query matched it
 * and was classified against epoch 0 instead of being adopted.
 */
export function createSearchSyncState(initialQuery: string): SearchSyncState {
  const query = normalizeSearchQuery(initialQuery);
  return {
    commits: [{ query, epoch: 0, spent: true }],
    appliedEpoch: 0,
    appliedQuery: query,
    trimmedThroughEpoch: NOTHING_TRIMMED,
    nextEpoch: 1
  };
}

/**
 * The query this form last asked the URL to become — which is not necessarily
 * the query currently in the URL.
 *
 * This is what "do we need to commit?" must be answered against. Comparing
 * against the query the server last rendered instead would re-issue a
 * navigation that is already in flight on every keystroke.
 */
export function latestRequestedQuery(state: SearchSyncState): string {
  const latest = state.commits[state.commits.length - 1];
  // `commits` is never empty: it is seeded at construction and only ever
  // appended to. `null` here would be a corrupted state, not an empty search,
  // so it is not silently turned into one.
  return latest === undefined ? "" : latest.query;
}

/** Record a navigation this form is about to start. */
export function recordSearchCommit(state: SearchSyncState, rawQuery: string): SearchSyncState {
  const query = normalizeSearchQuery(rawQuery);
  return {
    ...state,
    ...appendCommit(state, { query, epoch: state.nextEpoch, spent: false }),
    nextEpoch: state.nextEpoch + 1
  };
}

/**
 * Classify an arriving `?q=` against what this form has asked for.
 *
 * This is deliberately not "trust whichever render arrived last". Whether the
 * App Router can deliver an older navigation's render after a newer one is an
 * implementation detail of its action queue, and this form does not depend on
 * the answer: a render is matched to the request that produced it, and a
 * request that a later one superseded can never win.
 *
 * Idempotent by construction, because React re-runs effects — twice per mount
 * under StrictMode in development, and again whenever an effect's dependencies
 * are re-evaluated. Reconciling the same query twice classifies it as
 * `unchanged` the second time rather than adopting it again: the first pass
 * spends the commit, and the fallback below recognises the query already on
 * screen.
 *
 * WHAT CANNOT BE DECIDED FROM THE QUERY STRING ALONE, stated plainly. A commit
 * whose navigation was cancelled before it ever rendered stays unspent forever,
 * and if a later EXTERNAL navigation happens to carry that same query it will be
 * matched to that commit and classified `acknowledged` or `stale` rather than
 * `adopt`. Nothing in `?q=` can tell those two apart; the alternative — putting
 * a per-request nonce in the URL — was rejected outright, because the address is
 * the artefact the user copies and shares and it must not carry this
 * component's bookkeeping, and because a shared link would have no nonce anyway
 * and would land back on exactly this ambiguity.
 *
 * So the ambiguity is resolved toward the RECOVERABLE failure. The residual
 * misclassification leaves the field holding what the user typed while the URL
 * and results show the external query; one keystroke commits and everything
 * re-converges. The opposite choice — treating an unattributable render as
 * external — is the one that is not recoverable: it writes an old query into the
 * field under the cursor, pushes `appliedEpoch` above every outstanding commit
 * so all of them are stale forever, and makes that old query the latest
 * requested one, which is precisely what the debounce guard then refuses to
 * re-commit. Same reasoning drives the trimmed-log branch below.
 */
export function reconcileSearchQuery(
  state: SearchSyncState,
  incomingRaw: string
): { readonly state: SearchSyncState; readonly decision: SearchSyncDecision } {
  const incoming = normalizeSearchQuery(incomingRaw);
  const match = findUnspentCommit(state.commits, incoming);

  if (match !== null) {
    const commits = spendCommit(state.commits, match.index);

    if (match.commit.epoch > state.appliedEpoch) {
      return {
        state: { ...state, commits, appliedEpoch: match.commit.epoch, appliedQuery: incoming },
        decision: { kind: "acknowledged", epoch: match.commit.epoch }
      };
    }

    /*
     * Superseded: a newer request of ours has already been applied. Reported as
     * `stale` for every epoch at or below the watermark rather than splitting
     * out an `epoch === appliedEpoch` case as `unchanged` — the two behave
     * identically, but "the render already on screen" and "a render a newer one
     * beat" are different facts and the union should not conflate them. The
     * equal case is in fact unreachable, because the commit at `appliedEpoch` is
     * always spent by whatever applied it; `<=` is here so that a future change
     * which makes it reachable lands on the honest classification instead of on
     * a silently wrong one.
     */
    return {
      state: { ...state, commits },
      decision: { kind: "stale", epoch: match.commit.epoch }
    };
  }

  /*
   * No unspent commit matches. Before concluding anything about where this
   * render came from: is it simply the render already on screen, arriving again
   * because React re-ran the effect? That is the StrictMode path and the
   * re-mount path, and it must be inert.
   */
  if (incoming === state.appliedQuery) {
    return { state, decision: { kind: "unchanged" } };
  }

  if (state.trimmedThroughEpoch !== NOTHING_TRIMMED) {
    /*
     * The bounded log has dropped commits, so "not ours" is no longer something
     * this function can prove — the query may belong to a commit we deliberately
     * forgot. Ignoring it is wrong only for a genuinely external navigation that
     * arrives after 32 of our own commits in one visit, and it costs that user a
     * field that still shows what they typed until they touch the keyboard.
     * Adopting it is wrong for every trimmed render, and it costs that user the
     * surface: the search box accepts typing and never navigates again.
     *
     * The reported epoch is the watermark, which is the newest thing the log can
     * still honestly say about a commit it no longer holds individually.
     */
    return { state, decision: { kind: "stale", epoch: state.trimmedThroughEpoch } };
  }

  /*
   * The log is complete and holds no unspent commit for this query, so nobody
   * here asked for it and something outside the form set it. It becomes the
   * applied epoch — it is newer than anything we requested — but our outstanding
   * commits are KEPT rather than discarded, so that when one of them lands a
   * moment later it is recognised as stale and ignored instead of quietly
   * undoing the user's navigation. It is recorded SPENT: its render is the one
   * that just arrived.
   */
  const epoch = state.nextEpoch;
  const log = appendCommit(state, { query: incoming, epoch, spent: true });
  return {
    state: {
      commits: log.commits,
      trimmedThroughEpoch: log.trimmedThroughEpoch,
      appliedEpoch: epoch,
      appliedQuery: incoming,
      nextEpoch: epoch + 1
    },
    decision: { kind: "adopt", query: incoming }
  };
}

/**
 * What an explicit submit should do.
 *
 * - `commit` — the field says something we have not asked for yet. The ordinary
 *   path: skip the rest of the debounce and navigate now.
 * - `reissue` — the field says exactly what we last asked for, but the page on
 *   screen was rendered for something else. Ask for it AGAIN.
 * - `settled` — the field, the last request and the rendered page all agree.
 *   There is nothing a navigation could change, so none is started.
 */
export type SearchSubmitDecision =
  | { readonly kind: "commit"; readonly query: string }
  | { readonly kind: "reissue"; readonly query: string }
  | { readonly kind: "settled" };

/**
 * Enter, as a rule rather than as an event handler.
 *
 * The hint under the field promises that Enter searches straight away. Comparing
 * the typed value against `latestRequestedQuery` alone — which is the whole of
 * what the debounce guard needs — kept that promise only while the debounce had
 * not already fired. Once it had, submit was a total no-op, and the one state
 * the promise most needed to hold in was precisely the state it could not
 * repair: after a `stale` render the page shows a query the user has moved past
 * while the field and the last request agree with each other, so "the query
 * changed" is false and Enter did nothing at all. The user's only recovery was
 * to type a character they did not want.
 *
 * THE THIRD INPUT IS WHAT MAKES THE DIFFERENCE, and it is why this takes a
 * `serverQuery` rather than deriving everything from the state. The reconciler
 * compares an arriving render against the requests this form made; it never asks
 * whether the render currently on screen is the one that was asked for. That
 * question has a different answer and it can only be asked from outside a
 * reconcile pass, at a moment when both values are known to be current.
 *
 * `reissue` IS the `router.replace` the `stale` note rejects, and the difference
 * is the trigger, not the mechanism. Rejected there because a reconciler-driven
 * repair re-runs on the render it causes and therefore has no fixed point; here
 * the loop needs a keypress per iteration, which is a user deciding to try
 * again rather than a machine spinning. Nothing else about the rejection is
 * weakened: this returns `reissue` only from a submit, and the debounce and the
 * reconciler still never produce one.
 *
 * NO COMMIT IS RECORDED FOR A `reissue`, deliberately. The log exists to
 * attribute an arriving render to a request, and this asks for a query that is
 * already the latest request — so the render it produces is attributed by what
 * is already there: it matches the outstanding commit if one is still in flight
 * (`acknowledged`), and otherwise falls through to `incoming === appliedQuery`
 * (`unchanged`), because a spent latest commit is only spent by something that
 * made its query the applied one. It can never be `adopt`, so a re-issue can
 * never write the field out from under the cursor. Appending a duplicate commit
 * instead would leave an entry that only the re-issued render could answer, and
 * a router that serves the same URL from its client cache would leave that entry
 * unspent forever — which is the one condition under which a later external
 * navigation to the same query is misclassified.
 *
 * `serverQuery` is normalised on the way in even though the caller's prop is
 * documented as already normalised. `normalizeSearchQuery` is idempotent, so it
 * costs nothing, and the comparison this function exists to make must not
 * silently become "these two strings were spaced differently".
 */
export function decideSearchSubmit(
  state: SearchSyncState,
  rawValue: string,
  serverQuery: string
): SearchSubmitDecision {
  const value = normalizeSearchQuery(rawValue);
  const requested = latestRequestedQuery(state);

  if (value !== requested) return { kind: "commit", query: value };
  if (normalizeSearchQuery(serverQuery) !== requested) return { kind: "reissue", query: requested };
  return { kind: "settled" };
}
