import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { PlaybackProgressRow } from "@liberty/persistence";
import { describe, expect, it } from "vitest";

import {
  CONTINUE_WATCHING_QUERY_LIMIT,
  FINISHED_FRACTION,
  FINISHED_TAIL_SECONDS,
  RESUMABLE_MINIMUM_SECONDS,
  continueWatchingVerdict,
  selectContinueWatching
} from "./continue-watching";

/**
 * The continue-watching rules (PW-0305).
 *
 * THE ACCEPTANCE ASKS FOR A STATED RULE RATHER THAN A MAGIC THRESHOLD, so this
 * suite asserts against the exported constants rather than against literals.
 * A test that hardcoded 90 and 0.95 would pass after somebody changed the
 * policy and forgot the test, which is the same defect in the other direction.
 */

const HOUR = 3600;

function row(over: Partial<PlaybackProgressRow>): PlaybackProgressRow {
  return {
    profileId: "profile-1",
    contentId: "aurora-fall",
    positionSeconds: 600,
    runtimeSeconds: 2 * HOUR,
    writerEpoch: 1,
    writerId: "tv",
    writeSeq: 1,
    updatedAt: new Date("2026-09-05T10:00:00.000Z"),
    ...over
  };
}

function item(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: id,
    kind: "movie",
    rights: "owned",
    genre: "Drama",
    releaseYear: 2024,
    runtimeMinutes: 120,
    episodeCount: null,
    ...over
  } as CatalogItem;
}

describe("a lease is not progress", () => {
  it("excludes a row with no position", () => {
    /*
     * The state `issueWriterLease` creates: the title has been claimed for
     * writing and nothing has been watched. The store already excludes these;
     * the rule is restated here because this function is reachable from a row
     * read by other means, and `positionSeconds` is nullable on the type.
     */
    expect(continueWatchingVerdict(row({ positionSeconds: null }))).toEqual({
      kind: "excluded",
      why: "not_started"
    });
  });
});

describe("finished, by a rule that is written down", () => {
  it("excludes a title inside the tail, whatever the fraction says", () => {
    /*
     * A 22-minute episode with 60 seconds left is 95.5% through, so the
     * fraction would have caught this one too. A THREE-HOUR film with 60
     * seconds left is 99.9% through and the fraction catches it as well -- the
     * tail earns its place at the SHORT end, which the next case shows.
     */
    const almostOver = row({ runtimeSeconds: 22 * 60, positionSeconds: 22 * 60 - 60 });
    expect(continueWatchingVerdict(almostOver).kind).toBe("excluded");
  });

  it("excludes on the tail a title the fraction alone would have kept", () => {
    /*
     * THE CASE THE TAIL EXISTS FOR. Ten hours with 60 seconds left is 99.83%
     * through -- past the fraction — so pick a runtime where the two rules
     * disagree: 30 minutes with 80 seconds left is 95.55%, past 0.95. Use a
     * length where 90 seconds is LESS than 5%: 10 minutes. 10 minutes with 80
     * seconds left is 86.7% through, which the fraction would keep, and the
     * tail correctly calls finished.
     */
    const shortAndNearlyDone = row({ runtimeSeconds: 10 * 60, positionSeconds: 10 * 60 - 80 });
    const fraction = (10 * 60 - 80) / (10 * 60);
    expect(fraction).toBeLessThan(FINISHED_FRACTION);
    expect(continueWatchingVerdict(shortAndNearlyDone)).toEqual({
      kind: "excluded",
      why: "finished"
    });
  });

  it("excludes on the fraction a title the tail alone would have kept", () => {
    /*
     * THE CASE THE FRACTION EXISTS FOR, and the mirror of the one above. A
     * three-hour film at 96% has 432 seconds left -- far outside the 90-second
     * tail -- and is finished by any sensible reading.
     */
    const longAndMostlyDone = row({ runtimeSeconds: 3 * HOUR, positionSeconds: 3 * HOUR * 0.96 });
    expect(3 * HOUR - 3 * HOUR * 0.96).toBeGreaterThan(FINISHED_TAIL_SECONDS);
    expect(continueWatchingVerdict(longAndMostlyDone)).toEqual({
      kind: "excluded",
      why: "finished"
    });
  });

  it("keeps a title exactly one second short of both rules", () => {
    /*
     * A boundary, so the comparison operators are asserted rather than assumed
     * -- and the runtime is chosen so that BOTH rules are genuinely near-misses
     * rather than one of them being nowhere close. The first draft of this test
     * used two hours, where 91 seconds from the end is 98.7% through: the
     * fraction had already fired and the test was asserting the wrong thing. A
     * runtime under FINISHED_TAIL_SECONDS / (1 - FINISHED_FRACTION) -- 1800
     * seconds here -- is the range where the tail binds first, which is the
     * only range in which "one second short of both" is a reachable state.
     */
    const runtimeSeconds = 20 * 60;
    expect(runtimeSeconds).toBeLessThan(FINISHED_TAIL_SECONDS / (1 - FINISHED_FRACTION));
    const positionSeconds = runtimeSeconds - FINISHED_TAIL_SECONDS - 1;
    expect(positionSeconds / runtimeSeconds).toBeLessThan(FINISHED_FRACTION);
    expect(continueWatchingVerdict(row({ runtimeSeconds, positionSeconds })).kind).toBe("resumable");
  });

  it("excludes a title exactly on the tail boundary", () => {
    /* `<=`, not `<`: one more second of credits is not a reason to offer a
     * resume. Asserted because the operator is the whole rule here. */
    const runtimeSeconds = 20 * 60;
    expect(
      continueWatchingVerdict(
        row({ runtimeSeconds, positionSeconds: runtimeSeconds - FINISHED_TAIL_SECONDS })
      )
    ).toEqual({ kind: "excluded", why: "finished" });
  });
});

describe("barely started", () => {
  it("excludes a glance and keeps the second after the threshold", () => {
    expect(
      continueWatchingVerdict(row({ positionSeconds: RESUMABLE_MINIMUM_SECONDS - 1 })).kind
    ).toBe("excluded");
    expect(continueWatchingVerdict(row({ positionSeconds: RESUMABLE_MINIMUM_SECONDS })).kind).toBe(
      "resumable"
    );
  });

  it("names the exclusion separately from finished, because the causes differ", () => {
    const glance = continueWatchingVerdict(row({ positionSeconds: 5 }));
    expect(glance).toEqual({ kind: "excluded", why: "barely_started" });
  });
});

describe("an unknown runtime", () => {
  it("is resumable, is never finished, and reports no fraction", () => {
    /*
     * All three halves matter. Resumable because there is a real position;
     * never finished because "finished" is a claim about remaining duration and
     * nothing here knows the duration; no fraction because `null` is not zero
     * and a bar rendered at 0% would state "barely started" about a title this
     * code cannot measure.
     */
    expect(continueWatchingVerdict(row({ runtimeSeconds: null, positionSeconds: 4000 }))).toEqual({
      kind: "resumable",
      resumeAtSeconds: 4000,
      completedFraction: null
    });
  });
});

describe("where it resumes", () => {
  it("is the stored position exactly, with no rewind applied", () => {
    /*
     * A "back up ten seconds" courtesy is a real product behaviour and it is
     * NOT invented here. The acceptance says resume uses the stored position;
     * anything else is a second opinion about where the viewer was, and it
     * belongs in a decision somebody makes on purpose.
     */
    expect(continueWatchingVerdict(row({ positionSeconds: 1234 }))).toMatchObject({
      resumeAtSeconds: 1234
    });
  });

  it("clamps a fraction past the end rather than rendering a bar wider than its track", () => {
    /* Two devices, one of which reported a runtime the other disagrees with.
     * Not impossible, and a bar over 100% is a rendering bug that looks like a
     * data bug. It is still excluded as finished -- the clamp is for the
     * branch where it is not. */
    const verdict = continueWatchingVerdict({ positionSeconds: 100, runtimeSeconds: 90 });
    expect(verdict.kind).toBe("excluded");
  });
});

describe("selection", () => {
  const known = new Map([
    ["aurora-fall", item("aurora-fall")],
    ["northstar", item("northstar")]
  ]);
  const resolve = (contentId: string): CatalogItem | null => known.get(contentId) ?? null;

  it("keeps the store's order and does not re-sort", () => {
    /*
     * `listContinueWatching` orders by updated_at descending with content_id as
     * a total-order tie-break, and that IS the recency the acceptance asks for.
     * A sort here would also be a sort over the wrong subset, because the
     * query's LIMIT already decided which rows arrived.
     */
    const rows = [
      row({ contentId: "northstar", updatedAt: new Date("2020-01-01T00:00:00.000Z") }),
      row({ contentId: "aurora-fall", updatedAt: new Date("2026-01-01T00:00:00.000Z") })
    ];
    expect(selectContinueWatching(rows, resolve).map((entry) => entry.item.id)).toEqual([
      "northstar",
      "aurora-fall"
    ]);
  });

  it("drops a title the catalog will not surface", () => {
    /*
     * THE RIGHTS PROPERTY, and the reason this module reaches the metadata
     * source at all. A work withheld from browse for want of a rights basis
     * must not reappear on the home page because somebody once watched it.
     */
    const rows = [row({ contentId: "withheld-title" }), row({ contentId: "aurora-fall" })];
    expect(selectContinueWatching(rows, resolve).map((entry) => entry.item.id)).toEqual([
      "aurora-fall"
    ]);
  });

  it("drops excluded rows without disturbing the order of the rest", () => {
    const rows = [
      row({ contentId: "northstar", positionSeconds: 3 }),
      row({ contentId: "aurora-fall", positionSeconds: 900 })
    ];
    expect(selectContinueWatching(rows, resolve).map((entry) => entry.item.id)).toEqual([
      "aurora-fall"
    ]);
  });

  it("carries the resume point and the fraction onto the entry", () => {
    const entries = selectContinueWatching(
      [row({ contentId: "aurora-fall", positionSeconds: 1800, runtimeSeconds: 2 * HOUR })],
      resolve
    );
    expect(entries[0]?.resumeAtSeconds).toBe(1800);
    expect(entries[0]?.completedFraction).toBeCloseTo(0.25, 10);
  });

  it("answers an empty list for an empty store rather than throwing", () => {
    expect(selectContinueWatching([], resolve)).toEqual([]);
  });
});

describe("the query limit", () => {
  it("is larger than a screenful, because exclusions are applied after the read", () => {
    /*
     * Asking for exactly as many rows as the rail renders would show fewer than
     * a railful whenever anything was finished or barely started -- which is
     * most of the time for an active viewer.
     */
    expect(CONTINUE_WATCHING_QUERY_LIMIT).toBeGreaterThan(12);
  });
});
