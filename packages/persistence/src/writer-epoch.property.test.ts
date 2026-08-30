import { FAST_CHECK_SEED } from "@liberty/contracts/testing/arbitraries";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ProgressWrite, type StoredProgress, resolveProgressWrite } from "./writer-epoch";

/**
 * Determinism and clock-independence of the writer epoch, as properties.
 *
 * The example tests fix one scenario at a time. These fix the INVARIANT, which
 * is the part that regresses quietly: a future edit that reaches for
 * `updatedAt` to break a tie, or that starts comparing positions to decide
 * authority, passes every example test written above and fails here.
 *
 * Six order-dependence defects in this codebase so far. The `instant` and
 * `updatedAt` generators below are the guard against the seventh.
 *
 * THE SEED IS PINNED by importing `@liberty/contracts/testing/arbitraries`,
 * whose import side effect is `fc.configureGlobal`. This file previously ran
 * UNPINNED -- the one property suite in the repository that did -- which meant
 * its counterexamples were not reproducible, and a property suite whose failures
 * cannot be reproduced gets retried until it passes. `LIBERTY_FC_SEED` widens
 * the search without an edit.
 */

describe("the property suite is reproducible", () => {
  it("runs under the repository's pinned seed", () => {
    // Asserted rather than assumed. The pin is an import SIDE EFFECT, so a
    // tidy-up that removes the "unused" import silently unpins the whole file,
    // and nothing else here would notice.
    expect(fc.readConfigureGlobal().seed).toBe(FAST_CHECK_SEED);
  });
});

const writerId = fc.constantFrom("writer_tv", "writer_phone", "writer_tablet");
/**
 * Invalid Date is IN RANGE and stays in range.
 *
 * `fc.date()` emits `new Date(NaN)` alongside the moments in `[min, max]`
 * unless `noInvalidDate` is set, and setting it is the tempting non-fix: it
 * makes this file green by deleting the input that found the defect. An Invalid
 * Date is what `new Date(header)` and `new Date(jsonField)` return for anything
 * they cannot read, so it is exactly the input a request can carry.
 */
const instant = fc.date({ min: new Date("2000-01-01T00:00:00.000Z"), max: new Date("2100-01-01T00:00:00.000Z") });

const isReadable = (value: Date): boolean => !Number.isNaN(value.getTime());

/**
 * Total, because `toISOString()` is not.
 *
 * The stored row's `updatedAt` is carried and never parsed, so an unreadable one
 * must not change any verdict -- and generating one is how that is proved.
 * Mapping straight through `toISOString()` would instead throw during
 * GENERATION, which reports as a failure of whichever property happened to draw
 * it and says nothing about the resolver.
 */
const stamp = (value: Date): string => (isReadable(value) ? value.toISOString() : "not-a-timestamp");

const storedArb: fc.Arbitrary<StoredProgress> = fc.record({
  /**
   * NULL IS IN RANGE. A row created by `issueWriterLease` has no position yet,
   * so "leased, nothing reported" is a real stored state and not an edge case
   * invented for the generator. Excluding it would let a future edit read the
   * null as a zero and still pass this file.
   */
  positionSeconds: fc.option(fc.integer({ min: 0, max: 20000 }), { nil: null }),
  runtimeSeconds: fc.option(fc.integer({ min: 1, max: 20000 }), { nil: null }),
  writerEpoch: fc.integer({ min: 1, max: 50 }),
  writerId,
  writeSeq: fc.integer({ min: 0, max: 500 }),
  updatedAt: instant.map(stamp)
});

const writeArb: fc.Arbitrary<ProgressWrite> = fc.record({
  lease: fc.record({ epoch: fc.integer({ min: 1, max: 50 }), writerId }),
  writeSeq: fc.integer({ min: 0, max: 500 }),
  positionSeconds: fc.integer({ min: 0, max: 20000 }),
  runtimeSeconds: fc.option(fc.integer({ min: 1, max: 20000 }), { nil: null })
});

describe("resolveProgressWrite is independent of every clock", () => {
  it("reaches the same verdict whatever moment it is called at", () => {
    fc.assert(
      fc.property(storedArb, writeArb, instant, instant, (stored, write, first, second) => {
        // Both instants must NAME a moment for this comparison to mean
        // anything. Two instants that name different moments must agree; an
        // instant that names none is not a different moment, it is a broken
        // argument, and the property below is the one that covers it.
        fc.pre(isReadable(first) && isReadable(second));

        const a = resolveProgressWrite({ stored, write, instant: first });
        const b = resolveProgressWrite({ stored, write, instant: second });

        expect(a.accepted).toBe(b.accepted);
        expect(a.reason).toBe(b.reason);
        expect(a.trail).toEqual(b.trail);
        // The ONLY thing the instant may influence is the stamp on the row it
        // produces. If any other field differs, a clock has reached a decision.
        if (a.accepted && b.accepted) {
          expect({ ...a.next, updatedAt: null }).toEqual({ ...b.next, updatedAt: null });
          expect(a.next.updatedAt).toBe(first.toISOString());
        }
      })
    );
  });

  it("refuses an instant that names no moment, whatever the write says", () => {
    // The counterexample that found the defect, kept as a property. Before the
    // fix this threw `RangeError: Invalid time value` out of a pure resolver --
    // a 500 with no reason trail, on input a client can produce by sending a
    // date-shaped field that is not a date.
    fc.assert(
      fc.property(fc.option(storedArb, { nil: null }), writeArb, (stored, write) => {
        const resolution = resolveProgressWrite({ stored, write, instant: new Date(Number.NaN) });

        expect(resolution.accepted).toBe(false);
        if (resolution.accepted) return;
        // By name, and the SAME name every time: an unreadable stamp is a defect
        // in the caller, so it must not be reported as whatever verdict the
        // write would otherwise have earned.
        expect(resolution.reason).toBe("instant_not_representable");
      })
    );
  });

  it("reaches the same verdict whatever the stored row's own timestamp says", () => {
    fc.assert(
      fc.property(storedArb, writeArb, instant, (stored, write, other) => {
        const a = resolveProgressWrite({ stored, write, instant: "2026-01-01T00:00:00.000Z" });
        const b = resolveProgressWrite({
          stored: { ...stored, updatedAt: stamp(other) },
          write,
          instant: "2026-01-01T00:00:00.000Z"
        });

        // `updatedAt` on the stored row is carried, not consulted. A future
        // "last write wins" tiebreak would fail here immediately.
        expect(a.accepted).toBe(b.accepted);
        expect(a.reason).toBe(b.reason);
      })
    );
  });
});

describe("the current writer may always move the position, in either direction", () => {
  it("accepts any representable position from the lease holder with a fresh sequence", () => {
    fc.assert(
      fc.property(
        storedArb,
        fc.integer({ min: 0, max: 20000 }),
        fc.integer({ min: 1, max: 100 }),
        (anyStored, positionSeconds, seqAdvance) => {
          // Runtime removed from BOTH sides, so no position can be out of
          // range. This property is about AUTHORITY, and leaving a value check
          // in would make a failure ambiguous between the two.
          const stored = { ...anyStored, runtimeSeconds: null };
          const write: ProgressWrite = {
            lease: { epoch: stored.writerEpoch, writerId: stored.writerId },
            writeSeq: stored.writeSeq + seqAdvance,
            positionSeconds,
            runtimeSeconds: null
          };

          const resolution = resolveProgressWrite({
            stored,
            write,
            instant: "2026-01-01T00:00:00.000Z"
          });

          // No position, however far backwards, may be refused. This is the
          // rejected monotonic rule, stated as the property it violates.
          expect(resolution.accepted).toBe(true);
        }
      )
    );
  });
});

describe("an unknown stored position is never read as a zero", () => {
  it("reports the first write as first-reported and never as a rewind", () => {
    fc.assert(
      fc.property(
        storedArb,
        fc.integer({ min: 0, max: 20000 }),
        fc.integer({ min: 1, max: 100 }),
        (anyStored, positionSeconds, seqAdvance) => {
          const stored = { ...anyStored, positionSeconds: null, runtimeSeconds: null };
          const resolution = resolveProgressWrite({
            stored,
            write: {
              lease: { epoch: stored.writerEpoch, writerId: stored.writerId },
              writeSeq: stored.writeSeq + seqAdvance,
              positionSeconds,
              runtimeSeconds: null
            },
            instant: "2026-01-01T00:00:00.000Z"
          });

          expect(resolution.accepted).toBe(true);
          if (!resolution.accepted) return;
          // The defect stated as a property: a null read as 0 makes exactly the
          // writes with `positionSeconds === 0` look like rewinds and the rest
          // look ordinary, so a single example could miss it either way.
          expect(resolution.notes).toContain("position_first_reported");
          expect(resolution.notes).not.toContain("position_moved_backwards");
        }
      )
    );
  });

  it("never claims both first-reported and moved-backwards at once", () => {
    fc.assert(
      fc.property(storedArb, writeArb, (stored, write) => {
        const resolution = resolveProgressWrite({
          stored,
          write,
          instant: "2026-01-01T00:00:00.000Z"
        });
        if (!resolution.accepted) return;
        const both =
          resolution.notes.includes("position_first_reported") &&
          resolution.notes.includes("position_moved_backwards");
        expect(both).toBe(false);
      })
    );
  });
});

describe("authority is decided only by the epoch pair and the sequence", () => {
  it("never accepts a write whose epoch differs from the stored one", () => {
    fc.assert(
      fc.property(storedArb, writeArb, (stored, write) => {
        fc.pre(write.lease.epoch !== stored.writerEpoch);
        const resolution = resolveProgressWrite({
          stored,
          write,
          instant: "2026-01-01T00:00:00.000Z"
        });

        expect(resolution.accepted).toBe(false);
        expect(["epoch_not_issued", "superseded_by_newer_writer"]).toContain(resolution.reason);
      })
    );
  });

  it("never accepts a write from a writer that does not hold the stored epoch", () => {
    fc.assert(
      fc.property(storedArb, writeArb, (stored, write) => {
        fc.pre(write.lease.writerId !== stored.writerId);
        const resolution = resolveProgressWrite({
          stored,
          write,
          instant: "2026-01-01T00:00:00.000Z"
        });
        expect(resolution.accepted).toBe(false);
      })
    );
  });
});
