/* -------------------------------------------------------------------------
 * The generated snapshot names the constraints the DATABASE actually has
 * (PL-0407).
 *
 * WHAT WENT WRONG. PL-0406 installed `migrations/meta/0000_snapshot.json` so
 * `drizzle-kit generate` had a previous state to diff against -- without it the
 * next generate emitted a duplicate migration re-creating all eight tables.
 * The snapshot is derived from the ORM schema, and for three tables the ORM
 * schema and the reviewed hand-written migration disagreed about what the
 * primary key is CALLED. Every foreign key and unique constraint matched; only
 * the primary keys did not:
 *
 *   active_profile_selection   DB active_profile_selection_pkey
 *                              snapshot active_profile_selection_session_id_pk
 *   playback_progress          DB playback_progress_pkey
 *                              snapshot playback_progress_profile_id_content_id_pk
 *   watchlist_entry            DB watchlist_entry_pkey
 *                              snapshot watchlist_entry_profile_id_content_id_pk
 *
 * Nothing was wrong at runtime -- the keys exist, the columns are right, and
 * `generate` never consults a database. The failure was deferred and then
 * total: the first generated migration touching one of these keys would emit
 * `DROP CONSTRAINT "<a name that is not there>"` and fail against every real
 * database at once, in whichever environment ran migrations first.
 *
 * THE FIX WAS A METADATA ALIGNMENT, not a semantic change, and gpt-architect's
 * round-99 ruling chose it over the alternatives: renaming live constraints to
 * suit a tool's convention, or hand-editing generated output, which is lost the
 * next time anyone regenerates. The three `primaryKey()` calls now pass an
 * explicit `name`.
 *
 * ==========================================================================
 * WHY THERE ARE TWO LAYERS HERE
 * ==========================================================================
 *
 * The first layer runs everywhere and needs no database: the snapshot's names
 * must equal the names PostgreSQL produces for the reviewed migration. For two
 * of the three, the migration states the name itself, so that is a comparison
 * between two files. For `active_profile_selection` the migration writes an
 * INLINE `PRIMARY KEY` on the column and PostgreSQL chooses `<table>_pkey` by
 * its own convention -- so that one case is a claim about PostgreSQL rather
 * than about this repository, and a file comparison cannot settle it.
 *
 * The second layer settles it. Given a database to work in, it applies the
 * reviewed migration and reads `pg_constraint`. It is OPT-IN by environment
 * variable because the unit job has no PostgreSQL and the e2e job that does is
 * outside this task's write surface; what it is NOT is optional evidence --
 * PL-0407's gate records a real run of it, and the names below came from that
 * run rather than from the convention.
 * ---------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsDir = new URL("../../migrations/", import.meta.url);
const snapshot = JSON.parse(
  readFileSync(new URL("meta/0000_snapshot.json", migrationsDir), "utf8")
) as { tables: Record<string, { compositePrimaryKeys?: Record<string, unknown> }> };
const migrationSql = readFileSync(
  new URL("0000_profile_scoped_identity.sql", migrationsDir),
  "utf8"
);

/**
 * The names the reviewed migration produces, and where each comes from.
 *
 * `statedInSql` marks the two the migration names itself. The third is
 * PostgreSQL's own convention for an unnamed primary key, which is why the
 * live check below exists.
 */
const EXPECTED = [
  { table: "active_profile_selection", constraint: "active_profile_selection_pkey", statedInSql: false },
  { table: "playback_progress", constraint: "playback_progress_pkey", statedInSql: true },
  { table: "watchlist_entry", constraint: "watchlist_entry_pkey", statedInSql: true }
] as const;

function snapshotPrimaryKeyNames(table: string): string[] {
  const entry = snapshot.tables[`public.${table}`] ?? snapshot.tables[table];
  if (entry === undefined) throw new Error(`the snapshot has no table ${table}`);
  return Object.keys(entry.compositePrimaryKeys ?? {});
}

describe("the snapshot's primary-key names match the migrated database", () => {
  for (const { table, constraint, statedInSql } of EXPECTED) {
    it(`${table} is ${constraint} in the generated snapshot`, () => {
      expect(snapshotPrimaryKeyNames(table)).toEqual([constraint]);
    });

    if (statedInSql) {
      it(`${table}'s name is the one the reviewed migration states`, () => {
        /* A file-to-file comparison, which is all this case needs: the SQL
         * names the constraint, so PostgreSQL uses that name verbatim. */
        expect(migrationSql).toContain(`CONSTRAINT "${constraint}" PRIMARY KEY`);
      });
    } else {
      it(`${table}'s name is PostgreSQL's convention for the inline key the migration writes`, () => {
        /*
         * THE CASE A FILE COMPARISON CANNOT SETTLE. The migration writes
         * `"session_id" text PRIMARY KEY NOT NULL` with no constraint name, so
         * the name is PostgreSQL's to choose and this expectation is a claim
         * about PostgreSQL. Asserted here as the convention, and CONFIRMED
         * against a real server by the opt-in check below -- whose result is
         * recorded in this task's gate evidence rather than inferred.
         */
        expect(migrationSql).toMatch(
          /"session_id"\s+text\s+PRIMARY KEY/i
        );
        expect(constraint).toBe(`${table}_pkey`);
      });
    }
  }

  it("names every primary key the snapshot carries, so a fourth cannot appear unchecked", () => {
    const named = Object.entries(snapshot.tables)
      .filter(([, table]) => Object.keys(table.compositePrimaryKeys ?? {}).length > 0)
      .map(([name]) => name.replace(/^public\./, ""))
      .sort();
    expect(named).toEqual(EXPECTED.map((e) => e.table).sort());
  });
});

/**
 * The live confirmation.
 *
 * Opt in with `LIBERTY_CONSTRAINT_CHECK_DATABASE_URL` pointing at a database
 * this test may write to. It REFUSES a database that already has tables rather
 * than migrating over someone's data -- a test that silently ran DDL against
 * whatever URL it found would be a worse defect than the one it guards.
 */
const liveUrl = process.env["LIBERTY_CONSTRAINT_CHECK_DATABASE_URL"];

describe.skipIf(!liveUrl)("against a freshly migrated PostgreSQL", () => {
  it("every primary-key name in pg_constraint matches the snapshot", async () => {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: liveUrl });
    await client.connect();
    try {
      const existing = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public'"
      );
      expect(
        Number(existing.rows[0]?.count ?? "0"),
        "LIBERTY_CONSTRAINT_CHECK_DATABASE_URL must point at an EMPTY database; " +
          "this test applies the migration and will not do that over existing tables"
      ).toBe(0);

      await client.query(migrationSql);

      const constraints = await client.query<{ table: string; name: string }>(
        `select conrelid::regclass::text as "table", conname as "name"
           from pg_constraint
          where connamespace = 'public'::regnamespace and contype = 'p'
          order by 1`
      );
      const live = new Map(
        constraints.rows.map((row) => [row.table.replace(/^"|"$/g, ""), row.name])
      );

      for (const { table, constraint } of EXPECTED) {
        expect(live.get(table), `${table}'s primary key in the database`).toBe(constraint);
        expect(snapshotPrimaryKeyNames(table)).toEqual([live.get(table)]);
      }

      /* And the postcondition PL-0406 was told to keep. */
      const tables = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables " +
          "where table_schema = 'public' and table_type = 'BASE TABLE'"
      );
      expect(Number(tables.rows[0]?.count ?? "0")).toBe(8);
    } finally {
      await client.end();
    }
  });
});
