import { defineConfig } from "vitest/config";

/**
 * WHY THIS FILE EXISTS: one wall-clock assertion must not run in `npm run check`.
 *
 * `src/failover.perf.test.ts` is the PL-0204 performance gate. Almost all of it
 * is deterministic -- it counts how many fields the policy reads off its own
 * inputs, which is identical on every machine, every Node version and every run.
 * Those assertions belong in the default suite and stay in it.
 *
 * Exactly one of its assertions is a clock: `ranks a 4096-candidate pool well
 * inside the budget a request can afford` compares a measured median elapsed
 * time against `RANKING_WALL_CLOCK_CEILING_MS`. A wall-clock ceiling is a
 * function of the machine and of whatever else that machine is doing, and the
 * root `test` script runs inside `npm run check` -- the one all-in command this
 * repository tells an operator to run. A flake there is maximally expensive: it
 * reads as "the project is broken" to a reader who cannot tell a flake from a
 * defect, and the standing repair for a flake ("just run it again") is exactly
 * the habit that destroys a gate's value.
 *
 * So the DEFAULT run deselects that single test by name and keeps the rest of
 * the file. `bench:failover` runs with `--mode bench`, which drops the filter
 * and runs the whole benchmark including the clock. Nothing is skipped
 * everywhere; the timed assertion simply lives on the deliberate run rather
 * than the incidental one.
 *
 * DO NOT "fix" this by deleting the filter. If the timing assertion is wanted
 * in the default suite again, the honest change is to make it robust (or to
 * delete it and say so), not to reintroduce a machine-dependent threshold into
 * the double-click path.
 *
 * The name below must match the `it(...)` title in `failover.perf.test.ts`. A
 * rename there silently returns the timing assertion to the default run, which
 * fails loudly rather than quietly -- but the cleaner mechanism, once that file
 * can be edited alongside this one, is a `skipIf` at the test itself, where the
 * condition sits next to the assertion it governs.
 */
const WALL_CLOCK_TEST_NAME = "ranks a 4096-candidate pool well inside the budget a request can afford";

/**
 * Matches every full test name that does NOT contain the title above.
 *
 * Vitest matches `testNamePattern` against the full name (suite titles plus the
 * test title), so an anchored negative lookahead over the whole string is
 * separator-independent: it deselects exactly the one test and selects every
 * other test in this package.
 */
const EXCLUDE_WALL_CLOCK = new RegExp(`^(?!.*${WALL_CLOCK_TEST_NAME})`);

export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    // `--mode bench` (used by `npm run bench:failover`) runs everything.
    testNamePattern: mode === "bench" ? undefined : EXCLUDE_WALL_CLOCK
  }
}));
