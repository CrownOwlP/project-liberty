/**
 * `@liberty/net-policy` -- what a host is, and how it is spelled.
 *
 * A DEPENDENCY LEAF, and that is the entire reason the package exists rather
 * than being a folder in one of its two consumers. It imports nothing: no
 * `@liberty/*` package, no third-party library, no Node built-in. So an edge
 * from `@liberty/provider-sdk` or from `@liberty/media-inspection` onto this
 * package cannot be half of a cycle, whichever direction the eventual edge
 * between those two points.
 *
 * ```text
 *                 @liberty/net-policy
 *                     ^          ^
 *                     |          |
 *   @liberty/provider-sdk    @liberty/media-inspection
 * ```
 *
 * WHY IT WAS EXTRACTED. `@liberty/media-inspection` reached `classifyHost` in
 * `@liberty/provider-sdk` as an INJECTED PORT, specifically so that there would
 * be one address-range classifier and not two -- two SSRF classifiers drift, the
 * stale one becomes the hole, and nothing fails when they disagree. The port
 * worked for production and failed for verification: PL-0709 needed a test that
 * could hold both implementations at once, and the only way to reach the real
 * `classifyHost` from the other package was a deep relative import across the
 * package boundary, which the reviewer accepted for that single test at that
 * single tree and ruled was not an acceptable permanent boundary. Making either
 * package depend on the other would create or invite a workspace cycle. A lower
 * shared layer that neither can import back is the shape that works.
 *
 * THIS BARREL IS RE-EXPORT ONLY. Both modules are also published as subpaths --
 * `@liberty/net-policy/classify` and `@liberty/net-policy/host` -- and a
 * consumer should prefer those. The omission this package was partly created to
 * fix is a package that publishes one bare entry point and therefore forces its
 * consumers to choose between pulling in everything and reaching inside; making
 * the same omission in the new package would have been the joke writing itself.
 * `module-boundary.test.ts` asserts that every subpath resolves.
 */

export {
  PRIVATE_HOST_SUFFIXES,
  classifyHost,
  classifyResolvedAddress,
  type HostClass
} from "./classify";
export { bareAddress, bracketedLiteral, canonicalHost, withoutRootLabel } from "./host";
