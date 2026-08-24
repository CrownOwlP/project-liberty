import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { PROFILE_SCOPED_TABLES, playbackProgress, watchlistEntry } from "./schema";

/**
 * Profile scoping, checked against the schema itself (PL-0402/0403/0404).
 *
 * `docs/RESEARCH_IDENTITY.md` calls profile scoping the decision that is
 * expensive to reverse and requires it in the FIRST migration. That is a claim
 * about the schema, so it is tested against the schema -- `getTableConfig` reads
 * the real Drizzle table objects that `drizzle-kit generate` reads, so a table
 * that passes here is a table that will be generated with these columns.
 *
 * No database is required and none would help: the question is what the schema
 * SAYS, not what a particular instance currently contains.
 *
 * The test iterates `PROFILE_SCOPED_TABLES` rather than an enumerated list, so a
 * table added to that constant is checked automatically. The constant itself is
 * the reviewed answer to "which tables carry viewing behaviour", and adding one
 * is the moment to ask the question again.
 */

describe("every profile-scoped table", () => {
  const entries = Object.entries(PROFILE_SCOPED_TABLES);

  it("is a non-empty set, so this file cannot pass vacuously", () => {
    // A guard against the failure where somebody empties the constant and every
    // assertion below silently becomes true.
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s is keyed by profile_id first", (_name, table) => {
    const config = getTableConfig(table);
    const primaryKey = config.primaryKeys[0];

    expect(primaryKey).toBeDefined();
    const columns = primaryKey?.columns.map((column) => column.name) ?? [];
    // LEADING, not merely present. A `profile_id` that is the second column of
    // the key leaves the index unusable for "everything this profile watched",
    // which is the only list query these tables serve.
    expect(columns[0]).toBe("profile_id");
  });

  it.each(entries)("%s makes profile_id NOT NULL", (_name, table) => {
    const column = getTableConfig(table).columns.find((entry) => entry.name === "profile_id");
    expect(column?.notNull).toBe(true);
  });

  it.each(entries)("%s has no user_id column at all", (_name, table) => {
    const names = getTableConfig(table).columns.map((column) => column.name);
    // The invariant stated negatively, which is the version that catches the
    // real regression: somebody adding `user_id` "for convenience" reintroduces
    // exactly the account-scoped shape the ruling forbids, and a positive
    // profile_id check would not notice.
    expect(names).not.toContain("user_id");
  });

  it.each(entries)("%s cascades from the profile it is scoped to", (_name, table) => {
    const toProfile = getTableConfig(table).foreignKeys.find((key) =>
      key.reference().columns.some((column) => column.name === "profile_id")
    );

    expect(toProfile).toBeDefined();
    // An orphaned progress row is personal data with no controller and no way
    // to reach the person it describes.
    expect(toProfile?.onDelete).toBe("cascade");
  });
});

describe("the two viewer-state tables specifically", () => {
  it("key progress by (profile_id, content_id), which is what makes a write an upsert", () => {
    const key = getTableConfig(playbackProgress).primaryKeys[0];
    expect(key?.columns.map((column) => column.name)).toEqual(["profile_id", "content_id"]);
  });

  it("key the watchlist by (profile_id, content_id), which is what makes add idempotent", () => {
    const key = getTableConfig(watchlistEntry).primaryKeys[0];
    expect(key?.columns.map((column) => column.name)).toEqual(["profile_id", "content_id"]);
  });

  it("carry the server-issued writer epoch on the progress row", () => {
    const names = getTableConfig(playbackProgress).columns.map((column) => column.name);
    // All three, because the epoch alone is guessable, and the epoch pair alone
    // cannot order two packets from the same device.
    expect(names).toEqual(expect.arrayContaining(["writer_epoch", "writer_id", "write_seq"]));
  });

  it("offer the progress row nowhere to store a client-supplied timestamp", () => {
    const names = getTableConfig(playbackProgress).columns.map((column) => column.name);
    // `updated_at` is written by the server from an explicit instant. There is
    // no `client_time`, and there must not be one: a column is an invitation,
    // and the rejected design returns the moment somebody accepts it.
    expect(names.filter((name) => name.includes("client"))).toEqual([]);
  });
});
