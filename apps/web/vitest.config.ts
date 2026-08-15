import { defineConfig } from "vitest/config";

/**
 * `@liberty/*` workspace packages publish raw TypeScript via their `exports`
 * field. Vite normally resolves the workspace junction to its real path and
 * transforms it as source, but that depends on symlink resolution behaving the
 * same on every platform and CI runner. Inlining them makes the transform
 * explicit instead of incidental, so a runtime (non type-only) import such as
 * `catalogHomeResponseSchema` cannot fail to resolve.
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
