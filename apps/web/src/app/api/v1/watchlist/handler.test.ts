import { authorizeProfileSelection, type AccountIdentity, type LibertySession } from "@liberty/auth";
import { describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../deployment-environment";
import {
  createInMemoryRepository,
  createInMemoryStore
} from "../../../../lib/db/in-memory-repository";
import type { LibertyRepository } from "../../../../lib/db/repository";
import type { RequestContextOptions } from "../../../../lib/db/request-context";
import {
  MAX_WATCHLIST_PAGE_SIZE,
  watchlistResponseSchema,
  type WatchlistResponse
} from "./contract";
import {
  handleAddToWatchlist,
  handleListWatchlist,
  handleRemoveFromWatchlist
} from "./handler";

/*
 * The HTTP half of PL-0404.
 *
 * The properties worth pinning are the idempotence ones, because they are the
 * ones a status code most easily gets wrong: a double tap must not be a 409 and
 * a retried remove must not be a 404. The client is a button on a remote control
 * behind an unreliable network, and a retry has to converge.
 *
 * The other property is that one profile's list is invisible to another, which
 * is a product requirement rather than a security nicety -- a shared household
 * list is a different and worse product, and it is the version that cannot be
 * un-merged later.
 */

const HOUSEHOLD: AccountIdentity = { userId: "household-a", sessionId: "session-a" };
const OTHER_VIEWER: AccountIdentity = { userId: "household-a", sessionId: "session-b" };
const INSTANT = new Date("2026-09-04T10:00:00.000Z");

function newRepository(): LibertyRepository {
  const environment = NonDeploymentEnvironment.classify("test");
  if (environment === null) throw new Error('NonDeploymentEnvironment.classify rejected "test"');
  return createInMemoryRepository(environment, createInMemoryStore());
}

/** Creates a profile for `account` and selects it on that account's session. */
async function selectProfile(
  repository: LibertyRepository,
  account: AccountIdentity,
  displayName: string
): Promise<void> {
  const session: LibertySession = { account, activeProfileId: null };
  const created = await repository.createProfile({
    session,
    displayName,
    avatarKey: null,
    maxRating: null,
    instant: INSTANT
  });
  if (!created.ok) throw new Error(created.reason);

  const ownership = await repository.loadProfileOwnership(created.profile.id);
  const decision = authorizeProfileSelection({ session, ownership });
  if (!decision.allowed) throw new Error(decision.reason);

  const selection = await repository.selectActiveProfile({
    session,
    scope: decision.scope,
    instant: INSTANT
  });
  if (!selection.ok) throw new Error(selection.reason);
}

function optionsOver(
  repository: LibertyRepository,
  account: AccountIdentity,
  instant: Date = INSTANT
): RequestContextOptions {
  return { repository, account, now: () => instant };
}

async function readyContext(): Promise<RequestContextOptions> {
  const repository = newRepository();
  await selectProfile(repository, HOUSEHOLD, "Dad");
  return optionsOver(repository, HOUSEHOLD);
}

function mutation(method: string, contentId: string): Request {
  return new Request(`https://liberty.test/api/v1/watchlist/${contentId}`, { method });
}

function listRequest(query = ""): Request {
  return new Request(`https://liberty.test/api/v1/watchlist${query}`, { method: "GET" });
}

async function decision(response: Response): Promise<WatchlistResponse> {
  return watchlistResponseSchema.parse(await response.json());
}

describe("add and remove converge", () => {
  it("adds, reports it changed, and lists the entry", async () => {
    const context = await readyContext();

    const added = await handleAddToWatchlist(mutation("PUT", "northstar"), "northstar", context);
    expect(added.status).toBe(200);
    expect(added.headers.get("cache-control")).toBe("no-store");

    const body = await decision(added);
    expect(body.outcome).toBe("mutated");
    if (body.outcome !== "mutated") return;
    expect(body.changed).toBe(true);
    expect(body.reasons[0].code).toBe("added");
    expect(body.entry?.contentId).toBe("northstar");

    const listed = await decision(await handleListWatchlist(listRequest(), context));
    expect(listed.outcome === "listed" && listed.entries.map((entry) => entry.contentId)).toEqual([
      "northstar"
    ]);
  });

  it("answers a double tap with 200 and does not reorder the list", async () => {
    const repository = newRepository();
    await selectProfile(repository, HOUSEHOLD, "Dad");
    await handleAddToWatchlist(
      mutation("PUT", "northstar"),
      "northstar",
      optionsOver(repository, HOUSEHOLD)
    );

    /* A day later, against the same store, on a context whose clock has moved. */
    const later = optionsOver(repository, HOUSEHOLD, new Date("2026-09-05T10:00:00.000Z"));
    const again = await handleAddToWatchlist(mutation("PUT", "northstar"), "northstar", later);

    /*
     * NOT a 409. Adding something already on the list is not a conflict, it is
     * the request having already been satisfied -- and `changed: false` is what
     * tells telemetry the difference.
     */
    expect(again.status).toBe(200);
    const body = await decision(again);
    if (body.outcome !== "mutated") throw new Error(body.outcome);
    expect(body.changed).toBe(false);
    expect(body.reasons[0].code).toBe("already_present");
    /* THE FIRST ADD WINS THE SORT KEY: re-adding must not move an entry the
     * viewer never touched to the top. */
    expect(body.entry?.addedAt).toBe(INSTANT.toISOString());
  });

  it("answers removing something absent with 200 rather than 404", async () => {
    const context = await readyContext();
    const response = await handleRemoveFromWatchlist(
      mutation("DELETE", "northstar"),
      "northstar",
      context
    );

    expect(response.status).toBe(200);
    const body = await decision(response);
    if (body.outcome !== "mutated") throw new Error(body.outcome);
    expect(body.changed).toBe(false);
    expect(body.reasons[0].code).toBe("not_present");
    expect(body.entry).toBeNull();
  });

  it("removes what was added, and the entry is gone", async () => {
    const context = await readyContext();
    await handleAddToWatchlist(mutation("PUT", "northstar"), "northstar", context);

    const removed = await decision(
      await handleRemoveFromWatchlist(mutation("DELETE", "northstar"), "northstar", context)
    );
    if (removed.outcome !== "mutated") throw new Error(removed.outcome);
    expect(removed.changed).toBe(true);
    expect(removed.reasons[0].code).toBe("removed");

    const listed = await decision(await handleListWatchlist(listRequest(), context));
    expect(listed.outcome === "listed" && listed.entries).toEqual([]);
  });
});

describe("scoping", () => {
  it("keeps one profile's list invisible to another in the same household", async () => {
    const repository = newRepository();
    await selectProfile(repository, HOUSEHOLD, "Dad");
    /* The same account on a second session, acting as a second profile. */
    await selectProfile(repository, OTHER_VIEWER, "Kids");

    const dad = optionsOver(repository, HOUSEHOLD);
    const kids = optionsOver(repository, OTHER_VIEWER);

    await handleAddToWatchlist(mutation("PUT", "northstar"), "northstar", dad);

    const theirs = await decision(await handleListWatchlist(listRequest(), kids));
    expect(theirs.outcome).toBe("listed");
    if (theirs.outcome !== "listed") return;
    expect(theirs.entries).toEqual([]);
  });

  it("refuses a session that has selected no profile", async () => {
    const context = optionsOver(newRepository(), HOUSEHOLD);
    const response = await handleListWatchlist(listRequest(), context);

    expect(response.status).toBe(403);
    expect((await decision(response)).reasons[0].code).toBe("no_active_profile_selected");
  });
});

describe("the page size is a decision at this call site", () => {
  it("applies a default and echoes it", async () => {
    const context = await readyContext();
    const body = await decision(await handleListWatchlist(listRequest(), context));
    expect(body.outcome).toBe("listed");
    if (body.outcome !== "listed") return;
    /* Echoed so a caller that sent no limit does not have to hard-code the
     * default, and so a short page is distinguishable from the end of the list. */
    expect(body.limit).toBeGreaterThan(0);
  });

  it("refuses a page larger than the ceiling", async () => {
    const context = await readyContext();
    const response = await handleListWatchlist(
      listRequest(`?limit=${String(MAX_WATCHLIST_PAGE_SIZE + 1)}`),
      context
    );

    expect(response.status).toBe(400);
    expect((await decision(response)).reasons[0].code).toBe("limit_exceeds_page_maximum");
  });

  it("refuses a limit that is not a number, through the package's own check", async () => {
    const context = await readyContext();
    const response = await handleListWatchlist(listRequest("?limit=abc"), context);

    /*
     * `limit_not_representable` has exactly ONE emitter -- `parseListLimit` --
     * and the route deliberately hands `NaN` through to it rather than
     * duplicating the rule. A second check here would be a second wording of one
     * refusal, and the one a test exercised would not be the one that ran.
     */
    expect(response.status).toBe(400);
    expect((await decision(response)).reasons[0].code).toBe("limit_not_representable");
  });

  it("refuses a blank limit rather than reading it as zero", async () => {
    const context = await readyContext();
    const response = await handleListWatchlist(listRequest("?limit="), context);

    /* `Number("")` is `0`, which would silently turn "the caller stated a limit
     * and it was blank" into "the caller asked for no rows". */
    expect(response.status).toBe(400);
    expect((await decision(response)).reasons[0].code).toBe("limit_not_representable");
  });
});

describe("the request boundary", () => {
  it("refuses a body field rather than discarding it", async () => {
    const context = await readyContext();
    const response = await handleAddToWatchlist(
      new Request("https://liberty.test/api/v1/watchlist/northstar", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        /* An empty non-strict schema would accept and silently drop this. */
        body: JSON.stringify({ addedAt: "2030-01-01T00:00:00.000Z" })
      }),
      "northstar",
      context
    );

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("request_field_not_permitted");
    expect(body.reasons[0].detail).toContain("addedAt");
  });

  it("accepts a request with no body at all", async () => {
    const context = await readyContext();
    /* The whole request is in the method and the path. An absent body must not
     * be read as `null` and refused against the empty-object schema. */
    const response = await handleAddToWatchlist(mutation("PUT", "northstar"), "northstar", context);
    expect(response.status).toBe(200);
  });

  it("refuses a content id the contracts schema rejects", async () => {
    const context = await readyContext();
    const response = await handleAddToWatchlist(
      mutation("PUT", "not%20a%20id"),
      "not a id",
      context
    );

    expect(response.status).toBe(400);
    expect((await decision(response)).reasons[0].code).toBe("not_a_normalized_content_id");
  });
});
