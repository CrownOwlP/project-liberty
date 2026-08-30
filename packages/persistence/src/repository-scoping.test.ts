import type { ProfileScope } from "@liberty/auth";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LibertyDatabase } from "./client";
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
