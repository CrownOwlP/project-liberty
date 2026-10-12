/* -------------------------------------------------------------------------
 * THE ONE SERVER-SIDE IMPLEMENTATION OF `ProfileLibraryPort` (W132-F)
 *
 * ==========================================================================
 * WHY THE ADAPTER IS A SEPARATE FILE FROM THE MODEL
 * ==========================================================================
 *
 * `profile-library.ts` imports nothing. That is not tidiness: workers B, C and
 * D consume the model from a catalog card, a rail and a player, and a model
 * that reached `lib/db/request-context` would drag Drizzle,
 * `@liberty/persistence` and the schema into every one of those import graphs
 * -- the exact cost `lib/viewer-preferences.ts` documents refusing to pay, and
 * which several suites in this repository assert against by reading import
 * lists. `profile-library.test.ts` asserts the model's imports stay empty.
 *
 * THIS file is where the database lives, and it is only ever imported by a
 * SERVER COMPONENT. A client component importing it would be a build error
 * (`next/headers`, the pg driver), which is the boundary doing the work rather
 * than a comment asking for it.
 *
 * ==========================================================================
 * THE SCOPE IS BAKED IN AT CONSTRUCTION AND THE PORT HAS NO PARAMETER FOR IT
 * ==========================================================================
 *
 * `profileLibraryPort(headers)` takes the request's headers -- the session
 * cookie and the two development headers, which is the whole of what decides
 * identity on this path -- and the returned port's methods take NOTHING. The
 * profile comes from `resolveActiveProfileScope`, which reads
 * `session.activeProfileId`: server-side state written by `selectActiveProfile`.
 *
 * PL-0405 recorded a forgeable-scope defect and this is the file where it would
 * come back. There is no argument, no query parameter and no header this
 * function reads that a caller could use to name a profile, which is the same
 * absence `loadWatchlistPage` maintains and states in its own header.
 *
 * ==========================================================================
 * THE CONTEXT IS RESOLVED ONCE, NOT PER FACET
 * ==========================================================================
 *
 * A naive adapter resolves the request context inside each method, which is
 * three session reads and three authorization decisions for one render -- and,
 * worse, three CHANCES TO DISAGREE: a selection landing between two of them
 * would produce a snapshot whose watchlist belonged to one profile and whose
 * history belonged to another, labelled with whichever id was read last. That
 * is precisely the state `librarySnapshotStaleness` exists to catch, and
 * manufacturing it inside the loader would make the label a lie rather than a
 * check.
 *
 * So the resolution is one memoised promise, created on the first call and
 * shared by all of them. Every facet in a snapshot is therefore scoped to the
 * same decision, and the `profileId` on the snapshot is the id that decision
 * was made against.
 *
 * NO METHOD THROWS AND NO METHOD PUBLISHES A THROWN VALUE'S TEXT. A repository
 * exception can carry a connection string; every loader in this application
 * publishes a reason CODE and discards the text, and so does this.
 * ---------------------------------------------------------------------- */
import type { ListLimitRejection, PlaybackProgressRow, WatchlistEntryRow } from "@liberty/persistence";

import type { LibertyRepository } from "../../lib/db/repository";
import { resolveActiveProfileScope, resolveRequestContext } from "../../lib/db/request-context";
import {
  type HistoryEntry,
  type LibraryEntry,
  type LibraryFacet,
  type ProfileLibraryPort
} from "./profile-library";

/**
 * How many rows one facet reads.
 *
 * BOUNDED, AND THE BOUNDS ARE THE ONES THE EXISTING SURFACES ALREADY CHOSE:
 * `WATCHLIST_PAGE_QUERY_LIMIT` is 50 and `CONTINUE_WATCHING_QUERY_LIMIT` is 24.
 * They are restated as local constants rather than imported, because importing
 * `watchlist-page-data.ts` would pull the catalog metadata registry into this
 * module's graph for the sake of two integers -- and the two constants are
 * declarations of what THIS reader asks for, which is allowed to differ from
 * what a page-sized reader asks for.
 *
 * `listContinueWatching` requires `limit` and the port keeps it required for
 * the reason `repository.ts` gives: an unbounded list query against a table
 * that grows with every episode a household watches is a slow request waiting
 * for a heavy user.
 */
export const LIBRARY_WATCHLIST_LIMIT = 50;
export const LIBRARY_HISTORY_LIMIT = 50;

/** The reason code published when a read cannot be satisfied. */
export const LIBRARY_UNAVAILABLE = "profile_library_unavailable";

/**
 * `Array.isArray` does not narrow `readonly T[] | ListLimitRejection` on its
 * FALSE branch -- the member it leaves is still both -- which is why
 * `watchlist-page-data.ts` has the same helper rather than an inline check.
 */
function isLimitRefusal<T>(value: readonly T[] | ListLimitRejection): value is ListLimitRejection {
  return !Array.isArray(value);
}

/**
 * What one resolution produced, repository included.
 *
 * THE REPOSITORY IS CARRIED HERE RATHER THAN RE-RESOLVED PER FACET. An earlier
 * draft of this file called `resolveRequestContext` again inside each facet to
 * recover the repository, which is a second session read, a second adapter
 * resolution, and -- the real defect -- a second CHANCE TO DISAGREE with the
 * scope the facet is about to use. One resolution, one repository, one scope.
 */
type Resolved =
  | {
      readonly ok: true;
      readonly profileId: string;
      readonly scope: ResolvedScope;
      readonly repository: LibertyRepository;
    }
  | { readonly ok: false; readonly profileId: null };

/**
 * The scope object the repository takes.
 *
 * Deliberately typed as what `resolveActiveProfileScope` produced rather than
 * reconstructed: `ProfileScope` carries an issuance the persistence layer
 * checks as its first action, and a scope built here would be a scope this file
 * had asserted rather than one the authorization layer granted.
 */
type ResolvedScope = Awaited<
  ReturnType<typeof resolveActiveProfileScope>
> extends infer D
  ? D extends { readonly allowed: true; readonly scope: infer S }
    ? S
    : never
  : never;

/**
 * Build the port for one request.
 *
 * The resolution is lazy and memoised: nothing is read until a facet is asked
 * for, and every facet shares the one answer. See the header for why that is a
 * correctness property and not a performance one.
 */
export function profileLibraryPort(requestHeaders: Headers): ProfileLibraryPort {
  let pending: Promise<Resolved> | null = null;

  const resolve = (): Promise<Resolved> => {
    if (pending !== null) return pending;
    pending = (async (): Promise<Resolved> => {
      try {
        /*
         * A SYNTHESISED REQUEST CARRYING THE PAGE'S OWN HEADERS, exactly as
         * `loadResumePosition`, `loadWatchlistPage` and `loadMediaPreferences`
         * all do it. The URL is a placeholder the context resolver does not
         * read -- `.invalid` is reserved by RFC 2606 so it can never be a real
         * host -- and the headers are forwarded whole rather than picked over,
         * so this file holds no second opinion about which header identifies a
         * caller.
         */
        const context = await resolveRequestContext(
          new Request("http://profile-library.invalid/", { headers: requestHeaders })
        );
        if (!context.ok) return { ok: false, profileId: null };

        const decision = await resolveActiveProfileScope(context.context);
        if (!decision.allowed) return { ok: false, profileId: null };

        /*
         * THE ID IS READ FROM THE SESSION, NOT FROM THE SCOPE OBJECT. The scope
         * is an opaque issuance the persistence layer consumes; the session's
         * `activeProfileId` is the string this request was authorized for, and
         * it is the value a staleness check compares. Reaching into the scope to
         * recover it would be this file inventing a second answer to "whose
         * library is this".
         */
        const profileId = context.context.session.activeProfileId;
        if (typeof profileId !== "string" || profileId.length === 0) {
          return { ok: false, profileId: null };
        }

        return {
          ok: true,
          profileId,
          scope: decision.scope as ResolvedScope,
          repository: context.context.repository
        };
      } catch {
        return { ok: false, profileId: null };
      }
    })();
    return pending;
  };

  const unavailable = <T>(): LibraryFacet<T> => ({
    status: "unavailable",
    reason: LIBRARY_UNAVAILABLE
  });

  return {
    activeProfileId: async () => {
      const resolved = await resolve();
      return resolved.ok ? resolved.profileId : null;
    },

    watchlist: async (): Promise<LibraryFacet<LibraryEntry>> => {
      const resolved = await resolve();
      /*
       * `unavailable` RATHER THAN AN EMPTY LIST when the scope could not be
       * resolved. `loadProfileLibrary` short-circuits to the no-profile
       * snapshot before any facet is read, so reaching this branch means the
       * identity read and this one disagreed -- which is a failure, and an
       * empty list would render as "you have added nothing".
       */
      if (!resolved.ok) return unavailable();
      try {
        const rows: readonly WatchlistEntryRow[] | ListLimitRejection =
          await resolved.repository.listWatchlist({
            scope: resolved.scope,
            limit: LIBRARY_WATCHLIST_LIMIT
          });
        if (isLimitRefusal(rows)) return { status: "unavailable", reason: rows.reason };
        return {
          status: "ok",
          entries: rows.map((row) => ({
            contentId: row.contentId,
            /* ISO, never a `Date`: a snapshot crosses from a server component
             * to a client one, and `WatchlistPageEntry.addedAt` already
             * publishes instants this way. */
            addedAt: row.addedAt.toISOString()
          }))
        };
      } catch {
        return unavailable();
      }
    },

    history: async (): Promise<LibraryFacet<HistoryEntry>> => {
      const resolved = await resolve();
      if (!resolved.ok) return unavailable();
      try {
        const rows: readonly PlaybackProgressRow[] | ListLimitRejection =
          await resolved.repository.listContinueWatching({
            scope: resolved.scope,
            limit: LIBRARY_HISTORY_LIMIT
          });
        if (isLimitRefusal(rows)) return { status: "unavailable", reason: rows.reason };
        return {
          status: "ok",
          entries: rows.map((row) => ({
            contentId: row.contentId,
            positionSeconds: row.positionSeconds,
            runtimeSeconds: row.runtimeSeconds,
            updatedAt: row.updatedAt.toISOString()
          }))
        };
      } catch {
        return unavailable();
      }
    }

    /*
     * NO `favourites` METHOD, AND THAT IS THE HONEST ANSWER RATHER THAN AN
     * OMISSION. There is no favourites storage in this repository -- no table,
     * no port method, no route -- so `loadProfileLibrary` fills in
     * `FAVOURITES_NOT_IMPLEMENTED` and every screen reports it as a gap in the
     * build rather than as an empty shelf belonging to this viewer. The
     * proposed persistence diff is in this round's report.
     */
  };
}
