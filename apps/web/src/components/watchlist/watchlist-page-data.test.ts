import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { WatchlistEntryRow } from "@liberty/persistence";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* -------------------------------------------------------------------------
 * What /watchlist is given (PW-0304)
 *
 * TWO LAYERS, AND THE SECOND ONE IS WHY THIS FILE MOCKS ANYTHING AT ALL.
 *
 * `selectWatchlistPage` is pure and is tested directly. `loadWatchlistPage` is
 * not: it reaches the identity store, the repository and the catalog metadata
 * source, none of which exists in a `node` vitest process. What it decides,
 * though, is the thing most worth pinning -- the FOUR branches, and in
 * particular that `no_active_profile_selected` is its own answer rather than a
 * failure. That distinction is a product decision (a viewer who has not chosen
 * a profile is one click from the fix, and gets a link to `/profiles` instead
 * of an error panel), it is invisible to a type checker, and the e2e layer
 * cannot reach it cheaply because it would need a session with an account and
 * no selection.
 *
 * SO THE THREE SEAMS ARE MOCKED AND NOTHING ELSE IS. Every branch below is the
 * module's own code running against a stated input; no assertion here is about
 * the mock.
 * ---------------------------------------------------------------------- */

const resolveRequestContext = vi.fn();
const resolveActiveProfileScope = vi.fn();
const resolveCatalogMetadataSource = vi.fn();

vi.mock("../../lib/db/request-context", () => ({
  resolveRequestContext: (...args: unknown[]) => resolveRequestContext(...args),
  resolveActiveProfileScope: (...args: unknown[]) => resolveActiveProfileScope(...args)
}));

vi.mock("../../lib/catalog-source-registry", () => ({
  resolveCatalogMetadataSource: (...args: unknown[]) => resolveCatalogMetadataSource(...args)
}));

const {
  WATCHLIST_PAGE_QUERY_LIMIT,
  loadWatchlistPage,
  selectWatchlistPage
} = await import("./watchlist-page-data");

function item(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: `Title ${id}`,
    kind: "movie",
    /* `isSurfaceable` gates on this, so a fixture with the wrong value would
     * make every "the catalog named it" assertion below pass for the wrong
     * reason -- as the first draft of this file did. */
    rights: "owned",
    genre: "Science fiction",
    releaseYear: 2024,
    runtimeMinutes: 100,
    episodeCount: null,
    ...over
  } as CatalogItem;
}

function row(contentId: string, addedAt: string): WatchlistEntryRow {
  return { profileId: "profile-1", contentId, addedAt: new Date(addedAt) };
}

/* -------------------------------------------------------------------------
 * The pure half
 * ---------------------------------------------------------------------- */

describe("selectWatchlistPage", () => {
  it("keeps the store's order and does not re-sort", () => {
    /*
     * The ids are deliberately NOT in alphabetical order and the dates are
     * deliberately NOT in the order the rows are in, so a function that sorted
     * by either one would produce a different array than this assertion.
     */
    const rows = [
      row("zulu", "2026-01-01T00:00:00.000Z"),
      row("alpha", "2026-09-01T00:00:00.000Z"),
      row("mike", "2026-05-01T00:00:00.000Z")
    ];
    const entries = selectWatchlistPage(rows, () => null);
    expect(entries.map((entry) => entry.contentId)).toEqual(["zulu", "alpha", "mike"]);
  });

  it("publishes addedAt as an ISO instant", () => {
    const entries = selectWatchlistPage([row("alpha", "2026-09-30T22:15:00.000Z")], () => null);
    expect(entries.at(0)?.addedAt).toBe("2026-09-30T22:15:00.000Z");
  });

  it("carries the resolved item when the catalog names the title", () => {
    const entries = selectWatchlistPage([row("alpha", "2026-01-01T00:00:00.000Z")], (id) =>
      id === "alpha" ? item("alpha") : null
    );
    expect(entries.at(0)?.item?.title).toBe("Title alpha");
  });

  it("KEEPS an entry the catalog will not name, rather than dropping it", () => {
    /*
     * THE DIFFERENCE FROM THE CONTINUE-WATCHING RAIL, asserted rather than
     * described. `selectContinueWatching` drops such a row -- correctly, there
     * is nothing to put in the slot. Dropping it HERE would give a household a
     * list shorter than their list, with no way to remove the row that is not
     * being shown. The entry survives with `item: null` and the page renders it
     * by its identifier.
     */
    const entries = selectWatchlistPage(
      [row("alpha", "2026-01-01T00:00:00.000Z"), row("withheld", "2026-01-02T00:00:00.000Z")],
      (id) => (id === "alpha" ? item("alpha") : null)
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ contentId: "withheld", item: null });
  });
});

/* -------------------------------------------------------------------------
 * The four branches
 * ---------------------------------------------------------------------- */

const SCOPE = { profileId: "profile-1" };

function repositoryAnswering(result: unknown) {
  return { listWatchlist: vi.fn().mockResolvedValue(result) };
}

function contextWith(repository: unknown) {
  return { ok: true, context: { repository } };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveCatalogMetadataSource.mockReturnValue({
    status: "not-configured",
    reason: "no_metadata_source_configured",
    detail: null
  });
});

describe("loadWatchlistPage", () => {
  it("reports the context refusal's first code when there is no request context", async () => {
    resolveRequestContext.mockResolvedValue({
      ok: false,
      reasons: [{ code: "storage_not_configured", detail: "no DATABASE_URL" }]
    });

    await expect(loadWatchlistPage(new Headers())).resolves.toEqual({
      status: "unavailable",
      reason: "storage_not_configured"
    });
  });

  it("answers `no-profile` -- NOT `unavailable` -- when nobody has been chosen", async () => {
    /*
     * The assertion this whole mocked layer exists for. `no_active_profile_selected`
     * is the one refusal on this path that is not a fault of any kind, and the
     * page turns it into a link to `/profiles`. A regression that folded it
     * into the generic branch would be invisible to the type checker and would
     * hand somebody a dead end one click from the fix.
     */
    resolveRequestContext.mockResolvedValue(contextWith(repositoryAnswering([])));
    resolveActiveProfileScope.mockResolvedValue({
      allowed: false,
      reason: "no_active_profile_selected"
    });

    await expect(loadWatchlistPage(new Headers())).resolves.toEqual({ status: "no-profile" });
  });

  it("keeps every OTHER access denial in the unavailable branch", async () => {
    /* The non-vacuity check for the test above: the branch is selected by the
     * reason code, not by `allowed` being false. */
    resolveRequestContext.mockResolvedValue(contextWith(repositoryAnswering([])));
    resolveActiveProfileScope.mockResolvedValue({
      allowed: false,
      reason: "profile_archived"
    });

    await expect(loadWatchlistPage(new Headers())).resolves.toEqual({
      status: "unavailable",
      reason: "profile_archived"
    });
  });

  it("reports a limit refusal rather than rendering an empty list", async () => {
    resolveRequestContext.mockResolvedValue(
      contextWith(
        repositoryAnswering({ reason: "limit_exceeds_page_maximum", detail: "too many" })
      )
    );
    resolveActiveProfileScope.mockResolvedValue({ allowed: true, scope: SCOPE });

    await expect(loadWatchlistPage(new Headers())).resolves.toEqual({
      status: "unavailable",
      reason: "limit_exceeds_page_maximum"
    });
  });

  it("asks the store for the page limit, and lets a caller override it", async () => {
    const repository = repositoryAnswering([]);
    resolveRequestContext.mockResolvedValue(contextWith(repository));
    resolveActiveProfileScope.mockResolvedValue({ allowed: true, scope: SCOPE });

    await loadWatchlistPage(new Headers());
    expect(repository.listWatchlist).toHaveBeenCalledWith({
      scope: SCOPE,
      limit: WATCHLIST_PAGE_QUERY_LIMIT
    });

    await loadWatchlistPage(new Headers(), { limit: 3 });
    expect(repository.listWatchlist).toHaveBeenLastCalledWith({ scope: SCOPE, limit: 3 });
  });

  it("answers `ok` with no entries for a profile whose list is empty", async () => {
    resolveRequestContext.mockResolvedValue(contextWith(repositoryAnswering([])));
    resolveActiveProfileScope.mockResolvedValue({ allowed: true, scope: SCOPE });

    await expect(loadWatchlistPage(new Headers())).resolves.toEqual({ status: "ok", entries: [] });
  });

  it("names the titles the metadata source will surface", async () => {
    resolveRequestContext.mockResolvedValue(
      contextWith(repositoryAnswering([row("alpha", "2026-01-01T00:00:00.000Z")]))
    );
    resolveActiveProfileScope.mockResolvedValue({ allowed: true, scope: SCOPE });
    resolveCatalogMetadataSource.mockReturnValue({
      status: "configured",
      source: { listRecords: () => [{ item: item("alpha") }] }
    });

    const result = await loadWatchlistPage(new Headers());
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.entries.at(0)?.item?.title).toBe("Title alpha");
  });

  it("applies the catalog's RIGHTS GATE and will not name a withheld work", async () => {
    /*
     * THE INVARIANT, ASSERTED RATHER THAN DESCRIBED. A watchlist must not
     * become a second path into the catalog: a work withheld for want of a
     * rights basis may not reappear with its title because somebody once put
     * it on a list. The entry survives -- the viewer can still remove it --
     * and `item` is null, which is what the page renders as "a title we can't
     * name right now".
     *
     * The fixture casts a rights value that is not in `contentRightsSchema`,
     * because all three values the enum admits today are on
     * `PLAYABLE_CONTENT_RIGHTS`. That is exactly the situation the allowlist
     * exists for -- it says any value added later is non-surfaceable until
     * reviewed -- so this test is the one that would catch a future value
     * reaching this surface before anybody ruled on it.
     */
    resolveRequestContext.mockResolvedValue(
      contextWith(repositoryAnswering([row("embargoed-work", "2026-01-01T00:00:00.000Z")]))
    );
    resolveActiveProfileScope.mockResolvedValue({ allowed: true, scope: SCOPE });
    resolveCatalogMetadataSource.mockReturnValue({
      status: "configured",
      source: {
        listRecords: () => [
          { item: item("embargoed-work", { rights: "embargoed" } as unknown as Partial<CatalogItem>) }
        ]
      }
    });

    const result = await loadWatchlistPage(new Headers());
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.entries).toMatchObject([
      { contentId: "embargoed-work", item: null }
    ]);
  });

  it("NEVER THROWS: a repository that blows up becomes a stated reason", async () => {
    /*
     * And the reason is a FIXED STRING rather than the thrown value's text. A
     * repository exception can carry a connection string, and this value is
     * rendered into a server-rendered page.
     */
    resolveRequestContext.mockResolvedValue(
      contextWith({
        listWatchlist: vi.fn().mockRejectedValue(new Error("postgres://user:hunter2@host/db"))
      })
    );
    resolveActiveProfileScope.mockResolvedValue({ allowed: true, scope: SCOPE });

    const result = await loadWatchlistPage(new Headers());
    expect(result).toEqual({ status: "unavailable", reason: "watchlist_unavailable" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
