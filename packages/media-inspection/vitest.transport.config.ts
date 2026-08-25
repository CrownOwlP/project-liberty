import { configDefaults, defineConfig } from "vitest/config";

/*
 * The real-socket transport suite, run on demand: `npm run test:transport`.
 *
 * A second config rather than a path argument, because the default config
 * EXCLUDES `src/node/**` -- and vitest applies `exclude` to a path filter too,
 * so `vitest run src/node` against the default config would match nothing and
 * exit zero. A green run that executed no tests is worse than a red one, and it
 * is exactly the shape of false evidence a quality gate must never produce.
 *
 * See `vitest.config.ts` for why these tests are not in the blocking gate. The
 * short version: they all pass, and a socket abandoned by design emits
 * `ECONNRESET` at worker teardown where nothing can hold a listener for it.
 *
 * This run is expected to report that unhandled error and exit non-zero. Read
 * the test results, not the exit code: the assertions are the evidence, and any
 * FAILING test here is a real regression in address pinning.
 */
export default defineConfig({
  test: {
    include: ["src/node/**/*.test.ts"],
    exclude: [...configDefaults.exclude]
  }
});
