#!/usr/bin/env node
/*
 * The build (PW-0401).
 *
 * WHY A BUNDLE AT ALL. Every `@liberty/*` workspace publishes RAW TYPESCRIPT
 * through its `exports` field -- `@liberty/contracts` resolves to `./src/index.ts`
 * -- which `next` handles with `transpilePackages` and vitest handles with
 * `server.deps.inline`. A plain `node dist/main.js` has neither, and Node's
 * type stripping does not apply inside `node_modules`. So the service is
 * bundled, and the two mechanisms this repository already relies on are joined
 * by a third that does the same thing for a plain Node process.
 *
 * WHAT IS EXTERNAL AND WHY. The four runtime libraries below, and nothing else.
 * They are ordinary published JavaScript with their own dynamic requires and
 * native bindings (`pg`), and bundling them buys nothing while risking the kind
 * of failure that only appears under a real database connection. Everything
 * else -- this service's source and every `@liberty/*` workspace it reaches --
 * is bundled, which is the point.
 *
 * NO PROVIDER CREDENTIAL IS BAKED IN, and nothing here could bake one in: this
 * script defines no constants, reads no environment variable and performs no
 * substitution. Credentials reach this service the way they reach any service,
 * at runtime, from the environment of the process an operator starts.
 */
import { build } from "esbuild";

const EXTERNAL = ["pg", "pg/*", "pg-native"];

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL,
  sourcemap: true,
  logLevel: "info"
});
