import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  assessCardGroup,
  assessReachability,
  describeFailure,
  type ObservedElement
} from "../../apps/web/src/lib/a11y/keyboard-reachability";
import { CATALOG_AVAILABILITY, UNKNOWN_CATALOG_SKIP_REASON } from "../src/env";
import { DEMO } from "../src/fixtures";

/* -------------------------------------------------------------------------
 * Every control on the page can be reached with Tab (PW-0310)
 *
 * ==========================================================================
 * THIS IS A REGRESSION GATE, NOT AN AUDIT
 * ==========================================================================
 *
 * The acceptance asks for "an automated check in the e2e suite that fails
 * when a new interactive element is unreachable by keyboard, because a
 * one-off audit decays and a gate does not." So this file is deliberately
 * boring: it walks the tab order of each route and compares what it reached
 * against what is on the page. It makes no aesthetic judgement, measures no
 * contrast, and reads no label.
 *
 * EVERY DECISION IT MAKES IS SOMEWHERE ELSE. `apps/web/src/lib/a11y/
 * keyboard-reachability.ts` decides what counts as interactive and which
 * elements are legitimately out of the tab order, with unit tests, because a
 * rule that can only be exercised by running a browser is a rule that drifts.
 * This file collects facts and prints failures.
 *
 * ==========================================================================
 * WHY IT TABS RATHER THAN INSPECTING tabindex
 * ==========================================================================
 *
 * Reading `tabindex` would tell us what the markup INTENDS. Pressing Tab
 * tells us what the browser DOES, and the two part company over exactly the
 * defects worth catching: an element covered by an overlay, one inside a
 * container the browser skips, one whose ancestor is `inert`, one that is
 * focusable in principle and never arrives because the order is wrong. A gate
 * that read attributes would have passed every one of them.
 *
 * ==========================================================================
 * THE TWO THINGS THIS GOT WRONG ON ITS FIRST RUN, AND WHY THEY ARE HERE
 * ==========================================================================
 *
 * Both were failures of the GATE, not of the product, and both are written
 * down because a false red is the one result that teaches people to stop
 * reading a gate. The first run reported six unreachable episode links on
 * /title/northstar; a tab-order trace of the same page showed the browser
 * reaching every one of them.
 *
 *   1. IDENTITY WAS A DESCRIPTION. A title page has one `Play` link per
 *      episode row and every one of them describes as `a.episodePlay "Play"`.
 *      The walk below stops when focus returns to something already visited,
 *      so the second identical description looked like a wrap-around: the
 *      walk ended after two rows and the remaining three real, reachable
 *      links were reported as defects. Identity is now the element's position
 *      in a snapshot held in the page, so two things that look alike are two
 *      things. `describe` is a label for a human and nothing else.
 *
 *   2. IT JUDGED A PAGE THAT HAD NOT FINISHED ARRIVING. `SeasonNavigation`
 *      renders every season panel OPEN on the server -- that is the flat
 *      stack a browser without the bundle keeps -- and hides the unselected
 *      ones once it knows it has hydrated. Observing before that and walking
 *      after it is two different pages, and season 2's episode links were
 *      reported unreachable because they were observed while still visible
 *      and walked once they were not. `settle` below waits for the DOM to
 *      stop changing, so both halves see one page.
 *
 * ==========================================================================
 * THE TAB WALK TERMINATES, AND HOW
 * ==========================================================================
 *
 * Tab eventually leaves the document for the browser's own chrome and comes
 * back round. The walk therefore stops on the first REPEAT rather than after
 * a fixed number of presses -- a count would silently truncate a page that
 * grew -- with a generous ceiling as a backstop so a focus trap cannot hang
 * the suite instead of failing it. A trap is itself a defect and is reported
 * as one rather than waited out.
 * ---------------------------------------------------------------------- */

test.skip(CATALOG_AVAILABILITY === "unknown", UNKNOWN_CATALOG_SKIP_REASON);

/** A backstop, not a budget. Reaching it means the walk never came back round. */
const MAX_TAB_PRESSES = 400;

/** How long the DOM must hold still before the page counts as arrived. */
const QUIET_MS = 400;

/** And how long we are prepared to wait for that. */
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * The name of the element snapshot this check keeps in the page.
 *
 * NOTHING IN THE DOM IS MODIFIED to establish identity. An earlier draft
 * stamped a `data-` attribute on every element, which works and which also
 * means the gate is measuring a page nobody ships. Holding an array of the
 * real element references on `window` instead gives exact identity -- index
 * in that array -- while leaving the document byte-for-byte what the viewer
 * got.
 */
const REGISTRY = "__libertyKeyboardProbe";

/**
 * Wait until the page has stopped changing.
 *
 * NOT A SLEEP WITH BETTER MANNERS. Both halves of this check have to see the
 * same page: a server-rendered no-JS fallback and the hydrated application
 * are different documents with different tab orders, and judging one against
 * the other reports defects that do not exist. There is no generic "React has
 * hydrated" signal to wait on, so this waits on the observable consequence --
 * a MutationObserver reporting nothing for `QUIET_MS` -- which is true of
 * hydration, of a late image, and of an effect that rearranges a menu, and
 * which needs no knowledge of any particular component.
 *
 * It RESOLVES rather than throws on timeout. A page that never stops changing
 * is a real thing (a clock, a progress bar) and is not this gate's business;
 * what follows is still a fair measurement as long as both halves are taken
 * close together, which they are.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(
    ([quiet, cap]: readonly [number, number]) =>
      new Promise<void>((resolve) => {
        let timer = 0;
        const finish = (): void => {
          observer.disconnect();
          window.clearTimeout(timer);
          window.clearTimeout(backstop);
          resolve();
        };
        const observer = new MutationObserver(() => {
          window.clearTimeout(timer);
          timer = window.setTimeout(finish, quiet);
        });
        const backstop = window.setTimeout(finish, cap);
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
          characterData: true
        });
        timer = window.setTimeout(finish, quiet);
      }),
    [QUIET_MS, SETTLE_TIMEOUT_MS] as const
  );
}

/**
 * Describe every element on the page, as facts rather than judgements, and
 * leave the element references behind under `REGISTRY` so the walk can say
 * exactly which one it landed on.
 *
 * The `describe` string is for the human who reads a failure: tag, id, test
 * id, first class and a little text is enough to find a thing in a template.
 * It is NOT required to be unique and is never used to match -- see the
 * header.
 */
async function observe(page: Page): Promise<readonly ObservedElement[]> {
  return page.evaluate((registry: string) => {
    const describe = (node: Element): string => {
      const tag = node.tagName.toLowerCase();
      const id = node.id === "" ? "" : `#${node.id}`;
      const testId = node.getAttribute("data-testid");
      const cls = node.classList.length > 0 ? `.${node.classList[0]}` : "";
      const text = (node.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${tag}${id}${testId === null ? "" : `[${testId}]`}${cls}${
        text === "" ? "" : ` "${text}"`
      }`;
    };

    const hasAncestorWith = (node: Element, test: (candidate: Element) => boolean): boolean => {
      let current: Element | null = node;
      while (current !== null) {
        if (test(current)) return true;
        current = current.parentElement;
      }
      return false;
    };

    /* `Array.from` rather than a spread: this package's tsconfig lists `DOM`
     * without `DOM.Iterable`, so a NodeList is not iterable to the compiler. */
    const nodes = Array.from(document.querySelectorAll("*"));
    (window as unknown as Record<string, unknown>)[registry] = nodes;

    return nodes.map((node, index) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const input = node as HTMLInputElement;
      return {
        probe: String(index),
        describe: describe(node),
        tag: node.tagName.toLowerCase(),
        inputType:
          node.tagName.toLowerCase() === "input" ? (input.type ?? "").toLowerCase() : null,
        role: node.getAttribute("role"),
        tabIndexAttr: node.getAttribute("tabindex"),
        /* `disabled` is a property on controls and an attribute elsewhere;
         * aria-disabled is a claim and is honoured as one. */
        disabled:
          (node as HTMLButtonElement).disabled === true ||
          node.getAttribute("aria-disabled") === "true",
        ariaHidden: hasAncestorWith(node, (c) => c.getAttribute("aria-hidden") === "true"),
        inert: hasAncestorWith(node, (c) => c.hasAttribute("inert")),
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0,
        /* The DOM can only see a handler that was attached as an attribute or
         * as an `on*` property. React attaches listeners at the root, so a
         * React `onClick` on a div is NOT visible here -- which is stated
         * rather than hidden, because it is the honest limit of this check:
         * it catches the cases the DOM can see, and the ARIA-role rule above
         * is what catches most of the rest. */
        hasClickHandler:
          node.hasAttribute("onclick") || typeof (node as HTMLElement).onclick === "function",
        href: node.tagName.toLowerCase() === "a" ? node.getAttribute("href") : null
      };
    });
  }, REGISTRY);
}

/** What the walk learns from one Tab press. */
interface Landing {
  /** Index in the registry, or `null` when focus is on nothing we observed. */
  readonly probe: string | null;
  /** True when the registry is gone, which means the page navigated. */
  readonly lost: boolean;
}

/**
 * Which observed element is focused now.
 *
 * `-1` from `indexOf` is reported as `null` rather than as a probe: focus is
 * on something that was not in the snapshot -- the document body, the
 * browser's own chrome, or an element the page added since. None of those is
 * a thing this gate has an opinion about, and none may end the walk.
 */
async function landing(page: Page): Promise<Landing> {
  return page.evaluate((registry: string) => {
    const nodes = (window as unknown as Record<string, unknown>)[registry] as Element[] | undefined;
    if (nodes === undefined) return { probe: null, lost: true };
    const node = document.activeElement;
    if (node === null || node === document.body) return { probe: null, lost: false };
    const index = nodes.indexOf(node);
    return { probe: index === -1 ? null : String(index), lost: false };
  }, REGISTRY);
}

/**
 * Press Tab until focus comes back round, collecting what it landed on.
 *
 * Starts from the document body so the walk begins where a viewer's would,
 * rather than wherever a previous assertion left focus.
 */
async function walkTabOrder(page: Page): Promise<ReadonlySet<string>> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });

  const seen = new Set<string>();
  for (let press = 0; press < MAX_TAB_PRESSES; press += 1) {
    await page.keyboard.press("Tab");
    const where = await landing(page);
    if (where.lost) {
      throw new Error(
        "The page navigated or reloaded while its tab order was being walked, so what was " +
          "observed and what was reached are two different documents. This is a defect in " +
          "the check, not a finding about the page: nothing here presses Enter."
      );
    }
    /* `null` is focus on something outside the snapshot -- the browser's own
     * chrome, most often. The next Tab brings it back to the first element,
     * which we have already seen, so the loop ends on that repeat. */
    if (where.probe === null) continue;
    if (seen.has(where.probe)) return seen;
    seen.add(where.probe);
  }
  throw new Error(
    `Tab was pressed ${MAX_TAB_PRESSES} times and focus never returned to an element it had ` +
      "already visited. That is a focus trap, which is a defect in its own right: a keyboard " +
      "viewer who enters it cannot leave."
  );
}

/**
 * Every rail on the page, as cards and the controls inside them.
 *
 * WHY THIS EXISTS AT ALL. The per-element check above exempts anything with
 * `tabindex="-1"`, and `lib/a11y/roving-group.tsx` sets exactly that on most
 * of a rail's controls. Without this collector the rails could lose their
 * entry point entirely -- every card at -1, the whole row unreachable -- and
 * the gate would stay green, because every one of those controls is exempt.
 * `assessCardGroup` is what makes the exemption something each run has to
 * earn rather than something this file granted once.
 *
 * FOUND BY `data-testid="roving-group"` RATHER THAN BY SELECTOR. The four
 * rails render three different elements with three different classes, two of
 * them CSS-module hashes that change with the file. The component that makes
 * the roving claim is the thing that marks itself, so a rail that stops roving
 * stops claiming it in the same edit.
 */
async function observeRovingGroups(
  page: Page
): Promise<readonly { describe: string; cards: readonly (readonly ObservedElement[])[] }[]> {
  return page.evaluate(() => {
    const CONTROLS = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type=hidden])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]"
    ].join(",");

    const describe = (node: Element): string => {
      const tag = node.tagName.toLowerCase();
      const id = node.id === "" ? "" : `#${node.id}`;
      const cls = node.classList.length > 0 ? `.${node.classList[0]}` : "";
      const text = (node.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${tag}${id}${cls}${text === "" ? "" : ` "${text}"`}`;
    };

    const observe = (node: Element) => {
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return {
        /* `probe` is required by the shared type and is meaningless here:
         * this collector never compares against a tab walk. Named so rather
         * than faked with an index that might be mistaken for one. */
        probe: "not-walked",
        describe: describe(node),
        tag: node.tagName.toLowerCase(),
        inputType: null,
        role: node.getAttribute("role"),
        tabIndexAttr: node.getAttribute("tabindex"),
        disabled:
          (node as HTMLButtonElement).disabled === true ||
          node.getAttribute("aria-disabled") === "true",
        ariaHidden: node.closest('[aria-hidden="true"]') !== null,
        inert: node.closest("[inert]") !== null,
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0,
        hasClickHandler: false,
        href: node.tagName.toLowerCase() === "a" ? node.getAttribute("href") : null
      };
    };

    return Array.from(document.querySelectorAll('[data-testid="roving-group"]')).map(
      (group, index) => ({
        describe: `${describe(group)} (roving group ${String(index + 1)})`,
        cards: Array.from(group.children).map((card) =>
          Array.from(card.querySelectorAll(CONTROLS)).map(observe)
        )
      })
    );
  });
}

/** The probes whose elements are still in the document after the walk. */
async function stillConnected(page: Page): Promise<ReadonlySet<string>> {
  const present = await page.evaluate((registry: string) => {
    const nodes = (window as unknown as Record<string, unknown>)[registry] as Element[] | undefined;
    if (nodes === undefined) return [] as string[];
    const out: string[] = [];
    nodes.forEach((node, index) => {
      if (node.isConnected) out.push(String(index));
    });
    return out;
  }, REGISTRY);
  return new Set(present);
}

/**
 * Observe the settled page, walk it, and judge the two together.
 *
 * ONE PAGE, TWICE. Which elements are still in the document is re-read after
 * the walk and only those are judged. Focus legitimately changes a page -- a
 * menu opens, a tooltip mounts and unmounts -- and an element that was there
 * at the start and gone at the end was never something Tab could have been
 * required to reach. That is not a loophole: an element that has left the
 * document cannot be operated by anybody, and the planted-offender case below
 * is what proves the check still fails on one that stays.
 */
async function assertReachable(page: Page, route: string): Promise<void> {
  await settle(page);
  const observed = await observe(page);
  const focused = await walkTabOrder(page);
  const present = await stillConnected(page);

  const elements = observed.filter((element) => present.has(element.probe));
  const verdict = assessReachability(elements, focused);

  /*
   * THE EXEMPTION IS PAID FOR HERE, BEFORE THE REACHABILITY ASSERTION BELOW.
   * Deliberately first: a rail that has lost its entry point makes the
   * per-element check pass, because every control in it is exempt, so running
   * them the other way round would report a green page with an unreachable
   * row of titles on it.
   */
  for (const group of await observeRovingGroups(page)) {
    const roving = assessCardGroup(group);
    expect(
      roving.ok,
      roving.ok ? "" : `On ${route}: ${roving.why}`
    ).toBe(true);
  }

  /*
   * NON-VACUITY FIRST, and it is not a formality. A route that rendered
   * nothing, or a selector that matched nothing, would otherwise produce a
   * green gate that checked zero controls -- which is the failure mode of
   * every audit that decays into decoration.
   */
  expect(
    verdict.reached.length,
    `${route} reported no reachable interactive elements at all. Either the page did not ` +
      "render or this check stopped working; both are failures."
  ).toBeGreaterThan(0);

  expect(verdict.unreachable, describeFailure(route, verdict)).toEqual([]);
}

test("the home page is operable from the keyboard", async ({ page }) => {
  await page.goto("/");
  await assertReachable(page, "/");
});

test("the search page is operable from the keyboard", async ({ page }) => {
  await page.goto("/search");
  await assertReachable(page, "/search");
});

test("A TITLE PAGE IS OPERABLE FROM THE KEYBOARD, every episode row of it", async ({ page }) => {
  /* The route that caught both of this gate's own defects, and the one with
   * the most repeated structure: a season of episode rows whose controls all
   * look alike is exactly where a per-row regression hides. */
  await page.goto(`/title/${DEMO.series.id}`);
  await assertReachable(page, `/title/${DEMO.series.id}`);
});

test("the watchlist page is operable from the keyboard", async ({ page }) => {
  await page.goto("/watchlist");
  await assertReachable(page, "/watchlist");
});

test("THE PLAYER IS OPERABLE FROM THE KEYBOARD, controls and all", async ({ page }) => {
  test.skip(
    CATALOG_AVAILABILITY !== "fixtures",
    "a build with no catalog source serves a refusal rather than a player; the refusal page " +
      "is covered by the routes above"
  );
  await page.goto(`/watch/${DEMO.movie.id}`);
  /* Wait for the bar, so this is a check on the player and not on a page that
   * had not finished mounting one. */
  await expect(page.getByTestId("player-controls")).toHaveCount(1);
  await assertReachable(page, `/watch/${DEMO.movie.id}`);
});

test("THE GATE ITSELF FAILS WHEN SOMETHING IS UNREACHABLE", async ({ page }) => {
  /*
   * A gate that has never been seen to fail is a gate nobody has tested --
   * the rule this repository already applies to `verify-install.mjs` on every
   * Windows run. An unreachable control is planted here, in the page, and the
   * check is required to catch it.
   *
   * PLANTED RATHER THAN MOCKED: a real div, with a real click handler, really
   * in the document, which is exactly the shape of the defect this gate
   * exists for.
   */
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => {
    const offender = document.createElement("div");
    offender.id = "planted-unreachable-control";
    offender.textContent = "Press me";
    offender.setAttribute("onclick", "void 0");
    offender.style.cssText = "width:120px;height:40px";
    document.body.appendChild(offender);
  });

  const elements = await observe(page);
  const focused = await walkTabOrder(page);
  const verdict = assessReachability(elements, focused);
  expect(verdict.unreachable.map((entry) => entry.describe)).toContain(
    'div#planted-unreachable-control "Press me"'
  );
  expect(describeFailure("/", verdict)).toContain("planted-unreachable-control");
});

test("THE ROVING-GROUP CHECK ITSELF FAILS WHEN A RAIL LOSES ITS ENTRY POINT", async ({ page }) => {
  test.skip(
    CATALOG_AVAILABILITY !== "fixtures",
    "a build with no catalog source renders no rails, so there is no entry point to take away; " +
      "the check is proven against the configuration that has rails"
  );
  /*
   * The second gate in this file, and it needs its own proof for a sharper
   * reason than the first. The per-element check EXEMPTS tabindex=-1, and
   * `lib/a11y/roving-group.tsx` sets -1 on most of every rail's controls. So
   * a rail that lost its entry point -- every card at -1, the whole row
   * unreachable -- would make the per-element check pass, not fail. This is
   * the only thing that would notice, which makes "has it ever been seen to
   * fail" a question with teeth.
   *
   * The failure is PLANTED IN A REAL RAIL rather than constructed as a
   * record: a stale active index after a list shrinks produces exactly this
   * DOM, and `clampActive` in `roving.ts` is what prevents it.
   */
  await page.goto("/");
  await settle(page);

  const railsFound = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[data-testid="roving-group"]'));
    for (const group of groups) {
      for (const control of Array.from(group.querySelectorAll("a[href], button"))) {
        control.setAttribute("tabindex", "-1");
      }
    }
    return groups.length;
  });

  /* Non-vacuity: if the home page stopped rendering rails this test would
   * otherwise pass by checking nothing at all. */
  expect(
    railsFound,
    "the home page rendered no roving groups, so this test proved nothing"
  ).toBeGreaterThan(0);

  const groups = await observeRovingGroups(page);
  const verdicts = groups.map((group) => assessCardGroup(group));
  expect(verdicts.some((verdict) => !verdict.ok)).toBe(true);
  const why = verdicts.flatMap((verdict) => (verdict.ok ? [] : [verdict.why])).join("\n");
  expect(why).toMatch(/NONE of them in the tab order/);
});

/* -------------------------------------------------------------------------
 * The two behaviours the arrangement above exists to buy (PW-0310)
 *
 * The checks so far prove that the rails are SHAPED like a roving tabindex.
 * These prove the shape does what a roving tabindex is for -- otherwise a rail
 * with one card in the tab order and no arrow keys would pass everything above
 * while being strictly worse to use than the fifteen-tab version it replaced.
 * ---------------------------------------------------------------------- */

test("ARROW KEYS MOVE ALONG A RAIL, and Tab then leaves it", async ({ page }) => {
  test.skip(
    CATALOG_AVAILABILITY !== "fixtures",
    "a build with no catalog source renders no rails to arrow along"
  );
  await page.goto("/");
  await settle(page);

  /* Enter the first rail by focusing its entry point, the way Tab would. */
  const entry = await page.evaluate(() => {
    const group = document.querySelector('[data-testid="roving-group"]');
    if (group === null) return null;
    const control = group.querySelector<HTMLElement>('a[href]:not([tabindex="-1"])');
    if (control === null) return null;
    control.focus();
    return (control.textContent ?? "").trim();
  });
  expect(entry, "no rail with an entry point on the home page").not.toBeNull();

  const focusedText = async (): Promise<string> =>
    page.evaluate(() => (document.activeElement?.textContent ?? "").trim());

  await page.keyboard.press("ArrowRight");
  const second = await focusedText();
  expect(second, "ArrowRight did not move focus to another title").not.toBe(entry);

  await page.keyboard.press("ArrowLeft");
  expect(await focusedText()).toBe(entry);

  /* End jumps to the last card; ArrowRight there STAYS, rather than wrapping
   * round to the start. See `nextActive` in lib/a11y/roving.ts for why. */
  await page.keyboard.press("End");
  const last = await focusedText();
  expect(last).not.toBe(entry);
  await page.keyboard.press("ArrowRight");
  expect(await focusedText(), "ArrowRight wrapped around at the end of the rail").toBe(last);

  await page.keyboard.press("Home");
  expect(await focusedText()).toBe(entry);
});

test("A RAIL COSTS FAR FEWER TAB STOPS THAN IT HAS CONTROLS, which is the point", async ({
  page
}) => {
  test.skip(
    CATALOG_AVAILABILITY !== "fixtures",
    "a build with no catalog source renders no rails to count"
  );
  /*
   * MEASURED RATHER THAN ASSERTED AS A SHAPE. Everything above would still
   * pass if a rail held one card and dropped the others from the page, so the
   * claim worth gating is the one the acceptance actually makes: crossing the
   * browse surface should not cost one stop per control.
   *
   * ONLY CONTROLS A BROWSER WOULD ACTUALLY FOCUS ARE COUNTED, and that is a
   * correction rather than a nicety. The first version of this test counted
   * every `a[href]` and `button` and reported "8 of 12 rail controls are in
   * the tab order" against an arrangement that was in fact correct: a card's
   * My List button is `disabled` for a signed-out viewer, so six of those
   * twelve were never in anybody's tab order. A gate that counts things the
   * browser skips reports defects that are not there, which is the one
   * failure mode that teaches people to stop reading a gate.
   */
  await page.goto("/");
  await settle(page);

  const counts = await page.evaluate(() => {
    const FOCUSABLE = "a[href], button, input, select, textarea, summary";
    let focusable = 0;
    let inTabOrder = 0;
    for (const group of Array.from(document.querySelectorAll('[data-testid="roving-group"]'))) {
      for (const control of Array.from(group.querySelectorAll<HTMLElement>(FOCUSABLE))) {
        /* Disabled, hidden, or aria-disabled: out of the tab order for
         * reasons that have nothing to do with this arrangement. */
        if ((control as HTMLButtonElement).disabled) continue;
        if (control.getAttribute("aria-disabled") === "true") continue;
        const box = control.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        focusable += 1;
        if (control.tabIndex >= 0) inTabOrder += 1;
      }
    }
    return { focusable, inTabOrder };
  });

  expect(
    counts.focusable,
    "the home page rendered too few focusable rail controls for this to measure anything"
  ).toBeGreaterThan(3);

  /*
   * One active card per rail, holding its own controls. The bound is
   * deliberately loose -- this is a gate against the arrangement silently
   * reverting, not a pin on how many controls a card may grow.
   */
  expect(
    counts.inTabOrder,
    `${String(counts.inTabOrder)} of ${String(counts.focusable)} focusable rail controls are in ` +
      "the tab order; the roving arrangement is not reducing the cost of crossing the rails"
  ).toBeLessThan(counts.focusable / 2);
});

test("FOCUS FOLLOWS A CLIENT-SIDE NAVIGATION into the new page's main region", async ({ page }) => {
  test.skip(
    CATALOG_AVAILABILITY !== "fixtures",
    "a build with no catalog source has no card to navigate from"
  );
  /*
   * The defect this proves absent is invisible to every mouse: `next/link`
   * swaps the contents of <main> without a document load, nothing moves
   * focus, and a keyboard viewer who activated a card on the second rail is
   * left on an anchor that no longer exists.
   */
  await page.goto("/");
  await settle(page);

  const target = page.locator('[data-testid="roving-group"] h3 a').first();
  await expect(target).toBeVisible();
  await target.focus();
  await page.keyboard.press("Enter");

  await page.waitForURL(/\/title\/|\/watch\//);
  await settle(page);

  const landed = await page.evaluate(() => {
    const node = document.activeElement;
    return {
      id: node === null ? null : node.id,
      tag: node === null ? null : node.tagName.toLowerCase()
    };
  });
  expect(
    landed,
    "after a client-side navigation focus was not moved into the new page's main region, so a " +
      "keyboard viewer must tab past the whole chrome to reach the page they just chose"
  ).toEqual({ id: "main", tag: "main" });
});
