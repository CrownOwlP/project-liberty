/* -------------------------------------------------------------------------
 * Where a session starts: resume, restart, or no opinion (W132-D, item 4)
 *
 * ==========================================================================
 * WHY THIS IS NOT `continueWatchingVerdict`, WHICH ALREADY EXISTS
 * ==========================================================================
 *
 * `lib/continue-watching.ts` decides whether a stored row belongs ON A RAIL and
 * where it would resume. That function is correct and this file does not
 * replace it, but its answers are not this file's answers, and the difference is
 * the whole reason this exists: THE RAIL EXCLUDES A FINISHED TITLE AND THE
 * PLAYER MUST STILL PLAY IT. `{ kind: "excluded", why: "finished" }` is a
 * sound instruction to a rail and a bug in a player — a viewer who clicks a
 * title they finished last night gets a player that refuses to start, or worse,
 * one that seeks to 94% and shows them the credits. The playback-time answer to
 * "finished" is START OVER, and the playback-time answer to "barely started" is
 * also start over, and those are not exclusions at all.
 *
 * So this module answers a different question with the same thresholds, and a
 * reason trail saying which rule fired (product invariant 4).
 *
 * ==========================================================================
 * THE THRESHOLDS ARE MIRRORED, AND A TEST — NOT AN IMPORT — KEEPS THEM HONEST
 * ==========================================================================
 *
 * Importing the constants from `lib/continue-watching.ts` would be the obvious
 * way to have one copy, and it is the wrong one HERE, for a reason
 * `viewer-preferences.ts` already states about that exact module: it
 * "statically reaches the catalog metadata registry and through it
 * `@liberty/catalog-ingestion`". This file is reachable from a `"use client"`
 * component, so that import is a server-side ingestion package pulled into the
 * browser bundle — a defect class (bundle contamination through a constants
 * import) that is invisible in review and expensive at runtime.
 *
 * The values are therefore restated below and `resume-decision.test.ts` imports
 * the real module and asserts equality. A TEST FILE MAY IMPORT ANYTHING: it runs
 * in `environment: "node"` and is not bundled. This is the pattern
 * `telemetry-decision.ts` already uses for `CMCD_COLLECTOR_PATH`, which is
 * "kept honest by a test in the route's own directory that derives this path
 * from its own location on disk and compares".
 *
 * ==========================================================================
 * THREE OUTCOMES, AND `ignore` IS NOT `restart`
 * ==========================================================================
 *
 * `restart` ASSERTS a start position of 0. `ignore` ABSTAINS and carries
 * `startAtSeconds: null`. They differ in what the caller then does, and the
 * difference is already load-bearing in this repo: `watchResultFor` computes
 * `response.session.startAtSeconds ?? resumeAtSeconds`, so `null` means "the
 * session's own choice stands" while `0` overrides it. For a live or
 * DVR-windowed stream those are opposite behaviours — `0` seeks to the back of
 * the window, which is the oldest content the viewer can see, when they asked
 * for the channel.
 *
 * `ignore` is therefore the answer when this module has NOTHING TO SAY: no
 * stored position, or a stored position that is not a usable number. Collapsing
 * it into `restart` would turn an abstention into an assertion, and the bug it
 * produces is the one above.
 *
 * ==========================================================================
 * WHAT THIS MODULE DOES NOT DO
 * ==========================================================================
 *
 * IT DOES NOT WRITE PROGRESS. Writing belongs to the progress modules in
 * `lib/` (worker F's surface). `ProgressReadPort` below is the shape this file
 * needs to be handed, and nothing in this directory may reach into a store to
 * fill it.
 *
 * NOTHING HERE READS A BROWSER API, A CLOCK OR A STORE.
 * ---------------------------------------------------------------------- */

/**
 * A credits roll, in seconds. Mirrors `FINISHED_TAIL_SECONDS`.
 *
 * See the header: mirrored rather than imported, with a test pinning the two
 * together. If you change one, the test fails rather than the product drifting.
 */
export const FINISHED_TAIL_SECONDS = 90;

/** How much of a title counts as finished. Mirrors `FINISHED_FRACTION`. */
export const FINISHED_FRACTION = 0.95;

/** A title sequence, in seconds. Mirrors `RESUMABLE_MINIMUM_SECONDS`. */
export const RESUMABLE_MINIMUM_SECONDS = 30;

/** Why the session starts where it starts. One of these fired; exactly one. */
export type ResumeReason =
  /** A usable stored position far enough from both ends. */
  | "stored_position"
  /** A usable stored position, and no duration to measure the end against. */
  | "stored_position_unmeasurable"
  /** The viewer asked to start over, which outranks every other rule. */
  | "restart_requested"
  /** Inside the title sequence: resuming would save nobody anything. */
  | "near_start"
  /** Inside the credits: resuming would show the viewer the end. */
  | "near_end"
  /** Nothing stored. This module has no opinion about where to start. */
  | "nothing_stored"
  /** Something stored that is not a position: negative, NaN, not a number. */
  | "position_unusable";

export type ResumeDecision =
  | {
      readonly kind: "resume";
      /** Where to start, in seconds. Always the STORED value, never an estimate. */
      readonly startAtSeconds: number;
      readonly reason: ResumeReason;
    }
  | {
      readonly kind: "restart";
      /** An assertion of the beginning. See the header on `ignore`. */
      readonly startAtSeconds: 0;
      readonly reason: ResumeReason;
    }
  | {
      readonly kind: "ignore";
      /** An abstention. The session's own start position stands. */
      readonly startAtSeconds: null;
      readonly reason: ResumeReason;
    };

export interface ResumeInput {
  /** What the store holds, in seconds. `null` when it holds nothing. */
  readonly storedPositionSeconds: number | null;
  /** The runtime, in seconds. `null` when unknown — which is not zero. */
  readonly durationSeconds: number | null;
  /**
   * The viewer pressed "start over".
   *
   * `isRestartRequested` in `lib/continue-watching.ts` already parses the
   * `?restart=1` form of this. Taken as a boolean so this file holds no second
   * opinion about how that intent is spelled in a URL.
   */
  readonly restartRequested?: boolean;
}

/**
 * The read this module needs and must not perform itself.
 *
 * Declared here so the integration is a named type rather than a conversation:
 * whoever owns the progress store implements this, the watch page calls it, and
 * the result is handed in as `storedPositionSeconds`. One method, no store, no
 * profile resolution, because everything else about a progress row is somebody
 * else's business.
 */
export interface ProgressReadPort {
  readPositionSeconds(contentId: string): Promise<number | null>;
}

/**
 * Where to start, and why.
 *
 * RULE ORDER IS THE BEHAVIOUR and is therefore fixed here rather than left to a
 * chain of `if`s a later edit can reorder:
 *
 *  1. An explicit restart wins outright. A viewer who pressed "start over" is
 *     not asking for a threshold to be consulted, and a stored position two
 *     minutes in would otherwise beat them.
 *  2. Nothing stored, or nothing usable, is an ABSTENTION. See the header.
 *  3. Near the start is a restart. Below the title-sequence threshold there is
 *     nothing to return to.
 *  4. An unknown duration resumes, and never finishes. This is the rule
 *     `continueWatchingVerdict` states in terms — "finished" is a claim about
 *     remaining duration and nothing here knows the duration — and it is kept
 *     identical on purpose so the rail and the player cannot disagree about one
 *     title.
 *  5. Near the end is a restart, by tail OR fraction, whichever fires first.
 *  6. Otherwise, resume at the stored position exactly.
 */
export function resumeDecision(input: ResumeInput): ResumeDecision {
  const { storedPositionSeconds, durationSeconds } = input;

  if (input.restartRequested === true) {
    return { kind: "restart", startAtSeconds: 0, reason: "restart_requested" };
  }

  if (storedPositionSeconds === null || storedPositionSeconds === undefined) {
    return { kind: "ignore", startAtSeconds: null, reason: "nothing_stored" };
  }

  /* A NEGATIVE OR NON-FINITE POSITION IS NOT A POSITION. Seeking a media element
   * to `NaN` throws, and seeking it to -5 silently clamps to 0 — so one shape of
   * bad data would crash the player and the other would look like a deliberate
   * restart. Both are reported as unusable instead, and neither is passed on. */
  if (!Number.isFinite(storedPositionSeconds) || storedPositionSeconds < 0) {
    return { kind: "ignore", startAtSeconds: null, reason: "position_unusable" };
  }

  if (storedPositionSeconds < RESUMABLE_MINIMUM_SECONDS) {
    return { kind: "restart", startAtSeconds: 0, reason: "near_start" };
  }

  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return {
      kind: "resume",
      startAtSeconds: storedPositionSeconds,
      reason: "stored_position_unmeasurable"
    };
  }

  const remaining = durationSeconds - storedPositionSeconds;
  const fraction = storedPositionSeconds / durationSeconds;
  if (remaining <= FINISHED_TAIL_SECONDS || fraction >= FINISHED_FRACTION) {
    return { kind: "restart", startAtSeconds: 0, reason: "near_end" };
  }

  return { kind: "resume", startAtSeconds: storedPositionSeconds, reason: "stored_position" };
}

/**
 * The decision as one line for the reason trail.
 *
 * The player's trail is read by whoever is debugging "it didn't resume", and the
 * numbers that produced the verdict have to be in the line — a trail entry
 * reading `restart` alone cannot distinguish a credits-roll restart from a
 * viewer pressing the button.
 */
export function describeResumeDecision(input: ResumeInput, decision: ResumeDecision): string {
  const stored =
    input.storedPositionSeconds === null || input.storedPositionSeconds === undefined
      ? "none"
      : `${input.storedPositionSeconds}s`;
  const duration =
    input.durationSeconds === null || input.durationSeconds === undefined
      ? "unknown"
      : `${input.durationSeconds}s`;
  const start = decision.startAtSeconds === null ? "session default" : `${decision.startAtSeconds}s`;
  return `${decision.kind} at ${start}: ${decision.reason} (stored ${stored}, duration ${duration})`;
}
