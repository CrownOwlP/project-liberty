import { describeUnrepresentableInstant } from "./contracts";
import { representableInstant } from "./writer-epoch";

/* -------------------------------------------------------------------------
 * Two devices, one list: what actually decides a watchlist conflict (PL-0404)
 *
 * The progress lane got a server-issued writer epoch and this one did not, and
 * for a while the stated reason was "set membership is idempotent by nature, so
 * the primary key does all the work". That sentence is TRUE OF THE CASES IT
 * NAMES and silent about the one that matters. Two concurrent ADDS converge on
 * one row; two concurrent REMOVES converge on no row. Neither of those is the
 * conflict. The conflict is an ADD racing a REMOVE for the same
 * `(profileId, contentId)` from two devices, and a primary key has nothing to
 * say about it.
 *
 * So the rule is stated here rather than left implicit:
 *
 *   THE ORDER THE SERVER APPLIES THE STATEMENTS IS THE ORDER OF RECORD.
 *   The later statement to reach PostgreSQL wins, and nothing a client asserts
 *   can change that.
 *
 * WHY NOT A WRITER EPOCH, THE WAY PROGRESS DOES IT. Copying it here would be
 * cargo cult. An epoch is worth a round trip when a device emits writes
 * AUTONOMOUSLY and can therefore keep asserting a position long after the viewer
 * left the room -- that is what a heartbeat is, and it is why a superseded
 * television has to be silenced by name. A watchlist mutation is not autonomous:
 * it is one deliberate tap, once. There is no background emitter to supersede.
 * Charging every tap a lease round trip to solve a problem it does not have
 * would double the latency of the most trivial interaction in the product.
 *
 * WHY NOT A CLIENT TIMESTAMP. The same reason as progress, unchanged: a clock is
 * a value the client controls and routinely gets wrong. Note that `added_at`
 * here is NOT one -- it is supplied by the caller, and in this package the
 * caller is the server request handler. Nothing in `@liberty/persistence` calls
 * `new Date()` on its own behalf, so the instant is an explicit argument rather
 * than a hidden clock read, and it is DATA (the list's sort key) rather than
 * AUTHORITY (nothing below compares it to anything).
 *
 * WHY NOT "HIGHEST ADD COUNT WINS", the set-shaped analogue of the rejected
 * monotonic-position rule. It has the same defect for the same reason: it makes
 * one direction of travel privileged. A viewer who adds, removes, and adds again
 * is doing something completely ordinary, and a counter-based rule that refuses
 * the remove because removes do not increase anything is a product bug wearing a
 * consistency argument.
 *
 * WHAT THIS RULE KNOWINGLY DOES NOT COVER -- and it is stated rather than
 * quietly hoped away. Arrival order is the right order when both devices are
 * online. It is the WRONG order for an intent formed OFFLINE and delivered late:
 * the phone queues "add" in a tunnel, the viewer removes the title on the
 * television, the phone surfaces and flushes, and the title comes back. No rule
 * that lives in this table can fix that, because the server has no
 * non-clock evidence that the queued add is older than the remove -- and the
 * device could not have obtained a server-issued token for it, since the whole
 * premise is that it was offline. The fix belongs to the client's offline queue:
 * reconcile against a fresh server read at flush time instead of replaying
 * stale toggles. That is a client task, and naming it here is the point --
 * an unstated limitation is indistinguishable from an unnoticed one.
 * ---------------------------------------------------------------------- */

/**
 * The stored entry, as this resolver needs to see it.
 *
 * `addedAt` is `string | null`, and the null is load-bearing: `null` means
 * "a row exists and we did not read when it was added", which is exactly the
 * state `ON CONFLICT DO NOTHING ... RETURNING` leaves the repository in. The
 * alternative -- substituting the instant of the write that conflicted -- would
 * be inventing a first-added time that is off by however long the entry has
 * really been on the list, and that value is the list's sort key.
 *
 * "No row at all" is the OUTER null (`StoredWatchlistEntry | null`). The two
 * nulls mean different things and are deliberately not collapsed.
 */
export interface StoredWatchlistEntry {
  readonly addedAt: string | null;
}

/**
 * What the caller is trying to do.
 *
 * `add` carries an instant and `remove` does not, rather than both taking one
 * and remove ignoring it. A parameter that is accepted and unused is a parameter
 * somebody will eventually populate with something meaningful and expect to
 * matter -- which is how `removed_at` becomes a client-supplied clock.
 */
export type WatchlistMutationIntent =
  | { readonly kind: "add"; readonly instant: string | Date }
  | { readonly kind: "remove" };

/** Why a mutation was refused. */
export type WatchlistMutationRejection =
  /**
   * The instant to stamp `added_at` with names no moment.
   *
   * Shares its name with the progress refusal because it is the same defect and
   * the same check -- `representableInstant` is imported rather than
   * reimplemented, so the two can never develop a second opinion about what a
   * readable moment is. Without it, `new Date(header)` returning an Invalid Date
   * reaches the driver, which fails serialising it into a timestamp literal, and
   * the tap on the remote comes back as a 500 naming a column.
   */
  "instant_not_representable";

/** What a mutation did. Every one of the four is a distinct, nameable outcome. */
export type WatchlistMutationOutcome = "added" | "already_present" | "removed" | "not_present";

/**
 * The resolution.
 *
 * `changed` and `reason` are both present and are answers to different
 * questions: the UI wants "is it on the list now" (yes for both `added` and
 * `already_present`), and telemetry wants "did this request do anything". They
 * are correlated in the type rather than left as a free boolean so that a
 * `changed: true` cannot be paired with `already_present` by a later edit.
 *
 * `next` is the entry as it stands AFTER the mutation, or `null` for "not on the
 * list". On `already_present` it is the stored entry unchanged -- including its
 * unknown `addedAt`, if that is what was known -- because a re-add must not move
 * the entry to the top of a list the viewer did not reorder.
 */
export type WatchlistMutationResolution =
  | {
      readonly accepted: true;
      readonly reason: "added";
      readonly changed: true;
      readonly next: StoredWatchlistEntry;
    }
  | {
      readonly accepted: true;
      readonly reason: "already_present";
      readonly changed: false;
      readonly next: StoredWatchlistEntry;
    }
  | {
      readonly accepted: true;
      readonly reason: "removed";
      readonly changed: true;
      readonly next: null;
    }
  | {
      readonly accepted: true;
      readonly reason: "not_present";
      readonly changed: false;
      readonly next: null;
    }
  | {
      readonly accepted: false;
      readonly reason: WatchlistMutationRejection;
      readonly detail: string;
    };

/**
 * Every outcome, exported because the set being CLOSED is the guarantee.
 *
 * A caller switching on the reason should fail to compile when a fifth outcome
 * appears, rather than silently falling through to a default that means
 * "something happened".
 */
export const WATCHLIST_MUTATION_OUTCOMES = [
  "added",
  "already_present",
  "removed",
  "not_present"
] as const satisfies readonly WatchlistMutationOutcome[];

/**
 * Resolve one watchlist mutation against the entry as it stood.
 *
 * PURE. No clock, no I/O. As with `resolveProgressWrite`, the ENFORCEMENT is the
 * single SQL statement in `watchlist-repository.ts` -- `ON CONFLICT DO NOTHING`
 * and a guarded `DELETE`, both atomic, neither with a read-modify-write window
 * for a second device to slip into. This function is the EXPLANATION: the same
 * policy expressed where it can be unit-tested without a database, and the one
 * place the four outcome names are produced, so the repository cannot invent a
 * fifth spelling of "nothing happened".
 *
 * The instant is checked FIRST, ahead of the presence branch, and that ordering
 * is deliberate. An unreadable instant is a defect in the caller whichever
 * branch the mutation would have taken; resolving presence first would mean an
 * add with an Invalid Date reports `already_present` whenever the row happens to
 * exist, so the bug appears only on the requests where it does not -- an
 * intermittent 500 that reproduces on an empty list and nowhere else.
 */
export function resolveWatchlistMutation(input: {
  readonly stored: StoredWatchlistEntry | null;
  readonly mutation: WatchlistMutationIntent;
}): WatchlistMutationResolution {
  const { stored, mutation } = input;

  if (mutation.kind === "add") {
    const addedAt = representableInstant(mutation.instant);
    if (addedAt === null) {
      return {
        accepted: false,
        reason: "instant_not_representable",
        // Shared with the writer-lease path rather than spelled out here: see
        // `describeUnrepresentableInstant` for why an echoed value is not a
        // detail, and why one rule with two implementations is the thing to
        // avoid.
        detail: describeUnrepresentableInstant("addedAt", mutation.instant)
      };
    }

    // The FIRST add wins the sort key. Re-adding is not an error and is not a
    // reorder: `added_at` is when the title went on the list, and rewriting it
    // would silently move an entry the viewer never touched to the top.
    if (stored !== null) {
      return { accepted: true, reason: "already_present", changed: false, next: stored };
    }
    return { accepted: true, reason: "added", changed: true, next: { addedAt } };
  }

  // Removing something absent is a success, not a 404. The caller is a button on
  // a remote control behind an unreliable network, and a retried remove must
  // converge rather than fail.
  if (stored === null) {
    return { accepted: true, reason: "not_present", changed: false, next: null };
  }
  return { accepted: true, reason: "removed", changed: true, next: null };
}
