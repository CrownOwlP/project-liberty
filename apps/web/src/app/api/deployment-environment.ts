/* -------------------------------------------------------------------------
 * Is this process a deployment, or is it somebody's laptop?
 *
 * ONE FACT, READ IN ONE PLACE. Three permissions in this app need the answer --
 * whether the fixture provider may be constructed at all, whether the
 * candidate-ranking scaffold at `v1/playback/resolve` exists, and whether
 * `@liberty/provider-sdk`'s URL policy may be told `localDeployment: true`. They
 * are asked for at FOUR call sites, because two separate routes run their own
 * transport gate and so each need the last one. All four, as they stand today:
 *
 *   - `v1/playback/session/authorized-candidates.ts` calls
 *     `NonDeploymentEnvironment.classify()`, because what it gates is the
 *     CONSTRUCTION of a rights claim rather than an input to a later check;
 *   - `v1/playback/session/issue-session.ts` calls `isLocalDeployment()` for the
 *     `localDeployment` flag it hands to `checkUrl`;
 *   - `v1/playback/resolve/handler.ts` calls `isLocalDeployment()` to decide
 *     whether that development-only route answers at all;
 *   - `watch/watch-session.ts` calls `isLocalDeployment()` for the same
 *     `checkUrl` flag, on the watch page's own copy of the transport gate.
 *
 * BEFORE THIS MODULE EXISTED EACH ONE DECIDED FOR ITSELF, and they did not agree:
 *
 *   - the fixture gate had already been corrected to an ALLOWLIST, because the
 *     old `NODE_ENV !== "production"` admitted `staging`, `preview`,
 *     `Production`, `""` and unset;
 *   - `issue-session.ts` still derived `localDeployment` from that same
 *     denylist, so a `staging` process was telling the SSRF gate it was a
 *     laptop;
 *   - `resolve/handler.ts` began on the same denylist -- which exposed a route
 *     that ranks CALLER-SUPPLIED candidates on any deployment whose `NODE_ENV`
 *     was not exactly `production` -- and was then corrected by restating the
 *     allowlist's `.includes` test locally, which is a copy rather than a
 *     consumer;
 *   - and `watch/watch-session.ts` had no environment test of any kind.
 *
 * Four call sites, four separate decisions about one question -- one of them the
 * decision not to ask. That is the shape this module
 * exists to remove, so the classification lives here and the callers consult
 * it. The array below is the only place the permitted values are written, and
 * `NonDeploymentEnvironment.classify` is the only place they are tested: every
 * other consumer either calls `classify` or calls `isLocalDeployment`, which is
 * itself one line over `classify`.
 *
 * SHARING THE CLASSIFICATION IS NOT SHARING THE PERMISSION, and the distinction
 * is the one `url-policy.ts` insists on. Loopback still requires TWO
 * independently-owned facts: a source that opted in, AND a deployment that says
 * it is local. This module supplies only the second, only ever as an input, and
 * it grants nothing by itself -- `originIsLoopback` in the fixture provider is
 * still what supplies the first, and the two are still checked separately with
 * separate reasons. What is shared is the reading of `NODE_ENV`, which is a
 * fact about the process and cannot honestly have two values at once.
 *
 * AN ALLOWLIST, for the reason every other gate in this repository is one:
 * `PLAYABLE_CONTENT_RIGHTS`, `RIGHTS_BASIS_KINDS` and the engine's eligibility
 * check all refuse what they do not recognise rather than permitting it. A
 * denylist of the single string `production` fails open on every value nobody
 * thought of, and the failure mode here is a hosted process describing itself
 * to an SSRF gate as a local one.
 *
 * WHY `NODE_ENV` AND NOT A DEDICATED FLAG. It is the one fact about the running
 * process that no configuration file can forge. `scripts/with-root-env.mjs`
 * refuses to apply `NODE_ENV` from a dotenv file at all (`NEVER_APPLIED`),
 * precisely so a copied `.env.local` cannot turn `next start` into a
 * fixture-serving deployment, and Next computes its own file set before merging
 * so `apps/web/.env.local` cannot either. A new `LIBERTY_IS_LOCAL` variable
 * would have none of that protection and would be a second switch that could
 * disagree with this one.
 *
 * THE REMAINING GAP, recorded rather than papered over: a hosted deployment
 * that exports `NODE_ENV=development` and runs `next dev` is indistinguishable
 * from a laptop here, because it IS a development build. Nothing a string test
 * can do closes that; the control for it is not shipping one.
 *
 * WHERE THIS SHOULD EVENTUALLY LIVE: `apps/web/src/lib/`, beside the other
 * app-wide helpers. It is under `app/api/` because that was the only directory
 * every consumer could reach inside PL-0301's `allowedPaths` when it was
 * written. PL-0703 declares this FILE by name and the watch route, but not
 * `apps/web/src/lib/**`, so the move is still outside a declared surface and is
 * still not made here. It is named for the FACT rather than for any one caller,
 * so when the move happens it is a relocation and not a redesign.
 * ---------------------------------------------------------------------- */

/**
 * The `NODE_ENV` values that mean "this process is not a deployment".
 *
 * These two are the whole set: `next dev` runs as `development`, and vitest
 * sets `test`. Every other value -- including no value at all -- is treated as
 * a deployment, which is the direction that fails safe.
 *
 * Exported so a test can enumerate the permitted values rather than restating
 * them, and so the one place to review a widening is this array. Widening it is
 * a RIGHTS-RELEVANT edit: it widens the fixture provider's construction gate and
 * the resolve scaffold's availability at the same time, on purpose, because a
 * value that genuinely stopped being a deployment would have to change all three
 * answers together.
 */
export const NON_DEPLOYMENT_ENVIRONMENTS: readonly string[] = ["development", "test"];

/**
 * Evidence that this process is not a deployment, in a form only this module can
 * produce.
 *
 * WHY A VALUE AND NOT A BOOLEAN, and why it is worth a class. The corrective
 * this type exists for (PL-0703) had to make a fabricated rights basis
 * UNREACHABLE from a deployment, and the previous arrangement enforced that with
 * a runtime `if` in the resolver: delete the condition and the fixtures ship. A
 * later edit can delete a condition and everything still compiles, which is
 * exactly how the watch route came to carry an unguarded second copy of the same
 * fixtures in the first place.
 *
 * So the permission is carried by a VALUE instead. `fixtureProvider` in
 * `v1/playback/session/authorized-candidates.ts` takes one of these, and there
 * is no other way to obtain one than `classify`, which returns `null` outside
 * the allowlist. Under `strictNullChecks` the caller therefore cannot reach the
 * fixture provider without handling the `null` -- deleting that check is a
 * COMPILE ERROR rather than a silent widening, and the fabricated basis is a
 * value that cannot be constructed on a build that ships.
 *
 * TWO THINGS MAKE IT UNFORGEABLE FROM OUTSIDE, and both are needed:
 *
 *   - the CONSTRUCTOR is private, so no other module can `new` one;
 *   - a PRIVATE FIELD is present, so TypeScript compares this class nominally
 *     rather than structurally. Without it `{ nodeEnv: "test" }` would be
 *     assignable to the type and the whole mechanism would be decoration.
 *
 * What it is NOT is a security boundary against someone editing this file. It
 * is a boundary against the ordinary way this defect recurs: a change made
 * somewhere else that quietly stops consulting the gate. A forgery here has to
 * be written as a cast or as an edit to this module, both of which are visible
 * in a diff and neither of which is something a passing build will hide.
 */
export class NonDeploymentEnvironment {
  /**
   * The value that satisfied the allowlist.
   *
   * Private for the nominal-typing reason above, and exposed read-only through
   * `nodeEnv` because a caller that reports WHICH environment admitted it (a
   * test, a log line) should not have to re-read `process.env` and risk
   * reporting a different answer from the one that was actually used.
   */
  private readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /** The `NODE_ENV` this witness was classified from. Never re-tested. */
  get nodeEnv(): string {
    return this.value;
  }

  /**
   * Classifies the process, or answers `null` for a deployment.
   *
   * The argument exists so a test can state the environment it means instead of
   * mutating `process.env` and racing every other suite in the same worker. It
   * defaults to a read of `process.env` AT CALL TIME, never at module scope: a
   * module-scope read freezes the answer to whatever the process looked like
   * when the first route was loaded, which in a serverless cold start is not
   * necessarily the request's environment.
   *
   * `?? ""` rather than a nullish test, so an unset variable and an empty string
   * are the same answer -- neither is on the allowlist, and both mean "nobody
   * said", which is not a claim to be local.
   */
  static classify(
    nodeEnv: string | undefined = process.env.NODE_ENV
  ): NonDeploymentEnvironment | null {
    const value = nodeEnv ?? "";
    return NON_DEPLOYMENT_ENVIRONMENTS.includes(value)
      ? new NonDeploymentEnvironment(value)
      : null;
  }
}

/**
 * Whether this instance of Project Liberty is a local or development
 * deployment rather than a hosted one.
 *
 * The boolean form of the same classification, for the callers that need to
 * hand a `localDeployment` flag to `@liberty/provider-sdk`'s URL policy or to
 * decide whether a development-only route exists. It is one line over
 * `classify` rather than a second test of the array, so the two answers cannot
 * disagree.
 *
 * A BOOLEAN IS THE RIGHT SHAPE HERE AND THE WRONG SHAPE FOR THE FIXTURES. What
 * this value gates is an INPUT to a check that runs either way: `checkUrl` is
 * called with it and refuses loopback when it is false, so a caller that lost
 * the flag gets a refusal. What `NonDeploymentEnvironment` gates is the
 * CONSTRUCTION of a rights claim, where a caller that loses the check gets the
 * claim. Those need different mechanisms, and giving them the same one is what
 * produced the breach.
 */
export function isLocalDeployment(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return NonDeploymentEnvironment.classify(nodeEnv) !== null;
}
