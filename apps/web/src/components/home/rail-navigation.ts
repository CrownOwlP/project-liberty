/* -------------------------------------------------------------------------
 * MOVING BETWEEN RAILS, NOT JUST ALONG ONE (W132-B)
 *
 * ==========================================================================
 * WHAT ALREADY EXISTED, AND WHY THIS IS NOT A SECOND COPY OF IT
 * ==========================================================================
 *
 * `lib/a11y/roving.ts` and `lib/a11y/roving-group.tsx` already give every rail
 * in this product a roving tabindex: one card in the tab order, Left and Right
 * to move between cards, Home and End to the ends, no wraparound. Every rail on
 * the home surface is already wrapped in that group -- see `catalog-rail.tsx`
 * and `continue-watching/continue-watching-rail.tsx` -- so WITHIN a rail there
 * was nothing to add and nothing here restates any of it. A second module
 * deciding `ArrowRight` would be exactly the drift that file's own header warns
 * about.
 *
 * WHAT WAS MISSING IS THE OTHER AXIS. A roving group makes one rail cheap to
 * cross and says nothing about the rail above or below it, so leaving a rail
 * still meant Tab -- out through the remaining controls of the active card,
 * into the next group's entry point. On the home surface that is two or three
 * groups stacked vertically (continue watching, films, series), and the
 * arrangement a viewer of a desktop media application expects is the obvious
 * one: Up and Down move between ROWS the way Left and Right move within one.
 *
 * ==========================================================================
 * THE ONE PLACE THIS DELIBERATELY DISAGREES WITH `roving.ts`
 * ==========================================================================
 *
 * `nextActive` CLAMPS at the ends and its caller swallows the key anyway, on
 * the stated grounds that letting ArrowRight through at the last card would
 * "scroll the rail out from under the viewer". That argument is about a
 * HORIZONTAL key in a document that scrolls VERTICALLY, and it inverts here:
 * Down at the last rail and Up at the first are exactly the keys a reader uses
 * to move the page. So `nextRail` answers `null` rather than the index it
 * already had, and `rail-stack.tsx` calls `preventDefault` only when it has
 * somewhere to go. The rails get the keys while they are useful inside the
 * stack and give them back at the edges, which is also why nothing here needs
 * to re-implement scrolling.
 *
 * ==========================================================================
 * PLAIN NUMBERS, FOR THE SAME REASON `roving.ts` IS PLAIN NUMBERS
 * ==========================================================================
 *
 * `apps/web/vitest.config.ts` sets `environment: "node"`: this workspace has no
 * DOM test environment, and a `"use client"` component rendering `next/link`
 * cannot be rendered in a test at all. Every decision below is therefore a
 * function over numbers and booleans with its own unit test, and
 * `rail-stack.tsx` holds element references, asks these questions and does
 * nothing else.
 * ---------------------------------------------------------------------- */

/**
 * Whether a key press is one the rail stack should answer at all.
 *
 * SEPARATE FROM `nextRail` FOR THE REASON `isGroupKey` IS SEPARATE FROM
 * `nextActive`: the two questions are genuinely different. This one is about
 * the key, the other is about where it leads -- and because `nextRail` answers
 * `null` at both edges, a caller that inferred ownership from movement would
 * treat an edge press as somebody else's key. Here that happens to be the
 * behaviour we want, but relying on it would couple the two answers, and the
 * first time one of them changed the coupling would be invisible.
 *
 * ONLY THE TWO VERTICAL ARROWS. Not PageUp/PageDown, which belong to the
 * document and are how a reader moves past the rails; not Tab, which the
 * roving groups deliberately leave to the browser; and not Home/End, which
 * `roving.ts` has already claimed for the ends of a rail -- redefining them
 * here as the ends of the STACK would mean one key doing two things depending
 * on which element happened to have focus.
 */
export function isRailStackKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp";
}

/**
 * Which rail a vertical key moves to, or `null` for "leave this key alone".
 *
 * `null` COVERS FOUR DIFFERENT SITUATIONS AND THE CALLER TREATS THEM ALIKE: a
 * key that is not ours, a stack with fewer than two rails, a `current` that
 * names no rail, and an edge press. All four mean the rails have no answer and
 * the page should do whatever it does with that key, which for Up and Down is
 * to scroll. Distinguishing them would hand the caller a decision it has no
 * use for.
 *
 * NO WRAPAROUND, on `roving.ts`'s argument carried over one axis: a reader
 * holding Down expects to stop at the end of the rails the way they stop at the
 * end of a list, and teleporting to the top would lose the one thing arrow keys
 * are good at, which is knowing where you are without looking.
 */
export function nextRail(key: string, current: number, count: number): number | null {
  if (!isRailStackKey(key)) return null;
  if (count < 2) return null;
  if (current < 0 || current > count - 1) return null;
  if (key === "ArrowDown") return current === count - 1 ? null : current + 1;
  return current === 0 ? null : current - 1;
}

/**
 * Which rail the focused control belongs to, given one "does this rail contain
 * it" answer per rail.
 *
 * TAKES BOOLEANS RATHER THAN NODES, which is what keeps this module free of the
 * DOM. The caller asks `group.contains(target)` -- the one question a browser
 * can answer and a test cannot -- and this decides what to do with the answers.
 *
 * THE FIRST MATCH WINS, AND NESTING IS THEREFORE NOT AN ERROR HERE. Rails are
 * siblings today and a `contains` sweep over siblings produces at most one
 * `true`. If a group were ever nested inside another, the outer one appears
 * first in document order and would win -- which is a defensible answer rather
 * than a correct one, so it is stated rather than relied upon.
 *
 * `null` for a focus the stack does not contain, which the caller must treat as
 * "not ours" rather than as rail 0. A click on the hero above the rails is
 * exactly that case, and moving the reader into a rail they are not in would be
 * the most disorienting thing this component could do.
 */
export function railOwningFocus(contains: readonly boolean[]): number | null {
  const owner = contains.indexOf(true);
  return owner === -1 ? null : owner;
}

/**
 * Which control in the destination rail should receive focus, given the
 * `tabIndex` of each candidate in document order.
 *
 * THE ROVING ARRANGEMENT IS THE ANSWER, READ BACK RATHER THAN RECOMPUTED. Once
 * `RovingGroup` has hydrated, exactly one card's controls sit at `0` and every
 * other control in the rail sits at `-1` -- that IS the rail's entry point, by
 * construction and by the e2e guard that requires exactly one card to be
 * reachable. So the first candidate with a non-negative `tabIndex` is where a
 * viewer arriving by Tab would have landed, and arriving by ArrowDown should
 * land in the same place; anything else would mean the two ways into a rail
 * disagreed about where its entry is.
 *
 * ON A RAIL THAT HAS NOT HYDRATED, every control is in the natural tab order,
 * so the first candidate is the first control of the first card and this
 * answers it. That is the correct answer for that state too, and it is why this
 * function needs no "has the group hydrated" input.
 *
 * `null` WHEN NOTHING IN THE RAIL IS REACHABLE, which the caller treats as "no
 * answer" and lets the key through. A rail whose every candidate is `-1` is one
 * whose active card's controls are not of a kind the caller queried for, and
 * focusing something a viewer cannot Tab back out of would be worse than
 * scrolling.
 */
export function entryControl(tabIndexes: readonly number[]): number | null {
  const index = tabIndexes.findIndex((tabIndex) => tabIndex >= 0);
  return index === -1 ? null : index;
}
