/* -------------------------------------------------------------------------
 * What the keyboard-reachability gate counts as a defect (PW-0310).
 *
 * The gate itself runs in a browser — `e2e/tests/keyboard-reachability.spec.ts`
 * — because `apps/web` has no DOM, no focus and no Tab key. What is tested
 * here is every JUDGEMENT the gate makes, over plain records, so the edges of
 * "interactive" and "legitimately unreachable" can be argued with in a unit
 * test rather than only by running a browser.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import {
  assessCardGroup,
  assessReachability,
  assessRovingGroup,
  describeFailure,
  isInteractive,
  type ObservedElement
} from "./keyboard-reachability";

let probeCounter = 0;

function el(overrides: Partial<ObservedElement> = {}): ObservedElement {
  probeCounter += 1;
  return {
    probe: `p${String(probeCounter)}`,
    describe: "button#play",
    tag: "button",
    inputType: null,
    role: null,
    tabIndexAttr: null,
    disabled: false,
    ariaHidden: false,
    inert: false,
    visible: true,
    hasClickHandler: false,
    href: null,
    ...overrides
  };
}

describe("what counts as something a person is meant to operate", () => {
  it("native controls, because of what they are", () => {
    for (const tag of ["button", "select", "textarea", "summary"]) {
      expect(isInteractive(el({ tag }))).toBe(true);
    }
    expect(isInteractive(el({ tag: "input", inputType: "text" }))).toBe(true);
    expect(isInteractive(el({ tag: "input", inputType: "checkbox" }))).toBe(true);
  });

  it("A LINK IS AN ANCHOR WITH SOMEWHERE TO GO, and an anchor without one is not", () => {
    /* `<a>` with no href is a styled span to the keyboard. Counting it would
     * report a defect in every decorative anchor and teach people to ignore
     * this gate. */
    expect(isInteractive(el({ tag: "a", href: "/watch/x" }))).toBe(true);
    expect(isInteractive(el({ tag: "a", href: null }))).toBe(false);
  });

  it("an element that CLAIMS an interactive role, because a role is a promise", () => {
    /* `role="button"` tells a screen-reader user it behaves like a button. A
     * button that cannot be focused is a broken promise, not a style. */
    expect(isInteractive(el({ tag: "div", role: "button" }))).toBe(true);
    expect(isInteractive(el({ tag: "span", role: "tab" }))).toBe(true);
    expect(isInteractive(el({ tag: "li", role: "option" }))).toBe(true);
    expect(isInteractive(el({ tag: "div", role: "presentation" }))).toBe(false);
    expect(isInteractive(el({ tag: "div", role: "list" }))).toBe(false);
  });

  it("AN ELEMENT WITH A CLICK HANDLER, which is the case this gate exists for", () => {
    /* A `<div onClick>` is how an unreachable control gets built without
     * anybody deciding to build one. */
    expect(isInteractive(el({ tag: "div", hasClickHandler: true }))).toBe(true);
    expect(isInteractive(el({ tag: "div", hasClickHandler: false }))).toBe(false);
  });

  it("and nothing else — ordinary content is not a control", () => {
    for (const tag of ["p", "div", "span", "h1", "li", "img", "section"]) {
      expect(isInteractive(el({ tag }))).toBe(false);
    }
    /* A hidden input is not a control either. */
    expect(isInteractive(el({ tag: "input", inputType: "hidden" }))).toBe(false);
  });
});

describe("which interactive elements are allowed to be out of the tab order", () => {
  const focused = new Set<string>();

  it("a disabled control, which is deliberately not focusable", () => {
    const verdict = assessReachability([el({ describe: "d", disabled: true })], focused);
    expect(verdict.unreachable).toEqual([]);
    expect(verdict.exempt).toEqual([{ describe: "d", reason: "disabled" }]);
  });

  it("aria-hidden and inert, which remove it from the tree and the keyboard ON PURPOSE", () => {
    expect(assessReachability([el({ describe: "h", ariaHidden: true })], focused).exempt).toEqual([
      { describe: "h", reason: "aria-hidden" }
    ]);
    expect(assessReachability([el({ describe: "i", inert: true })], focused).exempt).toEqual([
      { describe: "i", reason: "inert" }
    ]);
  });

  it("something with nothing on screen to focus", () => {
    expect(assessReachability([el({ describe: "v", visible: false })], focused).exempt).toEqual([
      { describe: "v", reason: "not-visible" }
    ]);
  });

  it("tabindex=-1 — the roving spelling, and the one that can be abused", () => {
    expect(assessReachability([el({ describe: "r", tabIndexAttr: "-1" })], focused).exempt).toEqual(
      [{ describe: "r", reason: "tabindex-negative" }]
    );
  });

  it("reports the AUTHOR'S reason first when several apply", () => {
    /* Disabled and invisible at once is reported as disabled: that is the fact
     * somebody chose, where invisibility is the one most likely to be
     * incidental. */
    const verdict = assessReachability(
      [el({ describe: "both", disabled: true, visible: false })],
      focused
    );
    expect(verdict.exempt[0]?.reason).toBe("disabled");
  });
});

describe("the verdict itself", () => {
  it("SEPARATES REACHED FROM UNREACHABLE, which is the whole gate", () => {
    const elements = [
      el({ probe: "a", describe: "button#play" }),
      el({ probe: "b", describe: "div#card", tag: "div", hasClickHandler: true }),
      el({ probe: "c", describe: "p#blurb", tag: "p" })
    ];
    const verdict = assessReachability(elements, new Set(["a"]));
    expect(verdict.reached.map((e) => e.describe)).toEqual(["button#play"]);
    expect(verdict.unreachable).toEqual([{ describe: "div#card" }]);
    /* The paragraph is not interactive and appears in none of the three. */
    expect(verdict.exempt).toEqual([]);
  });

  it("TELLS TWO IDENTICAL-LOOKING CONTROLS APART, which it once could not", () => {
    /*
     * The regression test for this gate's own first failure. A title page has
     * one `Play` link per episode row and every one of them describes
     * identically. When identity was the description, the second one looked
     * like the first: the tab walk thought it had come back round and stopped,
     * and three real, reachable links were reported as defects.
     *
     * Same description, different probes, one reached and one not. The
     * unreached one is a finding and the reached one is not, and no amount of
     * looking alike changes that.
     */
    const elements = [
      el({ probe: "row-1", describe: 'a.episodePlay "Play"', tag: "a", href: "/watch/e1" }),
      el({ probe: "row-2", describe: 'a.episodePlay "Play"', tag: "a", href: "/watch/e2" })
    ];
    const verdict = assessReachability(elements, new Set(["row-1"]));
    expect(verdict.reached).toHaveLength(1);
    expect(verdict.unreachable).toEqual([{ describe: 'a.episodePlay "Play"' }]);

    /* And when the walk reaches both, neither is a finding -- the case the
     * old behaviour got wrong in the other direction. */
    expect(assessReachability(elements, new Set(["row-1", "row-2"])).unreachable).toEqual([]);
  });

  it("names every failure, because a count sends somebody to read a diff", () => {
    const verdict = assessReachability(
      [
        el({ describe: "div#one", tag: "div", hasClickHandler: true }),
        el({ describe: "a#two", tag: "a", href: "/x" })
      ],
      new Set()
    );
    const message = describeFailure("/watch/demo", verdict);
    expect(message).toContain("/watch/demo");
    expect(message).toContain("div#one");
    expect(message).toContain("a#two");
    /* And it closes the obvious escape hatch in the message itself. */
    expect(message).toMatch(/DO NOT silence this by adding tabindex=-1/);
  });
});

describe("a roving group, which is where tabindex=-1 stops being an excuse", () => {
  const member = (describe: string, tabIndexAttr: string | null): ObservedElement =>
    el({ describe, tag: "button", tabIndexAttr });

  it("accepts exactly one entry point and names it", () => {
    const verdict = assessRovingGroup({
      describe: "the season tabs",
      members: [member("s1", "0"), member("s2", "-1"), member("s3", "-1")]
    });
    expect(verdict).toEqual({ ok: true, entryPoint: "s1" });
  });

  it("REFUSES A GROUP WITH NO ENTRY POINT, which is the abuse it exists to catch", () => {
    /* Every member at -1 silences the per-element check and leaves the group
     * unreachable. */
    const verdict = assessRovingGroup({
      describe: "the rail",
      members: [member("a", "-1"), member("b", "-1")]
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toMatch(/NONE in the tab order/);
  });

  it("refuses a group where Tab walks every member, which is not a roving tabindex", () => {
    const verdict = assessRovingGroup({
      describe: "the rail",
      members: [member("a", null), member("b", null), member("c", null)]
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toMatch(/3 members in the tab order/);
  });

  it("ignores members that are not on screen before judging the group", () => {
    /* A carousel with off-screen items still has one entry point; counting the
     * hidden ones would report a defect in every rail that scrolls. */
    const verdict = assessRovingGroup({
      describe: "the rail",
      members: [member("a", "0"), el({ describe: "b", tabIndexAttr: "0", visible: false })]
    });
    expect(verdict).toEqual({ ok: true, entryPoint: "a" });
  });

  it("refuses an empty group rather than passing it", () => {
    /* Vacuous success is how a gate stops gating. */
    expect(assessRovingGroup({ describe: "nothing", members: [] }).ok).toBe(false);
  });
});

describe("a rail of cards, which is where the exemption is actually paid for", () => {
  /* A control inside a card. `-1` is out of the tab order, `null` is in it. */
  const control = (describe: string, tabIndexAttr: string | null): ObservedElement =>
    el({ describe, tag: "a", href: "/title/x", tabIndexAttr });

  /** A card whose controls are all in or all out of the tab order. */
  const card = (name: string, controls: number, roving: boolean): ObservedElement[] =>
    Array.from({ length: controls }, (_unused, index) =>
      control(`${name}-control-${String(index)}`, roving ? "-1" : null)
    );

  it("ACCEPTS ONE ACTIVE CARD HOLDING ALL OF ITS CONTROLS, and names the entry point", () => {
    const verdict = assessCardGroup({
      describe: "the Trending rail",
      cards: [card("a", 2, false), card("b", 2, true), card("c", 3, true)]
    });
    expect(verdict).toEqual({ ok: true, entryPoint: "a-control-0" });
  });

  it("REFUSES A RAIL WITH NO ENTRY POINT, which is the abuse the exemption invites", () => {
    /*
     * Every control at -1. The per-element check sees nothing wrong, because
     * -1 is an exemption there; this is the only thing standing between a
     * stale active index and a silently unreachable row of titles.
     */
    const verdict = assessCardGroup({
      describe: "the Trending rail",
      cards: [card("a", 2, true), card("b", 2, true)]
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toMatch(/NONE of them in the tab order/);
  });

  it("refuses a rail where every card is in the tab order, which is no roving at all", () => {
    /* Not a defect a viewer is stuck on -- Tab still reaches everything --
     * but it means the arrangement did not apply, which is what a gate is
     * for. */
    const verdict = assessCardGroup({
      describe: "the Trending rail",
      cards: [card("a", 2, false), card("b", 2, false)]
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toMatch(/2 cards in the tab order/);
  });

  it("REFUSES A CONTROL STRANDED INSIDE THE ACTIVE CARD, and names it", () => {
    /*
     * The quietest failure and the worst: the rail has an entry point, Tab
     * enters it, and one control in the active card can be reached by nobody.
     */
    const verdict = assessCardGroup({
      describe: "the Trending rail",
      cards: [
        [control("heading", null), control("my-list", "-1")],
        card("b", 2, true)
      ]
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toMatch(/inside the ACTIVE card/);
    expect(verdict.why).toContain("my-list");
  });

  it("does not mind a card with nothing to focus", () => {
    /* The watchlist renders a tile for a title it cannot name. It has no
     * controls, it is still a position the arrows move through, and it is not
     * a fault. */
    const verdict = assessCardGroup({
      describe: "your list",
      cards: [card("a", 2, false), [], card("c", 1, true)]
    });
    expect(verdict).toEqual({ ok: true, entryPoint: "a-control-0" });
  });

  it("refuses a group with nothing focusable anywhere rather than passing it", () => {
    /* Vacuous success is how a gate stops gating -- the same rule the
     * per-element check applies with its non-vacuity assertion. */
    expect(assessCardGroup({ describe: "empty", cards: [[], []] }).ok).toBe(false);
    expect(assessCardGroup({ describe: "empty", cards: [] }).ok).toBe(false);
  });

  it("ignores controls that are out of the tab order for OTHER reasons", () => {
    /* A hidden or disabled control is not part of this question, and counting
     * one would report a roving defect in a rail that has none. */
    const verdict = assessCardGroup({
      describe: "the Trending rail",
      cards: [
        [control("heading", null), el({ describe: "hidden-extra", visible: false })],
        card("b", 1, true)
      ]
    });
    expect(verdict).toEqual({ ok: true, entryPoint: "heading" });
  });
});
