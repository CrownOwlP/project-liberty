/* -------------------------------------------------------------------------
 * The title surface's stated appearance, under test (PL-0103)
 *
 * WHAT THIS FILE IS, STATED PLAINLY. `apps/web` runs Vitest in a `node`
 * environment with no DOM, so nothing here renders a component, mounts a style
 * sheet or resolves a cascade. These are SOURCE assertions: they read
 * `title.module.css` and the files that consume it and check that a rule exists
 * and is actually applied at the call sites that need it. That is the same
 * technique `components/player/telemetry.test.ts` already uses, and for the same
 * reason — the property being defended is invisible in the type of what the
 * component returns.
 *
 * WHAT THEY THEREFORE CANNOT PROVE: that the browser paints it. Specificity
 * against `globals.css` is argued in the module's own comments, not measured
 * here, and the contrast ratios are computed in those comments rather than
 * asserted, because a number recomputed by the test from the same constants the
 * code uses would only be checking arithmetic against itself.
 *
 * They are worth having anyway. Both defects they pin were REMOVALS of an
 * appearance, not wrong values: a link with no rule at all, and a focus rule
 * scoped to one region. A source scan is exactly the shape of check that
 * notices "there is no rule here" — and a rule that is written but never applied
 * is the other half of the same failure, so both halves are asserted.
 * ---------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

const read = (relativePath: string): string =>
  readFileSync(join(HERE, relativePath), "utf8");

/**
 * Comments removed before anything is scanned.
 *
 * These files argue for themselves at length, and the prose names the very
 * selectors the assertions look for — `.focusRing`, `text-decoration` and
 * `border-radius` all appear inside explanatory comments. Scanning the comments
 * as though they were code is how a source-scan test earns a reputation for
 * false positives and then gets deleted.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: string;
}

/**
 * A deliberately small CSS reader: `selector-list { declarations }`, whitespace
 * collapsed.
 *
 * It does not understand nesting or at-rules, and it does not need to — this
 * module has neither, and a rule that grew a `@media` wrapper would stop being
 * matched here rather than being matched incorrectly. That failure mode is the
 * safe one: the test goes red and is read, instead of quietly asserting nothing.
 */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];

  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1];
    const declarations = match[2];
    if (selectorList === undefined || declarations === undefined) continue;

    rules.push({
      selectors: selectorList
        .split(",")
        .map((part) => part.trim().replace(/\s+/g, " "))
        .filter((part) => part.length > 0),
      declarations: declarations.replace(/\s+/g, " ").trim()
    });
  }

  return rules;
}

const RULES = parseRules(stripComments(read("./title.module.css")));

const rulesFor = (selector: string): CssRule[] =>
  RULES.filter((rule) => rule.selectors.includes(selector));

/** Every rule that actually draws a ring, whatever it is selected by. */
const OUTLINE_RULES = RULES.filter((rule) => rule.declarations.includes("outline:"));
const RINGED_SELECTORS = OUTLINE_RULES.flatMap((rule) => rule.selectors);

describe("the stylesheet parses at all", () => {
  /*
   * The guard on everything below. A reader that returned nothing, or that
   * collapsed the file into one enormous rule whose declarations happened to
   * contain every string the assertions look for, would let those assertions pass
   * while checking nothing. Naming the classes the components actually import is
   * what makes this a check on the parse rather than on the file's length.
   */
  it("reads the module as separate rules", () => {
    expect(RULES.length).toBeGreaterThan(4);
    expect(RULES.flatMap((rule) => rule.selectors)).toEqual(
      expect.arrayContaining([".stateHeading", ".heroTitle", ".episodeGrid", ".episodePlay"])
    );
  });
});

describe("the episode row's play control", () => {
  /*
   * `globals.css` sets `a { color: inherit; text-decoration: none }` and
   * `.card p { color: var(--muted); font-size: 12px }`. With no rule of its own
   * the Play link was therefore the same colour, size, weight and decoration as
   * the static runtime line directly above it — and the BLOCKED branch, which
   * cannot be clicked, renders with `.code` and so was the more distinct of the
   * two.
   */
  it("is given an appearance of its own", () => {
    expect(rulesFor(".episodePlay")).toHaveLength(1);
  });

  /*
   * The cue must not be the colour. `--accent` and `--muted` differ by only
   * 1.20:1 in luminance contrast (the arithmetic is in the module), so on a
   * greyscale display, or to a reader with a colour deficiency, a recoloured link
   * is still the runtime line. The underline is what carries it.
   */
  it("distinguishes itself by something other than colour", () => {
    const [rule] = rulesFor(".episodePlay");
    if (rule === undefined) throw new Error("expected a rule for .episodePlay");

    expect(rule.declarations).toContain("text-decoration: underline");
  });

  /* The reviewer's other note: there was no hover rule anywhere on the surface. */
  it("responds to a pointer", () => {
    expect(rulesFor(".episodePlay:hover")).toHaveLength(1);
  });

  /* A rule nothing applies is the same defect as no rule. */
  it("is applied to the link and not merely declared", () => {
    const source = stripComments(read("./episode-list.tsx"));

    expect(source).toContain("title.module.css");
    expect(source).toContain("styles.episodePlay");
  });
});

describe("the focus indicator", () => {
  /*
   * Nothing in `globals.css` removes the user agent's ring and nothing defines
   * one, so the indicator is whatever the browser picks against a near-black
   * background. The module already made that argument and then scoped its remedy
   * to the episode grid, which left the play CTA, the hero's series link, the
   * topbar Home link and the not-found page's only control with exactly the
   * indicator the comment had just called inadequate.
   */
  it("is not scoped to the episode grid alone", () => {
    expect(RINGED_SELECTORS).toContain(".focusRing:focus-visible");
    expect(RINGED_SELECTORS).toContain(".episodeGrid a:focus-visible");
  });

  it("draws a ring the surface already uses elsewhere", () => {
    const [rule] = OUTLINE_RULES;
    if (rule === undefined) throw new Error("expected a rule declaring an outline");

    expect(rule.declarations).toContain("outline: 2px solid var(--accent)");
    expect(rule.declarations).toContain("outline-offset: 3px");
  });

  /*
   * The regression the promotion could have introduced. `.button` declares
   * `border-radius: 10px`; carrying the grid's 4px softening into the shared rule
   * would resquare the play CTA at the instant focus lands on it, and a control
   * that changes shape when you tab to it reads as a rendering fault.
   */
  it("does not reshape a control that has a radius of its own", () => {
    for (const rule of OUTLINE_RULES) {
      expect(rule.declarations).not.toContain("border-radius");
    }
  });

  /* And the softening the grid's plain text anchors still want is not lost. */
  it("still rounds the grid's own text links", () => {
    const rounded = rulesFor(".episodeGrid a:focus-visible").filter((rule) =>
      rule.declarations.includes("border-radius")
    );

    expect(rounded).toHaveLength(1);
  });

  /*
   * Every control the acceptance names, checked at its call site. `.focusRing` is
   * applied per control rather than to a container precisely so that this list is
   * enumerable — a container rule would be satisfied by one edit and silently
   * cover, or fail to cover, whatever a later edit nested inside it.
   */
  const FOCUS_RING_CALL_SITES: ReadonlyArray<{ control: string; file: string }> = [
    { control: "the play CTA", file: "./play-cta.tsx" },
    { control: "the hero's series link", file: "./title-hero.tsx" },
    { control: "the topbar Home link", file: "../../app/title/[titleId]/page.tsx" },
    {
      control: "the not-found page's only control",
      file: "../../app/title/[titleId]/not-found.tsx"
    }
  ];

  for (const { control, file } of FOCUS_RING_CALL_SITES) {
    it(`is applied to ${control}`, () => {
      const source = stripComments(read(file));

      expect(source).toContain("title.module.css");
      expect(source).toContain("styles.focusRing");
    });
  }
});
