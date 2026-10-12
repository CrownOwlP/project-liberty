/* -------------------------------------------------------------------------
 * THE RIGHTS GATE FOR LIVE CHANNELS, AND THE ONLY PLACE A `LiveChannel` IS MINTED
 * (Wave 132, Worker E).
 *
 * READ `docs/CONTENT_RIGHTS.md` AND `docs/LIVE_TV.md` BEFORE EDITING THIS FILE.
 *
 * THE DEFECT CLASS REMOVED, AND IT IS THE ONE THIS WHOLE WORKER EXISTS FOR: A
 * PLAYLIST TREATED AS AN ENTITLEMENT. An M3U file is a list of names and
 * addresses that anybody can write. `docs/LIVE_TV.md` states the position in its
 * own words — "reuse the tooling, never the site list as permission", because
 * "inclusion in a third-party index is not permission from anybody" — and
 * `docs/CONTENT_RIGHTS.md` forbids "scraping or resolving unauthorized streams"
 * outright. The tempting implementation reads a playlist, maps each line to a
 * channel, and ships. That implementation bundles unauthorized channels, and it
 * does so while looking exactly like a feature.
 *
 * SO THE DIRECTION OF AUTHORITY IS INVERTED HERE, STRUCTURALLY:
 *
 *   - A playlist entry is a CANDIDATE. It can be refused, and by default it is.
 *   - The rights basis comes from a `LiveFeedAuthorization` the LICENSED FEED
 *     supplies — provider identity, the origins that feed declared, and a per
 *     source-channel rights basis the provider established. A playlist cannot
 *     contribute to it. There is no attribute an M3U line could carry that would
 *     put a channel in `channelRights`, because this function reads rights only
 *     from the authorization argument and `M3uEntry` has no rights field to read.
 *   - An entry naming a channel the authorization does not cover is REJECTED with
 *     `no_rights_basis_declared`, not defaulted, not warned about, not included
 *     with a flag the UI might not check. `liveChannelSchema.rights` is required
 *     and non-nullable precisely so "a channel with no basis" has no
 *     representation; this is the function that makes that true at the boundary.
 *   - The basis is then put through the repository's EXISTING gate,
 *     `PLAYABLE_CONTENT_RIGHTS` from `@liberty/contracts/shared/rights` — the
 *     same allowlist `lib/catalog.ts`'s `isSurfaceable` and
 *     `app/title/title-detail.ts` gate on. Imported, never restated: the
 *     allowlist exists so that a rights value added to the vocabulary later is
 *     non-surfaceable until somebody reviews it, and a second copy of the list
 *     is how that stops being true.
 *   - An entry whose address is not on an origin the authorized feed DECLARED is
 *     rejected. A playlist therefore cannot introduce a new origin, which is the
 *     mechanism by which a legitimate-looking line pointed at somebody else's
 *     server gets nowhere.
 *
 * AND THEN THE ADDRESS IS DISCARDED. Look at the output type: it is
 * `LiveChannel`, which by contract has NO stream field of any kind. The URL this
 * function validated is not carried forward, not stashed beside the channel, and
 * not written to a cache. Producing something playable means producing a
 * `StreamCandidate` through an authorized provider adapter behind
 * `@liberty/provider-sdk`, which is PL-0602 and is blocked on licensed feed
 * access. That is not a limitation of this file working around a missing
 * dependency; it is the boundary, and this file is on the metadata side of it.
 *
 * NOTHING HERE OPENS ANYTHING. `new URL()` parses; it does not resolve a name or
 * open a socket. There is no `fetch`, no `node:http`, no `node:dns`, no
 * `node:fs` in this module, and `playlist-validation.test.ts` asserts that by
 * scanning the source.
 * ---------------------------------------------------------------------- */
import { liveChannelSchema, type LiveChannel } from "@liberty/contracts/domains/live";
import { PLAYABLE_CONTENT_RIGHTS, type ContentRights } from "@liberty/contracts/shared/rights";

import type { M3uEntry, M3uPlaylist } from "./m3u";

/**
 * What an authorized feed states, and the ONLY source of a rights basis.
 *
 * Supplied by a composition root (see `./feed-configuration.ts`), never
 * discovered: nothing in this module reads an environment variable, a file or a
 * credential, for the reason `lib/catalog-source-registry.ts` gives at length
 * about a hosted process describing its own configuration into existence.
 */
export interface LiveFeedAuthorization {
  /** The party delivering the feed. `liveChannelSchema.providerId`. */
  readonly providerId: string;
  /**
   * Origins (`host` or `host:port`, lower case) the feed declared it serves from.
   *
   * An ALLOWLIST rather than a denylist, and compared after `new URL()` has
   * normalised the host — which folds the decimal, octal, hex and
   * IPv4-in-IPv6 spellings that a string comparison would miss. An empty list
   * admits nothing, which is the correct answer for a feed that declared no
   * origins rather than a reason to skip the check.
   */
  readonly declaredOrigins: readonly string[];
  /**
   * Per XMLTV/playlist source channel id, the basis the PROVIDER established.
   *
   * A record rather than a list of ids plus one blanket basis: `docs/LIVE_TV.md`
   * is explicit that a rights basis is a property of the arrangement with the
   * party delivering a particular channel, so one basis covering a whole feed
   * would let one channel's licence speak for another's.
   */
  readonly channelRights: Readonly<Record<string, ContentRights>>;
  /** ISO-3166-1 alpha-2 per channel, where the provider stated one. */
  readonly channelCountry?: Readonly<Record<string, string>>;
}

/**
 * Why an entry did not become a channel. One reason per rejection, closed
 * vocabulary, and every one of them names a different remedy.
 */
export const PLAYLIST_REJECTION_REASONS = [
  /** No `tvg-id` and no usable name: nothing to join to an authorization or an EPG. */
  "no_channel_identity",
  /** An identity that cannot become a `normalizedContentId` (`^[a-z0-9]+(-[a-z0-9]+)*$`). */
  "identity_not_normalizable",
  /** `#EXTINF` with no display name at all. A channel with no name is not presentable. */
  "no_display_name",
  /** The playlist named the channel and gave no address. */
  "no_stream_address",
  /** Not a URL, or not `http`/`https`. `file:`, `data:` and `javascript:` land here. */
  "address_not_an_http_url",
  /** The address is on an origin the authorized feed did not declare. */
  "origin_not_declared_by_feed",
  /** THE RIGHTS GATE. The authorization states no basis for this channel. */
  "no_rights_basis_declared",
  /** A basis that exists but is not on `PLAYABLE_CONTENT_RIGHTS`. */
  "rights_basis_not_surfaceable",
  /** A second entry resolving to a channel id already admitted. */
  "duplicate_channel_id",
  /** A second entry pointing at an address already admitted under another id. */
  "duplicate_stream_address",
  /** `liveChannelSchema` refused the assembled record. A bug here, reported not thrown. */
  "contract_refused"
] as const;
export type PlaylistRejectionReason = (typeof PLAYLIST_REJECTION_REASONS)[number];

export interface RejectedPlaylistEntry {
  readonly line: number;
  /** For an operator's eye. `""` when the entry had none. Never an address. */
  readonly displayName: string;
  readonly reason: PlaylistRejectionReason;
  /**
   * Context, with NO address in it ever. A rejection list is the thing most
   * likely to be pasted into a ticket, and a playlist URL can carry a
   * query-string credential; `./stream-errors.ts` makes the same argument for
   * the viewer-facing path.
   */
  readonly detail: string;
}

export interface PlaylistAdmission {
  /** Admitted channels, in the order the playlist stated them. No address survives. */
  readonly channels: readonly LiveChannel[];
  readonly rejected: readonly RejectedPlaylistEntry[];
}

/**
 * Fold an identity into a `normalizedContentId`, or refuse.
 *
 * Lossy on purpose and in one direction only: XMLTV ids look like `BBCOne.uk`
 * and `normalizedContentIdSchema` exists because these ids are interpolated into
 * routes. The ORIGINAL is kept on `sourceChannelId`, so the join back to the
 * feed's `<programme channel=…>` stays exact — which is the arrangement
 * `liveChannelSchema` documents and the reason both fields exist.
 */
export function normalizeChannelIdentity(raw: string): string | null {
  const folded = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded === "" ? null : folded;
}

/** The origin a candidate address is on, or a named refusal. Parses; never resolves. */
function readOrigin(url: string): { readonly ok: true; readonly origin: string } | { readonly ok: false } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false };
  /* `host` includes a non-default port and excludes a default one, which is the
   * comparison an operator means when they write down an origin. */
  return { ok: true, origin: parsed.host.toLowerCase() };
}

/**
 * Admit playlist entries as channels, or reject each with a named reason.
 *
 * PURE. No clock, no environment, no I/O. Same playlist and same authorization
 * in, same admission out — which is what lets `playlist-validation.test.ts`
 * assert the gate exhaustively rather than hope a reviewer reads it.
 */
export function admitPlaylistChannels(
  playlist: M3uPlaylist,
  authorization: LiveFeedAuthorization
): PlaylistAdmission {
  const channels: LiveChannel[] = [];
  const rejected: RejectedPlaylistEntry[] = [];
  const admittedIds = new Set<string>();
  const admittedOrigins = new Map<string, string>();

  const declaredOrigins = new Set(
    authorization.declaredOrigins.map((origin) => origin.trim().toLowerCase())
  );

  const reject = (
    entry: M3uEntry,
    reason: PlaylistRejectionReason,
    detail: string
  ): void => {
    rejected.push({ line: entry.line, displayName: entry.displayName, reason, detail });
  };

  for (const entry of playlist.entries) {
    const statedIdentity = entry.tvgId ?? "";
    const identitySource = statedIdentity !== "" ? statedIdentity : entry.displayName;
    if (identitySource.trim() === "") {
      reject(entry, "no_channel_identity", "the entry states neither tvg-id nor a display name");
      continue;
    }

    const normalizedId = normalizeChannelIdentity(identitySource);
    if (normalizedId === null) {
      reject(
        entry,
        "identity_not_normalizable",
        "the stated identity contains no characters a normalized content id may carry"
      );
      continue;
    }

    const displayName = entry.displayName.trim() !== "" ? entry.displayName.trim() : (entry.tvgName ?? "").trim();
    if (displayName === "") {
      reject(entry, "no_display_name", "the entry has an identity but nothing to display");
      continue;
    }

    if (entry.url === null) {
      reject(entry, "no_stream_address", "the playlist named this channel and gave no address");
      continue;
    }

    const origin = readOrigin(entry.url);
    if (!origin.ok) {
      reject(
        entry,
        "address_not_an_http_url",
        "the address is not a parseable http or https URL"
      );
      continue;
    }
    if (!declaredOrigins.has(origin.origin)) {
      /*
       * The origin is NAMED in the detail and the full address is not. An
       * operator debugging a feed needs to know which host was refused; nobody
       * needs the path and query, and the query is where a token would be.
       */
      reject(
        entry,
        "origin_not_declared_by_feed",
        `the address is on ${origin.origin}, which provider ${authorization.providerId} did not declare`
      );
      continue;
    }

    /* ----------------------------------------------------------------
     * THE RIGHTS GATE. Two steps, and neither may be skipped.
     * ---------------------------------------------------------------- */
    const basis = authorization.channelRights[statedIdentity !== "" ? statedIdentity : displayName];
    if (basis === undefined) {
      reject(
        entry,
        "no_rights_basis_declared",
        "the authorized feed states no rights basis for this channel, so it is not a channel we may carry"
      );
      continue;
    }
    if (!PLAYABLE_CONTENT_RIGHTS.includes(basis)) {
      reject(
        entry,
        "rights_basis_not_surfaceable",
        `the declared basis (${basis}) is not on the platform's surfaceable allowlist`
      );
      continue;
    }

    if (admittedIds.has(normalizedId)) {
      reject(
        entry,
        "duplicate_channel_id",
        `a channel with id ${normalizedId} was already admitted; the first entry wins`
      );
      continue;
    }
    const addressKey = entry.url;
    const owner = admittedOrigins.get(addressKey);
    if (owner !== undefined) {
      /*
       * TWO IDS, ONE ADDRESS. Real feeds do this by accident (a copied line with
       * an edited name) and it is not harmless: the two entries become two
       * channels in the UI, two EPG joins and two rights records for one
       * broadcast. The first wins and the second is named, rather than both
       * being kept because deduplicating looked like data loss.
       */
      reject(
        entry,
        "duplicate_stream_address",
        `this address was already admitted as ${owner}; the first entry wins`
      );
      continue;
    }

    const country = authorization.channelCountry?.[statedIdentity !== "" ? statedIdentity : displayName];
    const candidate = {
      id: normalizedId,
      providerId: authorization.providerId,
      sourceChannelId: statedIdentity !== "" ? statedIdentity : displayName,
      displayName,
      rights: basis,
      countryCode: country === undefined ? null : country.toUpperCase(),
      languages: null,
      categories: entry.groupTitle === null ? null : [entry.groupTitle],
      logoUrl: entry.tvgLogo === null || entry.tvgLogo === "" ? null : entry.tvgLogo
    };

    /*
     * THE CONTRACT HAS THE LAST WORD, AND IT IS `.strict()`. Everything above is
     * this module's own reasoning; `liveChannelSchema` is the repository's. A
     * record that satisfied every check here and still fails the schema is a bug
     * in this file, and it is reported as a rejection rather than thrown — one
     * bad line must not cost the ingest, which is the rule the whole layer runs
     * on.
     */
    const parsed = liveChannelSchema.safeParse(candidate);
    if (!parsed.success) {
      reject(entry, "contract_refused", `liveChannelSchema refused the assembled record: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
      continue;
    }

    channels.push(parsed.data);
    admittedIds.add(normalizedId);
    admittedOrigins.set(addressKey, normalizedId);
  }

  return { channels, rejected };
}

/** Rejections of one reason. Here so no surface writes the filter itself. */
export function rejectionsOfReason(
  admission: PlaylistAdmission,
  reason: PlaylistRejectionReason
): readonly RejectedPlaylistEntry[] {
  return admission.rejected.filter((entry) => entry.reason === reason);
}
