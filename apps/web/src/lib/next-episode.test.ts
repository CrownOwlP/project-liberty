import type { TitleEpisodeSummary } from "@liberty/contracts/domains/title";
import { describe, expect, it } from "vitest";

import { resolveNextEpisode } from "./next-episode";
import { resolvePlayAvailability, sortEpisodes } from "../app/title/title-detail";

/* -------------------------------------------------------------------------
 * What plays after this episode (PW-0307)
 *
 * THE ACCEPTANCE ASKS FOR THIS SUITE BY NAME -- "a pure function with its own
 * tests" -- and the reason it gives is the one these cases are organised
 * around: "what plays next" must be RECONSTRUCTIBLE. Every case below is a
 * series written out in full and an answer stated in full, so a report that
 * autoplay chose wrongly becomes a new entry here rather than a session
 * somebody has to recreate.
 *
 * THE RIGHTS CASES ARE THE POINT. The acceptance says an autoplay that skips
 * the rights check "would be the rights breach PL-0703 was opened for, in a new
 * place". `rights: null` is the state that matters most -- undeclared, not
 * refused -- because it is the one that looks like an oversight rather than a
 * decision, and the one `resolvePlayAvailability` exists to keep out of a play
 * affordance.
 * ---------------------------------------------------------------------- */

type Rights = TitleEpisodeSummary["rights"];

function episode(
  season: number,
  number: number,
  rights: Rights = "owned",
  over: Partial<TitleEpisodeSummary> = {}
): TitleEpisodeSummary {
  return {
    id: `s${season}e${number}`,
    title: `Episode ${number}`,
    seasonNumber: season,
    episodeNumber: number,
    runtimeMinutes: 42,
    rights,
    ...over
  } as TitleEpisodeSummary;
}

/** A three-episode season where everything is cleared. */
const CLEARED = [episode(1, 1), episode(1, 2), episode(1, 3)];

describe("the ordinary case", () => {
  it("offers the next episode in the order the list renders", () => {
    const next = resolveNextEpisode(CLEARED, "s1e1");
    expect(next).toMatchObject({ kind: "next", href: "/watch/s1e2", skipped: [] });
    expect(next.kind === "next" && next.episode.id).toBe("s1e2");
  });

  it("does not depend on the order the caller supplied", () => {
    /*
     * `sortEpisodes` is applied here rather than trusted from the input,
     * because a provider can return a series in any order and the affordance
     * and the list must not disagree about what follows what.
     */
    const shuffled = [episode(1, 3), episode(1, 1), episode(1, 2)];
    expect(resolveNextEpisode(shuffled, "s1e1")).toMatchObject({ kind: "next" });
    expect(
      resolveNextEpisode(shuffled, "s1e1").kind === "next" &&
        (resolveNextEpisode(shuffled, "s1e1") as { episode: TitleEpisodeSummary }).episode.id
    ).toBe("s1e2");
  });

  it("CROSSES THE SEASON BOUNDARY: a finale is followed by a premiere", () => {
    /*
     * The decision argued in the module header. Stopping at the boundary would
     * remove the affordance exactly where a viewer most expects it.
     */
    const series = [episode(1, 1), episode(1, 2), episode(2, 1)];
    const next = resolveNextEpisode(series, "s1e2");
    expect(next.kind === "next" && next.episode).toMatchObject({
      seasonNumber: 2,
      episodeNumber: 1
    });
  });
});

describe("there is nothing to play next, and the three reasons are kept apart", () => {
  it("the last episode of the series answers `no_later_episode`", () => {
    expect(resolveNextEpisode(CLEARED, "s1e3")).toEqual({
      kind: "none",
      reason: "no_later_episode"
    });
  });

  it("an id this series does not contain is NOT reported as a finished series", () => {
    /*
     * The distinction that catches a real defect: a watch route handed an
     * episode id from another series, or a stale id after a provider
     * renumbered, would otherwise present as "you have reached the end".
     */
    expect(resolveNextEpisode(CLEARED, "s9e9")).toEqual({
      kind: "none",
      reason: "current_episode_not_in_series"
    });
  });

  it("an empty series answers the same way rather than throwing", () => {
    expect(resolveNextEpisode([], "s1e1")).toEqual({
      kind: "none",
      reason: "current_episode_not_in_series"
    });
  });

  it("later episodes that are all blocked answer `no_later_episode_is_playable`", () => {
    /*
     * Its own code rather than folded into `no_later_episode`, because this is
     * the one an operator can fix -- by recording a rights basis. "The series
     * ended" is not.
     */
    const series = [episode(1, 1), episode(1, 2, null), episode(1, 3, null)];
    expect(resolveNextEpisode(series, "s1e1")).toEqual({
      kind: "none",
      reason: "no_later_episode_is_playable"
    });
  });
});

describe("the rights gate, which is the clause this function exists to honour", () => {
  it("NEVER offers an episode whose rights are undeclared", () => {
    /*
     * `rights: null` is "nobody has said anything", not "refused", and it is
     * the state that must never be rendered as playable -- undeclared and
     * cleared look identical to a viewer if the UI only decides between play
     * and no-play. An autoplay that treated silence as permission is the
     * breach the acceptance names.
     */
    const series = [episode(1, 1), episode(1, 2, null), episode(1, 3)];
    const next = resolveNextEpisode(series, "s1e1");
    expect(next.kind === "next" && next.episode.id).toBe("s1e3");
  });

  it("REPORTS what it passed over rather than skipping silently", () => {
    /*
     * The honesty condition on the skip decision. A surface that renders the
     * outcome without reading `skipped` is making a claim this function did
     * not make, and that is visible in the caller rather than hidden here.
     */
    const series = [episode(1, 1), episode(1, 2, null), episode(1, 3, null), episode(1, 4)];
    const next = resolveNextEpisode(series, "s1e1");
    expect(next.kind === "next" && next.skipped.map((e) => e.id)).toEqual(["s1e2", "s1e3"]);
    expect(next.kind === "next" && next.episode.id).toBe("s1e4");
  });

  it("reports an empty skip list when nothing was passed over", () => {
    /* Non-vacuity for the test above: `skipped` is not simply always
     * populated. */
    expect(resolveNextEpisode(CLEARED, "s1e1")).toMatchObject({ skipped: [] });
  });

  it("the href it returns is the gate's own, not one it built", () => {
    /*
     * THE STRUCTURAL CLAIM THE MODULE HEADER MAKES, ASSERTED. There is no path
     * through `resolveNextEpisode` that produces an href for an episode
     * `resolvePlayAvailability` did not call playable, because the href IS
     * what that function returned. Compared against the gate directly rather
     * than against a literal, so a change to how `watchHref` encodes an id
     * cannot make these two disagree while this test still passes.
     */
    const target = episode(1, 2);
    const next = resolveNextEpisode([episode(1, 1), target], "s1e1");
    const gate = resolvePlayAvailability(target);
    expect(gate.status).toBe("playable");
    expect(next.kind === "next" && next.href).toBe(
      gate.status === "playable" ? gate.href : "<blocked>"
    );
  });

  it("agrees with the gate for EVERY episode of a mixed series", () => {
    /*
     * The property rather than a case: walk the whole series, and for each
     * position assert that whatever is offered next is an episode the gate
     * independently calls playable, and that every episode between them is one
     * the gate independently refuses. A regression that inverted the skip
     * condition passes every single-case test above and fails this one.
     */
    const series = [
      episode(1, 1),
      episode(1, 2, null),
      episode(1, 3),
      episode(2, 1, null),
      episode(2, 2)
    ];
    const ordered = sortEpisodes(series);

    for (const current of ordered) {
      const next = resolveNextEpisode(series, current.id);
      if (next.kind !== "next") continue;

      expect(resolvePlayAvailability(next.episode).status).toBe("playable");
      for (const passed of next.skipped) {
        expect(resolvePlayAvailability(passed).status).toBe("blocked");
      }

      /* And it really is LATER: the offered episode follows the current one in
       * the rendered order, never precedes it. */
      expect(ordered.indexOf(next.episode)).toBeGreaterThan(ordered.indexOf(current));
    }
  });

  it("a rights value outside the allowlist is refused as well as an absent one", () => {
    /*
     * `PLAYABLE_CONTENT_RIGHTS` exists so that a value added to the vocabulary
     * later is non-surfaceable until somebody reviews it, and that only holds
     * if something checks it. Every value the enum admits today is on the
     * allowlist, so the fixture casts one that is not -- which is exactly the
     * situation the allowlist was written for.
     */
    const series = [
      episode(1, 1),
      episode(1, 2, "embargoed" as unknown as Rights),
      episode(1, 3)
    ];
    const next = resolveNextEpisode(series, "s1e1");
    expect(next.kind === "next" && next.episode.id).toBe("s1e3");
    expect(next.kind === "next" && next.skipped.map((e) => e.id)).toEqual(["s1e2"]);
  });
});

describe("determinism", () => {
  it("gives the same answer twice and does not mutate its input", () => {
    /*
     * "Reconstructible" is the acceptance's word. A function that sorted its
     * caller's array in place would mutate a validated contract payload and
     * would make the second call a different question from the first.
     */
    const series = [episode(1, 3), episode(1, 1), episode(1, 2, null)];
    const before = series.map((e) => e.id);

    const first = resolveNextEpisode(series, "s1e1");
    const second = resolveNextEpisode(series, "s1e1");

    expect(first).toEqual(second);
    expect(series.map((e) => e.id)).toEqual(before);
  });

  it("two episodes sharing a (season, episode) pair still order deterministically", () => {
    /*
     * Two providers, or a provider and a fixture, can absolutely produce this.
     * `sortEpisodes` breaks the tie on id by code point, so the same series
     * answers the same way on every request rather than following whatever
     * order the source happened to return.
     */
    const a = episode(1, 2, "owned", { id: "aaa" });
    const b = episode(1, 2, "owned", { id: "bbb" });
    expect(resolveNextEpisode([episode(1, 1), b, a], "s1e1")).toMatchObject({ kind: "next" });
    const next = resolveNextEpisode([episode(1, 1), b, a], "s1e1");
    expect(next.kind === "next" && next.episode.id).toBe("aaa");
    const reversed = resolveNextEpisode([episode(1, 1), a, b], "s1e1");
    expect(reversed.kind === "next" && reversed.episode.id).toBe("aaa");
  });
});
