import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EPG_INSTANT_LENGTH,
  EPG_LISTING_CARRIES_NO_PLAYABILITY,
  PLAYABILITY_BEARING_KEYS,
  compareEpgListings,
  epgInstantSchema,
  epgListingSchema,
  epgScheduleSchema,
  epgWindowSchema,
  liveChannelSchema,
  readXmltvTimestamp,
  rightsBasisForListing,
  sortEpgListings,
  sortEpgSchedule,
  XMLTV_TIMESTAMP_REFUSALS,
  type EpgListing,
  type LiveChannel
} from "./live";
import { contentRightsSchema } from "../shared/rights";
import {
  MAX_LIST_LENGTH,
  contentRightsArb,
  distinctByIdArb,
  permutationKeysArb,
  permute
} from "../testing/arbitraries";

/**
 * PL-0601. The live contract's four load-bearing clauses, one describe block
 * each:
 *
 *   1. an omitted field stays unknown and is never inferred;
 *   2. a listing cannot carry playability, structurally;
 *   3. an offset-less XMLTV timestamp is refused rather than localised;
 *   4. a schedule is stable under permutation of its input.
 *
 * The generators are declared here rather than in `../testing/arbitraries`
 * because that module is shared with the media-engine and provider-sdk property
 * suites and nothing outside this file needs a live arbitrary yet. Importing
 * from it anyway is deliberate: it is what applies the PINNED fast-check seed,
 * so a counterexample found here is reproducible by anyone who runs the suite.
 */

/* -------------------------------------------------------------------------
 * Fixtures and generators.
 * ---------------------------------------------------------------------- */

const CHANNEL_ID = "bbc-one-hd";

const channel: LiveChannel = {
  id: CHANNEL_ID,
  providerId: "licensed-live-a",
  sourceChannelId: "BBCOne.uk",
  displayName: "BBC One HD",
  rights: "licensed",
  countryCode: "GB",
  languages: ["en"],
  categories: ["general"],
  logoUrl: "https://example.invalid/bbc-one.png"
};

const listing: EpgListing = {
  id: "bbc-one-hd-20260824-1930",
  channelId: CHANNEL_ID,
  startsAt: "2026-08-24T19:30:00.000Z",
  endsAt: "2026-08-24T20:00:00.000Z",
  title: "The Nine O'Clock Programme",
  episodeTitle: null,
  description: null,
  categories: null,
  seasonNumber: null,
  episodeNumber: null,
  isNew: null,
  isPreviouslyShown: null
};

/** The nullable half of a listing. Each one is a field an EPG feed omits. */
const NULLABLE_LISTING_KEYS = [
  "endsAt",
  "episodeTitle",
  "description",
  "categories",
  "seasonNumber",
  "episodeNumber",
  "isNew",
  "isPreviouslyShown"
] as const satisfies readonly (keyof EpgListing)[];

const NULLABLE_CHANNEL_KEYS = [
  "countryCode",
  "languages",
  "categories",
  "logoUrl"
] as const satisfies readonly (keyof LiveChannel)[];

/**
 * Ids from a deliberately narrow pool, for the same reason
 * `../testing/arbitraries` draws them from one: short ids collide, collisions
 * are what make the tie-break arms of `compareEpgListings` reachable, and a
 * wide pool would leave the third comparison key permanently unexercised.
 */
const normalizedIdArb: Arbitrary<string> = fc.constantFrom(
  "a",
  "b",
  "z",
  "a-1",
  "a-2",
  "b-1",
  "0",
  "9-9"
);

/**
 * Instants from a five-slot pool, for the same reason.
 *
 * With a wide range, two listings sharing a `startsAt` would essentially never
 * be generated, and the `endsAt`/`id` tiebreaks -- including the `null`-sorts-
 * last arm, which is the one nobody would agree on by accident -- would never
 * run.
 */
const instantArb: Arbitrary<string> = fc
  .integer({ min: 0, max: 4 })
  .map((slot) => new Date(Date.UTC(2026, 7, 24, 18 + slot, 0, 0)).toISOString());

const UNKNOWN_FREQ = 2;

function optional<Value>(value: Arbitrary<Value>): Arbitrary<Value | null> {
  return fc.option(value, { nil: null, freq: UNKNOWN_FREQ });
}

/** A contract-valid listing on `channelId`, with any combination of unknowns. */
function listingArb(channelId: string): Arbitrary<EpgListing> {
  return fc.record(
    {
      id: normalizedIdArb,
      channelId: fc.constant(channelId),
      startsAt: instantArb,
      endsAt: optional(instantArb),
      title: fc.constantFrom("News", "Film", "Match of the Day", "Continuity"),
      episodeTitle: optional(fc.constantFrom("Part One", "Part Two")),
      description: optional(fc.constantFrom("A programme.", "Another programme.")),
      categories: optional(fc.array(fc.constantFrom("news", "sport", "drama"), { maxLength: 2 })),
      seasonNumber: optional(fc.integer({ min: 1, max: 4 })),
      episodeNumber: optional(fc.integer({ min: 1, max: 12 })),
      isNew: optional(fc.boolean()),
      isPreviouslyShown: optional(fc.boolean())
    },
    { noNullPrototype: true }
  );
}

/**
 * `noNullPrototype: true` everywhere, matching `../testing/arbitraries`: a
 * null-prototype object stringifies as `{__proto__:null,...}` in every
 * counterexample and diff, which triples the width of the report a human reads
 * to find the one field that differed.
 */
const listingsArb: Arbitrary<EpgListing[]> = distinctByIdArb(listingArb(CHANNEL_ID), MAX_LIST_LENGTH);

const channelArb: Arbitrary<LiveChannel> = fc
  .record(
    {
      id: fc.constant(CHANNEL_ID),
      providerId: fc.constantFrom("licensed-live-a", "licensed-live-b"),
      sourceChannelId: fc.constantFrom("BBCOne.uk", "ITV1.uk"),
      displayName: fc.constantFrom("BBC One HD", "ITV1"),
      rights: contentRightsArb,
      countryCode: optional(fc.constantFrom("GB", "IE", "US")),
      languages: optional(fc.array(fc.constantFrom("en", "cy"), { maxLength: 2 })),
      categories: optional(fc.array(fc.constantFrom("general", "sport"), { maxLength: 2 })),
      logoUrl: optional(fc.constant("https://example.invalid/logo.png"))
    },
    { noNullPrototype: true }
  );

/* -------------------------------------------------------------------------
 * The meta-property. Everything below is only meaningful if this holds.
 * ---------------------------------------------------------------------- */

describe("the generators produce contract-valid live objects", () => {
  it("every generated listing and channel parses, unchanged", () => {
    fc.assert(
      fc.property(listingArb(CHANNEL_ID), channelArb, (generated, generatedChannel) => {
        const parsedListing = epgListingSchema.safeParse(generated);
        expect(parsedListing.success).toBe(true);
        // No transform, no default, no stripped field: what an adapter states is
        // exactly what a consumer reads.
        if (parsedListing.success) expect(parsedListing.data).toEqual(generated);

        const parsedChannel = liveChannelSchema.safeParse(generatedChannel);
        expect(parsedChannel.success).toBe(true);
        if (parsedChannel.success) expect(parsedChannel.data).toEqual(generatedChannel);
      })
    );
  });

  it("accepts the hand-written fixtures", () => {
    expect(liveChannelSchema.safeParse(channel).success).toBe(true);
    expect(epgListingSchema.safeParse(listing).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Clause 1: an omitted field stays unknown, and is never inferred.
 * ---------------------------------------------------------------------- */

describe("unknown is asserted, never achieved by silence", () => {
  it("accepts an explicitly null value for every nullable listing field", () => {
    for (const key of NULLABLE_LISTING_KEYS) {
      const result = epgListingSchema.safeParse({ ...listing, [key]: null });
      expect(result.success, key).toBe(true);
      if (result.success) expect(result.data[key], key).toBeNull();
    }
  });

  it("REJECTS an omitted nullable listing field, for every field", () => {
    /*
     * The whole argument for required-and-nullable. If an omitted key parsed,
     * "we do not know" and "nobody told me to send this" would arrive at every
     * read site as the same `undefined`, and unknown would be achievable by
     * silence -- including the silence of a producer written before the field
     * existed.
     */
    for (const key of NULLABLE_LISTING_KEYS) {
      const withoutField: Record<string, unknown> = { ...listing };
      expect(withoutField[key], key).not.toBeUndefined();
      delete withoutField[key];
      expect(epgListingSchema.safeParse(withoutField).success, key).toBe(false);
    }
  });

  it("REJECTS an omitted nullable channel field, for every field", () => {
    for (const key of NULLABLE_CHANNEL_KEYS) {
      const withoutField: Record<string, unknown> = { ...channel };
      expect(withoutField[key], key).not.toBeUndefined();
      delete withoutField[key];
      expect(liveChannelSchema.safeParse(withoutField).success, key).toBe(false);
    }
  });

  it("distinguishes an unreported list from a reported empty one", () => {
    const unreported = epgListingSchema.safeParse({ ...listing, categories: null });
    const reportedEmpty = epgListingSchema.safeParse({ ...listing, categories: [] });
    expect(unreported.success && reportedEmpty.success).toBe(true);
    if (!unreported.success || !reportedEmpty.success) return;
    // Collapsing these turns "we do not know how this was categorised" into
    // "it was categorised as nothing", which is a claim the feed never made.
    expect(unreported.data.categories).toBeNull();
    expect(reportedEmpty.data.categories).toEqual([]);
  });

  it("does not infer a missing end time from the next listing's start", () => {
    const openEnded: EpgListing = { ...listing, id: "open", endsAt: null };
    const next: EpgListing = {
      ...listing,
      id: "next",
      startsAt: "2026-08-24T20:00:00.000Z",
      endsAt: "2026-08-24T21:00:00.000Z"
    };

    const parsed = epgScheduleSchema.safeParse({
      channelId: CHANNEL_ID,
      window: { startsAt: "2026-08-24T19:00:00.000Z", endsAt: "2026-08-24T22:00:00.000Z" },
      listings: [openEnded, next],
      generatedAt: "2026-08-24T18:00:00.000Z"
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The obvious "fix" is to set the first entry's end to the second's start.
    // It fabricates a duration the feed never stated, and it makes the parsed
    // value depend on the order the entries were processed in.
    const sorted = sortEpgListings(parsed.data.listings);
    expect(sorted[0]?.id).toBe("open");
    expect(sorted[0]?.endsAt).toBeNull();
  });

  it("keeps a missing end time null under every permutation and every sort", () => {
    fc.assert(
      fc.property(listingsArb, permutationKeysArb, (listings, keys) => {
        const openEnded = listings.filter((entry) => entry.endsAt === null).map((entry) => entry.id);
        const sorted = sortEpgListings(permute(listings, keys));
        const stillOpen = sorted.filter((entry) => entry.endsAt === null).map((entry) => entry.id);
        expect(new Set(stillOpen)).toEqual(new Set(openEnded));
      })
    );
  });

  it("refuses a fabricated sentinel in place of unknown", () => {
    // A sentinel survives comparison and serialization without ever failing,
    // which is how a fabricated fact travels undetected. `null` is not a number
    // and not a timestamp, so nothing coerces it into one.
    expect(epgListingSchema.safeParse({ ...listing, episodeNumber: 0 }).success).toBe(false);
    expect(epgListingSchema.safeParse({ ...listing, seasonNumber: -1 }).success).toBe(false);
    expect(epgListingSchema.safeParse({ ...listing, description: "" }).success).toBe(false);
    expect(epgListingSchema.safeParse({ ...listing, endsAt: "unknown" }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Clause 2: a listing cannot carry playability.
 * ---------------------------------------------------------------------- */

describe("a listing is not an entitlement", () => {
  it("has no playability-bearing key at the type level", () => {
    // This const only exists -- and only type-checks -- while
    // `keyof EpgListing` and `PLAYABILITY_BEARING_KEYS` are disjoint. Adding
    // `rights` to the listing schema fails the BUILD, not this assertion; the
    // assertion is here so the guard is not dead code.
    expect(EPG_LISTING_CARRIES_NO_PLAYABILITY).toBe(true);
  });

  it("has no playability-bearing key at runtime, in the parsed value", () => {
    const parsed = epgListingSchema.safeParse(listing);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const key of PLAYABILITY_BEARING_KEYS) {
      expect(Object.keys(parsed.data), key).not.toContain(key);
    }
  });

  it("REJECTS a listing that arrives carrying one, rather than stripping it", () => {
    /*
     * `.strict()` is what makes this a rejection. Zod's default is to strip an
     * unknown key, so without it a feed sending `rights: "licensed"` would parse
     * cleanly, lose the field, and leave nobody aware that a listings source had
     * just tried to make a rights claim.
     */
    for (const key of PLAYABILITY_BEARING_KEYS) {
      const smuggled = { ...listing, [key]: "licensed" };
      expect(epgListingSchema.safeParse(smuggled).success, key).toBe(false);
    }
  });

  it("rejects them inside a schedule too, not just standalone", () => {
    const result = epgScheduleSchema.safeParse({
      channelId: CHANNEL_ID,
      window: { startsAt: "2026-08-24T19:00:00.000Z", endsAt: "2026-08-24T22:00:00.000Z" },
      listings: [{ ...listing, streamUrl: "https://example.invalid/live.m3u8" }],
      generatedAt: "2026-08-24T18:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("resolves a rights basis only through the channel", () => {
    const resolved = rightsBasisForListing(channel, listing);
    expect(resolved.basis).toBe(channel.rights);
    expect(contentRightsSchema.safeParse(resolved.basis).success).toBe(true);
  });

  it("refuses, distinguishably, for a listing belonging to another channel", () => {
    const foreign = rightsBasisForListing(channel, { ...listing, channelId: "some-other-channel" });
    expect(foreign.basis).toBeNull();
    // A refusal, not "this listing has no rights" -- the two have different
    // remedies and only one of them is a bug at the call site.
    expect(foreign).toHaveProperty("refusal", "listing_belongs_to_another_channel");
  });

  it("derives the basis from the channel ALONE, whatever the listing says", () => {
    fc.assert(
      fc.property(channelArb, listingArb(CHANNEL_ID), (generatedChannel, generatedListing) => {
        const resolved = rightsBasisForListing(generatedChannel, generatedListing);
        // The statement of "rights travel with the channel": no field of the
        // listing can move this answer, because none of them is consulted.
        expect(resolved.basis).toBe(generatedChannel.rights);
      })
    );
  });

  it("cannot be given a schedule that mixes channels", () => {
    // Otherwise a listing could be read against the wrong channel's rights by a
    // caller that pairs them by position.
    const result = epgScheduleSchema.safeParse({
      channelId: CHANNEL_ID,
      window: { startsAt: "2026-08-24T19:00:00.000Z", endsAt: "2026-08-24T22:00:00.000Z" },
      listings: [listing, { ...listing, id: "other", channelId: "another-channel" }],
      generatedAt: "2026-08-24T18:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("requires a channel to state a rights basis at all", () => {
    const { rights, ...withoutRights } = channel;
    expect(rights).toBe("licensed");
    expect(liveChannelSchema.safeParse(withoutRights).success).toBe(false);
    expect(liveChannelSchema.safeParse({ ...channel, rights: null }).success).toBe(false);
    expect(liveChannelSchema.safeParse({ ...channel, rights: "unlicensed" }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Clause 3: an offset-less timestamp is refused, never localised.
 * ---------------------------------------------------------------------- */

describe("XMLTV timestamps", () => {
  it("REFUSES an offset-less timestamp with a reason of its own", () => {
    const reading = readXmltvTimestamp("20260824193000");
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    // Not `malformed_timestamp`: the syntax is fine and the feed is the thing
    // to chase. Merging the two verdicts merges two different remedies.
    expect(reading.refusal).toBe("missing_offset");
  });

  it("refuses it however the ingest was run", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("20260824193000", "202608241930", "19700101000000", "20260101000000"),
        (offsetless) => {
          const reading = readXmltvTimestamp(offsetless);
          expect(reading.ok).toBe(false);
          if (!reading.ok) expect(reading.refusal).toBe("missing_offset");
        }
      )
    );
  });

  it("names every refusal it can return, and no others", () => {
    // A closed vocabulary rather than an error message, for the reason
    // `./failover` gives: an ingest that branches on provider-authored free
    // text is one reword away from silently changing behaviour.
    expect([...XMLTV_TIMESTAMP_REFUSALS]).toEqual([
      "missing_offset",
      "malformed_timestamp",
      "impossible_calendar_date"
    ]);
  });

  it("normalises a stated offset to UTC", () => {
    const reading = readXmltvTimestamp("20260824193000 +0100");
    expect(reading).toEqual({ ok: true, instant: "2026-08-24T18:30:00.000Z" });
  });

  it("handles a negative and a half-hour offset, and a day rollover", () => {
    expect(readXmltvTimestamp("20260824193000 -0430")).toEqual({
      ok: true,
      instant: "2026-08-25T00:00:00.000Z"
    });
    expect(readXmltvTimestamp("20260824193000 +0530")).toEqual({
      ok: true,
      instant: "2026-08-24T14:00:00.000Z"
    });
  });

  it("treats omitted seconds as zero, which the grammar makes unambiguous", () => {
    expect(readXmltvTimestamp("202608241930 +0000")).toEqual({
      ok: true,
      instant: "2026-08-24T19:30:00.000Z"
    });
  });

  it("collapses two spellings of the same moment onto one instant", () => {
    // Proof the normalisation is real rather than a re-formatting.
    const withOffset = readXmltvTimestamp("20260824193000 +0100");
    const asUtc = readXmltvTimestamp("20260824183000 +0000");
    expect(withOffset).toEqual(asUtc);
  });

  it("refuses malformed syntax and impossible dates separately", () => {
    for (const malformed of ["", "yesterday", "2026-08-24T19:30:00Z", "20260824193000+0100"]) {
      const reading = readXmltvTimestamp(malformed);
      expect(reading.ok, malformed).toBe(false);
      if (!reading.ok) expect(reading.refusal, malformed).toBe("malformed_timestamp");
    }

    for (const impossible of ["20260230120000 +0000", "20261324120000 +0000", "00991224120000 +0000"]) {
      const reading = readXmltvTimestamp(impossible);
      expect(reading.ok, impossible).toBe(false);
      // Including the two-digit-year trap: `Date.UTC(99, ...)` is 1999, and
      // without the round-trip check it would produce a plausible instant.
      if (!reading.ok) expect(reading.refusal, impossible).toBe("impossible_calendar_date");
    }
  });

  it("refuses an offset no real zone uses", () => {
    for (const outOfRange of ["20260824193000 +1500", "20260824193000 -1500", "20260824193000 +0160"]) {
      const reading = readXmltvTimestamp(outOfRange);
      expect(reading.ok, outOfRange).toBe(false);
      if (!reading.ok) expect(reading.refusal, outOfRange).toBe("malformed_timestamp");
    }
    expect(readXmltvTimestamp("20260824193000 +1400").ok).toBe(true);
  });

  it("emits only values the instant schema accepts, at fixed width", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.constantFrom("+0000", "+0100", "-0500", "+0530", "-1100", "+1400"),
        (year, month, day, hour, minute, offset) => {
          const pad = (value: number, width = 2) => String(value).padStart(width, "0");
          const raw = `${pad(year, 4)}${pad(month)}${pad(day)}${pad(hour)}${pad(minute)}00 ${offset}`;
          const reading = readXmltvTimestamp(raw);
          expect(reading.ok).toBe(true);
          if (!reading.ok) return;
          expect(epgInstantSchema.safeParse(reading.instant).success).toBe(true);
          expect(reading.instant).toHaveLength(EPG_INSTANT_LENGTH);
        }
      )
    );
  });
});

describe("the instant representation", () => {
  it("accepts only a UTC instant with exactly three fractional digits", () => {
    expect(epgInstantSchema.safeParse("2026-08-24T19:30:00.000Z").success).toBe(true);
    // An offset is ambiguity we already refused upstream; a variable-precision
    // instant breaks the fixed width the total order depends on.
    expect(epgInstantSchema.safeParse("2026-08-24T19:30:00+01:00").success).toBe(false);
    expect(epgInstantSchema.safeParse("2026-08-24T19:30:00Z").success).toBe(false);
    expect(epgInstantSchema.safeParse("2026-08-24T19:30:00.5Z").success).toBe(false);
    expect(epgInstantSchema.safeParse("2026-08-24 19:30:00.000Z").success).toBe(false);
  });

  it("orders by code point exactly as it orders by clock", () => {
    // The property the whole comparator rests on. It holds only because the
    // width is fixed.
    fc.assert(
      fc.property(instantArb, instantArb, (left, right) => {
        expect(left).toHaveLength(EPG_INSTANT_LENGTH);
        expect(left < right).toBe(Date.parse(left) < Date.parse(right));
      })
    );
  });

  it("requires a window to end after it starts", () => {
    expect(
      epgWindowSchema.safeParse({
        startsAt: "2026-08-24T22:00:00.000Z",
        endsAt: "2026-08-24T19:00:00.000Z"
      }).success
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Clause 4: determinism.
 * ---------------------------------------------------------------------- */

describe("a schedule is a function of its contents, not of its arrival order", () => {
  it("sorts identically under any permutation of the input", () => {
    fc.assert(
      fc.property(listingsArb, permutationKeysArb, (listings, keys) => {
        expect(sortEpgListings(permute(listings, keys))).toEqual(sortEpgListings(listings));
      })
    );
  });

  it("sorts identically under reversal", () => {
    // Beside the permutation property on purpose: identity IS a permutation,
    // so this stops the suite depending on the generator happening to produce a
    // non-trivial reordering.
    fc.assert(
      fc.property(listingsArb, (listings) => {
        expect(sortEpgListings([...listings].reverse())).toEqual(sortEpgListings(listings));
      })
    );
  });

  it("does not mutate its input", () => {
    fc.assert(
      fc.property(listingsArb, (listings) => {
        const before = [...listings];
        sortEpgListings(listings);
        expect(listings).toEqual(before);
      })
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(listingsArb, (listings) => {
        const once = sortEpgListings(listings);
        expect(sortEpgListings(once)).toEqual(once);
      })
    );
  });

  it("compares to zero only for the same listing id", () => {
    // Totality, stated directly: with distinct ids no two entries are
    // incomparable, so `Array.prototype.sort` never gets to decide anything.
    fc.assert(
      fc.property(listingArb(CHANNEL_ID), listingArb(CHANNEL_ID), (left, right) => {
        if (compareEpgListings(left, right) === 0) expect(left.id).toBe(right.id);
      })
    );
  });

  it("is antisymmetric", () => {
    fc.assert(
      fc.property(listingArb(CHANNEL_ID), listingArb(CHANNEL_ID), (left, right) => {
        /*
         * SIGNED ZERO. At a tie both calls return `0`, and `-Math.sign(0)` is
         * `-0`, which `Object.is` -- and therefore `toBe` -- reports as unequal
         * to `+0`. `| 0` maps `-0` to `+0` and leaves `1` and `-1` alone, so a
         * tie passes while `1` vs `1` (the real antisymmetry violation) still
         * fails. Do not "simplify" this back to bare `Math.sign`: ties are
         * reachable here on purpose, because `listingArb` draws ids from a
         * small pool so that two generated listings CAN be the same listing.
         */
        expect(Math.sign(compareEpgListings(left, right)) | 0).toBe(
          -Math.sign(compareEpgListings(right, left)) | 0
        );
      })
    );
  });

  it("is transitive", () => {
    fc.assert(
      fc.property(
        listingArb(CHANNEL_ID),
        listingArb(CHANNEL_ID),
        listingArb(CHANNEL_ID),
        (first, second, third) => {
          if (compareEpgListings(first, second) <= 0 && compareEpgListings(second, third) <= 0) {
            expect(compareEpgListings(first, third)).toBeLessThanOrEqual(0);
          }
        }
      )
    );
  });

  it("sorts a null end time last among listings that share a start", () => {
    // The one arm of the comparator nobody would agree on by accident, so it is
    // pinned by example as well as generated.
    const shared = "2026-08-24T19:30:00.000Z";
    const open: EpgListing = { ...listing, id: "a", startsAt: shared, endsAt: null };
    const closed: EpgListing = { ...listing, id: "b", startsAt: shared, endsAt: shared };
    expect(sortEpgListings([open, closed]).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(sortEpgListings([closed, open]).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("requires listing ids to be distinct within a schedule", () => {
    // The precondition that makes the order total. Without it the properties
    // above are claims the contract cannot keep.
    const result = epgScheduleSchema.safeParse({
      channelId: CHANNEL_ID,
      window: { startsAt: "2026-08-24T19:00:00.000Z", endsAt: "2026-08-24T22:00:00.000Z" },
      listings: [listing, { ...listing, title: "A different programme" }],
      generatedAt: "2026-08-24T18:00:00.000Z"
    });
    expect(result.success).toBe(false);
  });

  it("applies the same order through sortEpgSchedule, and changes nothing else", () => {
    fc.assert(
      fc.property(listingsArb, permutationKeysArb, (listings, keys) => {
        const schedule = {
          channelId: CHANNEL_ID,
          window: {
            startsAt: "2026-08-24T00:00:00.000Z",
            endsAt: "2026-08-25T00:00:00.000Z"
          },
          listings: permute(listings, keys),
          generatedAt: "2026-08-24T18:00:00.000Z"
        };
        const parsed = epgScheduleSchema.safeParse(schedule);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        const sorted = sortEpgSchedule(parsed.data);
        // One implementation of the rule, reachable from the schedule -- so a
        // grid, a route handler and a cache cannot each sort differently.
        expect(sorted.listings).toEqual(sortEpgListings(listings));
        expect({ ...sorted, listings: [] }).toEqual({ ...parsed.data, listings: [] });
      })
    );
  });

  it("accepts an empty schedule, which means nothing is on", () => {
    // A real answer, distinct from a failed fetch. A failure is never an empty
    // body.
    const result = epgScheduleSchema.safeParse({
      channelId: CHANNEL_ID,
      window: { startsAt: "2026-08-24T19:00:00.000Z", endsAt: "2026-08-24T22:00:00.000Z" },
      listings: [],
      generatedAt: "2026-08-24T18:00:00.000Z"
    });
    expect(result.success).toBe(true);
  });
});
