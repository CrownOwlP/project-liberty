import { describe, expect, it } from "vitest";
import {
  catalogHomeResponseSchema,
  catalogItemSchema,
  catalogRailSchema
} from "./domains/catalog";
import { PLAYABLE_CONTENT_RIGHTS, contentRightsSchema } from "./shared/rights";

const validItem = {
  id: "aurora-fall",
  title: "Aurora Fall",
  kind: "movie",
  rights: "owned",
  genre: "Sci-fi",
  releaseYear: 2024,
  runtimeMinutes: 128,
  episodeCount: null
};

describe("catalogItemSchema", () => {
  it("accepts a well-formed movie", () => {
    expect(catalogItemSchema.safeParse(validItem).success).toBe(true);
  });

  it("accepts a series with a null runtime", () => {
    const result = catalogItemSchema.safeParse({
      ...validItem,
      id: "northstar",
      kind: "series",
      runtimeMinutes: null,
      episodeCount: 8
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty id or title", () => {
    expect(catalogItemSchema.safeParse({ ...validItem, id: "" }).success).toBe(false);
    expect(catalogItemSchema.safeParse({ ...validItem, title: "" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(catalogItemSchema.safeParse({ ...validItem, kind: "podcast" }).success).toBe(false);
  });

  it("rejects rights outside the content-rights enum", () => {
    expect(catalogItemSchema.safeParse({ ...validItem, rights: "unlicensed" }).success).toBe(false);
  });

  it("rejects a non-positive or fractional runtime", () => {
    expect(catalogItemSchema.safeParse({ ...validItem, runtimeMinutes: 0 }).success).toBe(false);
    expect(catalogItemSchema.safeParse({ ...validItem, runtimeMinutes: 90.5 }).success).toBe(false);
  });

  it("requires runtimeMinutes and episodeCount to be present, even when null", () => {
    const { runtimeMinutes, ...withoutRuntime } = validItem;
    expect(runtimeMinutes).toBe(128);
    expect(catalogItemSchema.safeParse(withoutRuntime).success).toBe(false);
  });
});

/**
 * The shape fields are not independently nullable. Before these tests the
 * schema was a plain object with two `.nullable()` fields, so every invalid
 * combination below parsed successfully while a comment claimed otherwise.
 * These assert the invariant itself, not the comment.
 */
describe("catalogItemSchema cross-field invariants", () => {
  const movie = { ...validItem, kind: "movie", runtimeMinutes: 128, episodeCount: null };
  const series = {
    ...validItem,
    id: "northstar",
    kind: "series",
    runtimeMinutes: null,
    episodeCount: 8
  };
  const episode = {
    ...validItem,
    id: "northstar-s01e01",
    kind: "episode",
    runtimeMinutes: 47,
    episodeCount: null
  };

  it("accepts the one valid shape for each kind", () => {
    for (const item of [movie, series, episode]) {
      expect(catalogItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it("rejects a series that carries a runtime", () => {
    expect(catalogItemSchema.safeParse({ ...series, runtimeMinutes: 90 }).success).toBe(false);
  });

  it("rejects a series with no episode count", () => {
    expect(catalogItemSchema.safeParse({ ...series, episodeCount: null }).success).toBe(false);
  });

  it("rejects a movie that carries an episode count", () => {
    expect(catalogItemSchema.safeParse({ ...movie, episodeCount: 8 }).success).toBe(false);
  });

  it("rejects a movie with no runtime", () => {
    expect(catalogItemSchema.safeParse({ ...movie, runtimeMinutes: null }).success).toBe(false);
  });

  it("rejects an episode that carries an episode count", () => {
    expect(catalogItemSchema.safeParse({ ...episode, episodeCount: 3 }).success).toBe(false);
  });

  it("rejects an episode with no runtime", () => {
    expect(catalogItemSchema.safeParse({ ...episode, runtimeMinutes: null }).success).toBe(false);
  });

  it("rejects an item that carries neither shape field", () => {
    expect(
      catalogItemSchema.safeParse({ ...movie, runtimeMinutes: null, episodeCount: null }).success
    ).toBe(false);
  });

  it("reports the failure against the branch the discriminator selected", () => {
    const result = catalogItemSchema.safeParse({ ...series, runtimeMinutes: 90 });
    expect(result.success).toBe(false);
    if (result.success) return;
    // A non-discriminated union would union every branch's complaints, which is
    // why the discriminator is worth having: the error names the real field.
    expect(result.error.issues.every((issue) => issue.path[0] === "runtimeMinutes")).toBe(true);
  });
});

describe("catalogRailSchema", () => {
  it("accepts an empty rail", () => {
    expect(catalogRailSchema.safeParse({ id: "movies", title: "Films", items: [] }).success).toBe(true);
  });

  it("rejects a rail containing a malformed item", () => {
    const result = catalogRailSchema.safeParse({
      id: "movies",
      title: "Films",
      items: [{ ...validItem, releaseYear: 1200 }]
    });
    expect(result.success).toBe(false);
  });
});

describe("catalogHomeResponseSchema", () => {
  it("accepts a response with an ISO-8601 timestamp", () => {
    const result = catalogHomeResponseSchema.safeParse({
      rails: [{ id: "movies", title: "Films", items: [validItem] }],
      generatedAt: "2026-08-14T00:00:00.000Z"
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-datetime generatedAt", () => {
    const result = catalogHomeResponseSchema.safeParse({
      rails: [],
      generatedAt: "yesterday"
    });
    expect(result.success).toBe(false);
  });
});

describe("PLAYABLE_CONTENT_RIGHTS", () => {
  it("only contains values from the content-rights enum", () => {
    for (const rights of PLAYABLE_CONTENT_RIGHTS) {
      expect(contentRightsSchema.safeParse(rights).success).toBe(true);
    }
  });

  it("is an allowlist, so an unknown rights value is not surfaceable", () => {
    expect(PLAYABLE_CONTENT_RIGHTS).not.toContain("unlicensed");
  });
});
