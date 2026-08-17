import { describe, expect, it } from "vitest";
import {
  contentRightsSchema,
  normalizedContentIdSchema,
  titleDetailResponseSchema,
  titleDetailSchema,
  titleEpisodeSummarySchema,
  titleRightsBasisSchema,
  titleTechnicalMetadataSchema
} from "./index";

/*
 * Imported through the barrel on purpose.
 *
 * `index.ts` re-exports `title.ts` and `title.ts` reads the rights vocabulary
 * back out of `index.ts`, which is a module cycle. If that reference is ever
 * made eager, every one of these tests fails at import time rather than on an
 * assertion -- which is exactly the signal wanted, because that is also how it
 * would fail for the application.
 */

const NOTHING_REPORTED = {
  maxHeight: null,
  audioLanguages: null,
  subtitleLanguages: null
};

const movie = {
  kind: "movie",
  id: "aurora-fall",
  title: "Aurora Fall",
  rights: "owned",
  genre: "Sci-fi",
  releaseYear: 2024,
  synopsis: null,
  technical: NOTHING_REPORTED,
  runtimeMinutes: 128
};

describe("rights basis", () => {
  it("resolves the shared rights vocabulary through the cycle", () => {
    expect(contentRightsSchema.parse("owned")).toBe("owned");
    expect(titleRightsBasisSchema.parse("public-domain")).toBe("public-domain");
  });

  it("accepts an undeclared basis as null", () => {
    expect(titleRightsBasisSchema.parse(null)).toBeNull();
  });

  it("rejects a value that is not in the shared vocabulary", () => {
    expect(titleRightsBasisSchema.safeParse("bootleg").success).toBe(false);
  });

  /*
   * Required-and-nullable, not optional. An omitted key is indistinguishable
   * from a producer that forgot to send one, so "undeclared" has to be asserted
   * rather than achieved by silence.
   */
  it("requires the key to be present even when the basis is unknown", () => {
    expect(titleDetailSchema.safeParse({ ...movie, rights: undefined }).success).toBe(false);
    expect(titleDetailSchema.safeParse({ ...movie, rights: null }).success).toBe(true);
  });
});

describe("normalizedContentIdSchema", () => {
  it("accepts the ids the platform actually issues", () => {
    for (const id of ["northstar", "aurora-fall", "northstar-s1e12"]) {
      expect(normalizedContentIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it("rejects anything that would not survive being put in a URL", () => {
    for (const id of ["", "Aurora Fall", "AURORA-FALL", "aurora_fall", "../secret", "aurora--fall", "-aurora", "aurora-"]) {
      expect(normalizedContentIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe("titleTechnicalMetadataSchema", () => {
  it("accepts null for every fact, meaning nothing was reported", () => {
    expect(titleTechnicalMetadataSchema.safeParse(NOTHING_REPORTED).success).toBe(true);
  });

  it("keeps an empty reported list distinct from an unreported one", () => {
    const reported = titleTechnicalMetadataSchema.parse({
      maxHeight: 1080,
      audioLanguages: ["en"],
      subtitleLanguages: []
    });

    expect(reported.subtitleLanguages).toEqual([]);
    expect(reported.subtitleLanguages).not.toBeNull();
  });

  it("refuses to let a fact be omitted rather than stated as unknown", () => {
    expect(
      titleTechnicalMetadataSchema.safeParse({ maxHeight: null, audioLanguages: null }).success
    ).toBe(false);
  });
});

describe("titleDetailSchema", () => {
  it("parses a movie", () => {
    expect(titleDetailSchema.safeParse(movie).success).toBe(true);
  });

  it("requires a movie to carry a runtime", () => {
    const { runtimeMinutes: _runtimeMinutes, ...withoutRuntime } = movie;
    expect(titleDetailSchema.safeParse(withoutRuntime).success).toBe(false);
  });

  it("parses a series with no episodes, which is a real state", () => {
    const { runtimeMinutes: _runtimeMinutes, ...base } = movie;
    const series = { ...base, kind: "series", id: "northstar", episodes: [] };

    expect(titleDetailSchema.safeParse(series).success).toBe(true);
  });

  it("requires a series to carry an episode list at all", () => {
    expect(titleDetailSchema.safeParse({ ...movie, kind: "series", id: "northstar" }).success).toBe(
      false
    );
  });

  it("requires an episode to know which series it belongs to", () => {
    const episode = {
      ...movie,
      kind: "episode",
      id: "northstar-s1e1",
      seasonNumber: 1,
      episodeNumber: 1
    };

    expect(titleDetailSchema.safeParse(episode).success).toBe(false);
    expect(
      titleDetailSchema.safeParse({ ...episode, seriesId: "northstar", seriesTitle: "Northstar" })
        .success
    ).toBe(true);
  });

  it("rejects a kind that is not a title kind", () => {
    expect(titleDetailSchema.safeParse({ ...movie, kind: "channel" }).success).toBe(false);
  });
});

describe("titleEpisodeSummarySchema", () => {
  it("carries its own rights basis, which may be undeclared", () => {
    const episode = {
      id: "harbor-lights-s1e6",
      title: "Episode 6",
      seasonNumber: 1,
      episodeNumber: 6,
      runtimeMinutes: 44,
      synopsis: null,
      rights: null
    };

    expect(titleEpisodeSummarySchema.safeParse(episode).success).toBe(true);
    const { rights: _rights, ...withoutRights } = episode;
    expect(titleEpisodeSummarySchema.safeParse(withoutRights).success).toBe(false);
  });
});

describe("titleDetailResponseSchema", () => {
  it("parses a well-formed response", () => {
    const parsed = titleDetailResponseSchema.safeParse({
      detail: movie,
      generatedAt: "2026-08-17T00:00:00.000Z"
    });

    expect(parsed.success).toBe(true);
  });

  it("requires a timestamp that is actually a timestamp", () => {
    expect(
      titleDetailResponseSchema.safeParse({ detail: movie, generatedAt: "yesterday" }).success
    ).toBe(false);
  });

  /* A missing title is a 404, never a 200 carrying an empty payload. */
  it("has no representation for an absent title", () => {
    expect(
      titleDetailResponseSchema.safeParse({ detail: null, generatedAt: "2026-08-17T00:00:00.000Z" })
        .success
    ).toBe(false);
  });
});
