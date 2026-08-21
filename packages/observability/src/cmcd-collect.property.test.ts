/* -------------------------------------------------------------------------
 * Determinism is treated as correctness here
 *
 * Six order-dependence defects in this repository so far, so the claim under
 * test is the strong one: `collectCmcdEventReport` is a function of the CONTENT
 * of a report and of nothing about the order it arrived in. Not "the same
 * fields are present" — the same whole result, byte for byte, which is why
 * every assertion below compares serialised output rather than using `toEqual`.
 * `toEqual` compares objects structurally and would pass while the field order
 * inside a record silently drifted, and field order is exactly what a log
 * pipeline diffs on.
 *
 * WHY EXHAUSTIVE PERMUTATION RATHER THAN fast-check. The repository's property
 * suites use fast-check with the pinned seed and shared arbitraries in
 * `@liberty/contracts/testing/arbitraries`. Reaching for either from this
 * package means declaring a new devDependency in
 * `packages/observability/package.json`, and that desyncs `package-lock.json`,
 * which CI installs from with `npm ci` — a root-level file this task does not
 * own. So the permutation is enumerated instead. For the specific property
 * being asserted that is not a compromise but a strengthening: `permutations`
 * below covers ALL 720 orderings of a six-key record rather than sampling a
 * hundred, and a counterexample needs no shrinking because every case is
 * already minimal. Widening to generated reports is a follow-up, and it wants
 * fast-check.
 * ---------------------------------------------------------------------- */

import { describe, expect, it } from "vitest";
import { collectCmcdEventReport, type CmcdCollectionResult } from "./cmcd-collect";

const RECEIVED_AT = 1_700_000_000_000;

const SIGNED =
  "https://cdn.example.com/movies/northstar/1080p/seg-000012.m4s?Signature=SECRET-SIGNATURE";

/** Every ordering of `items`, in a fixed order that does not itself matter. */
function permutations<Item>(items: readonly Item[]): Item[][] {
  if (items.length <= 1) return [[...items]];

  const out: Item[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const head = items[index] as Item;
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

function serialise(result: CmcdCollectionResult): string {
  return JSON.stringify(result, null, 2);
}

function collect(events: readonly Record<string, unknown>[]): string {
  return serialise(
    collectCmcdEventReport({
      payload: { events },
      receivedAtMs: RECEIVED_AT,
      requestId: "req-1"
    })
  );
}

/** Rebuilds a record with its keys inserted in `order`. */
function withKeyOrder(
  order: readonly string[],
  values: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of order) record[key] = values[key];
  return record;
}

describe("permutation invariance", () => {
  it("does not depend on the order a decoder walked one event's keys in", () => {
    // Deliberately mixed: a good value, a refused one, a redacted one, a token
    // that routes the classification, and an unknown key. Each takes a
    // different branch, so an order dependence in any one of them shows up.
    const values: Record<string, unknown> = {
      msd: 1500,
      ltc: 1.5,
      dfa: Number.NaN,
      url: SIGNED,
      sta: "r",
      e: "ps"
    };
    const keys = Object.keys(values);
    const expected = collect([withKeyOrder(keys, values)]);

    for (const order of permutations(keys)) {
      expect(collect([withKeyOrder(order, values)]), order.join(",")).toBe(expected);
    }
  });

  it("does not depend on the order the events arrived in", () => {
    // A batch that is retried, re-merged or reordered in flight is the ordinary
    // case rather than the exotic one — the CMCD reporter retries on 429 and on
    // any 5xx.
    const events: Record<string, unknown>[] = [
      { e: "ps", sta: "s", ts: 1_700_000_000_100, msd: 1500 },
      { e: "bc", ts: 1_700_000_000_200 },
      { e: "e", ec: ["HTTP_ERROR"], ts: 1_700_000_000_300 },
      { e: "t", ts: 1_700_000_000_400, ltc: 4000 }
    ];
    const expected = collect(events);

    for (const order of permutations(events)) {
      expect(collect(order), order.map((event) => event["e"]).join(",")).toBe(expected);
    }
  });

  it("orders events with no timestamp by content rather than by arrival", () => {
    // `ts` is optional, so the sort needs a tiebreak that is still a function
    // of the events themselves. Without one these three would come back in
    // whatever order they were posted in.
    const events: Record<string, unknown>[] = [{ msd: 3000 }, { msd: 1000 }, { msd: 2000 }];
    const expected = collect(events);

    for (const order of permutations(events)) {
      expect(collect(order)).toBe(expected);
    }
  });

  it("is stable for a batch of identical events, which a retry produces", () => {
    const events: Record<string, unknown>[] = [{ msd: 1500 }, { msd: 1500 }, { msd: 1500 }];
    const expected = collect(events);

    for (const order of permutations(events)) {
      expect(collect(order)).toBe(expected);
    }
  });

  it("is invariant under permuting keys and events at the same time", () => {
    const shapes: Record<string, unknown>[] = [
      { e: "ps", sta: "r", ts: 1_700_000_000_100 },
      { e: "bc", ts: 1_700_000_000_200, br: [{ value: 4000, objectType: "v" }] },
      { url: SIGNED, ttfb: 40, e: "rr" }
    ];
    const expected = collect(shapes);

    for (const eventOrder of permutations(shapes)) {
      for (const shape of eventOrder) {
        const keyOrders = permutations(Object.keys(shape));
        for (const keyOrder of keyOrders) {
          const rebuilt = eventOrder.map((event) =>
            event === shape ? withKeyOrder(keyOrder, event) : event
          );
          expect(collect(rebuilt)).toBe(expected);
        }
      }
    }
  });

  it("aggregates rejections into an order-independent tally", () => {
    // The rejection list is part of the result, so it is covered by the
    // properties above — but it is the part most likely to be rebuilt as a
    // per-event list later, and this pins why it must not be.
    const events: Record<string, unknown>[] = [
      { msd: 1.5 },
      { nrr: "0-1023" },
      { msd: Number.NaN },
      { "acme-thing": 1 }
    ];
    const expected = collect(events);

    for (const order of permutations(events)) {
      expect(collect(order)).toBe(expected);
    }
  });
});
