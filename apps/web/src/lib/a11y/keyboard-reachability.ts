/* -------------------------------------------------------------------------
 * What "reachable by keyboard" means, as pure functions (PW-0310)
 *
 * ==========================================================================
 * WHY A POLICY MODULE AND NOT JUST A TEST
 * ==========================================================================
 *
 * The acceptance asks for "an automated check in the e2e suite that fails
 * when a new interactive element is unreachable by keyboard, because a one-off
 * audit decays and a gate does not". A gate is only as good as its definition
 * of the thing it gates, and "interactive" is a judgement with edges: a
 * `<div onclick>` is interactive and a `<p>` is not; a disabled button is
 * interactive and legitimately unreachable; an element inside `inert` or
 * `aria-hidden` is deliberately out of the tree.
 *
 * Putting those edges in a Playwright spec would make them untestable --
 * `apps/web` has no DOM, so the spec can only be exercised by running the
 * whole browser suite, and a rule nobody can unit-test is a rule that drifts.
 * So the DECISIONS live here, over plain records the browser collects, and
 * `e2e/tests/keyboard-reachability.spec.ts` does the collecting.
 *
 * ==========================================================================
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 * ==========================================================================
 *
 * NOT A WCAG AUDIT, which the acceptance rules out by name: "NOT IN SCOPE: a
 * full WCAG certification; the bar here is operability plus a mechanical guard
 * against regression." Nothing here measures contrast, reading order,
 * alternative text or anything a human has to look at.
 *
 * AND REACHABLE IS NOT USABLE. An element this module calls reachable can
 * still be a button with no accessible name, or a control whose focus ring is
 * invisible against its background. Those are different checks and some of
 * them are human. What this answers is one narrow question that is cheap to
 * answer wrongly by accident: can a person who cannot use a mouse get to it
 * at all.
 * ---------------------------------------------------------------------- */

/**
 * One element, as the browser can describe it without judgement.
 *
 * DESCRIBED, NOT CLASSIFIED. Everything here is read straight off the DOM, so
 * the spec that collects it holds no opinions and this module holds all of
 * them -- which is what makes the opinions testable.
 */
export interface ObservedElement {
  /**
   * EXACT IDENTITY, unique within one observation.
   *
   * Not cosmetic, and the reason it exists is a defect this gate had on its
   * first run. Identity used to be the `describe` string below, and a title
   * page carries five episode rows whose play links all describe as
   * `a.episodePlay "Play"`. The tab walk stops when focus returns to
   * something it has already seen, so the SECOND identical description ended
   * the walk after two rows and the remaining three were reported
   * unreachable -- a false failure naming real elements, which is the one
   * kind of gate failure that teaches people to ignore a gate.
   *
   * The collector assigns this from the element's position in a snapshot it
   * holds in the page, so two elements that look alike are still two
   * elements. `describe` went back to being what it is good at: a label for a
   * human reading the failure.
   */
  readonly probe: string;
  /** A handle for a failure message: tag, id, classes, text. NOT unique. */
  readonly describe: string;
  readonly tag: string;
  /** Lower-cased `type` for an `<input>`; `null` otherwise. */
  readonly inputType: string | null;
  readonly role: string | null;
  /** The literal attribute, unparsed. `null` when absent. */
  readonly tabIndexAttr: string | null;
  readonly disabled: boolean;
  /** True when the element or an ancestor carries `aria-hidden="true"`. */
  readonly ariaHidden: boolean;
  /** True when the element or an ancestor is `inert`. */
  readonly inert: boolean;
  /** True when it has a non-zero box and is not `display:none`/`visibility:hidden`. */
  readonly visible: boolean;
  /** True when it carries a click handler attribute the DOM can see. */
  readonly hasClickHandler: boolean;
  /** `href` for an anchor; `null` otherwise, including for `<a>` without one. */
  readonly href: string | null;
}

/**
 * Tags that are focusable by being what they are.
 *
 * `<a>` is NOT in this list and that is not an oversight: an anchor without an
 * `href` is not a link and is not focusable, which is a real and common defect
 * -- it is handled below where the `href` can be consulted.
 */
const NATIVELY_INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary"]);

/**
 * ARIA roles that promise keyboard operation.
 *
 * A role is a PROMISE, which is why claiming one puts an element in scope: an
 * element that says `role="button"` has told a screen-reader user it behaves
 * like a button, and a button that cannot be focused is a broken promise
 * rather than a styling choice.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "combobox",
  "textbox",
  "searchbox"
]);

/** An `<input type>` that is not focusable and not a control. */
const NON_INTERACTIVE_INPUT_TYPES = new Set(["hidden"]);

/**
 * Whether this element is something a person is meant to operate.
 *
 * THREE WAYS IN, and they are different claims rather than three spellings of
 * one. A native control is interactive because of what it IS. An element with
 * an interactive ROLE is interactive because of what it says it is. An element
 * with a CLICK HANDLER is interactive because of what it does -- and that
 * third case is the one this gate exists for, since a `<div onClick>` is how
 * an unreachable control gets built without anybody deciding to build one.
 */
export function isInteractive(element: ObservedElement): boolean {
  const tag = element.tag.toLowerCase();
  if (tag === "input") {
    return !NON_INTERACTIVE_INPUT_TYPES.has(element.inputType ?? "");
  }
  if (NATIVELY_INTERACTIVE_TAGS.has(tag)) return true;
  /* An anchor is a link when it has somewhere to go. `<a>` with no `href` is
   * a styled span as far as the keyboard is concerned, and treating it as a
   * link would report a defect in every breadcrumb separator. */
  if (tag === "a") return element.href !== null;
  if (element.role !== null && INTERACTIVE_ROLES.has(element.role.toLowerCase())) return true;
  return element.hasClickHandler;
}

/** Why an interactive element is allowed not to be reachable. */
export type ExemptionReason =
  /** Disabled controls are deliberately not in the tab order. */
  | "disabled"
  /** `aria-hidden` removes it from the accessibility tree on purpose. */
  | "aria-hidden"
  /** `inert` removes it from the keyboard on purpose. */
  | "inert"
  /** Nothing is on screen to focus. */
  | "not-visible"
  /**
   * `tabindex="-1"` — focusable by script, deliberately out of the tab order.
   *
   * THE ONE EXEMPTION THAT CAN BE ABUSED, and it is kept narrow for that
   * reason. It is how a roving tabindex works: the group's unfocused members
   * carry -1 and the arrow keys move focus between them, which is correct and
   * is exactly what the season selector does. It is ALSO how somebody silences
   * this gate. `rovingGroups` below is what tells the two apart.
   */
  | "tabindex-negative";

export interface Unreachable {
  readonly describe: string;
}

export interface ReachabilityVerdict {
  /** Interactive, in the tab order, reached. */
  readonly reached: readonly ObservedElement[];
  /** Interactive, expected in the tab order, NOT reached. The failures. */
  readonly unreachable: readonly Unreachable[];
  /** Interactive and legitimately out of the tab order, with the reason. */
  readonly exempt: readonly { readonly describe: string; readonly reason: ExemptionReason }[];
}

function exemption(element: ObservedElement): ExemptionReason | null {
  /* ORDER MATTERS AND IS THE STRONGEST REASON FIRST. An element that is both
   * disabled and invisible is reported as disabled, because that is the fact
   * an author chose; "not-visible" is the one most likely to be incidental. */
  if (element.disabled) return "disabled";
  if (element.ariaHidden) return "aria-hidden";
  if (element.inert) return "inert";
  if (!element.visible) return "not-visible";
  if (element.tabIndexAttr !== null && Number(element.tabIndexAttr) < 0) return "tabindex-negative";
  return null;
}

/**
 * Compare what is on the page against what the keyboard actually reached.
 *
 * `focusedProbes` is the set of probe handles the spec collected by pressing
 * Tab until focus came back round. Membership is by `probe` and never by
 * `describe`, so two controls that look identical are two controls here --
 * see the note on `ObservedElement.probe` for the failure that rule is made
 * of.
 */
export function assessReachability(
  elements: readonly ObservedElement[],
  focusedProbes: ReadonlySet<string>
): ReachabilityVerdict {
  const reached: ObservedElement[] = [];
  const unreachable: Unreachable[] = [];
  const exempt: { describe: string; reason: ExemptionReason }[] = [];

  for (const element of elements) {
    if (!isInteractive(element)) continue;
    const reason = exemption(element);
    if (reason !== null) {
      exempt.push({ describe: element.describe, reason });
      continue;
    }
    if (focusedProbes.has(element.probe)) reached.push(element);
    else unreachable.push({ describe: element.describe });
  }

  return { reached, unreachable, exempt };
}

/**
 * A group that is allowed to keep most of its members out of the tab order.
 *
 * WHY THIS EXISTS. `tabindex="-1"` is both the correct implementation of a
 * roving tabindex and the easiest way to make this gate stop complaining. The
 * difference is not visible one element at a time: it is visible in the GROUP.
 * A roving group has exactly ONE member in the tab order and the rest at -1,
 * and the arrow keys move between them. A group with ZERO members in the tab
 * order is unreachable however it is spelled, and a group with EVERY member at
 * -1 and no entry point is the abuse this rule catches.
 */
export interface RovingGroup {
  readonly describe: string;
  readonly members: readonly ObservedElement[];
}

export type RovingVerdict =
  | { readonly ok: true; readonly entryPoint: string }
  | { readonly ok: false; readonly why: string };

export function assessRovingGroup(group: RovingGroup): RovingVerdict {
  const candidates = group.members.filter((member) => exemption(member) !== "not-visible");
  if (candidates.length === 0) {
    return { ok: false, why: `${group.describe} has no visible members` };
  }
  const inTabOrder = candidates.filter(
    (member) => member.tabIndexAttr === null || Number(member.tabIndexAttr) >= 0
  );
  if (inTabOrder.length === 0) {
    return {
      ok: false,
      why:
        `${group.describe} has ${candidates.length} member(s) and NONE in the tab order. ` +
        "A roving tabindex keeps exactly one member reachable and moves focus with the arrow " +
        "keys; a group where every member is tabindex=-1 is simply unreachable."
    };
  }
  if (inTabOrder.length > 1) {
    return {
      ok: false,
      why:
        `${group.describe} has ${inTabOrder.length} members in the tab order. That is not a ` +
        "defect a viewer cannot use, but it is not a roving tabindex either: Tab walks every " +
        "one of them instead of leaving the group."
    };
  }
  return { ok: true, entryPoint: inTabOrder[0]?.describe ?? group.describe };
}

/**
 * A rail, as the browser has it: an ordered list of cards, each an ordered
 * list of the controls inside it.
 *
 * WHY A SECOND GROUP SHAPE AND NOT `RovingGroup` ABOVE. That one models a
 * group whose members ARE the controls -- the season tabs, where one tab is
 * one stop. A rail's members are CARDS, and a card is two or three controls:
 * a heading link, a My List toggle, sometimes a Start over link. The rule is
 * genuinely different, and collapsing the two would make "exactly one member
 * in the tab order" false of a correct rail.
 */
export interface ObservedCardGroup {
  readonly describe: string;
  readonly cards: readonly (readonly ObservedElement[])[];
}

/**
 * Whether a rail's `tabindex="-1"` is a roving tabindex or a silenced gate.
 *
 * THIS IS WHERE THE EXEMPTION IS PAID FOR. `exemption` above lets any element
 * with a negative tabindex out of the reachability check, and the note on
 * `ExemptionReason` says plainly that this is the one exemption that can be
 * abused. `lib/a11y/roving-group.tsx` sets -1 on most of a rail's controls, so
 * without this rule the rails could lose their entry point entirely -- every
 * card at -1, the whole row unreachable, and the per-element check reporting
 * nothing at all because every one of them is exempt.
 *
 * THREE WAYS TO FAIL, AND THEY ARE DIFFERENT FAULTS.
 *
 *   NO card in the tab order is an unreachable rail. It is what a stale active
 *   index produces when a list shrinks under it, which is why `clampActive`
 *   exists in `roving.ts` and why this is checked rather than trusted.
 *
 *   MORE THAN ONE card in the tab order is not a defect a viewer cannot work
 *   around -- Tab still reaches everything -- but it is not a roving tabindex
 *   either, and it means the arrangement did not apply. Reported, because a
 *   mechanism that silently stopped working is the thing a gate is for.
 *
 *   A PARTLY REACHABLE ACTIVE CARD is the quietest of the three and the worst:
 *   the rail has an entry point, Tab enters it, and a control inside the
 *   active card is at -1 and can never be reached by anybody. That is a
 *   genuinely unreachable control hiding behind a legitimate-looking group.
 *
 * Cards with no visible controls are not faults. The watchlist renders a tile
 * for a title it cannot name, which has nothing to focus; `roving.ts` keeps it
 * as a position the arrows move through and declines to move focus into it.
 */
export function assessCardGroup(group: ObservedCardGroup): RovingVerdict {
  /* Only controls that could be in the tab order at all. A hidden or disabled
   * control is out of it for reasons that have nothing to do with roving. */
  const cards = group.cards.map((controls) =>
    controls.filter((control) => {
      const reason = exemption(control);
      return reason === null || reason === "tabindex-negative";
    })
  );
  const populated = cards.filter((controls) => controls.length > 0);
  if (populated.length === 0) {
    return {
      ok: false,
      why:
        `${group.describe} has no focusable controls in any card. A roving group that contains ` +
        "nothing to focus is not a passing group; it is a check that measured nothing."
    };
  }

  const reachableCards = populated.filter((controls) =>
    controls.some((control) => exemption(control) !== "tabindex-negative")
  );

  if (reachableCards.length === 0) {
    return {
      ok: false,
      why:
        `${group.describe} has ${String(populated.length)} card(s) with controls and NONE of ` +
        "them in the tab order. Every control is tabindex=-1, so Tab cannot enter this rail at " +
        "all and the per-element check cannot see it either, because -1 is an exemption. This " +
        "is the abuse that exemption exists to be caught doing."
    };
  }
  if (reachableCards.length > 1) {
    return {
      ok: false,
      why:
        `${group.describe} has ${String(reachableCards.length)} cards in the tab order. Tab ` +
        "reaches everything, so no viewer is stuck -- but this is not a roving tabindex, which " +
        "means the arrangement did not apply and the rail still costs one stop per control."
    };
  }

  const active = reachableCards[0] ?? [];
  const strandedInActive = active.filter(
    (control) => exemption(control) === "tabindex-negative"
  );
  if (strandedInActive.length > 0) {
    return {
      ok: false,
      why:
        `${group.describe} has an entry point, but ${String(strandedInActive.length)} control(s) ` +
        "inside the ACTIVE card are tabindex=-1 and can be reached by nobody: " +
        strandedInActive.map((control) => control.describe).join(", ") +
        ". The active card must hold ALL of its controls in the tab order; that is what makes " +
        "Tab step through the card and then leave the group."
    };
  }

  return { ok: true, entryPoint: active[0]?.describe ?? group.describe };
}

/**
 * The failure text the gate prints.
 *
 * WRITTEN HERE RATHER THAN IN THE SPEC because the message is the entire value
 * of a regression gate: a red build that says "3 elements unreachable" sends
 * somebody to read a diff, and one that names them sends somebody to a fix.
 */
export function describeFailure(route: string, verdict: ReachabilityVerdict): string {
  const lines = [
    `${verdict.unreachable.length} interactive element(s) on ${route} cannot be reached by keyboard:`
  ];
  for (const entry of verdict.unreachable) lines.push(`  - ${entry.describe}`);
  lines.push(
    "",
    "Each one is something a person is meant to operate -- a native control, an element",
    "claiming an interactive ARIA role, or an element with a click handler -- and Tab never",
    "lands on it. Give it a real control element, or an explicit tabindex, or (if it is",
    "genuinely not meant to be operated) remove the role or the handler that says it is.",
    "",
    "DO NOT silence this by adding tabindex=-1: that is the roving-tabindex spelling and the",
    "group check will then ask where the group's single entry point is."
  );
  return lines.join("\n");
}
