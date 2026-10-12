"use client";

/* -------------------------------------------------------------------------
 * UP AND DOWN BETWEEN THE RAILS (W132-B)
 *
 * A THIN CONSUMER. Every decision this component makes is made by
 * `rail-navigation.ts` over numbers and booleans -- see that module's header
 * for why Up and Down are claimed, why Home/End are not, and why the edges give
 * the keys back to the page. This file holds element references and moves
 * focus, which is the split `lib/a11y/roving-group.tsx` makes against
 * `lib/a11y/roving.ts` and is the only split that is testable in a workspace
 * whose vitest environment is `node`.
 *
 * ==========================================================================
 * HOW IT FINDS THE RAILS, AND WHY NOT BY PROPS
 * ==========================================================================
 *
 * `[data-testid="roving-group"]` is the marker `RovingGroup` already sets on
 * every rail in the product, for the reason its own header gives: the rails
 * render three different elements with three different classes, two of them
 * CSS-module hashes that change with the file, and `e2e/tests/
 * keyboard-reachability.spec.ts` has to be able to ask "which of you are roving
 * groups" without a list of selectors that goes stale. The same question is
 * being asked here, so the same marker answers it -- and a rail that stops
 * roving stops being part of this stack in the same edit, which is the
 * behaviour we want. Threading an index into `CatalogRail`,
 * `ContinueWatchingRail` and whatever rail is added next would spread one
 * stack's keyboard arrangement across every component a rail is made of.
 *
 * ==========================================================================
 * WHAT IT REFUSES TO ASSUME ABOUT THE BROWSER
 * ==========================================================================
 *
 * Nothing here touches a non-universal API: no `matchMedia`, no
 * `ResizeObserver`, no `IntersectionObserver`, no `navigator`, no `Intl`.
 * Nothing runs at module evaluation and nothing runs in an effect -- the only
 * code path is a key handler, which cannot fire before there is a document. The
 * one DOM read is `querySelectorAll`, which returns an empty list rather than
 * `null`, and every index into its result is checked before it is used. That
 * matters beyond ordinary caution right now: `app/error.tsx` re-renders
 * `AppShell`, so a client component in the home tree that threw during render
 * would take the fallback down with it.
 *
 * `event.target` IS USED AS A `Node`, NOT NARROWED WITH `instanceof
 * HTMLElement`. `Node.contains` accepts any node, so the narrowing would buy
 * nothing and would put a reference to a browser global in a module that
 * currently has none.
 * ---------------------------------------------------------------------- */

import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { entryControl, isRailStackKey, nextRail, railOwningFocus } from "./rail-navigation";

/** Every rail, as `RovingGroup` marks itself. */
const ROVING_GROUP = '[data-testid="roving-group"]';

/**
 * What might be a rail's entry point.
 *
 * DELIBERATELY NARROWER THAN `roving-group.tsx`'s `CONTROL_SELECTOR`, and
 * narrower on purpose rather than by omission. That selector answers "what does
 * the browser put in the tab order", because that component has to arrange
 * every one of them. This one only has to find where to LAND, and
 * `entryControl` picks by `tabIndex` -- so the first clause below is the actual
 * answer on a hydrated rail and the other two are the fallback for a rail whose
 * group has not hydrated, where everything is in the natural tab order anyway.
 *
 * Copying the longer list would have been a second spelling of a vocabulary
 * that file owns and does not export, and it would have added inputs,
 * textareas and selects -- none of which any rail in this product renders -- to
 * a decision that cannot use them.
 */
const ENTRY_CANDIDATE = '[tabindex="0"], a[href], button:not([disabled])';

export interface RailStackProps {
  /** The rails, in document order. Rendered on the server; see the header. */
  readonly children: ReactNode;
}

export function RailStack({ children }: RailStackProps) {
  const container = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isRailStackKey(event.key)) return;

    const root = container.current;
    if (root === null) return;

    const groups = Array.from(root.querySelectorAll<HTMLElement>(ROVING_GROUP));
    const target: Node | null = event.target as Node | null;
    if (target === null) return;

    const owner = railOwningFocus(groups.map((group) => group.contains(target)));
    if (owner === null) return;

    const destination = nextRail(event.key, owner, groups.length);
    if (destination === null) return;

    const group = groups[destination];
    if (group === undefined) return;

    const candidates = Array.from(group.querySelectorAll<HTMLElement>(ENTRY_CANDIDATE));
    const index = entryControl(candidates.map((candidate) => candidate.tabIndex));
    if (index === null) return;

    const control = candidates[index];
    if (control === undefined) return;

    /*
     * PREVENTED ONLY NOW, with a destination in hand. Everything above returns
     * without touching the event, so a key the stack cannot answer still
     * scrolls the page -- which at the first and last rail is exactly what a
     * reader pressing Up or Down wants. See `nextRail`.
     */
    event.preventDefault();
    /*
     * In the tab order BEFORE focusing, the same order `roving-group.tsx`
     * uses and for the same reason: a `-1` element can be focused by script,
     * but leaving it there would mean Tab from it jumps out of the card the
     * viewer just arrived in. That group's own focus handler then picks this up
     * -- it listens for a focus arriving by any route precisely so its active
     * card follows the reader -- and its effect settles the rest of the rail.
     */
    control.tabIndex = 0;
    control.focus();
  };

  /*
   * `display: contents` IN `globals.css`, so this wrapper is a DOM node and not
   * a box. The rails keep the exact geometry they had as direct children of
   * `main.shell` -- their own `.section` margins, the grid they each declare --
   * and this element adds nothing to lay out. A wrapper that participated in
   * layout would be a redesign of the approved surface smuggled in as a
   * keyboard fix.
   */
  return (
    <div className="rail-stack" ref={container} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
