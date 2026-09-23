import { describe, expect, it } from "vitest";

import {
  PROFILES_ENDPOINT,
  PROFILE_SELECTION_ENDPOINT,
  createProfile,
  listProfiles,
  reasonDetails,
  selectProfile,
  type FetchLike
} from "./profiles-client";

/** One recorded call, so a test can assert what crossed the wire rather than what was returned. */
interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function recorder(
  reply: (url: string, init: RequestInit | undefined) => Response | Promise<Response>
): { readonly fetch: FetchLike; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return reply(url, init);
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const PROFILE = {
  id: "3f2a1b0c-0000-4000-8000-000000000001",
  displayName: "Sam",
  avatarKey: null,
  maxRating: null,
  createdAt: "2026-01-01T00:00:00.000Z"
};

const LISTED = {
  outcome: "listed",
  reasons: [{ code: "served_by_in_memory_adapter", detail: "answered by the in-memory adapter" }],
  profiles: [PROFILE],
  activeProfileId: null
};

describe("listProfiles", () => {
  it("sends no body, no query and no profile id", async () => {
    /*
     * THE CENTRAL SECURITY ASSERTION OF THIS MODULE. PL-0405 recorded a
     * forgeable-scope defect: a read scoped by an id the client supplied. If a
     * `?profileId=` ever appears on this request, the scope is back in the
     * client's hands, so the test states the requirement as an absence rather
     * than trusting the implementation to keep not doing it.
     */
    const { fetch, calls } = recorder(() => json(LISTED));
    await listProfiles(fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(PROFILES_ENDPOINT);
    expect(calls[0]?.url).not.toContain("?");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it("never lets a browser cache answer for it", async () => {
    /* A list served from cache after a selection is the stale-scope state. */
    const { fetch, calls } = recorder(() => json(LISTED));
    await listProfiles(fetch);
    expect(calls[0]?.init?.cache).toBe("no-store");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
  });

  it("parses a listed response", async () => {
    const { fetch } = recorder(() => json(LISTED));
    const result = await listProfiles(fetch);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.response.outcome).toBe("listed");
    if (result.response.outcome !== "listed") return;
    expect(result.response.profiles).toHaveLength(1);
    expect(result.response.activeProfileId).toBeNull();
  });

  it("does not sort, drop or reshape the profiles the server sent", async () => {
    /*
     * `profilesResponseSchema` makes oldest-first part of the contract because a
     * picker is muscle memory. This asserts the transport is a pass-through:
     * three profiles come back in exactly the order they were served.
     */
    const three = ["c", "a", "b"].map((suffix, index) => ({
      ...PROFILE,
      id: `id-${suffix}`,
      displayName: suffix.toUpperCase(),
      createdAt: `2026-01-0${String(index + 1)}T00:00:00.000Z`
    }));
    const { fetch } = recorder(() => json({ ...LISTED, profiles: three }));
    const result = await listProfiles(fetch);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered" || result.response.outcome !== "listed") return;
    expect(result.response.profiles.map((p) => p.id)).toEqual(["id-c", "id-a", "id-b"]);
  });

  it("reports a refusal as an ANSWER, not as a transport failure", async () => {
    /*
     * A `refused` body is the API working correctly. Classifying it as a
     * failure here would hide the reason trail, which is the only thing the
     * viewer or support can act on.
     */
    const { fetch } = recorder(() =>
      json(
        {
          outcome: "refused",
          reasons: [{ code: "profile_unavailable", detail: "that profile is not one this session may act as" }]
        },
        403
      )
    );
    const result = await listProfiles(fetch);

    expect(result.kind).toBe("answered");
    if (result.kind !== "answered") return;
    expect(result.response.outcome).toBe("refused");
    expect(result.status).toBe(403);
  });

  it("keeps the unavailable branch intact, because that is today's deployment state", async () => {
    /*
     * `authentication_not_configured` is what a deployment answers until PW-0403
     * lands. The screen has to be able to say so, so the transport must not
     * flatten it into a generic error.
     */
    const { fetch } = recorder(() =>
      json(
        {
          outcome: "unavailable",
          reasons: [
            { code: "authentication_not_configured", detail: "no identity can be established in this environment" }
          ]
        },
        503
      )
    );
    const result = await listProfiles(fetch);

    expect(reasonDetails(result)).toEqual([
      "no identity can be established in this environment"
    ]);
  });
});

describe("failures are told apart", () => {
  it("a rejected fetch is unreachable", async () => {
    const result = await listProfiles(() => Promise.reject(new Error("offline")));
    expect(result.kind).toBe("unreachable");
    expect(reasonDetails(result)[0]).toContain("offline");
  });

  it("a thrown non-Error still produces a readable detail", async () => {
    const result = await listProfiles(() => Promise.reject("nope"));
    expect(result.kind).toBe("unreachable");
    expect(reasonDetails(result)[0]).not.toContain("undefined");
  });

  it("a non-JSON body is unreadable, not unreachable", async () => {
    const { fetch } = recorder(
      () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
    );
    const result = await listProfiles(fetch);
    expect(result.kind).toBe("unreadable");
  });

  it("does not echo an unexpected body into the detail", async () => {
    /*
     * A payload that failed this schema is by definition not something we know
     * the shape of. Rendering it would turn a proxy's error page into content in
     * this application's DOM.
     */
    const { fetch } = recorder(() => new Response("<script>alert(1)</script>", { status: 500 }));
    const result = await listProfiles(fetch);
    expect(result.kind).toBe("unreadable");
    expect(reasonDetails(result)[0]).not.toContain("script");
    expect(reasonDetails(result)[0]).not.toContain("alert");
  });

  it("JSON that is not this contract is unreadable and names where, not what", async () => {
    const { fetch } = recorder(() => json({ outcome: "listed", profiles: [], activeProfileId: null }));
    const result = await listProfiles(fetch);

    expect(result.kind).toBe("unreadable");
    expect(reasonDetails(result)[0]).toContain("reasons");
  });

  it("a valid-looking outcome with a secret in it is still not echoed", async () => {
    const { fetch } = recorder(() => json({ outcome: "listed", reasons: [], token: "s3cret-value" }));
    const result = await listProfiles(fetch);
    expect(result.kind).toBe("unreadable");
    expect(reasonDetails(result)[0]).not.toContain("s3cret-value");
  });
});

describe("createProfile", () => {
  it("sends exactly the three contract fields, with explicit nulls", async () => {
    /*
     * `createProfileRequestSchema` is `.strict()` and both nullable fields are
     * REQUIRED, so omitting them is `request_malformed`. Sending `null` is also
     * the true statement: this form collects no avatar and no rating.
     */
    const { fetch, calls } = recorder(() => json({ outcome: "created", reasons: LISTED.reasons, profile: PROFILE }));
    await createProfile({ displayName: "Ada", avatarKey: null, maxRating: null }, fetch);

    expect(calls[0]?.url).toBe(PROFILES_ENDPOINT);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      displayName: "Ada",
      avatarKey: null,
      maxRating: null
    });
  });

  it("carries no account field, because the owner comes from the session", async () => {
    const { fetch, calls } = recorder(() => json({ outcome: "created", reasons: LISTED.reasons, profile: PROFILE }));
    await createProfile({ displayName: "Ada", avatarKey: null, maxRating: null }, fetch);

    const body: Record<string, unknown> = JSON.parse(String(calls[0]?.init?.body));
    for (const forbidden of ["accountId", "userId", "account", "ownerId"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("does not validate the name itself", async () => {
    /*
     * `resolveProfileCreation` reports `display_name_is_blank` and
     * `display_name_too_long` as distinct reasons naming the limit. A check here
     * would collapse both into a message the server never said.
     */
    const { fetch, calls } = recorder(() =>
      json({ outcome: "refused", reasons: [{ code: "display_name_is_blank", detail: "a profile needs a name" }] }, 422)
    );
    const result = await createProfile({ displayName: "   ", avatarKey: null, maxRating: null }, fetch);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init?.body)).displayName).toBe("   ");
    expect(reasonDetails(result)).toEqual(["a profile needs a name"]);
  });
});

describe("selectProfile", () => {
  it("is the only call that sends an id, and it sends it to the selection route", async () => {
    const { fetch, calls } = recorder(() =>
      json({ outcome: "selected", reasons: LISTED.reasons, profileId: PROFILE.id })
    );
    await selectProfile(PROFILE.id, fetch);

    expect(calls[0]?.url).toBe(PROFILE_SELECTION_ENDPOINT);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ profileId: PROFILE.id });
  });

  it("puts the id in the body and never in the path or a query", async () => {
    const { fetch, calls } = recorder(() =>
      json({ outcome: "selected", reasons: LISTED.reasons, profileId: PROFILE.id })
    );
    await selectProfile(PROFILE.id, fetch);

    expect(calls[0]?.url).not.toContain(PROFILE.id);
    expect(calls[0]?.url).not.toContain("?");
  });

  it("passes a malformed id through rather than pre-judging it", async () => {
    /*
     * `isMintedProfileId` in `@liberty/persistence` is the single authority on
     * what a profile id looks like, and a bad one comes back as
     * `profile_unavailable` -- the same answer another household's id gets. A
     * pattern here would be a second authority answering `request_malformed`,
     * which is itself a small oracle.
     */
    const { fetch, calls } = recorder(() =>
      json({ outcome: "refused", reasons: [{ code: "profile_unavailable", detail: "not available" }] }, 403)
    );
    await selectProfile("../../etc/passwd", fetch);

    expect(calls[0]?.url).toBe(PROFILE_SELECTION_ENDPOINT);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ profileId: "../../etc/passwd" });
  });
});

describe("the module's own shape", () => {
  it("retries nothing, so the contract's remedy distinction is the viewer's to act on", async () => {
    let attempts = 0;
    await listProfiles(() => {
      attempts += 1;
      return Promise.reject(new Error("down"));
    });
    expect(attempts).toBe(1);
  });

  it("names both endpoints as constants rather than as literals at call sites", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./profiles-client.ts", import.meta.url), "utf8")
    );
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    /* Exactly one occurrence each: the declaration. */
    expect(stripped.match(/"\/api\/v1\/profiles"/g)).toHaveLength(1);
    expect(stripped.match(/"\/api\/v1\/profiles\/selection"/g)).toHaveLength(1);
    /* Non-vacuity. */
    expect(stripped).toContain("export async function selectProfile");
  });
});
