import { defineConfig } from "vitest/config";

/**
 * WHY THIS FILE EXISTS: a property suite must not be timed by a default sized
 * for unit tests.
 *
 * `src/stream-candidate.property.test.ts` is PL-0708's response-budget work. A
 * fast-check property does not cost what the code under test costs -- it costs
 * that multiplied by the run count, and the generators for this suite build
 * deliberately maximal candidates (identifiers at the declared bound, filled
 * with a character that escapes to six UTF-8 bytes) precisely so the budget
 * assertion is not vacuous. That is the right design and it is not free.
 *
 * WHAT WENT WRONG WITHOUT THIS FILE, stated exactly, because "a flake" is the
 * reading that would have buried it. Round 52 recorded a single observed
 * failure in this suite and the lead could not reproduce it across ten seeds.
 * It was not seed-dependent. PL-0710's part A hit it twice out of two runs at
 * turbo's default concurrency and named a cause that fits every observation:
 *
 *   - this machine has 2 cores;
 *   - turbo's default concurrency is 10;
 *   - `@liberty/net-policy` took the graph from 18 test tasks to 20;
 *   - `refuses a licence endpoint that is not https, whatever else it is` runs
 *     in ~1.7s for the whole file standalone, and measured 5.4s and 7.4s under
 *     that graph, against vitest's 5000ms default.
 *
 * The same tree passes at `--concurrency=4`, and passes at default concurrency
 * with 19 tasks. So the suite was already running at roughly a third of the
 * default with no headroom, and the twentieth parallel task was merely what
 * finally spent it. The defect is the missing timeout, not the new package.
 *
 * HOW FAR THAT EVIDENCE GOES, because the difference matters. The failure is
 * load-dependent, not deterministic: removing this file and re-running the same
 * command on the same tree PASSED once for the lead, against two-of-two
 * failures for the agent that found it. So this file is not a demonstrated
 * red-to-green repair. It is headroom for a suite measured to run at about a
 * third of the budget it was being held to, which is a latent fragility whether
 * or not it fires on any given afternoon. Round 52's unexplained failure is
 * best explained by it and is NOT thereby proven to be it.
 *
 * THE VALUE. The whole file is ~1.76s standalone (31 tests, measured, not
 * estimated). Under a 10-wide graph on 2 cores the worst observation was 7.4s
 * for a single test, roughly 4x its unloaded cost. 30000ms is an order of
 * magnitude above the standalone figure and about 4x the worst loaded
 * observation, which leaves room for a slower machine or a wider graph without
 * leaving so much that a genuinely hung property looks like a slow one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not touch the run count, the
 * generators, or any assertion. Raising a timeout to make a slow property pass
 * would be the same mistake one level out: if this suite ever becomes slow for
 * a reason the code should answer for, the honest change is to the code or to
 * the property, and this comment is where that argument belongs -- not a larger
 * number.
 *
 * It also does not cap turbo's concurrency. That is a CLI flag rather than a
 * `turbo.json` key, and how wide CI runs is a CI decision rather than this
 * package's.
 */
const PROPERTY_SUITE_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: PROPERTY_SUITE_TIMEOUT_MS
  }
});
