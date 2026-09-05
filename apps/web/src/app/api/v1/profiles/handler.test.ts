import type { AccountIdentity } from "@liberty/auth";
import type { ProfileRow } from "@liberty/persistence";
import { describe, expect, it } from "vitest";
import { NonDeploymentEnvironment } from "../../deployment-environment";
import {
  createInMemoryRepository,
  createInMemoryStore,
  type InMemoryStore
} from "../../../../lib/db/in-memory-repository";
import type { RequestContextOptions } from "../../../../lib/db/request-context";
import { profilesResponseSchema, type ProfilesResponse } from "./contract";
import { handleCreateProfile, handleListProfiles, handleSelectProfile } from "./handler";
import { GET, POST } from "./route";

/*
 * The HTTP half of PL-0402.
 *
 * What is pinned here is that the status code and the outcome never disagree,
 * that a client-caused failure is a client-status answer rather than a 500, that
 * every body on the wire is a member of the published union, and that a denial
 * about another household's profile is indistinguishable from a denial about a
 * profile that does not exist.
 *
 * The repository is INJECTED rather than resolved, so these tests exercise real
 * repository behaviour -- the ceiling, the uniqueness rule, the scope check --
 * rather than a mock's idea of it, and so they do not depend on what
 * `DATABASE_URL` happens to be in the shell that ran them.
 */

const HOUSEHOLD_A: AccountIdentity = { userId: "household-a", sessionId: "session-a" };
const HOUSEHOLD_B: AccountIdentity = { userId: "household-b", sessionId: "session-b" };

/**
 * A clock that ADVANCES, one second per read.
 *
 * A CONSTANT CLOCK WAS A DEFECT IN THIS FILE, and specifically in the ordering
 * assertion below. `createdAt` is whatever `context.now()` returned at the
 * moment of the insert, and profiles are listed by `created_at` then `id`; with
 * a frozen clock every profile a test creates carries the SAME instant, every
 * comparison falls through to the tie-break, and the tie-break compares two
 * random UUIDs minted by `newProfileId`. The order was therefore a coin flip --
 * an executed run produced `["Kids", "Dad"]` -- and it was flipping for a reason
 * that says nothing at all about the adapter under test.
 *
 * Nothing depends on the size of the step: `created_at` is
 * `timestamp with time zone`, which holds far more resolution than a second.
 * A second is chosen because it is legible in a failure message.
 *
 * One clock per `options()` call, shared by every request in that test through
 * `asAccount`, which is what one process has.
 */
function advancingClock(): () => Date {
  const firstInstant = Date.parse("2026-09-04T10:00:00.000Z");
  let reads = 0;
  return () => {
    const instant = new Date(firstInstant + reads * 1000);
    reads += 1;
    return instant;
  };
}

/** One store shared by every call in a test, which is what a process would have. */
function options(
  account: AccountIdentity = HOUSEHOLD_A,
  store: InMemoryStore = createInMemoryStore()
): RequestContextOptions {
  const environment = NonDeploymentEnvironment.classify("test");
  if (environment === null) throw new Error('NonDeploymentEnvironment.classify rejected "test"');
  return {
    repository: createInMemoryRepository(environment, store),
    account,
    now: advancingClock()
  };
}

/** The same store, seen by a second account. */
function asAccount(base: RequestContextOptions, account: AccountIdentity): RequestContextOptions {
  return { ...base, account };
}

function get(): Request {
  return new Request("https://liberty.test/api/v1/profiles", { method: "GET" });
}

function postJson(body: unknown, path = "/api/v1/profiles"): Request {
  return new Request(`https://liberty.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

/**
 * Parsed against the published contract rather than read as `any`: a body that
 * is not a member of the union is a contract break, and it should fail here
 * rather than three assertions later as a missing property.
 */
async function decision(response: Response): Promise<ProfilesResponse> {
  return profilesResponseSchema.parse(await response.json());
}

async function createNamed(
  context: RequestContextOptions,
  displayName: string
): Promise<ProfilesResponse> {
  return decision(
    await handleCreateProfile(
      postJson({ displayName, avatarKey: null, maxRating: null }),
      context
    )
  );
}

describe("creating and listing", () => {
  it("answers a creation with 201, the profile, and no-store", async () => {
    const context = options();
    const response = await handleCreateProfile(
      postJson({ displayName: "Dad", avatarKey: "avatars/fox.png", maxRating: null }),
      context
    );

    expect(response.status).toBe(201);
    /* A profile list is a household's roster. A shared cache holding one would
     * serve it to another household. */
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await decision(response);
    expect(body.outcome).toBe("created");
    if (body.outcome !== "created") return;
    expect(body.profile.displayName).toBe("Dad");
    expect(body.profile.avatarKey).toBe("avatars/fox.png");
    expect(body.profile.maxRating).toBeNull();
    expect(body.reasons[0].code).toBe("profile_created");
    /* Which adapter answered is on every trail, success or failure. */
    expect(body.reasons.map((line) => line.code)).toContain("served_by_in_memory_adapter");
  });

  it("lists what was created oldest first, with nothing selected yet", async () => {
    const context = options();
    await createNamed(context, "Dad");
    await createNamed(context, "Kids");

    const response = await handleListProfiles(get(), context);
    expect(response.status).toBe(200);

    const body = await decision(response);
    expect(body.outcome).toBe("listed");
    if (body.outcome !== "listed") return;
    /*
     * OLDEST FIRST, which `contract.ts` publishes as part of the `listed`
     * branch rather than leaving to whichever adapter answered. The consumer is
     * a profile picker and a picker is muscle memory: adding "Kids" must not
     * move "Dad" off the tile the household has always aimed at.
     */
    expect(body.profiles.map((profile) => profile.displayName)).toEqual(["Dad", "Kids"]);
    /* `null` is "signed in, nothing chosen" -- the profile picker's own state,
     * and the reason the field is nullable rather than optional. */
    expect(body.activeProfileId).toBeNull();
  });

  it("orders by creation time rather than by the order rows happen to be stored", async () => {
    /*
     * THE ASSERTION ABOVE CANNOT TELL A SORT FROM A COINCIDENCE. Profiles
     * created through the API reach storage in the order they were created, so
     * an adapter that answered in insertion order and sorted nothing would
     * satisfy it. This one seeds the store with the OLDER profile written LAST
     * and gives it an id that sorts AFTER the newer one's, so insertion order
     * and id order both point the wrong way and only a real comparison of
     * `createdAt` produces "Dad" first.
     *
     * `createInMemoryStore` is exported so a test can hand the adapter a known
     * starting state, and that is the only way to reach this arrangement: the
     * API cannot create a profile in the past, so nothing driven through it can
     * ever disagree with its own insertion order.
     */
    const older: ProfileRow = {
      id: "f0000000-0000-4000-8000-000000000001",
      userId: HOUSEHOLD_A.userId,
      displayName: "Dad",
      avatarKey: null,
      maxRating: null,
      createdAt: new Date("2026-09-04T09:00:00.000Z"),
      archivedAt: null
    };
    const newer: ProfileRow = {
      id: "10000000-0000-4000-8000-000000000002",
      userId: HOUSEHOLD_A.userId,
      displayName: "Kids",
      avatarKey: null,
      maxRating: null,
      createdAt: new Date("2026-09-04T11:00:00.000Z"),
      archivedAt: null
    };

    const store = createInMemoryStore();
    store.profiles.set(newer.id, newer);
    store.profiles.set(older.id, older);

    const body = await decision(
      await handleListProfiles(get(), options(HOUSEHOLD_A, store))
    );
    expect(body.outcome).toBe("listed");
    if (body.outcome !== "listed") return;
    expect(body.profiles.map((profile) => profile.displayName)).toEqual(["Dad", "Kids"]);
  });

  it("does not publish the account id on a profile", async () => {
    const context = options();
    const created = await createNamed(context, "Dad");
    if (created.outcome !== "created") throw new Error(created.outcome);
    /* `profileViewSchema` is `.strict()`, so a `userId` that leaked into the
     * response would have failed the parse above. Asserted directly as well,
     * because the strictness is the thing being relied on. */
    expect(Object.keys(created.profile).sort()).toEqual([
      "avatarKey",
      "createdAt",
      "displayName",
      "id",
      "maxRating"
    ]);
  });
});

describe("refusals keep their own status", () => {
  it("answers a body that is not JSON with a refusal rather than a 500", async () => {
    const response = await handleCreateProfile(
      new Request("https://liberty.test/api/v1/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json"
      }),
      options()
    );

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.outcome).toBe("refused");
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("names an unaccepted field rather than silently discarding it", async () => {
    /* Zod's default is to STRIP unknown keys, which would hand a client a
     * successful creation while dropping the field it believed in -- and the
     * field a client would most like to send here is an owner. */
    const response = await handleCreateProfile(
      postJson({ displayName: "Dad", avatarKey: null, maxRating: null, userId: "household-b" }),
      options()
    );

    expect(response.status).toBe(400);
    const body = await decision(response);
    expect(body.reasons[0].code).toBe("request_field_not_permitted");
    expect(body.reasons[0].detail).toContain("userId");
  });

  it("answers a blank name with 400 and a duplicate with 409", async () => {
    const context = options();

    const blank = await handleCreateProfile(
      postJson({ displayName: "   ", avatarKey: null, maxRating: null }),
      context
    );
    expect(blank.status).toBe(400);
    expect((await decision(blank)).reasons[0].code).toBe("display_name_is_blank");

    await createNamed(context, "Dad");
    const duplicate = await handleCreateProfile(
      postJson({ displayName: "Dad", avatarKey: null, maxRating: null }),
      context
    );
    /*
     * 409 rather than 400: the request is well-formed and would have been
     * accepted a moment ago. Telling a household its request is malformed sends
     * somebody to correct a form that was never the problem.
     */
    expect(duplicate.status).toBe(409);
    expect((await decision(duplicate)).reasons[0].code).toBe("display_name_already_used");
  });
});

describe("selection", () => {
  it("records the choice and reports it on the next list", async () => {
    const context = options();
    const created = await createNamed(context, "Dad");
    if (created.outcome !== "created") throw new Error(created.outcome);

    const selected = await handleSelectProfile(
      postJson({ profileId: created.profile.id }, "/api/v1/profiles/selection"),
      context
    );
    expect(selected.status).toBe(200);
    const selection = await decision(selected);
    expect(selection.outcome).toBe("selected");
    if (selection.outcome !== "selected") return;
    expect(selection.profileId).toBe(created.profile.id);
    /* The grant is published as well as the outcome: invariant 4 applies to a
     * grant exactly as much as to a denial. */
    expect(selection.reasons.map((line) => line.code)).toContain(
      "selectable_profile_of_account"
    );

    const listed = await decision(await handleListProfiles(get(), context));
    expect(listed.outcome === "listed" && listed.activeProfileId).toBe(created.profile.id);
  });

  it("answers another household's profile the same way it answers one that does not exist", async () => {
    const context = options();
    const created = await createNamed(context, "Dad");
    if (created.outcome !== "created") throw new Error(created.outcome);

    const foreign = await handleSelectProfile(
      postJson({ profileId: created.profile.id }, "/api/v1/profiles/selection"),
      asAccount(context, HOUSEHOLD_B)
    );
    const invented = await handleSelectProfile(
      postJson({ profileId: "3f1a2b4c-5d6e-4f70-8901-a2b3c4d5e6f7" }, "/api/v1/profiles/selection"),
      asAccount(context, HOUSEHOLD_B)
    );

    /*
     * THE POINT OF THIS TEST. If these two answers differed -- in status or in
     * reason code -- an authenticated caller could ask about an id and learn
     * whether a profile with it exists anywhere in the product, and iterate. 403
     * for both, `profile_unavailable` for both; the sharp internal distinction
     * stays in `ProfileAccessDecision.trail`, which is a server-side artefact.
     */
    expect(foreign.status).toBe(403);
    expect(invented.status).toBe(403);
    expect((await decision(foreign)).reasons[0].code).toBe("profile_unavailable");
    expect((await decision(invented)).reasons[0].code).toBe("profile_unavailable");
  });

  it("does not let one household's profile be selected by another even after it selects its own", async () => {
    const context = options();
    const mine = await createNamed(context, "Dad");
    if (mine.outcome !== "created") throw new Error(mine.outcome);

    const theirContext = asAccount(context, HOUSEHOLD_B);
    const theirs = await createNamed(theirContext, "Dad");
    /* Two households may both have a "Dad": the uniqueness constraint is on
     * (user_id, display_name), not on the product. */
    if (theirs.outcome !== "created") throw new Error(theirs.outcome);

    const crossed = await handleSelectProfile(
      postJson({ profileId: mine.profile.id }, "/api/v1/profiles/selection"),
      theirContext
    );
    expect(crossed.status).toBe(403);
  });
});

describe("the route module Next actually deploys", () => {
  it("answers a real request through GET and POST", async () => {
    /*
     * THE ONLY TEST THAT EXECUTES `route.ts`. Everything above calls the
     * handlers directly, which is the only way to inject a repository -- and
     * which means a renamed export, a `GET` wired to the wrong handler or a
     * dropped `await` would leave this whole suite green while the deployed path
     * was broken.
     *
     * It is also the only place the DEFAULT composition root runs. That root
     * answers from the in-memory adapter under `NODE_ENV=test` and refuses in a
     * deployment, so the assertion is written against BOTH states rather than
     * against whichever one this machine happens to be in.
     */
    const listed = await GET(get());
    expect(listed).toBeInstanceOf(Response);
    expect(listed.headers.get("cache-control")).toBe("no-store");

    const body = await decision(listed);
    if (body.outcome === "listed") {
      expect(listed.status).toBe(200);
    } else {
      expect(body.outcome).toBe("unavailable");
      expect(listed.status).toBe(503);
    }

    const created = await POST(
      postJson({ displayName: "Route Check", avatarKey: null, maxRating: null })
    );
    expect(created).toBeInstanceOf(Response);
    expect([201, 409, 503]).toContain(created.status);
    /* Whatever the environment, the body is a member of the published union. */
    await decision(created);
  });
});
