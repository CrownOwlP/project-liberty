import type {
  addToWatchlist,
  createProfile,
  issueWriterLease,
  listProfilesForAccount,
  listWatchlist,
  loadProfileOwnership,
  readProgress,
  removeFromWatchlist,
  resolveLibertySession,
  selectActiveProfile,
  writeProgress
} from "@liberty/persistence";

/* -------------------------------------------------------------------------
 * The port the HTTP layer talks to (PL-0402 / PL-0403 / PL-0404)
 *
 * WHY A PORT AT ALL, when `@liberty/persistence` already exports functions the
 * routes could call directly. Every one of those functions takes a
 * `LibertyDatabase` as its first argument, and that type is
 * `ReturnType<typeof drizzle<typeof schema>>` -- a Drizzle client over a real
 * `pg` pool. There is no PostgreSQL in this development environment and there
 * will not be one, so a route that named that type could not be exercised at
 * all: not by a unit test, not by `next dev`, not by anybody clicking through
 * the product. The three packages this task exists to connect have 211 passing
 * tests and zero consumers precisely because the only door into them is a door
 * nobody here can open.
 *
 * So the port is the persistence function set WITH ITS `db` ARGUMENT REMOVED,
 * and that is expressed mechanically by `Bound` below rather than retyped. The
 * consequence worth having is that this file cannot drift from the package: a
 * changed signature in `@liberty/persistence` is a compile error in every
 * adapter at once, and nothing here restates a parameter or a result type that
 * could quietly stop matching.
 *
 * WHAT IS DELIBERATELY NOT HERE. `archiveProfile`, `listContinueWatching`,
 * `watchlistContains` and `countLiveProfilesForAccount` are exported by the
 * package and are not on this port, because no route in this task calls them. A
 * port method with no caller is a method whose in-memory implementation is
 * never executed, and an unexecuted implementation is a guess about behaviour
 * rather than a statement of it. They go on the port when a route needs them.
 * ---------------------------------------------------------------------- */

/**
 * A persistence function, minus the database handle.
 *
 * The constraint is `(db: never, input: never) => Promise<unknown>` rather than
 * `(db: unknown, input: unknown) => ...` because function parameters are
 * checked contravariantly under `strictFunctionTypes`: `never` is assignable to
 * every parameter type, so every function in the package satisfies it, while
 * `unknown` would satisfy none of them.
 */
type Bound<F extends (db: never, input: never) => Promise<unknown>> = (
  input: Parameters<F>[1]
) => ReturnType<F>;

/**
 * Which implementation answered.
 *
 * A closed pair rather than a boolean, because it is published in a reason
 * trail and a boolean named `inMemory` would have to be reworded at every call
 * site to say the other thing. `in_memory` uses an underscore because it is a
 * reason code and every other reason code in this app is snake_case.
 */
export const REPOSITORY_ADAPTER_IDS = ["postgres", "in_memory"] as const;

export type RepositoryAdapterId = (typeof REPOSITORY_ADAPTER_IDS)[number];

/**
 * Everything the profile, progress and watchlist routes need from storage.
 *
 * `adapterId` is not an implementation detail that leaked: it is the first line
 * of every reason trail this app publishes for these routes. A response that
 * cannot say whether it was answered by PostgreSQL or by a process-local map is
 * a response nobody can debug, and -- more sharply -- it is a response that
 * could report an empty watchlist because the store restarted and look exactly
 * like one reporting an empty watchlist because the viewer has not added
 * anything.
 *
 * Every method is `readonly`, so an adapter cannot be re-pointed after
 * construction by whatever holds a reference to it.
 */
export interface LibertyRepository {
  readonly adapterId: RepositoryAdapterId;

  /* --- profiles (PL-0402) --- */

  /**
   * Ownership facts for one profile id, or `null`.
   *
   * The one method that takes a raw string, for the reason
   * `loadProfileOwnership` documents: it is the lookup that runs BEFORE
   * authorization and produces the input to it. Everything after it takes a
   * `ProfileScope`.
   */
  readonly loadProfileOwnership: Bound<typeof loadProfileOwnership>;
  readonly listProfilesForAccount: Bound<typeof listProfilesForAccount>;
  readonly createProfile: Bound<typeof createProfile>;
  readonly selectActiveProfile: Bound<typeof selectActiveProfile>;
  /**
   * Build the `LibertySession` every authorization decision is made against.
   *
   * Named `resolveSession` rather than `resolveLibertySession`: inside this app
   * there is no other kind of session to disambiguate from, and the package's
   * longer name exists because it is exported into a namespace shared with
   * Better Auth's own vocabulary.
   */
  readonly resolveSession: Bound<typeof resolveLibertySession>;

  /* --- progress (PL-0403) --- */

  readonly issueWriterLease: Bound<typeof issueWriterLease>;
  readonly writeProgress: Bound<typeof writeProgress>;
  readonly readProgress: Bound<typeof readProgress>;

  /* --- watchlist (PL-0404) --- */

  readonly addToWatchlist: Bound<typeof addToWatchlist>;
  readonly removeFromWatchlist: Bound<typeof removeFromWatchlist>;
  readonly listWatchlist: Bound<typeof listWatchlist>;
}
