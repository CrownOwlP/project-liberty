import { MAX_LIST_LENGTH, permutationKeysArb, permute } from "@liberty/contracts/testing/arbitraries";
import { SEARCH_QUERY_MAX_LENGTH, normalizeSearchQuery } from "@liberty/contracts/domains/search";
import type { Arbitrary } from "fast-check";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  NOTHING_TRIMMED,
  SEARCH_ROUTE,
  SEARCH_SYNC_HISTORY_LIMIT,
  buildSearchHref,
  createSearchSyncState,
  latestRequestedQuery,
  recordSearchCommit,
  reconcileSearchQuery,
  type SearchSyncState
} from "./search-sync";

/**
 * Search synchronisation properties (fast-check).
 *
 * `search-sync.test.ts` pins the interleavings somebody thought of. This file
 * pins the ones nobody did, which is the only honest way to cover a state
 * machine whose entire reason for existing is that renders can arrive in an
 * order the author did not picture. Every defect this suite was written after —
 * a URL builder that threw on a truncated astral character, a bounded log that
 * turned overflow into an external navigation, an already-answered request that
 * made the back button unreachable — was invisible to an example suite that
 * looked complete.
 *
 * The seed is pinned by importing `@liberty/contracts/testing/arbitraries`,
 * which calls `fc.configureGlobal` on first import. An unpinned property suite
 * fails on one CI run in forty with a counterexample nobody can reproduce, and
 * a test that cannot be reproduced gets retried until it passes.
 *
 * There is no clock and no I/O in `search-sync.ts`, so nothing here is
 * time-dependent and no counterexample can be a flake.
 */

/**
 * Any single UTF-16 CODE UNIT, unpaired surrogate halves included.
 *
 * fast-check v4's `unit: "binary"` generates code POINTS and documents that it
 * excludes half surrogate pairs — so the string arbitraries it builds are always
 * well-formed and could not have produced the input that broke
 * `buildSearchHref`. Generating raw code units is the whole point: a lone
 * surrogate is the one input class `encodeURIComponent` refuses.
 */
const codeUnitArb: Arbitrary<string> = fc
  .integer({ min: 0x0000, max: 0xffff })
  .map((unit) => String.fromCharCode(unit));

/** One astral character, i.e. TWO UTF-16 code units. */
const GRINNING = String.fromCodePoint(0x1f600);

/**
 * Strings that straddle the length cap with an astral character.
 *
 * Random generation reaches this eventually and only eventually: the cap is at
 * 128 code units and the failing case needs a surrogate pair to land on exactly
 * that boundary. Aiming at it directly turns "would have found it in a few
 * thousand runs" into "finds it in the first few".
 */
const capBoundaryArb: Arbitrary<string> = fc
  .integer({ min: SEARCH_QUERY_MAX_LENGTH - 4, max: SEARCH_QUERY_MAX_LENGTH + 2 })
  .map((padding) => `${"a".repeat(padding)}${GRINNING}bbb`);

const anyQueryTextArb: Arbitrary<string> = fc.oneof(
  fc.string({ unit: codeUnitArb, maxLength: 260 }),
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ maxLength: 40 }),
  capBoundaryArb
);

describe("buildSearchHref is total", () => {
  it("never throws, for any sequence of UTF-16 code units", () => {
    /*
     * THE BLOCKER, stated as the property that would have caught it.
     *
     * `encodeURIComponent` throws `URIError` on an unpaired surrogate, and the
     * previous truncation could manufacture one out of a perfectly ordinary
     * emoji. The throw landed inside a debounce callback — after the commit had
     * been recorded — so the reconciler was left believing it had asked for a
     * query it never navigated to, and the search field went on accepting
     * typing and never moved again, with nothing rendered and no boundary hit.
     */
    fc.assert(
      fc.property(anyQueryTextArb, (raw) => {
        expect(() => buildSearchHref(raw)).not.toThrow();
      })
    );
  });

  it("produces an address a URL parser reads back as the normalized query", () => {
    // Totality is not enough on its own: a function that returned a constant
    // would also never throw. The address has to still MEAN the query, with
    // every character that would otherwise be structure carried as a value.
    fc.assert(
      fc.property(anyQueryTextArb, (raw) => {
        const normalized = normalizeSearchQuery(raw);
        const url = new URL(buildSearchHref(raw), "https://liberty.test");

        expect(url.pathname).toBe(SEARCH_ROUTE);
        // An empty query addresses the bare route: no `?q=` at all, because a
        // blank parameter reads as a search that ran and matched nothing.
        expect(url.searchParams.get("q")).toBe(normalized === "" ? null : normalized);
      })
    );
  });

  it("stays inside the contract's length cap however the query is spelled", () => {
    fc.assert(
      fc.property(anyQueryTextArb, (raw) => {
        expect(normalizeSearchQuery(raw).length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_LENGTH);
      })
    );
  });
});

/* -------------------------------------------------------------------------
 * Interleavings.
 * ---------------------------------------------------------------------- */

type Step =
  | { readonly kind: "commit"; readonly query: string }
  | { readonly kind: "render"; readonly query: string };

/**
 * A deliberately NARROW query pool.
 *
 * The interesting states of this machine are the ones where the same string was
 * committed twice, or rendered after being superseded, or navigated back to
 * from outside. A wide pool makes every collision astronomically unlikely and
 * the whole out-of-order region unreachable — the suite would then only prove
 * that distinct queries behave distinctly. The prefixes are what a real typist
 * produces, and `""` is in the pool because the idle state is a query too.
 */
const scriptQueryArb: Arbitrary<string> = fc.constantFrom(
  "",
  "a",
  "au",
  "aur",
  "aurora",
  "the fall",
  "northstar"
);

const stepArb: Arbitrary<Step> = fc.oneof(
  scriptQueryArb.map((query) => ({ kind: "commit" as const, query })),
  scriptQueryArb.map((query) => ({ kind: "render" as const, query }))
);

/**
 * Scripts long enough to overflow the history bound.
 *
 * `SEARCH_SYNC_HISTORY_LIMIT + MAX_LIST_LENGTH` rather than a comfortable
 * length, because the branch this suite most needs to reach is the one that only
 * exists AFTER the log has trimmed something — and a generator that never
 * overflows would leave the trimmed-render decision permanently unexercised
 * while reporting full coverage of everything else.
 */
const scriptArb: Arbitrary<Step[]> = fc.array(stepArb, {
  maxLength: SEARCH_SYNC_HISTORY_LIMIT + MAX_LIST_LENGTH * 2
});

const initialQueryArb: Arbitrary<string> = fc.oneof(scriptQueryArb, anyQueryTextArb);

/**
 * Freeze a state so an attempted in-place edit is a thrown TypeError.
 *
 * Modules are strict mode, so writing through a frozen reference throws rather
 * than failing silently — which turns "the transition function mutated its
 * argument" from something a later assertion might notice into something the
 * offending line reports itself.
 */
function deepFreeze(state: SearchSyncState): SearchSyncState {
  for (const commit of state.commits) Object.freeze(commit);
  Object.freeze(state.commits);
  return Object.freeze(state);
}

/**
 * A structurally identical, independently allocated copy.
 *
 * Used to state "the input was not modified" as a comparison against something
 * captured before the call rather than against the input itself, which would be
 * vacuous. Written out rather than reaching for `structuredClone` so the copy is
 * plainly readable here and does not depend on a host global.
 */
function createReplica(state: SearchSyncState): SearchSyncState {
  return {
    commits: state.commits.map((commit) => ({ ...commit })),
    appliedEpoch: state.appliedEpoch,
    appliedQuery: state.appliedQuery,
    trimmedThroughEpoch: state.trimmedThroughEpoch,
    nextEpoch: state.nextEpoch
  };
}

describe("search sync holds its invariants under any interleaving", () => {
  it("keeps every structural guarantee, whatever order commits and renders arrive in", () => {
    fc.assert(
      fc.property(initialQueryArb, scriptArb, permutationKeysArb, (initialQuery, steps, keys) => {
        const script = permute(steps, keys);
        let state = deepFreeze(createSearchSyncState(initialQuery));

        for (const step of script) {
          if (step.kind === "commit") {
            const appliedBefore = state.appliedEpoch;
            state = deepFreeze(recordSearchCommit(state, step.query));

            // A commit is a REQUEST. It can never claim a render arrived.
            expect(state.appliedEpoch).toBe(appliedBefore);
            expect(latestRequestedQuery(state)).toBe(normalizeSearchQuery(step.query));
          } else {
            const before = state;
            const incoming = normalizeSearchQuery(step.query);
            const hadUnspentCommit = before.commits.some(
              (commit) => !commit.spent && commit.query === incoming
            );
            /* Snapshotted BEFORE the call, or the comparison below would only be
             * comparing the input to a copy of whatever it had already become. */
            const replica = createReplica(before);
            const outcome = reconcileSearchQuery(before, incoming);

            /* PURE. The caller keeps a usable value even if it ignores the
             * returned state, and React may call this twice for one render. The
             * freeze above makes an in-place edit throw at the offending line;
             * this makes a structural one fail here. */
            expect(before).toEqual(replica);

            /* MONOTONIC. `appliedEpoch` is the watermark that decides which
             * renders are superseded; if it could move backwards, a render
             * already ruled out could win a second time. */
            expect(outcome.state.appliedEpoch).toBeGreaterThanOrEqual(before.appliedEpoch);
            expect(outcome.state.nextEpoch).toBeGreaterThanOrEqual(before.nextEpoch);

            /* ONLY `adopt` WRITES. Every other decision leaves the field alone,
             * so it must also leave alone the value the field is reconciled
             * against — otherwise the debounce guard would start comparing
             * against a query nobody asked for. */
            if (outcome.decision.kind === "adopt") {
              expect(latestRequestedQuery(outcome.state)).toBe(outcome.decision.query);
              expect(outcome.state.appliedQuery).toBe(outcome.decision.query);

              /* `adopt` MEANS "nobody here asked for this". An unanswered commit
               * for the same query is proof that somebody did.
               *
               * NOTE this is deliberately "no UNSPENT commit" and not the
               * stronger "not present in the log at all". The stronger form was
               * the old behaviour and it is exactly what made a navigation back
               * to an earlier query impossible: the answered commit matched, its
               * epoch was below the watermark, and a real external navigation
               * was discarded as a stale render forever. A commit explains one
               * render; a second render carrying the same string has to have
               * come from somewhere else. */
              expect(hadUnspentCommit).toBe(false);

              /* ...and once the bound has forgotten a commit, "not in the log"
               * stops being proof of anything, so adoption stops. */
              expect(before.trimmedThroughEpoch).toBe(NOTHING_TRIMMED);
            } else {
              expect(latestRequestedQuery(outcome.state)).toBe(latestRequestedQuery(before));
            }

            /* `acknowledged` and `stale` both name one of OUR epochs, never an
             * epoch that has not been issued. */
            if (outcome.decision.kind === "acknowledged") {
              expect(outcome.decision.epoch).toBeGreaterThan(before.appliedEpoch);
              expect(outcome.state.appliedEpoch).toBe(outcome.decision.epoch);
              expect(outcome.state.appliedQuery).toBe(incoming);
            }
            if (outcome.decision.kind === "stale") {
              expect(outcome.state.appliedEpoch).toBe(before.appliedEpoch);
              expect(outcome.state.appliedQuery).toBe(before.appliedQuery);
            }
            if (outcome.decision.kind === "unchanged") {
              expect(outcome.state).toBe(before);
            }

            state = deepFreeze(outcome.state);
          }

          /* BOUNDED. Asserted after every step, commits included: the log grows
           * on both paths, and a bound that only held on the reconcile path
           * would be no bound at all during a long typing session. */
          expect(state.commits.length).toBeLessThanOrEqual(SEARCH_SYNC_HISTORY_LIMIT);

          /* THE COMMIT AT THE WATERMARK IS ALWAYS ANSWERED. This is what makes
           * `findUnspentCommit` unable to return the applied commit, and
           * therefore what makes the `epoch === appliedEpoch` case unreachable
           * rather than merely unlikely. */
          const applied = state.commits.find((commit) => commit.epoch === state.appliedEpoch);
          if (applied !== undefined) expect(applied.spent).toBe(true);

          /* Epochs are issued in order and never reused. */
          for (let index = 1; index < state.commits.length; index += 1) {
            const previous = state.commits[index - 1];
            const current = state.commits[index];
            if (previous === undefined || current === undefined) continue;
            expect(current.epoch).toBeGreaterThan(previous.epoch);
            expect(current.epoch).toBeLessThan(state.nextEpoch);
          }
        }
      })
    );
  });

  it("never adopts a render for a commit the history bound forgot", () => {
    /*
     * The overflow case on its own, driven past the bound deliberately rather
     * than left to a generator that might not get there. A render for a trimmed
     * commit used to be indistinguishable from an external navigation, and
     * adopting it wrote the session's oldest query back into the field, marked
     * every outstanding commit stale forever and left the debounce guard
     * refusing to correct any of it.
     */
    fc.assert(
      fc.property(
        /*
         * The seed occupies one slot, so `total` commits leave the log holding
         * query indices `total - LIMIT` through `total - 1`. A forgotten index
         * therefore only EXISTS once `total` exceeds the limit, and the range
         * for `trimmedIndex` is derived from `total` rather than guessed —
         * otherwise most runs would "test" a query that is still in the log and
         * the property would quietly assert nothing.
         */
        fc
          .integer({ min: SEARCH_SYNC_HISTORY_LIMIT + 1, max: SEARCH_SYNC_HISTORY_LIMIT * 3 })
          .chain((total) =>
            fc.tuple(
              fc.constant(total),
              fc.nat({ max: total - SEARCH_SYNC_HISTORY_LIMIT - 1 })
            )
          ),
        ([total, trimmedIndex]) => {
          let state = createSearchSyncState("");
          for (let index = 0; index < total; index += 1) {
            state = recordSearchCommit(state, `query ${index}`);
          }

          const forgotten = `query ${trimmedIndex}`;
          expect(state.commits.some((commit) => commit.query === forgotten)).toBe(false);

          const requestedBefore = latestRequestedQuery(state);
          const outcome = reconcileSearchQuery(state, forgotten);

          expect(outcome.decision.kind).toBe("stale");
          expect(latestRequestedQuery(outcome.state)).toBe(requestedBefore);
          expect(outcome.state.appliedEpoch).toBe(state.appliedEpoch);

          // And the form can still recognise its own newest navigation, which
          // is what the old behaviour destroyed.
          const newest = reconcileSearchQuery(outcome.state, `query ${total - 1}`);
          expect(newest.decision).toEqual({ kind: "acknowledged", epoch: total });
        }
      )
    );
  });
});
