/* -------------------------------------------------------------------------
 * CHANNEL ORGANISATION: GROUPS, FAVOURITES, SEARCH, AND ONE TOTAL ORDER
 * (Wave 132, Worker E).
 *
 * THE DEFECT CLASS REMOVED: THE ORDER THAT DEPENDS ON THE MACHINE. This
 * repository has hit order-dependence six times by its own count (see
 * `@liberty/contracts/domains/live`'s comparator note), and a channel list is
 * where the seventh lives. There are two separate ways to get it wrong and this
 * module refuses both:
 *
 *   1. `localeCompare`. It is the obvious choice for a name list and it makes
 *      the order a function of the machine's ICU data and default locale, so a
 *      grid sorts one way in CI, another in a container, and a third on a
 *      laptop with a different locale — and nothing fails when they disagree,
 *      because every one of them looks sorted. Every comparison below is by CODE
 *      POINT (`<`), which is the same on every runtime there is. The cost is
 *      honest and stated: accented and non-Latin names sort by code point, which
 *      is not alphabetical in any language. A locale-correct order is a real
 *      feature and it needs a declared collation locale carried as data, not a
 *      call to the ambient default.
 *   2. AN ORDER THAT IS NOT TOTAL. Two channels with the same group and the same
 *      name are incomparable under a name-only comparator, `Array.prototype.sort`'s
 *      tie handling decides between them, and the result becomes a function of
 *      the order the feed happened to arrive in. `compareLiveChannels` has FOUR
 *      keys and the last one is `id`, which `liveChannelSchema` makes unique
 *      within an admitted set — so the order is total and sorting is invariant
 *      under permutation of the input. `channels.test.ts` asserts that by
 *      sorting shuffled copies.
 *
 * NULL PLACEMENT IS STATED, NOT LEFT TO CHANCE. An ungrouped channel sorts
 * AFTER every grouped one, and a channel with no category sorts after one with
 * a category of `""`. The placement is arbitrary; an unstated arbitrary choice
 * is a coin flip each implementation makes separately, which is the argument
 * `compareEpgListings` makes about `null` end times.
 *
 * FAVOURITES ARE A PURE MODEL OVER A SET, with no storage in sight. `./epg-cache.ts`
 * explains where this would persist and why no storage dependency is added here.
 * ---------------------------------------------------------------------- */
import type { LiveChannel } from "@liberty/contracts/domains/live";

/** Channels with no `group-title` are collected under this stated key, not under `""`. */
export const UNGROUPED_KEY = "__ungrouped__";

/** The label a surface shows for `UNGROUPED_KEY`. Here so three surfaces cannot disagree. */
export const UNGROUPED_LABEL = "Ungrouped";

/**
 * A channel's group, from `categories[0]`.
 *
 * FIRST CATEGORY ONLY, and deliberately so. `group-title` in an M3U is a single
 * value; `liveChannelSchema.categories` is an array because XMLTV channels carry
 * several, and `null` there means "the feed stated nothing" while `[]` means
 * "the feed stated an empty set" — a distinction the contract draws on purpose
 * and which this function must not collapse. Both map to ungrouped for
 * presentation, which is a RENDERING decision made here rather than a
 * normalisation decision made upstream.
 */
export function channelGroupKey(channel: LiveChannel): string {
  const categories = channel.categories;
  if (categories === null || categories.length === 0) return UNGROUPED_KEY;
  const first = categories[0];
  return first === undefined || first.trim() === "" ? UNGROUPED_KEY : first;
}

/**
 * The total order over channels. Four keys, each a strict tiebreak on the last.
 *
 *   1. group key, by code point, with `UNGROUPED_KEY` forced LAST rather than
 *      sorted as the string it happens to be — `"__ungrouped__"` would otherwise
 *      sort among names beginning with an underscore, which is a position nobody
 *      chose.
 *   2. `displayName`, by code point. NOT `localeCompare`; see the header.
 *   3. `sourceChannelId`, by code point. Two providers' spellings of one
 *      network's name are distinguished here before the synthetic id is reached,
 *      so the order stays stable when our own id scheme changes.
 *   4. `id`, by code point. The key that makes the order total.
 */
export function compareLiveChannels(left: LiveChannel, right: LiveChannel): number {
  const leftGroup = channelGroupKey(left);
  const rightGroup = channelGroupKey(right);
  if (leftGroup !== rightGroup) {
    if (leftGroup === UNGROUPED_KEY) return 1;
    if (rightGroup === UNGROUPED_KEY) return -1;
    return leftGroup < rightGroup ? -1 : 1;
  }
  if (left.displayName !== right.displayName) return left.displayName < right.displayName ? -1 : 1;
  if (left.sourceChannelId !== right.sourceChannelId) {
    return left.sourceChannelId < right.sourceChannelId ? -1 : 1;
  }
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/** Channels in the one order. Non-mutating: a caller's array is not reordered underneath them. */
export function sortLiveChannels(channels: readonly LiveChannel[]): LiveChannel[] {
  return [...channels].sort(compareLiveChannels);
}

export interface ChannelGroup {
  /** `UNGROUPED_KEY` for the ungrouped bucket. */
  readonly key: string;
  readonly label: string;
  readonly channels: readonly LiveChannel[];
}

/**
 * Channels bucketed by group, both levels in the one order.
 *
 * Groups are produced in the order their channels sort in, which is the group
 * key's own code-point order with ungrouped last — so the group list is derived
 * from the channel order rather than being a second ordering rule that could
 * disagree with it.
 */
export function groupLiveChannels(channels: readonly LiveChannel[]): readonly ChannelGroup[] {
  const sorted = sortLiveChannels(channels);
  const groups: ChannelGroup[] = [];
  const index = new Map<string, LiveChannel[]>();
  for (const channel of sorted) {
    const key = channelGroupKey(channel);
    let bucket = index.get(key);
    if (bucket === undefined) {
      bucket = [];
      index.set(key, bucket);
      groups.push({ key, label: key === UNGROUPED_KEY ? UNGROUPED_LABEL : key, channels: bucket });
    }
    bucket.push(channel);
  }
  return groups;
}

/** Every group key present, in the channel order's group order. For a filter control. */
export function channelGroupKeys(channels: readonly LiveChannel[]): readonly string[] {
  return groupLiveChannels(channels).map((group) => group.key);
}

/** Channels in one group. `null` means every group. */
export function filterChannelsByGroup(
  channels: readonly LiveChannel[],
  groupKey: string | null
): readonly LiveChannel[] {
  if (groupKey === null) return sortLiveChannels(channels);
  return sortLiveChannels(channels).filter((channel) => channelGroupKey(channel) === groupKey);
}

/**
 * Search, case-insensitively, over the two fields a viewer actually types.
 *
 * `toLowerCase()` and NOT `toLocaleLowerCase()`. The locale-aware form is
 * exactly the same environment dependence the header rejects for sorting, and it
 * has a specific trap: in a Turkish locale `"I".toLocaleLowerCase()` is `"ı"`,
 * so a channel named `INFO` stops matching the query `info` on a machine whose
 * locale somebody changed. `toLowerCase()` is defined by Unicode, not by the
 * environment.
 *
 * SUBSTRING, NOT FUZZY. A channel list is tens to hundreds of items a viewer is
 * scanning, and a fuzzy matcher's job is to rank — which needs a scoring
 * function, which needs tie-breaks, which is a second ordering rule. Substring
 * over a known-total order is the whole feature here.
 */
export function searchLiveChannels(
  channels: readonly LiveChannel[],
  query: string
): readonly LiveChannel[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return sortLiveChannels(channels);
  return sortLiveChannels(channels).filter((channel) => {
    if (channel.displayName.toLowerCase().includes(needle)) return true;
    if (channel.sourceChannelId.toLowerCase().includes(needle)) return true;
    return channelGroupKey(channel).toLowerCase().includes(needle);
  });
}

/* -------------------------------------------------------------------------
 * Favourites: a pure model over a set of channel ids.
 * ---------------------------------------------------------------------- */

/**
 * Favourite channel ids, as data.
 *
 * A `readonly string[]` rather than a `Set` because this value is SERIALISED —
 * it is what a store round-trips and what a server render receives — and a `Set`
 * has no stable serialisation. Kept sorted by code point by every function
 * below, so two sessions that favourited the same channels in a different order
 * produce byte-identical state and a diff of the stored value is meaningful.
 */
export type FavouriteChannelIds = readonly string[];

export const NO_FAVOURITES: FavouriteChannelIds = Object.freeze([]);

export function isFavouriteChannel(favourites: FavouriteChannelIds, channelId: string): boolean {
  return favourites.includes(channelId);
}

/** Add or remove, returning NEW state. Idempotent per direction, never mutating. */
export function toggleFavouriteChannel(
  favourites: FavouriteChannelIds,
  channelId: string
): FavouriteChannelIds {
  if (channelId.trim() === "") return favourites;
  if (favourites.includes(channelId)) {
    return Object.freeze(favourites.filter((id) => id !== channelId));
  }
  return Object.freeze([...favourites, channelId].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)));
}

/**
 * Stored favourites narrowed to channels this process actually holds.
 *
 * A favourite for a channel the feed no longer carries is DROPPED from the view
 * and left in the stored value, which is the deliberate half-measure: the
 * channel may come back next refresh, and a reconciliation that deleted it would
 * lose a viewer's choice because of one bad fetch. `./epg-cache.ts` makes the
 * same local-first argument about stale schedules.
 */
export function favouriteChannels(
  channels: readonly LiveChannel[],
  favourites: FavouriteChannelIds
): readonly LiveChannel[] {
  return sortLiveChannels(channels).filter((channel) => favourites.includes(channel.id));
}

/**
 * Favourites first, then everything else, each half in the one order.
 *
 * Expressed as two sorted halves rather than as a fifth comparator key, so the
 * total order above stays the only order and "favourites first" stays a
 * PRESENTATION choice a surface can decline. A comparator that read a favourites
 * set would make the stored preference part of the sort's definition, and the
 * order would stop being a function of the channels alone.
 */
export function favouritesFirst(
  channels: readonly LiveChannel[],
  favourites: FavouriteChannelIds
): readonly LiveChannel[] {
  const sorted = sortLiveChannels(channels);
  return [
    ...sorted.filter((channel) => favourites.includes(channel.id)),
    ...sorted.filter((channel) => !favourites.includes(channel.id))
  ];
}
