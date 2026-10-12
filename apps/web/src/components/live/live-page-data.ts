/* -------------------------------------------------------------------------
 * THE LIVE TV SURFACE'S VIEW MODEL — ALL OF ITS LOGIC, IN A PURE .ts MODULE
 * (Wave 132, Worker E).
 *
 * WHY THIS FILE EXISTS AT ALL, AND IT IS A TESTING CONSTRAINT WITH A DESIGN
 * CONSEQUENCE. `apps/web/vitest.config.ts` sets `environment: "node"`: there is
 * no DOM, no jsdom and no app-router context in this repository's test run, so a
 * component cannot be rendered in a test (`lib/routes.ts` says the same thing
 * about its own placement). The consequence is that every decision worth
 * asserting has to live somewhere a node test can reach. So it all lives here —
 * the feed resolution, the parse, the rights gate, the grouping, the search, the
 * favourites, the now/next and the wording selection — and `live-surface.tsx`
 * is a function from this value to JSX with no branch in it that this file did
 * not already decide.
 *
 * THE INVARIANT THIS FILE IS ACCOUNTABLE FOR, AND IT IS THE WHOLE POINT OF THE
 * WORKER: **the surface renders the rights gate's real verdict.** Not a demo
 * grid, not the synthetic fixtures, not an optimistic "coming soon" with channel
 * art. In the shipped configuration `resolveLiveFeed()` answers
 * `not-configured`, this function returns the `unconfigured` state, and the
 * screen says plainly that no licensed live feed is configured. There is no
 * branch below in which a fixture is substituted, and this module imports
 * nothing from `media/fixtures/**` — `live-page-data.test.ts` asserts both by
 * scanning the source, because a reviewer reads a file once and the next person
 * to need "something on the screen" will be under deadline.
 *
 * AND WHEN A FEED IS CONFIGURED, EVERY CHANNEL ON THE SCREEN CAME THROUGH
 * `admitPlaylistChannels`, which is the only minter of a `LiveChannel` and which
 * refuses an entry the authorization states no rights basis for. The rejected
 * entries are carried as COUNTS BY REASON for an operator panel, never as rows:
 * a refused channel must not appear in a channel list in any styling, because a
 * greyed-out row is still a bundled channel.
 * ---------------------------------------------------------------------- */
import type { EpgListing, LiveChannel } from "@liberty/contracts/domains/live";

import {
  UNGROUPED_KEY,
  UNGROUPED_LABEL,
  channelGroupKey,
  favouritesFirst,
  filterChannelsByGroup,
  groupLiveChannels,
  isFavouriteChannel,
  searchLiveChannels,
  type FavouriteChannelIds
} from "../../lib/livetv/channels";
import { assembleEpgSchedules } from "../../lib/livetv/epg-assembly";
import {
  LIVE_FEED_NOT_CONFIGURED_REASON,
  resolveLiveFeed,
  type LiveFeedResolution
} from "../../lib/livetv/feed-configuration";
import { parseM3u } from "../../lib/livetv/m3u";
import {
  admitPlaylistChannels,
  type PlaylistRejectionReason
} from "../../lib/livetv/playlist-validation";
import { nowAndNext, type LiveClock, type NowAndNext } from "../../lib/livetv/schedule";
import { formatZonedClock, type ResolvedViewerZone } from "../../lib/livetv/time";
import { parseXmltv, type XmltvRefusal } from "../../lib/livetv/xmltv";

/** One row of the channel list. Everything already decided; nothing for JSX to compute. */
export interface LiveChannelRow {
  readonly channel: LiveChannel;
  readonly groupLabel: string;
  readonly favourite: boolean;
  readonly nowAndNext: NowAndNext;
  /** `"19:30 Example Programme"`-shaped, in the viewer's zone. `null` when nothing is on. */
  readonly nowLabel: string | null;
  readonly nextLabel: string | null;
  /** The sentence under the row when nothing is on. `null` when something is. */
  readonly idleExplanation: string | null;
}

export interface LiveGroupOption {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
}

export type LivePageModel =
  /**
   * NO LICENSED FEED. The shipped state, and the state this surface is designed
   * around rather than apologising for.
   */
  | {
      readonly status: "unconfigured";
      readonly reason: typeof LIVE_FEED_NOT_CONFIGURED_REASON;
      readonly detail: string | null;
    }
  /** A feed is configured and its EPG document was refused outright. */
  | { readonly status: "epg_refused"; readonly refusal: XmltvRefusal; readonly detail: string }
  /**
   * A feed is configured and not one entry survived the gate. Distinct from
   * `unconfigured`: somebody configured something and it admitted nothing, which
   * is an operator's problem with a different remedy.
   */
  | {
      readonly status: "no_authorized_channels";
      readonly rejectedByReason: ReadonlyArray<{
        readonly reason: PlaylistRejectionReason;
        readonly count: number;
      }>;
    }
  | {
      readonly status: "ready";
      readonly providerLabel: string;
      readonly rows: readonly LiveChannelRow[];
      readonly groups: readonly LiveGroupOption[];
      readonly query: string;
      /** Rows hidden by the current filter or query, so the surface can offer a way out. */
      readonly filteredOut: number;
      readonly rejectedByReason: ReadonlyArray<{
        readonly reason: PlaylistRejectionReason;
        readonly count: number;
      }>;
      /** Listings dropped because no authorized channel was held for them. */
      readonly droppedListings: number;
    };

export interface LivePageInputs {
  readonly clock: LiveClock;
  readonly zone: ResolvedViewerZone;
  readonly favourites: FavouriteChannelIds;
  /** `null` = every group. From the URL, so the filter survives a reload. */
  readonly groupKey: string | null;
  readonly query: string;
  /** Defaults to the process registry; a test hands one in. */
  readonly feed?: LiveFeedResolution;
}

function labelFor(listing: EpgListing, zone: ResolvedViewerZone): string {
  const clock = formatZonedClock(listing.startsAt, zone);
  return clock === null ? listing.title : `${clock} ${listing.title}`;
}

/**
 * The sentence for a channel with nothing on, per state.
 *
 * FIVE STATES, FIVE SENTENCES, and that is the reason `NowAndNext` is a union
 * rather than a nullable listing: "this channel has no schedule", "the schedule
 * starts later", "the schedule we have has run out", and "we are in a gap
 * between programmes" are four different things to tell somebody, and a surface
 * handed `null` would say one of them for all four.
 */
function idleExplanationFor(state: NowAndNext, zone: ResolvedViewerZone): string | null {
  switch (state.state) {
    case "no_listings":
      return "No schedule has been loaded for this channel.";
    case "before_schedule": {
      const clock = formatZonedClock(state.next.startsAt, zone);
      return clock === null
        ? "This channel's schedule starts later."
        : `This channel's schedule starts at ${clock}.`;
    }
    case "after_schedule":
      return "The schedule we hold for this channel has run out; a refresh is due.";
    case "in_gap": {
      const clock = formatZonedClock(state.next.startsAt, zone);
      return clock === null
        ? "Nothing is scheduled right now."
        : `Nothing is scheduled right now; the next programme is at ${clock}.`;
    }
    case "on_air":
    case "on_air_indeterminate_end":
      return null;
  }
}

function currentOf(state: NowAndNext): EpgListing | null {
  if (state.state === "on_air" || state.state === "on_air_indeterminate_end") return state.current;
  return null;
}

function nextOf(state: NowAndNext): EpgListing | null {
  switch (state.state) {
    case "before_schedule":
    case "in_gap":
      return state.next;
    case "on_air":
    case "on_air_indeterminate_end":
      return state.next;
    case "no_listings":
    case "after_schedule":
      return null;
  }
}

function countByReason(
  rejected: ReadonlyArray<{ readonly reason: PlaylistRejectionReason }>
): ReadonlyArray<{ readonly reason: PlaylistRejectionReason; readonly count: number }> {
  const counts = new Map<PlaylistRejectionReason, number>();
  for (const entry of rejected) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  /* Sorted by reason, by code point, so the panel is stable across renders. */
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => (left.reason === right.reason ? 0 : left.reason < right.reason ? -1 : 1));
}

/**
 * Build the whole surface. Pure: the only impurity reachable from here is the
 * feed registry read, and that is a parameter with a default.
 */
export function buildLivePageModel(inputs: LivePageInputs): LivePageModel {
  const resolution = inputs.feed ?? resolveLiveFeed();
  if (resolution.status === "not-configured") {
    return { status: "unconfigured", reason: resolution.reason, detail: resolution.detail };
  }

  const feed = resolution.feed;
  const playlist = parseM3u(feed.playlistText);
  const admission = admitPlaylistChannels(playlist, feed.authorization);
  const rejectedByReason = countByReason(admission.rejected);

  if (admission.channels.length === 0) {
    return { status: "no_authorized_channels", rejectedByReason };
  }

  let listingsByChannel = new Map<string, readonly EpgListing[]>();
  let droppedListings = 0;
  if (feed.epgText !== null) {
    const parsed = parseXmltv(feed.epgText);
    if (!parsed.ok) {
      /*
       * A refused EPG document does NOT degrade to a channel list with no
       * schedule. It is reported, because `./xmltv.ts` refuses a document only
       * for reasons an operator must act on — a DTD, a size cap, markup that is
       * not well formed — and silently showing a scheduleless grid would hide a
       * feed that is actively broken.
       */
      return { status: "epg_refused", refusal: parsed.refusal, detail: parsed.detail };
    }
    const assembled = assembleEpgSchedules(admission.channels, parsed.document.programmes, {
      generatedAt: inputs.clock.now()
    });
    droppedListings = assembled.dropped.length;
    listingsByChannel = new Map(
      assembled.schedules.map((schedule) => [schedule.channelId, schedule.listings])
    );
  }

  const inGroup = filterChannelsByGroup(admission.channels, inputs.groupKey);
  const matching = searchLiveChannels(inGroup, inputs.query);
  const ordered = favouritesFirst(matching, inputs.favourites);

  const rows: LiveChannelRow[] = ordered.map((channel) => {
    const state = nowAndNext(listingsByChannel.get(channel.id) ?? [], inputs.clock);
    const current = currentOf(state);
    const next = nextOf(state);
    const groupKey = channelGroupKey(channel);
    return {
      channel,
      groupLabel: groupKey === UNGROUPED_KEY ? UNGROUPED_LABEL : groupKey,
      favourite: isFavouriteChannel(inputs.favourites, channel.id),
      nowAndNext: state,
      nowLabel: current === null ? null : labelFor(current, inputs.zone),
      nextLabel: next === null ? null : labelFor(next, inputs.zone),
      idleExplanation: idleExplanationFor(state, inputs.zone)
    };
  });

  const groups: LiveGroupOption[] = groupLiveChannels(admission.channels).map((group) => ({
    key: group.key,
    label: group.label,
    count: group.channels.length,
    selected: inputs.groupKey === group.key
  }));

  return {
    status: "ready",
    providerLabel: feed.label,
    rows,
    groups,
    query: inputs.query,
    filteredOut: admission.channels.length - rows.length,
    rejectedByReason,
    droppedListings
  };
}
