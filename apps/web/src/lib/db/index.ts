import { NonDeploymentEnvironment } from "../../app/api/deployment-environment";
import { createInMemoryRepository } from "./in-memory-repository";
import { createPostgresRepository } from "./postgres-repository";
import type { LibertyRepository } from "./repository";

export type { LibertyRepository, RepositoryAdapterId } from "./repository";
export { REPOSITORY_ADAPTER_IDS } from "./repository";
export { createInMemoryRepository, createInMemoryStore } from "./in-memory-repository";
export type { InMemoryRepository, InMemoryStore } from "./in-memory-repository";
export { createPostgresRepository, postgresRepositoryOver } from "./postgres-repository";

/* -------------------------------------------------------------------------
 * The composition root: which storage answers, and how that is decided
 *
 * ONE ALLOWLIST, CONSULTED RATHER THAN RESTATED. The question "is this process a
 * deployment" is already answered in exactly one place --
 * `app/api/deployment-environment.ts` -- and the reason that module exists is
 * that four call sites used to decide it separately and did not agree. This file
 * is a fifth consumer, not a fifth decision: it imports
 * `NonDeploymentEnvironment` and never tests `NODE_ENV` itself.
 *
 * THE SELECTION, in the order it is made:
 *
 *   1. `DATABASE_URL` present and well-formed -> the PostgreSQL adapter. This is
 *      the production implementation, and it is chosen by CONFIGURATION rather
 *      than by environment, so a developer who does have PostgreSQL running gets
 *      it on their laptop and exercises the real statements.
 *   2. `DATABASE_URL` present and malformed -> REFUSED. Not a fallback. Falling
 *      back to memory here would answer an operator's typo by silently serving a
 *      volatile store from something that believes it has a database, and the
 *      first symptom would be a household's viewing history disappearing on
 *      deploy.
 *   3. `DATABASE_URL` absent, outside a deployment -> the in-memory adapter.
 *   4. `DATABASE_URL` absent, in a deployment -> REFUSED, with the operator's
 *      remedy named.
 *
 * WHY THE IN-MEMORY ADAPTER CANNOT BE REACHED BY CASE 4 EVEN IF THIS FUNCTION IS
 * EDITED. `createInMemoryRepository` takes a `NonDeploymentEnvironment`, whose
 * constructor is private and whose only producer is `classify()`. Deleting the
 * `null` check below does not widen the gate; it stops compiling. That is the
 * point of preferring a witness to a boolean: the illegal state is
 * unrepresentable rather than merely unreached.
 *
 * WHAT THIS ARRANGEMENT CANNOT DO, recorded here because it is the load-bearing
 * limitation of the whole task. There is no PostgreSQL in this environment, so
 * `postgres-repository.ts` has never executed a single statement. Every SQL
 * behaviour PL-0402, PL-0403 and PL-0404 depend on -- the guarded progress
 * `UPDATE`, `ON CONFLICT DO NOTHING`, the `UNIQUE (user_id, display_name)`
 * violation `createProfile` translates, the composite foreign key on
 * `active_profile_selection` -- is unverified here. The `integration` quality
 * gate on those three tasks is therefore NOT satisfiable from this lane and must
 * not be recorded as passing on the strength of the in-memory adapter: passing
 * against a `Map` is evidence about the `Map`.
 * ---------------------------------------------------------------------- */

/** The environment variable that selects PostgreSQL. Declared `@optional` in `.env.example`. */
export const DATABASE_URL_VARIABLE = "DATABASE_URL";

/**
 * The URL schemes `pg` understands as PostgreSQL.
 *
 * An allowlist, for the reason every other gate in this repository is one. It is
 * checked here rather than left to the driver because a malformed value
 * otherwise surfaces at the first query as a connection error naming a host,
 * long after the request that could have explained it.
 */
const POSTGRES_URL_PROTOCOLS: readonly string[] = ["postgres:", "postgresql:"];

export type RepositoryRefusalReason = "database_url_malformed" | "storage_not_configured";

export type RepositoryResolution =
  | {
      readonly ok: true;
      readonly repository: LibertyRepository;
      /** Never empty. Says which adapter answered and what admitted it. */
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: RepositoryRefusalReason;
      readonly detail: string;
    };

/**
 * The one repository this process uses, and the input it was built from.
 *
 * CACHED, AND THE CACHE IS NOT AN OPTIMISATION. For PostgreSQL it is a
 * correctness requirement -- a new `Pool` per request would exhaust
 * `max_connections` within seconds. For the in-memory adapter it is the entire
 * feature: a fresh store per request would mean every profile created is gone
 * before the next request reads it, which looks exactly like a persistence bug
 * and is the reason a per-request adapter is not merely wasteful.
 *
 * Keyed by the resolved `DATABASE_URL` so that a process whose configuration
 * changed does not keep answering from the old one. THE KEY IS NEVER LOGGED AND
 * NEVER ENTERS A REASON TRAIL: it carries the password, which is why
 * `libertyAuthConfigSchema` says the same thing about its own `databaseUrl`.
 */
let cached: { readonly key: string; readonly resolution: RepositoryResolution } | null = null;

/**
 * Build the repository for a given configuration, without caching.
 *
 * Exported so a test can exercise every branch of the selection -- including the
 * two refusals -- without mutating `process.env` and racing every other suite in
 * the same worker. `resolveRepository` is the caching wrapper over it.
 *
 * `nodeEnv` is passed through to `classify` rather than read here, for the same
 * reason: a test states the environment it means.
 */
export function selectRepository(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): RepositoryResolution {
  const configured = (databaseUrl ?? "").trim();

  if (configured !== "") {
    let protocol: string;
    try {
      protocol = new URL(configured).protocol;
    } catch {
      return {
        ok: false,
        reason: "database_url_malformed",
        /*
         * The variable name, never the value. A connection string carries a
         * password, and a refusal that echoed it would put that password into
         * every log line that recorded the refusal.
         */
        detail: `${DATABASE_URL_VARIABLE} is set but is not a URL`
      };
    }
    if (!POSTGRES_URL_PROTOCOLS.includes(protocol)) {
      return {
        ok: false,
        reason: "database_url_malformed",
        detail: `${DATABASE_URL_VARIABLE} names the ${protocol} scheme; PostgreSQL is required (${POSTGRES_URL_PROTOCOLS.join(", ")})`
      };
    }

    return {
      ok: true,
      repository: createPostgresRepository(configured).repository,
      detail: `PostgreSQL, selected by ${DATABASE_URL_VARIABLE}`
    };
  }

  const environment = NonDeploymentEnvironment.classify(nodeEnv);
  if (environment === null) {
    return {
      ok: false,
      reason: "storage_not_configured",
      detail: `${DATABASE_URL_VARIABLE} is not set and this process is a deployment, so no store is available; set ${DATABASE_URL_VARIABLE} to a PostgreSQL connection string`
    };
  }

  const repository = createInMemoryRepository(environment);
  return {
    ok: true,
    repository,
    /*
     * The environment is reported from the witness rather than re-read, so the
     * trail names the value that actually admitted this adapter.
     */
    detail: `in-memory development store, admitted by NODE_ENV=${repository.admittedBy}; nothing here is durable and no SQL is executed`
  };
}

/**
 * The repository for this process.
 *
 * The environment is read at CALL time, never at module scope, matching
 * `resolveAuthorizedCandidates` and `NonDeploymentEnvironment.classify`: a
 * module-scope read freezes the answer to whatever the process looked like when
 * the first route was loaded.
 */
export function resolveRepository(): RepositoryResolution {
  const key = (process.env[DATABASE_URL_VARIABLE] ?? "").trim();
  const existing = cached;
  if (existing !== null && existing.key === key) return existing.resolution;

  const resolution = selectRepository(key);
  cached = { key, resolution };
  return resolution;
}

/*
 * THERE IS NO RESET, AND NO CLOSE, and both absences are recorded rather than
 * left to be discovered.
 *
 * A reset is not needed: every test in this app injects its repository through
 * `RequestContextOptions` rather than resolving one, and `selectRepository`
 * takes both of its inputs explicitly so a test can exercise every branch of the
 * selection without touching `process.env` or this cache.
 *
 * A close is MISSING rather than unnecessary. `selectRepository` keeps the
 * repository and lets `createPostgresRepository`'s `DatabaseHandle` -- and with
 * it the `pg` pool -- go out of scope, so nothing here can end a pool it opened.
 * That is acceptable only because the cache means at most one pool per
 * connection string per process, and it stops being acceptable the moment
 * anything wants an orderly shutdown. Closing belongs with whatever eventually
 * owns process lifecycle, which does not exist in this app yet.
 */
