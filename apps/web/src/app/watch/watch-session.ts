import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import type { FailoverPolicy } from "@liberty/contracts/domains/failover";
import { DEFAULT_FAILOVER_POLICY, rankStreamCandidates } from "@liberty/media-engine";
import {
  checkPlaybackSource,
  describeSourceRejection,
  type PlaybackSource
} from "../../components/player/playback-source";
import type { PlaybackCandidate, PlaybackSession } from "../../components/player/playback-session";

/* -------------------------------------------------------------------------
 * Where the watch route gets a session — and what it will never accept
 *
 * THE CLIENT SUPPLIES A CONTENT ID AND NOTHING ELSE. There is no code path here
 * or in the route that turns a query parameter, a header or a request body into
 * a media URL, and there must never be one: a player that plays a URL the page
 * chose is an open proxy for arbitrary media, and it relocates product invariant
 * 1 into whatever code sets the attribute. `playback-source.ts` states the same
 * boundary one layer down.
 *
 * THIS IS A STAND-IN FOR PL-0501, AND IT IS SHAPED LIKE THE REAL THING ON
 * PURPOSE. What it fakes is narrow and named: the CANDIDATE SOURCE, injected
 * below, which today returns fixtures and tomorrow returns what a provider
 * adapter resolved. What it does NOT fake is the decision — rights and
 * eligibility go through `rankStreamCandidates` from `@liberty/media-engine`,
 * the same already-reviewed allowlist the resolve route uses, so the gate this
 * page renders is the real gate rather than a comment promising one. When
 * PL-0501 lands, the `source` argument is replaced and the rest of this file
 * stops existing.
 *
 * No API route is added here. `apps/web/src/app/api/v1/playback/**` belongs to
 * PL-0501 and inventing a second endpoint for the session would give the
 * platform two answers to "what is a playback session".
 * ---------------------------------------------------------------------- */

/**
 * A stream we hold rights information for, paired with the URL an authorized
 * session would have signed.
 *
 * Two fields rather than one flattened record, because they come from different
 * places and have different lifetimes: the `StreamCandidate` is metadata a
 * provider stated and the ranking reads, and the `PlaybackSource` is a
 * short-lived credential-bearing URL that no ranking should ever see.
 */
export interface AuthorizedCandidate {
  readonly candidate: StreamCandidate;
  readonly source: PlaybackSource;
}

/**
 * Where candidates come from. Injectable so this loader's failure paths are
 * testable, and so PL-0501's resolver can replace the fixtures without the route
 * changing.
 *
 * `null` means not-found. A source that cannot answer THROWS instead, so
 * "this title does not exist" and "the provider is down" stay distinguishable —
 * they send a reader to different systems and the route renders them
 * differently.
 */
export type AuthorizedCandidateSource = (
  contentId: string
) => readonly AuthorizedCandidate[] | null | Promise<readonly AuthorizedCandidate[] | null>;

export type WatchSessionResult =
  | { readonly status: "ok"; readonly session: PlaybackSession; readonly policy: FailoverPolicy }
  | { readonly status: "not-found"; readonly contentId: string }
  | { readonly status: "denied"; readonly contentId: string; readonly reasons: readonly string[] }
  | { readonly status: "error"; readonly reason: string };

/**
 * A conservative device profile.
 *
 * The server does not know what the browser can decode — that is genuinely
 * PL-0501's problem, because capability negotiation is part of the session
 * request and not of this stub. Stating a narrow profile means the fixtures
 * exercise the eligibility path rather than trivially passing it, and it fails
 * in the safe direction: a candidate wrongly excluded here costs a fallback,
 * while one wrongly included costs a decode failure the viewer watches happen.
 */
const CONSERVATIVE_CAPABILITIES: PlaybackCapabilities = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

/**
 * Where development fixtures are served from.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so the default can
 * never accidentally reach a real host — the fixtures fail, the machine fails
 * over through all three of them, and the reason trail on the page shows the
 * whole sequence, which is a more useful default than a player that silently
 * does nothing. Point `LIBERTY_FIXTURE_MEDIA_ORIGIN` at a local DASH/HLS rig
 * (`http://localhost:…` is carved out by `checkPlaybackSource`) to watch
 * something.
 */
const FIXTURE_MEDIA_ORIGIN = process.env.LIBERTY_FIXTURE_MEDIA_ORIGIN ?? "https://fixtures.invalid";

const FIXTURE_PROVIDER = "fixture";

/**
 * Three candidates so failover has somewhere to go.
 *
 * Ordered worst-first deliberately: if this list were already in preference
 * order, a defect in `rankStreamCandidates` or in the mapping below would be
 * invisible, because the wrong answer and the right one would look the same.
 */
function fixtureCandidates(contentId: string): readonly AuthorizedCandidate[] {
  const rights = "owned" as const;
  return [
    {
      candidate: {
        id: `${contentId}-progressive`,
        providerId: FIXTURE_PROVIDER,
        rights,
        protocol: "https",
        height: 720,
        bitrateKbps: 2800,
        estimatedLatencyMs: 120,
        healthScore: 0.82,
        videoCodec: "h264",
        audioCodec: "aac"
      },
      source: { uri: `${FIXTURE_MEDIA_ORIGIN}/${contentId}/720p.mp4`, mimeType: "video/mp4" }
    },
    {
      candidate: {
        id: `${contentId}-hls`,
        providerId: FIXTURE_PROVIDER,
        rights,
        protocol: "hls",
        height: 1080,
        bitrateKbps: 5200,
        estimatedLatencyMs: 90,
        healthScore: 0.94,
        videoCodec: "h264",
        audioCodec: "aac"
      },
      source: {
        uri: `${FIXTURE_MEDIA_ORIGIN}/${contentId}/master.m3u8`,
        mimeType: "application/vnd.apple.mpegurl"
      }
    },
    {
      candidate: {
        id: `${contentId}-dash`,
        providerId: FIXTURE_PROVIDER,
        rights,
        protocol: "dash",
        height: 1080,
        bitrateKbps: 6000,
        estimatedLatencyMs: 70,
        healthScore: 0.97,
        videoCodec: "h264",
        audioCodec: "aac"
      },
      source: { uri: `${FIXTURE_MEDIA_ORIGIN}/${contentId}/manifest.mpd`, mimeType: "application/dash+xml" }
    }
  ];
}

/**
 * Turn a ranking into the ordered candidate list the player walks.
 *
 * The ranking's order is preserved exactly. Re-sorting here would create a
 * second opinion about preference that could disagree with the one the decision
 * already published, and then the reason trail would explain a choice nobody
 * made.
 *
 * The transport check is a BACKSTOP rather than a rights check — see
 * `playback-source.ts`. It runs here so that a misconfigured fixture origin is
 * a reason on this page instead of a generic network error three layers down
 * that looks exactly like a dead CDN.
 */
function toPlaybackCandidates(
  ranked: readonly { readonly candidate: StreamCandidate }[],
  authorized: readonly AuthorizedCandidate[],
  reasons: string[]
): PlaybackCandidate[] {
  const sources = new Map(authorized.map((entry) => [entry.candidate.id, entry.source]));
  const playable: PlaybackCandidate[] = [];

  for (const entry of ranked) {
    const id = entry.candidate.id;
    const source = sources.get(id);
    if (source === undefined) {
      /* Reachable only if the ranking returned an id it was not given, which
       * would be a defect rather than a data problem — so it is reported rather
       * than skipped in silence. */
      reasons.push(`${id}: ranked but no authorized source was issued for it`);
      continue;
    }

    const check = checkPlaybackSource(source);
    if (!check.ok) {
      reasons.push(`${id}: ${describeSourceRejection(check.reason)}`);
      continue;
    }

    playable.push({ id, providerId: entry.candidate.providerId, source });
  }

  return playable;
}

/**
 * The loader the watch route uses.
 *
 * Never throws. Every outcome is a branch the route can render, because the
 * three that are not "ok" have three different remedies and a reader told to
 * "try again in a moment" about a title that will never exist will keep trying.
 */
export async function loadPlaybackSession(
  contentId: string,
  source: AuthorizedCandidateSource = fixtureCandidates
): Promise<WatchSessionResult> {
  /*
   * Checked before the source is consulted. An id that is not normalized cannot
   * name anything — every id in the system is lower-case and hyphen-separated —
   * so this is not-found rather than an error, and doing it first keeps raw URL
   * path input from reaching the provider boundary at all.
   */
  if (!normalizedContentIdSchema.safeParse(contentId).success) {
    return { status: "not-found", contentId };
  }

  let authorized: readonly AuthorizedCandidate[] | null;
  try {
    authorized = await source(contentId);
  } catch (cause) {
    return { status: "error", reason: cause instanceof Error ? cause.message : "candidate source failed" };
  }

  if (authorized === null) return { status: "not-found", contentId };

  const decision = rankStreamCandidates(
    authorized.map((entry) => entry.candidate),
    CONSERVATIVE_CAPABILITIES
  );

  /*
   * The rights and eligibility gate. `rankStreamCandidates` refuses any rights
   * value outside its allowlist before scoring anything, so a denial here is the
   * real invariant-1 answer rather than a check this file performs.
   */
  if (decision.selected === null) {
    return {
      status: "denied",
      contentId,
      reasons: [
        decision.reason,
        ...decision.rejected.map((entry) => `${entry.candidateId}: ${entry.reason}`)
      ]
    };
  }

  const reasons: string[] = [decision.reason, ...decision.ranked.map((entry) => `${entry.candidate.id}: ${entry.reason}`)];
  const candidates = toPlaybackCandidates(decision.ranked, authorized, reasons);

  if (candidates.length === 0) {
    return { status: "denied", contentId, reasons };
  }

  return {
    status: "ok",
    session: {
      contentId,
      candidates,
      /*
       * `null` rather than `0`, and the difference is not cosmetic: `null` means
       * "engine default", which for VOD is the beginning and for live is the
       * live edge. Resume-from-progress is PL-0403's, and it will set this.
       */
      startAtSeconds: null,
      reasons
    },
    policy: DEFAULT_FAILOVER_POLICY
  };
}
