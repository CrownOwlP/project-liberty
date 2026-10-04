/* -------------------------------------------------------------------------
 * Reading and writing a profile's media preferences (PL-0723).
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. `repository-scoping.test.ts`
 * already renders every statement these functions build and asserts each one
 * filters or writes `profile_id`; that is the security property and it has its
 * own home. This file is about the one piece of BEHAVIOUR that is easy to get
 * wrong and expensive to get wrong quietly: the difference between a profile
 * that has never chosen anything and a profile whose viewer deliberately chose
 * nothing.
 *
 * No database, and none would help. The question is what these functions
 * return for a given row and what they put in a row for a given input; a live
 * PostgreSQL would answer that too, slower, and only for whatever happened to
 * be in the table. The migration itself WAS applied to a real database and the
 * ordering and cascade verified there -- that evidence is in the task's gate,
 * because it is a fact about the schema rather than about this module.
 * ---------------------------------------------------------------------- */
import { authorizeProfileAccess, type ProfileScope } from "@liberty/auth";
import { NO_MEDIA_PREFERENCES } from "@liberty/contracts/domains/preferences";
import { describe, expect, it } from "vitest";

import type { LibertyDatabase } from "./client";
import {
  forgetMediaPreferences,
  readMediaPreferences,
  writeMediaPreferences
} from "./profile-preferences";

/**
 * A scope, obtained the only way a scope can legitimately be obtained.
 *
 * The same fixture `repository-scoping.test.ts` uses, and for the reason it
 * records: `ProfileScope`'s brand is a runtime fact held in a WeakSet inside
 * `@liberty/auth`, so a cast literal is refused -- and a test that built the
 * capability by hand would be testing against a state the system cannot
 * produce.
 */
function issuedScope(profileId: string, ownerUserId: string): ProfileScope {
  const decision = authorizeProfileAccess({
    session: {
      account: { userId: ownerUserId, sessionId: `session_${ownerUserId}` },
      activeProfileId: profileId
    },
    requestedProfileId: profileId,
    ownership: { profileId, ownerUserId, archivedAt: null }
  });
  if (!decision.allowed) throw new Error(`fixture is wrong: ${decision.reason}`);
  return decision.scope;
}

const scope = issuedScope("profile_ada", "user_household");
const INSTANT = new Date("2026-10-04T03:00:00.000Z");

/** Records what was written and answers reads with `rows`. */
function fakeDb(rows: readonly unknown[], captured: Record<string, unknown>[] = []) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => void) => resolve([...rows]);
        }
        if (typeof property === "symbol") return undefined;
        const method: string = property;
        return (...args: unknown[]) => {
          if (method === "values") captured.push(args[0] as Record<string, unknown>);
          return chain;
        };
      }
    }
  );
  return { db: chain as LibertyDatabase, captured };
}

const storedRow = {
  profileId: "profile_ada",
  preferredAudioLanguages: ["ja", "de", "en"],
  preferredSubtitleLanguages: ["pt-BR", "en"],
  subtitleMode: "off",
  hearingImpaired: true,
  playbackDiagnostics: false,
  updatedAt: INSTANT
};

describe("a profile that has never chosen anything", () => {
  it("IS NOT THE SAME AS ONE THAT CHOSE NOTHING, which is the whole point", () => {
    /*
     * The distinction this table exists to carry. A profile that has never
     * opened the settings screen has expressed no opinion and the player
     * should keep doing what it did before; a viewer who cleared the list has
     * said "do not prefer any language for me" and the player must honour it.
     * Collapsing the two would quietly overrule the second viewer.
     */
    expect(NO_MEDIA_PREFERENCES.preferredAudioLanguages).toEqual([]);
    /* Same values, different answers to "has anybody chosen?". */
    expect({ stored: false, preferences: NO_MEDIA_PREFERENCES }).not.toEqual({
      stored: true,
      preferences: NO_MEDIA_PREFERENCES
    });
  });

  it("reads as the neutral value with stored false, rather than throwing", async () => {
    /* Absence is the normal case -- it is every profile until somebody opens
     * the screen -- so it is data, not an error. */
    const { db } = fakeDb([]);
    await expect(readMediaPreferences(db, { scope })).resolves.toEqual({
      stored: false,
      preferences: NO_MEDIA_PREFERENCES
    });
  });
});

describe("reading a profile that has chosen", () => {
  it("returns what was stored, with stored true", async () => {
    const { db } = fakeDb([storedRow]);
    await expect(readMediaPreferences(db, { scope })).resolves.toEqual({
      stored: true,
      preferences: {
        preferredAudioLanguages: ["ja", "de", "en"],
        preferredSubtitleLanguages: ["pt-BR", "en"],
        subtitleMode: "off",
        hearingImpaired: true,
        playbackDiagnostics: false
      }
    });
  });

  it("PRESERVES ORDER, because order is the only information the list carries", async () => {
    const { db } = fakeDb([storedRow]);
    const read = await readMediaPreferences(db, { scope });
    expect(read.preferences.preferredAudioLanguages).toEqual(["ja", "de", "en"]);
  });

  it("hands back a COPY, so a caller cannot mutate the result set", async () => {
    /* The driver returns a fresh array per row today. A caller that sorted
     * what it was given in place would be sorting a result set, and the
     * ordering is the only thing these arrays carry. */
    const { db } = fakeDb([storedRow]);
    const read = await readMediaPreferences(db, { scope });
    read.preferences.preferredAudioLanguages.reverse();
    expect(storedRow.preferredAudioLanguages).toEqual(["ja", "de", "en"]);
  });

  it("does not rewrite a mode it does not recognise", async () => {
    /*
     * The column is text and the contract owns the value set, so an older
     * build could in principle have written a mode this one does not know.
     * Returning it as-is means the HTTP boundary refuses it by name; coercing
     * it to "auto" here would tell the viewer their choice was honoured when
     * it had been replaced.
     */
    const { db } = fakeDb([{ ...storedRow, subtitleMode: "sometimes" }]);
    const read = await readMediaPreferences(db, { scope });
    expect(read.preferences.subtitleMode).toBe("sometimes");
  });
});

describe("writing", () => {
  it("stores every field, keyed to the scope's profile and nothing else", async () => {
    const { db, captured } = fakeDb([storedRow]);
    await writeMediaPreferences(db, {
      scope,
      preferences: {
        preferredAudioLanguages: ["ja", "en"],
        preferredSubtitleLanguages: [],
        subtitleMode: "auto",
        hearingImpaired: false,
        playbackDiagnostics: true
      },
      instant: INSTANT
    });
    expect(captured[0]).toEqual({
      profileId: "profile_ada",
      preferredAudioLanguages: ["ja", "en"],
      preferredSubtitleLanguages: [],
      subtitleMode: "auto",
      hearingImpaired: false,
      playbackDiagnostics: true,
      updatedAt: INSTANT
    });
  });

  it("REPORTS WHAT THE DATABASE HAS, not what it was asked for", async () => {
    /*
     * Echoing the input would make a write that silently did nothing look
     * identical to one that worked, which is the failure a settings screen
     * would show as "saved".
     */
    const { db } = fakeDb([storedRow]);
    const written = await writeMediaPreferences(db, {
      scope,
      preferences: {
        preferredAudioLanguages: ["fr"],
        preferredSubtitleLanguages: ["fr"],
        subtitleMode: "auto",
        hearingImpaired: false,
        playbackDiagnostics: true
      },
      instant: INSTANT
    });
    expect(written.preferences.preferredAudioLanguages).toEqual(["ja", "de", "en"]);
    expect(written.stored).toBe(true);
  });

  it("REFUSES TO REPORT SUCCESS WHEN THE UPSERT RETURNED NOTHING", async () => {
    /* An insert with onConflictDoUpdate always returns a row, so no row means
     * the statement did not execute as written -- and nothing should reach a
     * viewer as saved. */
    const { db } = fakeDb([]);
    await expect(
      writeMediaPreferences(db, {
        scope,
        preferences: NO_MEDIA_PREFERENCES,
        instant: INSTANT
      })
    ).rejects.toThrow(/returned no row/);
  });

  it("writes a copy of the caller's arrays", async () => {
    const languages = ["ja", "en"];
    const { db, captured } = fakeDb([storedRow]);
    await writeMediaPreferences(db, {
      scope,
      preferences: { ...NO_MEDIA_PREFERENCES, preferredAudioLanguages: languages },
      instant: INSTANT
    });
    languages.push("de");
    expect(captured[0]?.["preferredAudioLanguages"]).toEqual(["ja", "en"]);
  });
});

describe("forgetting", () => {
  it("deletes the row rather than storing empty lists", async () => {
    /*
     * "Reset to no opinion" and "prefer nothing" are the two answers this
     * module exists to keep apart, and a reset that wrote empty lists would
     * take away the viewer's ability to express the second. The statement
     * itself is checked by repository-scoping.test.ts; what is checked here
     * is that nothing is VALUED -- a delete that wrote a row would show up
     * as a captured values call.
     */
    const { db, captured } = fakeDb([]);
    await forgetMediaPreferences(db, { scope });
    expect(captured).toEqual([]);
  });

  it("is idempotent, so a second click is not an error", async () => {
    const { db } = fakeDb([]);
    await expect(forgetMediaPreferences(db, { scope })).resolves.toBeUndefined();
    await expect(forgetMediaPreferences(db, { scope })).resolves.toBeUndefined();
  });
});
