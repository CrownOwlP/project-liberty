import { defineConfig } from "vitest/config";

/**
 * The same `inline` rule `apps/web/vitest.config.ts` states, and for the same
 * reason: every `@liberty/*` workspace publishes raw TypeScript through its
 * `exports` field, and inlining makes the transform explicit rather than
 * dependent on symlink resolution behaving identically on every platform and CI
 * runner. This service imports more of them than any other consumer does, so
 * the rule matters here more, not less.
 */
export default defineConfig({
  test: {
    environment: "node",
    server: {
      deps: {
        inline: [/@liberty\//]
      }
    }
  }
});
