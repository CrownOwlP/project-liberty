import { failoverPolicySchema } from "@liberty/contracts/domains/failover";
import {
  compatibilityConfidenceSchema,
  playbackCapabilitiesSchema
} from "@liberty/contracts/domains/playback";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type { RejectionReason } from "@liberty/media-engine";
import type { UrlRejectionReason } from "@liberty/provider-sdk";
import { z } from "zod";

/* -------------------------------------------------------------------------
 * The playback session wire contract (PL-0501)
 *
 * WHY THIS LIVES HERE AND NOT IN `@liberty/contracts`. It belongs there, and
 * docs/API_CONTRACTS.md says so ("Before implementing these routes, define
 * request/response schemas in `@liberty/contracts`"). It is written here because
 * that package is under a lock held by other in-flight work at the time this
 * task ran, and a second editor there would have produced a merge conflict in
 * the one module every other lane compiles against. The move is mechanical --
 * nothing below imports anything from this app -- and it is the first item in
 * this task's follow-up list rather than a decision to keep the contract in the
 * route. `apps/web/src/components/player/playback-session.ts` already records
 * the same reasoning from the consumer's side.
 *
 * WHAT A CALLER GETS. Exactly one of three outcomes, discriminated on
 * `outcome`, and `reasons` on every one of them. Product invariant 4 says a
 * playback decision must expose a reason trail sufficient to debug candidate
 * selection, and a denial with no trail breaks it exactly as badly as a grant
 * with none: "we will not play this" with no reason is unanswerable by the
 * viewer, unactionable by support and undebuggable by us.
 *
 * `reasons` is therefore NOT an optional field on a common envelope, and it is
 * not `PlaybackSessionReason[]` either. It is a NON-EMPTY tuple on each branch
 * (`z.array(...).nonempty()`), which has three consequences that a convention
 * cannot have:
 *
 *   - a branch with no reasons is not constructible: `reasons: []` fails to
 *     typecheck against `[Reason, ...Reason[]]`;
 *   - `reasons[0]` reads as a `PlaybackSessionReason` rather than as
 *     `PlaybackSessionReason | undefined` under `noUncheckedIndexedAccess`, so
 *     "the primary reason" is a fact about the type and not a hope about the
 *     data. `playbackSessionHttpStatus` depends on this;
 *   - the response is validated against the same schema before it leaves the
 *     server (see `handler.ts`), so a future edit that drops the trail is a
 *     loud 500 rather than a decision nobody can explain.
 *
 * The three factory functions below are the only intended way to build a
 * response, and each one takes its first reason as a REQUIRED positional
 * argument. Forgetting the trail is not a mistake that reaches review.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Request
 * ---------------------------------------------------------------------- */

/**
 * What a client may send: a content id and what its device can decode.
 *
 * THERE IS NO FIELD HERE THROUGH WHICH A CLIENT CAN NAME A MEDIA URL, AND THERE
 * MUST NEVER BE ONE. The server resolves authorized provider candidates itself;
 * a request body that could carry a manifest URI would make this endpoint an
 * open proxy for arbitrary media and would relocate product invariant 1 out of
 * the code that enforces it and into whoever populated the field. That is also
 * why `/api/v1/playback/resolve` -- which DOES accept candidates -- is a
 * testing-only scaffold and not the session endpoint.
 *
 * `.strict()` on both levels is the enforcement, not decoration. Zod's default
 * is to STRIP unknown keys, which means a client posting
 * `{ contentId, capabilities, uri: "https://elsewhere/x.mpd" }` would get a
 * perfectly successful session and no indication that the field it believed in
 * was silently discarded -- and the next person to add a field to this schema
 * would be one keystroke away from honouring it. Refusing the request instead
 * makes the boundary observable from outside: the client is TOLD its field is
 * not accepted here.
 *
 * `contentId` is `normalizedContentIdSchema` rather than a free string, so a
 * path traversal, an absolute URL or a provider-native id is refused by the
 * schema before any resolver, adapter or fetch sees it.
 */
export const playbackSessionRequestSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    capabilities: playbackCapabilitiesSchema.strict()
  })
  .strict();

export type PlaybackSessionRequest = z.infer<typeof playbackSessionRequestSchema>;

/* -------------------------------------------------------------------------
 * Reasons
 * ---------------------------------------------------------------------- */

/**
 * The closed reason vocabulary.
 *
 * A CODE RATHER THAN A SENTENCE, for the reason `domains/failover.ts` spells
 * out at length: the moment a consumer has to decide anything by matching
 * substrings of prose, a reworded message becomes a behaviour change that no
 * type, test or review can see. `detail` beside it is for humans and is never
 * parsed.
 *
 * Three groups, and the second and third are deliberately spelled the same as
 * the vocabularies they carry -- `@liberty/media-engine`'s `RejectionReason`
 * and `@liberty/provider-sdk`'s `UrlRejectionReason`. A reason that gets
 * translated on the way out is a reason that eventually stops matching what the
 * code did, so these are surfaced verbatim. `engineReasonCode` and
 * `urlReasonCode` below are what stop the spellings drifting.
 */
export const playbackSessionReasonCodeSchema = z.enum([
  /* Request-level. Nothing about a specific candidate. */
  "request_malformed",
  "request_field_not_permitted",
  "content_not_found",
  "provider_not_configured",
  "provider_unavailable",
  "no_candidates_resolved",
  "rights_not_established",
  "no_playable_candidate",
  "session_issued",
  "session_issued_unverified_compatibility",

  /* Candidate-level, decided here. */
  "duplicate_candidate_id",
  "candidate_source_missing",
  "candidate_ranked",

  /* Candidate-level, decided by `@liberty/media-engine` (`RejectionReason`). */
  "rights_not_playable",
  "unsupported_video_codec",
  "unsupported_audio_codec",
  "resolution_exceeds_capability",
  "provider_health_below_floor",

  /* Candidate-level, decided by `@liberty/provider-sdk` (`UrlRejectionReason`). */
  "url_unparseable",
  "url_scheme_not_http",
  "url_credentials_present",
  "url_host_missing",
  "url_host_unparseable",
  "url_plaintext_http_not_loopback",
  "url_loopback_not_permitted",
  "url_loopback_not_local_deployment",
  "url_private_address"
]);

export type PlaybackSessionReasonCode = z.infer<typeof playbackSessionReasonCodeSchema>;

/**
 * Widens a media-engine rejection into this vocabulary, and that is its whole
 * job: the body is the identity function.
 *
 * It exists as a COMPILE-TIME LINK. If `@liberty/media-engine` gains a sixth
 * `RejectionReason`, this stops assigning and the build fails here, at the one
 * place that would otherwise have to invent a name for it at runtime. Without
 * it the new reason would reach `playbackReason()` as an unlisted code, the
 * response would fail its own schema, and a legitimate eligibility decision
 * would surface to the viewer as a 500.
 */
export function engineReasonCode(reason: RejectionReason): PlaybackSessionReasonCode {
  return reason;
}

/** The same guard for `@liberty/provider-sdk`'s outbound URL policy. */
export function urlReasonCode(reason: UrlRejectionReason): PlaybackSessionReasonCode {
  return reason;
}

/**
 * One line of the trail.
 *
 * `candidateId` is REQUIRED and nullable rather than optional, matching the
 * rule the rest of this repository states for unknown facts: `null` says "this
 * reason is about the request as a whole", an absent key says only that
 * somebody did not think about it. A support engineer reading a trail has to be
 * able to tell "we refused the request" from "we refused this stream".
 */
export const playbackSessionReasonSchema = z.object({
  code: playbackSessionReasonCodeSchema,
  candidateId: z.string().min(1).nullable(),
  detail: z.string().min(1)
});

export type PlaybackSessionReason = z.infer<typeof playbackSessionReasonSchema>;

/**
 * `.nonempty()` is the invariant, declared once and reused by all three
 * branches so no branch can be relaxed on its own.
 */
const reasonsSchema = z.array(playbackSessionReasonSchema).nonempty();

/**
 * Builds a reason.
 *
 * The empty-`detail` fallback is not defensive clutter: `detail` is
 * `.min(1)` in the schema, the schema is enforced on the way out, and several
 * details are strings produced by other packages (`explainScore`,
 * `UrlCheckResult.detail`). One of those returning `""` some day would convert
 * a correct playback decision into a 500. The code is always a truthful
 * minimum, so falling back to it degrades legibility rather than correctness.
 */
export function playbackReason(
  code: PlaybackSessionReasonCode,
  detail: string,
  candidateId: string | null = null
): PlaybackSessionReason {
  return { code, candidateId, detail: detail.trim() === "" ? code : detail };
}

/* -------------------------------------------------------------------------
 * The granted payload
 * ---------------------------------------------------------------------- */

/**
 * One stream the player may attempt, in preference order.
 *
 * `id` is the ranking's candidate id, NOT a URL and not an index: it is the
 * attribution key for every failure the player reports back, and
 * `PlaybackAttemptFailure` in `@liberty/contracts/domains/failover` is keyed by
 * it. `mimeType` is required-and-nullable for the usual reason -- `null` means
 * the resolver could not state one, which is a different claim from a field
 * nobody sent, and Shaka behaves differently (it issues a HEAD request to
 * guess) when it is absent.
 *
 * `compatibility` is carried per candidate rather than once per session because
 * the answer differs per candidate: `unverified` says this stream survived
 * eligibility by not being disqualified rather than by being qualified, so a
 * decode error on it is a foreseeable outcome and not evidence that the
 * provider has gone bad. A failover policy that cannot tell those apart will
 * blame the wrong thing.
 */
export const playbackSessionCandidateSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  uri: z.string().min(1),
  mimeType: z.string().min(1).nullable(),
  compatibility: compatibilityConfidenceSchema
});

export type PlaybackSessionCandidate = z.infer<typeof playbackSessionCandidateSchema>;

/**
 * The session itself.
 *
 * `candidates` is `.nonempty()` for the same reason `reasons` is: a granted
 * session with an empty candidate list is a grant that cannot be acted on, and
 * a player handed one goes straight to `fatal` with `no_candidates` -- a true
 * statement made in the wrong place, by the layer that does not know why. If
 * nothing is playable the outcome is `unavailable`, which carries the reasons.
 *
 * `startAtSeconds` is `null` rather than `0`, and the difference is not
 * cosmetic: `null` means "engine default", which for VOD is the beginning and
 * for live is the live edge. Resume-from-progress is PL-0403's and it is what
 * will start setting this.
 *
 * `failoverPolicy` is published rather than left for the client to hardcode.
 * The attempt budget is a product decision that has to be changeable without
 * shipping a new bundle, and a client with its own copy is a second policy that
 * can disagree with the reason trail this response already published.
 *
 * `expiresAt` bounds the session. See `PLAYBACK_SESSION_TTL_MS`.
 */
export const issuedPlaybackSessionSchema = z.object({
  sessionId: z.string().min(1),
  contentId: normalizedContentIdSchema,
  candidates: z.array(playbackSessionCandidateSchema).nonempty(),
  startAtSeconds: z.number().nonnegative().nullable(),
  expiresAt: z.string().datetime(),
  failoverPolicy: failoverPolicySchema
});

export type IssuedPlaybackSession = z.infer<typeof issuedPlaybackSessionSchema>;

/**
 * How long an issued session stays valid.
 *
 * Short and session-scoped is the rule from docs/RESEARCH_PLAYBACK.md and
 * docs/SECURITY.md: whatever credential eventually rides on a playback session
 * -- a licence token, a signed manifest URL -- must be minted per session and
 * expire, never a static licence URL or key sitting in a client bundle. NO SUCH
 * CREDENTIAL IS MINTED YET (see `authorized-candidates.ts` for where it will
 * be); this value exists so the bound is stated in the contract from the start
 * rather than retrofitted onto clients that learned to cache a session forever.
 *
 * Five minutes is a start-up budget, not a viewing budget: it bounds how long
 * after issuance a player may begin, and a two-hour film does not need a
 * two-hour session because the session is not what keeps the segments flowing.
 */
export const PLAYBACK_SESSION_TTL_MS = 5 * 60 * 1000;

/* -------------------------------------------------------------------------
 * The response
 * ---------------------------------------------------------------------- */

/**
 * Three outcomes, and the distinction between the last two is a REMEDY
 * distinction rather than a severity one:
 *
 *   - `granted`     -- a session exists and these are its candidates.
 *   - `denied`      -- we refuse. Either the request is not one we accept, or
 *                      no candidate carries a rights basis we may play from.
 *                      Retrying changes nothing; the caller must change what it
 *                      asked for, or we must acquire rights.
 *   - `unavailable` -- we would have, and could not. Nothing is registered
 *                      under that id, the provider could not answer, or nothing
 *                      survived eligibility and transport. Retrying later is
 *                      sometimes reasonable.
 *
 * A viewer told "try again in a moment" about something we will never be
 * entitled to play will keep trying, and a viewer told "you may not watch this"
 * about a CDN blip will stop. Collapsing the two is the whole reason this is a
 * union and not a boolean.
 *
 * `reasons[0]` is the PRIMARY reason -- the one that decided the outcome. The
 * rest are the trail behind it: candidates dropped, and why. Consumers may show
 * the primary and log the rest; they must not assume the trail is short.
 */
export const playbackSessionResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("granted"),
    reasons: reasonsSchema,
    session: issuedPlaybackSessionSchema
  }),
  z.object({
    outcome: z.literal("denied"),
    reasons: reasonsSchema
  }),
  z.object({
    outcome: z.literal("unavailable"),
    reasons: reasonsSchema
  })
]);

export type PlaybackSessionResponse = z.infer<typeof playbackSessionResponseSchema>;

type NonEmptyReasons = [PlaybackSessionReason, ...PlaybackSessionReason[]];

/**
 * `[head, ...rest]` typed as the non-empty tuple the schema requires.
 *
 * The assertion states the tuple rather than leaning on the contextual type to
 * infer it. A spread literal in a return position is one of the few places where
 * whether an array widens to `Reason[]` or stays `[Reason, ...Reason[]]` depends
 * on inference rules rather than on anything written down, and this is the
 * single construction point for every response the endpoint can produce -- so it
 * is said explicitly. It cannot be wrong: `head` is non-optional and the spread
 * follows it.
 */
function trail(head: PlaybackSessionReason, rest: PlaybackSessionReason[]): NonEmptyReasons {
  return [head, ...rest] as NonEmptyReasons;
}

/**
 * The three constructors.
 *
 * Each takes the primary reason as a required positional argument, so a branch
 * without a trail cannot be written down. This is the "enforced by the type
 * rather than by convention" half of invariant 4; the schema check on the way
 * out is the other half, for values that arrive from somewhere else.
 */
export function grantedSession(
  session: IssuedPlaybackSession,
  primary: PlaybackSessionReason,
  ...rest: PlaybackSessionReason[]
): PlaybackSessionResponse {
  return { outcome: "granted", reasons: trail(primary, rest), session };
}

export function deniedSession(
  primary: PlaybackSessionReason,
  ...rest: PlaybackSessionReason[]
): PlaybackSessionResponse {
  return { outcome: "denied", reasons: trail(primary, rest) };
}

export function unavailableSession(
  primary: PlaybackSessionReason,
  ...rest: PlaybackSessionReason[]
): PlaybackSessionResponse {
  return { outcome: "unavailable", reasons: trail(primary, rest) };
}

/**
 * Denials that are the CALLER's problem rather than a rights refusal.
 *
 * Kept apart because the status codes differ and mean different things to
 * everything downstream: a 400 tells a client to fix its request and tells a
 * dashboard nothing about entitlement, while a 403 is a rights signal that
 * ends up in exactly the metrics a rights review reads.
 */
const REQUEST_LEVEL_DENIALS: readonly PlaybackSessionReasonCode[] = [
  "request_malformed",
  "request_field_not_permitted"
];

/**
 * The HTTP status for a decision.
 *
 * Derived from the response rather than chosen at each return site, so the wire
 * status and the outcome cannot disagree -- and so `handler.ts` has no opinion
 * of its own about what a denial means. Reads `reasons[0]`, which the non-empty
 * tuple makes safe without a guard.
 */
export function playbackSessionHttpStatus(response: PlaybackSessionResponse): number {
  switch (response.outcome) {
    case "granted":
      return 200;
    case "denied":
      return REQUEST_LEVEL_DENIALS.includes(response.reasons[0].code) ? 400 : 403;
    case "unavailable":
      /* 404 only for "nothing is registered under this id". Everything else
       * here is a transient or configuration state, and telling a client a
       * title does not exist because a provider timed out is how a viewer
       * concludes their library lost something. */
      return response.reasons[0].code === "content_not_found" ? 404 : 503;
  }
}
