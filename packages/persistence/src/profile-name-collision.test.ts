import type { LibertySession } from "@liberty/auth";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LibertyDatabase } from "./client";
import { createProfile } from "./profile-repository";
import { PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT, profile } from "./schema";

/**
 * A second "Dad" is a refusal, not a stack trace (PL-0402).
 *
 * `profile` carries `UNIQUE (user_id, display_name)` and `createProfile`
 * normalises the name so that the constraint means something. What it did not
 * have was an ANSWER for the constraint firing: the second "Dad" arrived as a
 * raw driver exception from an unattributable stack depth -- the exact failure
 * `profile-repository.ts` criticises elsewhere, where a composite foreign key
 * "would catch it, as a driver exception at an unattributable stack depth".
 *
 * WHAT THESE TESTS ARE REALLY ABOUT: the MATCH. A translation that fires on the
 * wrong errors is worse than none, and a translation that quietly stops firing
 * is worse still, because the refusal disappears while the test stays green. So
 * the cases below are mostly negative -- the errors that must travel through
 * untouched -- and the positive ones are shaped like the errors the real stack
 * produces rather than like the errors the check happens to look for.
 *
 * NO DATABASE, AND NONE WOULD HELP HERE. A live PostgreSQL would prove that a
 * duplicate insert raises `23505`, which is not in doubt; what is in doubt is
 * whether this package RECOGNISES it after Drizzle has wrapped it, and that is
 * a question about our code.
 *
 * WHAT THIS FILE CANNOT PROVE, STATED PLAINLY. The error objects below are built
 * BY HAND to the shape `pg` and `drizzle-orm@0.45.2` produce; nothing here
 * observes the real driver, so if that shape is wrong these tests are green and
 * wrong together. The shape was read out of `pg-core/session.js`, where
 * `queryWithCache` rethrows `new DrizzleQueryError(query, params, e)`, and out
 * of node-postgres's `DatabaseError`, which carries `code` and `constraint`.
 * The mitigation is not another assertion, it is the SHAPE OF THE MATCH: the
 * unwrapping walks a cause chain and accepts a hit at any depth, so a Drizzle
 * that stops wrapping is the `bare driver error` case below rather than a
 * regression, and only a change to `code`/`constraint` themselves would defeat
 * it. That would be a `pg` major, which is a reviewed event.
 */

const HOUSEHOLD = "user_household";

const session: LibertySession = {
  account: { userId: HOUSEHOLD, sessionId: "session_tv_lounge" },
  activeProfileId: null
};

const INSTANT = new Date("2026-08-21T20:00:00.000Z");

interface Recorded {
  readonly calls: string[];
  readonly values: Record<string, unknown>[];
}

const emptyRecording = (): Recorded => ({ calls: [], values: [] });

/**
 * A Drizzle stand-in whose COUNT succeeds and whose INSERT throws.
 *
 * The same `Proxy` idea as `repository-scoping.test.ts`, with one addition: the
 * thenable rejects once `insert` has been seen. `createProfile` awaits the count
 * before it builds the insert, so "insert has been called" is an exact test for
 * "this await is the insert" without the fake having to model statement
 * boundaries.
 */
function dbFailingTheInsert(recorded: Recorded, error: unknown): LibertyDatabase {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => void, reject: (reason?: unknown) => void) => {
            if (recorded.calls.includes("insert")) {
              reject(error);
              return;
            }
            // The shape `countLiveProfilesForAccount` reads: `rows[0]?.value`.
            resolve([{ value: 0 }]);
          };
        }
        if (typeof property === "symbol") return undefined;
        const method: string = property;

        return (...args: unknown[]) => {
          recorded.calls.push(method);
          if (method === "values") recorded.values.push(args[0] as Record<string, unknown>);
          return chain;
        };
      }
    }
  );

  // The cast that `repository-scoping.test.ts` explains: `LibertyDatabase` is a
  // driver-bound type and this object executes nothing.
  return chain as LibertyDatabase;
}

/**
 * A `pg` `DatabaseError`, as node-postgres actually shapes one.
 *
 * The SQLSTATE is on `code` and the constraint name is on `constraint`, both
 * populated from the server's error fields. The MESSAGE is deliberately the
 * real English one, so that a check written against the message would pass
 * every positive test here and be caught only by `does not match on the message`
 * below.
 */
function driverError(code: string, constraint?: string): Error {
  const error: Error & { code?: string; constraint?: string } = new Error(
    'duplicate key value violates unique constraint "profile_user_id_display_name_key"'
  );
  error.code = code;
  if (constraint !== undefined) error.constraint = constraint;
  return error;
}

/**
 * Drizzle's wrapper, as `drizzle-orm@0.45.2` builds it.
 *
 * `pg-core/session.js` catches every driver exception and rethrows
 * `new DrizzleQueryError(queryString, params, e)`. The SQLSTATE is therefore NOT
 * on the error a repository catches; it is one `cause` deeper. A `DrizzleQueryError`
 * is not imported here on purpose -- the check under test is structural, and
 * building the wrapper by hand is what makes it a test of the shape rather than
 * of an `instanceof`.
 */
function wrapped(cause: unknown): Error {
  return new Error("Failed query: insert into \"profile\" ...", { cause });
}

const attempt = (error: unknown, displayName = "Dad", into: Recorded = emptyRecording()) =>
  createProfile(dbFailingTheInsert(into, error), {
    session,
    displayName,
    avatarKey: null,
    maxRating: null,
    instant: INSTANT
  });

describe("the constraint name the match depends on", () => {
  it("is the one the schema actually declares, on the columns it claims", () => {
    // The whole translation rests on this one string. Read back off the real
    // Drizzle table object -- the same object `drizzle-kit generate` reads -- so
    // that a constraint renamed in the schema fails HERE rather than by the
    // refusal quietly never firing again. That is the failure mode a string
    // literal in two files has, and it is silent in every other test.
    const constraint = getTableConfig(profile).uniqueConstraints.find(
      (entry) => entry.name === PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT
    );

    expect(constraint).toBeDefined();
    expect(constraint?.columns.map((column) => column.name)).toEqual([
      "user_id",
      "display_name"
    ]);
  });

  it("is not the other unique constraint on the same table", () => {
    // `profile_id_user_id_key` exists so other tables can carry a composite
    // foreign key, and it is violated by the same INSERT. The match has to tell
    // the two apart, so they had better not be one name.
    const names = getTableConfig(profile).uniqueConstraints.map((entry) => entry.name);

    expect(names).toContain(PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT);
    expect(names).toContain("profile_id_user_id_key");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("a display name that is already used", () => {
  it("is a refusal with a reason, not a driver exception", async () => {
    const result = await attempt(wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT)));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("display_name_already_used");
  });

  it("names the profile that would have been created, in its stored spelling", async () => {
    // The NORMALISED name, because that is the value the constraint compared.
    // Echoing the submission would print "  Dad  " and send the account holder
    // looking for a profile whose name has spaces in it.
    const result = await attempt(
      wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT)),
      "  Dad  "
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('"Dad"');
    expect(result.detail).not.toContain('"  Dad  "');
  });

  it("says that an archived profile counts, because that is the case nobody can see", async () => {
    // The constraint deliberately spans archived rows, so "that name is in use"
    // can be true while the picker shows nothing of the sort. A refusal that did
    // not say so is unanswerable.
    const result = await attempt(wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT)));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("archived");
  });

  it("does not put an account identifier in the refusal", async () => {
    // The collision is necessarily within one account, so there is no other
    // household to leak -- but the detail is still a support-facing string and
    // an id in it is an id in a log line that did not need one.
    const result = await attempt(wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT)));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain(HOUSEHOLD);
  });

  it("attempts the insert exactly once and does not retry", async () => {
    // A retry would be a second row attempt against a constraint that has
    // already answered, and a duplicate write is the one thing a refusal on a
    // uniqueness violation must not turn into.
    const recorded = emptyRecording();
    await attempt(wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT)), "Dad", recorded);

    expect(recorded.calls.filter((call) => call === "insert")).toHaveLength(1);
    expect(recorded.values).toHaveLength(1);
  });
});

describe("where the SQLSTATE is looked for", () => {
  it("finds it through Drizzle's wrapper, where the real one arrives", async () => {
    // The defect the obvious implementation has. `drizzle-orm@0.45.2` wraps every
    // driver exception in a `DrizzleQueryError`, so `error.code === "23505"` on
    // the caught error is a check that never once fires.
    const outer = wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT));

    // The premise of this test, checked rather than assumed: the fixture really
    // does hide the SQLSTATE one level down. Without this, `wrapped` could be
    // quietly changed to copy `code` outward and the test below would keep
    // passing while proving nothing about the unwrapping.
    expect(Object.hasOwn(outer, "code")).toBe(false);
    expect(outer.cause).toBeDefined();

    const result = await attempt(outer);
    expect(result.ok).toBe(false);
  });

  it("finds it on a bare driver error too, in case the wrapping ever goes away", async () => {
    const result = await attempt(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("display_name_already_used");
  });

  it("finds it through more than one layer of wrapping", async () => {
    const result = await attempt(
      wrapped(wrapped(driverError("23505", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT)))
    );

    expect(result.ok).toBe(false);
  });

  it("terminates on a cause chain that points at itself", async () => {
    // `cause` is a caller-populated field and nothing prevents a cycle. An error
    // handler that hangs is a worse failure than the one it was translating, so
    // the walk is bounded; this is the assertion that it is.
    // `Error.cause` is `unknown` in the ES2022 lib, so no cast is needed to
    // build this -- which is also why a real driver could hand one over.
    const cyclic = new Error("a cause that loops");
    cyclic.cause = cyclic;

    await expect(attempt(cyclic)).rejects.toBe(cyclic);
  });
});

describe("errors that must travel through untouched", () => {
  it("rethrows a unique violation on a DIFFERENT constraint", async () => {
    // `profile_id_user_id_key` and the primary key on `id` are violated by the
    // same INSERT, and a violation of either means `newProfileId` produced a
    // colliding UUID. Reporting that as "the name is taken" would send an
    // account holder to rename a profile in response to a bug in the id
    // generator, and would bury the only evidence of it.
    const error = wrapped(driverError("23505", "profile_id_user_id_key"));

    await expect(attempt(error)).rejects.toBe(error);
  });

  it("rethrows a different SQLSTATE on the right constraint name", async () => {
    // `23503` is foreign_key_violation. The constraint name alone is not the
    // match; both halves have to agree, or a `user_id` pointing at a deleted
    // account would be reported as a duplicate name.
    const error = wrapped(driverError("23503", PROFILE_DISPLAY_NAME_UNIQUE_CONSTRAINT));

    await expect(attempt(error)).rejects.toBe(error);
  });

  it("rethrows a unique violation whose constraint name was not reported", async () => {
    // Some poolers and older servers do not forward the constraint field. There
    // is then no way to tell which of the table's three unique constraints
    // fired, so the honest answer is the one that was there before this
    // translation existed: fail loudly.
    const error = wrapped(driverError("23505"));

    await expect(attempt(error)).rejects.toBe(error);
  });

  it("does not match on the message, which is the field a driver upgrade rewords", async () => {
    // The message of every `driverError` above already names the constraint, so
    // a check written against the message would have passed every positive test
    // in this file. This is the case that separates them: the right words, no
    // SQLSTATE.
    const error = wrapped(
      new Error('duplicate key value violates unique constraint "profile_user_id_display_name_key"')
    );

    await expect(attempt(error)).rejects.toBe(error);
  });

  it("rethrows something that is not an error object at all", async () => {
    // `throw "string"` is legal JavaScript and a driver is not obliged to be
    // reasonable. The walk must not assume it was handed an object.
    await expect(attempt("not an error")).rejects.toBe("not an error");
  });
});
