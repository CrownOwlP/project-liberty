import { configDefaults, defineConfig } from "vitest/config";

/**
 * WHY THIS FILE EXISTS: one suite must never run inside a gate.
 *
 * `src/wikidata.live.test.ts` talks to the real Wikidata Query Service and the
 * real MediaWiki Action API. Everything else in this package is deterministic
 * and offline -- the adapter's tests drive RECORDED real responses through the
 * real egress boundary -- and belongs in the default run, which is what
 * `turbo run test` and `npm run check` invoke.
 *
 * A NETWORK TEST IN A GATE IS A LIABILITY, and this one is a bad candidate twice
 * over. Wikimedia rate-limits by address: researching this adapter drew an HTTP
 * 429 twice within a few minutes from a single client, and the User-Agent policy
 * is explicit that a misbehaving client may be IP-BLOCKED WITHOUT NOTICE. A CI
 * fleet running the live suite on every push is therefore not merely flaky, it
 * is a way to get an operator blocked. Separately, a shared public SPARQL
 * endpoint is allowed to be slow -- the enumeration query measured between 2.3
 * and 32.8 seconds depending on the watermark -- and a gate that goes red
 * because Wikidata is busy teaches a reader to ignore the gate.
 *
 * SO THE EXCLUSION IS MECHANICAL, NOT A NAMING CONVENTION SOMEBODY REMEMBERS.
 * The pattern is added to vitest's own defaults rather than replacing them, so
 * `node_modules`, `dist` and the rest stay excluded.
 *
 * `--mode live` IS WHAT LIFTS IT, following the `--mode bench` precedent in
 * `packages/media-engine/vitest.config.ts`. A path argument is NOT enough and
 * that was found by trying it: vitest applies `exclude` to the file list before
 * a positional filter narrows it, so `vitest run src/wikidata.live.test.ts`
 * against this config reports "No test files found" and exits 1. The mode is
 * therefore the switch, and `npm run test:live` in this package passes both.
 *
 * DO NOT "fix" a stale fixture by deleting this exclusion. The live suite exists
 * to be run deliberately by a human who wants to know whether the recordings in
 * `src/__fixtures__` still describe reality; making it incidental destroys both
 * that property and the gate.
 */
export default defineConfig(({ mode }) => ({
  test: {
    environment: "node",
    // `--mode live` (used by `npm run test:live`) is the only way to reach the
    // network suite. Every other invocation, including `turbo run test`, gets
    // the exclusion.
    exclude:
      mode === "live"
        ? [...configDefaults.exclude]
        : [...configDefaults.exclude, "**/*.live.test.ts"]
  }
}));
