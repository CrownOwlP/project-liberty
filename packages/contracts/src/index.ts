/* -------------------------------------------------------------------------
 * `@liberty/contracts` — COMPATIBILITY BARREL.
 *
 * Re-export only. Nothing is DEFINED here, and nothing inside this package
 * imports from here.
 *
 * This file is not the authoritative public surface. The authoritative surfaces
 * are the subpath exports declared in `package.json`:
 *
 *   @liberty/contracts/shared/<vocabulary>   leaf vocabularies (rights, codecs,
 *                                            media facts, normalized ids)
 *   @liberty/contracts/domains/<domain>      one module per domain contract
 *
 * Both are WILDCARD exports, which is the property that matters: adding
 * `domains/live.ts` or `domains/auth.ts` later requires touching neither this
 * file nor `package.json`. A new domain contract does NOT have to be appended
 * here — if it did, this barrel would simply become the new global mutex that
 * `packages/contracts/**` ownership used to be, and the whole point of the
 * split would be lost.
 *
 * Existing root imports keep working, which is why the barrel exists at all.
 * Prefer the subpath when writing new code, and prefer it when touching an old
 * import: `import type { StreamCandidate } from "@liberty/contracts/domains/playback"`
 * says what a module actually depends on, and a review of the playback contract
 * can then see who its real consumers are.
 *
 * Every line below is `export *`, and `packages/contracts/src/module-boundary.test.ts`
 * asserts that mechanically — a schema definition that lands here is a
 * regression, not a shortcut.
 * ---------------------------------------------------------------------- */

/* Shared leaf vocabularies. */
export * from "./shared/codecs";
export * from "./shared/ids";
export * from "./shared/media-facts";
export * from "./shared/rights";

/* Domain contracts. */
export * from "./domains/audio";
export * from "./domains/catalog";
export * from "./domains/failover";
export * from "./domains/playback";
export * from "./domains/search";
export * from "./domains/subtitles";
export * from "./domains/title";
