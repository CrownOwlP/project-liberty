/* -------------------------------------------------------------------------
 * Channel organisation: the order is total, and it is not the machine's
 * (Wave 132, Worker E).
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import type { LiveChannel } from "@liberty/contracts/domains/live";

import {
  NO_FAVOURITES,
  UNGROUPED_KEY,
  UNGROUPED_LABEL,
  channelGroupKey,
  channelGroupKeys,
  compareLiveChannels,
  favouriteChannels,
  favouritesFirst,
  filterChannelsByGroup,
  groupLiveChannels,
  isFavouriteChannel,
  searchLiveChannels,
  sortLiveChannels,
  toggleFavouriteChannel
} from "./channels";
import { sourceWithoutComments } from "./testing/fixtures";

function channel(overrides: Partial<LiveChannel> & { id: string }): LiveChannel {
  return {
    id: overrides.id,
    providerId: overrides.providerId ?? "synthetic-provider",
    sourceChannelId: overrides.sourceChannelId ?? `${overrides.id}.example`,
    displayName: overrides.displayName ?? overrides.id,
    rights: overrides.rights ?? "licensed",
    countryCode: overrides.countryCode ?? null,
    languages: overrides.languages ?? null,
    categories: overrides.categories ?? null,
    logoUrl: overrides.logoUrl ?? null
  };
}

const news = (id: string, displayName: string): LiveChannel =>
  channel({ id, displayName, categories: ["News"] });
const sport = (id: string, displayName: string): LiveChannel =>
  channel({ id, displayName, categories: ["Sport"] });

describe("the order is total and locale-independent", () => {
  it("never calls localeCompare", () => {
    /* The single most likely regression in this file, and the one that would
     * make the order a function of the runner's ICU data. */
    const source = sourceWithoutComments(new URL("./channels.ts", import.meta.url));
    expect(source).not.toContain("localeCompare");
    expect(source).not.toContain("Intl.Collator");
  });

  it("sorts by group, then name, then source id, then id", () => {
    const left = channel({ id: "a", displayName: "Same", sourceChannelId: "a.example", categories: ["News"] });
    const right = channel({ id: "b", displayName: "Same", sourceChannelId: "b.example", categories: ["News"] });
    expect(compareLiveChannels(left, right)).toBeLessThan(0);
    expect(compareLiveChannels(right, left)).toBeGreaterThan(0);
    expect(compareLiveChannels(left, left)).toBe(0);
  });

  it("breaks a full tie on id, which is what makes the order total", () => {
    const left = channel({ id: "aaa", displayName: "Same", sourceChannelId: "same.example", categories: ["News"] });
    const right = channel({ id: "bbb", displayName: "Same", sourceChannelId: "same.example", categories: ["News"] });
    expect(compareLiveChannels(left, right)).toBeLessThan(0);
  });

  it("is invariant under permutation of its input", () => {
    /*
     * THE PROPERTY THAT MATTERS. Three shuffles of the same set must sort to the
     * same array element for element; a non-total comparator passes a single
     * sorted-input test and fails this one.
     */
    const set = [
      news("alpha", "Aurora News"),
      news("beta", "Aurora News"),
      sport("gamma", "Meridian Sport"),
      channel({ id: "delta", displayName: "Unfiled" }),
      channel({ id: "epsilon", displayName: "Unfiled", categories: [] })
    ];
    const reference = sortLiveChannels(set).map((item) => item.id);
    for (const permutation of [
      [...set].reverse(),
      [set[2]!, set[0]!, set[4]!, set[1]!, set[3]!],
      [set[4]!, set[3]!, set[1]!, set[2]!, set[0]!]
    ]) {
      expect(sortLiveChannels(permutation).map((item) => item.id)).toEqual(reference);
    }
  });

  it("does not mutate its input", () => {
    const set = [sport("z", "Z"), news("a", "A")];
    const snapshot = set.map((item) => item.id);
    sortLiveChannels(set);
    expect(set.map((item) => item.id)).toEqual(snapshot);
  });

  it("puts ungrouped channels last rather than sorting the sentinel as a name", () => {
    const sorted = sortLiveChannels([
      channel({ id: "unfiled", displayName: "Unfiled" }),
      news("alpha", "Aurora"),
      sport("beta", "Meridian")
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["alpha", "beta", "unfiled"]);
  });
});

describe("groups", () => {
  it("reads the group from the first category, treating null and [] as ungrouped", () => {
    expect(channelGroupKey(news("a", "A"))).toBe("News");
    expect(channelGroupKey(channel({ id: "b", displayName: "B" }))).toBe(UNGROUPED_KEY);
    expect(channelGroupKey(channel({ id: "c", displayName: "C", categories: [] }))).toBe(UNGROUPED_KEY);
    expect(channelGroupKey(channel({ id: "d", displayName: "D", categories: ["   "] }))).toBe(UNGROUPED_KEY);
  });

  it("buckets channels with the ungrouped bucket labelled and last", () => {
    const groups = groupLiveChannels([
      channel({ id: "unfiled", displayName: "Unfiled" }),
      news("alpha", "Aurora"),
      news("beta", "Borealis"),
      sport("gamma", "Meridian")
    ]);
    expect(groups.map((group) => group.key)).toEqual(["News", "Sport", UNGROUPED_KEY]);
    expect(groups[2]?.label).toBe(UNGROUPED_LABEL);
    expect(groups[0]?.channels.map((item) => item.id)).toEqual(["alpha", "beta"]);
  });

  it("filters to one group, and null means every group", () => {
    const set = [news("alpha", "Aurora"), sport("beta", "Meridian")];
    expect(filterChannelsByGroup(set, "News").map((item) => item.id)).toEqual(["alpha"]);
    expect(filterChannelsByGroup(set, null)).toHaveLength(2);
    expect(filterChannelsByGroup(set, "Nothing")).toEqual([]);
    expect(channelGroupKeys(set)).toEqual(["News", "Sport"]);
  });
});

describe("search", () => {
  const set = [
    news("alpha", "Aurora News One"),
    sport("beta", "Meridian Sport"),
    channel({ id: "gamma", displayName: "Polaris Docs", sourceChannelId: "polaris.docs.example", categories: ["Documentary"] })
  ];

  it("matches display name, source id and group, case-insensitively", () => {
    expect(searchLiveChannels(set, "aurora").map((item) => item.id)).toEqual(["alpha"]);
    expect(searchLiveChannels(set, "POLARIS.DOCS").map((item) => item.id)).toEqual(["gamma"]);
    expect(searchLiveChannels(set, "sport").map((item) => item.id)).toEqual(["beta"]);
  });

  it("returns everything for an empty or whitespace query", () => {
    expect(searchLiveChannels(set, "")).toHaveLength(3);
    expect(searchLiveChannels(set, "   ")).toHaveLength(3);
  });

  it("returns nothing, rather than everything, for a query that matches nothing", () => {
    expect(searchLiveChannels(set, "zzz")).toEqual([]);
  });

  it("uses locale-independent case folding", () => {
    /* `"INFO".toLocaleLowerCase()` is `"ınfo"` in a Turkish locale, which would
     * make this channel unfindable by the obvious query on that machine. */
    const info = [channel({ id: "info", displayName: "INFO Channel" })];
    expect(searchLiveChannels(info, "info").map((item) => item.id)).toEqual(["info"]);
  });
});

describe("favourites", () => {
  it("starts empty and toggles in both directions without mutating", () => {
    expect(NO_FAVOURITES).toEqual([]);
    const once = toggleFavouriteChannel(NO_FAVOURITES, "alpha");
    expect(once).toEqual(["alpha"]);
    expect(NO_FAVOURITES).toEqual([]);
    expect(isFavouriteChannel(once, "alpha")).toBe(true);
    const off = toggleFavouriteChannel(once, "alpha");
    expect(off).toEqual([]);
    expect(once).toEqual(["alpha"]);
  });

  it("keeps the stored value sorted, so two sessions produce the same bytes", () => {
    const a = toggleFavouriteChannel(toggleFavouriteChannel(NO_FAVOURITES, "zeta"), "alpha");
    const b = toggleFavouriteChannel(toggleFavouriteChannel(NO_FAVOURITES, "alpha"), "zeta");
    expect(a).toEqual(b);
    expect(a).toEqual(["alpha", "zeta"]);
  });

  it("ignores an empty id rather than storing one", () => {
    expect(toggleFavouriteChannel(NO_FAVOURITES, "   ")).toEqual([]);
  });

  it("narrows a favourite for a channel the feed no longer carries, without deleting it", () => {
    const stored = ["alpha", "vanished"];
    const held = [news("alpha", "Aurora")];
    expect(favouriteChannels(held, stored).map((item) => item.id)).toEqual(["alpha"]);
    /* The stored value is untouched: the channel may come back next refresh. */
    expect(stored).toEqual(["alpha", "vanished"]);
  });

  it("puts favourites first with each half in the one order", () => {
    const set = [news("alpha", "Aurora"), news("beta", "Borealis"), sport("gamma", "Meridian")];
    expect(favouritesFirst(set, ["gamma"]).map((item) => item.id)).toEqual(["gamma", "alpha", "beta"]);
    /* With no favourites it is exactly the base order, so the surface can decline. */
    expect(favouritesFirst(set, NO_FAVOURITES).map((item) => item.id)).toEqual(
      sortLiveChannels(set).map((item) => item.id)
    );
  });
});
