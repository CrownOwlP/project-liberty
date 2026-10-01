/* The first-paint read, and the one thing it must never do: turn "we could not
 * find out" into "not on your list" (PW-0304). */
import { describe, expect, it } from "vitest";

import { snapshotFromBody } from "./watchlist-source";

describe("reading a listed envelope", () => {
  it("returns the content ids in order", () => {
    expect(
      snapshotFromBody({
        outcome: "listed",
        reasons: [{ code: "watchlist_listed", detail: "d" }],
        entries: [
          { contentId: "tt-2", addedAt: "2026-01-02T00:00:00.000Z" },
          { contentId: "tt-1", addedAt: "2026-01-01T00:00:00.000Z" }
        ]
      })
    ).toEqual(["tt-2", "tt-1"]);
  });

  it("returns an EMPTY list for an empty list, which is a real answer", () => {
    expect(snapshotFromBody({ outcome: "listed", entries: [] })).toEqual([]);
  });

  it("returns UNKNOWN, not empty, for every answer that is not a list", () => {
    /* The distinction this file exists for. A signed-out viewer, an
     * unconfigured deployment and a dropped socket all land here, and rendering
     * any of them as an empty list would put an Add button in front of someone
     * whose list already holds the title. */
    for (const body of [
      null,
      undefined,
      42,
      "listed",
      [],
      {},
      { outcome: "refused", reasons: [{ code: "not_authenticated", detail: "d" }] },
      { outcome: "unavailable" },
      { outcome: "listed" },
      { outcome: "listed", entries: "none" },
      { outcome: "listed", entries: [{ addedAt: "2026-01-01T00:00:00.000Z" }] },
      { outcome: "listed", entries: [{ contentId: "" }] },
      { outcome: "listed", entries: [{ contentId: 7 }] }
    ]) {
      expect(snapshotFromBody(body), JSON.stringify(body ?? null)).toBeNull();
    }
  });

  it("refuses the whole page rather than silently dropping a malformed row", () => {
    /* Returning the good rows would answer "off-list" for the bad one, which is
     * the same lie in a smaller place. */
    expect(
      snapshotFromBody({
        outcome: "listed",
        entries: [{ contentId: "tt-1" }, { contentId: null }]
      })
    ).toBeNull();
  });
});
