import { describe, expect, it } from "vitest";
import { catalogItemSchema } from "@liberty/contracts/domains/catalog";
import {
  isAvailable,
  projectCatalogAnswer,
  projectToCatalogRecord,
  selectLocalized,
  type ProjectionRequest
} from "./project";
import type { AcceptedWork } from "./provider";
import type { IngestedWork } from "./record";

const MINUTE = 60_000;
const OBSERVED = "2026-09-16T00:00:00.000Z";
const NOW = Date.parse(OBSERVED) + MINUTE;

const work = (over: Partial<IngestedWork> = {}): IngestedWork => ({
  contentId: "example-source-a1",
  kind: "movie",
  titles: [
    { locale: "en", value: "A Work" },
    { locale: "fr", value: "Une Oeuvre" }
  ],
  synopses: [],
  genres: [
    { locale: "en", value: "Drama" },
    { locale: "fr", value: "Drame" }
  ],
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  availability: [{ territory: "WW", startsAt: null, endsAt: null }],
  artwork: [],
  rights: { category: "public-domain", reference: null },
  ...over
});

const accepted = (over: Partial<IngestedWork> = {}): AcceptedWork => ({
  work: work(over),
  ref: { sourceId: "example-source", nativeId: "a1" },
  crossRefs: [],
  observedAt: OBSERVED,
  sourceRevision: null
});

const request = (over: Partial<ProjectionRequest> = {}): ProjectionRequest => ({
  locales: ["en"],
  territory: "GB",
  atMs: NOW,
  unstatedAvailability: "refuse",
  ...over
});

describe("selectLocalized", () => {
  it("prefers an exact locale match in preference order", () => {
    const entries = [
      { locale: "en-GB", value: "Colour" },
      { locale: "en-US", value: "Color" }
    ];
    expect(selectLocalized(entries, ["en-US", "en-GB"])?.value).toBe("Color");
  });

  /*
   * WHAT THIS CATCHES: the two rounds being interleaved. `en` matches `en-GB` by
   * primary subtag, but an EXACT match on the less-preferred `fr` still beats
   * it -- an implementation that walked the preference list once, trying exact
   * then loose at each step, would answer "Colour" here.
   */
  it("prefers an exact match on a less-preferred locale over a loose match on a better one", () => {
    const entries = [
      { locale: "en-GB", value: "Colour" },
      { locale: "fr", value: "Couleur" }
    ];
    expect(selectLocalized(entries, ["en", "fr"])?.value).toBe("Couleur");
  });

  it("falls back to a primary-subtag match when nothing matches exactly", () => {
    const entries = [{ locale: "en-GB", value: "Colour" }];
    expect(selectLocalized(entries, ["en"])?.value).toBe("Colour");
  });

  /*
   * WHAT THIS CATCHES: a fallback to "whatever the source listed first". A
   * reader who asked for German and is handed Japanese has been given a worse
   * answer than an honest refusal, and cannot tell it is wrong.
   */
  it("refuses rather than serving a language nobody asked for", () => {
    expect(selectLocalized([{ locale: "ja", value: "..." }], ["de"])).toBeNull();
  });
});

describe("isAvailable", () => {
  const at = Date.parse("2026-06-15T00:00:00.000Z");

  it("matches a worldwide window and a matching territory", () => {
    expect(isAvailable([{ territory: "WW", startsAt: null, endsAt: null }], "GB", at)).toBe(true);
    expect(isAvailable([{ territory: "GB", startsAt: null, endsAt: null }], "GB", at)).toBe(true);
    expect(isAvailable([{ territory: "US", startsAt: null, endsAt: null }], "GB", at)).toBe(false);
  });

  /*
   * WHAT THIS CATCHES: a window's dates being ignored. A licence that has not
   * started, or has ended, is not a licence -- and an implementation that
   * matched on territory alone would surface a work outside its term, which is
   * a rights defect rather than a display bug.
   */
  it("respects both ends of the term", () => {
    const window = {
      territory: "GB" as const,
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-12-31T00:00:00.000Z"
    };
    expect(isAvailable([window], "GB", at)).toBe(true);
    expect(isAvailable([window], "GB", Date.parse("2025-12-31T00:00:00.000Z"))).toBe(false);
    expect(isAvailable([window], "GB", Date.parse("2027-01-01T00:00:00.000Z"))).toBe(false);
    // Both boundary instants are inside the term.
    expect(isAvailable([window], "GB", Date.parse(window.startsAt))).toBe(true);
    expect(isAvailable([window], "GB", Date.parse(window.endsAt))).toBe(true);
  });
});

describe("projectToCatalogRecord", () => {
  it("produces a record the catalog contract accepts", () => {
    const projected = projectToCatalogRecord(accepted(), request());
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    expect(catalogItemSchema.safeParse(projected.record.item).success).toBe(true);
    expect(projected.record.item).toEqual({
      id: "example-source-a1",
      title: "A Work",
      kind: "movie",
      rights: "public-domain",
      genre: "Drama",
      releaseYear: 2024,
      runtimeMinutes: 100,
      episodeCount: null
    });
    expect(projected.record.rights).toEqual({ category: "public-domain", reference: null });
  });

  it("answers the requested locale", () => {
    const projected = projectToCatalogRecord(accepted(), request({ locales: ["fr"] }));
    expect(projected.ok && projected.record.item.title).toBe("Une Oeuvre");
    expect(projected.ok && projected.record.item.genre).toBe("Drame");
  });

  /*
   * WHAT THIS CATCHES: the single most important property of this module. A
   * `CatalogItem` has no url, image or stream field, and artwork is DROPPED
   * rather than mapped -- so nothing a provider says about where an image or a
   * stream lives can cross into a browse payload. Asserted over the key set
   * rather than by inspection, so a field added later has to be considered.
   */
  it("carries no address and no artwork into the browse shape", () => {
    const projected = projectToCatalogRecord(
      accepted({
        artwork: [
          {
            role: "poster",
            assetRef: "poster-a1",
            rights: { category: "licensed", reference: null }
          }
        ]
      }),
      request()
    );
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;

    expect(Object.keys(projected.record.item).sort()).toEqual([
      "episodeCount",
      "genre",
      "id",
      "kind",
      "releaseYear",
      "rights",
      "runtimeMinutes",
      "title"
    ]);
    expect(JSON.stringify(projected.record)).not.toContain("poster");
  });

  /*
   * WHAT THIS CATCHES: "we do not know where this is licensed" quietly becoming
   * "available here". A source that names no territory has told us nothing, and
   * which way to read that is a product-and-rights decision -- so the caller
   * states it and the fail-closed reading is available.
   */
  it("makes the unstated-availability reading the caller's decision", () => {
    const unstated = accepted({ availability: [] });

    const refused = projectToCatalogRecord(unstated, request({ unstatedAvailability: "refuse" }));
    expect(refused).toEqual({
      ok: false,
      reason: "availability_not_stated",
      detail: "example-source-a1 names no territory"
    });

    const allowed = projectToCatalogRecord(
      unstated,
      request({ unstatedAvailability: "treat_as_worldwide" })
    );
    expect(allowed.ok).toBe(true);
  });

  it("refuses a work not offered in the requested territory", () => {
    const projected = projectToCatalogRecord(
      accepted({ availability: [{ territory: "US", startsAt: null, endsAt: null }] }),
      request({ territory: "GB" })
    );
    expect(projected).toMatchObject({ ok: false, reason: "not_available_in_territory" });
  });

  /*
   * WHAT THIS CATCHES: a work with an undeclared basis being given a permissive
   * one so that it parses. The item still has to carry one of three contract
   * values, but `record.rights` stays `null` -- which is what the port's
   * `selectDeclaredItems` refuses on. If this ever emitted `owned` with a
   * non-null basis, an unchecked work would reach a rail.
   */
  it("keeps an undeclared basis null even though the contract forces the item to name one", () => {
    const projected = projectToCatalogRecord(accepted({ rights: null }), request());
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.record.rights).toBeNull();
    expect(catalogItemSchema.safeParse(projected.record.item).success).toBe(true);
  });

  /*
   * WHAT THIS CATCHES: the contract's own kind/runtime invariant being bypassed.
   * `ingestedWorkSchema` allows both fields to be nullable independently;
   * `catalogItemSchema` is a discriminated union that does not. The projection
   * must be refused by the CONTRACT rather than by a second copy of the rule.
   */
  it("refuses a series that carries a runtime, using the contract's own rule", () => {
    const projected = projectToCatalogRecord(
      accepted({ kind: "series", runtimeMinutes: 45, episodeCount: 8 }),
      request()
    );
    expect(projected).toMatchObject({ ok: false, reason: "item_failed_contract_validation" });
  });
});

describe("projectCatalogAnswer", () => {
  const policy = { freshForMs: 15 * MINUTE, staleAfterMs: 6 * 60 * MINUTE };

  /*
   * WHAT THIS CATCHES: a rail describing itself by its freshest row. One
   * just-refreshed record would otherwise let a page of week-old ones be
   * reported as fresh, which is exactly the dishonesty "an answer carries its
   * age" exists to prevent.
   */
  it("ages the answer by its oldest record, not its newest", () => {
    const old = { ...accepted(), observedAt: "2026-09-15T00:00:00.000Z" };
    const recent = { ...accepted({ contentId: "example-source-a2" }), observedAt: OBSERVED };

    const answer = projectCatalogAnswer([recent, old], request(), policy, NOW);

    expect(answer).not.toBeNull();
    expect(answer?.verdict.observedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(answer?.verdict.freshness).toBe("expired");
  });

  it("reports refusals beside the records rather than dropping them", () => {
    const answer = projectCatalogAnswer(
      [accepted(), accepted({ contentId: "example-source-a2", availability: [] })],
      request(),
      policy,
      NOW
    );
    expect(answer?.value.records).toHaveLength(1);
    expect(answer?.value.refused).toEqual([
      { contentId: "example-source-a2", reason: "availability_not_stated" }
    ]);
  });

  /*
   * WHAT THIS CATCHES: an empty set being dated with `now`, which would claim a
   * freshly-observed empty catalog when nothing was observed at all.
   */
  it("answers null for an empty set rather than inventing an observation time", () => {
    expect(projectCatalogAnswer([], request(), policy, NOW)).toBeNull();
  });
});
