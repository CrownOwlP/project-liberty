/* -------------------------------------------------------------------------
 * When a progress write happens -- and the number that is deliberately absent
 *
 * The research (PL-0403) is explicit that the client policy is: one heartbeat on
 * an interval, plus immediate writes on pause, on a settled seek, and at
 * playback end. It is equally explicit that THE INTERVAL IS AN OPEN PRODUCT
 * CHOICE. "Pick one, write down why, and let telemetry change it later."
 *
 * So this module does not pick one. `heartbeatSeconds` is `null` until somebody
 * decides, and `planProgressWrite` refuses heartbeat events while it is null,
 * with the reason `heartbeat_interval_not_configured`. That is louder than a
 * default and much louder than a comment: a default of 30 would be indefensible
 * research inherited from an example, and within a month it would be quoted back
 * as though it had been chosen.
 *
 * The event-driven writes are NOT open. Pause, settled seek and end are the
 * three moments where losing the position is directly visible to the viewer, so
 * they are unconditional and are not subject to the interval at all.
 *
 * WHY COALESCING IS HERE AND REDIS IS NOT. The research calls client-side write
 * coalescing "the first lever" and refuses Redis write-behind until a PostgreSQL
 * problem has been MEASURED. Coalescing costs one pure function and no
 * operational surface; Redis costs replay semantics, reconciliation and a window
 * of writes that `appendfsync everysec` can still lose. This file is the cheap
 * lever, taken first.
 * ---------------------------------------------------------------------- */

/**
 * A moment at which the player might report progress.
 *
 * `seek_settled`, not `seek`: a scrub produces dozens of intermediate positions
 * and writing each one would both hammer the database and store a position the
 * viewer never actually watched from. The player decides when a seek has
 * settled; this module only decides what to do once it has.
 */
export type ProgressEventKind =
  | "heartbeat"
  | "pause"
  | "seek_settled"
  | "playback_ended"
  | "buffering_started";

export interface ProgressReportingPolicy {
  /**
   * Seconds between heartbeats, or `null` for "not decided yet".
   *
   * Null is the shipped value. See the header: inventing a number and
   * presenting it as settled is the specific failure this design avoids.
   */
  readonly heartbeatSeconds: number | null;
  /**
   * Minimum seconds of position change before a HEARTBEAT is worth sending.
   *
   * The coalescing lever. A paused-but-not-reported player and a player sitting
   * on a menu produce heartbeats whose position has not moved, and writing them
   * is pure load. Event-driven writes ignore this entirely -- a pause at the
   * same position as the last heartbeat is still worth recording, because it is
   * the position the viewer will return to.
   */
  readonly minimumPositionDeltaSeconds: number;
}

/**
 * The shipped policy: event-driven writes on, heartbeat undecided.
 *
 * Exported as a named constant rather than inlined so that the day somebody
 * decides the interval, the decision is one edit in one place with one reason
 * comment attached to it.
 */
export const UNDECIDED_PROGRESS_REPORTING_POLICY: ProgressReportingPolicy = {
  heartbeatSeconds: null,
  minimumPositionDeltaSeconds: 5
};

export type ProgressWriteDecisionReason =
  /** An event whose loss is directly visible to the viewer. Always written. */
  | "viewer_visible_event"
  /** A heartbeat that has moved far enough to be worth a row. */
  | "heartbeat_due"
  /** No interval has been chosen, so heartbeats are not sent at all. */
  | "heartbeat_interval_not_configured"
  /**
   * Too soon since the last write. Kept distinct from
   * `position_delta_below_threshold` because the remedies differ: this one says
   * the INTERVAL is doing its job, that one says the interval fired and the
   * viewer had not moved.
   */
  | "heartbeat_not_due"
  /** The position has not moved enough since the last write. Coalesced away. */
  | "position_delta_below_threshold"
  /** Buffering is a playback-quality signal for `@liberty/observability`, not a progress write. */
  | "event_does_not_report_progress";

export interface ProgressWriteDecision {
  readonly write: boolean;
  readonly reason: ProgressWriteDecisionReason;
}

/**
 * Decide whether one player event should produce a progress write.
 *
 * Pure, and takes `secondsSinceLastWrite` and `positionSeconds` as explicit
 * inputs rather than reading a clock or holding state. That is what lets a test
 * drive a whole viewing session as a list of events with no timers, and it is
 * why this function can live in a package that has no player in it.
 */
export function planProgressWrite(input: {
  readonly policy: ProgressReportingPolicy;
  readonly event: ProgressEventKind;
  readonly positionSeconds: number;
  readonly lastWrittenPositionSeconds: number | null;
  readonly secondsSinceLastWrite: number;
}): ProgressWriteDecision {
  const { policy, event, positionSeconds, lastWrittenPositionSeconds, secondsSinceLastWrite } = input;

  if (event === "buffering_started") {
    return { write: false, reason: "event_does_not_report_progress" };
  }

  if (event !== "heartbeat") {
    // Pause, settled seek and end. Unconditional: these are the three moments
    // where a lost position is something the viewer notices, and no amount of
    // coalescing is worth resuming a film in the wrong place.
    return { write: true, reason: "viewer_visible_event" };
  }

  if (policy.heartbeatSeconds === null) {
    return { write: false, reason: "heartbeat_interval_not_configured" };
  }

  if (secondsSinceLastWrite < policy.heartbeatSeconds) {
    return { write: false, reason: "heartbeat_not_due" };
  }

  if (lastWrittenPositionSeconds !== null) {
    const delta = Math.abs(positionSeconds - lastWrittenPositionSeconds);
    // Absolute, not signed. A heartbeat that moved BACKWARDS by more than the
    // threshold is a real change worth recording; a signed comparison would
    // silently drop the position of a viewer who rewound and then paused
    // outside the event path.
    if (delta < policy.minimumPositionDeltaSeconds) {
      return { write: false, reason: "position_delta_below_threshold" };
    }
  }

  return { write: true, reason: "heartbeat_due" };
}
