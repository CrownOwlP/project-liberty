/* -------------------------------------------------------------------------
 * Is this process a deployment, or is it somebody's laptop?
 *
 * ONE FACT, READ IN ONE PLACE. Two unrelated permissions in this app need the
 * answer -- whether the fixture provider may resolve at all
 * (`FIXTURE_ENVIRONMENTS` in `v1/playback/session/authorized-candidates.ts`)
 * and whether `@liberty/provider-sdk`'s URL policy may be told
 * `localDeployment: true` -- and before this module existed each one computed
 * it for itself, differently:
 *
 *   - the fixture gate had already been corrected to an ALLOWLIST, because the
 *     old `NODE_ENV !== "production"` admitted `staging`, `preview`,
 *     `Production`, `""` and unset;
 *   - `issue-session.ts` still derived `localDeployment` from that same
 *     denylist, so a `staging` process was telling the SSRF gate it was a
 *     laptop;
 *   - and `watch/watch-session.ts` had no environment test of any kind.
 *
 * Three call sites, three answers, one question. That is the shape this task
 * exists to remove, so the classification lives here and the callers consult
 * it.
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
 * both consumers could reach inside PL-0301's `allowedPaths` when it was
 * written; the corrective task PL-0703 declares both surfaces, so that
 * constraint no longer applies and the location is now inertia rather than a
 * reason. It is named for the FACT rather than for either caller, so the move
 * is a rename and not a redesign.
 * ---------------------------------------------------------------------- */

/**
 * The `NODE_ENV` values that mean "this process is not a deployment".
 *
 * These two are the whole set: `next dev` runs as `development`, and vitest
 * sets `test`. Every other value -- including no value at all -- is treated as
 * a deployment, which is the direction that fails safe.
 *
 * Exported so a test can enumerate the permitted values rather than restating
 * them, and so the one place to review a widening is this array.
 */
export const NON_DEPLOYMENT_ENVIRONMENTS: readonly string[] = ["development", "test"];

/**
 * Whether this instance of Project Liberty is a local or development
 * deployment rather than a hosted one.
 *
 * The argument exists so a test can state the environment it means instead of
 * mutating `process.env` and racing every other suite in the same worker. It
 * defaults to a read of `process.env` AT CALL TIME, never at module scope: a
 * module-scope read freezes the answer to whatever the process looked like when
 * the first route was loaded, which in a serverless cold start is not
 * necessarily the request's environment.
 *
 * `?? ""` rather than a nullish test, so an unset variable and an empty string
 * are the same answer -- neither is on the allowlist, and both mean "nobody
 * said", which is not a claim to be local.
 */
export function isLocalDeployment(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return NON_DEPLOYMENT_ENVIRONMENTS.includes(nodeEnv ?? "");
}
