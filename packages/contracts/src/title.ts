import { z } from "zod";
import { contentRightsSchema } from "./index";

/* -------------------------------------------------------------------------
 * Title detail (PL-0103)
 * ---------------------------------------------------------------------- */

/**
 * The shared rights vocabulary, reached through a deferred reference.
 *
 * `index.ts` re-exports this module, so the import above closes a module cycle:
 * this file is evaluated before `index.ts`'s own body runs, which means reading
 * `contentRightsSchema` at module scope here would touch a `const` that is
 * still in its temporal dead zone. That does not fail a test, it fails the
 * import -- every consumer of `@liberty/contracts` would throw on load, and
 * under a CommonJS interop build it would be worse still: the binding reads as
 * `undefined` and the failure moves to the first `.nullable()` call. `z.lazy`
 * defers the read to the first parse, by which point `index.ts` has finished
 * initialising.
 *
 * Re-declaring the three rights values locally would also break the cycle, but
 * it would leave a second rights vocabulary free to drift from the one the
 * playback path enforces. A rights boundary that disagrees with itself is the
 * one thing this file must not introduce.
 *
 * `search.ts` reaches `catalogItemSchema` the same way for the same reason. The
 * structural fix is to move the shared vocabularies out of `index.ts` into
 * their own module and have every sibling import that; that is a change to the
 * layout of shared contracts and belongs in a deliberate follow-up rather than
 * folded into either task.
 */
const rightsBasisSchema = z.lazy(() => contentRightsSchema);

/**
 * A rights basis that may not have been established yet.
 *
 * `null` means no source has declared one. It is not a fourth kind of rights
 * and it is not "no rights": it is the absence of a claim. The distinction is
 * load-bearing, because a title detail is reachable by direct id for anything
 * the metadata layer knows about, including a work nobody has yet cleared. A
 * catalog rail can require a declared basis -- it only ever shows items that
 * already passed the gate -- but a detail surface has to be able to say "we do
 * not know", and a client that cannot tell "undeclared" from "owned" will
 * render an undeclared work as playable.
 */
export const titleRightsBasisSchema = rightsBasisSchema.nullable();
export type TitleRightsBasis = z.infer<typeof titleRightsBasisSchema>;

/**
 * A normalized content id: the id every surface agrees on, independent of which
 * provider supplied the metadata.
 *
 * Constrained rather than free-form because these ids are interpolated into
 * routes (`/title/<id>`, `/watch/<id>`) and compared across the catalog,
 * playback and progress surfaces. A provider-native id carrying a slash, a
 * space or upper case would produce a different URL than the one the catalog
 * links to, and two spellings of the same work would resolve as two works.
 */
export const normalizedContentIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lower-case, hyphen-separated normalized id");
export type NormalizedContentId = z.infer<typeof normalizedContentIdSchema>;

const runtimeMinutes = z.number().int().positive();
const ordinal = z.number().int().positive();

/**
 * What is known about how a title can be presented.
 *
 * Every field is required and explicitly nullable, and the two empty-ish values
 * mean different things: `null` is "the source did not report this", `[]` is
 * "the source reported this and it is empty". Collapsing them turns "we do not
 * know whether subtitles exist" into "there are no subtitles", and defaulting
 * `maxHeight` to a plausible number turns unknown compatibility into asserted
 * compatibility. That is the same defect PL-0205 is removing from the playback
 * path; the rule applies identically to what the UI is allowed to state.
 */
export const titleTechnicalMetadataSchema = z.object({
  maxHeight: z.number().int().positive().nullable(),
  audioLanguages: z.array(z.string().min(2)).nullable(),
  subtitleLanguages: z.array(z.string().min(2)).nullable()
});
export type TitleTechnicalMetadata = z.infer<typeof titleTechnicalMetadataSchema>;

/**
 * One row of a series' episode list.
 *
 * `rights` is per episode rather than inherited from the series because that is
 * the unit that enters playback resolution: a series can be licensed while one
 * episode has no basis recorded yet, and the list has to be able to withhold
 * the play affordance for exactly that episode.
 */
export const titleEpisodeSummarySchema = z.object({
  id: normalizedContentIdSchema,
  title: z.string().min(1),
  seasonNumber: ordinal,
  episodeNumber: ordinal,
  runtimeMinutes,
  synopsis: z.string().min(1).nullable(),
  rights: titleRightsBasisSchema
});
export type TitleEpisodeSummary = z.infer<typeof titleEpisodeSummarySchema>;

/**
 * Fields whose meaning does not depend on `kind`, split out so the branches
 * below differ only where the kinds genuinely differ.
 */
const titleDetailBaseShape = {
  id: normalizedContentIdSchema,
  title: z.string().min(1),
  rights: titleRightsBasisSchema,
  genre: z.string().min(1),
  releaseYear: z.number().int().min(1888),
  /** `null` means no synopsis was supplied, never "there is no story here". */
  synopsis: z.string().min(1).nullable(),
  technical: titleTechnicalMetadataSchema
};

/**
 * A discriminated union for the same reason `catalogItemSchema` is one: the
 * cross-field invariants become structural instead of documented, so a series
 * carrying a runtime or an episode with no series to belong to cannot parse and
 * cannot be constructed in TypeScript either.
 *
 * Unlike `CatalogItem` the branches do not pad each other's fields with
 * explicit `null`. There, both shape fields are provider-supplied and omitting
 * one says something different from asserting it does not apply. Here
 * `episodes` and `seriesId` are not fields a provider withholds for a movie --
 * they are structurally meaningless for it, so there is nothing to distinguish.
 *
 * The three `kind` literals mirror `catalogItemKindSchema`. They are written as
 * literals rather than derived from it because a value import from `./index`
 * would close the module cycle described at the top of this file.
 */
export const movieTitleDetailSchema = z.object({
  ...titleDetailBaseShape,
  kind: z.literal("movie"),
  runtimeMinutes
});

export const seriesTitleDetailSchema = z.object({
  ...titleDetailBaseShape,
  kind: z.literal("series"),
  /**
   * May legitimately be `[]`: a series whose episodes are not listed yet is a
   * real, distinct state, and it is the reason the client must not treat an
   * empty list as a failed load.
   */
  episodes: z.array(titleEpisodeSummarySchema)
});

export const episodeTitleDetailSchema = z.object({
  ...titleDetailBaseShape,
  kind: z.literal("episode"),
  seriesId: normalizedContentIdSchema,
  seriesTitle: z.string().min(1),
  seasonNumber: ordinal,
  episodeNumber: ordinal,
  runtimeMinutes
});

export const titleDetailSchema = z.discriminatedUnion("kind", [
  movieTitleDetailSchema,
  seriesTitleDetailSchema,
  episodeTitleDetailSchema
]);
export type TitleDetail = z.infer<typeof titleDetailSchema>;
export type MovieTitleDetail = z.infer<typeof movieTitleDetailSchema>;
export type SeriesTitleDetail = z.infer<typeof seriesTitleDetailSchema>;
export type EpisodeTitleDetail = z.infer<typeof episodeTitleDetailSchema>;
export type TitleDetailKind = TitleDetail["kind"];

/**
 * Response body of the planned `GET /api/v1/titles/:id`.
 *
 * The payload key is `detail` rather than `title` so the title's own `title`
 * field does not read as `response.title.title` at every call site.
 *
 * A title that does not exist is a 404 with a machine-readable reason, never a
 * 200 carrying `detail: null`. "Not found", "failed to load" and "found, but
 * has no episodes" have three different remedies, and a nullable payload
 * collapses the first two into the shape of the third.
 */
export const titleDetailResponseSchema = z.object({
  detail: titleDetailSchema,
  generatedAt: z.string().datetime()
});
export type TitleDetailResponse = z.infer<typeof titleDetailResponseSchema>;
