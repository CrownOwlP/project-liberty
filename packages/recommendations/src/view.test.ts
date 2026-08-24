import { describe, expect, it } from "vitest";
import { sealEligibility } from "./eligibility";
import type { CandidateGenerator } from "./generator";
import { recommend } from "./recommend";
import { PERMITTED_VIEW_MEMBERS, buildView } from "./view";
import type { RecommendationView } from "./view";
import {
  eligibleVerdict,
  facts,
  ineligibleVerdict,
  progress,
  request,
  type RequestParts
} from "./testing/fixtures";

/* -------------------------------------------------------------------------
 * Acceptance clause: candidate generation may see ONLY the active profile's
 * explicit watchlist, that profile's progress and completion state, catalog
 * metadata, and already-resolved eligibility.
 *
 * These tests assert the constraint where it lives — on the input TYPE and the
 * strict schema — rather than checking that today's generators happen to behave.
 * A generator is free to read anything it is handed; the guarantee is about what
 * it is handed.
 * ---------------------------------------------------------------------- */

function viewFor(parts: RequestParts): RecommendationView {
  return buildView(
    {
      watchlist: [...(parts.watchlist ?? [])],
      progress: [...(parts.progress ?? [])],
      catalog: [...(parts.catalog ?? [])]
    },
    sealEligibility(parts.eligibility ?? [])
  ).view;
}

/** Records exactly what it was called with, and produces nothing. */
function probe(): { generator: CandidateGenerator; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const generator: CandidateGenerator = {
    id: "probe",
    generate(...args) {
      calls.push([...args]);
      return [];
    }
  };
  return { generator, calls };
}

describe("the view exposes exactly the four permitted inputs", () => {
  it("has no member outside the permitted list", () => {
    /*
     * Asserted against `PERMITTED_VIEW_MEMBERS`, which the module exports, so a
     * field added to `RecommendationView` without being added there fails here.
     * A local copy of the list would drift and the test would keep passing.
     */
    const view = viewFor({ eligibility: [eligibleVerdict("alpha")], catalog: [facts("alpha")] });
    expect(Object.keys(view).sort()).toEqual([...PERMITTED_VIEW_MEMBERS].sort());
  });

  it("carries no profile identity, account, device or demographic anywhere in it", () => {
    const view = viewFor({
      eligibility: [eligibleVerdict("alpha")],
      watchlist: ["alpha"],
      progress: [progress("alpha")],
      catalog: [facts("alpha")]
    });

    const keys = [
      ...Object.keys(view),
      ...view.progress.flatMap((entry) => Object.keys(entry)),
      ...view.catalog.flatMap((entry) => Object.keys(entry))
    ];

    for (const key of keys) {
      expect(key).not.toMatch(/profile|account|user|email|age|gender|device|ipaddress|session|search/i);
    }
  });

  it("gives catalog facts no rights, provider or stream field", () => {
    /*
     * Rights are an eligibility input and eligibility is already resolved. A
     * generator that can read the rights basis can branch on it, and the next
     * reviewer then has to prove that branch is not a second, weaker rights
     * decision at the one layer that must not make one.
     */
    const view = viewFor({ eligibility: [eligibleVerdict("alpha")], catalog: [facts("alpha")] });
    expect(Object.keys(view.catalog[0] ?? {}).sort()).toEqual([
      "contentId",
      "genre",
      "kind",
      "releaseYear",
      "title"
    ]);
  });

  it("gives progress entries only position, runtime and completion", () => {
    const view = viewFor({
      eligibility: [eligibleVerdict("alpha")],
      progress: [progress("alpha")],
      catalog: [facts("alpha")]
    });
    expect(Object.keys(view.progress[0] ?? {}).sort()).toEqual([
      "completed",
      "contentId",
      "positionSeconds",
      "runtimeSeconds"
    ]);
  });
});

describe("a generator receives the view and nothing else", () => {
  it("is called once, with one argument", () => {
    /*
     * Arity is checked as well as the call log, because a second parameter added
     * to `CandidateGenerator.generate` is exactly how a profile id or a clock
     * gets in later, and it would be a compiling, reviewable-looking change.
     */
    const { generator, calls } = probe();
    recommend(request({ eligibility: [eligibleVerdict("alpha")], catalog: [facts("alpha")] }), [generator]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it("cannot mutate what it was handed", () => {
    /*
     * A generator that mutated the view would make every later generator's
     * output depend on generator order, in a way the ranking comparator cannot
     * see and no permutation property would catch.
     */
    const view = viewFor({
      eligibility: [eligibleVerdict("alpha")],
      watchlist: ["alpha"],
      progress: [progress("alpha")],
      catalog: [facts("alpha")]
    });

    expect(Object.isFrozen(view)).toBe(true);
    /*
     * Widened in two CHECKED steps rather than through `unknown`. `push` is the
     * point of the assertion, and a `readonly` array does not have one, so some
     * widening is unavoidable here -- but `EligibleContentId` is `string & {
     * [brand] }`, so `readonly EligibleContentId[]` -> `readonly string[]` is a
     * real subtype relation and only the `readonly` is asserted away. Going via
     * `as unknown as` would compile just as well and would keep compiling if the
     * member's element type were later changed to something that is not a
     * string, which is the one edit this line should notice.
     */
    expect(() => (view.watchlist as readonly string[] as string[]).push("beta-two")).toThrow(
      TypeError
    );
    expect(() => {
      (view as unknown as { watchlist: unknown[] }).watchlist = [];
    }).toThrow(TypeError);
  });

  it("never sees an id upstream refused", () => {
    const view = viewFor({
      eligibility: [eligibleVerdict("alpha"), ineligibleVerdict("gamma")],
      watchlist: ["alpha", "gamma"],
      progress: [progress("gamma")],
      catalog: [facts("alpha"), facts("gamma")]
    });

    expect(view.watchlist).toEqual(["alpha"]);
    expect(view.progress).toEqual([]);
    expect(view.catalog.map((entry) => entry.contentId)).toEqual(["alpha"]);
    expect(view.eligibleIds).toEqual(["alpha"]);
  });
});

describe("the request schema refuses to widen what this package processes", () => {
  it.each<[string, Record<string, unknown>]>([
    ["profileId", { profileId: "p-1" }],
    ["email", { email: "someone@example.com" }],
    ["ageBracket", { ageBracket: "25-34" }],
    ["searchHistory", { searchHistory: ["heist films"] }]
  ])("rejects a request carrying %s", (_label, extra) => {
    expect(() =>
      recommend({ ...request({ eligibility: [eligibleVerdict("alpha")], catalog: [facts("alpha")] }), ...extra })
    ).toThrow();
  });

  it("rejects an extra field smuggled inside a catalog entry", () => {
    /*
     * Strictness at the top level alone would be defeated by widening a nested
     * record, which is the shape this would actually arrive in — a provider
     * adapter adding one more field to the metadata it already sends.
     */
    expect(() =>
      recommend(
        request({
          eligibility: [eligibleVerdict("alpha")],
          catalog: [{ ...facts("alpha"), viewerAgeBracket: "25-34" } as never]
        })
      )
    ).toThrow();
  });

  it("rejects two progress records for the same work", () => {
    /*
     * Rejected rather than reduced, because there is no defensible winner: a
     * profile has one position in one work, and picking the last one seen would
     * hand the view to input order.
     */
    expect(() =>
      recommend(
        request({
          eligibility: [eligibleVerdict("alpha")],
          progress: [progress("alpha", { positionSeconds: 10 }), progress("alpha", { positionSeconds: 20 })],
          catalog: [facts("alpha")]
        })
      )
    ).toThrow();
  });
});
