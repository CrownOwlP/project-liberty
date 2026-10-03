"use client";

/* -------------------------------------------------------------------------
 * A rail you cross with the arrow keys instead of fifteen tabs (PW-0310)
 *
 * ==========================================================================
 * WHAT IT DOES AND WHERE THE DECISIONS ARE
 * ==========================================================================
 *
 * This component holds element references and sets `tabindex`. Every question
 * about WHAT the answer should be -- which card is active after a key, who is
 * in the tab order, where focus goes, what happens when the group changes size
 * -- is answered by `roving.ts` over plain numbers and is unit-tested there.
 * The split is the one `keyboard-reachability.ts` makes, for the same reason:
 * a rule that can only be exercised by running a browser is a rule that
 * drifts.
 *
 * ==========================================================================
 * IT CHANGES NOTHING UNTIL IT HAS HYDRATED, AND THAT IS THE FALLBACK
 * ==========================================================================
 *
 * The server renders the rail exactly as it rendered before: every card's
 * controls in the ordinary tab order, which is a correct if verbose keyboard
 * experience and is what a browser with no bundle keeps. Only once this
 * component is running does it take the other cards out of the tab order --
 * so the roving behaviour and the arrow keys arrive together, and there is no
 * window in which the controls are at -1 and nothing is listening for the keys
 * that would reach them. `SeasonNavigation` takes the same shape for the same
 * reason.
 *
 * ==========================================================================
 * WHY IT READS THE DOM INSTEAD OF TAKING PROPS
 * ==========================================================================
 *
 * The alternative is to thread an `active` index and a tabindex through
 * `CatalogCard`, `WatchlistControl`, `PosterArtwork` and every control any
 * card grows later. That spreads one group's keyboard arrangement across every
 * component a card is made of, makes each of them take a prop that is none of
 * their business, and guarantees the next control added is the one that
 * forgets. Querying the group's own subtree keeps the arrangement in the one
 * place that owns it, and a control added to a card tomorrow is picked up with
 * no change to anything.
 *
 * The cost is honest and bounded: this reaches into its own children's DOM. It
 * does not reach outside itself, it writes only `tabindex`, and the attribute
 * is one React does not set on these elements, so there is nothing to clobber
 * and nothing to be clobbered by.
 *
 * ==========================================================================
 * THE EXEMPTION THIS SPENDS, AND WHERE IT IS EARNED BACK
 * ==========================================================================
 *
 * `keyboard-reachability.ts` calls `tabindex="-1"` "the one exemption that can
 * be abused", because it is both the correct spelling of a roving tabindex and
 * the easiest way to silence a reachability gate. This component sets it on
 * most of a rail's controls. It is therefore checked on every run rather than
 * asserted once here: the e2e guard re-derives each rail from the real DOM and
 * requires that exactly one card is in the tab order -- never zero, which
 * would be a silently unreachable rail, and never all of them, which would not
 * be a roving tabindex at all.
 * ---------------------------------------------------------------------- */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  cardOwning,
  clampActive,
  firstFocusable,
  isGroupKey,
  nextActive,
  tabIndexPlan
} from "./roving";

/**
 * What counts as a control inside a card.
 *
 * Deliberately the NATIVELY FOCUSABLE things plus anything carrying an
 * explicit non-negative tabindex, and deliberately NOT everything
 * `keyboard-reachability.ts` calls interactive. The two lists answer different
 * questions: that module asks "is this something a person is meant to
 * operate", so an element with a click handler and no way to focus it is a
 * FINDING there. Here the question is "what does the browser put in the tab
 * order", and adding an unfocusable element to this list would quietly hide
 * that finding by handing it a tabindex.
 */
const CONTROL_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex^="-"])'
].join(",");

export interface RovingGroupProps {
  /** The element to render, so the existing markup is unchanged. */
  readonly as: "div" | "ul";
  /*
   * `| undefined` EXPLICITLY, because this package sets
   * `exactOptionalPropertyTypes`. Two of the four rails pass a CSS-module
   * class, which is typed `string | undefined`, and an optional property
   * under that flag accepts an ABSENT key but not an explicit `undefined`
   * value. Widening here rather than making callers assert a class they are
   * not certain of.
   */
  readonly className?: string | undefined;
  /** Each child is ONE CARD. Arrow keys move between them. */
  readonly children: ReactNode;
  /**
   * What the arrow keys are moving through, for the instruction a screen
   * reader hears once on entry. "titles on the Trending rail", not "the
   * rail" -- the noun is what a viewer is choosing between.
   */
  readonly itemNoun: string;
}

export function RovingGroup({ as, className, children, itemNoun }: RovingGroupProps) {
  const container = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  /*
   * MOUNTED, NOT "is this the browser". The first client render must produce
   * the server's markup or React replaces the subtree, so the arrangement is
   * applied in an effect and this flag is what makes the first pass a no-op.
   */
  const [mounted, setMounted] = useState(false);

  /** The cards, and the controls inside each, as the DOM has them right now. */
  const read = useCallback((): { cards: HTMLElement[]; controls: HTMLElement[][] } => {
    const root = container.current;
    if (root === null) return { cards: [], controls: [] };
    const cards = Array.from(root.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement
    );
    return {
      cards,
      controls: cards.map((card) =>
        Array.from(card.querySelectorAll<HTMLElement>(CONTROL_SELECTOR))
      )
    };
  }, []);

  /**
   * Put the group into the arrangement `roving.ts` describes.
   *
   * Returns the index it settled on, or `null` when there was nothing to
   * arrange, so the caller can correct a stale `active` rather than leaving
   * the rail in a state no card is reachable from.
   */
  const apply = useCallback((): number | null => {
    const { controls } = read();
    if (controls.length === 0) return null;
    const safe = clampActive(active, controls.length);
    const plan = tabIndexPlan(
      controls.map((group) => group.length),
      safe
    );
    controls.forEach((group, card) => {
      group.forEach((control, index) => {
        control.tabIndex = plan[card]?.[index] ?? -1;
      });
    });
    return safe;
  }, [active, read]);

  /*
   * APPLY ON EVERY RENDER, AND AGAIN WHENEVER THE SUBTREE CHANGES.
   *
   * WHY THE SECOND HALF, STATED ACCURATELY BECAUSE THE FIRST ANSWER WAS
   * WRONG AND IS NOT WORTH LEAVING ON THE RECORD. This observer was added
   * while chasing a gate failure reporting that eight of twelve rail controls
   * were still in the tab order. That number was the GATE miscounting: it was
   * tallying the My List buttons, which are `disabled` for a signed-out
   * viewer and were therefore never in the tab order at all. A census of the
   * real DOM showed the arrangement had been correct the whole time -- every
   * heading link at 0 or -1, exactly one card reachable per rail. The gate
   * was fixed to count only controls a browser would actually focus.
   *
   * The observer was KEPT, on its own merits rather than on that diagnosis,
   * and the merits are real. A rail does not stop changing when this
   * component stops rendering, and none of the ways it changes re-render
   * THIS component: a My List control is its own client component and is
   * disabled until it knows whether the title is on the list, so for a
   * signed-IN viewer it becomes focusable after the arrangement last ran; a
   * watchlist row is removed; a search returns fewer results. A control that
   * was not focusable when the plan was applied is one the plan correctly
   * skipped, and without this it would keep its natural tabindex and sit in
   * the tab order of a card that is supposed to be out of it.
   *
   * `childList` PLUS A TWO-ATTRIBUTE FILTER, and the filter is what makes
   * observing attributes safe at all. Setting `tabindex` is itself an
   * attribute mutation, so an unfiltered attribute observer would call this
   * back for every write it just made, forever. `disabled` and
   * `aria-disabled` are the two this component's own selector reads and
   * neither is one it ever writes, so the loop cannot close.
   */
  useEffect(() => {
    setMounted(true);
    const settled = apply();
    if (settled !== null && settled !== active) {
      setActive(settled);
      return;
    }
    const root = container.current;
    if (root === null) return;
    const observer = new MutationObserver(() => {
      apply();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled"]
    });
    return () => {
      observer.disconnect();
    };
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!isGroupKey(event.key)) return;
    const { controls } = read();
    const target = nextActive(event.key, active, controls.length);
    if (target === null) return;
    /*
     * PREVENTED EVEN WHEN THE ACTIVE CARD DOES NOT MOVE. At the last card
     * ArrowRight answers the last card, and letting that key through would
     * scroll the page out from under a viewer who is at the end of a rail.
     * `isGroupKey` is the separate question that makes this expressible.
     */
    event.preventDefault();
    setActive(target);
    const index = firstFocusable(
      controls.map((group) => group.length),
      target
    );
    if (index === null) return;
    const control = controls[target]?.[index];
    if (control === undefined) return;
    /* Put it in the tab order before focusing: a -1 element can be focused by
     * script, but leaving it at -1 would mean Tab from it jumps out of the
     * card the viewer just arrived in. The effect above re-runs and settles
     * the rest. */
    control.tabIndex = 0;
    control.focus();
  };

  /*
   * FOLLOW A VIEWER WHO ARRIVED ANY OTHER WAY -- a click, a Shift+Tab from
   * below, a screen reader's own navigation. Without this the first arrow
   * press would yank focus back to wherever the group last thought it was,
   * which is the most disorienting thing a composite widget can do.
   */
  const onFocus = (event: React.FocusEvent<HTMLElement>): void => {
    const { controls } = read();
    const flat = controls.flat();
    const owner = cardOwning(
      controls.map((group) => group.length),
      flat.indexOf(event.target as HTMLElement)
    );
    if (owner !== null && owner !== active) setActive(owner);
  };

  const shared = {
    ref: container as React.Ref<never>,
    className,
    onKeyDown,
    onFocus,
    /*
     * HOW THE GATE FINDS THESE GROUPS. The four rails render three different
     * elements with three different classes, two of them CSS-module hashes
     * that change with the file. `e2e/tests/keyboard-reachability.spec.ts`
     * re-derives every group from the DOM and requires that exactly one card
     * is in the tab order; it has to be able to ask "which of you are roving
     * groups" without a list of selectors that goes stale the first time a
     * rail is restyled. Marked here because this component is what makes the
     * claim, so a group that stops roving stops claiming it in the same edit.
     */
    "data-testid": "roving-group",
    /*
     * THE INSTRUCTION, ONCE, AND ONLY ONCE THE KEYS ACTUALLY WORK. Announcing
     * "use the arrow keys" on a server-rendered page where nothing is
     * listening for them would be a false promise, so it appears with the
     * behaviour it describes. It is a description rather than a label: the
     * rail already has a heading, and `aria-label` would replace that name
     * with this sentence.
     */
    "aria-description": mounted
      ? `Use the left and right arrow keys to move between ${itemNoun}.`
      : undefined
  };

  return as === "ul" ? <ul {...shared}>{children}</ul> : <div {...shared}>{children}</div>;
}
