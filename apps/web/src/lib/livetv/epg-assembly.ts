/* -------------------------------------------------------------------------
 * FROM WIRE RECORDS TO A CONTRACT SCHEDULE (Wave 132, Worker E).
 *
 * `./xmltv.ts` produces wire-shaped records with no identity and no rights. This
 * module turns them into `EpgSchedule` values from
 * `@liberty/contracts/domains/live`, and the two decisions it makes are the two
 * the contract cannot make for itself.
 *
 * DECISION ONE: A LISTING'S IDENTITY, WHICH XMLTV DOES NOT GIVE IT.
 * `epgListingSchema.id` is required, and its own comment explains why: without
 * an identity a schedule cannot be deduplicated, cannot be diffed against the
 * next refresh, and has no total order. `epgScheduleSchema` additionally
 * requires ids to be DISTINCT within a schedule, which is the precondition that
 * makes `compareEpgListings` total.
 *
 * So the id is minted, and it is minted as a CONTENT HASH rather than as an
 * ordinal. That is the whole point. `${channelId}-${index}` is the obvious
 * implementation and it is an order-dependence defect wearing a feature's
 * clothes: the same feed chunked differently, or arriving in a different order,
 * mints different ids for the same broadcasts, so every cached schedule
 * mismatches and every diff reports the whole grid as changed. A hash over
 * (channel, start, stop, title) means the id is a function of the broadcast, so
 * two independent ingests of one feed agree, and two entries that hash
 * identically ARE the same entry — which is what makes dropping the second one a
 * deduplication rather than data loss.
 *
 * DECISION TWO: WHICH PROGRAMMES ARE ALLOWED INTO A SCHEDULE AT ALL, AND THIS IS
 * A RIGHTS DECISION. A programme whose channel is not among the channels we hold
 * is DROPPED with a named reason. `docs/LIVE_TV.md` is explicit that an EPG is
 * "the largest, cheapest and least-verified body of metadata in the system" and
 * that "a schedule is routinely fetched for channels we do not carry". Rights
 * travel with the channel; a listing has no field capable of expressing
 * playability; so a schedule keyed to a channel we hold no `LiveChannel` for
 * would be a grid of broadcasts with no route to a rights basis — exactly what
 * `rightsBasisForListing` refuses to answer, and exactly the thing that must not
 * reach a surface. `assembleEpgSchedules` is given `LiveChannel` values (which
 * only `./playlist-validation.ts` can mint, and only through the rights gate),
 * so holding a channel IS holding its basis.
 * ---------------------------------------------------------------------- */
import {
  epgScheduleSchema,
  rightsBasisForListing,
  sortEpgListings,
  type EpgInstant,
  type EpgListing,
  type EpgSchedule,
  type EpgWindow,
  type LiveChannel
} from "@liberty/contracts/domains/live";

import type { XmltvProgramme } from "./xmltv";

export const EPG_DROP_REASONS = [
  /** No `LiveChannel` is held for the programme's channel, so it has no rights basis. */
  "channel_not_held",
  /** A second programme hashing to an id already present: the same broadcast twice. */
  "duplicate_listing_identity",
  /** The assembled listing was refused by `epgScheduleSchema`. A bug here, reported. */
  "contract_refused",
  /** `rightsBasisForListing` refused the pair. Unreachable by construction; checked anyway. */
  "rights_basis_unavailable"
] as const;
export type EpgDropReason = (typeof EPG_DROP_REASONS)[number];

export interface DroppedProgramme {
  readonly line: number;
  readonly sourceChannelId: string;
  readonly title: string;
  readonly reason: EpgDropReason;
  readonly detail: string;
}

export interface EpgAssembly {
  /** One schedule per held channel, including channels with an empty `listings`. */
  readonly schedules: readonly EpgSchedule[];
  readonly dropped: readonly DroppedProgramme[];
}

/**
 * FNV-1a, 32-bit, written out.
 *
 * NOT A CRYPTOGRAPHIC HASH AND NOT USED AS ONE. It is a dispersal function whose
 * only job is to turn a broadcast's identifying fields into a short, stable,
 * route-safe token. It is written out rather than imported from `node:crypto`
 * for two reasons: this module is reachable from a React Server Component, where
 * a Node built-in is an unnecessary runtime constraint; and `createHash` is
 * asynchronous-adjacent API surface for a pure function. Collisions are possible
 * in principle at 32 bits; the caller's behaviour on a collision is to treat the
 * entries as duplicates, which is the correct behaviour for a true duplicate and
 * a reported drop for the astronomically unlikely false one.
 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    /* `Math.imul` keeps the multiply in 32 bits; `*` would lose precision past 2^53. */
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Digits of an instant, for a readable id. `2026-10-12T19:30:00.000Z` -> `20261012t1930`. */
function instantToIdToken(instant: EpgInstant): string {
  const compact = instant.replace(/[^0-9TZ]/g, "").toLowerCase();
  return compact.slice(0, 13);
}

/**
 * The id a broadcast gets. A function of the broadcast, never of its position.
 *
 * Shaped to satisfy `normalizedContentIdSchema` (`^[a-z0-9]+(-[a-z0-9]+)*$`) by
 * construction: the channel id already does, the timestamp token is digits and a
 * `t`, and the hash is base-36 lower case.
 */
export function mintListingId(channelId: string, programme: XmltvProgramme): string {
  const material = [
    channelId,
    programme.sourceChannelId,
    programme.startsAt,
    programme.endsAt ?? "",
    programme.title
  ].join("\u0000");
  return `${channelId}-${instantToIdToken(programme.startsAt)}-${fnv1a32(material)}`;
}

/**
 * The window a set of listings covers, from the listings themselves.
 *
 * `epgWindowSchema` requires `startsAt < endsAt` and both bounds non-nullable,
 * because a window is "a parameter WE chose" rather than a fact a feed withheld.
 * With no listings there is nothing to derive, so this returns `null` and the
 * caller must supply one — which is correct: an empty schedule still covers a
 * window somebody asked for, and inventing one from an empty set would be
 * fabricating the request.
 */
export function windowCovering(listings: readonly EpgListing[]): EpgWindow | null {
  if (listings.length === 0) return null;
  const sorted = sortEpgListings(listings);
  const first = sorted[0];
  if (first === undefined) return null;
  let latest = first.startsAt;
  for (const listing of sorted) {
    if (listing.startsAt > latest) latest = listing.startsAt;
    const end = listing.endsAt;
    if (end !== null && end > latest) latest = end;
  }
  /*
   * A single listing with no end time would make `startsAt === endsAt`, which
   * `epgWindowSchema` refuses. One second is added rather than an hour guessed:
   * the window must be non-empty and must not imply a duration nobody stated.
   */
  if (latest <= first.startsAt) {
    const nudged = new Date(Date.parse(first.startsAt) + 1000).toISOString();
    return { startsAt: first.startsAt, endsAt: nudged };
  }
  return { startsAt: first.startsAt, endsAt: latest };
}

export interface AssembleOptions {
  /** `generatedAt` for every schedule. Supplied, because this module has no clock. */
  readonly generatedAt: EpgInstant;
  /** The window that was requested. When absent, each schedule derives its own. */
  readonly window?: EpgWindow;
}

/**
 * Assemble one schedule per held channel.
 *
 * PURE and clock-free. `generatedAt` is a parameter for the reason the whole
 * scheduling layer takes an injected clock: a module that read `Date.now()`
 * could not be tested for the boundary cases that matter, and this repository
 * tests that no scheduling logic does.
 */
export function assembleEpgSchedules(
  channels: readonly LiveChannel[],
  programmes: readonly XmltvProgramme[],
  options: AssembleOptions
): EpgAssembly {
  const dropped: DroppedProgramme[] = [];
  const bySourceId = new Map<string, LiveChannel>();
  for (const channel of channels) bySourceId.set(channel.sourceChannelId, channel);

  const listingsByChannel = new Map<string, EpgListing[]>();
  const seenIds = new Map<string, Set<string>>();
  for (const channel of channels) {
    listingsByChannel.set(channel.id, []);
    seenIds.set(channel.id, new Set());
  }

  for (const programme of programmes) {
    const channel = bySourceId.get(programme.sourceChannelId);
    if (channel === undefined) {
      /*
       * THE RIGHTS DROP. Not an error, not a warning the UI might render anyway —
       * the listing does not enter any schedule. See this module's header.
       */
      dropped.push({
        line: programme.line,
        sourceChannelId: programme.sourceChannelId,
        title: programme.title,
        reason: "channel_not_held",
        detail: "no authorized channel is held for this listing, so it has no route to a rights basis"
      });
      continue;
    }

    const id = mintListingId(channel.id, programme);
    const seen = seenIds.get(channel.id);
    if (seen !== undefined && seen.has(id)) {
      dropped.push({
        line: programme.line,
        sourceChannelId: programme.sourceChannelId,
        title: programme.title,
        reason: "duplicate_listing_identity",
        detail: "a listing with identical channel, start, stop and title is already present"
      });
      continue;
    }

    const listing: EpgListing = {
      id,
      channelId: channel.id,
      startsAt: programme.startsAt,
      endsAt: programme.endsAt,
      title: programme.title,
      episodeTitle: programme.episodeTitle,
      description: programme.description,
      categories: programme.categories === null ? null : [...programme.categories],
      seasonNumber: programme.seasonNumber,
      episodeNumber: programme.episodeNumber,
      isNew: programme.isNew,
      isPreviouslyShown: programme.isPreviouslyShown
    };

    /*
     * THE CONTRACT'S OWN GATE, CALLED RATHER THAN TRUSTED. `rightsBasisForListing`
     * is the only route from a listing to a rights basis and it refuses a
     * mismatched pair. It cannot fail here — the listing's `channelId` was just
     * set from this channel — and it is called anyway, because "cannot fail" is a
     * property of three lines above that somebody will edit.
     */
    const basis = rightsBasisForListing(channel, listing);
    if (basis.basis === null) {
      dropped.push({
        line: programme.line,
        sourceChannelId: programme.sourceChannelId,
        title: programme.title,
        reason: "rights_basis_unavailable",
        detail: `the contract refused the channel/listing pair: ${basis.refusal}`
      });
      continue;
    }

    listingsByChannel.get(channel.id)?.push(listing);
    seen?.add(id);
  }

  const schedules: EpgSchedule[] = [];
  for (const channel of channels) {
    const listings = sortEpgListings(listingsByChannel.get(channel.id) ?? []);
    const window = options.window ?? windowCovering(listings);
    if (window === null) {
      /*
       * A held channel with no listings and no requested window. The schedule is
       * OMITTED rather than given a fabricated window: `epgScheduleSchema` has no
       * representation for "a window nobody asked for", and an empty `listings`
       * array is only a meaningful answer ("nothing is scheduled here") relative
       * to a window somebody chose.
       */
      continue;
    }
    const parsed = epgScheduleSchema.safeParse({
      channelId: channel.id,
      window,
      listings,
      generatedAt: options.generatedAt
    });
    if (!parsed.success) {
      for (const listing of listings) {
        dropped.push({
          line: 0,
          sourceChannelId: channel.sourceChannelId,
          title: listing.title,
          reason: "contract_refused",
          detail: `epgScheduleSchema refused this channel's schedule: ${parsed.error.issues
            .map((issue) => issue.path.join("."))
            .join(", ")}`
        });
      }
      continue;
    }
    schedules.push(parsed.data);
  }

  return { schedules, dropped };
}
