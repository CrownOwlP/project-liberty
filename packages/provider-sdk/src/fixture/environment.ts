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
 * `./rights`) takes one of these, and there is no other constructor of a fixture
 * rights basis.
 *
 * WHERE THE ALLOWLIST WENT, AND WHY THERE IS NO `NON_PRODUCTION_RUNTIMES` HERE
 * ANY MORE. This module used to carry `["development", "test"]` and test a
 * caller-supplied name against it. `apps/web/src/app/api/deployment-environment.ts`
 * carries the same two values for the same decision, and its copy is the
 * better-informed one: it reads `NODE_ENV` at the process boundary, and the
 * fixture path's other consumers -- the session route's transport gate, the
 * `v1/playback/resolve` scaffold, the watch page -- already consult it. Two
 * allowlists for one question is the arrangement this corrective exists to
 * remove, and a header that acknowledged the application's copy and then
 * re-expressed it anyway was an admission rather than a justification. THE
 * CLASSIFICATION IS THE DEPLOYMENT'S. This package requires evidence that one
 * happened and no longer performs one.
 *
 * THAT IT CANNOT PERFORM ONE IS A FACT ABOUT THIS PACKAGE AND NOT A PROMISE:
 * there is no `process.env` read anywhere under `src/`, so nothing here can
 * obtain a runtime name from ambient state. A name arrives as an argument or it
 * does not arrive.
 *
 * WHAT THE WITNESS STILL ESTABLISHES, stated exactly, because a comment that
 * overclaims a check is worse than having no check:
 *
 *   - it is UNFORGEABLE BY SHAPE. The CONSTRUCTOR is private, so no other module
 *     can `new` one, and a PRIVATE FIELD is present, so TypeScript compares this
 *     class NOMINALLY rather than structurally -- without it `{ name: "test" }`
 *     would be assignable to the type and the whole mechanism would be
 *     decoration. Both are load bearing and `provider.test.ts` asserts each as a
 *     compile error;
 *   - it is UNREACHABLE FROM OUTSIDE THIS PACKAGE. `NonProductionRuntime` is not
 *     re-exported by `../index.ts`, and the package publishes exactly one entry
 *     point (`"exports": "./src/index.ts"`), so no consumer can name the type or
 *     call `from`. `createFixtureProvider` mints the witness inside the factory
 *     from the classification it was handed, which makes that factory the only
 *     door to a fabricated `owned` declaration -- and it is a door that cannot be
 *     opened without an argument.
 *
 * WHAT IT DOES NOT ESTABLISH. It cannot tell whether the classification it was
 * handed describes the process it is running in. A caller that passes
 * `{ nodeEnv: "test" }` from a hosted process gets a provider, and nothing inside
 * a package can close that: the fact lives in the deployment. In this repository
 * the only caller outside this package's own tests is `apps/web`'s
 * `v1/playback/session/authorized-candidates.ts`, and it cannot reach
 * `createFixtureProvider` without a `NonDeploymentEnvironment` -- a value with
 * its own private constructor and private field, minted only by
 * `NonDeploymentEnvironment.classify`, which reads `NODE_ENV` at the process
 * boundary and answers `null` for every value off the one allowlist. So the
 * application classifies, this package requires the classification to have
 * happened, and there is one place to review a widening.
 *
 * What none of this defends against is an edit to this module. Nothing in
 * TypeScript can. What it defends against is the way this defect actually
 * recurs: a change made somewhere else that quietly stops consulting the gate.
 * A forgery has to be written as a cast or as an edit to these files, both of
 * which are visible in a diff and neither of which is something a passing build
 * will hide.
 * ---------------------------------------------------------------------- */

/**
 * A deployment's own answer to "what runtime is this process".
 *
 * ONE FIELD, AND IT IS THE ONE THIS PACKAGE MUST NOT INVENT. `nodeEnv` is named
 * for what it is rather than given a package-local vocabulary: every caller this
 * SDK has is a Node or Next process, `NODE_ENV` is the one fact about such a
 * process that no configuration file can forge (`scripts/with-root-env.mjs`
 * refuses to apply it from a dotenv file at all, precisely so a copied
 * `.env.local` cannot turn `next start` into a fixture-serving deployment), and
 * a second spelling would mean the application translating between two names for
 * one fact -- which is the shape of duplication this change removed.
 *
 * `apps/web`'s `NonDeploymentEnvironment` satisfies this interface as it stands,
 * so the application hands over the witness it already holds instead of building
 * a literal at the call site. A literal satisfies it too; the header states
 * exactly what that does and does not mean.
 */
export interface RuntimeClassification {
  readonly nodeEnv: string;
}

export class NonProductionRuntime {
  /**
   * The name the classification stated.
   *
   * Private for the nominal-typing reason in the header, and exposed read-only
   * through `name` because a caller that reports WHICH runtime admitted the
   * fixtures (a test, a log line, the provider's own `runtime` field) should
   * read the value the attestation actually used rather than reaching for a
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
   * A witness for a classification that states a runtime, or `null` for one that
   * states nothing.
   *
   * THE `null` IS NOT AN ALLOWLIST AND MUST NOT BECOME ONE. It refuses a blank
   * `nodeEnv` -- a caller that classified nothing -- for the reason
   * `isOpaqueRightsReference` refuses an empty reference: this value is carried
   * into `FixtureRightsBasis.attestedRuntime` and into the provider's `runtime`,
   * so a rights basis whose provenance field is empty records nothing while
   * looking like it records something. WHICH NAMES MEAN PRODUCTION is a
   * different question, it is one this package cannot answer, and it is answered
   * by the deployment before it gets here.
   *
   * The name is reported exactly as the deployment stated it and is never
   * trimmed into shape: this is provenance, and a value quietly edited on the
   * way through is provenance about something else.
   */
  static from(classification: RuntimeClassification): NonProductionRuntime | null {
    return classification.nodeEnv.trim() === ""
      ? null
      : new NonProductionRuntime(classification.nodeEnv);
  }
}
