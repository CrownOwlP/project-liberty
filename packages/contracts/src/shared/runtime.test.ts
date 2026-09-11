import { afterEach, describe, expect, it } from "vitest";
import {
  NON_DEPLOYMENT_ENVIRONMENTS,
  classifyRuntime,
  isClassifiedRuntime,
  isNonDeploymentEnvironmentName
} from "./runtime";

/**
 * The authority of the runtime capability, pinned at the level the defect keeps
 * coming back at.
 *
 * This boundary has now been refused four times, and each refusal found the same
 * defect one input further out: first a public structural interface anything of
 * the right shape satisfied; then a nominal witness the SDK minted from whatever
 * object it was handed; then a mint that accepted a caller-supplied `nodeEnv`,
 * so a hosted process could ask for `test` and receive a genuine, branded,
 * registered capability; and finally -- once the mint took no argument at all --
 * the ALLOWLIST the argument-free mint consults, which was exported as
 * `readonly string[]` and was therefore an ordinary mutable array wearing a
 * compile-time promise.
 *
 * The pattern is worth stating because it is what these tests are for. Each fix
 * removed the caller's ability to state the permission-granting fact through one
 * door, and the next round found another door onto the same fact. So the
 * assertions below are not written against the current implementation's shape --
 * a frozen array, an index walk -- but against the PROPERTY every one of those
 * rounds was really about: nothing a consumer can execute, short of editing this
 * module or the process it runs in, may cause `classifyRuntime()` to admit a
 * production process.
 *
 * Two of these tests reach for the environment and one patches a built-in. Both
 * restore in `afterEach` rather than inline, so a failing expectation cannot
 * leave the rest of the suite running under a rewritten `NODE_ENV` or a poisoned
 * `Array.prototype` -- which would turn one red test into a file of confusing
 * ones.
 */

/*
 * Refused rather than defaulted. Vitest sets `NODE_ENV=test`, so an absence here
 * would mean this suite is not running under the runner it was written for --
 * and a suite that rewrites the environment must be able to put back exactly
 * what it found. Restoring a guessed `test` over an absence would leave the
 * process describing itself as something it was not, which is the whole class of
 * mistake this module exists to prevent.
 */
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
if (ORIGINAL_NODE_ENV === undefined) {
  throw new Error(
    "NODE_ENV is unset; vitest sets it to test, and this suite rewrites it and must restore what it found"
  );
}
const RESTORE_NODE_ENV: string = ORIGINAL_NODE_ENV;
const ORIGINAL_INCLUDES = Object.getOwnPropertyDescriptor(Array.prototype, "includes");

afterEach(() => {
  process.env.NODE_ENV = RESTORE_NODE_ENV;

  if (ORIGINAL_INCLUDES !== undefined) {
    Object.defineProperty(Array.prototype, "includes", ORIGINAL_INCLUDES);
  }
});

describe("the allowlist is the authority, so it is immutable at runtime", () => {
  it("holds exactly the two names, and no more", () => {
    // Restated rather than derived, on purpose: this is the set whose contents
    // are a rights decision, and a test that computed it from the source would
    // agree with any future widening automatically.
    expect([...NON_DEPLOYMENT_ENVIRONMENTS]).toEqual(["development", "test"]);
  });

  it("is frozen, not merely annotated readonly", () => {
    expect(Object.isFrozen(NON_DEPLOYMENT_ENVIRONMENTS)).toBe(true);
  });

  it("refuses a cast-and-append, which is how a consumer would add production", () => {
    const mutable = NON_DEPLOYMENT_ENVIRONMENTS as unknown as string[];

    // A module is always strict mode, so the write throws instead of failing
    // silently. Both halves matter: the throw is what a caller notices, and the
    // unchanged array below is what the mint consults either way.
    expect(() => mutable.push("production")).toThrow(TypeError);
    expect([...NON_DEPLOYMENT_ENVIRONMENTS]).toEqual(["development", "test"]);
    expect(isNonDeploymentEnvironmentName("production")).toBe(false);
  });

  it("refuses an index overwrite and a length truncation", () => {
    const mutable = NON_DEPLOYMENT_ENVIRONMENTS as unknown as string[];

    expect(() => {
      mutable[0] = "production";
    }).toThrow(TypeError);
    expect(() => {
      mutable.length = 0;
    }).toThrow(TypeError);
    expect([...NON_DEPLOYMENT_ENVIRONMENTS]).toEqual(["development", "test"]);
  });

  it("does not answer through Array.prototype.includes", () => {
    // The array can be frozen and the answer still be wrong, because the
    // COMPARISON used to be borrowed from a prototype every module can write to.
    // This is the same hole as the mutable array, entered from the method side.
    //
    // The results are COLLECTED under the patch and asserted after it is undone.
    // `expect` is a large amount of third-party code and it is entitled to call
    // `includes` on its own account; asserting while a core method lies would be
    // testing the assertion library as much as the subject.
    // Initialised rather than merely declared: an assignment inside `try` is not
    // a definite assignment as far as the compiler is concerned.
    let answers: Record<string, boolean> = {};
    try {
      Object.defineProperty(Array.prototype, "includes", {
        configurable: true,
        writable: true,
        value: () => true
      });

      answers = {
        production: isNonDeploymentEnvironmentName("production"),
        staging: isNonDeploymentEnvironmentName("staging"),
        empty: isNonDeploymentEnvironmentName(""),
        undefined: isNonDeploymentEnvironmentName(undefined),
        development: isNonDeploymentEnvironmentName("development")
      };
    } finally {
      if (ORIGINAL_INCLUDES !== undefined) {
        Object.defineProperty(Array.prototype, "includes", ORIGINAL_INCLUDES);
      }
    }

    expect(answers).toEqual({
      production: false,
      staging: false,
      empty: false,
      undefined: false,
      development: true
    });
  });
});

describe("a mutated allowlist cannot make a deployment mintable", () => {
  it("still refuses a production process after every mutation attempt", () => {
    process.env.NODE_ENV = "production";

    const mutable = NON_DEPLOYMENT_ENVIRONMENTS as unknown as string[];
    expect(() => mutable.push("production")).toThrow(TypeError);

    // The end of the chain, and the only assertion here that is about the
    // capability rather than about the array: the mint observes a genuine
    // production process, consults the allowlist it always consults, and
    // answers null. Before the freeze this returned a real branded capability
    // whose identity the registry would have vouched for.
    expect(classifyRuntime()).toBeNull();
  });

  it("still issues a capability for a process that genuinely is not a deployment", () => {
    process.env.NODE_ENV = "development";

    const issued = classifyRuntime();
    expect(issued).not.toBeNull();
    expect(issued?.nodeEnv).toBe("development");
    // The refusal above is only meaningful if the mint still works; a gate that
    // refuses everything would pass the previous test for the wrong reason.
    expect(issued === null ? false : isClassifiedRuntime(issued)).toBe(true);
  });
});
