/* -------------------------------------------------------------------------
 * Text that was typed before React arrived (PL-0705)
 *
 * The search field is ordinary server-rendered HTML before it is a React
 * component. From the moment that markup reaches the browser the input can be
 * focused and typed into, and the client bundle that turns it into a controlled
 * input lands some unbounded time later — on a cold cache, on a slow
 * connection, or behind whatever else the page is fetching. Characters typed in
 * that window exist in exactly ONE place: the `value` of the DOM node. React's
 * state was seeded from the query the server rendered and knows nothing about
 * them, so the first commit that updates the input writes that seed back over
 * the top and the typing is discarded with no error and no trace.
 *
 * WHO REPORTS THE LOSS, since this file has observed no run of its own. PL-0705's
 * task record is the source: it states that the race reproduces on WebKit and
 * not on Chromium, and it makes an EXECUTED Playwright run on WebKit the proof
 * the task is accepted against. No such run is recorded in this repository, so
 * the rule below stands on the mechanism above and is unproven end to end.
 *
 * It must not be read as the harness failure that IS recorded. The run described
 * in `apps/web/next.config.ts` and in `e2e/tests/critical-journey.spec.ts` failed
 * the search test on all four browser projects for a different reason and with a
 * different signature: `allowedDevOrigins` did not name the loopback IP, every
 * dev chunk was refused, and nothing hydrated at all -- the ABSENCE of hydration
 * rather than a race with it, with the typed text sitting in the box and the
 * address bar never moving. That is evidence about the dev server's origin guard
 * and evidence of nothing about this rule.
 *
 * The recovery rule is a handful of lines and it lives here rather than inside
 * the component for the same reason `search-sync.ts` does: `apps/web` runs
 * Vitest under the `node` environment with no DOM, so a rule written as a
 * `useLayoutEffect` body could not be tested at all — it would be reviewed once
 * and then trusted forever. The component reads the DOM and applies the answer;
 * it decides nothing.
 *
 * "ADOPT" HERE IS NOT THE `adopt` OF `search-sync.ts`, and the two must not be
 * read as one word. That one moves a query from the URL into the field, because
 * the URL is the addressable thing. This one moves text from the DOM node into
 * React's state, because the DOM node is where the user's typing already is.
 * They do not interact: `reconcileSearchQuery` never looks at the field, only at
 * the query the server rendered and at the requests this form made.
 * ---------------------------------------------------------------------- */

/**
 * Which render an observation was taken at.
 *
 * `hydration` is the first commit of a component instance. On a cold load of
 * this page that is the commit where React takes over markup the server
 * produced, and it is the only render at which the DOM and React's state can
 * disagree for a reason React did not cause — so it is the only render at which
 * the disagreement carries information. Arriving instead by a client-side
 * navigation, the same commit CREATES the element, so the two agree by
 * construction and the rule answers `settled`; naming the phase after the
 * interesting case does not make the uninteresting one wrong.
 *
 * `post-hydration` is every render after it. From then on React owns the value:
 * a divergence is either a keystroke React is already processing through
 * `onChange` or a value React itself is about to write, and in neither case is
 * the DOM a source to be copied back. Copying it back on a later render would
 * be a loop — the copy is a state update, which is a render, which observes the
 * DOM again.
 *
 * The phase is an INPUT to the rule rather than a decision the caller makes by
 * choosing when to call, so that "adoption happens once, at the boundary" is a
 * property of the tested function instead of a property of a dependency array.
 */
export type SearchFieldPhase = "hydration" | "post-hydration";

/**
 * The three facts the rule needs, named rather than positional.
 *
 * `domValue` and `renderedValue` are both strings, and the entire meaning of the
 * comparison is which of the two is allowed to win. Positional arguments would
 * make transposing them a silent behaviour change, and the transposed behaviour
 * is precisely the defect: writing the server's value over the user's text.
 */
export interface SearchFieldObservation {
  /**
   * What the input element holds at the moment of the observation, or `null`
   * when it could not be read.
   *
   * `null` is "unknown" and never "empty". Collapsed into `""` the two would be
   * indistinguishable, and they demand opposite responses: an empty field that
   * the server rendered non-empty is a user who cleared it and must be
   * honoured, while an unreadable field is a fact we do not have and must not
   * act on.
   */
  readonly domValue: string | null;
  /**
   * The value React rendered into that input — what it is controlling the input
   * with. At the hydration boundary that is the query the server rendered.
   */
  readonly renderedValue: string;
  readonly phase: SearchFieldPhase;
}

/**
 * What to do with whatever the field was found holding.
 *
 * - `adopt` — the field holds something other than what was rendered into it,
 *   so the text belongs to the user and React's state must be moved to it. The
 *   paragraphs below are the whole of the argument for that.
 * - `settled` — the field holds exactly what was rendered into it. Nobody typed
 *   anything, and there is nothing to recover.
 * - `unobservable` — the element could not be read. Nothing is assumed and
 *   nothing is written; a guessed value here would be a value the user did not
 *   type, written into a field under their cursor.
 * - `not-hydrating` — asked at a render other than the boundary. Refused rather
 *   than answered, because after hydration the DOM's value is React's own
 *   output and adopting it is at best circular.
 *
 * WHY A DIVERGENCE CAN ONLY BE HONOURED. Nothing this application ships writes
 * the input's value before hydration: the server renders it once, and the only
 * code that would touch it afterwards is the bundle that has not run yet. So a
 * difference was put there from outside the application, and the ordinary way
 * that happens is a person typing into a field that looks ready because it IS
 * ready. Whatever the source, it is text the user can SEE in the box, and
 * replacing visible text with something else is the defect this rule exists to
 * remove. The rule does not need to identify the writer and deliberately does
 * not try.
 *
 * THE COMPARISON IS OVER RAW TEXT, NOT NORMALISED QUERIES. `renderedValue`
 * arrives already normalised (`normalizeSearchQuery` collapses runs of
 * whitespace and trims), so an untouched field reads back character for
 * character what was rendered and cannot diverge spuriously — including through
 * the "strip line breaks" value sanitisation that `<input type="search">`
 * applies, since a normalised query contains no line breaks. Comparing
 * NORMALISED values instead would call "the fall " and "the fall" equal and let
 * React delete a trailing space out from under a caret in the middle of a
 * sentence, which is this defect in miniature.
 * The adopted value is likewise the raw text, uninterpreted: the field's state
 * holds what was typed, and normalisation happens where it already happens, on
 * the way into a URL.
 *
 * AN ADOPTED VALUE IS TEXT, NOT A PENDING SUBMIT, and that is a decision rather
 * than an omission. A pre-hydration Enter never reaches this rule at all: the
 * form carries no `action` and no `method`, so the browser submits it itself as
 * a GET against the current URL, the server renders the query, and the field
 * comes back agreeing with it — the no-JavaScript path, working as designed. So
 * the only thing that can still be sitting in the box at the boundary is text
 * the user has NOT submitted, and the honest reproduction of it is a keystroke:
 * write the state and let the ordinary debounce decide when that becomes a
 * navigation. Committing immediately instead would navigate at the instant of
 * hydration, possibly mid-word, which is the exact behaviour the debounce
 * exists to prevent. The third option — recording the adopted text as a request
 * without navigating — would be the worst of the three: `latestRequestedQuery`
 * would then equal the text in the field, the debounce guard would compare equal
 * on every subsequent keystroke, and the search box would accept typing and
 * never navigate again. `search-sync.ts` documents that failure twice; this must
 * not become a third way to reach it.
 *
 * IT CANNOT MAKE A STALE RESPONSE LOOK FRESH. Adoption writes the field's value
 * state and nothing else. It records no commit, issues no epoch, and moves
 * neither `appliedEpoch` nor `appliedQuery`, so no arriving render is
 * reclassified by it and the reconciler's invariants — including "a re-issued
 * navigation can never adopt", which is an argument about the commit log and the
 * applied query — are untouched. The only route from adopted text into
 * `SearchSyncState` is the debounce calling `recordSearchCommit`, which appends
 * one unspent commit at the highest epoch, exactly as a keystroke does. There is
 * also nothing in flight to confuse it with: at the hydration boundary the log
 * holds only the spent seed commit and this form has issued no navigation, and
 * that ordering is guaranteed rather than incidental — React runs every layout
 * effect in the commit phase, before any passive effect, and both the debounce
 * and the reconciler are passive.
 */
export type SearchHydrationDecision =
  | { readonly kind: "adopt"; readonly value: string }
  | { readonly kind: "settled" }
  | { readonly kind: "unobservable" }
  | { readonly kind: "not-hydrating" };

/**
 * Compare what the field holds against what was rendered into it, once.
 *
 * Pure and total. The guards run from the most fundamental refusal outwards: a
 * post-hydration observation is refused before its contents are considered at
 * all, because at that point the contents cannot mean what this rule would
 * otherwise read them to mean.
 */
export function decideHydrationAdoption(
  observation: SearchFieldObservation
): SearchHydrationDecision {
  if (observation.phase !== "hydration") return { kind: "not-hydrating" };

  // Unknown, so nothing is concluded. Reached only if the element could not be
  // read at the one moment it mattered; the boundary does not come round again.
  if (observation.domValue === null) return { kind: "unobservable" };

  // Identical text is not evidence of anything, and writing it back would be a
  // state update per mount for every visitor who typed nothing.
  if (observation.domValue === observation.renderedValue) return { kind: "settled" };

  return { kind: "adopt", value: observation.domValue };
}
