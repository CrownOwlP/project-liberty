import type { LibertySession, ProfileScope } from "@liberty/auth";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LibertyDatabase } from "./client";
import {
  archiveProfile,
  countLiveProfilesForAccount,
  createProfile,
  listProfilesForAccount,
  loadActiveProfileId,
  loadProfileOwnership,
  resolveLibertySession,
  selectActiveProfile
} from "./profile-repository";
import {
  issueWriterLease,
  listContinueWatching,
  readProgress,
  writeProgress
} from "./progress-repository";
import {
  addToWatchlist,
  listWatchlist,
  removeFromWatchlist,
  watchlistContains
} from "./watchlist-repository";

/**
 * Every statement carries a profile predicate -- checked against the SQL, not
 * against a reading of the source (PL-0403/PL-0404).
 *
 * `profile-scoping.test.ts` proves the SCHEMA is scoped: `profile_id` leads both
 * primary keys, is NOT NULL, cascades, and there is no `user_id` column. That is
 * a necessary condition and not a sufficient one. A correctly-keyed table is
 * still readable across profiles by a query that simply omits the predicate, and
 * the failure mode is the worst one this product has: one household member's
 * viewing history rendered on another's screen.
 *
 * The same argument runs one level up, and the second half of this file
 * (PL-0402) makes it: the ACCOUNT-level statements in `profile-repository.ts`
 * are what decide which profiles exist for a household at all, and a
 * `listProfilesForAccount` that forgot its `user_id` predicate would render
 * every profile in the product on somebody's picker. Those statements had no
 * rendered-SQL coverage until this audit; the brand on `ProfileScope` says
 * nothing about them, because they take a `LibertySession` rather than a scope.
 *
 * So this file checks the OTHER half -- that every statement every repository
 * function issues either filters on `profile_id` or writes it as a value. It
 * does so by running the real repository functions against a recording stand-in
 * for the Drizzle client and rendering the captured `WHERE` clauses through
 * Drizzle's own `PgDialect`. The SQL asserted on is therefore the SQL that would
 * be sent, not a paraphrase of it.
 *
 * NO DATABASE, AND NONE WOULD HELP. The question is what the statement SAYS. A
 * live PostgreSQL would answer "did this particular query return rows it should
 * not have", which depends on what happens to be in the table -- a test that
 * passes on an empty database and on a single-profile fixture, which is exactly
 * the shape of fixture somebody writes first.
 *
 * WHAT THIS FILE CANNOT COVER. It sees the statements these functions build. It
 * cannot see a future raw-SQL escape hatch, a relational-query-builder call
 * (`db.query.*`), or anything a caller writes outside this package. Those need
 * the integration suite that does not exist yet; see the audit note in
 * `docs/DATA_MODEL.md` under "Unverified".
 */

const dialect = new PgDialect();

interface Recorded {
  /** Every `SQL` handed to a `.where(...)`, in the order the statements were built. */
  readonly wheres: SQL[];
  /** Every row object handed to an `.values(...)`. */
  readonly values: Record<string, unknown>[];
  /** Every `ON CONFLICT` target, so an upsert's implicit scoping is visible too. */
  readonly conflictTargets: unknown[];
  /** Method names seen, so a statement that built nothing at all is detectable. */
  readonly calls: string[];
}

function emptyRecording(): Recorded {
  return { wheres: [], values: [], conflictTargets: [], calls: [] };
}

/**
 * A stand-in for the Drizzle client that records instead of executing.
 *
 * A `Proxy` rather than a hand-written fake with one method per builder step:
 * the hand-written version has to be extended every time a repository adds a
 * `.orderBy` or a `.returning`, and the version that is not extended fails as a
 * `TypeError` that looks like a bug in the repository rather than in the test.
 *
 * `then` is intercepted because every Drizzle builder is a thenable -- awaiting
 * one is what executes it -- so without this the first `await` in a repository
 * would hang or recurse.
 */
function recordingDb(recorded: Recorded, rows: readonly unknown[]): LibertyDatabase {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => void) => resolve([...rows]);
        }
        // Symbols are probed by the runtime (`Symbol.toPrimitive`,
        // `Symbol.iterator`); answering them with a function would make the
        // proxy claim to be things it is not.
        if (typeof property === "symbol") return undefined;
        // Bound to a `const` so the narrowing to `string` survives into the
        // closure below; a parameter's narrowing does not.
        const method: string = property;

        return (...args: unknown[]) => {
          recorded.calls.push(method);
          if (method === "where") {
            for (const argument of args) {
              if (argument !== undefined && argument !== null) recorded.wheres.push(argument as SQL);
            }
          }
          if (method === "values") {
            recorded.values.push(args[0] as Record<string, unknown>);
          }
          if (method === "onConflictDoNothing" || method === "onConflictDoUpdate") {
            recorded.conflictTargets.push(args[0]);
          }
          return chain;
        };
      }
    }
  );

  // The cast is unavoidable and is the point of the file: `LibertyDatabase` is a
  // driver-bound type and this object executes nothing. It is confined to this
  // test rather than being a helper anything else can reach for.
  return chain as LibertyDatabase;
}

/**
 * A scope, forged.
 *
 * `ProfileScope`'s brand is a non-exported `unique symbol`, so producing one
 * outside `authorizeProfileAccess` requires exactly this cast -- which is the
 * enforcement working as designed. A test is the one legitimate place for it.
 */
const scope = { profileId: "profile_ada", grantedFor: "user_household" } as unknown as ProfileScope;
const OTHER_PROFILE = "profile_grace";

const INSTANT = new Date("2026-08-21T20:00:00.000Z");

const progressRow = {
  profileId: scope.profileId,
  contentId: "the-northstar-affair",
  positionSeconds: 600,
  runtimeSeconds: 5400,
  writerEpoch: 4,
  writerId: "writer_television",
  writeSeq: 12,
  updatedAt: INSTANT
};

const watchlistRow = { profileId: scope.profileId, contentId: "the-northstar-affair", addedAt: INSTANT };

const leaseRow = { epoch: 4, writerId: "writer_television" };

/** Render one captured predicate to the SQL text that would be sent. */
const render = (where: SQL): string => dialect.sqlToQuery(where).sql;

/**
 * Every repository call that issues a statement, with rows chosen so the
 * function reaches its statement rather than short-circuiting.
 *
 * `writeProgress` is given a stored row that its write legitimately supersedes;
 * with no row the resolver refuses `no_writer_lease` and the guarded UPDATE --
 * the statement most worth checking -- is never built.
 */
const calls: readonly {
  readonly name: string;
  readonly rows: readonly unknown[];
  readonly run: (db: LibertyDatabase) => Promise<unknown>;
}[] = [
  {
    name: "readProgress",
    rows: [progressRow],
    run: (db) => readProgress(db, { scope, contentId: "the-northstar-affair" })
  },
  {
    name: "listContinueWatching",
    rows: [progressRow],
    run: (db) => listContinueWatching(db, { scope, limit: 20 })
  },
  {
    name: "issueWriterLease",
    rows: [leaseRow],
    run: (db) =>
      issueWriterLease(db, {
        scope,
        contentId: "the-northstar-affair",
        writerId: "writer_phone",
        instant: INSTANT
      })
  },
  {
    name: "writeProgress",
    rows: [progressRow],
    run: (db) =>
      writeProgress(db, {
        scope,
        contentId: "the-northstar-affair",
        write: {
          lease: { epoch: 4, writerId: "writer_television" },
          writeSeq: 13,
          positionSeconds: 660,
          runtimeSeconds: 5400
        },
        instant: INSTANT
      })
  },
  {
    name: "addToWatchlist",
    rows: [watchlistRow],
    run: (db) => addToWatchlist(db, { scope, contentId: "the-northstar-affair", instant: INSTANT })
  },
  {
    name: "removeFromWatchlist",
    rows: [watchlistRow],
    run: (db) => removeFromWatchlist(db, { scope, contentId: "the-northstar-affair" })
  },
  {
    name: "listWatchlist",
    rows: [watchlistRow],
    run: (db) => listWatchlist(db, { scope, limit: 20 })
  },
  {
    name: "watchlistContains",
    rows: [watchlistRow],
    run: (db) =>
      watchlistContains(db, { scope, contentIds: ["the-northstar-affair", "episode-2"] })
  }
];

describe("every repository statement is scoped to a profile", () => {
  it("covers every exported function that touches a viewer-state table", () => {
    // A guard against this file quietly shrinking: adding a repository function
    // and forgetting to list it here is how the next unscoped query ships.
    expect(calls.map((call) => call.name).sort()).toEqual([
      "addToWatchlist",
      "issueWriterLease",
      "listContinueWatching",
      "listWatchlist",
      "readProgress",
      "removeFromWatchlist",
      "watchlistContains",
      "writeProgress"
    ]);
  });

  it.each(calls)("$name builds at least one statement", async ({ rows, run }) => {
    const recorded = emptyRecording();
    await run(recordingDb(recorded, rows));
    // Without this, a function that returned early would pass every assertion
    // below vacuously -- the exact way a scoping suite becomes decoration.
    expect(recorded.calls.length).toBeGreaterThan(0);
  });

  it.each(calls)("$name filters or writes profile_id in every statement", async ({ rows, run }) => {
    const recorded = emptyRecording();
    await run(recordingDb(recorded, rows));

    const scoped =
      recorded.wheres.length + recorded.values.length + recorded.conflictTargets.length;
    expect(scoped).toBeGreaterThan(0);

    for (const where of recorded.wheres) {
      // The rendered predicate, not the builder object: an `eq()` on the wrong
      // column is still an `eq()`, and only the SQL says which one.
      expect(render(where)).toContain('"profile_id"');
    }
    for (const row of recorded.values) {
      // The INSERT paths (`addToWatchlist`, `issueWriterLease`) carry no WHERE;
      // their scoping is the value written plus the composite primary key.
      expect(row["profileId"]).toBe(scope.profileId);
    }
  });

  it.each(calls)("$name never names a profile other than the scope's", async ({ rows, run }) => {
    const recorded = emptyRecording();
    await run(recordingDb(recorded, rows));

    // The parameters are what a predicate is actually compared against, so this
    // is where a scope swapped for a request-body profile id would show up.
    for (const where of recorded.wheres) {
      const query = dialect.sqlToQuery(where);
      expect(query.params).not.toContain(OTHER_PROFILE);
    }
    for (const row of recorded.values) {
      expect(Object.values(row)).not.toContain(OTHER_PROFILE);
    }
  });
});

describe("the profile predicate is bound to the scope, not to a literal", () => {
  it("puts the scope's profile id in the parameters of every predicate", async () => {
    const recorded = emptyRecording();
    for (const call of calls) {
      await call.run(recordingDb(recorded, call.rows));
    }

    expect(recorded.wheres.length).toBeGreaterThan(0);
    for (const where of recorded.wheres) {
      const query = dialect.sqlToQuery(where);
      // Parameterised, so the id can never be spliced into the statement text --
      // and present, so the predicate is about THIS profile rather than about
      // `profile_id` in the abstract.
      expect(query.params).toContain(scope.profileId);
    }
  });
});

/* -------------------------------------------------------------------------
 * The account level (PL-0402)
 * ---------------------------------------------------------------------- */

const HOUSEHOLD = "user_household";
const OTHER_HOUSEHOLD = "user_someone_else";

/**
 * A session for the account the forged scope above was granted to.
 *
 * `scope.grantedFor` is `"user_household"`, so this session and that scope agree
 * -- which is what lets the functions taking both get past
 * `scopeBelongsToSession` and reach the statement this file is here to inspect.
 */
const session: LibertySession = {
  account: { userId: HOUSEHOLD, sessionId: "session_tv_lounge" },
  activeProfileId: scope.profileId
};

/** A well-formed profile id of the shape `newProfileId` actually mints. */
const MINTED_PROFILE_ID = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

const profileRow = {
  id: MINTED_PROFILE_ID,
  userId: HOUSEHOLD,
  displayName: "Dad",
  avatarKey: null,
  maxRating: null,
  createdAt: INSTANT,
  archivedAt: null
};

/**
 * Every account-level call, with rows chosen so the function reaches its
 * statement.
 *
 * The recording client answers EVERY await with the same array, so a function
 * issuing two statements sees the same rows twice. That is harmless here --
 * nothing below inspects the returned row's shape, only the SQL that was built
 * -- and it is the reason `createProfile` is given a row that satisfies both its
 * count query and its insert's `RETURNING`.
 */
const accountCalls: readonly {
  readonly name: string;
  readonly rows: readonly unknown[];
  readonly run: (db: LibertyDatabase) => Promise<unknown>;
}[] = [
  {
    name: "listProfilesForAccount",
    rows: [profileRow],
    run: (db) => listProfilesForAccount(db, session)
  },
  {
    name: "countLiveProfilesForAccount",
    rows: [{ value: 0 }],
    run: (db) => countLiveProfilesForAccount(db, session)
  },
  {
    name: "createProfile",
    rows: [{ value: 0, ...profileRow }],
    run: (db) =>
      createProfile(db, {
        session,
        displayName: "Kids",
        avatarKey: null,
        maxRating: "PG",
        instant: INSTANT
      })
  },
  {
    name: "selectActiveProfile",
    rows: [],
    run: (db) => selectActiveProfile(db, { session, scope, instant: INSTANT })
  },
  {
    name: "archiveProfile",
    // Non-empty, or the UPDATE's `RETURNING` comes back empty, the function
    // refuses with `no_live_profile_for_scope` and the DELETE that releases the
    // selection -- the second statement worth checking -- is never built.
    rows: [{ id: scope.profileId }],
    run: (db) => archiveProfile(db, { session, scope, instant: INSTANT })
  },
  {
    name: "loadActiveProfileId",
    rows: [{ profileId: scope.profileId }],
    run: (db) => loadActiveProfileId(db, session.account)
  },
  {
    name: "resolveLibertySession",
    rows: [{ profileId: scope.profileId }],
    run: (db) => resolveLibertySession(db, session.account)
  }
];

describe("every account-level profile statement names the account", () => {
  it("covers every account-scoped statement profile-repository.ts issues", () => {
    // The same guard the viewer-state list carries, and for the same reason:
    // adding a repository function and forgetting to list it here is how the
    // next unscoped query ships. `newProfileId` is absent because it issues no
    // statement; `loadProfileOwnership` is the ONE deliberate absence and is asserted
    // separately below: it runs before authorization and therefore cannot carry
    // an account predicate. Folding it in here would have meant weakening this
    // assertion to accommodate the one function that legitimately breaks it.
    expect(accountCalls.map((call) => call.name).sort()).toEqual([
      "archiveProfile",
      "countLiveProfilesForAccount",
      "createProfile",
      "listProfilesForAccount",
      "loadActiveProfileId",
      "resolveLibertySession",
      "selectActiveProfile"
    ]);
    // The forged scope at the top of this file was granted to this account. If
    // that ever stops being true, every call below refuses on
    // `scope_not_granted_to_this_session` and the statement assertions pass
    // vacuously because no statement was built.
    expect(scope.grantedFor).toBe(HOUSEHOLD);
  });

  it.each(accountCalls)("$name builds at least one statement", async ({ rows, run }) => {
    const recorded = emptyRecording();
    await run(recordingDb(recorded, rows));
    expect(recorded.calls.length).toBeGreaterThan(0);
  });

  it.each(accountCalls)("$name filters or writes user_id in every statement", async ({ rows, run }) => {
    const recorded = emptyRecording();
    await run(recordingDb(recorded, rows));

    for (const where of recorded.wheres) {
      // Rendered, not the builder object: an `eq()` on the wrong column is still
      // an `eq()`, and only the SQL says which one.
      expect(render(where)).toContain('"user_id"');
    }
    for (const row of recorded.values) {
      // The INSERT paths carry no WHERE; their scoping is the value written.
      expect(row["userId"]).toBe(HOUSEHOLD);
    }
    expect(recorded.wheres.length + recorded.values.length).toBeGreaterThan(0);
  });

  it.each(accountCalls)("$name binds the session's account, never another", async ({ rows, run }) => {
    const recorded = emptyRecording();
    await run(recordingDb(recorded, rows));

    for (const where of recorded.wheres) {
      const query = dialect.sqlToQuery(where);
      expect(query.params).toContain(HOUSEHOLD);
      expect(query.params).not.toContain(OTHER_HOUSEHOLD);
    }
    for (const row of recorded.values) {
      expect(Object.values(row)).not.toContain(OTHER_HOUSEHOLD);
    }
  });

  it("never writes a caller-supplied owner", async () => {
    // The single worst thing this file could fail to catch: `userId` taken from
    // a request body rather than from the session is how one account creates a
    // profile inside another's household, and no downstream check recovers from
    // having written that row.
    const recorded = emptyRecording();
    await createProfile(recordingDb(recorded, [{ value: 0, ...profileRow }]), {
      session,
      displayName: "Kids",
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });

    expect(recorded.values.length).toBe(1);
    expect(recorded.values[0]?.["userId"]).toBe(HOUSEHOLD);
  });

  it("mints the profile id itself rather than accepting one", async () => {
    // There is no `profileId` field on `CreateProfileInput` to pass, which is
    // the enforcement; this asserts the value that lands is the minted shape and
    // not, say, a display name reused as a key.
    const recorded = emptyRecording();
    await createProfile(recordingDb(recorded, [{ value: 0, ...profileRow }]), {
      session,
      displayName: "Kids",
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });

    expect(recorded.values[0]?.["id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("writes null rather than an empty string for an optional field left blank", async () => {
    // "Unknown is not a value." An `avatarKey: ""` reaching the column is a
    // third state that means the same thing as NULL and does not compare equal
    // to it, so `avatar_key IS NULL` stops finding the profiles with no avatar.
    const recorded = emptyRecording();
    await createProfile(recordingDb(recorded, [{ value: 0, ...profileRow }]), {
      session,
      displayName: "Kids",
      avatarKey: "   ",
      maxRating: "",
      instant: INSTANT
    });

    expect(recorded.values[0]?.["avatarKey"]).toBeNull();
    expect(recorded.values[0]?.["maxRating"]).toBeNull();
  });

  it("refuses a blank display name before issuing any statement but the count", async () => {
    const recorded = emptyRecording();
    const result = await createProfile(recordingDb(recorded, [{ value: 0 }]), {
      session,
      displayName: `  ${String.fromCodePoint(0x200b)}  `,
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    // Nothing was inserted. A refusal that still wrote the row would be a
    // validator in name only.
    expect(recorded.values).toEqual([]);
  });

  it("refuses to create past the ceiling, and inserts nothing when it does", async () => {
    const recorded = emptyRecording();
    const result = await createProfile(recordingDb(recorded, [{ value: 5 }]), {
      session,
      displayName: "Sixth",
      avatarKey: null,
      maxRating: null,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("profile_limit_reached");
    expect(recorded.values).toEqual([]);
  });
});

describe("the one read that cannot carry an account predicate", () => {
  it("loadProfileOwnership selects by profile id alone, which is the point of it", async () => {
    // It runs BEFORE authorization -- it is what produces the input to the
    // decision -- so it cannot presuppose the answer by scoping to the account.
    // It returns ownership facts only, which is what makes that safe: the row's
    // display name and avatar never leave the package for a profile the caller
    // has not been authorized for.
    const recorded = emptyRecording();
    await loadProfileOwnership(recordingDb(recorded, [profileRow]), MINTED_PROFILE_ID);

    expect(recorded.wheres.length).toBe(1);
    const rendered = recorded.wheres.map(render).join(" ");
    expect(rendered).toContain('"id"');
    expect(rendered).not.toContain('"user_id"');
  });

  it("loadProfileOwnership issues no statement at all for an id that could not have been minted", async () => {
    // The cost boundary. A caller walking /profiles/1, /profiles/2, ... is
    // answered from a regex rather than from a connection, so the cheapest
    // possible probe is also the one that consumes nothing.
    const recorded = emptyRecording();
    const ownership = await loadProfileOwnership(recordingDb(recorded, [profileRow]), "1");

    expect(ownership).toBeNull();
    expect(recorded.calls).toEqual([]);
  });

  it("loadActiveProfileId names the session as well as the account", async () => {
    // The account predicate is asserted by the shared suite above; this is the
    // other half, and it is the one that makes the read a lookup rather than a
    // scan -- `active_profile_selection` is keyed by session id.
    const recorded = emptyRecording();
    await loadActiveProfileId(recordingDb(recorded, [{ profileId: scope.profileId }]), session.account);

    expect(recorded.wheres.length).toBeGreaterThan(0);
    for (const where of recorded.wheres) {
      expect(render(where)).toContain('"session_id"');
    }
  });
});

describe("resolveLibertySession", () => {
  it("takes the active profile from the database, and offers no way to supply one", async () => {
    // The whole point of the function. `LibertySession` is a plain interface, so
    // a handler can build one from a header and every type here will accept it;
    // this constructor's signature has no parameter through which an
    // `activeProfileId` could arrive, which is the same absence `ProgressWrite`
    // maintains for client-asserted timestamps.
    const resolved = await resolveLibertySession(
      recordingDb(emptyRecording(), [{ profileId: scope.profileId }]),
      session.account
    );

    expect(resolved.account).toEqual(session.account);
    expect(resolved.activeProfileId).toBe(scope.profileId);
  });

  it("reports null when nothing is selected, rather than inventing a profile", async () => {
    // "Signed in, no profile chosen" is the profile picker's state and is a real
    // one. Defaulting to the first profile in the household here would silently
    // resume somebody else's episode on a shared television.
    const resolved = await resolveLibertySession(recordingDb(emptyRecording(), []), session.account);

    expect(resolved.activeProfileId).toBeNull();
  });
});

describe("a scope that was granted to another session", () => {
  /**
   * The forgery this file is allowed to make, pointed the other way.
   *
   * `ProfileScope`'s brand proves that SOME authorization decision happened. It
   * cannot prove the decision was made for THIS session, because a scope is a
   * plain object that can outlive the request that earned it -- a cache, a
   * closure, a module-level variable. `grantedFor` is what closes that, and
   * nothing in this package was checking it before this audit.
   */
  const foreignScope = {
    profileId: scope.profileId,
    grantedFor: OTHER_HOUSEHOLD
  } as unknown as ProfileScope;

  it("cannot select a profile", async () => {
    const recorded = emptyRecording();
    const result = await selectActiveProfile(recordingDb(recorded, []), {
      session,
      scope: foreignScope,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_not_granted_to_this_session");
    // No statement was built. The composite foreign key would also have refused
    // this, as a driver exception at an unattributable stack depth; the point of
    // the check is that it never reaches the database.
    expect(recorded.calls).toEqual([]);
  });

  it("cannot archive a profile", async () => {
    const recorded = emptyRecording();
    const result = await archiveProfile(recordingDb(recorded, [{ id: scope.profileId }]), {
      session,
      scope: foreignScope,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope_not_granted_to_this_session");
    expect(recorded.calls).toEqual([]);
  });

  it("does not name either account id in the refusal", async () => {
    const result = await selectActiveProfile(recordingDb(emptyRecording(), []), {
      session,
      scope: foreignScope,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A detail printing both user ids would put one account's identifier into
    // the other account's error surface -- the leak this refusal exists to
    // prevent, in miniature.
    expect(result.detail).not.toContain(HOUSEHOLD);
    expect(result.detail).not.toContain(OTHER_HOUSEHOLD);
    expect(result.detail).toContain(scope.profileId);
  });
});

describe("archiving releases the sessions pointed at the profile", () => {
  it("archives, then deletes the selection rows, in that order", async () => {
    const recorded = emptyRecording();
    const result = await archiveProfile(recordingDb(recorded, [{ id: scope.profileId }]), {
      session,
      scope,
      instant: INSTANT
    });

    expect(result.ok).toBe(true);
    // `active_profile_selection` cascades on DELETE and archiving is not a
    // delete, so without the second statement a television is left with an
    // `activeProfileId` naming an archived profile: denied on every request, and
    // never shown the picker, because it still has a selection.
    expect(recorded.calls).toContain("update");
    expect(recorded.calls).toContain("delete");
    expect(recorded.calls.indexOf("update")).toBeLessThan(recorded.calls.indexOf("delete"));
    // Both statements name the account, and the DELETE names the profile too --
    // it must not release selections for a profile that was not archived.
    expect(recorded.wheres.length).toBe(2);
    for (const where of recorded.wheres) {
      expect(render(where)).toContain('"user_id"');
    }
  });

  it("reports a miss instead of claiming success, and releases nothing", async () => {
    // The defect this return type replaced: the extra ownership predicate
    // matched nothing, the UPDATE affected zero rows, and the caller was told
    // the archive succeeded. A household would have seen the profile still on
    // the picker after being told it was removed.
    const recorded = emptyRecording();
    const result = await archiveProfile(recordingDb(recorded, []), {
      session,
      scope,
      instant: INSTANT
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_live_profile_for_scope");
    expect(recorded.calls).not.toContain("delete");
  });
});
