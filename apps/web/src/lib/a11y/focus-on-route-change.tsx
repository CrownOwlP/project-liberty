"use client";

/* -------------------------------------------------------------------------
 * Where focus goes when a client-side navigation replaces the page (PW-0310)
 *
 * ==========================================================================
 * THE DEFECT, WHICH IS INVISIBLE TO EVERY MOUSE
 * ==========================================================================
 *
 * `CatalogCard` links with `next/link`, so following one from the home page to
 * a title page is a CLIENT navigation: React swaps the contents of `<main>`
 * and the browser never loads a document. A browser moves focus on a real
 * navigation; nothing moves it on this one. So a keyboard viewer who activates
 * the fourth card on the second rail arrives at the title page with focus
 * still on an anchor that no longer exists, and their next Tab starts from
 * wherever the browser decided to put it -- usually the very top of the
 * document, which means tabbing past the skip link and the whole navigation to
 * reach the page they just chose. A screen reader is worse off still: nothing
 * announced that the page changed at all.
 *
 * PW-0310's acceptance names it: "REQUIRED: focus restoration on route change
 * and on dialog close."
 *
 * ==========================================================================
 * TO `<main>`, AND WHY NOT TO THE HEADING
 * ==========================================================================
 *
 * The main landmark, which is what the skip link already targets -- so a
 * keyboard viewer lands in the same place whether they arrived by following a
 * link or by skipping the chrome, and there is one answer to "where does
 * content start" rather than two. Focusing the `<h1>` instead is the common
 * alternative and it announces a little more; it also depends on every route
 * having exactly one, in a place that makes sense to land on, which is a
 * promise this application has not made and which would fail silently on the
 * first route that broke it.
 *
 * `tabindex="-1"` is set on the landmark imperatively rather than rendered
 * into it. It is focusable by script and still absent from the tab order,
 * which is exactly the -1 case `keyboard-reachability.ts` exempts, and doing
 * it here keeps the whole mechanism in one file instead of spreading an
 * attribute into a server shell that several tests render.
 *
 * ==========================================================================
 * NOT ON FIRST LOAD, WHICH IS THE PART THAT IS EASY TO GET WRONG
 * ==========================================================================
 *
 * On the first page a viewer sees, focus belongs at the top of the document
 * where the browser put it -- that is where the skip link is, and stealing
 * focus into `<main>` on arrival would skip the navigation past somebody who
 * never asked to skip it. So the first pathname this component sees is
 * recorded and nothing happens; only a CHANGE moves focus.
 *
 * THE DIALOG HALF OF THE CLAUSE HAS NOTHING TO RESTORE FROM. A search of
 * `apps/web/src` for `role="dialog"`, `<dialog` and `aria-modal` finds
 * nothing: this application has no dialogs, modal or otherwise. That is
 * reported rather than satisfied by inventing one. If a dialog is ever added,
 * the reachability gate in `e2e/tests/keyboard-reachability.spec.ts` is what
 * notices that its controls are unreachable, and restoring focus to the
 * opener belongs to the component that owns the dialog rather than to a
 * global listener that would have to guess which element opened it.
 * ---------------------------------------------------------------------- */

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** The landmark the skip link already points at. One answer, not two. */
const MAIN = "#main";

export function FocusOnRouteChange() {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const was = previous.current;
    previous.current = pathname;
    /* The first pathname is an arrival, not a navigation. See the header. */
    if (was === null || was === pathname) return;

    const main = document.querySelector<HTMLElement>(MAIN);
    if (main === null) return;
    /* Focusable by script, still out of the tab order. */
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    /*
     * `preventScroll`, because the router has already decided where the new
     * page should be scrolled to and focusing an element scrolls it into
     * view. Without this the two fight and the viewer sees a jump.
     */
    main.focus({ preventScroll: true });
  }, [pathname]);

  return null;
}
