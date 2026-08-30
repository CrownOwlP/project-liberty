import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  parseContentId,
  parseListLimit,
  playbackProgressRowSchema,
  profileRowSchema,
  watchlistEntryRowSchema
} from "./contracts";
import { playbackProgress, profile, watchlistEntry } from "./schema";

/**
 * Schema/zod agreement, and the contracts boundary.
 *
 * Two claims are tested, and they are different claims:
 *
 *   1. DERIVED, NOT DUPLICATED. The zod row schemas come from the Drizzle
 *      tables, so their keys must be exactly the table's columns. If somebody
 *      ever replaces a derivation with a hand-written schema "just for this
 *      one", the key sets drift and this fails -- which is the whole reason the
 *      house rule exists.
 *
 *   2. ONE OWNER PER RULE. `@liberty/contracts` owns what a normalized content
 *      id is. `parseContentId` calls it rather than re-implementing it, so the
 *      pattern appears exactly once in the repository. The cases below are the
 *      ones a persistence layer would otherwise get wrong on its own: a
 *      `text` column happily stores `"The Northstar Affair"` next to
 *      `"the-northstar-affair"` and makes one work look like two.
 *
 * `drizzle-zod@0.8.3` emits zod v4 schemas while `@liberty/contracts` is zod v3
 * classic; see the header of `contracts.ts`. That is why this file compares KEY
 * SETS rather than trying to unify the two schema objects -- unifying them is
 * the thing that does not work, and pretending otherwise in a test would be a
 * test of a fiction.
 */

const columnNames = (table: Parameters<typeof getTableConfig>[0]): readonly string[] =>
  getTableConfig(table)
    .columns.map((column) => column.name)
    .sort();

describe("row schemas are derived from the tables", () => {
  it.each([
    ["profile", profileRowSchema, profile],
    ["playbackProgress", playbackProgressRowSchema, playbackProgress],
    ["watchlistEntry", watchlistEntryRowSchema, watchlistEntry]
  ] as const)("%s has one zod key per table column", (_name, schema, table) => {
    // The count, not the names: drizzle-zod keys by the TypeScript property
    // name and the table config reports the SQL column name, and those differ
    // by design (`positionSeconds` / `position_seconds`). The invariant that
    // survives the difference is that neither side has a field the other lacks.
    const columns = columnNames(table);
    expect(columns.length).toBeGreaterThan(0);
    expect(Object.keys(schema.shape).length).toBe(columns.length);
  });
});

describe("parseContentId defers to @liberty/contracts", () => {
  it.each([
    "the-northstar-affair",
    "a",
    "episode-2",
    "the-northstar-affair-s01e01"
  ])("accepts the normalized id %s", (value) => {
    const parsed = parseContentId(value);
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["a display title with spaces and capitals", "The Northstar Affair"],
    ["an id with a slash, which would break /title/<id>", "movies/northstar"],
    ["a leading hyphen", "-northstar"],
    ["a trailing hyphen", "northstar-"],
    ["a double hyphen", "north--star"],
    ["an empty string", ""],
    ["an underscore", "north_star"]
  ])("refuses %s", (_name, value) => {
    const parsed = parseContentId(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("not_a_normalized_content_id");
    // The rejection explains itself. A repository that returns "invalid" with
    // no detail forces the caller to guess which of seven rules was broken.
    expect(parsed.detail.length).toBeGreaterThan(0);
  });

  it("refuses values that are not strings at all", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(parseContentId(value).ok).toBe(false);
    }
  });

  it("is deterministic", () => {
    expect(parseContentId("the-northstar-affair")).toEqual(parseContentId("the-northstar-affair"));
  });
});

describe("parseListLimit", () => {
  it.each([0, 1, 20, 1000])("accepts the page size %s", (value) => {
    const parsed = parseListLimit(value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.limit).toBe(value);
  });

  it.each([
    ["NaN, which is what `Number(\"abc\")` gives a query string", Number.NaN],
    ["a negative limit, which PostgreSQL refuses outright", -1],
    ["a fractional limit", 2.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an integer too large to survive the driver", Number.MAX_SAFE_INTEGER + 2]
  ])("refuses %s", (_name, value) => {
    const parsed = parseListLimit(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("limit_not_representable");
    // Named and explained, because the alternative is a driver exception that
    // mentions neither the caller nor the parameter -- `LIMIT NaN` reaches
    // PostgreSQL as a syntax error and arrives as a 500 with no reason trail.
    expect(parsed.detail).toContain("limit");
  });

  it("accepts zero rather than inventing a minimum page size", () => {
    // `LIMIT 0` is legal SQL that returns nothing, and it is the natural result
    // of a paginator that has run out of page. Refusing it would be this module
    // inventing a product rule nobody asked it for.
    expect(parseListLimit(0).ok).toBe(true);
  });
});
