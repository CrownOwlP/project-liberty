/* -------------------------------------------------------------------------
 * The decisions a roving rail makes (PW-0310).
 *
 * `roving-group.tsx` holds element references and sets attributes; everything
 * it has an opinion about is here, over plain numbers, so the edges can be
 * argued with in a unit test rather than only by pressing a key in a browser.
 * Whether the attributes actually land is `e2e/tests/keyboard-reachability.
 * spec.ts`, which re-derives the group from the real DOM and refuses to accept
 * a group that has quietly left every card out of the tab order.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import {
  cardOwning,
  clampActive,
  firstFocusable,
  isGroupKey,
  nextActive,
  tabIndexPlan
} from "./roving";

describe("which key moves the active card", () => {
  it("moves one card at a time with the arrows", () => {
    expect(nextActive("ArrowRight", 0, 5)).toBe(1);
    expect(nextActive("ArrowLeft", 3, 5)).toBe(2);
  });

  it("STOPS AT THE ENDS RATHER THAN WRAPPING AROUND", () => {
    /* A rail is a row with two ends. A viewer holding Right expects to stop
     * at the end of it, the way they stop at the end of a line of text;
     * teleporting back to the start loses the one thing arrow keys are good
     * at, which is knowing where you are without looking. */
    expect(nextActive("ArrowRight", 4, 5)).toBe(4);
    expect(nextActive("ArrowLeft", 0, 5)).toBe(0);
  });

  it("jumps to either end, which is what pays for the absence of wraparound", () => {
    expect(nextActive("Home", 3, 5)).toBe(0);
    expect(nextActive("End", 0, 5)).toBe(4);
  });

  it("ANSWERS null FOR A KEY THAT IS NOT OURS, which is not a detail", () => {
    /* A rail contains links and buttons. Swallowing a key the group has no
     * answer for is how a composite widget breaks Enter, Space, or the
     * browser's own find-as-you-type. */
    for (const key of ["Enter", " ", "a", "Tab", "ArrowDown", "PageUp", "Escape"]) {
      expect(nextActive(key, 1, 5)).toBeNull();
    }
  });

  it("answers null for an empty group rather than an index into nothing", () => {
    expect(nextActive("ArrowRight", 0, 0)).toBeNull();
    expect(nextActive("Home", 0, 0)).toBeNull();
  });

  it("KNOWS A KEY IS OURS EVEN WHEN IT MOVES NOTHING, which is a separate question", () => {
    /*
     * At the last card ArrowRight returns the last card -- the same index it
     * already had. A caller that read "no movement" as "not ours" would hand
     * that key to the page and scroll the rail out from under the viewer.
     */
    expect(nextActive("ArrowRight", 4, 5)).toBe(4);
    expect(isGroupKey("ArrowRight")).toBe(true);
    expect(isGroupKey("Enter")).toBe(false);
    expect(isGroupKey("ArrowDown")).toBe(false);
  });
});

describe("who is in the tab order", () => {
  it("THE ACTIVE CARD'S CONTROLS, ALL OF THEM, AND NOBODY ELSE'S", () => {
    /* This is what makes Tab step through the active card and then leave the
     * rail: the browser's own tab order does the walking. */
    expect(tabIndexPlan([2, 3, 1], 1)).toEqual([
      [-1, -1],
      [0, 0, 0],
      [-1]
    ]);
  });

  it("leaves exactly one card reachable however many cards there are", () => {
    const plan = tabIndexPlan([1, 1, 1, 1, 1], 3);
    expect(plan.flat().filter((value) => value === 0)).toHaveLength(1);
    expect(plan[3]).toEqual([0]);
  });

  it("keeps an empty card as a position rather than skipping it", () => {
    /* The watchlist's "a title we can't name right now" tile has no controls.
     * Arrow keys move between TITLES, and a viewer counting three presses to
     * the third title is not wrong because the third title has no link. */
    expect(tabIndexPlan([2, 0, 2], 1)).toEqual([[-1, -1], [], [-1, -1]]);
  });
});

describe("where focus goes when the active card changes", () => {
  it("to the first control, which is the heading link on every card here", () => {
    expect(firstFocusable([2, 3], 1)).toBe(0);
  });

  it("NOWHERE AT ALL when the card has nothing to focus", () => {
    /* Focus stays put, the active index still moves, and the next arrow press
     * continues past it. Moving focus into an empty card would strand a
     * keyboard viewer on something they can neither act on nor leave by the
     * key that got them there. */
    expect(firstFocusable([2, 0, 2], 1)).toBeNull();
    expect(firstFocusable([], 0)).toBeNull();
  });
});

describe("following a viewer who arrived without using the arrows", () => {
  it("finds the card that owns the control focus landed on", () => {
    /* A click, a Shift+Tab from below, a screen reader's own navigation. If
     * the active card did not follow, the next arrow press would yank focus
     * back to wherever the group last thought it was. */
    const counts = [2, 3, 1];
    expect(cardOwning(counts, 0)).toBe(0);
    expect(cardOwning(counts, 1)).toBe(0);
    expect(cardOwning(counts, 2)).toBe(1);
    expect(cardOwning(counts, 4)).toBe(1);
    expect(cardOwning(counts, 5)).toBe(2);
  });

  it("steps over an empty card rather than attributing a control to it", () => {
    expect(cardOwning([2, 0, 2], 2)).toBe(2);
  });

  it("ANSWERS null FOR A CONTROL IT DOES NOT CONTAIN, not index 0", () => {
    /* "Not ours" and "the first card" are different answers, and conflating
     * them would make focus anywhere on the page move this rail's active
     * card. */
    expect(cardOwning([2, 2], 4)).toBeNull();
    expect(cardOwning([2, 2], -1)).toBeNull();
    expect(cardOwning([], 0)).toBeNull();
  });
});

describe("a remembered index meeting a group that changed size", () => {
  it("CLAMPS RATHER THAN LEAVING THE WHOLE RAIL UNREACHABLE", () => {
    /*
     * The failure this exists to prevent is specific and total: an active
     * index past the end means no card matches, every control is set to -1,
     * and the rail has no entry point at all -- which is exactly what
     * `assessRovingGroup` in keyboard-reachability.ts refuses, and which a
     * watchlist removal or a narrower search would otherwise cause.
     */
    expect(clampActive(7, 3)).toBe(2);
    expect(clampActive(-2, 3)).toBe(0);
    expect(clampActive(1, 3)).toBe(1);
  });

  it("clamps to the END, because a viewer at the end of a shrinking list is still there", () => {
    expect(clampActive(4, 2)).toBe(1);
  });

  it("answers 0 for a group that has emptied, rather than a negative index", () => {
    expect(clampActive(3, 0)).toBe(0);
  });
});
