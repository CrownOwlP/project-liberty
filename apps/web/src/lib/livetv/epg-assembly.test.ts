/* -------------------------------------------------------------------------
 * Assembly: listing identity is a function of the broadcast, and a listing for
 * a channel we do not hold enters no schedule (Wave 132, Worker E).
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import { epgScheduleSchema, type LiveChannel } from "@liberty/contracts/domains/live";

import { assembleEpgSchedules, mintListingId, windowCovering } from "./epg-assembly";
import { parseM3u } from "./m3u";
import { admitPlaylistChannels, type LiveFeedAuthorization } from "./playlist-validation";
import { readLiveTvFixture } from "./testing/fixtures";
import { parseXmltv, type XmltvProgramme } from "./xmltv";

const GENERATED_AT = "2026-10-12T18:00:00.000Z";

const AUTHORIZATION: LiveFeedAuthorization = {
  providerId: "synthetic-test-provider",
  declaredOrigins: ["edge.example.invalid"],
  channelRights: {
    "aurora.news.example": "licensed",
    "meridian.sport.example": "licensed",
    "polaris.docs.example": "public-domain",
    "harbour.local.example": "owned"
  }
};

function heldChannels(): readonly LiveChannel[] {
  return admitPlaylistChannels(parseM3u(readLiveTvFixture("authorized-synthetic.m3u")), AUTHORIZATION)
    .channels;
}

function programmes(): readonly XmltvProgramme[] {
  const parsed = parseXmltv(readLiveTvFixture("synthetic-epg.xml"));
  if (!parsed.ok) throw new Error(`fixture refused: ${parsed.refusal}`);
  return parsed.document.programmes;
}

function programme(overrides: Partial<XmltvProgramme> & { sourceChannelId: string; startsAt: string }): XmltvProgramme {
  return {
    sourceChannelId: overrides.sourceChannelId,
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt ?? null,
    title: overrides.title ?? "Title",
    episodeTitle: overrides.episodeTitle ?? null,
    description: overrides.description ?? null,
    categories: overrides.categories ?? null,
    seasonNumber: overrides.seasonNumber ?? null,
    episodeNumber: overrides.episodeNumber ?? null,
    isNew: overrides.isNew ?? null,
    isPreviouslyShown: overrides.isPreviouslyShown ?? null,
    line: overrides.line ?? 1
  };
}

describe("listing identity", () => {
  it("is a function of the broadcast, not of its position in the document", () => {
    /*
     * THE DEFECT THIS REPLACES: `${channelId}-${index}`. The same feed chunked
     * differently mints different ids for the same broadcasts, every cached
     * schedule mismatches, and every diff reports the whole grid as changed.
     */
    const one = programme({ sourceChannelId: "aurora.news.example", startsAt: "2026-10-12T19:00:00.000Z", title: "A" });
    expect(mintListingId("aurora-news", one)).toBe(mintListingId("aurora-news", { ...one, line: 999 }));
  });

  it("differs when any identifying field differs", () => {
    const base = programme({ sourceChannelId: "a.example", startsAt: "2026-10-12T19:00:00.000Z", title: "A" });
    const id = mintListingId("aurora-news", base);
    expect(mintListingId("aurora-news", { ...base, title: "B" })).not.toBe(id);
    expect(mintListingId("aurora-news", { ...base, startsAt: "2026-10-12T19:30:00.000Z" })).not.toBe(id);
    expect(mintListingId("aurora-news", { ...base, endsAt: "2026-10-12T20:00:00.000Z" })).not.toBe(id);
    expect(mintListingId("meridian", base)).not.toBe(id);
  });

  it("is a normalized content id, so it can be interpolated into a route", () => {
    const id = mintListingId("aurora-news", programme({ sourceChannelId: "A.Example", startsAt: "2026-10-12T19:00:00.000Z" }));
    expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("the rights drop", () => {
  it("puts a listing for a channel we do not hold into no schedule at all", () => {
    const assembly = assembleEpgSchedules(heldChannels(), programmes(), { generatedAt: GENERATED_AT });
    const orphanTitles = assembly.dropped
      .filter((drop) => drop.reason === "channel_not_held")
      .map((drop) => drop.title);
    expect(orphanTitles).toContain("Programme For A Channel Nobody Declared");
    for (const schedule of assembly.schedules) {
      for (const listing of schedule.listings) {
        expect(listing.title).not.toBe("Programme For A Channel Nobody Declared");
      }
    }
  });

  it("holds nothing at all when no channel is held", () => {
    const assembly = assembleEpgSchedules([], programmes(), { generatedAt: GENERATED_AT });
    expect(assembly.schedules).toEqual([]);
    expect(assembly.dropped.length).toBe(programmes().length);
    for (const drop of assembly.dropped) expect(drop.reason).toBe("channel_not_held");
  });

  it("drops a second listing identical to one already present", () => {
    const channels = heldChannels();
    const duplicate = programme({
      sourceChannelId: "aurora.news.example",
      startsAt: "2026-10-12T19:00:00.000Z",
      endsAt: "2026-10-12T20:00:00.000Z",
      title: "Twice"
    });
    const assembly = assembleEpgSchedules(channels, [duplicate, { ...duplicate, line: 50 }], {
      generatedAt: GENERATED_AT
    });
    expect(assembly.schedules[0]?.listings).toHaveLength(1);
    expect(assembly.dropped.map((drop) => drop.reason)).toContain("duplicate_listing_identity");
  });
});

describe("the schedules it produces satisfy the contract", () => {
  const assembly = assembleEpgSchedules(heldChannels(), programmes(), { generatedAt: GENERATED_AT });

  it("re-parses every schedule through epgScheduleSchema", () => {
    expect(assembly.schedules.length).toBeGreaterThan(0);
    for (const schedule of assembly.schedules) {
      expect(epgScheduleSchema.safeParse(schedule).success, schedule.channelId).toBe(true);
    }
  });

  it("keeps each schedule to its own channel and keeps listing ids distinct", () => {
    for (const schedule of assembly.schedules) {
      const ids = new Set<string>();
      for (const listing of schedule.listings) {
        expect(listing.channelId).toBe(schedule.channelId);
        expect(ids.has(listing.id)).toBe(false);
        ids.add(listing.id);
      }
    }
  });

  it("keeps the overlapping regatta coverage, because real grids overlap", () => {
    const meridian = assembly.schedules.find((schedule) => schedule.channelId === "meridian-sport-example");
    expect(meridian?.listings.map((listing) => listing.title)).toContain("Meridian Regatta Overlap Coverage");
    expect(meridian?.listings.map((listing) => listing.title)).toContain("Meridian Harbour Regatta");
  });

  it("keeps a null end time rather than inferring one from the next start", () => {
    const meridian = assembly.schedules.find((schedule) => schedule.channelId === "meridian-sport-example");
    const open = meridian?.listings.find((listing) => listing.title === "Meridian Late Highlights");
    expect(open?.endsAt).toBeNull();
  });

  it("omits a held channel with no listings rather than fabricating a window for it", () => {
    /* `polaris` and `harbour` have no programmes in the fixture. */
    expect(assembly.schedules.map((schedule) => schedule.channelId)).toEqual([
      "aurora-news-example",
      "meridian-sport-example"
    ]);
  });

  it("produces an empty-listings schedule when a window is supplied", () => {
    const withWindow = assembleEpgSchedules(heldChannels(), [], {
      generatedAt: GENERATED_AT,
      window: { startsAt: "2026-10-12T18:00:00.000Z", endsAt: "2026-10-13T06:00:00.000Z" }
    });
    expect(withWindow.schedules).toHaveLength(4);
    for (const schedule of withWindow.schedules) expect(schedule.listings).toEqual([]);
  });

  it("is invariant under permutation of the programme list", () => {
    const reversed = assembleEpgSchedules(heldChannels(), [...programmes()].reverse(), {
      generatedAt: GENERATED_AT
    });
    expect(JSON.stringify(reversed.schedules)).toBe(JSON.stringify(assembly.schedules));
  });
});

describe("the derived window", () => {
  it("spans the earliest start to the latest end", () => {
    const assembly = assembleEpgSchedules(heldChannels(), programmes(), { generatedAt: GENERATED_AT });
    const aurora = assembly.schedules.find((schedule) => schedule.channelId === "aurora-news-example");
    expect(aurora?.window.startsAt).toBe("2026-03-08T06:30:00.000Z");
    /* The latest end is the midnight-crossing Night Desk, which ends on the 13th. */
    expect(aurora?.window.endsAt).toBe("2026-10-13T00:30:00.000Z");
  });

  it("returns null for an empty set rather than inventing a request", () => {
    expect(windowCovering([])).toBeNull();
  });

  it("nudges rather than guessing a duration for a single open-ended listing", () => {
    const assembly = assembleEpgSchedules(
      heldChannels(),
      [programme({ sourceChannelId: "aurora.news.example", startsAt: "2026-10-12T19:00:00.000Z" })],
      { generatedAt: GENERATED_AT }
    );
    const aurora = assembly.schedules[0];
    expect(aurora?.window.startsAt).toBe("2026-10-12T19:00:00.000Z");
    expect(aurora?.window.endsAt).toBe("2026-10-12T19:00:01.000Z");
  });
});
