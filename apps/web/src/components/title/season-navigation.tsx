"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import styles from "./season-navigation.module.css";

/* -------------------------------------------------------------------------
 * Choosing a season (PW-0307)
 *
 * WHAT THIS REPLACES. Every season of a series rendered as one flat stack, in
 * full, with no way to get to season 4 except to scroll past the other three.
 * On a ten-season series that is two hundred cards between a viewer and the
 * episode they came for.
 *
 * ==========================================================================
 * IT DOES NOT NAVIGATE, WHICH IS THE ACCEPTANCE'S OWN REQUIREMENT
 * ==========================================================================
 *
 * "season navigation that does not lose the viewer's place." A link to
 * `/title/:id?season=4` loses it twice over -- a round trip, a fresh document,
 * the scroll position gone, and the back button then walking the viewer
 * backwards through every season they looked at. Anchors into the stack
 * (`#season-4`) keep the document but keep the stack too, which is the thing
 * being removed. So the choice is client state, and this component owns it.
 *
 * ==========================================================================
 * NOTHING IS LOST WITHOUT JAVASCRIPT, AND THAT IS NOT AN ACCIDENT
 * ==========================================================================
 *
 * A tab strip whose panels are hidden by default is a page that shows one
 * season to anyone whose script did not run -- a REGRESSION against the flat
 * stack, which at least showed everything. So the first render is the flat
 * stack, exactly as before: every season, no tab strip. `interactive` flips in
 * an effect, which only ever runs in a browser that executed the bundle, and
 * the tabs appear then.
 *
 * The cost is one extra client render on hydration and it is paid knowingly.
 * The alternative -- `hidden` panels and a `<noscript>` stylesheet to unhide
 * them -- puts the no-script path in a place no test in this repository can
 * reach, which is how it would quietly stop working.
 *
 * `useSyncExternalStore` RATHER THAN AN EFFECT, AND RATHER THAN SNIFFING THE
 * ENVIRONMENT. A `typeof window !== "undefined"` check evaluates differently on
 * the server and on the client's FIRST render, which is a hydration mismatch by
 * construction. An effect that called `setState` would work and is what the
 * first draft did -- `react-hooks/set-state-in-effect` refused it, correctly:
 * it is a cascading render, and React publishes a primitive for exactly this
 * question. `getServerSnapshot` answers `false`, the client snapshot answers
 * `true`, and React reconciles the two the way it reconciles any other
 * hydration difference. The subscription is a no-op because the answer never
 * changes again: a document is hydrated once.
 *
 * ==========================================================================
 * IT IS A TAB STRIP, SPELLED AS ONE
 * ==========================================================================
 *
 * `role="tablist"` with roving tabindex and arrow keys, because that is what
 * this control is and a screen reader should be told so rather than hearing a
 * row of buttons with no relationship to the content below. The whole
 * application has, per PW-0306's acceptance, "not one keyboard handler" today;
 * this is one, and it is the standard one.
 *
 * AUTOMATIC ACTIVATION -- moving focus changes the panel -- which the WAI-ARIA
 * pattern recommends when showing a panel is cheap. It is: every panel is
 * already rendered and the switch is a `hidden` attribute, no fetch and no
 * work. Manual activation (arrow to move, Enter to choose) would be the right
 * call if a panel cost a round trip, and it does not.
 * ---------------------------------------------------------------------- */

export interface SeasonPanel {
  readonly seasonNumber: number;
  /** The heading's own text, so this component states no copy of its own. */
  readonly heading: string;
  /** What the season's heading row shows beside the heading. */
  readonly summary: string;
  /** The episodes, rendered by the server component that owns the card markup. */
  readonly content: ReactNode;
}

export interface SeasonNavigationProps {
  readonly panels: readonly SeasonPanel[];
}

function tabId(seasonNumber: number): string {
  return `season-tab-${String(seasonNumber)}`;
}

function panelId(seasonNumber: number): string {
  return `season-panel-${String(seasonNumber)}`;
}

/** The subscription `useSyncExternalStore` requires. Hydration happens once,
 * so there is nothing to subscribe to; module scope keeps it referentially
 * stable, which is what stops the store resubscribing on every render. */
const NEVER_CHANGES = () => () => {};
const ON_THE_CLIENT = () => true;
const ON_THE_SERVER = () => false;

export function SeasonNavigation({ panels }: SeasonNavigationProps) {
  const interactive = useSyncExternalStore(NEVER_CHANGES, ON_THE_CLIENT, ON_THE_SERVER);
  const [chosen, setChosen] = useState<number | null>(null);
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());

  /*
   * THE SELECTION IS DERIVED, NOT REPAIRED.
   *
   * `panels` comes from a server render and a navigation to another series
   * reuses this component, so a stored season number can outlive the series
   * that had it -- and a selection pointing at a season nothing renders would
   * hide every panel, which is a blank page that reads as a load failure. The
   * first draft fixed that up in an effect; deriving it during render makes
   * the state unrepresentable instead, and `react-hooks/set-state-in-effect`
   * was right to refuse the effect.
   *
   * `chosen` is therefore what the VIEWER asked for -- `null` until they ask
   * for anything -- and `selected` is what the component can honour.
   */
  const selected =
    chosen !== null && panels.some((panel) => panel.seasonNumber === chosen)
      ? chosen
      : (panels[0]?.seasonNumber ?? 0);

  function focusSeason(seasonNumber: number) {
    setChosen(seasonNumber);
    /* Roving tabindex: the newly selected tab is the only one in the tab
     * order, so focus has to follow the selection or it lands nowhere. */
    tabRefs.current.get(seasonNumber)?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = panels.findIndex((panel) => panel.seasonNumber === selected);
    if (index === -1) return;

    /* A total switch over the keys this control claims. Anything else is left
     * to the browser -- a tab strip that swallowed Tab, or the shortcuts a
     * screen reader uses, would be worse than no key handling at all. */
    let target: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        target = (index + 1) % panels.length;
        break;
      case "ArrowLeft":
        target = (index - 1 + panels.length) % panels.length;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = panels.length - 1;
        break;
      default:
        return;
    }

    const next = panels[target];
    if (next === undefined) return;
    /* Only now, once a key this control owns has matched: `preventDefault`
     * before the switch would have eaten Home and End on the whole page. */
    event.preventDefault();
    focusSeason(next.seasonNumber);
  }

  /*
   * THE FIRST RENDER, AND THE ONE A BROWSER WITHOUT THE BUNDLE KEEPS: the flat
   * stack this task is replacing. It is byte-for-byte the arrangement
   * `episode-list.tsx` produced before PW-0307 -- a section per season, every
   * one of them open -- so nothing is behind a control that cannot be operated.
   */
  if (!interactive || panels.length <= 1) {
    return (
      <>
        {panels.map((panel) => (
          <section
            className="section"
            key={panel.seasonNumber}
            aria-labelledby={`season-${String(panel.seasonNumber)}`}
          >
            <div className="section-head">
              <h2 id={`season-${String(panel.seasonNumber)}`}>{panel.heading}</h2>
              <small>{panel.summary}</small>
            </div>
            {panel.content}
          </section>
        ))}
      </>
    );
  }

  return (
    <section className="section" aria-labelledby="seasons-heading">
      {/*
        A HEADING THE TAB STRIP CAN BE NAMED BY, and it is visually hidden
        rather than absent. `aria-label="Seasons"` on the tablist would have
        done the same job for a screen reader and nothing for anyone else; a
        real heading also gives the section a name in the document outline,
        which is how a reader skipping by heading finds the episodes at all.
      */}
      <h2 className="visually-hidden" id="seasons-heading">
        Seasons
      </h2>
      <div
        className={styles.tabs}
        role="tablist"
        aria-labelledby="seasons-heading"
        onKeyDown={onKeyDown}
      >
        {panels.map((panel) => (
          <button
            type="button"
            key={panel.seasonNumber}
            ref={(node) => {
              if (node === null) tabRefs.current.delete(panel.seasonNumber);
              else tabRefs.current.set(panel.seasonNumber, node);
            }}
            id={tabId(panel.seasonNumber)}
            role="tab"
            aria-selected={panel.seasonNumber === selected}
            aria-controls={panelId(panel.seasonNumber)}
            /* ROVING TABINDEX. One stop for the whole strip, not one per
             * season: a ten-season series would otherwise cost ten tab presses
             * to get past, which is the toll PW-0301 removed from the header
             * with a skip link. */
            tabIndex={panel.seasonNumber === selected ? 0 : -1}
            className={styles.tab}
            onClick={() => setChosen(panel.seasonNumber)}
            data-testid="season-tab"
          >
            {panel.heading}
          </button>
        ))}
      </div>

      {panels.map((panel) => (
        <div
          key={panel.seasonNumber}
          id={panelId(panel.seasonNumber)}
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={tabId(panel.seasonNumber)}
          /* EVERY PANEL IS RENDERED AND THE UNSELECTED ONES ARE `hidden`,
           * rather than one panel mounted at a time. Unmounting would throw
           * away the DOM a viewer scrolled through and, more importantly, would
           * make the browser's find-in-page unable to see any season but the
           * open one -- which on a series is exactly the search somebody is
           * trying to do. */
          hidden={panel.seasonNumber !== selected}
          /* Focusable so that a keyboard user leaving the tab strip lands in
           * the panel it controls, which is the pattern's own requirement when
           * the panel's first child is not itself focusable. */
          tabIndex={panel.seasonNumber === selected ? 0 : -1}
          data-testid="season-panel"
          data-season={panel.seasonNumber}
        >
          <div className="section-head">
            <h3>{panel.heading}</h3>
            <small>{panel.summary}</small>
          </div>
          {panel.content}
        </div>
      ))}
    </section>
  );
}
