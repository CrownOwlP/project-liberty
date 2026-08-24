/* -------------------------------------------------------------------------
 * The full schema, in one place.
 *
 * Re-export only. `drizzle.config.ts` points at this module, so a table that is
 * not reachable from here is a table `drizzle-kit generate` will not see and
 * will therefore silently propose DROPPING on the next migration.
 * ---------------------------------------------------------------------- */

export * from "./auth";
export * from "./profiles";
export * from "./progress";
export * from "./watchlist";

import { account, session, user, verification } from "./auth";
import { activeProfileSelection, profile } from "./profiles";
import { playbackProgress } from "./progress";
import { watchlistEntry } from "./watchlist";

/**
 * Every table, for the Drizzle client and for the profile-scoping test.
 *
 * The test in `profile-scoping.test.ts` walks THIS object rather than an
 * enumerated list, so a new table added to the schema is checked for profile
 * scoping automatically. An enumerated list would have to be remembered, and
 * the whole point is that nobody has to remember.
 */
export const schema = {
  user,
  session,
  account,
  verification,
  profile,
  activeProfileSelection,
  playbackProgress,
  watchlistEntry
} as const;

/**
 * Tables that hold what a viewer WATCHED or WANTS TO WATCH, and must therefore
 * be scoped to a profile rather than an account.
 *
 * Named explicitly because the rule cannot be inferred: `session` legitimately
 * has no `profile_id`, and a test that demanded one everywhere would be turned
 * off within a week. This list is the reviewed answer to "which tables carry
 * viewing behaviour", and adding one is the moment to ask the question again.
 */
export const PROFILE_SCOPED_TABLES = {
  playbackProgress,
  watchlistEntry
} as const;
