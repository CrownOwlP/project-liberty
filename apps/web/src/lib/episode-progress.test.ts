import type { PlaybackProgressRow } from "@liberty/persistence";
import { describe, expect, it } from "vitest";

import {
  EPISODE_PROGRESS_QUERY_LIMIT,
  episodeProgressLabel,
  indexEpisodeProgress,
  type EpisodeProgress
} from "./episode-progress";
import {
  CONTINUE_WATCHING_QUERY_LIMIT,
  FINISHED_FRACTION,
  FINISHED_TAIL_SECONDS,
  RESUMABLE_MINIMUM_SECONDS
} from "./continue-watching";

/* -------------------------------------------------------------------------
 * Per-episode watched and in-progress state (PW-0307)
 *
 * THE POLICY IS NOT RESTATED HERE. Every threshold below is read from the
 * exported constants in `lib/continue-watching.ts` rather than written as a
 * literal, for the reason `continue-watching.test.ts` gives about its own
 * suite: "A test that hardcoded 90 and 0.95 would pass after somebody changed
 * the policy and forgot the test, which is the same defect in the other
 * direction."
 *
 * WHAT THIS SUITE IS ACTUALLY ABOUT. `continueWatchingVerdict` decides
 * resumable / finished / barely-started and has its own tests. What is new
 * here is the MAPPING from those three answers onto what an episode list says,
 * and the mapping is where this module can be wrong in a way a viewer sees:
 * an episode marked watched that the player starts from the beginning, or a
 * resume badge on something somebody opened for ten seconds and closed.
 * ---------------------------------------------------------------------- */

const HOUR = 3600;

function row(over: Partial<PlaybackProgressRow>): PlaybackProgressRow {
  return {
    profileId: "profile-1",
    contentId: "northstar-s1e1",
    positionSeconds: 600,
    runtimeSeconds: 2 * HOUR,
    writerEpoch: 1,
    writerId: "tv",
    writeSeq: 1,
    updatedAt: new Date("2026-10-01T10:00:00.000Z"),
    ...over
  };
}

const EPISODES = ["northstar-s1e1", "northstar-s1e2", "northstar-s1e3"];

describe("the mapping from a verdict to what the list says", () => {
  it("a resumable row is in progress, and carries how far through", () => {
    const index = indexEpisodeProgress([row({ positionSeconds: 30 * 60 })], EPISODES);
    expect(index.get("northstar-s1e1")).toEqual({
      state: "in-progress",
      completedFraction: 0.25
    });
  });

  it("a FINISHED row is watched -- the one exclusion that is a claim about the viewer", () => {
    /*
     * Built from the policy rather than from a number: a position inside the
     * finished tail is finished whatever the fraction says, which is the rule
     * that exists so a 22-minute episode is not "95% watched" during its
     * credits.
     */
    const runtime = 42 * 60;
    const index = indexEpisodeProgress(
      [row({ positionSeconds: runtime - (FINISHED_TAIL_SECONDS - 1), runtimeSeconds: runtime })],
      EPISODES
    );
    expect(index.get("northstar-s1e1")).toEqual({ state: "watched" });
  });

  it("the fraction rule also produces watched, for a runtime the tail is too small for", () => {
    const runtime = 3 * HOUR;
    const index = indexEpisodeProgress(
      [row({ positionSeconds: Math.ceil(runtime * FINISHED_FRACTION), runtimeSeconds: runtime })],
      EPISODES
    );
    expect(index.get("northstar-s1e1")).toEqual({ state: "watched" });
  });

  it("a BARELY STARTED row is unwatched, not in progress", () => {
    /*
     * The distinction a viewer would notice. Opening a title and leaving
     * writes a row; `RESUMABLE_MINIMUM_SECONDS` is why the rail ignores it,
     * and putting a resume badge on it here would re-introduce the same
     * mistake one surface over.
     */
    const index = indexEpisodeProgress(
      [row({ positionSeconds: RESUMABLE_MINIMUM_SECONDS - 1 })],
      EPISODES
    );
    expect(index.get("northstar-s1e1")).toEqual({ state: "unwatched" });
  });

  it("a LEASE -- a row with no position -- is unwatched", () => {
    /* The store already excludes these in SQL. The branch is kept because this
     * function is reachable from rows read by other means, which is the same
     * reason `continueWatchingVerdict` restates the rule it is given. */
    const index = indexEpisodeProgress([row({ positionSeconds: null })], EPISODES);
    expect(index.get("northstar-s1e1")).toEqual({ state: "unwatched" });
  });

  it("an unknown runtime is in progress with a null fraction, never zero", () => {
    /*
     * `null` is not 0. A source that never reported a runtime has not said the
     * episode is at the beginning -- it has said nothing -- and a bar drawn at
     * zero would be a statement the data does not support.
     */
    const index = indexEpisodeProgress([row({ runtimeSeconds: null })], EPISODES);
    expect(index.get("northstar-s1e1")).toEqual({ state: "in-progress", completedFraction: null });
  });
});

describe("what it refuses to index", () => {
  it("ignores a row for a title this page is not showing", () => {
    /*
     * The ids are passed in rather than inferred from the rows, because the
     * query returns a profile's recent progress across the WHOLE product. A
     * row for a film the viewer watched yesterday must not produce an entry
     * the episode list then cannot place.
     */
    const index = indexEpisodeProgress([row({ contentId: "aurora-fall" })], EPISODES);
    expect(index.size).toBe(0);
  });

  it("leaves an episode with no row ABSENT rather than marking it unwatched", () => {
    /*
     * Absent and `unwatched` render the same thing today, and they are still
     * different facts: absent means the read did not cover it, and the caller
     * is the one that knows whether the read succeeded. A loader that failed
     * returns `unavailable` and the page shows no badges at all; this function
     * must not fill in a claim on its behalf.
     */
    const index = indexEpisodeProgress([row({ contentId: "northstar-s1e2" })], EPISODES);
    expect(index.has("northstar-s1e1")).toBe(false);
    expect(index.has("northstar-s1e2")).toBe(true);
  });

  it("keeps the store's order when a profile somehow has two rows for one episode", () => {
    /*
     * `listContinueWatching` orders by `updated_at` descending, so the first
     * row for a content id is the newest. Taking the first is how that order
     * is honoured; re-sorting here would be a second ordering authority free
     * to disagree with the one that also decided which rows the limit
     * returned.
     */
    const index = indexEpisodeProgress(
      [
        row({ contentId: "northstar-s1e1", positionSeconds: 30 * 60 }),
        row({ contentId: "northstar-s1e1", positionSeconds: 10 })
      ],
      EPISODES
    );
    expect(index.get("northstar-s1e1")).toEqual({
      state: "in-progress",
      completedFraction: 0.25
    });
  });
});

describe("the page size is a decision, and it is this module's", () => {
  it("is larger than the rail's, because it covers a page rather than five tiles", () => {
    /*
     * `parseListLimit` imposes no ceiling on purpose -- "Any ceiling written
     * here would be a number nobody chose ... a cap belongs there, with a
     * reason" -- so this asserts that the call site made a choice and that the
     * choice is bigger than the one made for a five-tile rail.
     */
    expect(EPISODE_PROGRESS_QUERY_LIMIT).toBeGreaterThan(CONTINUE_WATCHING_QUERY_LIMIT);
    /* And bounded. An unbounded read against a table that grows with every
     * episode a household watches is the slow query the required limit
     * exists to prevent. */
    expect(Number.isSafeInteger(EPISODE_PROGRESS_QUERY_LIMIT)).toBe(true);
  });
});

describe("the badge", () => {
  const labels: ReadonlyArray<readonly [EpisodeProgress | undefined, string | null]> = [
    [{ state: "watched" }, "Watched"],
    [{ state: "in-progress", completedFraction: 0.25 }, "25% watched"],
    [{ state: "in-progress", completedFraction: null }, "In progress"],
    [{ state: "unwatched" }, null],
    [{ state: "unknown" }, null],
    [undefined, null]
  ];

  it.each(labels)("renders %j as %j", (progress, expected) => {
    expect(episodeProgressLabel(progress)).toBe(expected);
  });

  it("says NOTHING for unknown, which is the state that must not make a claim", () => {
    /*
     * The assertion above covers it as one row of a table; this one states why
     * it is the row that matters. `unwatched` has nothing to report.
     * `unknown` is a failed or absent read, and a badge is a claim -- "not
     * watched" there would tell a household they have not seen an episode on
     * the strength of never having looked.
     */
    expect(episodeProgressLabel({ state: "unknown" })).toBeNull();
    /* Non-vacuity: the function does produce labels. */
    expect(episodeProgressLabel({ state: "watched" })).toBe("Watched");
  });

  it("rounds rather than truncating, so 99.6% is not reported as 99%", () => {
    expect(episodeProgressLabel({ state: "in-progress", completedFraction: 0.996 })).toBe(
      "100% watched"
    );
  });
});
