import {
  classifyRuntime,
  isClassifiedRuntime,
  type ClassifiedRuntime
} from "@liberty/contracts/shared/runtime";

/* -------------------------------------------------------------------------
 * Is this process a deployment, or is it somebody's laptop?
 *
 * THIS APP'S DOOR TO ONE CLASSIFICATION, WHICH IS NOT HERE. The allowlist, the
 * `NODE_ENV` read and the capability they produce all live in
 * `@liberty/contracts/shared/runtime`. This module holds no array, performs no
 * comparison and reads no environment variable: every function below is one
 * line over that module. What it still owns is the VOCABULARY this application
 * uses for the fact -- `NonDeploymentEnvironment` is what a route asks for, and
 * reads better in a signature than a contracts-package type name would.
 *
 * NOTHING HERE TAKES A RUNTIME NAME, and that is the corrective this file was
 * rewritten for. `classify` used to forward an optional `nodeEnv` to the mint,
 * so a caller could ask for -- and be issued -- a genuine classification of an
 * environment the process was not running in. The mint now reads the process
 * and declares no parameter; these wrappers declare none either, because a
 * wrapper that accepted one would have to invent a way to pass it on, and there
 * is deliberately no longer one.
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
 * THE CALL SITES, ALL CONSUMERS, none of them a second decision:
 *
 *   - `v1/playback/session/authorized-candidates.ts` calls
 *     `NonDeploymentEnvironment.classify()`, because what it gates is the
 *     CONSTRUCTION of a rights claim rather than an input to a later check, and
 *     `localDeploymentFor` for the flag it hands the SDK alongside it;
 *   - `v1/playback/session/issue-session.ts` calls `isLocalDeployment()` for the
 *     `localDeployment` flag it hands to `checkUrl`;
 *   - `v1/playback/resolve/handler.ts` calls `isLocalDeployment()` to decide
 *     whether that development-only route answers at all;
 *   - `watch/watch-session.ts` calls `isLocalDeployment()` for the same
 *     `checkUrl` flag, on the watch page's own copy of the transport gate;
 *   - `lib/db/index.ts` and `lib/session/account.ts` guard the volatile store
 *     and the development identity. Each takes a
 *     `NonDeploymentEnvironment | null` from its own caller and defaults it to
 *     `classify()`, so a test exercises the refusal by passing `null` rather
 *     than by naming an environment. That is the shape for every consumer that
 *     used to forward a `nodeEnv`, including `lib/catalog-source-registry.ts`,
 *     which guards the invented catalog and is owned by a separate lane.
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
 * The `NODE_ENV` values that mean "this process is not a deployment", and the
 * predicate that tests a name against them.
 *
 * RE-EXPORTED, NOT RESTATED. The array is declared once, in
 * `@liberty/contracts/shared/runtime`, and that is also the only place its
 * members are compared against anything. These lines exist so the app's own
 * suites can keep importing the set, and now the test of it, from the module
 * they already import the classification from; a copy here would be the second
 * allowlist this whole arrangement exists to prevent.
 *
 * RE-EXPORTING IT HANDS OUT NO MUTATION CHANNEL, and that is a property of the
 * array rather than of these two lines. It is frozen where it is declared, so a
 * holder of this binding cannot cast it and append `production` -- which, once
 * the mint stopped taking a runtime name, was the last public input through
 * which a consumer could still change who the classifier admits. Were it merely
 * `readonly`, this door would be the app re-exporting its own authority.
 *
 * `isNonDeploymentEnvironmentName` ANSWERS ABOUT A STRING AND ISSUES NOTHING.
 * It is what a test uses to assert which names are admitted, now that no
 * function anywhere will mint a capability from a name. Nothing in this
 * application's own code path calls it: the app asks the process, through
 * `classify` and `isLocalDeployment`.
 */
export {
  NON_DEPLOYMENT_ENVIRONMENTS,
  isNonDeploymentEnvironmentName
} from "@liberty/contracts/shared/runtime";

/**
 * Whether a value this app is holding is a classification the contracts module
 * actually issued.
 *
 * IT BELONGS AT THIS DOOR FOR THE REASON THE TWO LINES ABOVE DO. This module is
 * where the application meets `@liberty/contracts/shared/runtime`: it names the
 * capability (`NonDeploymentEnvironment`), it obtains one (`classify`), and it
 * already publishes the allowlist and the name predicate. The registry check is
 * the runtime half of the same control -- a parameter typed
 * `NonDeploymentEnvironment` is satisfied by an `as unknown as` cast and by a
 * spread copy of a genuine classification, and only object identity tells those
 * from the real thing -- so every consumer in this app that grants something on
 * the strength of the value must call it. Before this line existed those
 * consumers took the capability from here and the predicate from the contracts
 * module directly: one module reached by two routes, for no reason other than
 * that this export was missing.
 *
 * RE-EXPORTED, NOT WRAPPED, exactly like the two above and unlike
 * `localDeploymentFor` below. The registry lives in the contracts module and
 * only that module can add to it; a local function here would be one more hop
 * that could drift, and there is nothing for it to add.
 *
 * All four consumers that check issuance -- `demoCatalogSource`,
 * `selectRepository`, `createInMemoryRepository` and `developmentAccount` --
 * now take both the capability and the predicate through this file, in a single
 * import each. `localDeploymentFor` below is the one caller that does NOT come
 * through this line, and cannot: a re-export creates no local binding, so it
 * calls the predicate through this file's own import at the top instead. Same
 * function object either way.
 */
export { isClassifiedRuntime } from "@liberty/contracts/shared/runtime";

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
 * none can write it; a registry of the values that module actually issued, so a
 * cast or a spread copy is caught at runtime by whoever asks; and a mint that
 * takes no argument, so an issued value is a fact about the process rather than
 * a fact about its caller. The full argument, and what it does not cover, is in
 * that file.
 */
export type NonDeploymentEnvironment = ClassifiedRuntime;

/**
 * The app's name for the one classification.
 *
 * A PLAIN OBJECT RATHER THAN A CLASS, and the shape is what every call site
 * already writes: `NonDeploymentEnvironment.classify()`. It used to be a class
 * with a private constructor, which is a value a consumer can reach for -- and
 * a private field is a compile-time nominality trick that does nothing at
 * runtime, so a spread copy of a real instance passed every check the class
 * could make about itself. The brand-plus-registry in the contracts module
 * catches that; a class could not.
 */
export const NonDeploymentEnvironment = {
  /**
   * Classifies this process, or answers `null` for a deployment.
   *
   * Forwards to `classifyRuntime` and adds nothing -- including the argument it
   * used to add. There is no parameter here because there is no parameter
   * there: the environment classified is the one the process is running under,
   * read AT CALL TIME rather than at module scope, and a caller that wants a
   * different answer would have to be a different process.
   *
   * A TEST REACHES THE REFUSAL WITHOUT NAMING AN ENVIRONMENT. Consumers take a
   * `NonDeploymentEnvironment | null` and default it to this call, so a test
   * passes `null` for the deployment case and, where it needs the granting
   * case, uses the capability this process really has -- vitest runs as `test`,
   * which is on the allowlist.
   */
  classify(): NonDeploymentEnvironment | null {
    return classifyRuntime();
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
 * And it takes no argument, so the boolean is about this process. The two
 * callers that need the flag decided by something other than the running
 * process -- a unit test, and the resolve scaffold's `available` option -- take
 * an injected boolean of their own and never reach for a way to tell this
 * function what environment to consider.
 */
export function isLocalDeployment(): boolean {
  return classifyRuntime() !== null;
}

/**
 * The `localDeployment` flag for a caller that is already holding a
 * classification.
 *
 * DERIVED FROM THE CAPABILITY, NOT FROM A SECOND READ. `authorized-candidates.ts`
 * holds a `NonDeploymentEnvironment` and has to tell `createFixtureProvider`
 * whether this is a local deployment. Calling `isLocalDeployment()` there would
 * ask the process a second time for a question it has already answered -- two
 * reads that a `process.env` write between them could split -- and writing
 * `true` would hardcode one of the two independently-owned permissions
 * `url-policy.ts` requires, which is the mistake that file's `allowLoopback`
 * already had to be corrected for.
 *
 * So it answers from the registry instead: `true` exactly when the contracts
 * module ISSUED this object. A genuine classification means the process was
 * classified as a non-deployment when it was minted, which is what the flag
 * states; a cast or a spread copy answers `false` here and is refused outright
 * by `createFixtureProvider` before the flag is read at all.
 */
export function localDeploymentFor(environment: NonDeploymentEnvironment): boolean {
  return isClassifiedRuntime(environment);
}
