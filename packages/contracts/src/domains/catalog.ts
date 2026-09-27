import { z } from "zod";
import { artworkListSchema } from "../shared/artwork";
import { contentRightsSchema } from "../shared/rights";

/* -------------------------------------------------------------------------
 * Catalog (PL-0101)
 *
 * Browse-surface metadata: what a rail shows and what the home response is made
 * of. Carries no stream, URL or provider field -- a catalog item says a work
 * exists, never that it is playable. Depends only on shared leaf vocabularies.
 *
 * THAT HEADER SURVIVES PW-0302 UNCHANGED, AND IT HAD TO. A catalog item now
 * carries artwork, and the sentence above still says there is no URL field in
 * this shape, because `artworkListSchema` is a list of OPAQUE REFERENCES:
 * `../shared/artwork` has no url, uri, src, href or origin field and constrains
 * the reference so that none can be spelled inside one. An image is named here;
 * where to fetch it from is decided at the artwork resolution boundary in
 * `apps/web`, which is the only place in the product an artwork origin exists.
 * The alternative -- a `posterUrl` beside the title -- would have made this
 * header false, which is how the round-83 audit caught it.
 *
 * `PLAYABLE_CONTENT_RIGHTS` used to be declared under this heading; it now lives
 * in `../shared/rights` beside the vocabulary it is an allowlist over, because
 * the provider SDK and the title surface gate on it too.
 * ---------------------------------------------------------------------- */

export const catalogItemKindSchema = z.enum(["movie", "series", "episode"]);
export type CatalogItemKind = z.infer<typeof catalogItemKindSchema>;

/**
 * Fields whose meaning does not depend on `kind`.
 *
 * Split out so the per-kind branches below differ ONLY in the cross-field
 * invariants, which makes it obvious at a glance that nothing else diverges.
 */
const catalogItemBaseShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  rights: contentRightsSchema,
  genre: z.string().min(1),
  releaseYear: z.number().int().min(1888),
  /**
   * Opaque artwork references, never image addresses.
   *
   * See `../shared/artwork` for the whole vocabulary, including why the list is
   * optional where the rest of this shape is required -- in short, because ten
   * existing producers of this type have no artwork concept and a required key
   * would force each of them to assert a fact it has not established.
   */
  artwork: artworkListSchema
};

const runtime = z.number().int().positive();
const episodes = z.number().int().positive();

/**
 * `runtimeMinutes` and `episodeCount` are NOT independently nullable: which one
 * carries the shape is determined by `kind`. Expressing that as a plain object
 * with two `.nullable()` fields — as this schema previously did — documents the
 * invariant in a comment while accepting every payload that violates it: a
 * series with a runtime, a movie with an episode count, or an item with
 * neither. A comment is not a validator.
 *
 * A discriminated union makes the invariant structural, so an invalid
 * combination cannot parse and cannot be constructed in TypeScript either.
 * Zod also uses the discriminator to report the error against the correct
 * branch instead of unioning every branch's failures.
 *
 * Both fields stay REQUIRED (explicitly `null`, never absent) in every branch.
 * A provider that omits a field is signalling something different from one that
 * asserts the field does not apply, and the resolver needs to tell them apart.
 */
export const movieCatalogItemSchema = z.object({
  ...catalogItemBaseShape,
  kind: z.literal("movie"),
  /** A movie always has a runtime. */
  runtimeMinutes: runtime,
  /** Only a series is counted in episodes. */
  episodeCount: z.null()
});

export const seriesCatalogItemSchema = z.object({
  ...catalogItemBaseShape,
  kind: z.literal("series"),
  /** A series has no single runtime; its episodes do. */
  runtimeMinutes: z.null(),
  episodeCount: episodes
});

export const episodeCatalogItemSchema = z.object({
  ...catalogItemBaseShape,
  kind: z.literal("episode"),
  /** An individual episode has its own runtime. */
  runtimeMinutes: runtime,
  /** An episode is one unit; it does not itself contain episodes. */
  episodeCount: z.null()
});

export const catalogItemSchema = z.discriminatedUnion("kind", [
  movieCatalogItemSchema,
  seriesCatalogItemSchema,
  episodeCatalogItemSchema
]);
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export type MovieCatalogItem = z.infer<typeof movieCatalogItemSchema>;
export type SeriesCatalogItem = z.infer<typeof seriesCatalogItemSchema>;
export type EpisodeCatalogItem = z.infer<typeof episodeCatalogItemSchema>;

export const catalogRailSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  items: z.array(catalogItemSchema)
});
export type CatalogRail = z.infer<typeof catalogRailSchema>;

/** Response body of `GET /api/v1/catalog/home`. */
export const catalogHomeResponseSchema = z.object({
  rails: z.array(catalogRailSchema),
  generatedAt: z.string().datetime()
});
export type CatalogHomeResponse = z.infer<typeof catalogHomeResponseSchema>;
