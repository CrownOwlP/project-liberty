/* -------------------------------------------------------------------------
 * What the player is handed, and by whom
 *
 * The state machine below plays a LIST of candidates, in order, and never
 * decides what that list contains. The rights decision, the ranking and the
 * URL signing all happen before this shape exists — `playback-source.ts` states
 * the same boundary for a single source and this states it for a session.
 *
 * WHY THIS IS NOT IN `@liberty/contracts`. PL-0501 owns the wire contract for a
 * playback session and its acceptance already fixes the shape: a discriminated
 * union on outcome with reasons on every branch. Declaring that contract here
 * would create a second opinion about it in a package this task does not own,
 * and the two would drift the moment PL-0501 lands. What IS here is only what
 * the PLAYER consumes — an ordered candidate list and a resume point — so when
 * the real contract arrives the change is one adapter function, not a rewrite
 * of the machine. `outcome` mirrors PL-0501's three branches deliberately, so
 * that adapter is a rename rather than a redesign.
 *
 * `id` is the candidate id the ranking issued, NOT a URL and not an index.
 * Failures the machine records are `{ candidateId, kind }` — exactly
 * `PlaybackAttemptFailure` from `@liberty/contracts/domains/failover` — so the
 * trail this player produces can be fed straight back into
 * `planFailover()` in `@liberty/media-engine` without a translation step that
 * could lose or invent an attribution.
 * ---------------------------------------------------------------------- */

import type { PlaybackSource } from "./playback-source";

export interface PlaybackCandidate {
  /** The ranking's id for this stream. Attribution for every recorded failure. */
  readonly id: string;
  /** Which adapter produced it. Carried for the trail, never for a decision. */
  readonly providerId: string;
  /**
   * The already-authorized source. Checked again by `checkPlaybackSource` on the
   * way into the engine — a backstop, not a rights check; see
   * `playback-source.ts` for why both exist.
   */
  readonly source: PlaybackSource;
}

export interface PlaybackSession {
  readonly contentId: string;
  /**
   * In PREFERENCE ORDER. The machine walks this list and never re-sorts it:
   * a second opinion about preference here could disagree with the one
   * `rankStreamCandidates` already published, and then the reason trail would
   * explain a choice nobody made.
   */
  readonly candidates: readonly PlaybackCandidate[];
  /**
   * Where to start, in SECONDS, matching Shaka's `load()` and everything else
   * in this directory. `null` means "engine default", which for VOD is zero and
   * for live is the live edge — a difference this layer must not flatten to 0.
   */
  readonly startAtSeconds: number | null;
  /**
   * Why this session exists in the form it does, from whoever authorized it.
   * Product invariant 4 applies to a grant as much as to a denial, so this is
   * required and not optional: a session that arrived with no reasons is a
   * session nobody can debug.
   */
  readonly reasons: readonly string[];
}

/**
 * The three outcomes PL-0501 will publish, with `reasons` on every branch.
 *
 * Not optional on any branch, for the reason PL-0501's acceptance states: a
 * denial with no reason trail violates invariant 4 exactly as much as a grant
 * with none.
 */
export type PlaybackSessionOutcome =
  | { readonly outcome: "granted"; readonly session: PlaybackSession; readonly reasons: readonly string[] }
  | { readonly outcome: "denied"; readonly reasons: readonly string[] }
  | { readonly outcome: "unavailable"; readonly reasons: readonly string[] };
