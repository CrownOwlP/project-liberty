import { classifyRuntime, type ClassifiedRuntime } from "@liberty/contracts/shared/runtime";

/* -------------------------------------------------------------------------
 * Is this process a deployment, or is it somebody's laptop?
 *
 * THIS APP'S DOOR TO ONE CLASSIFICATION, WHICH IS NOT HERE. The allowlist, the
 * `NODE_ENV` read and the capability they produce all live in
 * `@liberty/contracts/shared/runtime`. This module holds no array, performs no
 * comparison and reads no environment variable: every function below is one
 * line over `classifyRuntime`. What it still owns is the VOCABULARY this
 * application uses for the fact -- `NonDeploymentEnvironment` is what a route
 * asks for, and reads better in a signature than a contracts-package type name
 * would.
 *
 * WHY THE CLASSIFICATION MOVED (PL-0706). It used to be a class declared here,
 * and `@liberty/provider-sdk` could not import it -- a package cannot depend on
 * an application. So the SDK's `createFixtureProvider` took a structural
 * interface with one field instead, `{ nodeEnv: string }`, exported from the
 * package root alongside the factory. A hosted caller could write that literal
 * and receive a fixture provider declaring `owned` over media nothing had
 * opened, which made the whole gate a naming convention. The fix is a single
 * nominal capability at a boundary BELOW both consumers: `@liberty/contracts`
 * is already a dependency of this app and of the provider SDK, so both can
 * consume the same issued value and neither can mint one.
 *
 * FIVE CALL SITES, ALL CONSUMERS, none of them a second decision:
 *
 *   - `v1/playback/session/authorized-candidates.ts` calls
 *     `NonDeploymentEnvironment.classify()`, because what it gates is the
 *     CONSTRUCTION of a rights claim rather than an input to a later check;
 *   - `v1/playback/session/issue-session.ts` calls `isLocalDeployment()` for the
 *     `localDeployment` flag it hands to `checkUrl`;
 *   - `v1/playback/resolve/handler.ts` calls `isLocalDeployment()` to decide
 *     whether that development-only route answers at all;
 *   - `watch/watch-session.ts` calls `isLocalDeployment()` for the same
 *     `checkUrl` flag, on the watch page's own copy of the transport gate;
 *   - `lib/db/index.ts`, `lib/session/account.ts` and
 *     `lib/catalog-source-registry.ts` call `classify` for the three gates that
 *     keep a volatile store, a development identity and an invented catalog out
 *     of a deployment.
 *
 * BEFORE ANY OF THIS EXISTED EACH ONE DECIDED FOR ITSELF, and they did not agree:
 * the fixture gate had been corrected to an allowlist while `issue-session.ts`
 * still derived `localDeployment` from a `NODE_ENV !== "production"` denylist --
 * so a `staging` process was telling the SSRF gate it was a laptop -- and
 * `watch/watch-session.ts` had no environment test of any kind. Four call sites,
 * four separate answers to one question, one of them the answer not to ask.
 *
 * SHARING THE CLASSIFICATION IS NOT SHARING THE PERMISSION, and the distinction
 * is the one `url-policy.ts` insists on. Loopback still requires TWO
 * independently-owned facts: a source that opted in, AND a deployment that says
 * it is local. This module supplies only the second, only ever as an input, and
 * it grants nothing by itself -- `originIsLoopback` in `authorized-candidates.ts`
 * is what supplies the first, and the two are still checked separately with
 * separate reasons.
 *
 * WHERE THIS SHOULD EVENTUALLY LIVE: `apps/web/src/lib/`, beside the other
 * app-wide helpers. It is under `app/api/` because that was the only directory
 * every consumer could reach inside PL-0301's `allowedPaths` when it was
 * written. It is named for the FACT rather than for any one caller, so when the
 * move happens it is a relocation and not a redesign.
 * ---------------------------------------------------------------------- */

/**
 * The `NODE_ENV` values that mean "this process is not a deployment".
 *
 * RE-EXPORTED, NOT RESTATED. The array is declared once, in
 * `@liberty/contracts/shared/runtime`, and that is also the only place its
 * members are compared against anything. This line exists so the app's own
 * suites can keep importing the set from the module they already import the
 * classification from; a copy here would be the second allowlist this whole
 * arrangement exists to prevent.
 */
export { NON_DEPLOYMENT_ENVIRONMENTS } from "@liberty/contracts/shared/runtime";

/**
 * Evidence that this process is not a deployment, in a form only the contracts
 * module can produce.
 *
 * AN ALIAS, DELIBERATELY, AND NOT A WRAPPER. Re-boxing the capability into an
 * app-local type would mean this module could mint one -- which is exactly the
 * property the corrective removed. The value a route holds is the value
 * `classifyRuntime` issued and registered, unchanged, so a consumer that asks
 * the registry (the fixture provider does, at the top of its factory) is asking
 * about the same object.
 *
 * WHY A VALUE AND NOT A BOOLEAN. What this gates is the CONSTRUCTION of things a
 * deployment must not be able to build -- a fabricated rights basis, a volatile
 * store standing in for a database, an invented catalog. The previous
 * arrangement enforced that with a runtime `if`, and a later edit can delete a
 * condition while everything still compiles; that is how the watch route came to
 * carry an unguarded second copy of the fixtures. A caller cannot reach any of
 * those constructors without handling the `null` from `classify`, so deleting
 * the check is a COMPILE ERROR rather than a silent widening.
 *
 * WHAT MAKES IT UNFORGEABLE is a brand whose key is a `unique symbol` private to
 * `@liberty/contracts/shared/runtime`, so no consumer can name it and therefore
 * none can write it, plus a registry of the values that module actually issued,
 * so a cast or a spread copy is caught at runtime by whoever asks. The full
 * argument, and what it does not cover, is in that file.
 */
export type NonDeploymentEnvironment = ClassifiedRuntime;

/**
 * The app's name for the one classification.
 *
 * A PLAIN OBJECT RATHER THAN A CLASS, and the shape is what every call site
 * already writes: `NonDeploymentEnvironment.classify(...)`. It used to be a
 * class with a private constructor, which is a value a consumer can reach for --
 * and a private field is a compile-time nominality trick that does nothing at
 * runtime, so a spread copy of a real instance passed every check the class
 * could make about itself. The brand-plus-registry in the contracts module
 * catches that; a class could not.
 */
export const NonDeploymentEnvironment = {
  /**
   * Classifies the process, or answers `null` for a deployment.
   *
   * Forwards to `classifyRuntime` and adds nothing. `nodeEnv` is optional rather
   * than defaulted here, so the read of `process.env.NODE_ENV` happens in the
   * one module that owns it: a default in this file would be a second reader,
   * and two readers is how a route and the gate it consults come to be looking
   * at different environments. Omitting the argument therefore still reads the
   * environment AT CALL TIME, never at module scope.
   *
   * The argument exists so a test can state the environment it means instead of
   * mutating `process.env` and racing every other suite in the same worker.
   */
  classify(nodeEnv?: string): NonDeploymentEnvironment | null {
    return classifyRuntime(nodeEnv);
  }
} as const;

/**
 * Whether this instance of Project Liberty is a local or development
 * deployment rather than a hosted one.
 *
 * The boolean form of the same classification, for the callers that need to
 * hand a `localDeployment` flag to `@liberty/provider-sdk`'s URL policy or to
 * decide whether a development-only route exists. It is one line over
 * `classifyRuntime` rather than a second test of the array, so the two answers
 * cannot disagree.
 *
 * A BOOLEAN IS THE RIGHT SHAPE HERE AND THE WRONG SHAPE FOR THE FIXTURES. What
 * this value gates is an INPUT to a check that runs either way: `checkUrl` is
 * called with it and refuses loopback when it is false, so a caller that lost
 * the flag gets a refusal. What `NonDeploymentEnvironment` gates is the
 * CONSTRUCTION of a rights claim, where a caller that loses the check gets the
 * claim. Those need different mechanisms, and giving them the same one is what
 * produced the breach.
 *
 * It discards the capability it just obtained rather than returning it, which is
 * the point: a boolean cannot be handed to anything that grants construction.
 */
export function isLocalDeployment(nodeEnv?: string): boolean {
  return classifyRuntime(nodeEnv) !== null;
}
