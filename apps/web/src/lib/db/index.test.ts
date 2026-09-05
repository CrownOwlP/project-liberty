import { describe, expect, it } from "vitest";
import { NON_DEPLOYMENT_ENVIRONMENTS } from "../../app/api/deployment-environment";
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
 * `process.env`, so nothing here mutates the environment and races another suite
 * in the same worker.
 */

describe("the in-memory adapter cannot answer a deployment", () => {
  it("refuses when DATABASE_URL is unset and NODE_ENV is not on the allowlist", () => {
    /*
     * `""` stands for an UNSET `NODE_ENV`: `classify` collapses both with
     * `?? ""`. `undefined` cannot be used, because passing it explicitly
     * triggers the parameter's default -- a read of `process.env` -- which in
     * this worker is `test` and would assert the opposite of what the case
     * means.
     */
    for (const nodeEnv of ["production", "staging", "preview", "Production", ""]) {
      const resolved = selectRepository(undefined, nodeEnv);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.reason).toBe("storage_not_configured");
      /* The remedy is named, and the variable is named. The VALUE never is: a
       * connection string carries a password. */
      expect(resolved.detail).toContain(DATABASE_URL_VARIABLE);
    }
  });

  it("answers with the in-memory adapter on every allowlisted environment, and says so", () => {
    /* Enumerated from the exported allowlist rather than restated, so widening
     * `NON_DEPLOYMENT_ENVIRONMENTS` is visible here rather than silently
     * untested. */
    for (const nodeEnv of NON_DEPLOYMENT_ENVIRONMENTS) {
      const resolved = selectRepository(undefined, nodeEnv);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.repository.adapterId).toBe("in_memory");
      /* The trail has to be able to say which adapter answered AND what admitted
       * it, or an empty watchlist from a restarted development store is
       * indistinguishable from an empty one the viewer curated. */
      expect(resolved.detail).toContain(nodeEnv);
      expect(resolved.detail).toContain("no SQL is executed");
    }
  });
});

describe("a configured DATABASE_URL selects PostgreSQL", () => {
  it("does not fall back to memory when the value is not a URL", () => {
    const resolved = selectRepository("liberty.internal:5432", "development");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe("database_url_malformed");
  });

  it("does not fall back to memory when the scheme is not PostgreSQL", () => {
    /* An allowlist of schemes, like every other gate in this repository. A
     * denylist would pass every scheme nobody thought of. */
    const resolved = selectRepository("mysql://liberty@localhost:3306/liberty", "development");
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
     */
    for (const nodeEnv of ["development", "test", "production"]) {
      const resolved = selectRepository(
        "postgresql://liberty:liberty@localhost:5432/liberty",
        nodeEnv
      );
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.repository.adapterId).toBe("postgres");
      /* The connection string must never reach a reason trail. */
      expect(resolved.detail).not.toContain("liberty:liberty");
    }
  });
});
