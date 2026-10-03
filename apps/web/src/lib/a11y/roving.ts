/* -------------------------------------------------------------------------
 * What a roving tabindex over a rail of cards means (PW-0310)
 *
 * ==========================================================================
 * THE PROBLEM THIS SOLVES, IN NUMBERS
 * ==========================================================================
 *
 * A `.rail` is a five-column grid of `article.card`, and a card is not one
 * control. It carries a heading link, a My List toggle whenever the id is one
 * the list can hold, and on the continue-watching rail a Start over link as
 * well. So a rail of five cards costs up to FIFTEEN tab stops, and the home
 * page renders two or three rails above each other. Crossing the browse
 * surface to reach the navigation below it is a journey nobody with a mouse
 * ever makes, which is why it went unnoticed, and PW-0310's acceptance names
 * it: "the rails are not arrow-key navigable, which is table stakes for a
 * desktop media application."
 *
 * ==========================================================================
 * THE SHAPE CHOSEN, AND THE TWO IT WAS CHOSEN OVER
 * ==========================================================================
 *
 * THE CARD IS THE ROVING ITEM, NOT THE CONTROL. Tab enters the rail once and
 * lands in the active card; Tab again moves through THAT CARD'S remaining
 * controls; Tab again leaves the rail entirely. Left and Right move the active
 * card, Home and End jump to the ends. A five-card rail is then two or three
 * tab stops instead of fifteen, and every control is still reachable.
 *
 * REJECTED: one roving stop per CONTROL, so that arrows walk heading, toggle,
 * heading, toggle across the rail. It is fewer concepts and it is wrong for
 * this content -- the thing a viewer is navigating between is titles, and an
 * arrow key that sometimes moves to a different title and sometimes to a
 * button on the same one is not a direction.
 *
 * REJECTED: `role="grid"` with `gridcell` children, which is the ARIA pattern
 * for exactly this and would be the right answer if the rail were a table of
 * cells. It is a list of articles with headings, and taking on grid semantics
 * would make a screen reader announce rows and columns that mean nothing here,
 * while suppressing the article and heading structure that means a great deal.
 * The lighter pattern buys the same keyboard economy without lying about what
 * the content is.
 *
 * ==========================================================================
 * EVERY DECISION IS HERE AND NOTHING HERE TOUCHES THE DOM
 * ==========================================================================
 *
 * `roving-group.tsx` holds element references and sets attributes; it asks
 * this module what the answer is. The split is the same one
 * `keyboard-reachability.ts` makes and for the same reason: a rule that can
 * only be exercised by running a browser is a rule that drifts.
 * ---------------------------------------------------------------------- */

/**
 * Which card should be active after a key press.
 *
 * `null` means this key is not ours and the event must be left alone -- which
 * is not a detail. A rail contains links and buttons, and swallowing a key the
 * group has no answer for is how a composite widget breaks Enter, Space, or
 * the browser's own find-as-you-type.
 *
 * NO WRAPAROUND. Right at the last card stays at the last card. A rail is a
 * row with two ends and a viewer holding Right expects to stop at the end of
 * it, the way they stop at the end of a line of text; silently teleporting
 * back to the start loses the one thing arrow keys are good at, which is
 * knowing where you are without looking. Home and End are the deliberate jump,
 * and they exist so the absence of wraparound costs nothing.
 */
export function nextActive(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
      return current >= last ? last : current + 1;
    case "ArrowLeft":
      return current <= 0 ? 0 : current - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * Whether a key press is one this group should answer at all.
 *
 * SEPARATE FROM `nextActive` ON PURPOSE. At the last card, `ArrowRight`
 * returns the last card -- the same index it already had -- and a caller that
 * decided "no movement means not ours" would hand that key straight to the
 * page and scroll the rail out from under the viewer. The two questions are
 * genuinely different: this one is about the key, the other is about where it
 * leads.
 */
export function isGroupKey(key: string): boolean {
  return key === "ArrowRight" || key === "ArrowLeft" || key === "Home" || key === "End";
}

/**
 * The tabindex every control in the group should carry.
 *
 * Returned as a plan over (card, control) positions rather than applied,
 * because applying it is a DOM job and deciding it is this one.
 *
 * `0` for every control in the active card and `-1` for every control
 * elsewhere. That is what makes Tab step THROUGH the active card and then out
 * of the group: the browser's own tab order does the walking, and this module
 * only decides who is in it.
 *
 * AN EMPTY CARD IS NOT A SKIPPED INDEX. A card with no controls -- the
 * watchlist's "a title we can't name right now" tile is one -- still occupies
 * a position, because the arrow keys move between TITLES and a viewer counting
 * three presses to the third title is not wrong just because the third title
 * has no link. `firstFocusable` below is what declines to move focus into one.
 */
export function tabIndexPlan(
  controlsPerCard: readonly number[],
  active: number
): readonly (readonly number[])[] {
  return controlsPerCard.map((controls, card) =>
    Array.from({ length: controls }, () => (card === active ? 0 : -1))
  );
}

/**
 * Where focus should go when the active card changes, or `null` for nowhere.
 *
 * The FIRST control of the card, which is the heading link on every card this
 * application renders -- so arrowing along a rail reads out title after title,
 * which is the point of arrowing along a rail.
 *
 * `null` when the card has no controls. Focus stays where it was, the active
 * index still moves, and the next arrow press continues past it. Moving focus
 * to a card with nothing in it would strand a keyboard viewer on an element
 * they cannot act on and cannot leave by the same key that got them there.
 */
export function firstFocusable(controlsPerCard: readonly number[], active: number): number | null {
  const controls = controlsPerCard[active];
  if (controls === undefined || controls <= 0) return null;
  return 0;
}

/**
 * Which card an arriving focus belongs to, given the control it landed on.
 *
 * WHY THE GROUP LISTENS FOR FOCUS AT ALL. A viewer can enter a rail without
 * using its arrow keys -- a click, a Shift+Tab from below, a screen reader's
 * own navigation -- and if the active card did not follow them, the first
 * arrow press would yank focus back to wherever the group last thought it was.
 * That is the single most disorienting thing a composite widget can do.
 *
 * `null` for a control the group does not contain, which the caller must treat
 * as "not ours" rather than as index 0.
 */
export function cardOwning(
  cardControlCounts: readonly number[],
  flatControlIndex: number
): number | null {
  if (flatControlIndex < 0) return null;
  let seen = 0;
  for (let card = 0; card < cardControlCounts.length; card += 1) {
    const controls = cardControlCounts[card] ?? 0;
    if (flatControlIndex < seen + controls) return card;
    seen += controls;
  }
  return null;
}

/**
 * Clamp a remembered active index onto a group that has changed size.
 *
 * Rails re-render: a watchlist entry is removed, a search returns fewer
 * results. An index held across that is a stale number, and reading it
 * unchecked is how a group ends up with NO card in the tab order -- every
 * control at -1 and the whole rail unreachable, which is the exact failure
 * `assessRovingGroup` in `keyboard-reachability.ts` exists to catch. Clamped
 * to the last card rather than reset to the first, because a viewer who was at
 * the end of a list that shrank is still at the end of it.
 */
export function clampActive(active: number, count: number): number {
  if (count <= 0) return 0;
  if (active < 0) return 0;
  if (active > count - 1) return count - 1;
  return active;
}
