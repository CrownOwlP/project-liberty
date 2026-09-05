import type { ProfileOwnership } from "@liberty/auth";
import { scopeBelongsToSession } from "@liberty/auth";
import {
  describeUnrepresentableInstant,
  isMintedProfileId,
  newProfileId,
  nextWriterEpoch,
  parseContentId,
  parseListLimit,
  representableInstant,
  resolveProfileCreation,
  resolveProgressWrite,
  resolveWatchlistMutation,
  type PlaybackProgressRow,
  type ProfileRow,
  type StoredProgress,
  type WatchlistEntryRow
} from "@liberty/persistence";
import type { NonDeploymentEnvironment } from "../../app/api/deployment-environment";
import type { LibertyRepository } from "./repository";

/* -------------------------------------------------------------------------
 * The development adapter: profile-scoped storage in process memory
 *
 * WHY IT EXISTS, stated plainly rather than as an apology. There is no
 * PostgreSQL in this development environment and there will not be one, so
 * without this file the three persistence packages remain what they were before
 * this task: 211 passing tests behind a door nobody here can open. With it,
 * `next dev` has profiles, progress and a watchlist, the handlers above it have
 * unit tests that exercise real repository behaviour rather than a mock's, and
 * the PostgreSQL adapter stays the production implementation with no
 * development-shaped compromise inside it.
 *
 * WHAT IT IS NOT. It is not a database. It has no durability, no transactions,
 * no cross-process visibility and no constraints beyond the ones written below.
 * It therefore CANNOT stand in for the `integration` quality gate on PL-0402,
 * PL-0403 or PL-0404: those gates ask whether the SQL is right, and no amount of
 * passing against a `Map` is evidence about a statement this file never issues.
 * `index.ts` records that once; this paragraph exists so the claim is also
 * refused at the point where somebody would be most tempted to make it.
 *
 * IT CANNOT BE SELECTED IN A DEPLOYMENT, and that is enforced by a type rather
 * than by a condition. `createInMemoryRepository` requires a
 * `NonDeploymentEnvironment`, whose constructor is private and whose only
 * producer is `NonDeploymentEnvironment.classify()` in
 * `app/api/deployment-environment.ts` -- which answers `null` for every
 * `NODE_ENV` outside the `development`/`test` allowlist, including no value at
 * all. Under `strictNullChecks` a caller cannot reach this function without
 * handling that `null`, so deleting the check is a COMPILE ERROR rather than a
 * silent widening. That is the mechanism `fixtureProvider` uses, chosen for the
 * same reason: a runtime `if` is a line a later edit can delete while everything
 * still compiles.
 *
 * WHERE THE RULES COME FROM. Every decision this adapter makes is delegated to
 * the pure resolvers in `@liberty/persistence`: `resolveProgressWrite` and
 * `nextWriterEpoch` for the writer-epoch conflict rule,
 * `resolveWatchlistMutation` for the watchlist one, `resolveProfileCreation` for
 * names and ceilings, `parseContentId` and `parseListLimit` for the boundary
 * checks. Nothing about a conflict is decided here. If it were, this adapter and
 * PostgreSQL would be two implementations of one policy that agreed only by
 * coincidence, and the tests above them would be testing the coincidence.
 *
 * THE ONE RULE THIS FILE MODELS ITSELF is display-name uniqueness, because
 * PostgreSQL owns it as `UNIQUE (user_id, display_name)` and there is no pure
 * module to borrow. It is marked at its site.
 * ---------------------------------------------------------------------- */

/**
 * The separator that joins a profile id and a content id into one map key.
 *
 * A vertical bar, and the choice is about what CANNOT appear on either side. A
 * profile id is a lower-case RFC 4122 UUID (`isMintedProfileId`) and a content
 * id is `[a-z0-9]+(-[a-z0-9]+)*` (`normalizedContentIdSchema`), so neither
 * vocabulary contains a bar -- which makes the encoding injective without a
 * length prefix. A hyphen would NOT be injective: both vocabularies contain one,
 * so `("a-b", "c")` and `("a", "b-c")` would collide, and the visible failure is
 * two titles sharing one progress row.
 *
 * A control character such as NUL would also be injective and is deliberately
 * not used: an invisible character in source is invisible in every diff and
 * every review, an editor is liable to normalise it away on save, and it makes
 * the file read as binary to ordinary tooling. `profile-creation.ts` records the
 * same reasoning for its zero-width joiner.
 */
const KEY_SEPARATOR = "|";

/** The composite key for the two profile-scoped tables. */
function scopedKey(profileId: string, contentId: string): string {
  return `${profileId}${KEY_SEPARATOR}${contentId}`;
}

/** The stored progress row, reduced to what the pure resolver reads. */
function toStored(row: PlaybackProgressRow): StoredProgress {
  return {
    positionSeconds: row.positionSeconds,
    runtimeSeconds: row.runtimeSeconds,
    writerEpoch: row.writerEpoch,
    writerId: row.writerId,
    writeSeq: row.writeSeq,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Ownership facts, and nothing else. Mirrors `toOwnership` in the package. */
function toOwnership(row: ProfileRow): ProfileOwnership {
  return {
    profileId: row.id,
    ownerUserId: row.userId,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString()
  };
}

/** Which profile a session is acting as. Keyed by session, exactly like the table. */
export interface SelectionRow {
  readonly profileId: string;
  readonly userId: string;
  readonly selectedAt: Date;
}

/**
 * The tables, as maps.
 *
 * Exported so a test can construct an adapter with a known starting state and
 * read the state back afterwards, rather than asserting on storage through the
 * HTTP layer that is supposed to be the thing under test.
 */
export interface InMemoryStore {
  readonly profiles: Map<string, ProfileRow>;
  readonly selections: Map<string, SelectionRow>;
  readonly progress: Map<string, PlaybackProgressRow>;
  readonly watchlist: Map<string, WatchlistEntryRow>;
}

export function createInMemoryStore(): InMemoryStore {
  return {
    profiles: new Map(),
    selections: new Map(),
    progress: new Map(),
    watchlist: new Map()
  };
}

/**
 * The development repository, plus the one fact about itself worth publishing.
 *
 * `admittedBy` exists for the same reason `FixtureProvider.environment` does: a
 * caller that reports which environment authorised this adapter must read the
 * value the classification actually used, rather than re-reading `process.env`
 * and possibly reporting a different one. `index.ts` puts it in the reason
 * trail.
 *
 * `adapterId` is narrowed to the literal, so a consumer holding this type does
 * not have to re-check which adapter it has.
 */
export interface InMemoryRepository extends LibertyRepository {
  readonly adapterId: "in_memory";
  /** The `NODE_ENV` that admitted this adapter. Reported, never re-tested. */
  readonly admittedBy: string;
}

/**
 * Build the development repository.
 *
 * `environment` is a WITNESS, not a configuration value. Its purpose is that it
 * cannot be obtained in a deployment; see the header. It is read once, for the
 * `NODE_ENV` it reports, and never re-tested.
 *
 * `store` is injectable so that tests can seed and inspect one. It defaults to a
 * fresh store, which is the right default for a caller that has not said
 * otherwise -- a shared module-level store would make two adapters built in one
 * process invisibly the same adapter.
 */
export function createInMemoryRepository(
  environment: NonDeploymentEnvironment,
  store: InMemoryStore = createInMemoryStore()
): InMemoryRepository {
  /** The account's profiles that are still on the picker, in the table's order. */
  function liveProfilesOf(userId: string): readonly ProfileRow[] {
    return [...store.profiles.values()]
      .filter((row) => row.userId === userId && row.archivedAt === null)
      /*
       * Creation time then id, matching `listProfilesForAccount`'s
       * `ORDER BY created_at, id`. `createdAt` alone is not a total order, and a
       * picker whose tiles reshuffle between renders is a determinism defect the
       * viewer can see.
       *
       * `id` IS THE TIE-BREAK AND NOTHING MORE. It is a random UUID from
       * `newProfileId`, so two profiles sharing an instant come back in a stable
       * but meaningless order -- NOT in creation order, which nothing stored
       * here or in PostgreSQL can recover. Answering ties from this map's
       * insertion order instead would give a better answer than the database
       * can, which is the worst of the options: development would be quietly
       * correct about something production is not.
       * `app/api/v1/profiles/contract.ts` publishes the promise both adapters
       * can actually keep -- oldest first, ties stable.
       */
      .sort((left, right) => {
        const byCreated = left.createdAt.getTime() - right.createdAt.getTime();
        return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
      });
  }

  return {
    adapterId: "in_memory",
    admittedBy: environment.nodeEnv,

    /* ----------------------------------------------------------------
     * Profiles (PL-0402)
     * ---------------------------------------------------------------- */

    loadProfileOwnership: async (profileId) => {
      /*
       * The shape check runs before the lookup, matching the package: an id that
       * could not have been minted is answered without touching storage, so the
       * cheapest possible probe is also the cheapest one to answer.
       */
      if (!isMintedProfileId(profileId)) return null;
      const row = store.profiles.get(profileId);
      return row === undefined ? null : toOwnership(row);
    },

    listProfilesForAccount: async (session) => liveProfilesOf(session.account.userId),

    createProfile: async (input) => {
      const resolution = resolveProfileCreation({
        existingProfileCount: liveProfilesOf(input.session.account.userId).length,
        displayName: input.displayName,
        avatarKey: input.avatarKey,
        maxRating: input.maxRating
      });
      if (!resolution.ok) return resolution;

      /*
       * THE ONE RULE THIS FILE MODELS ITSELF. In the PostgreSQL adapter this is
       * `UNIQUE (user_id, display_name)` -- declared in `schema/profiles.ts`,
       * applied by migration `0000_profile_scoped_identity.sql` -- and
       * `createProfile` reads the constraint violation back. There is no pure
       * module to borrow, so the rule is restated, and the two properties that
       * make the restatement match are stated rather than assumed:
       *
       *   - it compares the NORMALISED name (`resolution.displayName`), which is
       *     what the column would hold, not what the caller submitted;
       *   - it spans ARCHIVED profiles, because the constraint carries no
       *     partial predicate, so reusing an archived profile's name is refused
       *     by both adapters.
       *
       * It is a linear scan. The ceiling is five profiles per account, so the
       * scan is bounded by the number of accounts in a development process, and
       * an index here would be machinery guarding nothing.
       */
      for (const row of store.profiles.values()) {
        if (row.userId !== input.session.account.userId) continue;
        if (row.displayName !== resolution.displayName) continue;
        return {
          ok: false,
          reason: "display_name_already_used",
          detail: `this account already has a profile named ${JSON.stringify(resolution.displayName)}; the check spans archived profiles, matching UNIQUE (user_id, display_name) in migration 0000_profile_scoped_identity.sql`
        };
      }

      const row: ProfileRow = {
        /*
         * Minted here, by the package's own generator, for the reason
         * `newProfileId` gives: a caller-supplied id leaves the most important
         * property of an identifier -- whether it is guessable -- undecided.
         */
        id: newProfileId(),
        /* From the SESSION, never from a request body. */
        userId: input.session.account.userId,
        displayName: resolution.displayName,
        avatarKey: resolution.avatarKey,
        maxRating: resolution.maxRating,
        createdAt: input.instant,
        archivedAt: null
      };
      store.profiles.set(row.id, row);
      return { ok: true, profile: row };
    },

    selectActiveProfile: async (input) => {
      /*
       * The brand proves an authorization decision happened; it does not carry
       * WHICH session it was made for. Checked first, exactly as the package
       * does, because a scope that outlived its request is otherwise a working
       * capability for another account's profile.
       */
      if (!scopeBelongsToSession(input.scope, input.session)) {
        return {
          ok: false,
          reason: "scope_not_granted_to_this_session",
          detail: `the scope for profile ${input.scope.profileId} was granted to a different account than this session's`
        };
      }

      /*
       * PostgreSQL refuses a selection naming a profile this account does not
       * own through `active_profile_selection_profile_owner_fk`, the composite
       * foreign key to `profile (id, user_id)`. A foreign-key violation reaches
       * the PostgreSQL adapter as a thrown driver exception, so a THROW is what
       * matches: returning a reasoned refusal here would make the two adapters
       * differ on a path that is only reachable when something upstream is
       * already broken, and would hide it. It is not reachable through the
       * routes -- the only producers of a `ProfileScope` are the two grants in
       * `@liberty/auth`, and both establish ownership before minting one.
       */
      const owned = store.profiles.get(input.scope.profileId);
      if (owned === undefined || owned.userId !== input.session.account.userId) {
        throw new Error(
          `active_profile_selection would violate profile ownership for ${input.scope.profileId}`
        );
      }

      store.selections.set(input.session.account.sessionId, {
        profileId: input.scope.profileId,
        userId: input.session.account.userId,
        selectedAt: input.instant
      });
      return { ok: true, profileId: input.scope.profileId };
    },

    resolveSession: async (account) => {
      const selection = store.selections.get(account.sessionId);
      /*
       * Scoped by session AND account, matching `loadActiveProfileId`. The
       * session id alone is already the primary key; the second predicate costs
       * nothing and means the selection returned is one this account made.
       */
      const activeProfileId =
        selection !== undefined && selection.userId === account.userId ? selection.profileId : null;
      return { account, activeProfileId };
    },

    /* ----------------------------------------------------------------
     * Progress (PL-0403)
     * ---------------------------------------------------------------- */

    issueWriterLease: async (input) => {
      const contentId = parseContentId(input.contentId);
      if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

      /*
       * The same guard `issueWriterLease` applies, for the same reason: an
       * Invalid Date is what `new Date(x)` returns for any `x` it cannot read,
       * and on this path there is no resolver downstream to catch it.
       */
      if (representableInstant(input.instant) === null) {
        return {
          ok: false,
          reason: "instant_not_representable",
          detail: describeUnrepresentableInstant("instant", input.instant)
        };
      }

      const key = scopedKey(input.scope.profileId, contentId.contentId);
      const stored = store.progress.get(key);
      /*
       * `nextWriterEpoch` rather than arithmetic written here. In PostgreSQL the
       * increment happens INSIDE the statement, so two devices asking at the
       * same instant are serialised by the server; JavaScript's single thread
       * gives the same serialisation for free, and the epoch is still computed
       * by the package's function so the two cannot disagree about where epochs
       * start.
       */
      const epoch = nextWriterEpoch(stored === undefined ? null : toStored(stored));

      if (stored === undefined) {
        store.progress.set(key, {
          profileId: input.scope.profileId,
          contentId: contentId.contentId,
          /*
           * NULL, NOT ZERO. A lease is a claim on the right to write; it is not
           * a write. A 0 here would record a position the viewer never reached
           * and put the title at the top of "continue watching" at 0:00.
           */
          positionSeconds: null,
          runtimeSeconds: null,
          writerEpoch: epoch,
          writerId: input.writerId,
          writeSeq: 0,
          updatedAt: input.instant
        });
      } else {
        /*
         * `positionSeconds`, `runtimeSeconds` and `updatedAt` are carried over
         * untouched, matching the `onConflictDoUpdate` set list: taking over
         * playback must not move the resume point or make an untouched title
         * look freshly watched.
         */
        store.progress.set(key, {
          ...stored,
          writerEpoch: epoch,
          writerId: input.writerId,
          writeSeq: 0
        });
      }

      return { ok: true, epoch, writerId: input.writerId };
    },

    writeProgress: async (input) => {
      const contentId = parseContentId(input.contentId);
      if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

      const key = scopedKey(input.scope.profileId, contentId.contentId);
      const stored = store.progress.get(key);

      /*
       * The resolver decides, and it is the only thing that decides. In
       * PostgreSQL the authority is a guarded `UPDATE ... WHERE writer_epoch = $
       * AND writer_id = $ AND write_seq < $`, and the resolver explains what the
       * guard did; here there is no second writer between the read and the write
       * -- JavaScript's single thread is the serialisation -- so the resolver's
       * verdict is both the explanation and the enforcement.
       */
      const resolution = resolveProgressWrite({
        stored: stored === undefined ? null : toStored(stored),
        write: input.write,
        instant: input.instant
      });
      if (!resolution.accepted) return resolution;

      /*
       * The row is built from `resolution.next` rather than from `input.write`,
       * so the runtime stored is the one the resolver decided -- which is where
       * `retained_known_runtime` is applied. Reading the write's own runtime here
       * would overwrite a known runtime with an unknown one and make that note a
       * lie.
       */
      store.progress.set(key, {
        profileId: input.scope.profileId,
        contentId: contentId.contentId,
        positionSeconds: resolution.next.positionSeconds,
        runtimeSeconds: resolution.next.runtimeSeconds,
        writerEpoch: resolution.next.writerEpoch,
        writerId: resolution.next.writerId,
        writeSeq: resolution.next.writeSeq,
        updatedAt: new Date(resolution.next.updatedAt)
      });
      return resolution;
    },

    readProgress: async (input) => {
      const contentId = parseContentId(input.contentId);
      if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };
      return store.progress.get(scopedKey(input.scope.profileId, contentId.contentId)) ?? null;
    },

    /* ----------------------------------------------------------------
     * Watchlist (PL-0404)
     * ---------------------------------------------------------------- */

    addToWatchlist: async (input) => {
      const contentId = parseContentId(input.contentId);
      if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

      const key = scopedKey(input.scope.profileId, contentId.contentId);
      const existing = store.watchlist.get(key);

      /*
       * ONE call to the resolver, with the pre-state this adapter genuinely
       * read. The PostgreSQL adapter needs two -- a pre-flight to catch an
       * unreadable instant before the statement, then a second call to name the
       * outcome -- because `ON CONFLICT DO NOTHING ... RETURNING` is what proves
       * the pre-state there. Here the map was read first, so the pre-state is a
       * fact before anything is written and a pre-flight would be asking the
       * same question twice.
       *
       * `addedAt` IS REPORTED ON `already_present`, where the PostgreSQL adapter
       * reports `null`. That is a real difference between the adapters and it is
       * the honest answer for each: `null` there means "a row exists and we did
       * not read when it was added", which is true of a `DO NOTHING` that
       * returned no row and would be false here. Consumers must handle `null`
       * either way, and the response contract types it nullable.
       */
      const resolution = resolveWatchlistMutation({
        stored: existing === undefined ? null : { addedAt: existing.addedAt.toISOString() },
        mutation: { kind: "add", instant: input.instant }
      });
      if (!resolution.accepted) return resolution;

      if (resolution.reason === "added") {
        store.watchlist.set(key, {
          profileId: input.scope.profileId,
          contentId: contentId.contentId,
          addedAt: input.instant
        });
      }
      /*
       * Nothing is written on `already_present`: the FIRST add wins the sort
       * key, and rewriting `added_at` would move an entry the viewer never
       * touched to the top of the list.
       */
      return resolution;
    },

    removeFromWatchlist: async (input) => {
      const contentId = parseContentId(input.contentId);
      if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

      const key = scopedKey(input.scope.profileId, contentId.contentId);
      const existing = store.watchlist.get(key);
      store.watchlist.delete(key);

      /* Removing something absent is a success, not a 404 -- the resolver's rule. */
      return resolveWatchlistMutation({
        stored: existing === undefined ? null : { addedAt: existing.addedAt.toISOString() },
        mutation: { kind: "remove" }
      });
    },

    listWatchlist: async (input) => {
      const limit = parseListLimit(input.limit);
      if (!limit.ok) return limit;

      return [...store.watchlist.values()]
        .filter((row) => row.profileId === input.scope.profileId)
        /*
         * Most recently added first, with `contentId` descending as the
         * tie-break, matching `ORDER BY added_at DESC, content_id DESC`. A bulk
         * import can add many entries in one instant, and without a total order
         * a paginated list drops and repeats rows.
         */
        .sort((left, right) => {
          const byAdded = right.addedAt.getTime() - left.addedAt.getTime();
          return byAdded !== 0 ? byAdded : right.contentId.localeCompare(left.contentId);
        })
        .slice(0, limit.limit);
    }
  };
}
