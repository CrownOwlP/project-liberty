import {
  addToWatchlist,
  createDatabase,
  createProfile,
  issueWriterLease,
  listProfilesForAccount,
  listWatchlist,
  loadProfileOwnership,
  readProgress,
  removeFromWatchlist,
  resolveLibertySession,
  selectActiveProfile,
  writeProgress,
  type DatabaseHandle
} from "@liberty/persistence";
import type { LibertyRepository } from "./repository";

/* -------------------------------------------------------------------------
 * The production adapter: PostgreSQL, through `@liberty/persistence`
 *
 * DELEGATION AND NOTHING ELSE. Every method below is the package's own function
 * with the database handle supplied. There is no query here, no conflict rule,
 * no reason code invented on the way past: the enforcement lives in the SQL
 * statements `@liberty/persistence` writes, and this file's whole job is to
 * hold the handle those statements need.
 *
 * That is worth stating because the alternative was tempting and wrong. A
 * "smart" adapter that added a retry, a cache or a default limit here would put
 * behaviour in the one layer that has no tests -- the layer that cannot have
 * tests, because exercising it requires the PostgreSQL instance this
 * environment does not have. Anything with a decision in it belongs in the
 * package, where `writer-epoch.ts` and `watchlist-mutation.ts` show what a
 * testable decision looks like.
 *
 * NOTHING IN THIS FILE HAS BEEN RUN AGAINST A DATABASE. See `index.ts` for why
 * that is recorded rather than papered over, and what it means for the
 * `integration` gate on PL-0402, PL-0403 and PL-0404.
 * ---------------------------------------------------------------------- */

/**
 * A repository over an already-constructed handle.
 *
 * Takes the handle rather than a connection string so that the pool's lifetime
 * is the caller's problem -- which matters because a pool is a process-wide
 * resource and this function may legitimately be called more than once in a
 * development server that hot-reloads its modules. `index.ts` owns the single
 * instance; this function owns none.
 */
export function postgresRepositoryOver(handle: DatabaseHandle): LibertyRepository {
  const { db } = handle;

  return {
    adapterId: "postgres",

    loadProfileOwnership: (profileId) => loadProfileOwnership(db, profileId),
    listProfilesForAccount: (session) => listProfilesForAccount(db, session),
    createProfile: (input) => createProfile(db, input),
    selectActiveProfile: (input) => selectActiveProfile(db, input),
    resolveSession: (account) => resolveLibertySession(db, account),

    issueWriterLease: (input) => issueWriterLease(db, input),
    writeProgress: (input) => writeProgress(db, input),
    readProgress: (input) => readProgress(db, input),

    addToWatchlist: (input) => addToWatchlist(db, input),
    removeFromWatchlist: (input) => removeFromWatchlist(db, input),
    listWatchlist: (input) => listWatchlist(db, input)
  };
}

/**
 * Open a pool and build the repository over it.
 *
 * `max` is not set, for the reason `createDatabase` gives: the right number is
 * a function of how many application instances share the server's
 * `max_connections`, and a value chosen here would look authoritative while
 * being wrong on every deployment topology but one. When a deployment topology
 * exists, the number belongs beside it.
 *
 * The connection string is never logged and never enters a reason trail -- it
 * carries the password. `index.ts` reports only WHICH adapter answered.
 */
export function createPostgresRepository(connectionString: string): {
  readonly repository: LibertyRepository;
  readonly handle: DatabaseHandle;
} {
  const handle = createDatabase({ connectionString });
  return { repository: postgresRepositoryOver(handle), handle };
}
