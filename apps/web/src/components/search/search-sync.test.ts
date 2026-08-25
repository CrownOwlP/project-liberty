import { describe, expect, it } from "vitest";
import { SEARCH_QUERY_MAX_LENGTH } from "@liberty/contracts/domains/search";
import {
  SEARCH_ROUTE,
  SEARCH_SYNC_HISTORY_LIMIT,
  buildSearchHref,
  createSearchSyncState,
  latestRequestedQuery,
  recordSearchCommit,
  reconcileSearchQuery,
  type SearchSyncState
} from "./search-sync";

/*
 * Surrogate fixtures, built from code points rather than pasted in as glyphs so
 * that what a test is about does not depend on this file's encoding surviving
 * every tool it passes through. A lone surrogate is invisible in an editor and
 * indistinguishable from a mojibaked one; a `String.fromCharCode` is not.
 */
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const LOW_SURROGATE = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);
/** One astral character, i.e. TWO UTF-16 code units. */
const GRINNING = String.fromCodePoint(0x1f600);

/**
 * Small driver so a test reads as the sequence of events it is about — commit,
 * commit, render arrives, render arrives — rather than as state plumbing. Every
 * step returns the decision the form would have acted on.
 */
function driver(initialQuery: string) {
  let state: SearchSyncState = createSearchSyncState(initialQuery);

  return {
    commit(query: string) {
      state = recordSearchCommit(state, query);
    },
    /** A server render carrying `?q=` arrives. */
    render(query: string) {
      const outcome = reconcileSearchQuery(state, query);
      state = outcome.state;
      return outcome.decision;
    },
    requested() {
      return latestRequestedQuery(state);
    },
    commitCount() {
      return state.commits.length;
    }
  };
}

describe("buildSearchHref", () => {
  it("addresses the bare route for an empty or whitespace-only query", () => {
    // Not `/search?q=`: an empty parameter reads as a search that was run and
    // matched nothing, which is a different state from never having searched.
    expect(buildSearchHref("")).toBe(SEARCH_ROUTE);
    expect(buildSearchHref("   ")).toBe(SEARCH_ROUTE);
  });

  it("encodes a space as %20 rather than as a form-encoded plus", () => {
    expect(buildSearchHref("the fall")).toBe("/search?q=the%20fall");
  });

  it("normalizes before encoding, so equivalent typing shares one address", () => {
    expect(buildSearchHref("  the   fall  ")).toBe(buildSearchHref("the fall"));
  });

  it("encodes the characters that would otherwise become URL structure", () => {
    // If any of these ever survive unencoded, the query has stopped being a
    // value and started being part of the address.
    expect(buildSearchHref("a&b")).toBe("/search?q=a%26b");
    expect(buildSearchHref("a#b")).toBe("/search?q=a%23b");
    expect(buildSearchHref("a=b")).toBe("/search?q=a%3Db");
    expect(buildSearchHref("a?b")).toBe("/search?q=a%3Fb");
    expect(buildSearchHref("a+b")).toBe("/search?q=a%2Bb");
    expect(buildSearchHref("100%")).toBe("/search?q=100%25");
  });

  it("encodes an HTML-flavoured query instead of carrying it as markup", () => {
    expect(buildSearchHref("<img src=x onerror=alert(1)>")).toBe(
      "/search?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E"
    );
  });

  it("carries the contract's length cap into the address", () => {
    const href = buildSearchHref("a".repeat(SEARCH_QUERY_MAX_LENGTH + 500));
    expect(href).toBe(`/search?q=${"a".repeat(SEARCH_QUERY_MAX_LENGTH)}`);
  });

  it("survives a lone surrogate instead of throwing URIError at it", () => {
    /*
     * `encodeURIComponent` throws on an unpaired surrogate. Reachable from a
     * crafted link, from a paste, and — before the fix — from ordinary
     * truncation. A throw here does not merely fail one navigation: it happens
     * after the commit has been recorded, so the reconciler would believe it had
     * asked for a query it never navigated to and the field would accept typing
     * forever without moving. U+FFFD is what the URL round trip produces for
     * these code units anyway.
     */
    expect(buildSearchHref(HIGH_SURROGATE)).toBe(`/search?q=${encodeURIComponent(REPLACEMENT)}`);
    expect(buildSearchHref(LOW_SURROGATE)).toBe(`/search?q=${encodeURIComponent(REPLACEMENT)}`);
    expect(buildSearchHref(`a${HIGH_SURROGATE}b`)).toBe(
      `/search?q=a${encodeURIComponent(REPLACEMENT)}b`
    );
  });

  it("does not cut a surrogate pair in half at the length cap", () => {
    /*
     * THE BLOCKER, as an example. 127 ASCII characters plus one astral
     * character is 129 code units, so the cap lands between the two halves of
     * the pair; slicing there produced a string ending in a lone high surrogate
     * and `encodeURIComponent` threw on it. Backing up to the code-point
     * boundary drops the whole character.
     */
    const overflowing = `${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}${GRINNING}`;
    expect(overflowing).toHaveLength(SEARCH_QUERY_MAX_LENGTH + 1);
    expect(buildSearchHref(overflowing)).toBe(
      `/search?q=${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}`
    );
  });

  it("keeps an astral character that fits inside the cap", () => {
    // The complement of the test above: backing up must happen at the boundary
    // and nowhere else, or the cap would quietly cost a character every time.
    const exact = `${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 2)}${GRINNING}`;
    expect(exact).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
    expect(buildSearchHref(exact)).toBe(
      `/search?q=${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 2)}${encodeURIComponent(GRINNING)}`
    );
  });
});

describe("search sync on the ordinary path", () => {
  it("treats the query the page was rendered for as already applied", () => {
    const form = driver("aurora");
    expect(form.render("aurora")).toEqual({ kind: "unchanged" });
    expect(form.requested()).toBe("aurora");
  });

  it("re-reconciling the same render is a no-op, as React re-runs effects", () => {
    // StrictMode invokes every effect twice on mount in development. If the
    // second pass were not inert, every mount would fight itself.
    const form = driver("");
    form.commit("aurora");
    expect(form.render("aurora")).toEqual({ kind: "acknowledged", epoch: 1 });
    expect(form.render("aurora")).toEqual({ kind: "unchanged" });
  });

  it("acknowledges its own navigation without writing to the field", () => {
    const form = driver("");
    form.commit("aur");
    // The user keeps typing while that navigation is in flight; the render for
    // "aur" must not put "aur" back into a field that now says "aurora".
    expect(form.render("aur")).toEqual({ kind: "acknowledged", epoch: 1 });
  });

  it("ignores a render of the previous query that arrives after a commit", () => {
    // The window between asking the router for a new query and its render
    // arriving still shows the old one. That is not an external navigation.
    const form = driver("aur");
    form.commit("aurora");
    expect(form.render("aur")).toEqual({ kind: "unchanged" });
    expect(form.render("aurora")).toEqual({ kind: "acknowledged", epoch: 1 });
  });

  it("reports the query it last asked for, not the one last rendered", () => {
    const form = driver("aur");
    form.commit("aurora");
    expect(form.requested()).toBe("aurora");
  });

  it("matches a render regardless of how the query was spaced", () => {
    const form = driver("");
    form.commit("the fall");
    expect(form.render("  the   fall ")).toEqual({ kind: "acknowledged", epoch: 1 });
  });
});

describe("search sync under out-of-order renders", () => {
  it("ignores a slow render for an older query that lands after a newer one", () => {
    /*
     * The classic search defect: a slow request for "au" landing after a fast
     * one for "aurora" and replacing correct results with stale ones. Here the
     * damage would be worse than stale results — adopting "au" would also pull
     * four characters back out of the field the user is still typing in.
     */
    const form = driver("");
    form.commit("au");
    form.commit("aurora");

    expect(form.render("aurora")).toEqual({ kind: "acknowledged", epoch: 2 });
    expect(form.render("au")).toEqual({ kind: "stale", epoch: 1 });
  });

  it("ignores every superseded render, not only the most recent one", () => {
    const form = driver("");
    form.commit("a");
    form.commit("au");
    form.commit("aur");
    form.commit("aurora");

    expect(form.render("aurora")).toEqual({ kind: "acknowledged", epoch: 4 });
    expect(form.render("aur")).toEqual({ kind: "stale", epoch: 3 });
    expect(form.render("au")).toEqual({ kind: "stale", epoch: 2 });
    expect(form.render("a")).toEqual({ kind: "stale", epoch: 1 });
  });

  it("still applies renders that arrive in order", () => {
    const form = driver("");
    form.commit("au");
    form.commit("aurora");

    expect(form.render("au")).toEqual({ kind: "acknowledged", epoch: 1 });
    expect(form.render("aurora")).toEqual({ kind: "acknowledged", epoch: 2 });
  });

  it("matches a repeated query to the newer of its two commits", () => {
    // Typed "aur", deleted back to "au", typed "aur" again. The render that
    // arrives belongs to the second "aur"; treating it as the first would
    // classify a current render as stale and freeze the field.
    const form = driver("");
    form.commit("aur");
    form.commit("au");
    form.commit("aur");

    expect(form.render("aur")).toEqual({ kind: "acknowledged", epoch: 3 });
  });

  it("leaves the requested query alone when it drops a stale render", () => {
    const form = driver("");
    form.commit("au");
    form.commit("aurora");
    form.render("aurora");
    form.render("au");

    // The form still believes "aurora" is what the URL should say, so nothing
    // re-commits and the field and the address bar cannot end up disagreeing
    // with no way back.
    expect(form.requested()).toBe("aurora");
  });
});

describe("search sync under navigation from outside the form", () => {
  it("adopts a query nobody here asked for", () => {
    // A shared link, a bookmark, or the back button leaving the search surface
    // and coming forward again. The URL is the addressable thing, so it wins.
    const form = driver("aurora");
    expect(form.render("northstar")).toEqual({ kind: "adopt", query: "northstar" });
    expect(form.requested()).toBe("northstar");
  });

  it("adopts an emptied query as the idle state rather than as no change", () => {
    const form = driver("aurora");
    expect(form.render("")).toEqual({ kind: "adopt", query: "" });
  });

  it("does not let an in-flight commit undo an external navigation", () => {
    /*
     * The user typed, then followed a link back onto the search surface before
     * the debounced navigation landed. The external query is newer, so it wins,
     * and our own render arriving afterwards is stale rather than authoritative.
     */
    const form = driver("");
    form.commit("aurora");
    expect(form.render("northstar")).toEqual({ kind: "adopt", query: "northstar" });
    expect(form.render("aurora")).toEqual({ kind: "stale", epoch: 1 });
    expect(form.requested()).toBe("northstar");
  });

  it("adopts the normalized query, so the field says what the URL means", () => {
    const form = driver("");
    expect(form.render("  Aurora   Fall  ")).toEqual({ kind: "adopt", query: "Aurora Fall" });
  });

  it("adopts a hand-written over-long query as the query that was actually run", () => {
    const form = driver("");
    const decision = form.render("z".repeat(SEARCH_QUERY_MAX_LENGTH + 40));
    expect(decision).toEqual({ kind: "adopt", query: "z".repeat(SEARCH_QUERY_MAX_LENGTH) });
  });
});

describe("search sync when a query is visited twice", () => {
  it("adopts a navigation back to a query whose own render already arrived", () => {
    /*
     * The user typed "a", then "au", and both renders landed. Something now
     * navigates to /search?q=a — a link, a bookmark, the back button leaving and
     * returning. "a" IS in the commit log, so matching on the query string alone
     * classified this as a render of epoch 1, older than the applied epoch 2,
     * and dropped it: field "au", URL "a", results for "a", and the debounce
     * guard refusing to re-commit. A permanent three-way disagreement.
     *
     * One commit can only explain one render. Epoch 1 was already answered, so
     * this second "a" has to have come from somewhere else.
     */
    const form = driver("");
    form.commit("a");
    form.commit("au");
    expect(form.render("a")).toEqual({ kind: "acknowledged", epoch: 1 });
    expect(form.render("au")).toEqual({ kind: "acknowledged", epoch: 2 });

    expect(form.render("a")).toEqual({ kind: "adopt", query: "a" });
    expect(form.requested()).toBe("a");
    // And adopting it is idempotent, exactly as any other adoption is.
    expect(form.render("a")).toEqual({ kind: "unchanged" });
  });

  it("adopts a navigation back to the query the page was first rendered for", () => {
    // Same shape, reached through the seed commit rather than a typed one. The
    // seed is spent at construction for precisely this case.
    const form = driver("aurora");
    expect(form.render("northstar")).toEqual({ kind: "adopt", query: "northstar" });
    expect(form.render("aurora")).toEqual({ kind: "adopt", query: "aurora" });
  });

  it("still matches a repeated query to its unanswered commit before adopting", () => {
    // The counterweight to the two above: spending must not make the form
    // forget a request that is genuinely still outstanding.
    const form = driver("");
    form.commit("aur");
    expect(form.render("aur")).toEqual({ kind: "acknowledged", epoch: 1 });
    form.commit("au");
    form.commit("aur");
    expect(form.render("aur")).toEqual({ kind: "acknowledged", epoch: 3 });
    expect(form.render("au")).toEqual({ kind: "stale", epoch: 2 });
  });
});

describe("search sync leaves the results behind when it drops a render", () => {
  it("does not repair the result list a stale render put on screen", () => {
    /*
     * A STATED LIMITATION, pinned so it stays a decision.
     *
     * `stale` describes the field and the URL. By the time it is returned React
     * has already committed the page with the superseded query, so the result
     * list and the announced sentence describe "au" while the field and the
     * address bar say "aurora". Nothing here re-fetches — see the note on the
     * `stale` variant for why both automatic repairs (a `router.refresh()` and a
     * re-issued `router.replace`) were rejected as loop-or-adopt.
     */
    const form = driver("");
    form.commit("au");
    form.commit("aurora");
    expect(form.render("aurora")).toEqual({ kind: "acknowledged", epoch: 2 });
    expect(form.render("au")).toEqual({ kind: "stale", epoch: 1 });

    // No repair is requested, and the form does not re-commit by itself: the
    // decision carries nothing for the caller to act on and the requested query
    // is untouched.
    expect(form.requested()).toBe("aurora");
    expect(form.render("aurora")).toEqual({ kind: "unchanged" });

    // The recovery that does exist: one further keystroke, and every surface
    // agrees again.
    form.commit("aurora borealis");
    expect(form.render("aurora borealis")).toEqual({ kind: "acknowledged", epoch: 3 });
    expect(form.requested()).toBe("aurora borealis");
  });
});

describe("search sync bounds", () => {
  it("keeps its history bounded across a long typing session", () => {
    const form = driver("");
    for (let index = 0; index < SEARCH_SYNC_HISTORY_LIMIT * 3; index += 1) {
      form.commit(`query ${index}`);
    }
    expect(form.commitCount()).toBe(SEARCH_SYNC_HISTORY_LIMIT);
  });

  it("still recognises its most recent commits after trimming", () => {
    const form = driver("");
    for (let index = 0; index < SEARCH_SYNC_HISTORY_LIMIT * 3; index += 1) {
      form.commit(`query ${index}`);
    }
    const last = SEARCH_SYNC_HISTORY_LIMIT * 3 - 1;
    expect(form.render(`query ${last}`)).toEqual({
      kind: "acknowledged",
      epoch: last + 1
    });
    expect(form.render(`query ${last - 1}`)).toEqual({ kind: "stale", epoch: last });
  });

  it("drops a render whose commit was trimmed instead of adopting it", () => {
    /*
     * The bound reproducing the exact defect the module exists to prevent. A
     * render for a commit that fell off the log matched nothing, and matching
     * nothing meant "external", so the oldest query in the session was written
     * back into the field under the user's cursor, `appliedEpoch` was pushed
     * above every outstanding commit — marking all of them stale forever — and
     * that ancient query became the latest requested one, which is exactly what
     * the debounce guard then refuses to re-commit. Unrecoverable.
     *
     * A bound is a statement about how much is REMEMBERED. It must not double as
     * a statement about where a render came from.
     */
    const form = driver("");
    for (let index = 0; index < SEARCH_SYNC_HISTORY_LIMIT * 3; index += 1) {
      form.commit(`query ${index}`);
    }

    const decision = form.render("query 0");
    expect(decision.kind).toBe("stale");
    expect(form.requested()).toBe(`query ${SEARCH_SYNC_HISTORY_LIMIT * 3 - 1}`);

    // And the form is still able to recognise its own newest navigation, which
    // is the property the old behaviour destroyed.
    const last = SEARCH_SYNC_HISTORY_LIMIT * 3 - 1;
    expect(form.render(`query ${last}`)).toEqual({ kind: "acknowledged", epoch: last + 1 });
  });

  it("drops an unattributable render at the bound and just past it, not only far past", () => {
    // Off-by-one cover for the trim watermark itself. The seed occupies one
    // slot, so the log overflows on the LIMIT-th commit, not the LIMIT+1-th.
    const atBound = driver("");
    for (let index = 0; index < SEARCH_SYNC_HISTORY_LIMIT - 1; index += 1) {
      atBound.commit(`query ${index}`);
    }
    expect(atBound.commitCount()).toBe(SEARCH_SYNC_HISTORY_LIMIT);
    // Nothing has been trimmed yet, so "not in the log" still proves "external".
    expect(atBound.render("northstar")).toEqual({ kind: "adopt", query: "northstar" });

    const pastBound = driver("");
    for (let index = 0; index < SEARCH_SYNC_HISTORY_LIMIT; index += 1) {
      pastBound.commit(`query ${index}`);
    }
    expect(pastBound.commitCount()).toBe(SEARCH_SYNC_HISTORY_LIMIT);
    /*
     * One commit has been forgotten, so the proof is gone with it and an
     * unattributable render is ignored rather than adopted. This IS a cliff:
     * the same external navigation adopts before the log overflows and is
     * dropped afterwards. It is the deliberate side of the trade — being wrong
     * this way costs a field that still shows what the user typed until they
     * touch the keyboard, and being wrong the other way costs the search box.
     */
    expect(pastBound.render("northstar").kind).toBe("stale");
    expect(pastBound.requested()).toBe(`query ${SEARCH_SYNC_HISTORY_LIMIT - 1}`);
  });
});
