/* -------------------------------------------------------------------------
 * Evidence that this process is not a production runtime (PL-0301).
 *
 * WHY THIS TYPE EXISTS AT ALL. The fixture provider in this directory declares
 * `owned` over media nothing has ever opened. Nothing in this package verifies
 * that -- there is no probe, no manifest is read, and every consumer of
 * `AuthorizedMediaProvider` treats a declared rights value exactly as it treats
 * any adapter's, because the platform's model is that adapters ESTABLISH
 * authorization and the engine ranks among what they established. An
 * unverifiable declaration therefore has exactly one real control, and it is
 * that the declaration cannot be constructed on a build that ships.
 *
 * A CONDITION IS THE WRONG MECHANISM FOR THAT, and the repository has already
 * paid for using one. `apps/web` gated its fixtures with
 * `FIXTURE_ENVIRONMENTS.includes(process.env.NODE_ENV ?? "")`: correct, and
 * deletable. Delete the condition and every fixture resolves in production, and
 * everything still compiles -- which is not hypothetical, because a second copy
 * of those fixtures shipped in the watch route under no environment condition at
 * all. So the permission is carried by a VALUE. `fixtureRightsBasis` (see
 * `./rights`) takes one of these, and there is no other way to obtain one than
 * `attest`, which answers `null` off the allowlist. Under `strictNullChecks` a
 * caller cannot reach the fixture basis without handling that `null`: removing
 * the check is a COMPILE ERROR rather than a silent widening.
 *
 * TWO THINGS MAKE THE TYPE UNFORGEABLE FROM OUTSIDE THIS MODULE, and both are
 * needed:
 *
 *   - the CONSTRUCTOR is private, so no other module can `new` one;
 *   - a PRIVATE FIELD is present, so TypeScript compares this class NOMINALLY
 *     rather than structurally. Without it `{ name: "test" }` would be
 *     assignable to the type and the whole mechanism would be decoration.
 *
 * WHY THE SDK CANNOT SIMPLY IMPORT THE APP'S ANSWER, which is the obvious
 * objection. `apps/web/src/app/api/deployment-environment.ts` already owns a
 * witness of exactly this shape (`NonDeploymentEnvironment`), and it is the
 * better-informed one: it reads `NODE_ENV` from the running process. A package
 * cannot import from an application, so the guarantee has to be re-expressed in
 * this package's own terms, and this is that expression.
 *
 * WHAT THIS ONE CAN AND CANNOT ESTABLISH, stated exactly, because a comment that
 * overclaims a check is worse than having no check. `attest` is handed a runtime
 * NAME by its caller. It checks that name against an allowlist and refuses
 * everything else -- so `attest("production")`, `attest("staging")`,
 * `attest("")` and `attest(anythingNobodyThoughtOf)` all answer `null`. It
 * CANNOT verify that the name it was handed is the name of the process it is
 * running in; a caller that passes the literal `"test"` from a hosted process
 * gets a witness.
 *
 * THAT LIMIT IS WHY THE TWO GATES ARE CHAINED RATHER THAN DUPLICATED, and the
 * chaining is the same two-owner pattern `stremio/url-policy.ts` insists on for
 * loopback. The deployment's own classification supplies the fact this module
 * cannot check -- in `apps/web`, `NonDeploymentEnvironment.classify()` reads
 * `NODE_ENV` at the process boundary and publishes the value it used as
 * `nodeEnv`, which is precisely the value a caller passes here. Both conditions
 * are required, they are owned by different modules in different packages, and
 * DRIFT BETWEEN THEM FAILS CLOSED IN BOTH DIRECTIONS: a runtime name the app
 * admits and this allowlist does not produces no provider, and a name this
 * allowlist admits and the app's does not never reaches `attest`.
 *
 * What none of this defends against is an edit to this module. Nothing in
 * TypeScript can. What it defends against is the way this defect actually
 * recurs: a change made somewhere else that quietly stops consulting the gate.
 * A forgery has to be written as a cast or as an edit to these files, both of
 * which are visible in a diff and neither of which is something a passing build
 * will hide.
 * ---------------------------------------------------------------------- */

/**
 * The runtime names this package is willing to treat as "not production".
 *
 * These are `NODE_ENV` values, and naming them that way is deliberate rather
 * than a leak of a Node concept into a runtime-agnostic package: every caller
 * this SDK has is a Node or Next process, `NODE_ENV` is the one fact about such
 * a process that no configuration file can forge (`scripts/with-root-env.mjs`
 * refuses to apply it from a dotenv file at all), and inventing a second
 * vocabulary here would mean the app translating between two spellings of one
 * fact.
 *
 * `development` and `test` are the whole set: `next dev` runs as the first and
 * vitest sets the second. Every other value -- including no value at all -- is
 * treated as production, which is the direction that fails safe.
 *
 * Exported so a test can enumerate the permitted values rather than restating
 * them, and so the one place to review a widening is this array. Widening it is
 * a RIGHTS-RELEVANT edit: it widens the construction gate on a fabricated rights
 * basis, which is the only control that basis has.
 */
export const NON_PRODUCTION_RUNTIMES: readonly string[] = ["development", "test"];

export class NonProductionRuntime {
  /**
   * The name that satisfied the allowlist.
   *
   * Private for the nominal-typing reason in the header, and exposed read-only
   * through `name` because a caller that reports WHICH runtime admitted the
   * fixtures (a test, a log line, the provider's own `runtime` field) should
   * read the value the attestation actually used rather than re-deriving a
   * possibly different one.
   */
  private readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /** The runtime name this witness was attested from. Never re-tested. */
  get name(): string {
    return this.value;
  }

  /**
   * A witness, or `null` for every name outside the allowlist.
   *
   * The name is a REQUIRED argument and is never read from `process.env` here.
   * That follows the position `stremio/source.ts` already takes about
   * `DeploymentContext`: "this gate is pure and testable, and the deployment's
   * answer must come from the deployment". A `process.env` read inside this
   * package would also be a second, independently-drifting classification of a
   * fact the application has already classified -- see the header for why the
   * two gates are chained instead.
   *
   * An allowlist, for the reason every other gate in this repository is one:
   * `PLAYABLE_CONTENT_RIGHTS`, `RIGHTS_BASIS_KINDS` and the engine's eligibility
   * check all refuse what they do not recognise rather than permitting it. A
   * denylist of the single string `production` fails open on every value nobody
   * thought of.
   */
  static attest(runtimeName: string): NonProductionRuntime | null {
    return NON_PRODUCTION_RUNTIMES.includes(runtimeName)
      ? new NonProductionRuntime(runtimeName)
      : null;
  }
}
