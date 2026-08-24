import { describe, expect, it } from "vitest";
import {
  FIRST_WRITER_EPOCH,
  PROGRESS_WRITE_CHECK_ORDER,
  type ProgressWrite,
  type StoredProgress,
  nextWriterEpoch,
  resolveProgressWrite
} from "./writer-epoch";

/**
 * The writer epoch (PL-0403).
 *
 * The scenario that motivates the whole mechanism, told as tests: a viewer
 * starts an episode on the television, moves to a phone, and the television --
 * still open, still on a heartbeat -- keeps writing.
 *
 * Four properties are under test, and each maps to one of the ways the two
 * REJECTED designs fail:
 *
 *   - NO CLOCK. `instant` may be varied freely, over every moment it can name,
 *     without changing any verdict. This is the property "latest client
 *     timestamp wins" cannot have, and its absence here is why device skew and
 *     packet reordering are irrelevant. The one instant that changes an outcome
 *     is one that names no moment at all, and it produces a refusal rather than
 *     a `RangeError` -- see the `instant_not_representable` cases below.
 *   - REWIND IS LEGAL. The current writer may move the position backwards to
 *     zero and the write is accepted. This is the property "monotonically
 *     increasing position" cannot have, and it is a product bug, not a
 *     theoretical one -- it is a viewer skipping back to re-hear a line.
 *   - AUTHORITY IS NOT CLAIMABLE. A client sending a higher epoch than the
 *     server ever issued is refused. Without this the scheme degenerates into
 *     trusting a client-supplied counter, which is the timestamp design wearing
 *     a different name.
 *   - EXPLAINED. Four distinct denials with four distinct remedies, and an
 *     accepted write that says what it discarded.
 *
 * No database is involved and none is needed: every rule above is a function of
 * two records. The SQL guard in `progress-repository.ts` expresses the same
 * rules and is NOT tested here, because a test of it without PostgreSQL would
 * be a test of a stub.
 */

const TELEVISION = "writer_television";
const PHONE = "writer_phone";
const INSTANT = "2026-08-21T20:00:00.000Z";

const stored = (over: Partial<StoredProgress> = {}): StoredProgress => ({
  positionSeconds: 600,
  runtimeSeconds: 5400,
  writerEpoch: 4,
  writerId: TELEVISION,
  writeSeq: 12,
  updatedAt: "2026-08-21T19:59:00.000Z",
  ...over
});

const write = (over: Partial<ProgressWrite> = {}): ProgressWrite => ({
  lease: { epoch: 4, writerId: TELEVISION },
  writeSeq: 13,
  positionSeconds: 660,
  runtimeSeconds: 5400,
  ...over
});

describe("nextWriterEpoch", () => {
  it("starts at 1 so that 0 can mean never leased", () => {
    expect(nextWriterEpoch(null)).toBe(FIRST_WRITER_EPOCH);
  });

  it("increments the stored epoch", () => {
    expect(nextWriterEpoch(stored({ writerEpoch: 41 }))).toBe(42);
  });
});

describe("resolveProgressWrite -- the current writer", () => {
  it("accepts a write from the current lease holder", () => {
    const resolution = resolveProgressWrite({ stored: stored(), write: write(), instant: INSTANT });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.reason).toBe("current_writer");
    expect(resolution.next.positionSeconds).toBe(660);
    expect(resolution.next.updatedAt).toBe(INSTANT);
  });

  it("accepts a REWIND from the current writer, all the way to zero", () => {
    // The single most important assertion in this file. A monotonic-position
    // rule refuses this write, and refusing it is a user-visible defect: the
    // viewer skipped back thirty seconds and the player will resume from where
    // they skipped FROM.
    const resolution = resolveProgressWrite({
      stored: stored({ positionSeconds: 3000 }),
      write: write({ positionSeconds: 0 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next.positionSeconds).toBe(0);
    // And it says so, because a position that moved backwards is worth seeing
    // in a trail even though it is entirely legitimate.
    expect(resolution.notes).toContain("position_moved_backwards");
  });

  it("keeps a known runtime when the write reports none", () => {
    // PL-0205's rule: an unknown must not overwrite a known. A null here would
    // make the title's completion percentage disappear for no reason other than
    // that one heartbeat did not happen to carry the duration.
    const resolution = resolveProgressWrite({
      stored: stored({ runtimeSeconds: 5400 }),
      write: write({ runtimeSeconds: null }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next.runtimeSeconds).toBe(5400);
    expect(resolution.notes).toContain("retained_known_runtime");
  });

  it("refuses a position past the RETAINED runtime, not just a restated one", () => {
    // The write states no runtime, so the stored one survives -- and the range
    // check must be made against the value that will actually be stored.
    // Checking only the write's runtime would let this row through the resolver
    // and then be refused by the CHECK constraint, turning a reasoned denial
    // into a database exception nobody can act on.
    const resolution = resolveProgressWrite({
      stored: stored({ runtimeSeconds: 5400 }),
      write: write({ runtimeSeconds: null, positionSeconds: 6000 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("position_beyond_runtime");
  });

  it("takes a restated runtime and says it did", () => {
    const resolution = resolveProgressWrite({
      stored: stored({ runtimeSeconds: 5400 }),
      write: write({ runtimeSeconds: 5401, positionSeconds: 10 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next.runtimeSeconds).toBe(5401);
    expect(resolution.notes).toContain("runtime_restated");
  });
});

describe("resolveProgressWrite -- two devices", () => {
  it("refuses the television once the phone has taken the lease", () => {
    // The phone asked for a lease, so the server incremented the epoch to 5.
    // The television is still on epoch 4 and still sending heartbeats.
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 5, writerId: PHONE, writeSeq: 0, positionSeconds: 700 }),
      write: write({ lease: { epoch: 4, writerId: TELEVISION }, positionSeconds: 610 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("superseded_by_newer_writer");
  });

  it("refuses the television even when its position is AHEAD of the phone's", () => {
    // Position is not a term in the authority decision. The stale device being
    // further into the episode does not make it current -- it makes it a device
    // that kept playing to an empty room.
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 5, writerId: PHONE, writeSeq: 0, positionSeconds: 100 }),
      write: write({ lease: { epoch: 4, writerId: TELEVISION }, positionSeconds: 5000 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("superseded_by_newer_writer");
  });

  it("refuses a client that invents a higher epoch than the server issued", () => {
    // Anti-forgery. If this passed, "send a big number" would be a way to seize
    // authority and the epoch would be no better than a client timestamp.
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 4 }),
      write: write({ lease: { epoch: 9999, writerId: PHONE } }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("epoch_not_issued");
  });

  it("refuses the right epoch held by the wrong writer", () => {
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 4, writerId: TELEVISION }),
      write: write({ lease: { epoch: 4, writerId: PHONE } }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("writer_id_mismatch");
  });

  it("refuses a write with no lease at all", () => {
    const resolution = resolveProgressWrite({ stored: null, write: write(), instant: INSTANT });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("no_writer_lease");
  });
});

describe("resolveProgressWrite -- one device, reordered packets", () => {
  it.each([
    { name: "a replayed packet", writeSeq: 12 },
    { name: "a packet that overtook a newer one", writeSeq: 11 }
  ])("refuses $name from the current writer", ({ writeSeq }) => {
    // Same epoch, same writer -- so the epoch cannot resolve this. The
    // per-writer sequence can, and it does so WITHOUT looking at position,
    // which is what stops it from becoming the monotonic-position rule by
    // another route.
    const resolution = resolveProgressWrite({
      stored: stored({ writeSeq: 12 }),
      write: write({ writeSeq }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("stale_write_within_writer");
  });

  it("still accepts a rewind carried by a NEWER sequence number", () => {
    // The proof that the sequence rule is not a position rule in disguise.
    const resolution = resolveProgressWrite({
      stored: stored({ writeSeq: 12, positionSeconds: 3000 }),
      write: write({ writeSeq: 13, positionSeconds: 20 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(true);
  });
});

describe("resolveProgressWrite -- values and explanation", () => {
  it.each([
    { name: "a negative position", positionSeconds: -1, reason: "position_not_representable" },
    { name: "a fractional position", positionSeconds: 12.5, reason: "position_not_representable" },
    { name: "NaN", positionSeconds: Number.NaN, reason: "position_not_representable" },
    { name: "a position past the stated runtime", positionSeconds: 99999, reason: "position_beyond_runtime" }
  ])("refuses $name with $reason", ({ positionSeconds, reason }) => {
    const resolution = resolveProgressWrite({
      stored: stored(),
      write: write({ positionSeconds }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe(reason);
  });

  it.each([
    { name: "an Invalid Date", instant: new Date(Number.NaN) },
    { name: "a Date built from a header that was not one", instant: new Date("last Tuesday") },
    { name: "a string that names no moment", instant: "not-a-timestamp" },
    { name: "an empty string", instant: "" }
  ])("refuses $name rather than throwing", ({ instant }) => {
    // The defect this pins: every one of these reaches `toISOString()` looking
    // like a timestamp and leaves it as a `RangeError`, thrown from inside a
    // pure resolver and surfacing in a request handler as a 500 with no reason
    // trail. `new Date(someHeader)` and `new Date(someJsonField)` both produce
    // an Invalid Date silently, so this is reachable from real input, not a
    // property-test curiosity.
    const resolution = resolveProgressWrite({ stored: stored(), write: write(), instant });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("instant_not_representable");
  });

  it("blames the instant, not the handoff, when the writer is ALSO superseded", () => {
    // The one place this check outranks authority. A stamp we could not read is
    // a defect in the caller that built it, and calling it
    // `superseded_by_newer_writer` would send an engineer to read handoff code
    // that is working exactly as designed.
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 9, writerId: PHONE }),
      write: write({ lease: { epoch: 4, writerId: TELEVISION } }),
      instant: new Date(Number.NaN)
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("instant_not_representable");
  });

  it("takes a Date and stamps the row with its canonical spelling", () => {
    const resolution = resolveProgressWrite({
      stored: stored(),
      write: write(),
      instant: new Date(INSTANT)
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next.updatedAt).toBe(INSTANT);
  });

  it("refuses a second spelling of a moment it can otherwise read", () => {
    // `2026-08-21T20:00:00Z` parses, and is the same instant. It is still
    // refused, because `updatedAt` is carried verbatim to clients and two rows
    // written at one moment must not stop comparing equal as strings.
    const resolution = resolveProgressWrite({
      stored: stored(),
      write: write(),
      instant: "2026-08-21T20:00:00Z"
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("instant_not_representable");
  });

  it("reports the AUTHORITY failure when a superseded writer also sends nonsense", () => {
    // Precedence matters here: reporting `position_beyond_runtime` would send
    // an engineer to look at the media pipeline, when the actual event is a
    // device that has been handed off and does not know it.
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 9, writerId: PHONE }),
      write: write({ lease: { epoch: 4, writerId: TELEVISION }, positionSeconds: -50 }),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("superseded_by_newer_writer");
  });

  it("runs its checks in the published precedence order", () => {
    const resolution = resolveProgressWrite({ stored: stored(), write: write(), instant: INSTANT });
    expect(resolution.trail.map((entry) => entry.check)).toEqual([...PROGRESS_WRITE_CHECK_ORDER]);
  });

  it("ends every denial trail on the check that failed", () => {
    const resolution = resolveProgressWrite({
      stored: stored({ writerEpoch: 9 }),
      write: write(),
      instant: INSTANT
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.trail.at(-1)).toEqual({
      check: "superseded_by_newer_writer",
      passed: false
    });
  });

  it("offers a write no place to assert a client timestamp", () => {
    // Structural, and worth the assertion: the rejected design comes back the
    // day somebody adds `clientTime` "just for diagnostics", because the next
    // person to read the resolver assumes a field that exists is a field that
    // is used.
    const keys = Object.keys(write()).sort();
    expect(keys).toEqual(["lease", "positionSeconds", "runtimeSeconds", "writeSeq"]);
  });
});
