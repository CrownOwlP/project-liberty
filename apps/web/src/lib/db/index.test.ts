import { describe, expect, it } from "vitest";
import {
  isNonDeploymentEnvironmentName,
  NON_DEPLOYMENT_ENVIRONMENTS,
  NonDeploymentEnvironment
} from "../../app/api/deployment-environment";
import { DATABASE_URL_VARIABLE, selectRepository } from "./index";

/*
 * The selection, which is the security-relevant part of the composition root.
 *
 * Two properties are pinned: a deployment can never be answered by the in-memory
 * adapter, and a malformed `DATABASE_URL` is a REFUSAL rather than a fallback.
 * The second matters as much as the first -- falling back to memory on an
 * operator's typo would serve a volatile store from a process that believes it
 * has a database, and the first symptom would be a household's history vanishing
 * on deploy.
 *
 * `selectRepository` takes both inputs explicitly rather than reading
 * `process.env` itself, so nothing here mutates the environment and races
 * another suite in the same worker.
 *
 * THE ENVIRONMENT ARGUMENT IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME,
 * and that changes how this file has to be read. It used to pass a `nodeEnv`
 * string, so one loop over a list of names could exercise both branches at once
 * -- which was exactly the hole the corrective closed, because a caller naming
 * its own environment was how a hosted process obtained a development
 * capability. There are now two separate questions here, asserted separately:
 *
 *   - WHICH NAMES THE ALLOWLIST ADMITS is asked of
 *     `isNonDeploymentEnvironmentName`, which answers about a string, issues
 *     nothing and grants nothing, so a test may hand it any name it likes --
 *     including names belonging to processes this one is not.
 *   - WHAT `selectRepository` DOES WITH EACH ANSWER is asked with `null` for the
 *     deployment branch, and with this process's own witness for the other. A
 *     test cannot mint a witness for an environment it is not running in, and it
 *     does not need to: `null` is what a deployment receives, obtained the way a
 *     deployment obtains it.
 */

/**
 * This process's own witness.
 *
 * `classify` takes no argument -- it reads the process. The witness is genuine
 * because the process running this suite really is a test process: vitest sets
 * `NODE_ENV=test`, which `NON_DEPLOYMENT_ENVIRONMENTS` admits. That is the
 * design rather than a way around it, and the throw names the only condition
 * that leaves this file without one.
 *
 * Not a `!`. A test that reached for a non-null assertion on this value would be
 * demonstrating the opposite of what the type is for. Nothing in this file
 * rewrites `NODE_ENV`, so there is no window in which this answer changes.
 */
function classifiedProcess(): NonDeploymentEnvironment {
  const environment = NonDeploymentEnvironment.classify();
  if (environment === null) {
    throw new Error(
      "this process is not classified as a non-deployment; vitest sets NODE_ENV=test, which NON_DEPLOYMENT_ENVIRONMENTS admits"
    );
  }
  return environment;
}

describe("the in-memory adapter cannot answer a deployment", () => {
  /*
   * The names a deployment runs under, asked of the predicate rather than of the
   * mint. `""` stands for an UNSET `NODE_ENV`: the allowlist test collapses both
   * with `?? ""`, so this covers the unset case with the same call.
   *
   * A NAME IS ALL THIS CAN BE ASKED ABOUT NOW, and that is the point.
   * `isNonDeploymentEnvironmentName` issues nothing, so handing it `production`
   * proves the allowlist refuses that name without anyone having obtained a
   * capability for it. What such a process then receives from `classify` is
   * `null`, which is what the case below passes.
   */
  it.each(["production", "staging", "preview", "Production", "PRODUCTION", "", "dev", "prod"])(
    "is a name the allowlist refuses: %j",
    (nodeEnv) => {
      expect(isNonDeploymentEnvironmentName(nodeEnv)).toBe(false);
    }
  );

  it("refuses when DATABASE_URL is unset and this process is a deployment", () => {
    /*
     * `null` is the classification a deployment gets, passed the way a
     * deployment gets it. `undefined` cannot be used, because passing it
     * explicitly triggers the parameter's default -- a read of `process.env` --
     * which in this worker is `test` and would assert the opposite of what the
     * case means.
     */
    const resolved = selectRepository(undefined, null);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("storage_not_configured");
    /* The remedy is named, and the variable is named. The VALUE never is: a
     * connection string carries a password. */
    expect(resolved.detail).toContain(DATABASE_URL_VARIABLE);
  });

  /* Enumerated from the exported allowlist rather than restated, so widening
   * `NON_DEPLOYMENT_ENVIRONMENTS` is visible here rather than silently
   * untested. */
  it.each([...NON_DEPLOYMENT_ENVIRONMENTS])("is a name the allowlist admits: %s", (nodeEnv) => {
    expect(isNonDeploymentEnvironmentName(nodeEnv)).toBe(true);
  });

  it("answers with the in-memory adapter for a classified process, and says so", () => {
    const environment = classifiedProcess();
    const resolved = selectRepository(undefined, environment);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.repository.adapterId).toBe("in_memory");
    /* The trail has to be able to say which adapter answered AND what admitted
     * it, or an empty watchlist from a restarted development store is
     * indistinguishable from an empty one the viewer curated. The expected name
     * is read off the witness rather than restated, because the witness carries
     * the environment the classification actually used -- which is the only
     * environment this process may name, now that no name can be handed in.
     * Matched with its `NODE_ENV=` prefix so a bare occurrence of the word
     * elsewhere in the detail would not satisfy it. */
    expect(resolved.detail).toContain(`NODE_ENV=${environment.nodeEnv}`);
    expect(resolved.detail).toContain("no SQL is executed");
  });
});

/*
 * The runtime half of the control, which the type cannot supply.
 *
 * A parameter typed `NonDeploymentEnvironment` is checked by the COMPILER, and
 * two values get past a compiler: an `as unknown as NonDeploymentEnvironment`,
 * and a spread copy of a genuine classification. The cast is the blunt forgery;
 * the SPREAD is the subtle one and the reason a brand alone was never enough --
 * it copies the brand, needs no cast, and only object identity tells it from the
 * real thing. Both are exercised, matching
 * `packages/provider-sdk/src/fixture/provider.test.ts`, which is where this
 * repository first made a consumer ask.
 *
 * NEITHER CASE PASSES WITHOUT THE REGISTRY CHECK IN `selectRepository`. A
 * forgery is not `null`, so the deployment branch does not catch it: the first
 * case would have been answered `ok` with an adapter built from the `nodeEnv`
 * the forgery carries, and the second `ok` with the PostgreSQL adapter, because
 * without the check nothing on that branch consults the capability at all.
 */
describe("a classification the contracts module never issued", () => {
  function forgeries(): readonly NonDeploymentEnvironment[] {
    const cast = { nodeEnv: "test" } as unknown as NonDeploymentEnvironment;
    /* Genuine, then copied: the copy carries the brand and is refused anyway. */
    const copied: NonDeploymentEnvironment = { ...classifiedProcess() };
    return [cast, copied];
  }

  it("cannot obtain the in-memory adapter", () => {
    for (const forged of forgeries()) {
      const resolved = selectRepository(undefined, forged);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("storage_not_configured");
      /* The detail names the forgery rather than the operator's remedy: the
       * remedy for a manufactured capability is not to set a variable. */
      expect(resolved.detail).toContain("was not issued by");
    }
  });

  it("is refused before DATABASE_URL is looked at", () => {
    /*
     * The ordering, pinned with a `DATABASE_URL` that would otherwise select
     * PostgreSQL successfully -- the branch that never reads the capability at
     * all. A composition root handed a manufactured capability is refused
     * outright rather than answered on whichever branch its configuration
     * happens to take.
     */
    for (const forged of forgeries()) {
      const resolved = selectRepository(
        "postgresql://liberty:liberty@localhost:5432/liberty",
        forged
      );
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("storage_not_configured");
      /* The connection string must never reach a reason trail, on this path
       * either. */
      expect(resolved.detail).not.toContain("liberty:liberty");
    }
  });
});

describe("a configured DATABASE_URL selects PostgreSQL", () => {
  /*
   * `null` rather than a witness in both refusals below, and it is not a
   * shortcut. `null` is not a forgery, so the registry check at the top of
   * `selectRepository` passes over it, and the malformed-URL branch then returns
   * without the parameter being read for anything else. The refusal is the same
   * either way, and `null` states that these tests do not depend on the
   * classification.
   */
  it("does not fall back to memory when the value is not a URL", () => {
    const resolved = selectRepository("liberty.internal:5432", null);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("database_url_malformed");
  });

  it("does not fall back to memory when the scheme is not PostgreSQL", () => {
    /* An allowlist of schemes, like every other gate in this repository. A
     * denylist would pass every scheme nobody thought of. */
    const resolved = selectRepository("mysql://liberty@localhost:3306/liberty", null);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("database_url_malformed");
    expect(resolved.detail).toContain("mysql:");
  });

  it("is chosen by configuration rather than by environment", () => {
    /*
     * `pg`'s `Pool` performs no I/O in its constructor -- it allocates no client
     * and opens no socket until something calls `connect` -- so building the
     * adapter here is safe without a database. NOTHING BELOW EXERCISES A
     * STATEMENT, and nothing in this suite can: the `integration` gate on
     * PL-0402/0403/0404 is what covers the SQL, and it is not satisfiable in this
     * environment.
     *
     * BOTH CLASSIFICATIONS, which is the whole claim: `null` is what a
     * deployment holds and the witness is what this process holds, and a
     * configured `DATABASE_URL` has to reach PostgreSQL from either. It used to
     * be a list of environment NAMES, which could say no more than this and
     * required a caller able to state an environment it was not running in.
     */
    for (const environment of [null, classifiedProcess()]) {
      const resolved = selectRepository(
        "postgresql://liberty:liberty@localhost:5432/liberty",
        environment
      );
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.repository.adapterId).toBe("postgres");
      /* The connection string must never reach a reason trail. */
      expect(resolved.detail).not.toContain("liberty:liberty");
    }
  });
});
