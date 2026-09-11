/* -------------------------------------------------------------------------
 * Shared vocabulary: is this process a deployment, or is it somebody's laptop?
 * (PL-0706)
 *
 * ONE CLASSIFICATION, AND IT IS A CAPABILITY RATHER THAN A SHAPE. Three
 * permissions across this repository turn on the answer -- whether
 * `@liberty/provider-sdk`'s fixture provider may be constructed at all, whether
 * the in-memory repository and the demo catalog may be selected, and whether a
 * caller may tell the outbound URL policy `localDeployment: true`. The value
 * below is the only thing that answers it, and holding one is proof that the
 * answer was computed here, from this process, rather than asserted by whoever
 * wanted the permission.
 *
 * WHY THIS FILE IS IN `@liberty/contracts` AND NOT SOMEWHERE MORE OBVIOUS. The
 * classification has to be reachable from BOTH `apps/web` -- which owns the
 * process and can read its environment -- and `@liberty/provider-sdk`, which
 * gates a fabricated rights declaration on it. A package cannot import from an
 * application, so the application could not own it. Putting it in the provider
 * SDK would drag that whole package into the module graph of every surface that
 * merely renders a catalog card, because it publishes a single bare root entry.
 * `@liberty/contracts` is already a dependency of both, its `exports` map
 * already carries a `./shared/*` wildcard, and a shared vocabulary is exactly
 * what "which runtime names are not deployments" is.
 *
 * IT IMPORTS NOTHING, and that is enforced rather than observed:
 * `../module-boundary.test.ts` allows a `shared/**` module to import zod or a
 * sibling shared module and nothing else. This one needs neither. There is no
 * schema here because there is no wire format here -- a classification is a
 * fact about the running process, and a fact that arrived over a network would
 * be somebody else's claim about our process.
 *
 * THREE MECHANISMS, AND THEY CLOSE THREE DIFFERENT HOLES. The second and third
 * are the pair `packages/media-inspection/src/egress.ts` uses for
 * `PinnedTarget`, for the same reason and after the same review finding. The
 * first is the one this file was corrected for, and it is the one the other two
 * depend on to mean anything:
 *
 *   1. THE MINT READS THE PROCESS AND TAKES NOTHING FROM ITS CALLER.
 *      `classifyRuntime()` declares no parameters, so there is no argument to
 *      write: the `NODE_ENV` it classifies is the one `process.env` holds at
 *      the moment of the call. It used to take a `nodeEnv` that DEFAULTED to
 *      that read, and the default was what every production call site used --
 *      but the parameter meant a hosted process could call
 *      `classifyRuntime("test")` and receive a genuine classification: branded,
 *      frozen, and recorded in the registry below, because this module really
 *      had issued it. Every check downstream then answered honestly about an
 *      object whose permission-granting fact the caller had written. A registry
 *      proves the mint issued a value; only a mint with no argument proves the
 *      mint OBSERVED the process.
 *
 *      The allowlist stays testable without a way to mint from a name.
 *      `isNonDeploymentEnvironmentName` answers "would this name be admitted"
 *      for any string, issues nothing and grants nothing; and a consumer that
 *      has to be exercised against a refusing environment takes a
 *      `ClassifiedRuntime | null` from its caller rather than a runtime name,
 *      so `null` is how a test says "a deployment" and the only source of the
 *      non-`null` case remains this function.
 *
 *   2. A BRAND THAT CANNOT BE WRITTEN DOWN. `classifiedRuntime` below is a
 *      module-private `unique symbol`. It is not exported, so no other module
 *      -- in this package or in any consumer -- can NAME the key, and an object
 *      literal that omits it is not a `ClassifiedRuntime`. There is no exported
 *      constructor to reach for either: `classifyRuntime` is the only function
 *      that writes the brand, and it writes it only after the allowlist test.
 *      Fabrication stops being something a reviewer has to notice and becomes
 *      something the compiler refuses.
 *
 *   3. A REGISTRY OF THE VALUES THIS MODULE ACTUALLY ISSUED. A brand alone is a
 *      COMPILE-TIME control, and two things get past a compile-time control at
 *      runtime: an explicit `as unknown as ClassifiedRuntime`, and a spread --
 *      `{ ...realClassification, nodeEnv: "test" }` copies the brand along with
 *      everything else and type-checks. Both yield a value the allowlist never
 *      admitted. So every issued classification is recorded in a `WeakSet` that
 *      only this module can add to, and `isClassifiedRuntime` answers from it.
 *      A `WeakSet` rather than a `Set` because a registry of classifications
 *      must not keep them alive; and the key is object IDENTITY, which is
 *      exactly the thing a copy does not have.
 *
 * WHY NOT A CLASS WITH A PRIVATE CONSTRUCTOR, which is what this replaced. A
 * class exports a VALUE that a consumer can reach -- and, more to the point, a
 * private field makes TypeScript compare the class nominally at COMPILE time
 * and does nothing whatever at runtime, so a spread copy of a real instance is
 * an ordinary object that passes every check the class can perform on itself.
 * The registry catches that; a private field cannot.
 *
 * EACH ISSUED VALUE IS FROZEN. `readonly` is erased at runtime, so without this
 * a holder of a genuine classification could reassign `nodeEnv` between the
 * classification and the permission it unlocks -- and `nodeEnv` is carried into
 * a fixture rights basis as provenance, so a value edited on the way through is
 * provenance about something else.
 *
 * WHY `NODE_ENV` AND NOT A DEDICATED FLAG. It is the one fact about the running
 * process that no configuration file can forge: `scripts/with-root-env.mjs`
 * refuses to apply `NODE_ENV` from a dotenv file at all, precisely so a copied
 * `.env.local` cannot turn `next start` into a fixture-serving deployment, and
 * Next computes its own file set before merging so `apps/web/.env.local` cannot
 * either. A new `LIBERTY_IS_LOCAL` variable would have none of that protection
 * and would be a second switch that could disagree with this one.
 *
 * WHAT THIS DOES NOT CLAIM, stated exactly, because a comment that overclaims a
 * check is worse than having no check:
 *
 *   - AN EDIT TO THIS FILE defeats it, and nothing in TypeScript can prevent
 *     that. What it prevents is the way this defect actually recurs: a change
 *     made somewhere else that quietly stops consulting the gate, a call site
 *     that hands a permission-granting factory a literal it wrote itself, or a
 *     call site that tells the mint which environment to classify. All three
 *     used to compile. None do.
 *   - CODE INSIDE THE PROCESS THAT REWRITES ITS OWN ENVIRONMENT. Assigning
 *     `process.env.NODE_ENV` before a call changes what this module observes,
 *     because what it observes is the process. That is a statement executing in
 *     the deployment, with the same reach as an edit to this file and the same
 *     visibility in a diff; it is not something a caller can do THROUGH this
 *     module, which is the boundary that moved. It is also how a test states an
 *     environment it does not have: the process really becomes that process for
 *     the duration, and the classification it then issues is a true one.
 *   - A CONSUMER THAT DOES NOT ASK. `isClassifiedRuntime` is a function, so a
 *     permission that takes a `ClassifiedRuntime` and never calls it is
 *     protected by the brand alone -- which is to say, against a literal but
 *     not against a cast or a spread. Every consumer that grants something on
 *     the strength of this value must consult the registry; the fixture
 *     provider does, at the top of its factory, before it reads any other
 *     field.
 *   - A HOSTED DEPLOYMENT THAT EXPORTS `NODE_ENV=development` and runs
 *     `next dev` is indistinguishable from a laptop here, because it IS a
 *     development build. Nothing a string test can do closes that; the control
 *     for it is not shipping one.
 * ---------------------------------------------------------------------- */

/**
 * The `NODE_ENV` values that mean "this process is not a deployment".
 *
 * These two are the whole set: `next dev` runs as `development`, and vitest
 * sets `test`. Every other value -- including no value at all -- is treated as
 * a deployment, which is the direction that fails safe.
 *
 * AN ALLOWLIST, for the reason every other gate in this repository is one.
 * `PLAYABLE_CONTENT_RIGHTS`, `RIGHTS_BASES_FOR_RIGHTS` and the engine's
 * eligibility check all refuse what they do not recognise rather than
 * permitting it. A denylist of the single string `production` fails open on
 * every value nobody thought of -- `staging`, `preview`, `Production`, `""` --
 * and the failure mode here is a hosted process describing itself to an SSRF
 * gate as a local one.
 *
 * THIS IS THE ONLY COPY IN THE REPOSITORY, and it is exported so a test can
 * enumerate the permitted values rather than restating them. Widening it is a
 * RIGHTS-RELEVANT edit: it widens the fixture provider's construction gate, the
 * demo catalog's, the in-memory repository's and the resolve scaffold's
 * availability all at once, on purpose, because a value that genuinely stopped
 * being a deployment would have to change every one of those answers together.
 */
export const NON_DEPLOYMENT_ENVIRONMENTS: readonly string[] = ["development", "test"];

/**
 * Whether a runtime NAME is one the allowlist admits.
 *
 * A PREDICATE, AND DELIBERATELY NOT A MINT. It answers a question about a
 * string. It issues nothing, registers nothing, brands nothing and grants
 * nothing, so a caller may pass any name it likes -- including one belonging to
 * a process it is not running in -- and receive only a boolean. That is the
 * whole reason it can safely take an argument when `classifyRuntime` cannot.
 *
 * IT EXISTS SO THE ALLOWLIST STAYS TESTABLE. `classifyRuntime` can only ever be
 * asked about the process running the test, so "does `staging` get in" is a
 * question the mint can no longer be asked directly. It is asked here instead,
 * of the same array the mint consults -- one line below, in the only comparison
 * this repository performs on `NODE_ENV`.
 *
 * `?? ""` rather than a nullish test, so an unset variable and an empty string
 * are the same answer -- neither is on the allowlist, and both mean "nobody
 * said", which is not a claim to be local.
 */
export function isNonDeploymentEnvironmentName(nodeEnv: string | undefined): boolean {
  return NON_DEPLOYMENT_ENVIRONMENTS.includes(nodeEnv ?? "");
}

/**
 * The brand.
 *
 * Module-private and never exported, so no other module can name the key and
 * therefore no other module can write it. Same mechanism, and the same
 * reasoning, as `authorisedByEgress` in `packages/media-inspection` and
 * `RIGHTS_DECLARED` in the provider SDK's Stremio adapter.
 */
const classifiedRuntime: unique symbol = Symbol("liberty.runtime.classified");

/**
 * Evidence that THIS process was classified as a non-deployment, in a form only
 * this module can produce and only from the process itself.
 *
 * WHY A VALUE AND NOT A BOOLEAN. What this gates is the CONSTRUCTION of things
 * a deployment must not be able to build -- a fabricated `owned` rights basis,
 * a volatile store standing in for a database, an invented catalog. The
 * previous arrangement enforced that with a runtime `if` at each call site, and
 * a later edit can delete a condition while everything still compiles. A
 * missing ARGUMENT cannot be deleted that way: a caller that stops handling the
 * `null` from `classifyRuntime` gets a compile error, not a wider gate.
 */
export interface ClassifiedRuntime {
  /**
   * The `NODE_ENV` this process was running under when the allowlist admitted
   * it.
   *
   * Carried so a caller that reports WHICH environment admitted it -- a log
   * line, a reason trail, a fixture rights basis's `attestedRuntime` -- reads
   * the value the classification actually used instead of re-reading the
   * environment and risking a different answer. Reported exactly as it was
   * classified and never trimmed into shape: this is provenance.
   */
  readonly nodeEnv: string;
  /** The brand. Unwritable outside this module; see the section above. */
  readonly [classifiedRuntime]: true;
}

/**
 * The classifications this module has issued, by identity.
 *
 * Weak so that holding the registry never holds a classification alive. Nothing
 * removes an entry, and nothing re-validates one: a classification records what
 * the process was when it was minted, which is the fact its holders were
 * granted their permission on, and an expiry would be a new failure mode for no
 * gain.
 */
const issuedRuntimes = new WeakSet<ClassifiedRuntime>();

/**
 * Whether this exact object came out of `classifyRuntime`.
 *
 * The parameter is typed `ClassifiedRuntime` rather than `unknown` on purpose:
 * a caller that has not at least satisfied the brand cannot get this far, so
 * the only inputs worth asking about are the ones that got past the compiler --
 * a cast, or a copy of a real classification. Both answer `false`.
 *
 * EVERY PERMISSION BUILT ON THIS VALUE MUST CALL IT, and must call it before it
 * reads anything else off the object. A consumer that merely accepts the type
 * has the compile-time half of the control and not the runtime half.
 */
export function isClassifiedRuntime(value: ClassifiedRuntime): boolean {
  return issuedRuntimes.has(value);
}

/**
 * Classifies THIS process, or answers `null` for a deployment.
 *
 * NO ARGUMENT, AND THAT ABSENCE IS THE CONTROL. The environment classified is
 * the one the process is running under; there is nothing for a caller to state,
 * so no caller can obtain a capability for an environment it is not in. The
 * previous signature took a `nodeEnv` that defaulted to this same read, which
 * meant a hosted process could ask for -- and receive -- a genuine
 * classification of `test`. Everything downstream was then correct about an
 * object founded on a caller's own claim. See the header.
 *
 * THE ONE PLACE `NODE_ENV` IS COMPARED TO ANYTHING is
 * `isNonDeploymentEnvironmentName`, immediately above, and the read below is
 * the only one any permission in `apps/web` or the packages it depends on rests
 * on. Consumers take the capability, or `null`, and forward it; there is no
 * parameter anywhere on this path through which a name could be supplied
 * instead of observed.
 *
 * THE READ HAPPENS AT CALL TIME, never at module scope: a module-scope read
 * freezes the answer to whatever the process looked like when the first route
 * was loaded, which in a serverless cold start is not necessarily the request's
 * environment.
 *
 * A FRESH VALUE PER CALL, not a memoised one. Two holders sharing one object
 * would be indistinguishable to the registry, which is harmless, but a cache
 * would have to decide when a classification stops being true -- and the answer
 * is "when the process's environment changes", which is precisely the thing the
 * cache would be there to avoid re-reading. Minting is a frozen object literal
 * and a `WeakSet` insert.
 */
export function classifyRuntime(): ClassifiedRuntime | null {
  const value = process.env.NODE_ENV ?? "";
  if (!isNonDeploymentEnvironmentName(value)) return null;

  const classified: ClassifiedRuntime = Object.freeze({
    [classifiedRuntime]: true as const,
    nodeEnv: value
  });
  issuedRuntimes.add(classified);
  return classified;
}
