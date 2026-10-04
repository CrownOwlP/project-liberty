import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RovingGroup } from "./roving-group";

/* -------------------------------------------------------------------------
 * The half of the roving group only a SERVER render can see (PL-0725)
 *
 * `apps/web/vitest.config.ts` sets `environment: "node"`: no DOM, no effects,
 * no focus, no key events. So nothing here can press an arrow key -- that is
 * `e2e/tests/keyboard-reachability.spec.ts`, in a real browser, and it is
 * where the hydrated behaviour is proven.
 *
 * WHAT THAT LEAVES UNCOVERED, AND WHY THIS FILE EXISTS. The e2e can only ever
 * observe the component AFTER hydration. The property PL-0725 put at risk is
 * the one before it: the first client render must reproduce the server's
 * markup, and the arrow-key instruction must not appear until the keys
 * actually work. `roving.test.ts` cannot see it either -- it tests `roving.ts`
 * over plain numbers and never renders anything. So the server half had no
 * assertion anywhere, in a task whose whole change was to the mechanism that
 * produces it.
 * ---------------------------------------------------------------------- */

const INSTRUCTION = /arrow keys/i;

/*
 * OFF-SITE HREFS, FOR A LINT RULE RATHER THAN FOR REALISM. A rail's cards link
 * to `/title/<id>`, and `@next/next/no-html-link-for-pages` refuses a raw `<a>`
 * pointing at a route this application serves -- correctly, for product code.
 * Here the children are only something focusable to arrange, and importing
 * `next/link` would drag the router into a server-render assertion that is not
 * about routing at all. A `.invalid` host (RFC 2606) can never resolve, so
 * nothing here can be mistaken for a real destination.
 */
const ONE = "https://cards.invalid/one";
const TWO = "https://cards.invalid/two";

describe("what the server sends, before anything can listen for a key", () => {
  it("renders the group and its children", () => {
    const html = renderToStaticMarkup(
      <RovingGroup as="ul" itemNoun="titles on the Trending rail">
        <li>
          <a href={ONE}>One</a>
        </li>
      </RovingGroup>
    );

    expect(html).toContain('data-testid="roving-group"');
    expect(html).toContain(`href="${ONE}"`);
  });

  it("promises no arrow keys on a page where nothing is listening for them", () => {
    /*
     * THE GUARD, AND THE REASON IT IS NOT A DETAIL. `aria-description` is read
     * to a screen-reader user on entry. Announcing "use the left and right
     * arrow keys" in server-rendered HTML -- which can be served from a cache,
     * and which is all a viewer has until hydration completes or if it never
     * does -- tells somebody a thing they can rely on that is not true yet.
     * The instruction appears with the behaviour it describes, or not at all.
     */
    const html = renderToStaticMarkup(
      <RovingGroup as="ul" itemNoun="titles on the Trending rail">
        <li>
          <a href={ONE}>One</a>
        </li>
      </RovingGroup>
    );

    expect(html).not.toMatch(INSTRUCTION);
    expect(html).not.toContain("aria-description");
  });

  it("sets no tabindex, so an unhydrated rail is an ordinary list of links", () => {
    /*
     * The arrangement is applied in an effect. If the server emitted it, a
     * page that failed to hydrate would have a rail with exactly one
     * reachable card and no way to reach the rest -- strictly worse than the
     * plain tab order it degrades to now.
     */
    const html = renderToStaticMarkup(
      <RovingGroup as="ul" itemNoun="titles on the Trending rail">
        <li>
          <a href={ONE}>One</a>
        </li>
        <li>
          <a href={TWO}>Two</a>
        </li>
      </RovingGroup>
    );

    expect(html).not.toContain("tabindex");
  });

  it("renders a div when asked for one, and still says nothing", () => {
    const html = renderToStaticMarkup(
      <RovingGroup as="div" itemNoun="results">
        <div>
          <button type="button">A result</button>
        </div>
      </RovingGroup>
    );

    expect(html.startsWith("<div")).toBe(true);
    expect(html).not.toMatch(INSTRUCTION);
  });
});

describe("the client gains the instruction, and the source says how", () => {
  async function source(): Promise<string> {
    const raw = await readFile(new URL("./roving-group.tsx", import.meta.url), "utf8");
    /* Comments stripped first: this component's header discusses the rule
     * below in prose, and a rule its own explanation can fail is not a rule.
     * The pattern `degraded-banner.test.tsx` established. */
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("asks whether it has hydrated instead of writing it into state", async () => {
    /*
     * PL-0725's acceptance forbids making lint green without changing the
     * behaviour the rule objects to. `react-hooks/set-state-in-effect` would
     * catch a re-introduced `setMounted` in CI, but only while that rule stays
     * enabled; this is the assertion that does not depend on the config.
     *
     * The server snapshot is `false` and the client snapshot is `true`, so
     * React performs the hydration-safe switch itself -- the same two renders,
     * with no state to make conditional by accident.
     */
    const text = await source();
    expect(text).toContain("useSyncExternalStore");
    expect(text).not.toMatch(/setMounted/);
  });

  it("writes no clamped index back into state", async () => {
    /*
     * `active` is a REQUEST, and every use clamps it against the count the DOM
     * has at that moment. The removed write-back was the second setState in
     * that effect; this pins that the effect no longer sets any state at all,
     * which is what makes the remaining `setActive` calls -- both in event
     * handlers, where setState belongs -- safe to read at a glance.
     */
    const text = await source();
    const effectBody = /useEffect\(\(\) => \{([\s\S]*?)\n  \}\);/.exec(text)?.[1];

    expect(effectBody, "the effect was not found; this rule has gone vacuous").toBeTypeOf("string");
    expect(effectBody).not.toMatch(/setActive\(|setMounted\(/);
  });

  it("clamps before asking which card is next", async () => {
    /*
     * NOT A TIDY-UP. `nextActive` is not safe against an out-of-range
     * `current`: ArrowLeft from index 7 in a three-card rail returns 6, which
     * names a card that is not there. The old write-back hid this by keeping
     * state in range; with it gone, the clamp at the point of use is what
     * makes the handler correct, and `roving.test.ts` pins `clampActive`
     * itself.
     */
    const text = await source();
    expect(text).toMatch(/nextActive\(\s*event\.key,\s*clampActive\(active, controls\.length\)/);
  });
});
