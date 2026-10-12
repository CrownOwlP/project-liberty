import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FAVOURITES_NOT_IMPLEMENTED,
  PORT_THREW,
  facetIsTrulyEmpty,
  libraryIsFirstRun,
  librarySnapshotStaleness,
  loadProfileLibrary,
  noProfileSnapshot,
  resumePositionFor,
  visibleSnapshot,
  watchlistContentIds,
  type HistoryEntry,
  type LibraryEntry,
  type LibraryFacet,
  type ProfileLibraryPort,
  type ProfileLibrarySnapshot
} from "./profile-library";

/* -------------------------------------------------------------------------
 * The per-profile library model (W132-F)
 *
 * EVERYTHING HERE IS A PURE FUNCTION OR A PORT CALL, which is why this suite
 * can be exhaustive where the component suites cannot: `apps/web` runs Vitest
 * in a `node` environment with no DOM, so logic left inside a `.tsx` is logic
 * no unit test can reach. The whole point of putting the model in a `.ts` is
 * that the rules below are assertions rather than hopes.
 *
 * THE PORT IS A LITERAL, NOT A MOCK FRAMEWORK. Every method is a function this
 * file writes, the same structural-dependency style `profiles-client.ts` uses
 * for `fetch`. A mock would let a test pass while the real shape drifted.
 * ---------------------------------------------------------------------- */

const ENTRY = (contentId: string, addedAt = "2026-01-01T00:00:00.000Z"): LibraryEntry => ({
  contentId,
  addedAt
});

const HISTORY = (
  contentId: string,
  positionSeconds: number | null,
  runtimeSeconds: number | null = 3600
): HistoryEntry => ({
  contentId,
  positionSeconds,
  runtimeSeconds,
  updatedAt: "2026-01-01T00:00:00.000Z"
});

function port(overrides: Partial<ProfileLibraryPort> = {}): ProfileLibraryPort {
  return {
    activeProfileId: () => Promise.resolve("profile-a"),
    watchlist: () => Promise.resolve({ status: "ok", entries: [] }),
    history: () => Promise.resolve({ status: "ok", entries: [] }),
    ...overrides
  };
}

const SNAPSHOT = (
  profileId: string | null,
  watchlist: LibraryFacet<LibraryEntry> = { status: "ok", entries: [] },
  history: LibraryFacet<HistoryEntry> = { status: "ok", entries: [] }
): ProfileLibrarySnapshot => ({
  profileId,
  watchlist,
  favourites: FAVOURITES_NOT_IMPLEMENTED,
  history
});

describe("the port cannot be asked about another profile", () => {
  it("declares no method that takes a profile id", async () => {
    /*
     * PL-0405 RECORDED A FORGEABLE-SCOPE DEFECT AND THIS IS WHERE IT WOULD COME
     * BACK. `listWatchlist(profileId)` is the obvious port signature and it is
     * the one thing this module may not have: an id a caller supplies is a
     * client-held scope. The structural assertion is that the interface's
     * methods take nothing -- a property that is obvious while it is being
     * written and invisible to the next person to add a method.
     */
    const raw = await readFile(new URL("./profile-library.ts", import.meta.url), "utf8");
    /* Comments stripped first: this file's own header discusses the signature
     * it forbids, and a rule its own explanation can fail is not a rule. The
     * pattern `profile-ui.test.tsx` established. */
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    const interfaceStart = source.indexOf("export interface ProfileLibraryPort");
    expect(interfaceStart).toBeGreaterThan(-1);
    const body = source.slice(interfaceStart, source.indexOf("}", interfaceStart));

    /* Every declared method is `() => Promise<...>`: an empty parameter list. */
    const signatures = body.match(/\(\s*[^)]*\)\s*=>/g) ?? [];
    expect(signatures.length).toBeGreaterThan(0);
    for (const signature of signatures) {
      expect(signature, `port methods take no arguments: ${signature}`).toMatch(/\(\s*\)\s*=>/);
    }
    expect(body).not.toMatch(/profileId\s*:/);
  });

  it("imports no database, no persistence package and no request context", async () => {
    /*
     * Workers B, C and D consume this from a card, a rail and a player. An
     * import of `lib/db/request-context` here would make every one of those
     * surfaces statically reach Drizzle and the schema -- the import-graph cost
     * `lib/viewer-preferences.ts` documents refusing to pay.
     */
    const raw = await readFile(new URL("./profile-library.ts", import.meta.url), "utf8");
    const imports = (raw.match(/^import .*$/gm) ?? []).join("\n");
    for (const forbidden of ["@liberty/persistence", "db/request-context", "drizzle", "lib/db"]) {
      expect(imports, `must not import ${forbidden}`).not.toContain(forbidden);
    }
    /* Non-vacuity: a file with no imports at all would pass the rule above. */
    expect(raw).toContain("export interface ProfileLibraryPort");
  });

  it("reads no browser storage, because the server owns the session", async () => {
    const raw = await readFile(new URL("./profile-library.ts", import.meta.url), "utf8");
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "window."]) {
      expect(source, `must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("loadProfileLibrary never throws and never loses a facet", () => {
  it("answers the no-profile snapshot when nobody has chosen", async () => {
    const snapshot = await loadProfileLibrary(port({ activeProfileId: () => Promise.resolve(null) }));
    expect(snapshot).toEqual(noProfileSnapshot());
    expect(snapshot.profileId).toBeNull();
  });

  it("treats an empty-string profile id as no profile", async () => {
    /* A `""` from a half-written adapter would otherwise label a snapshot with
     * an id that can never match anything, so every consumer would see `stale`
     * forever and draw nothing, with no failure anywhere to explain it. */
    const snapshot = await loadProfileLibrary(port({ activeProfileId: () => Promise.resolve("") }));
    expect(snapshot.profileId).toBeNull();
  });

  it("survives a port whose identity read rejects", async () => {
    const snapshot = await loadProfileLibrary(
      port({ activeProfileId: () => Promise.reject(new Error("pool exhausted")) })
    );
    expect(snapshot.profileId).toBeNull();
    expect(snapshot.watchlist).toEqual({ status: "unavailable", reason: PORT_THREW });
    expect(snapshot.history).toEqual({ status: "unavailable", reason: PORT_THREW });
  });

  it("publishes a reason code and never the thrown value's text", async () => {
    /*
     * A repository exception can carry a connection string. Every loader in
     * this application discards the text for that reason, and this asserts the
     * secret cannot appear anywhere in the snapshot -- not just in the field
     * somebody remembered to check.
     */
    const secret = "postgres://liberty:hunter2@localhost:5432/liberty";
    const snapshot = await loadProfileLibrary(
      port({ watchlist: () => Promise.reject(new Error(secret)) })
    );
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
    expect(JSON.stringify(snapshot)).not.toContain("postgres://");
    expect(snapshot.watchlist).toEqual({ status: "unavailable", reason: PORT_THREW });
  });

  it("lets one facet fail without taking the others with it", async () => {
    /*
     * `Promise.all` OVER THE RAW CALLS WOULD FAIL THIS. It rejects on the first
     * rejection, which would discard a watchlist that read perfectly because
     * history did not.
     */
    const snapshot = await loadProfileLibrary(
      port({
        watchlist: () => Promise.resolve({ status: "ok", entries: [ENTRY("film-a")] }),
        history: () => Promise.reject(new Error("timeout"))
      })
    );
    expect(snapshot.watchlist).toEqual({ status: "ok", entries: [ENTRY("film-a")] });
    expect(snapshot.history.status).toBe("unavailable");
  });

  it("treats a port that answered something that is not a facet as a failed read", async () => {
    /*
     * A forgotten `return` in an adapter yields `undefined`, which would reach
     * a consumer as `status === undefined` and fall through every branch to
     * whatever the last `else` rendered -- silently, as a success.
     */
    const broken = {
      activeProfileId: () => Promise.resolve("profile-a"),
      watchlist: (() => Promise.resolve(undefined)) as unknown as ProfileLibraryPort["watchlist"],
      history: (() => Promise.resolve("ok")) as unknown as ProfileLibraryPort["history"]
    };
    const snapshot = await loadProfileLibrary(broken);
    expect(snapshot.watchlist.status).toBe("unavailable");
    expect(snapshot.history.status).toBe("unavailable");
  });

  it("reports favourites as not-implemented rather than as an empty list", async () => {
    /*
     * THERE IS NO FAVOURITES STORAGE IN THIS REPOSITORY. An empty array here
     * would render as "you have no favourites", which is a claim about this
     * viewer that is actually a fact about the schema.
     */
    const snapshot = await loadProfileLibrary(port());
    expect(snapshot.favourites.status).toBe("not-implemented");
    expect(facetIsTrulyEmpty(snapshot.favourites)).toBe(false);
  });

  it("uses a favourites implementation when one is supplied", async () => {
    /* The port is ready for the storage: nothing here has to change when it
     * lands, which is the test that proves the optional method is wired. */
    const snapshot = await loadProfileLibrary(
      port({ favourites: () => Promise.resolve({ status: "ok", entries: [ENTRY("film-b")] }) })
    );
    expect(snapshot.favourites).toEqual({ status: "ok", entries: [ENTRY("film-b")] });
  });
});

describe("switching profile switches all of it", () => {
  it("calls a snapshot from another profile stale", () => {
    /*
     * THE ACCEPTANCE CLAUSE, AS A FUNCTION. Its only enforcement until now was
     * that the picker calls `router.refresh()` -- a rule about one component,
     * remembered. A household seeing a sibling's half-watched episode under
     * their own name is the defect, and this is the question that catches it.
     */
    expect(librarySnapshotStaleness(SNAPSHOT("profile-a"), "profile-b")).toBe("stale");
    expect(librarySnapshotStaleness(SNAPSHOT("profile-a"), "profile-a")).toBe("fresh");
  });

  it("yields nothing visible from a stale snapshot, for every facet at once", () => {
    const stale = SNAPSHOT(
      "profile-a",
      { status: "ok", entries: [ENTRY("film-a")] },
      { status: "ok", entries: [HISTORY("film-a", 120)] }
    );
    expect(visibleSnapshot(stale, "profile-b")).toBeNull();
    expect(visibleSnapshot(stale, "profile-a")).toBe(stale);
  });

  it("distinguishes 'nobody told me' from 'the server says nobody is active'", () => {
    /*
     * `unknown` IS NOT `stale`. Treating a first paint as stale would blank a
     * correct screen every time an unrelated identity read was still in flight;
     * treating it as fresh would draw rows nobody can attribute.
     */
    expect(librarySnapshotStaleness(SNAPSHOT("profile-a"), undefined)).toBe("unknown");
    expect(visibleSnapshot(SNAPSHOT("profile-a"), undefined)).toBeNull();
    expect(librarySnapshotStaleness(SNAPSHOT("profile-a"), null)).toBe("stale");
  });

  it("calls a no-profile snapshot stale once a profile has been chosen", () => {
    expect(librarySnapshotStaleness(noProfileSnapshot(), "profile-a")).toBe("stale");
    expect(librarySnapshotStaleness(noProfileSnapshot(), null)).toBe("fresh");
  });
});

describe("first-run detection is about the viewer, not about the database", () => {
  it("is true only when both real facets were read and were empty", () => {
    expect(libraryIsFirstRun(SNAPSHOT("profile-a"))).toBe(true);
  });

  it("is false when a facet could not be read", () => {
    /*
     * THE DEFECT THIS PREVENTS: showing a household "add your first title"
     * because the database was down. An unreadable list is not an empty one.
     */
    expect(
      libraryIsFirstRun(SNAPSHOT("profile-a", { status: "unavailable", reason: PORT_THREW }))
    ).toBe(false);
    expect(
      libraryIsFirstRun(
        SNAPSHOT("profile-a", { status: "ok", entries: [] }, { status: "unavailable", reason: PORT_THREW })
      )
    ).toBe(false);
  });

  it("is false when either list holds something", () => {
    expect(libraryIsFirstRun(SNAPSHOT("profile-a", { status: "ok", entries: [ENTRY("x")] }))).toBe(
      false
    );
    expect(
      libraryIsFirstRun(
        SNAPSHOT("profile-a", { status: "ok", entries: [] }, { status: "ok", entries: [HISTORY("x", 5)] })
      )
    ).toBe(false);
  });

  it("is not blocked forever by favourites being unimplemented", () => {
    /* Including the `not-implemented` facet would make this answer `false` in
     * every build and the onboarding would never appear -- a feature disabled
     * by an unrelated missing feature. */
    expect(SNAPSHOT("profile-a").favourites.status).toBe("not-implemented");
    expect(libraryIsFirstRun(SNAPSHOT("profile-a"))).toBe(true);
  });

  it("is false with no profile, because there is nobody whose first run it is", () => {
    expect(libraryIsFirstRun(noProfileSnapshot())).toBe(false);
  });
});

describe("watchlistContentIds is the port worker B consumes", () => {
  it("answers the ids in the store's order", () => {
    const snapshot = SNAPSHOT("profile-a", {
      status: "ok",
      entries: [ENTRY("film-b", "2026-02-01T00:00:00.000Z"), ENTRY("film-a")]
    });
    expect(watchlistContentIds(snapshot)).toEqual(["film-b", "film-a"]);
  });

  it("answers null for BOTH failures, never an empty array", () => {
    /*
     * `presenceFromList` reads `null` as "unknown" and `[]` as "off-list". An
     * empty array for a failed read would paint "Add to My List" on a title the
     * viewer's list already holds -- which is the lie `watchlist-state.ts`
     * documents its `unknown` state exists to avoid.
     */
    expect(
      watchlistContentIds(SNAPSHOT("profile-a", { status: "unavailable", reason: PORT_THREW }))
    ).toBeNull();
    expect(
      watchlistContentIds(
        SNAPSHOT("profile-a", { status: "not-implemented", detail: "no storage" })
      )
    ).toBeNull();
  });

  it("answers an empty array for a successful empty read", () => {
    expect(watchlistContentIds(SNAPSHOT("profile-a"))).toEqual([]);
  });
});

describe("resumePositionFor is the port worker D consumes", () => {
  const withHistory = (entries: readonly HistoryEntry[]): ProfileLibrarySnapshot =>
    SNAPSHOT("profile-a", { status: "ok", entries: [] }, { status: "ok", entries });

  it("answers the stored position for a title that has one", () => {
    expect(resumePositionFor(withHistory([HISTORY("film-a", 942)]), "film-a")).toBe(942);
  });

  it("answers null for a title with no row, and for a row with no position", () => {
    expect(resumePositionFor(withHistory([HISTORY("film-a", 942)]), "film-b")).toBeNull();
    expect(resumePositionFor(withHistory([HISTORY("film-a", null)]), "film-a")).toBeNull();
  });

  it("answers null rather than a number a player cannot seek to", () => {
    /*
     * THE SAME DEFECT CLASS `migrateViewerPreferences` REMOVES FOR RATES. The
     * column is nullable and the row may have been written by a build that no
     * longer exists; a `NaN` or a negative reaching `currentTime` is a player
     * that never starts.
     */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "120" as unknown as number]) {
      expect(
        resumePositionFor(withHistory([HISTORY("film-a", bad as number)]), "film-a"),
        String(bad)
      ).toBeNull();
    }
  });

  it("answers null when history could not be read, not 0", () => {
    /* A `0` would be a resume point: it would mean "start from the beginning"
     * by coincidence today and "we know where you were" to anything that tested
     * for a non-null. */
    const snapshot = SNAPSHOT(
      "profile-a",
      { status: "ok", entries: [] },
      { status: "unavailable", reason: PORT_THREW }
    );
    expect(resumePositionFor(snapshot, "film-a")).toBeNull();
  });

  it("accepts a stored 0 as a real position", () => {
    expect(resumePositionFor(withHistory([HISTORY("film-a", 0)]), "film-a")).toBe(0);
  });
});
