import { configDefaults, defineConfig } from "vitest/config";

/*
 * The real-socket transport suite. Do NOT run this config directly in a gate --
 * run `npm run test:transport`, which wraps it.
 *
 * A second config rather than a path argument, because the default config
 * EXCLUDES `src/node/**`, and vitest applies `exclude` to a path filter too: so
 * `vitest run src/node` against the default config would match nothing and exit
 * zero. A green run that executed no tests is worse than a red one, and it is
 * exactly the false evidence a quality gate must never produce.
 *
 * This config is expected to exit NON-ZERO on a known teardown artefact while
 * every assertion passes. `scripts/gate-transport.mjs` is what distinguishes
 * that from a real failure; it is the thing to trust, and it explains why.
 */
export default defineConfig({
  test: {
    include: ["src/node/**/*.test.ts"],
    exclude: [...configDefaults.exclude]
  }
});
