import {
  PLAYBACK_FAILURE_KINDS,
  type PlaybackAttemptFailure,
  type PlaybackFailureKind
} from "@liberty/contracts/domains/failover";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import type { ContentRights } from "@liberty/contracts/shared/rights";
import { describe, expect, it } from "vitest";
import { planFailover } from "./failover";
import { scheduleAttempts } from "./scheduling";

/* -------------------------------------------------------------------------
 * The performance gate for candidate failover (PL-0204).
 *
 * PL-0204 declares a `performance` quality gate and nothing in this repository
 * could run one: there was no benchmark, so the gate had nothing to record and
 * the task could not honestly reach DONE. This is that benchmark.
 *
 * IT IS A GATE, NOT A PRINTOUT. Every measurement below ends in an `expect`, so
 * a regression is a non-zero exit from `npm run bench:failover` (and from
 * `npm run test`, since this file is part of the suite -- see the note on
 * placement at the bottom of this header).
 *
 * WHAT IT MEASURES, AND WHY IT IS MOSTLY NOT MILLISECONDS
 * ------------------------------------------------------
 * The primary metric is an OPERATION COUNT: how many times the policy reads a
 * field off its own inputs. It is obtained by handing `planFailover` and
 * `scheduleAttempts` inputs whose properties are getters that increment a
 * counter -- so the count is of work the policy actually does, observed from
 * outside, with nothing in `scheduling.ts`, `failover.ts`, `ranking.ts` or
 * `scoring.ts` modified to report on itself. That matters: this package has a
 * stated purity guarantee (no clocks, no randomness, no ambient state) and its
 * property tests assert that a plan is identical however many times it is
 * computed. Instrumenting the source to serve a benchmark would break the thing
 * the benchmark exists to protect.
 *
 * Three properties make the count the right primary metric:
 *
 *   - IT IS EXACT. The same workload produces the same count on every machine,
 *     every Node version and every run, so the gate has no variance to tune a
 *     threshold against and cannot be made to pass by re-running it. A wall-clock
 *     threshold on a developer laptop or a shared CI runner is a coin flip, and a
 *     gate people learn to re-run is not a gate.
 *   - IT SEES THE COMPLEXITY CLASS DIRECTLY. Quadratic work shows up as a count
 *     that grows faster than its input, which the scaling assertions below test
 *     WITHOUT any absolute constant at all -- so those assertions hold even if
 *     the per-unit budgets further down turn out to be mis-derived.
 *   - IT IS ATTRIBUTABLE. A failed count names the dimension that regressed
 *     (candidates, or failures) rather than reporting that something, somewhere,
 *     got slower.
 *
 * ITS BLIND SPOT IS STATED RATHER THAN IGNORED: a change that adds expensive
 * constant work per candidate -- a serialization, a regex, a deep clone -- costs
 * real time while reading no additional fields. Nothing but a clock sees that,
 * which is why there is also one wall-clock assertion, deliberately coarse. See
 * `RANKING_WALL_CLOCK_CEILING_MS`.
 *
 * WHY THESE WORKLOADS
 * -------------------
 * They are the two dimensions the policy is a function of, isolated from each
 * other so a failure names one of them.
 *
 * CANDIDATES (`planFailover`). A playback session ranks every candidate it was
 * given, synchronously, inside an HTTP handler. A single Stremio addon commonly
 * offers dozens to low hundreds of streams for one title, and a session that
 * aggregates several sources plus their mirror lists reaches the low thousands.
 * 4096 is deliberately above anything production should see: this is a HEADROOM
 * gate, not a "does today's traffic fit" gate. The candidates are generated ALL
 * TIED ON SCORE, which is the adversarial case rather than the average one --
 * ranking's comparator only reaches the id tiebreak when score and unknown-fact
 * count both tie, so a tied pool is what actually exercises it -- and they are
 * fed in a deterministic pseudo-random order, because a list that arrives
 * already sorted lets `Array.prototype.sort` detect one run and finish in linear
 * comparisons, which would measure the easy case and call it the budget.
 *
 * FAILURES (`scheduleAttempts`). Here the honest statement is that the realistic
 * F is SINGLE DIGITS: `DEFAULT_FAILOVER_POLICY.maxAttempts` is 4, so a real
 * session reports a handful of failures and no wall-clock budget is ever at risk.
 * This dimension is gated anyway, and for a specific reason -- to pin the
 * COMPLEXITY CLASS so that raising `maxAttempts`, replaying a long failure log
 * from a bug report, or a long-lived session accumulating attempts cannot turn a
 * linear pass into a quadratic one unnoticed. That is not hypothetical. The
 * shape below (every reported failure naming an id that is NOT in the pool, which
 * is what a client produces after a session re-resolves and its remembered ids
 * stop matching the new candidate list) was quadratic in F until the change this
 * benchmark prompted: `unattributedDetail` re-scanned the whole failure list once
 * per (unattributed id, failure kind) pair. See the note on that block in
 * `scheduling.ts`. Run this file against the previous implementation and the
 * per-failure budget below is exceeded by orders of magnitude -- and by more of
 * them the longer the failure log is, which is the signature the ratio
 * assertions are there to name.
 *
 * HOW THE THRESHOLDS WERE SET
 * ---------------------------
 * Each per-unit budget is DERIVED FROM THE SOURCE -- counted by reading which
 * fields each function touches -- and then given headroom, and both the derived
 * figure and the headroom are stated at the constant. A threshold read off a run
 * on one machine and rounded up would only ever assert "this is what it did the
 * day it was written".
 *
 * Each budget sits above its derived figure -- by about a factor of two where
 * the derivation is a count of field reads, and at the exact worst case where
 * the derivation is already a worst case and the multiplier it is applied to
 * carries the slack instead. That headroom is what makes this a COMPLEXITY-CLASS
 * gate rather than a constant-factor one, and the trade is deliberate: a refactor
 * that changes how many times a field is touched per candidate is allowed to
 * pass, while a change of asymptotic behaviour is not, because it exceeds any
 * constant. The scaling assertions carry the load the absolute budgets cannot:
 * they use no constant at all, so they hold even where a derivation is wrong.
 *
 * PLACEMENT: this file ends in `.test.ts`, so it runs in `npm run test` as well
 * as under its own script. That is deliberate. The gate is cheap (the counted
 * workloads are pure arithmetic and the one timed workload is a handful of
 * repeats) and a performance regression is worth catching on the run a developer
 * already does, rather than only on the run somebody remembers to make.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Workload sizes. Two of each, a factor of 8 apart, because a single size can
 * only ever test an absolute budget and it is the RATIO that identifies a
 * complexity change. Both are exact powers of two so `Math.log2` is exact and
 * the normalisation below carries no rounding of its own.
 * ---------------------------------------------------------------------- */
const CANDIDATES_SMALL = 512;
const CANDIDATES_LARGE = 4096;
const FAILURES_SMALL = 512;
const FAILURES_LARGE = 4096;

/**
 * The seed the candidate order is shuffled with. Any fixed non-zero value does;
 * what matters is that it is FIXED, so the permutation -- and therefore the
 * comparison count the sort makes -- is the same on every run and every machine.
 */
const WORKLOAD_SEED = 0x5eed1234;

/**
 * A pool small enough that its own cost cannot mask a change in the FAILURE
 * dimension. Held constant across both failure sizes, so the only thing that
 * varies between the two measurements is the number of failures.
 */
const FAILURE_SCENARIO_POOL = 64;

/**
 * Reads of a `PlaybackAttemptFailure` field, per failure, that `scheduleAttempts`
 * is allowed.
 *
 * DERIVED: 4 in the worst of the two shapes below. The grouping loop reads
 * `candidateId` and `kind` once each (2F); `unattributedFailures` reads
 * `candidateId` once per failure to filter (F) and once more per failure that
 * survives the filter (F when every failure is unattributed, 0 when none is).
 * `unattributedDetail` reads none, because it consults the map the grouping loop
 * already built.
 *
 * Set to 8 for one refactor's worth of headroom. The value is a CONSTANT per
 * failure and that is the property being gated: anything that walks the failure
 * list a number of times that depends on its length exceeds this at F = 4096
 * whatever constant is chosen.
 */
const FAILURE_FIELD_READS_PER_FAILURE = 8;

/**
 * Reads of a `StreamCandidate` field, per candidate, that `planFailover` is
 * allowed BEFORE the sort allowance below.
 *
 * DERIVED: 32 for a fully-stated, eligible candidate. `firstRejectionReason`
 * reads 8 (rights, both codecs twice each for the null test and the membership
 * test, height twice, healthScore); `scoreCandidate` reads 16 across its six
 * components plus its own `unknownMediaFacts` pass; `rankStreamCandidates` reads
 * 4 more for its second `unknownMediaFacts` and 2 for `compatibilityOf`; and
 * `planFailover` reads each ranked entry's id twice more, once to build the id
 * list it hands the scheduler and once in the enrichment walk.
 *
 * Set to 64, twice the derived figure. The derivation was made by reading the
 * source rather than by running it, so the headroom absorbs a mis-count; the
 * scaling assertion is what catches the failure this budget is really aimed at.
 */
const CANDIDATE_FIELD_READS_PER_CANDIDATE = 64;

/**
 * Reads of a `StreamCandidate` field the sort is allowed, per comparison, on top
 * of the per-candidate allowance.
 *
 * DERIVED: up to 4, averaging 3. Ranking's comparator reaches the id tiebreak
 * only when score and unknown-fact count have both tied -- which the tied
 * workload below guarantees for EVERY comparison, so this is the worst case
 * rather than a typical one -- and the tiebreak is written
 * `a.id < b.id ? -1 : a.id > b.id ? 1 : 0`, which reads both ids once and then
 * both again whenever the first test is false. With distinct ids that is false
 * about half the time.
 *
 * Set to 4, which is the exact worst case rather than a doubling of it. The
 * headroom on this term comes from the multiplier instead: it is applied to
 * `C * log2(C)`, and a merge-based sort performs strictly fewer comparisons than
 * that (the standard bound subtracts a `2^ceil(log2 C)` term), so the allowance
 * exceeds the achievable read count without needing a second safety factor.
 */
const CANDIDATE_FIELD_READS_PER_COMPARISON = 4;

/**
 * How much the per-unit cost may grow between the small and large workloads.
 *
 * THE ASSERTION THAT NEEDS NO CONSTANT, which is what makes it the one that
 * survives a mis-derived budget.
 *
 * Work in the expected class produces a per-unit figure at or below 1 in this
 * ratio. For the failure dimension the per-failure cost is flat, so the ratio is
 * 1. For the candidate dimension the normalisation divides by `C * log2(C)`
 * while part of the work is merely linear, so the figure actually FALLS as C
 * grows and the expected ratio is below 1. Quadratic work in either dimension
 * multiplies the per-unit figure by roughly the size factor -- 8 for the failure
 * log, and about 6 for the candidate pool once the `log2(C)` in the denominator
 * is accounted for -- so both land far outside this.
 *
 * 1.25 is therefore slack rather than a needed allowance. It is there because
 * the comparison count a real sort performs does not track `C * log2(C)`
 * exactly, and a gate should not fail on the difference between a bound and the
 * thing it bounds.
 */
const SUPERLINEAR_TOLERANCE = 1.25;

/**
 * The one wall-clock assertion, and it is coarse on purpose.
 *
 * DERIVED FROM A PRODUCT BUDGET, NOT FROM A MEASUREMENT ON THIS MACHINE. The
 * playback session route ranks candidates synchronously inside a request. A pool
 * of 4096 costing 1.5 s is a user-visible stall, and it is a stall on any
 * hardware -- so the ceiling marks the point at which the behaviour is a defect
 * regardless of what it is running on, rather than the point at which this
 * laptop got slower.
 *
 * That is a very loose bound for simple arithmetic over 4096 items, and loose is
 * the point: a wall-clock threshold tight enough to be interesting is tight
 * enough to flake on a shared CI runner under load, and the first flake teaches
 * everyone to re-run the gate. What this catches is an order-of-magnitude
 * constant-factor blowup -- a serialization or a regex added per candidate --
 * which is precisely the regression the operation count is blind to. Anything
 * finer than that is the operation count's job and is enforced above.
 *
 * Warmed up and taken as a MEDIAN of repeats rather than measured cold once, so
 * a single JIT pause or GC cycle cannot decide the result.
 */
const RANKING_WALL_CLOCK_CEILING_MS = 1500;
const TIMING_WARMUP_RUNS = 2;
const TIMING_REPEATS = 5;

/** Generous, because a slow machine should fail an assertion, not a timeout. */
const BENCHMARK_TIMEOUT_MS = 60_000;

interface ReadTally {
  reads: number;
}

const CAPABILITIES: PlaybackCapabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc", "av1", "vp9"],
  supportedAudioCodecs: ["aac", "ac3", "eac3", "opus"],
  preferredAudioLanguages: []
};

/**
 * Deterministic pseudo-randomness, in the HARNESS only.
 *
 * `Math.random` never reaches the policy and could not: nothing is passed to it
 * but the arrays this file builds. It is not used here either, because a
 * benchmark whose workload differs between runs cannot have a threshold. This is
 * a seeded xorshift32, so the permutation below is a fixed one that simply is not
 * sorted.
 */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** Fisher-Yates against a seeded generator. Same input, same output, always. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = xorshift32(seed);
  for (let index = out.length - 1; index > 0; index--) {
    const swap = next() % (index + 1);
    const here = out[index];
    const there = out[swap];
    // Unreachable: both indices are inside the array. Present because
    // `noUncheckedIndexedAccess` makes an index read `T | undefined`, and a
    // non-null assertion would hide a real out-of-range bug in this harness.
    if (here === undefined || there === undefined) {
      throw new Error("shuffle produced an out-of-range index");
    }
    out[index] = there;
    out[swap] = here;
  }
  return out;
}

function kindAt(index: number): PlaybackFailureKind {
  const kind = PLAYBACK_FAILURE_KINDS[index % PLAYBACK_FAILURE_KINDS.length];
  if (kind === undefined) throw new Error("the contract published no failure kinds");
  return kind;
}

/**
 * A candidate whose every field read is counted.
 *
 * Accessors rather than data properties, which is what makes the count possible
 * without touching the source. The values are IDENTICAL for every candidate
 * except the id, so every candidate scores the same and states the same number
 * of facts -- see the header for why a tied pool is the workload the comparator
 * actually has to work on.
 */
function countedCandidate(id: string, tally: ReadTally): StreamCandidate {
  return {
    get id(): string {
      tally.reads++;
      return id;
    },
    get providerId(): string {
      tally.reads++;
      return "bench";
    },
    get rights(): ContentRights {
      tally.reads++;
      return "licensed";
    },
    get protocol(): StreamCandidate["protocol"] {
      tally.reads++;
      return "hls";
    },
    get height(): number | null {
      tally.reads++;
      return 1080;
    },
    get bitrateKbps(): number | null {
      tally.reads++;
      // Exactly `height * BITRATE_KBPS_PER_LINE`, so the bitrate dimension is
      // measured rather than clamped. A clamped one would score the same for
      // every candidate too, but it would stop exercising the arithmetic.
      return 8100;
    },
    get estimatedLatencyMs(): number {
      tally.reads++;
      return 120;
    },
    get healthScore(): number {
      tally.reads++;
      return 0.9;
    },
    get videoCodec(): StreamCandidate["videoCodec"] {
      tally.reads++;
      return "h264";
    },
    get audioCodec(): StreamCandidate["audioCodec"] {
      tally.reads++;
      return "aac";
    }
  };
}

/** The same candidate without the accessors, for the timed run. */
function plainCandidate(id: string): StreamCandidate {
  return {
    id,
    providerId: "bench",
    rights: "licensed",
    protocol: "hls",
    height: 1080,
    bitrateKbps: 8100,
    estimatedLatencyMs: 120,
    healthScore: 0.9,
    videoCodec: "h264",
    audioCodec: "aac"
  };
}

function countedFailure(
  candidateId: string,
  kind: PlaybackFailureKind,
  tally: ReadTally
): PlaybackAttemptFailure {
  return {
    get candidateId(): string {
      tally.reads++;
      return candidateId;
    },
    get kind(): PlaybackFailureKind {
      tally.reads++;
      return kind;
    }
  };
}

/**
 * Ids are zero-padded so that lexicographic order and numeric order agree.
 *
 * Not cosmetic: `byCodePoint` and ranking's id tiebreak both compare by code
 * point, and unpadded ids would make `id-10` sort before `id-9`. The workload
 * would still be valid, but its shuffle would no longer be the only source of
 * disorder, which is the thing the sort measurement depends on.
 */
function paddedId(prefix: string, index: number, width: number): string {
  return `${prefix}-${String(index).padStart(width, "0")}`;
}

/**
 * `size` values from `make`, built with a plain loop.
 *
 * Not `Array.from({ length })`: this harness is read by someone deciding whether
 * to trust a number, and an index-by-index loop is the form where "how many were
 * built, and with which index" needs no knowledge of a library helper.
 */
function build<T>(size: number, make: (index: number) => T): T[] {
  const out: T[] = [];
  for (let index = 0; index < size; index++) out.push(make(index));
  return out;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("cannot take a median of no samples");
  return middle;
}

function medianElapsedMs(run: () => void): number {
  for (let index = 0; index < TIMING_WARMUP_RUNS; index++) run();

  const samples: number[] = [];
  for (let index = 0; index < TIMING_REPEATS; index++) {
    const startedAt = performance.now();
    run();
    samples.push(performance.now() - startedAt);
  }
  return median(samples);
}

/* -------------------------------------------------------------------------
 * The candidate dimension: `planFailover`.
 * ---------------------------------------------------------------------- */

/** Total candidate-field reads for one `planFailover` over `size` candidates. */
function candidateFieldReads(size: number): number {
  const tally: ReadTally = { reads: 0 };
  const width = String(size).length;
  const candidates = shuffled(
    build(size, (index) => countedCandidate(paddedId("cand", index, width), tally)),
    WORKLOAD_SEED
  );

  // Reset AFTER construction: building the array reads nothing, but the shuffle
  // must not be able to contribute to a count that is compared against a budget.
  tally.reads = 0;
  const plan = planFailover(candidates, CAPABILITIES);

  // The plan has to be a real one, or the count is a count of nothing. Asserted
  // here rather than in a separate test so the measurement itself is what proves
  // the workload was ranked.
  if (plan.next === null || plan.attemptable.length !== size) {
    throw new Error(
      `benchmark workload did not rank: next=${String(plan.next?.candidate.id)} ` +
        `attemptable=${String(plan.attemptable.length)} of ${String(size)}`
    );
  }
  return tally.reads;
}

/** The budget for `size` candidates: per-candidate work plus a sort allowance. */
function candidateFieldReadBudget(size: number): number {
  return (
    size * CANDIDATE_FIELD_READS_PER_CANDIDATE +
    CANDIDATE_FIELD_READS_PER_COMPARISON * size * Math.log2(size)
  );
}

/**
 * Reads per `C * log2(C)` unit of work -- the normalisation that makes the two
 * sizes comparable.
 *
 * `C * log2(C)` is the shape a comparison sort over C items has, so a policy that
 * stays within its complexity class produces a normalised figure that is FLAT or
 * FALLING as C grows (the per-candidate term is divided by a growing `log2(C)`).
 * A quadratic one produces a figure that grows like `C / log2(C)`, which no
 * tolerance absorbs.
 */
function normalisedCandidateReads(size: number): number {
  return candidateFieldReads(size) / (size * Math.log2(size));
}

describe("planFailover stays within its complexity class as the candidate pool grows", () => {
  it(
    "reads a bounded number of candidate fields per candidate, at both sizes",
    () => {
      for (const size of [CANDIDATES_SMALL, CANDIDATES_LARGE]) {
        expect(candidateFieldReads(size)).toBeLessThanOrEqual(candidateFieldReadBudget(size));
      }
    },
    BENCHMARK_TIMEOUT_MS
  );

  it(
    "does not read more per unit of sorted work at 4096 candidates than at 512",
    () => {
      const small = normalisedCandidateReads(CANDIDATES_SMALL);
      const large = normalisedCandidateReads(CANDIDATES_LARGE);

      // No absolute constant appears here, so this assertion survives a
      // mis-derived budget above. It is the real complexity gate.
      expect(large).toBeLessThanOrEqual(small * SUPERLINEAR_TOLERANCE);
    },
    BENCHMARK_TIMEOUT_MS
  );

  it(
    "ranks a 4096-candidate pool well inside the budget a request can afford",
    () => {
      const width = String(CANDIDATES_LARGE).length;
      const candidates = shuffled(
        build(CANDIDATES_LARGE, (index) => plainCandidate(paddedId("cand", index, width))),
        WORKLOAD_SEED
      );

      const elapsedMs = medianElapsedMs(() => {
        planFailover(candidates, CAPABILITIES);
      });

      expect(elapsedMs).toBeLessThanOrEqual(RANKING_WALL_CLOCK_CEILING_MS);
    },
    BENCHMARK_TIMEOUT_MS
  );
});

/* -------------------------------------------------------------------------
 * The failure dimension: `scheduleAttempts`.
 * ---------------------------------------------------------------------- */

/**
 * Total failure-field reads for one `scheduleAttempts` over `size` failures.
 *
 * `attributable` picks the shape. Both are gated because they exercise different
 * halves of the function: attributable failures drive the exclusion pass, and
 * unattributed ones drive `unattributedFailures` and `unattributedDetail`, which
 * is the half that was quadratic.
 */
function failureFieldReads(size: number, attributable: boolean): number {
  const tally: ReadTally = { reads: 0 };
  const poolWidth = String(FAILURE_SCENARIO_POOL).length;
  const failureWidth = String(size).length;

  const pool = build(FAILURE_SCENARIO_POOL, (index) => paddedId("pool", index, poolWidth));

  const failures = build(size, (index) => {
    const candidateId = attributable
      ? paddedId("pool", index % FAILURE_SCENARIO_POOL, poolWidth)
      : // A DISTINCT id per failure, which is the worst case for the
        // unattributed path: it maximises the number of ids that pass through
        // `unattributedDetail`, and therefore the number of times a
        // re-scanning implementation would walk the whole failure list.
        paddedId("ghost", index, failureWidth);
    /*
     * The kind advances with the LAP as well as with the index, so a candidate
     * collects several different kinds rather than the same one repeatedly.
     * Without the lap term the pool size (64) is a multiple of the kind count
     * (4), so every failure landing on a given candidate would carry an
     * identical kind and the multi-kind resolution in `exclusionFor` would never
     * be exercised.
     */
    return countedFailure(
      candidateId,
      kindAt(index + Math.floor(index / FAILURE_SCENARIO_POOL)),
      tally
    );
  });

  tally.reads = 0;
  const schedule = scheduleAttempts(pool, failures);

  // Again: prove the workload was the one intended, or the count means nothing.
  const expectedUnattributed = attributable ? 0 : size;
  if (schedule.unattributedFailures.length !== expectedUnattributed) {
    throw new Error(
      `benchmark workload was not the shape it claims: ${String(schedule.unattributedFailures.length)} ` +
        `unattributed ids, expected ${String(expectedUnattributed)}`
    );
  }
  return tally.reads;
}

describe("scheduleAttempts stays linear in the failure log", () => {
  it(
    "reads a bounded number of failure fields per failure, in both shapes and at both sizes",
    () => {
      for (const attributable of [true, false]) {
        for (const size of [FAILURES_SMALL, FAILURES_LARGE]) {
          expect(failureFieldReads(size, attributable)).toBeLessThanOrEqual(
            size * FAILURE_FIELD_READS_PER_FAILURE
          );
        }
      }
    },
    BENCHMARK_TIMEOUT_MS
  );

  it(
    "costs no more per failure at 4096 unattributed failures than at 512",
    () => {
      /*
       * THE ASSERTION THAT NAMES THE DEFECT. Before `unattributedDetail` was
       * changed to read the map the grouping pass had already built, this shape
       * walked the whole failure list once per (unattributed id, failure kind)
       * pair, so the per-failure cost grew IN PROPORTION TO THE LENGTH OF THE
       * FAILURE LOG rather than staying flat. Under quadratic work this ratio is
       * the size factor itself -- 8 here -- against a tolerance of 1.25, so it
       * fails; the absolute budget above fails at the same time and by a much
       * wider margin, which is the pair a reader wants: one says the shape is
       * wrong, the other says how badly.
       */
      const perFailureSmall = failureFieldReads(FAILURES_SMALL, false) / FAILURES_SMALL;
      const perFailureLarge = failureFieldReads(FAILURES_LARGE, false) / FAILURES_LARGE;

      expect(perFailureLarge).toBeLessThanOrEqual(perFailureSmall * SUPERLINEAR_TOLERANCE);
    },
    BENCHMARK_TIMEOUT_MS
  );

  it(
    "costs no more per failure at 4096 attributable failures than at 512",
    () => {
      const perFailureSmall = failureFieldReads(FAILURES_SMALL, true) / FAILURES_SMALL;
      const perFailureLarge = failureFieldReads(FAILURES_LARGE, true) / FAILURES_LARGE;

      expect(perFailureLarge).toBeLessThanOrEqual(perFailureSmall * SUPERLINEAR_TOLERANCE);
    },
    BENCHMARK_TIMEOUT_MS
  );
});
