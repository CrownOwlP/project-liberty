import { FAST_CHECK_SEED } from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type StoredWatchlistEntry,
  type WatchlistMutationIntent,
  resolveWatchlistMutation
} from "./watchlist-mutation";

/**
 * Watchlist convergence, as properties (PL-0404).
 *
 * The example suite fixes the scenarios somebody thought of. This one fixes the
 * INVARIANT that has to survive a sequence nobody pictured, because a watchlist
 * is exactly the shape that produces those: two devices, an unreliable network,
 * and a toggle that can be pressed any number of times in any order.
 *
 * Three invariants, and each is a defect stated in advance:
 *
 *   1. NO CLOCK IS AUTHORITY. Varying the instant must not change any verdict.
 *      This is the property "latest client timestamp wins" cannot have, and it
 *      is what keeps `added_at` DATA rather than becoming a tiebreak.
 *   2. THE FINAL STATE IS A FUNCTION OF THE LAST MUTATION ONLY. Whatever the
 *      history, "on the list" after an add and "off it" after a remove. A
 *      counter-based rule -- the set-shaped version of the rejected
 *      monotonic-position rule -- fails this the first time a viewer adds,
 *      removes, and adds again.
 *   3. REPLAYING A MUTATION CHANGES NOTHING. Idempotence stated over arbitrary
 *      sequences rather than over the one double-tap somebody tested.
 *
 * The seed is pinned by importing `@liberty/contracts/testing/arbitraries`,
 * whose import side effect is `fc.configureGlobal`. `LIBERTY_FC_SEED` widens the
 * search without an edit.
 */

const readableInstant = fc
  .date({ min: new Date("2000-01-01T00:00:00.000Z"), max: new Date("2100-01-01T00:00:00.000Z") })
  .filter((value) => !Number.isNaN(value.getTime()));

/**
 * `addedAt` includes `null`, because "a row exists and we did not read when it
 * was added" is a real state the repository produces on the `ON CONFLICT DO
 * NOTHING` path -- not an edge case invented for the generator. Excluding it
 * would let a future edit substitute a value for the unknown and still pass.
 */
const storedArb: fc.Arbitrary<StoredWatchlistEntry | null> = fc.option(
  fc.record({
    addedAt: fc.option(readableInstant.map((value) => value.toISOString()), { nil: null })
  }),
  { nil: null }
);

const mutationArb: fc.Arbitrary<WatchlistMutationIntent> = fc.oneof(
  readableInstant.map((instant): WatchlistMutationIntent => ({ kind: "add", instant })),
  fc.constant<WatchlistMutationIntent>({ kind: "remove" })
);

/** Apply one mutation and return the entry as it now stands. Refusals are not expected here. */
function apply(
  stored: StoredWatchlistEntry | null,
  mutation: WatchlistMutationIntent
): StoredWatchlistEntry | null {
  const resolution = resolveWatchlistMutation({ stored, mutation });
  if (!resolution.accepted) throw new Error(`unexpected refusal: ${resolution.reason}`);
  return resolution.next;
}

describe("the property suite is reproducible", () => {
  it("runs under the repository's pinned seed", () => {
    expect(fc.readConfigureGlobal().seed).toBe(FAST_CHECK_SEED);
  });
});

describe("resolveWatchlistMutation is independent of every clock", () => {
  it("reaches the same verdict whatever moment an add is stamped with", () => {
    fc.assert(
      fc.property(storedArb, readableInstant, readableInstant, (stored, first, second) => {
        const a = resolveWatchlistMutation({ stored, mutation: { kind: "add", instant: first } });
        const b = resolveWatchlistMutation({ stored, mutation: { kind: "add", instant: second } });

        expect(a.accepted).toBe(b.accepted);
        expect(a.reason).toBe(b.reason);
      })
    );
  });

  it("reaches the same verdict whatever the stored entry's own addedAt says", () => {
    fc.assert(
      fc.property(
        fc.option(readableInstant.map((v) => v.toISOString()), { nil: null }),
        fc.option(readableInstant.map((v) => v.toISOString()), { nil: null }),
        mutationArb,
        (firstAddedAt, secondAddedAt, mutation) => {
          const a = resolveWatchlistMutation({ stored: { addedAt: firstAddedAt }, mutation });
          const b = resolveWatchlistMutation({ stored: { addedAt: secondAddedAt }, mutation });

          // `added_at` is the list's SORT KEY and nothing else. A future "the
          // newer add wins" tiebreak would fail here immediately.
          expect(a.accepted).toBe(b.accepted);
          expect(a.reason).toBe(b.reason);
        }
      )
    );
  });

  it("refuses an add whose instant names no moment, whatever the stored entry is", () => {
    fc.assert(
      fc.property(storedArb, (stored) => {
        const resolution = resolveWatchlistMutation({
          stored,
          mutation: { kind: "add", instant: new Date(Number.NaN) }
        });

        expect(resolution.accepted).toBe(false);
        if (resolution.accepted) return;
        expect(resolution.reason).toBe("instant_not_representable");
      })
    );
  });
});

describe("convergence over an arbitrary sequence of taps", () => {
  it("ends on the list if and only if the last mutation was an add", () => {
    fc.assert(
      fc.property(
        storedArb,
        fc.array(mutationArb, { minLength: 1, maxLength: 8 }),
        (initial, mutations) => {
          const final = mutations.reduce(apply, initial);
          const last = mutations[mutations.length - 1];

          // Stated over a whole sequence rather than one pair, because the
          // defect being excluded -- a rule that privileges one direction of
          // travel -- only shows up on add/remove/add.
          expect(final !== null).toBe(last?.kind === "add");
        }
      )
    );
  });

  it("is unchanged by replaying the last mutation any number of times", () => {
    fc.assert(
      fc.property(
        storedArb,
        fc.array(mutationArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        (initial, mutations, replays) => {
          const once = mutations.reduce(apply, initial);
          const last = mutations[mutations.length - 1];
          if (last === undefined) return;

          let replayed = once;
          for (let attempt = 0; attempt < replays; attempt += 1) {
            replayed = apply(replayed, last);
          }

          // A retried request, a double tap and a replayed offline queue are all
          // this. Including `addedAt`: a re-add that moved the entry to the top
          // would show up here as a difference.
          expect(replayed).toEqual(once);
        }
      )
    );
  });

  it("never reports changed:true without changing the membership", () => {
    fc.assert(
      fc.property(storedArb, mutationArb, (stored, mutation) => {
        const resolution = resolveWatchlistMutation({ stored, mutation });
        if (!resolution.accepted) return;

        const wasPresent = stored !== null;
        const isPresent = resolution.next !== null;
        // `changed` is what telemetry counts. A `changed` that is not tied to a
        // real membership transition makes every dashboard built on it a lie.
        expect(resolution.changed).toBe(wasPresent !== isPresent);
      })
    );
  });

  it("never invents an addedAt for an entry it did not add", () => {
    fc.assert(
      fc.property(storedArb, mutationArb, (stored, mutation) => {
        const resolution = resolveWatchlistMutation({ stored, mutation });
        if (!resolution.accepted) return;
        if (resolution.reason !== "already_present") return;

        // The unknown stays unknown, and a known value stays exactly itself.
        expect(resolution.next.addedAt).toBe(stored?.addedAt ?? null);
      })
    );
  });
});
