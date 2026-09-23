import type { DatabaseHandle } from "@liberty/persistence";
import {
  isClassifiedRuntime,
  NonDeploymentEnvironment
} from "../../app/api/deployment-environment";
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
 * `@liberty/contracts/shared/runtime`, reached through this app's
 * `app/api/deployment-environment.ts` -- and the reason that arrangement exists
 * is that four call sites used to decide it separately and did not agree. This
 * file is one more consumer, not one more decision: it imports
 * `NonDeploymentEnvironment` and never tests `NODE_ENV` itself. It does not
 * name an environment either -- `selectRepository` takes the CAPABILITY, or
 * `null`, and defaults it to `classify()`, which reads the process. There is no
 * runtime name anywhere in this file to compare, forward, or get wrong.
 *
 * `isClassifiedRuntime` AND THE CAPABILITY COME THROUGH THE SAME DOOR, in one
 * import. The door re-exports the registry check alongside the allowlist and the
 * name predicate, so there is one route from this file to the classification
 * rather than two. The predicate is not restated here or anywhere else: a
 * re-export creates no local binding and no second hop, so the function called
 * below is the one `@liberty/contracts/shared/runtime` declares. The imports in
 * `in-memory-repository.ts` and `session/account.ts` were moved with this one.
 *
 * THE SELECTION, in the order it is made. Before any of it, a capability the
 * contracts module never issued is REFUSED outright -- see `selectRepository` --
 * so the four cases below are only ever reached with `null` or with a genuine
 * classification:
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
 * EDITED. `createInMemoryRepository` takes a `NonDeploymentEnvironment`, which is
 * a branded capability whose key is a `unique symbol` private to
 * `@liberty/contracts/shared/runtime` -- no consumer can name it, so no consumer
 * can write one -- and whose only producer is `classify()`. Deleting the `null`
 * check below does not widen the gate; it stops compiling. That is the point of
 * preferring a witness to a boolean: the illegal state is unrepresentable rather
 * than merely unreached.
 *
 * THE BRAND IS THE COMPILE-TIME HALF, AND BOTH HALVES ARE NOW HERE. Two things
 * get past a brand at runtime -- an `as unknown as NonDeploymentEnvironment`,
 * and a spread copy of a real classification, which carries the brand and needs
 * no cast -- and neither is admitted by the allowlist. So `selectRepository`
 * asks the registry by object identity before it selects anything, and
 * `createInMemoryRepository` asks again as its own first statement for a caller
 * that did not come through here. Until that pair existed, this file held the
 * compile-time half of the control and not the runtime half.
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
 *
 * A CORRECTION OF FACT, 2026-09-15 (PL-0405 round 43). PostgreSQL 16.15 now
 * exists in this container, and `packages/persistence/migrations/0000_profile_scoped_identity.sql`
 * has been applied to it and exercised with live Better Auth sign-up and
 * sign-in. That does NOT change anything this paragraph concludes:
 * `postgres-repository.ts` still has not executed a single statement, the
 * environment a developer or CI runs in still has no database configured, and
 * the `integration` gate still needs a committed suite rather than one
 * session's scratch database. The sentence above is kept because it is the
 * reason this adapter exists; this note is here so it is not read as a claim
 * that a database is impossible.
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
      /**
       * The PostgreSQL handle this repository was built over, or `null` for the
       * in-memory adapter, which has no database at all (PW-0403).
       *
       * IT WAS ALWAYS CREATED AND ALWAYS DISCARDED. `createPostgresRepository`
       * returns `{ repository, handle }` and this module used only the first
       * half, so the pool existed with no reference to it outside the
       * repository's closures. Returning it changes nothing about the pool's
       * lifetime -- the cache below is still what guarantees one per connection
       * string per process -- and it is what lets the auth instance share this
       * pool instead of opening a second one. A second pool would break the
       * invariant this module's own comments state, and it would do it in a
       * desktop sidecar where connection count is not free.
       *
       * REQUIRED-AND-NULLABLE rather than optional, the rule this repository
       * applies to every unknown fact: `null` says "this adapter has no
       * database", while an absent key would say only that somebody did not
       * think about it. A caller that needs SQL must handle the `null` and say
       * what it does about it.
       */
      readonly handle: DatabaseHandle | null;
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
 * `environment` IS THE CAPABILITY OR `null`, NEVER A RUNTIME NAME. It used to be
 * a `nodeEnv` string forwarded to `classify`, which meant a caller could name
 * the environment it wished to be treated as and be issued a real capability
 * for it. There is nothing to name now: the default reads the process, and a
 * test that wants the deployment branch passes `null` -- which is the answer a
 * deployment gets, obtained the way a deployment gets it. A non-`null` value it
 * did not receive from the mint is refused below, which is what makes the
 * previous sentence a fact about callers rather than about types.
 *
 * THE REFUSAL REUSES `storage_not_configured` RATHER THAN NAMING A THIRD REASON,
 * and that is a constraint worth stating rather than a shrug. This union is
 * published: `repositoryRefusalCode` in `db/request-context.ts` widens it into
 * `RequestContextReasonCode` by identity, and the three route groups' own
 * `contract.ts` files enumerate every code they can answer, so a new member is
 * an API-contract change across files this lane does not own. It is also a true
 * statement of what happened -- no store was selected -- and
 * `contextRefusalIsClientFault` already classifies it as not the caller's fault,
 * which is right: nothing on the wire can reach this parameter. What the shared
 * code cannot carry is the REMEDY, which is not the one the other
 * `storage_not_configured` branch names: setting `DATABASE_URL` does not fix a
 * manufactured capability, because this refusal is returned before the variable
 * is looked at. That is the DETAIL's job, and the detail names the forgery
 * exactly and names no variable.
 */
export function selectRepository(
  databaseUrl: string | undefined,
  environment: NonDeploymentEnvironment | null = NonDeploymentEnvironment.classify()
): RepositoryResolution {
  /*
   * THE FIRST THING THIS FUNCTION DOES, before `databaseUrl` is even trimmed,
   * matching the ordering `createFixtureProvider` documents: consult the
   * registry before reading any other field off any argument.
   *
   * `null` IS NOT A FORGERY AND IS PASSED OVER. It is the answer a deployment
   * gets from the mint, and it is handled below by the branch that exists for
   * it. What this refuses is a non-`null` value the contracts module never
   * issued.
   *
   * IT REFUSES THE WHOLE SELECTION, INCLUDING THE POSTGRESQL BRANCH THAT WOULD
   * NOT HAVE READ THE CAPABILITY AT ALL. That is deliberate: a composition root
   * handed a manufactured capability has been lied to about the one fact it
   * gates on, and answering it with a working repository because this particular
   * request happened to take the other branch would make the check depend on
   * configuration. Refusing outright is also the direction that fails safe.
   */
  if (environment !== null && !isClassifiedRuntime(environment)) {
    return {
      ok: false,
      reason: "storage_not_configured",
      detail:
        "the runtime classification handed to selectRepository was not issued by " +
        "@liberty/contracts/shared/runtime, so nothing has shown this process is not a " +
        "deployment and no store is selected; a cast or a spread copy carries the " +
        "capability's brand but not the decision behind it"
    };
  }

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

    const postgres = createPostgresRepository(configured);
    return {
      ok: true,
      repository: postgres.repository,
      detail: `PostgreSQL, selected by ${DATABASE_URL_VARIABLE}`,
      handle: postgres.handle
    };
  }

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
     * `null`, and it is an assertion rather than a gap: the in-memory adapter
     * executes no SQL and has no database. A caller that needs one -- the auth
     * instance is the first -- has to say what it does about that, and what it
     * does is refuse, because database sessions cannot live in a store that
     * disappears with the process.
     */
    handle: null,
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
