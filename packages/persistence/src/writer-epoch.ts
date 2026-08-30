/* -------------------------------------------------------------------------
 * Two devices, one title: the server-issued writer epoch (PL-0403)
 *
 * The situation: a viewer starts an episode on the television, pauses, picks it
 * up on a phone, and the television -- still open, still buffering, still on a
 * heartbeat -- sends a progress write. Which position is the truth?
 *
 * BOTH OBVIOUS ANSWERS ARE WRONG, and the research says so explicitly.
 *
 *   1. "Latest client timestamp wins." A client clock is a value the client
 *      controls and routinely gets wrong -- a device an hour fast wins every
 *      argument forever, and a device an hour slow can never write again.
 *      Packets also reorder in flight, so even honest clocks arrive out of
 *      order. This is deriving a fact (who is current) from something that
 *      merely correlates with it (what a device thinks the time is).
 *
 *   2. "Position must increase monotonically." This one is worse, because it
 *      looks conservative and is actually a product bug: it refuses a REWIND.
 *      A viewer who skips back thirty seconds to re-hear a line has their
 *      correct, deliberate, current-device write rejected as stale.
 *
 * THE ANSWER: the SERVER issues a writer epoch. When a device begins playing a
 * title it asks for a lease; the server increments the epoch stored against
 * `(profileId, contentId)` and hands back `{ epoch, writerId }`. Every
 * subsequent write echoes that pair. The server then compares the echoed epoch
 * against the one it stored -- comparing a value it issued against a value it
 * issued -- and the newest lease wins by construction.
 *
 * WHY IT BEATS BOTH:
 *   - Against timestamps: no clock is read anywhere in this module. Ordering
 *     comes from a counter the server allocated, so skew and reordering cannot
 *     change the outcome. An out-of-order packet from a superseded writer is
 *     rejected because of WHO sent it, not when.
 *   - Against monotonic position: `positionSeconds` is not a term in the
 *     authority decision at all. The current writer may move the position
 *     backwards as far as it likes. The only thing that loses is a STALE
 *     writer, at any position.
 *
 * AND THE THIRD PROBLEM NEITHER ADDRESSES: two packets from the SAME device can
 * still reorder, and they carry the same epoch and writer. `writeSeq` -- a
 * counter monotonic within one epoch -- resolves that. It is not a position
 * rule: a rewind carries a HIGHER sequence number, so it is still accepted. It
 * is compared only against writes from the same writer, so it can never refuse a
 * legitimate seek.
 *
 * PURE. No clock, no I/O, no randomness. The instant is an explicit input and is
 * used only to STAMP the resulting row: it is never a term in any comparison
 * between the stored row and the write, so no two writes can be ordered by it.
 * The tests assert that by varying it and requiring the decision to be unchanged.
 *
 * The single exception is the instant deciding about ITSELF. An instant that
 * names no moment -- `new Date(x)` on anything that is not a date yields an
 * Invalid Date silently, and `x` routinely comes from a header or from parsed
 * JSON -- is refused by name, because the alternative is a `RangeError` thrown
 * from the middle of this function and arriving at a request handler as a 500
 * with no reason trail, which is the one outcome the whole reasoned-refusal
 * design exists to prevent. Refusing is also the only safe answer: substituting
 * "now" would mean reading a clock, which is exactly what this module does not
 * do, and would make the stamp a fiction nobody could later distinguish from a
 * real one.
 * ---------------------------------------------------------------------- */

/** A lease. Both halves are server-issued; a client may echo them but not choose them. */
export interface WriterLease {
  readonly epoch: number;
  readonly writerId: string;
}

/** The stored row, as the resolver needs to see it. */
export interface StoredProgress {
  /**
   * The last position reported, or `null` when the title has been leased and no
   * position has ever been reported for it.
   *
   * NULL IS NOT ZERO. A lease creates the row; it does not report a position.
   * Defaulting the missing value to 0 here would make the resolver claim
   * `position_moved_backwards` on the very first real write of every title,
   * because every position is "behind" a zero that nobody ever watched.
   */
  readonly positionSeconds: number | null;
  readonly runtimeSeconds: number | null;
  readonly writerEpoch: number;
  readonly writerId: string;
  readonly writeSeq: number;
  /** Present so the resolver can carry it forward. Never read to decide anything. */
  readonly updatedAt: string;
}

/**
 * An incoming write.
 *
 * NOTE WHAT IS ABSENT: there is no client timestamp field, and there is nowhere
 * to put one. A client cannot assert when it thinks the write happened, so no
 * future edit can start believing it by accident. That absence is asserted by a
 * test, because a field added "just for diagnostics" is how the rejected design
 * comes back.
 */
export interface ProgressWrite {
  readonly lease: WriterLease;
  readonly writeSeq: number;
  readonly positionSeconds: number;
  readonly runtimeSeconds: number | null;
}

/** Why a write was refused. */
export type ProgressWriteRejection =
  /**
   * The instant to stamp the row with names no moment. Not the client's fault
   * and not the client's field: this is the caller handing over an Invalid Date
   * or an unrecognisable string, and it is reported separately so that it is
   * never mistaken for a verdict about the write itself.
   */
  | "instant_not_representable"
  /** No row, so no lease was ever issued. Ask for one; do not write blind. */
  | "no_writer_lease"
  /**
   * The claimed epoch is HIGHER than any the server issued. The anti-forgery
   * check: without it, "send a large number" would be a way to seize authority,
   * and the whole scheme would reduce to trusting a client-supplied counter.
   */
  | "epoch_not_issued"
  /** A newer lease exists. The classic second-device case; the old device stops here. */
  | "superseded_by_newer_writer"
  /** Right epoch, wrong writer. Makes the epoch a pair rather than a guessable integer. */
  | "writer_id_mismatch"
  /** Same writer, out-of-order packet. Not a position rule -- see the header. */
  | "stale_write_within_writer"
  /** Not a whole, finite, non-negative number of seconds. */
  | "position_not_representable"
  /** Past the end of a runtime the write itself states. */
  | "position_beyond_runtime";

/** Why a write was accepted. Accepted decisions are explained too. */
export type ProgressWriteAcceptance = "current_writer";

/**
 * Something worth recording that did not change the verdict.
 *
 * A grant that quietly discarded information is as hard to debug as an
 * unexplained denial, so the discard is stated.
 */
export type ProgressWriteNote =
  /**
   * The write reported no runtime while the stored row knew one, so the known
   * value was kept. An unknown must not overwrite a known -- the same rule
   * PL-0205 applies to media facts, and the reason a null here would otherwise
   * make a title's completion percentage vanish.
   */
  | "retained_known_runtime"
  /** The write restated the runtime differently; the write's value won. */
  | "runtime_restated"
  /** The accepted position is BEHIND the stored one. Legitimate, and worth saying so. */
  | "position_moved_backwards"
  /**
   * The stored row had no position at all -- it was created by a lease and this
   * is the first write to report one.
   *
   * Stated rather than left silent because it is the note that distinguishes
   * "unknown became known" from "0 became 40", and those look identical the
   * moment anybody starts reading a null as a zero. It is also mutually
   * exclusive with `position_moved_backwards`, which is the assertion that keeps
   * the two apart.
   */
  | "position_first_reported";

export interface ProgressWriteCheck {
  readonly check: ProgressWriteRejection;
  readonly passed: boolean;
}

export type ProgressWriteResolution =
  | {
      readonly accepted: true;
      readonly reason: ProgressWriteAcceptance;
      readonly next: StoredProgress;
      readonly notes: readonly ProgressWriteNote[];
      readonly trail: readonly ProgressWriteCheck[];
    }
  | {
      readonly accepted: false;
      readonly reason: ProgressWriteRejection;
      readonly trail: readonly ProgressWriteCheck[];
    };

/**
 * Check precedence, exported because it is a tested guarantee.
 *
 * AUTHORITY BEFORE VALIDITY, deliberately. A superseded television sending a
 * nonsensical position should be reported as superseded: we are not going to
 * store its value whatever it says, and "position beyond runtime" would send an
 * engineer looking at the media pipeline instead of at the handoff.
 *
 * `instant_not_representable` sits AHEAD of authority, which looks like a
 * violation of that rule and is not. The rule orders checks on values the CLIENT
 * asserted, so that a device which has lost the lease is told it lost the lease.
 * The instant is not one of those: it is the server's own stamp, so an
 * unreadable one is a defect in this process, and reporting it as
 * `superseded_by_newer_writer` would hide our bug behind a description of a
 * handoff that is working perfectly.
 */
export const PROGRESS_WRITE_CHECK_ORDER = [
  "instant_not_representable",
  "no_writer_lease",
  "epoch_not_issued",
  "superseded_by_newer_writer",
  "writer_id_mismatch",
  "stale_write_within_writer",
  "position_not_representable",
  "position_beyond_runtime"
] as const satisfies readonly ProgressWriteRejection[];

/** The first epoch a title is ever leased at. Epochs start at 1 so that 0 can mean "never leased". */
export const FIRST_WRITER_EPOCH = 1;

/**
 * Allocate the next lease for a title.
 *
 * Pure: the caller applies the returned epoch inside the same statement that
 * reads the old one (`ON CONFLICT DO UPDATE SET writer_epoch = writer_epoch + 1`),
 * so two devices asking simultaneously are serialised by PostgreSQL and get
 * distinct epochs. Computing the increment here and then writing it in a
 * separate statement WOULD be a lost-update race; `progress-repository.ts` does
 * not do that, and this function exists to make the arithmetic testable rather
 * than to be the thing that performs it.
 */
export function nextWriterEpoch(stored: StoredProgress | null): number {
  return (stored?.writerEpoch ?? 0) + 1;
}

/** Whether a position is a value this system can store and resume from. */
function isRepresentablePosition(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= 0;
}

/**
 * The stamp a write would carry, or `null` when the caller supplied something
 * that names no moment.
 *
 * `new Date(x)` never throws and never reports failure -- it returns an Invalid
 * Date whose `getTime()` is `NaN` -- so a header that was not a date, a JSON
 * field that was a number, and a typo all arrive looking exactly like a
 * timestamp. The failure surfaces only when something calls `toISOString()`,
 * which throws `RangeError` from wherever that call happens to be. Converting
 * once, here, is what turns an exception thrown deep in a resolver into a value
 * the caller can branch on.
 *
 * A string must already be in the canonical `toISOString()` spelling. Refusing
 * `2026-08-21T20:00:00Z` -- which `Date` parses happily -- is deliberate:
 * `updatedAt` is carried verbatim onto the row and handed to clients, so
 * admitting a second spelling means two rows recorded at the same moment stop
 * comparing equal as strings, and every such comparison in tests and clients
 * becomes subtly wrong.
 *
 * Exported because `issueWriterLease` needs the same answer and must not have a
 * second opinion about it: a lease that accepts an instant the following write
 * refuses would let a device hold a lease it can never use.
 */
export function representableInstant(instant: string | Date): string | null {
  if (instant instanceof Date) {
    return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
  }
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString() === instant ? instant : null;
}

/**
 * Decide whether an incoming write may replace the stored row.
 *
 * `instant` is the caller's stamp, as a `Date` or as a canonical ISO-8601
 * string. It is put on the resulting row and is read by no comparison in this
 * function. If it names no moment the write is refused rather than stamped, and
 * that is the only influence it has on any outcome.
 */
export function resolveProgressWrite(input: {
  readonly stored: StoredProgress | null;
  readonly write: ProgressWrite;
  readonly instant: string | Date;
}): ProgressWriteResolution {
  const { stored, write } = input;
  const trail: ProgressWriteCheck[] = [];

  const reject = (reason: ProgressWriteRejection): ProgressWriteResolution => {
    trail.push({ check: reason, passed: false });
    return { accepted: false, reason, trail };
  };
  const pass = (check: ProgressWriteRejection): void => {
    trail.push({ check, passed: true });
  };

  // Resolved before anything is decided, so that a caller whose clock source is
  // broken learns that, rather than learning whichever verdict this write would
  // have earned anyway. See the precedence note above for why this one check
  // runs ahead of authority.
  const instant = representableInstant(input.instant);
  if (instant === null) return reject("instant_not_representable");
  pass("instant_not_representable");

  if (stored === null) return reject("no_writer_lease");
  pass("no_writer_lease");

  if (write.lease.epoch > stored.writerEpoch) return reject("epoch_not_issued");
  pass("epoch_not_issued");

  if (write.lease.epoch < stored.writerEpoch) return reject("superseded_by_newer_writer");
  pass("superseded_by_newer_writer");

  if (write.lease.writerId !== stored.writerId) return reject("writer_id_mismatch");
  pass("writer_id_mismatch");

  // `<=` rather than `<`: a replayed packet carries the sequence number it
  // already used, and re-applying it would resurrect a position the viewer has
  // since moved past.
  if (write.writeSeq <= stored.writeSeq) return reject("stale_write_within_writer");
  pass("stale_write_within_writer");

  if (!isRepresentablePosition(write.positionSeconds)) return reject("position_not_representable");
  pass("position_not_representable");

  const notes: ProgressWriteNote[] = [];
  // The runtime that will actually be STORED, resolved before the range check
  // so that the check and the `COALESCE` in `progress-repository.ts` agree. If
  // they disagreed, the pure resolver would accept a position that the
  // `playback_progress_position_within_runtime` CHECK constraint then rejects,
  // turning a reasoned refusal into a database exception.
  let runtimeSeconds: number | null;
  if (write.runtimeSeconds === null && stored.runtimeSeconds !== null) {
    runtimeSeconds = stored.runtimeSeconds;
    notes.push("retained_known_runtime");
  } else if (write.runtimeSeconds !== null && write.runtimeSeconds !== stored.runtimeSeconds) {
    runtimeSeconds = write.runtimeSeconds;
    notes.push("runtime_restated");
  } else {
    runtimeSeconds = write.runtimeSeconds;
  }

  if (runtimeSeconds !== null && write.positionSeconds > runtimeSeconds) {
    return reject("position_beyond_runtime");
  }
  pass("position_beyond_runtime");

  // Guarded on the stored position being KNOWN. The first write after a lease
  // has nothing to have moved backwards from, and comparing against a null
  // coerced to 0 would report every one of them as a rewind -- a note that fires
  // on every title's first write is a note nobody reads by the second week.
  if (stored.positionSeconds === null) {
    notes.push("position_first_reported");
  } else if (write.positionSeconds < stored.positionSeconds) {
    notes.push("position_moved_backwards");
  }

  return {
    accepted: true,
    reason: "current_writer",
    next: {
      positionSeconds: write.positionSeconds,
      runtimeSeconds,
      writerEpoch: stored.writerEpoch,
      writerId: stored.writerId,
      writeSeq: write.writeSeq,
      updatedAt: instant
    },
    // Sorted so that the note list is a set with a stable rendering rather than
    // an artefact of the order the branches happen to run in.
    notes: [...notes].sort(),
    trail
  };
}
