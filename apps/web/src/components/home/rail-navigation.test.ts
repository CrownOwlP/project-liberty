import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { entryControl, isRailStackKey, nextRail, railOwningFocus } from "./rail-navigation";

/**
 * Up and down between the rails (W132-B).
 *
 * The same arrangement `lib/a11y/roving.test.ts` has for the other axis, and
 * for the same reason: `apps/web/vitest.config.ts` is `environment: "node"`, so
 * the decisions are numbers and booleans here and `rail-stack.tsx` is the thin
 * consumer that holds the elements.
 */

describe("which keys the stack answers", () => {
  it("claims the two vertical arrows", () => {
    expect(isRailStackKey("ArrowDown")).toBe(true);
    expect(isRailStackKey("ArrowUp")).toBe(true);
  });

  it("leaves the keys the rails and the document already own", () => {
    /* Left/Right/Home/End belong to `roving.ts` -- one key doing two things
     * depending on which element has focus is not a direction. PageUp/PageDown
     * and Tab belong to the document. */
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "PageDown", "Tab", "Enter", " "]) {
      expect(isRailStackKey(key), `${key} was claimed`).toBe(false);
    }
  });
});

describe("where a vertical key leads", () => {
  it("moves to the next rail and the previous one", () => {
    expect(nextRail("ArrowDown", 0, 3)).toBe(1);
    expect(nextRail("ArrowDown", 1, 3)).toBe(2);
    expect(nextRail("ArrowUp", 2, 3)).toBe(1);
    expect(nextRail("ArrowUp", 1, 3)).toBe(0);
  });

  it("gives the key back at both edges instead of clamping", () => {
    /*
     * THE ONE PLACE THIS MODULE DISAGREES WITH `roving.ts`, and it is deliberate.
     * `nextActive` clamps and its caller swallows the key, because a HORIZONTAL
     * key at the end of a rail would otherwise scroll the page. Up and Down ARE
     * how a reader scrolls, so at the edges of the stack they must reach the
     * document -- `null` is what tells `rail-stack.tsx` not to call
     * `preventDefault`.
     */
    expect(nextRail("ArrowDown", 2, 3)).toBeNull();
    expect(nextRail("ArrowUp", 0, 3)).toBeNull();
  });

  it("has no answer when there is no second rail to move to", () => {
    expect(nextRail("ArrowDown", 0, 1)).toBeNull();
    expect(nextRail("ArrowUp", 0, 1)).toBeNull();
    expect(nextRail("ArrowDown", 0, 0)).toBeNull();
  });

  it("refuses a current index the stack does not have", () => {
    /* The rails re-render -- continue watching resolves to nothing, a rail is
     * dropped for having no surfaceable items -- and a remembered index can
     * name a rail that is gone. `roving.ts` clamps its equivalent because it
     * must land somewhere; here the honest answer is to do nothing. */
    expect(nextRail("ArrowDown", 7, 3)).toBeNull();
    expect(nextRail("ArrowUp", -1, 3)).toBeNull();
  });

  it("answers nothing for a key it does not own, whatever the indices say", () => {
    expect(nextRail("ArrowRight", 0, 3)).toBeNull();
    expect(nextRail("End", 0, 3)).toBeNull();
  });
});

describe("which rail the focus is in", () => {
  it("names the rail that contains the focused control", () => {
    expect(railOwningFocus([false, true, false])).toBe(1);
    expect(railOwningFocus([true])).toBe(0);
  });

  it("answers nothing for a focus the stack does not contain", () => {
    /* A click on the hero above the rails. Treating that as rail 0 would move
     * a reader into a rail they are not in. */
    expect(railOwningFocus([false, false])).toBeNull();
    expect(railOwningFocus([])).toBeNull();
  });
});

describe("where focus lands in the destination rail", () => {
  it("lands on the roving entry point, which is the control already in the tab order", () => {
    /* `RovingGroup` leaves exactly one card's controls at 0 and everything else
     * at -1, so arriving by ArrowDown lands exactly where arriving by Tab
     * would. */
    expect(entryControl([-1, -1, 0, 0, -1])).toBe(2);
  });

  it("lands on the first control of a rail that has not hydrated", () => {
    /* Before `RovingGroup` runs, every control is in the natural tab order --
     * and an anchor with no tabindex attribute reports 0. */
    expect(entryControl([0, 0, 0])).toBe(0);
  });

  it("accepts a positive tabindex as well as zero", () => {
    expect(entryControl([3, -1])).toBe(0);
  });

  it("answers nothing when nothing in the rail is reachable", () => {
    /* Letting the key scroll is better than focusing something a reader cannot
     * Tab back out of. */
    expect(entryControl([-1, -1])).toBeNull();
    expect(entryControl([])).toBeNull();
  });
});

describe("the consumer stays thin, which is the only reason any of this is testable", () => {
  const consumer = readFileSync(new URL("./rail-stack.tsx", import.meta.url), "utf8")
    /* The component explains in prose what it refuses to touch; a rule its own
     * explanation can fail is not a rule. */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("decides nothing itself", () => {
    /* No key comparison, no index arithmetic: every branch in that file is a
     * guard against the DOM being other than it expects. */
    expect(consumer).not.toMatch(/"Arrow(Up|Down)"/);
    expect(consumer).not.toMatch(/\+\s*1|-\s*1/);
  });

  it("touches no browser API that a WebView2 window might not have", () => {
    /*
     * `app/error.tsx` re-renders `AppShell`, so a client component in the home
     * tree that threw at module evaluation or during render would take the
     * error fallback down with it. The handler reads `querySelectorAll`, which
     * returns an empty list rather than null, and nothing else.
     */
    for (const api of [
      "matchMedia",
      "ResizeObserver",
      "IntersectionObserver",
      "navigator.",
      "Intl.",
      "window.",
      "document."
    ]) {
      expect(consumer, `${api} reached the rail stack`).not.toContain(api);
    }
  });

  it("runs only from a key press -- no effect, no module-evaluation work", () => {
    expect(consumer).not.toContain("useEffect");
    expect(consumer).not.toContain("useLayoutEffect");
  });

  it("prevents the default exactly once, after it has somewhere to go", () => {
    const prevented = consumer.match(/preventDefault/g) ?? [];
    expect(prevented).toHaveLength(1);
    /* Every guard returns before it. */
    expect(consumer.indexOf("preventDefault")).toBeGreaterThan(consumer.lastIndexOf("return;"));
  });
});
