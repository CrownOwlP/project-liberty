import { describe, expect, it } from "vitest";
import {
  WATCHLIST_MUTATION_OUTCOMES,
  type StoredWatchlistEntry,
  resolveWatchlistMutation
} from "./watchlist-mutation";

/**
 * Watchlist mutation policy (PL-0404).
 *
 * The rule these tests pin is argued in `watchlist-mutation.ts`: server arrival
 * order decides, no client value is authority, and the four outcomes are named
 * rather than reduced to a boolean. What is worth stating here is what each test
 * is actually defending:
 *
 *   - IDEMPOTENCE IS NOT ENOUGH ON ITS OWN. "Add twice is one row" was the whole
 *     of the previous story, and it is silent about an add racing a remove. The
 *     tests below cover both directions of that race explicitly.
 *   - A RE-ADD MUST NOT REORDER. `added_at` is when the title went on the list,
 *     and the entry is the list's sort key. Rewriting it moves an entry the
 *     viewer never touched.
 *   - AN UNREADABLE INSTANT IS REFUSED BY NAME. `new Date(header)` returns an
 *     Invalid Date for anything it cannot read, and that value used to reach the
 *     driver.
 *
 * No database is involved and none would help: every rule here is a function of
 * one stored entry and one intent. The SQL that ENFORCES the same rules is in
 * `watchlist-repository.ts` and is untestable without PostgreSQL.
 */

const INSTANT = "2026-08-21T20:00:00.000Z";
const EARLIER = "2026-08-01T09:30:00.000Z";

const present = (addedAt: string | null = EARLIER): StoredWatchlistEntry => ({ addedAt });

describe("add", () => {
  it("adds a title that is not on the list", () => {
    const resolution = resolveWatchlistMutation({
      stored: null,
      mutation: { kind: "add", instant: INSTANT }
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.reason).toBe("added");
    expect(resolution.changed).toBe(true);
    expect(resolution.next?.addedAt).toBe(INSTANT);
  });

  it("is idempotent, and says which of the two happened", () => {
    const resolution = resolveWatchlistMutation({
      stored: present(),
      mutation: { kind: "add", instant: INSTANT }
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    // Both answers, because they answer different questions: the UI wants "it is
    // on the list now" and telemetry wants "did this request do anything".
    expect(resolution.reason).toBe("already_present");
    expect(resolution.changed).toBe(false);
  });

  it("does not move an existing entry to the top of the list", () => {
    // The reorder defect. A double tap, a retried request and a replayed offline
    // queue all arrive as a second add, and any of them silently reordering the
    // list is a change the viewer did not make and cannot undo.
    const resolution = resolveWatchlistMutation({
      stored: present(EARLIER),
      mutation: { kind: "add", instant: INSTANT }
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next?.addedAt).toBe(EARLIER);
  });

  it("keeps an unknown addedAt unknown rather than substituting the write's instant", () => {
    // `ON CONFLICT DO NOTHING ... RETURNING` proves a row exists without saying
    // when it was added, so the repository passes `addedAt: null`. Filling that
    // in with `INSTANT` would fabricate a first-added time wrong by however long
    // the entry has really been on the list -- and that value is the sort key.
    const resolution = resolveWatchlistMutation({
      stored: present(null),
      mutation: { kind: "add", instant: INSTANT }
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next?.addedAt).toBeNull();
  });

  it.each([
    { name: "an Invalid Date", instant: new Date(Number.NaN) },
    { name: "a Date built from a header that was not one", instant: new Date("last Tuesday") },
    { name: "a string that names no moment", instant: "not-a-timestamp" },
    { name: "an empty string", instant: "" },
    { name: "a second spelling of a readable moment", instant: "2026-08-21T20:00:00Z" }
  ])("refuses $name rather than throwing", ({ instant }) => {
    const resolution = resolveWatchlistMutation({ stored: null, mutation: { kind: "add", instant } });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("instant_not_representable");
    expect(resolution.detail.length).toBeGreaterThan(0);
  });

  it("refuses an unreadable instant even when the title is already on the list", () => {
    // Precedence, and it matters. Resolving presence first would report
    // `already_present` whenever the row happens to exist, so the caller's broken
    // date would surface only on the requests where it does not -- an
    // intermittent failure that reproduces on an empty list and nowhere else.
    const resolution = resolveWatchlistMutation({
      stored: present(),
      mutation: { kind: "add", instant: new Date(Number.NaN) }
    });

    expect(resolution.accepted).toBe(false);
    if (resolution.accepted) return;
    expect(resolution.reason).toBe("instant_not_representable");
  });

  it("accepts a Date and stamps the canonical spelling", () => {
    const resolution = resolveWatchlistMutation({
      stored: null,
      mutation: { kind: "add", instant: new Date(INSTANT) }
    });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.next?.addedAt).toBe(INSTANT);
  });
});

describe("remove", () => {
  it("removes a title that is on the list", () => {
    const resolution = resolveWatchlistMutation({ stored: present(), mutation: { kind: "remove" } });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.reason).toBe("removed");
    expect(resolution.changed).toBe(true);
    expect(resolution.next).toBeNull();
  });

  it("treats removing something absent as a success", () => {
    // Not a 404. The caller is a button behind an unreliable network, and a
    // retried remove must converge rather than fail.
    const resolution = resolveWatchlistMutation({ stored: null, mutation: { kind: "remove" } });

    expect(resolution.accepted).toBe(true);
    if (!resolution.accepted) return;
    expect(resolution.reason).toBe("not_present");
    expect(resolution.changed).toBe(false);
  });

  // There is deliberately no "remove with an unreadable instant" case: the
  // remove intent has no instant field, so the state is unrepresentable rather
  // than merely untested. A parameter accepted and ignored is one somebody
  // eventually populates and expects to matter, which is how `removed_at`
  // becomes a client-supplied clock.
});

describe("the add/remove race, which a primary key does not resolve", () => {
  it("lets a remove that reaches the server after an add win", () => {
    // Device A added; device B's remove arrives second and takes effect. Arrival
    // order is the order of record -- see the header of `watchlist-mutation.ts`
    // for why that is the only ordering available that is not a client clock.
    const afterAdd = resolveWatchlistMutation({
      stored: null,
      mutation: { kind: "add", instant: INSTANT }
    });
    expect(afterAdd.accepted).toBe(true);
    if (!afterAdd.accepted) return;

    const afterRemove = resolveWatchlistMutation({
      stored: afterAdd.next,
      mutation: { kind: "remove" }
    });
    expect(afterRemove.accepted).toBe(true);
    if (!afterRemove.accepted) return;
    expect(afterRemove.reason).toBe("removed");
    expect(afterRemove.next).toBeNull();
  });

  it("lets an add that reaches the server after a remove win", () => {
    // The mirror image, and the one the offline-replay limitation is about: this
    // outcome is CORRECT when the add is a fresh intent and WRONG when it is a
    // stale one flushed from a queue. The server cannot tell them apart, which
    // is why the fix is named as the client's and not pretended to be here.
    const afterRemove = resolveWatchlistMutation({
      stored: present(),
      mutation: { kind: "remove" }
    });
    expect(afterRemove.accepted).toBe(true);
    if (!afterRemove.accepted) return;

    const afterAdd = resolveWatchlistMutation({
      stored: afterRemove.next,
      mutation: { kind: "add", instant: INSTANT }
    });
    expect(afterAdd.accepted).toBe(true);
    if (!afterAdd.accepted) return;
    expect(afterAdd.reason).toBe("added");
  });

  it("nothing in the resolver compares one instant to another", () => {
    // The property that makes "no client clock is authority" true rather than
    // aspirational: an add stamped a decade in the past reaches exactly the same
    // verdict as one stamped today.
    const ancient = resolveWatchlistMutation({
      stored: null,
      mutation: { kind: "add", instant: "1999-12-31T23:59:59.000Z" }
    });
    const recent = resolveWatchlistMutation({
      stored: null,
      mutation: { kind: "add", instant: INSTANT }
    });

    expect(ancient.accepted).toBe(recent.accepted);
    expect(ancient.reason).toBe(recent.reason);
  });
});

describe("the outcome vocabulary", () => {
  it("is exactly four names", () => {
    expect([...WATCHLIST_MUTATION_OUTCOMES].sort()).toEqual([
      "added",
      "already_present",
      "not_present",
      "removed"
    ]);
  });

  it("never returns a bare boolean for any reachable input", () => {
    // Criterion: every refusal and every acceptance explains itself. A `false`
    // with no reason forces the caller to guess which of four things happened.
    const cases = [
      { stored: null, mutation: { kind: "add", instant: INSTANT } },
      { stored: present(), mutation: { kind: "add", instant: INSTANT } },
      { stored: null, mutation: { kind: "remove" } },
      { stored: present(), mutation: { kind: "remove" } },
      { stored: null, mutation: { kind: "add", instant: "nope" } }
    ] as const;

    for (const input of cases) {
      const resolution = resolveWatchlistMutation(input);
      expect(typeof resolution.reason).toBe("string");
      expect(resolution.reason.length).toBeGreaterThan(0);
    }
  });
});
