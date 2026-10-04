/* -------------------------------------------------------------------------
 * The migration mechanism is wired, not merely present (PL-0406).
 *
 * WHAT WENT WRONG, AND WHY NO TEST CAUGHT IT. `packages/persistence/migrations/`
 * held one hand-written SQL file and nothing else. `drizzle-kit migrate` does
 * not read a directory of `.sql` files; it reads `meta/_journal.json` and
 * applies the tags listed there. With no journal, the documented command
 * `npm run db:migrate -w @liberty/persistence` applied NOTHING, and PW-0312
 * measured the consequence against a live PostgreSQL 16: a fresh database, a
 * real connection string, and zero relations afterwards. The same SQL through
 * `psql` creates all eight tables.
 *
 * MEASURED AGAIN HERE, on drizzle-kit 0.31.10, because the exact failure shape
 * decides what this file has to assert:
 *
 *   - NO journal at all            -> exit 1, and NOTHING on stderr. A silent
 *                                     non-zero is better than a silent zero and
 *                                     is still not a diagnosis.
 *   - journal with EMPTY `entries` -> EXIT 0, zero tables, and the words
 *                                     "migrations applied successfully!". This
 *                                     is the reported defect exactly: a command
 *                                     that reports success having done nothing.
 *   - tag with no matching .sql    -> exit 1.
 *   - malformed journal JSON       -> exit 1.
 *
 * So the property that makes the defect impossible is not "a journal exists".
 * It is that the journal is NON-EMPTY and agrees with the SQL on disk in BOTH
 * directions -- every tag has a file, and every file has a tag. An orphan
 * migration nobody references is the same failure wearing the other hat: the
 * file is right there, and it never runs.
 *
 * WHY THIS TEST TOUCHES NO DATABASE. A test that needed PostgreSQL would not
 * run in the unit job, which is where a regression has to fail to be worth
 * having -- and the thing that broke was never the SQL. It was the metadata
 * that decides whether the SQL is read at all, and that is a fact about files.
 * The live-database half of the acceptance -- fresh database, eight tables,
 * idempotent second run, non-zero on invalid metadata -- is recorded as gate
 * evidence against a real PostgreSQL 16, because that half genuinely cannot be
 * asserted here.
 *
 * `drizzle.config.ts` IS READ RATHER THAN TRUSTED. The directory this file
 * checks is the one the config names in `out`; hard-coding "migrations" would
 * let someone move the output and leave this test guarding an empty path.
 * ---------------------------------------------------------------------- */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** The `out` directory drizzle-kit writes to and reads from. */
const migrationsDir = (() => {
  const config = readFileSync(join(packageRoot, "drizzle.config.ts"), "utf8");
  const out = /out:\s*"\.\/([^"]+)"/.exec(config)?.[1];
  if (out === undefined) {
    throw new Error(
      "drizzle.config.ts no longer declares `out` as a './' string literal, so this test " +
        "cannot find the directory it is supposed to be guarding. Do not hard-code it here: " +
        "the config is the source."
    );
  }
  return join(packageRoot, out);
})();

const journalPath = join(migrationsDir, "meta", "_journal.json");

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  readonly version: string;
  readonly breakpoints: boolean;
}

function readJournal(): { version: string; dialect: string; entries: JournalEntry[] } {
  return JSON.parse(readFileSync(journalPath, "utf8")) as ReturnType<typeof readJournal>;
}

const sqlFiles = () =>
  readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

/**
 * The eight tables the first migration exists to create.
 *
 * gpt-architect's acceptance asks for this count to survive the repair --
 * "keep the eight-table postcondition even after the command itself is
 * repaired" -- because it is cheap and it is the assertion that would have
 * caught the original defect. Asserted here against the SQL rather than
 * against a database, so it runs in the unit job.
 */
const EXPECTED_TABLES = [
  "account",
  "active_profile_selection",
  "playback_progress",
  "profile",
  /*
   * ADDED BY PL-0723, AND THIS LIST IS MEANT TO BE EDITED EXACTLY HERE.
   * The postcondition is not "there are eight tables"; it is "the migrations
   * create precisely the set somebody reviewed", which is what makes a run
   * that creates NONE -- the defect this file was written for -- impossible
   * to mistake for success. Growing the set is a schema decision, and the
   * moment to ask whether the new table earns its place. Asked and answered:
   * profile_media_preference is keyed by profile_id, cascades from the
   * profile, holds viewer preferences only, carries no capability or
   * entitlement, and is registered in PROFILE_SCOPED_TABLES so the automatic
   * scoping check covers it.
   */
  "profile_media_preference",
  "session",
  "user",
  "verification",
  "watchlist_entry"
] as const;

describe("the migration journal is what makes db:migrate do anything", () => {
  it("exists and is readable, because its absence is a silent no-op", () => {
    expect(() => readJournal()).not.toThrow();
  });

  it("declares the dialect and journal version drizzle-kit expects", () => {
    const journal = readJournal();
    expect(journal.dialect).toBe("postgresql");
    expect(journal.version).toBe("7");
  });

  it("IS NOT EMPTY — an empty journal exits 0 and creates nothing", () => {
    /*
     * THE REGRESSION. Measured on drizzle-kit 0.31.10: with `entries: []` the
     * command prints "migrations applied successfully!", exits 0, and leaves a
     * fresh database with zero relations. That is the reported defect's exact
     * signature, and it is reachable from a journal that exists.
     */
    const journal = readJournal();
    expect(Array.isArray(journal.entries)).toBe(true);
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("names a real SQL file for every entry, and that file changes the schema", () => {
    /*
     * WHAT THIS RULE USED TO SAY AND WHY IT CHANGED (PL-0724). It required
     * `CREATE TABLE` in every migration, which was true of the only two that
     * existed and is not a property of migrations. `0002_profile_diagnostics_
     * preference.sql` adds a column to a table 0001 created, so it is an
     * ALTER and nothing else -- and the rule failed it.
     *
     * The rule is RELAXED IN ONE DIRECTION AND NOT WEAKENED, which is the
     * distinction worth getting right. What it was actually defending against
     * is a journal entry naming a file that does nothing: drizzle-kit reports
     * success over an empty or commentary-only migration, which is the same
     * silent no-op the test above this one exists for. So the requirement is
     * now that the file carries a schema-CHANGING statement, which an ALTER
     * is and a file of comments is not. Accepting `CREATE TABLE` alone would
     * have meant every future column addition had to edit this line, and the
     * edit somebody makes under time pressure is the one that deletes the
     * check.
     *
     * COMMENTS ARE STRIPPED FIRST, because every migration in this repository
     * opens with a prose header explaining itself, and a header mentioning
     * the words "create table" would satisfy a naive match while the file
     * below it did nothing at all.
     */
    const DDL = /\b(create|alter|drop)\s+(table|index|type|schema)\b/i;
    for (const entry of readJournal().entries) {
      const file = join(migrationsDir, `${entry.tag}.sql`);
      const sql = readFileSync(file, "utf8");
      expect(sql.length, `${entry.tag}.sql is empty`).toBeGreaterThan(0);
      const executable = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
      expect(
        executable,
        `${entry.tag}.sql carries no schema-changing statement outside its comments, so the ` +
          `journal names a file whose application would be a silent no-op`
      ).toMatch(DDL);
    }
  });

  it("THAT RULE REFUSES A MIGRATION THAT ONLY TALKS ABOUT CHANGING THE SCHEMA", () => {
    /*
     * NON-VACUITY, and it guards the exact hole the relaxation above could
     * have opened. The rule now accepts more kinds of file than it did, so
     * the thing to prove is that it still rejects the kind it was written
     * for -- including the nastiest version, a file whose PROSE contains the
     * very words being matched.
     */
    const DDL = /\b(create|alter|drop)\s+(table|index|type|schema)\b/i;
    const strip = (sql: string): string =>
      sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

    expect(strip("/* This migration will CREATE TABLE widgets later. */\n")).not.toMatch(DDL);
    expect(strip("-- ALTER TABLE profile ADD COLUMN nickname text;\n")).not.toMatch(DDL);
    expect(strip("\n\n   \n")).not.toMatch(DDL);
    /* And it accepts both real shapes, so it has not become a rule that
     * refuses everything. */
    expect(strip('CREATE TABLE "widget" (id text);')).toMatch(DDL);
    expect(strip('ALTER TABLE "widget" ADD COLUMN "flag" boolean NOT NULL;')).toMatch(DDL);
  });

  it("references every SQL file on disk, so no migration can be orphaned", () => {
    /* The other half of the agreement. A `.sql` file the journal does not
     * mention is a migration that will never run, and nothing else in this
     * repository would notice. */
    const referenced = readJournal()
      .entries.map((entry) => `${entry.tag}.sql`)
      .sort();
    expect(referenced).toEqual(sqlFiles());
  });

  it("numbers its entries from zero without gaps, which is the apply order", () => {
    const entries = readJournal().entries;
    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
  });

  it("carries a snapshot per entry, or the next db:generate duplicates everything", () => {
    /*
     * NOT COSMETIC, AND MEASURED. With the journal present but
     * `meta/0000_snapshot.json` absent, `drizzle-kit generate` has no previous
     * state to diff against, treats the schema as new, and emits a SECOND
     * migration re-creating all eight tables -- observed as
     * `0001_nervous_omega_red.sql`. With the snapshot in place the same command
     * answers "No schema changes, nothing to migrate".
     *
     * `db:check` does NOT catch this: it answered "Everything's fine" with no
     * snapshot present. So this assertion is the only thing standing between a
     * future developer and a duplicate migration.
     */
    const meta = readdirSync(join(migrationsDir, "meta"));
    for (const entry of readJournal().entries) {
      const snapshot = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
      expect(meta, `${snapshot} is missing`).toContain(snapshot);
    }
  });
});

describe("the exact-table-set postcondition, kept after the repair", () => {
  it("creates exactly the tables the identity, playback and preference model needs", () => {
    const sql = sqlFiles()
      .map((name) => readFileSync(join(migrationsDir, name), "utf8"))
      .join("\n");
    const created = [...sql.matchAll(/create table(?:\s+if\s+not\s+exists)?\s+"([^"]+)"/gi)]
      .map((match) => match[1])
      .sort();
    expect(created).toEqual([...EXPECTED_TABLES]);
  });
});
