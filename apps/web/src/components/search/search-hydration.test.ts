import { describe, expect, it } from "vitest";
import {
  decideHydrationAdoption,
  type SearchFieldPhase,
  type SearchHydrationDecision
} from "./search-hydration";

/*
 * No DOM is mounted anywhere in this file, and none is available: `apps/web`
 * runs Vitest under the `node` environment. That is the reason the rule is a
 * function over three values rather than an effect body — the observation is
 * supplied here as data, exactly as the component supplies it from a real
 * element.
 */

/**
 * Read as the sentence every test below is about: the server rendered THIS, and
 * the field was found holding THAT. The mapping onto the named fields the rule
 * actually takes is written out once, here, so no test can transpose the two
 * strings on its own.
 */
function observe(
  renderedValue: string,
  domValue: string | null,
  phase: SearchFieldPhase = "hydration"
): SearchHydrationDecision {
  return decideHydrationAdoption({ domValue, renderedValue, phase });
}

describe("the field holds what was rendered into it", () => {
  it("adopts nothing when the two agree", () => {
    // The ordinary visit: the page arrived, nobody typed into it before the
    // bundle did, and there is no user text to recover.
    expect(observe("aurora", "aurora")).toEqual({ kind: "settled" });
  });

  it("adopts nothing when both are empty", () => {
    // Arriving on /search with no query at all. Empty is a real value here, not
    // an absent one, and it must not be read as "something happened".
    expect(observe("", "")).toEqual({ kind: "settled" });
  });
});

describe("the field holds something else", () => {
  it("adopts text typed into a field the server rendered empty", () => {
    /*
     * THE REPORTED DEFECT. The user reached /search, typed while the client
     * bundle was still loading, and React mounted with the server's empty
     * query. Without this the next commit writes "" over the top and the
     * characters are gone with no error anywhere.
     */
    expect(observe("", "northstar")).toEqual({ kind: "adopt", value: "northstar" });
  });

  it("adopts characters appended to a query the server did render", () => {
    // The same window, reached from a shared link rather than from /search: the
    // field arrives holding "aurora" and the user refines it before hydration.
    expect(observe("aurora", "aurora borealis")).toEqual({
      kind: "adopt",
      value: "aurora borealis"
    });
  });

  it("adopts an emptied field rather than treating empty as nothing to do", () => {
    /*
     * Select-all and delete, before hydration. This is the case a heuristic
     * would get wrong: "adopt when the field is non-empty" reads perfectly and
     * silently restores the query the user just cleared. Emptying the box is a
     * search — it is the idle state — so it is adopted like any other text, and
     * the debounce that follows navigates back to /search.
     */
    expect(observe("aurora", "")).toEqual({ kind: "adopt", value: "" });
  });

  it("adopts the raw text, including whitespace a query would not keep", () => {
    /*
     * WHY THE COMPARISON IS NOT NORMALISED. "the fall " and "the fall" are the
     * same QUERY and a different FIELD: one has a caret sitting after a space
     * because the user is part-way through typing the next word. Normalising
     * before comparing would call this settled and let React delete that space
     * mid-sentence, which is this defect at one character.
     */
    expect(observe("the fall", "the fall ")).toEqual({ kind: "adopt", value: "the fall " });
  });
});

describe("what the rule refuses to answer", () => {
  it("refuses every render after the hydration boundary, divergence or not", () => {
    /*
     * After hydration the input's value is React's own output, so a divergence
     * is either a keystroke already travelling through `onChange` or a value
     * React is about to write. Adopting it would be a state update caused by
     * observing the result of the last state update.
     */
    expect(observe("aurora", "aurora borealis", "post-hydration")).toEqual({
      kind: "not-hydrating"
    });
    expect(observe("aurora", "aurora", "post-hydration")).toEqual({ kind: "not-hydrating" });
    expect(observe("aurora", "", "post-hydration")).toEqual({ kind: "not-hydrating" });
  });

  it("refuses a field it could not read instead of assuming it was empty", () => {
    /*
     * `null` is unknown. Read as `""` it would diverge from any non-empty
     * rendered query and be adopted as a deliberate clearing — so an unreadable
     * element would EMPTY the search box and navigate away from the results the
     * user arrived on.
     */
    expect(observe("aurora", null)).toEqual({ kind: "unobservable" });
    expect(observe("", null)).toEqual({ kind: "unobservable" });
  });

  it("refuses on phase before it considers whether it could read anything", () => {
    // Both refusals apply; the phase is the more fundamental one and the union
    // should say which refusal actually happened rather than the first one the
    // implementation happened to reach.
    expect(observe("aurora", null, "post-hydration")).toEqual({ kind: "not-hydrating" });
  });
});
