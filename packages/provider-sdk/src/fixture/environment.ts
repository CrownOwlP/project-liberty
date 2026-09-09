import { isClassifiedRuntime, type ClassifiedRuntime } from "@liberty/contracts/shared/runtime";

/* -------------------------------------------------------------------------
 * Evidence that this process is not a production runtime (PL-0301, PL-0706).
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
 * WHAT ARRIVES FROM OUTSIDE, AND WHY IT IS NO LONGER A SHAPE. This module used
 * to declare a public `RuntimeClassification` interface holding one field,
 * `nodeEnv`, and mint its witness from whatever structural object it was
 * handed. Both that interface and `createFixtureProvider` were exported from the
 * package root, so a hosted caller could write `{ nodeEnv: "test" }` and receive
 * a provider -- which made the whole mechanism a naming convention. PL-0706
 * removed it. The argument is now `ClassifiedRuntime` from
 * `@liberty/contracts/shared/runtime`: a branded value whose key is a
 * module-private `unique symbol` nobody outside that file can name, minted only
 * by `classifyRuntime` after the one allowlist test in this repository, frozen,
 * and recorded in a registry that `isClassifiedRuntime` answers from. A literal
 * does not compile; a cast and a spread copy compile and are refused below.
 *
 * WHERE THE ALLOWLIST IS, AND WHY THERE IS NO `NON_PRODUCTION_RUNTIMES` HERE.
 * This module used to carry `["development", "test"]` and test a caller-supplied
 * name against it, while `apps/web` carried the same two values for the same
 * decision. Two allowlists for one question is the arrangement that corrective
 * removed, and a header that acknowledged the other copy and then re-expressed
 * it anyway was an admission rather than a justification. There is now exactly
 * one copy, in `@liberty/contracts/shared/runtime`, and both the application and
 * this package consume it. THE CLASSIFICATION IS NOT THIS PACKAGE'S TO PERFORM:
 * it requires evidence that one happened.
 *
 * THAT IT CANNOT PERFORM ONE IS A FACT ABOUT THIS PACKAGE AND NOT A PROMISE:
 * there is no `process.env` read anywhere under `src/`, so nothing here can
 * obtain a runtime name from ambient state. A name arrives inside a classified
 * runtime or it does not arrive.
 *
 * WHAT THE WITNESS ESTABLISHES, stated exactly, because a comment that
 * overclaims a check is worse than having no check:
 *
 *   - IT WAS ISSUED, not merely shaped. `from` consults the contracts registry
 *     by object identity before it mints anything, so the two forgeries that get
 *     past a compile-time brand -- `{} as unknown as ClassifiedRuntime`, and
 *     `{ ...realClassification }` which copies the brand and type-checks -- both
 *     answer `null` here and are refused by name in `./provider.ts`.
 *   - IT IS UNFORGEABLE BY SHAPE. The CONSTRUCTOR is private, so no other module
 *     can `new` one, and a PRIVATE FIELD is present, so TypeScript compares this
 *     class NOMINALLY rather than structurally -- without it `{ name: "test" }`
 *     would be assignable to the type. Both are load bearing and
 *     `provider.test.ts` asserts each as a compile error.
 *   - IT IS UNREACHABLE FROM OUTSIDE THIS PACKAGE. `NonProductionRuntime` is not
 *     re-exported by `../index.ts`, and the package publishes exactly one entry
 *     point (`"exports": "./src/index.ts"`), so no consumer can name the type or
 *     call `from`. `createFixtureProvider` mints the witness inside the factory
 *     from the classification it was handed, which makes that factory the only
 *     door to a fabricated `owned` declaration -- and it is a door that cannot be
 *     opened without a classification the application issued.
 *
 * WHAT REMAINS, recorded rather than papered over. An edit to
 * `@liberty/contracts/shared/runtime`, or to these files, defeats this; nothing
 * in TypeScript can prevent that, and both are visible in a diff. And a
 * deployment that exports `NODE_ENV=development` and runs `next dev` is
 * classified as a non-deployment because it IS a development build -- the
 * control for that one is not shipping one. What is closed is the way this
 * defect actually recurs: a call site that stops consulting the gate, or one
 * that hands this factory a value it wrote itself.
 * ---------------------------------------------------------------------- */

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
   * A witness for a classification this repository actually issued, or `null`
   * for anything else.
   *
   * THE `null` IS NOT AN ALLOWLIST AND MUST NOT BECOME ONE. What it answers is
   * "did `classifyRuntime` produce this exact object", by identity. WHICH NAMES
   * MEAN PRODUCTION is a different question, it is one this package cannot
   * answer, and it is answered before anything gets here.
   *
   * THE BLANK-NAME REFUSAL THAT USED TO BE HERE IS GONE, and it was not
   * weakened. It existed because the argument was a structural interface over an
   * arbitrary string, and a blank `nodeEnv` would be carried into
   * `FixtureRightsBasis.attestedRuntime` as provenance that records nothing.
   * `classifyRuntime` only ever mints for a member of
   * `NON_DEPLOYMENT_ENVIRONMENTS`, so an issued classification always names a
   * non-empty runtime, and an unissued one does not get past the line below
   * whatever it carries. A guard no input can reach is a claim no test can
   * check, and the check that replaced it is strictly stronger -- the same
   * exchange `createPinnedLookup` made when it dropped its empty-address guard
   * for an identity check.
   *
   * The name is reported exactly as it was classified and is never trimmed into
   * shape: this is provenance, and a value quietly edited on the way through is
   * provenance about something else.
   */
  static from(classification: ClassifiedRuntime): NonProductionRuntime | null {
    if (!isClassifiedRuntime(classification)) return null;
    return new NonProductionRuntime(classification.nodeEnv);
  }
}
