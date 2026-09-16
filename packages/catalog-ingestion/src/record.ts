import { z } from "zod";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import { contentRightsSchema } from "@liberty/contracts/shared/rights";

/* -------------------------------------------------------------------------
 * What an ingested catalog record is
 *
 * THIS IS INGESTION VOCABULARY, NOT BROWSE VOCABULARY, and the two are
 * deliberately different shapes. `CatalogItem` in `@liberty/contracts` is what a
 * rail renders: one title, one genre, one synopsis, no dates, no territory, no
 * artwork. That is the right shape for a card and the wrong shape for what a
 * metadata provider actually states, which is several localized titles, an
 * availability window per territory, artwork with its own licence, and a rights
 * position that may not have been established at all.
 *
 * Making the ingestion record a superset -- and projecting DOWN to `CatalogItem`
 * in `project.ts` -- is the only ordering that does not lose information at the
 * boundary. The reverse (ingest straight into `CatalogItem`) would force a
 * locale and a territory to be chosen inside the adapter, where nothing knows
 * who is asking.
 *
 * EVERY SHAPE HERE IS A ZOD SCHEMA AND NOT AN INTERFACE, because this is the
 * parse boundary for untrusted third-party I/O. A provider response is not
 * trusted to have the fields it claims, so the types below are INFERRED from
 * parsers rather than asserted over unvalidated objects.
 *
 * NOTHING HERE CAN CARRY A MEDIA ADDRESS. There is no url, uri, src, href,
 * manifest or stream field anywhere in this module, and artwork is an OPAQUE
 * ASSET REFERENCE rather than a link (see `artworkRefSchema`). That is invariant
 * 1 and 2 expressed as an absence: a catalog record states that a work exists,
 * and there is no field in which it could state where to fetch it from.
 * `safety.ts` re-checks the absence at runtime, because a schema with
 * `.passthrough()` somewhere upstream is not a proof.
 * ---------------------------------------------------------------------- */

/**
 * A language tag, loosely BCP-47.
 *
 * DELIBERATELY NOT A FULL BCP-47 PARSER. What this rejects is the thing that
 * actually breaks a locale-tagged catalog: an empty tag, a display name
 * ("English"), a locale with an underscore (`en_GB`, the POSIX spelling), and
 * anything carrying whitespace or punctuation that would not survive a
 * `Content-Language` header or an `Intl` lookup. A provider that sends a
 * well-formed but unregistered subtag gets through, and that is the correct
 * trade: registry membership changes over time and is not this package's to
 * arbitrate, while shape is stable and is what downstream string comparison
 * depends on.
 */
export const languageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "must be a BCP-47-shaped language tag");
export type LanguageTag = z.infer<typeof languageTagSchema>;

/**
 * An ISO 3166-1 alpha-2 territory, or `WW` for worldwide.
 *
 * `WW` is not an ISO code and is named here rather than borrowed, because the
 * alternative spellings a provider might send for "everywhere" (`ZZ`, `XX`, the
 * empty string, the absent field) are each ambiguous with "unknown". One
 * explicit token means the difference between "offered everywhere" and "nobody
 * stated a territory" survives ingestion, and the second is expressible only by
 * having NO window at all.
 */
export const territorySchema = z
  .string()
  .regex(/^(?:[A-Z]{2}|WW)$/, "must be an ISO 3166-1 alpha-2 code or WW");
export type Territory = z.infer<typeof territorySchema>;

export const localizedTextSchema = z.object({
  locale: languageTagSchema,
  value: z.string().min(1)
});
export type LocalizedText = z.infer<typeof localizedTextSchema>;

/**
 * One locale-tagged field, with at least one entry.
 *
 * NON-EMPTY IS ENFORCED rather than assumed. A zero-length title set parses
 * happily as an array and then produces a work with no name on every surface
 * that reads it, which is the kind of defect that shows up as a blank card in
 * production and as a passing test everywhere else.
 */
export const localizedTextSetSchema = z.array(localizedTextSchema).min(1);
export type LocalizedTextSet = z.infer<typeof localizedTextSetSchema>;

/**
 * When and where a work is offered.
 *
 * THE HOME PAGE'S EMPTY STATE ALREADY SAYS "in your region". Until something
 * ingests this, that phrase has nothing behind it -- `docs/CATALOG_SOURCE.md`
 * records that as an open defect. This is the shape that would back it.
 *
 * Both ends are nullable and `null` means OPEN, not unknown: a window with no
 * end is a real and common licensing position ("from 1 March, indefinitely"),
 * and a work whose availability nobody stated carries no window at all rather
 * than a window with two nulls. The two are distinguishable, which is the point.
 */
export const availabilityWindowSchema = z
  .object({
    territory: territorySchema,
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable()
  })
  .refine(
    (window) =>
      window.startsAt === null ||
      window.endsAt === null ||
      Date.parse(window.startsAt) <= Date.parse(window.endsAt),
    { message: "an availability window may not end before it starts" }
  );
export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;

/**
 * What is stated about the right to describe -- or to show -- one thing.
 *
 * The same two fields `CatalogRightsBasis` carries in `apps/web`, and
 * deliberately the same two: the category is the enforced half and the reference
 * is an opaque pointer into the operator's own rights register that nothing in
 * this repository parses. `docs/CONTENT_RIGHTS.md` is why the agreement itself
 * is not carried here -- no counterparty, scope, term date, licence body or URL
 * may be written into a reference.
 *
 * The SHAPE of the reference is checked in `safety.ts`, using
 * `isOpaqueRightsReference` imported from `@liberty/provider-sdk`. It is not
 * restated here and must not be: a second spelling of a rights rule is exactly
 * the defect that predicate's own comment exists to prevent.
 */
export const ingestedRightsBasisSchema = z.object({
  category: contentRightsSchema,
  reference: z.string().min(1).nullable()
});
export type IngestedRightsBasis = z.infer<typeof ingestedRightsBasisSchema>;

/**
 * A reference to one image, and the licence that image is carried under.
 *
 * ARTWORK CARRIES ITS OWN RIGHTS, SEPARATELY FROM THE WORK'S, and `rights` here
 * is REQUIRED rather than nullable -- the one place in this package where a
 * rights basis may not be absent. The reason is asymmetric risk: a work with an
 * undeclared basis is refused from browse and nothing is published, whereas an
 * image with an undeclared basis that reached a page would be a copy of somebody
 * else's file served from our origin. So the undeclared case is not expressible:
 * an artwork entry either states a basis or is not an artwork entry.
 *
 * `assetRef` IS AN OPAQUE INTERNAL IDENTIFIER AND NEVER A URL. A provider's
 * image CDN link is a media address in a catalog payload, and this package has
 * nowhere to put one. What an operator does with the reference -- resolve it
 * against their own asset store, or nothing at all -- is outside this boundary.
 * `project.ts` drops artwork entirely on the way to `CatalogItem`, which has no
 * image field, so today artwork is ingested and NOT delivered. That is the
 * "or they do not arrive" half of the requirement, made structural.
 */
export const artworkRefSchema = z.object({
  role: z.enum(["poster", "backdrop", "still"]),
  assetRef: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be an opaque lower-case asset reference"),
  rights: ingestedRightsBasisSchema
});
export type ArtworkRef = z.infer<typeof artworkRefSchema>;

export const ingestedWorkKindSchema = z.enum(["movie", "series", "episode"]);
export type IngestedWorkKind = z.infer<typeof ingestedWorkKindSchema>;

/**
 * One work as a source states it.
 *
 * `rights: null` MEANS NO BASIS WAS ESTABLISHED and is never read as permission,
 * the same rule `apps/web/src/lib/catalog-source.ts` states for the port. It is
 * nullable here for the same reason it is nullable there: `catalogItemSchema`
 * forces `rights` to hold one of three values whether or not anybody checked, so
 * the browse shape cannot express "undeclared" and the ingestion shape has to.
 *
 * The runtime/episode-count invariant is NOT re-checked here. `catalogItemSchema`
 * is a discriminated union that already enforces it, and `project.ts` parses
 * against that union, so a work with a runtime and an episode count is refused at
 * projection with the contract's own error rather than by a second copy of the
 * rule that could drift from it.
 */
export const ingestedWorkSchema = z.object({
  contentId: normalizedContentIdSchema,
  kind: ingestedWorkKindSchema,
  titles: localizedTextSetSchema,
  synopses: z.array(localizedTextSchema),
  genres: localizedTextSetSchema,
  releaseYear: z.number().int().min(1888),
  runtimeMinutes: z.number().int().positive().nullable(),
  episodeCount: z.number().int().positive().nullable(),
  availability: z.array(availabilityWindowSchema),
  artwork: z.array(artworkRefSchema),
  rights: ingestedRightsBasisSchema.nullable()
});
export type IngestedWork = z.infer<typeof ingestedWorkSchema>;

/**
 * Where a record came from and when it was observed.
 *
 * `observedAt` IS WHAT MAKES AN ANSWER AGE-BEARING. `freshness.ts` reads it and
 * nothing else; a record without one cannot be assessed and so cannot be served
 * with a staleness claim, which is why it is required rather than defaulted to
 * "now" at read time -- defaulting would make every record eternally fresh.
 *
 * `sourceRevision` is whatever the provider uses to say "this record changed":
 * an ETag, a `last_modified`, a revision counter. Opaque, compared for equality
 * only, never ordered -- ordering assumes a monotonic counter and a provider
 * that sends a hash would silently sort at random.
 */
export const recordProvenanceSchema = z.object({
  sourceId: z.string().min(1),
  nativeId: z.string().min(1),
  observedAt: z.string().datetime(),
  sourceRevision: z.string().min(1).nullable()
});
export type RecordProvenance = z.infer<typeof recordProvenanceSchema>;

export const ingestedRecordSchema = z.object({
  work: ingestedWorkSchema,
  provenance: recordProvenanceSchema
});
export type IngestedRecord = z.infer<typeof ingestedRecordSchema>;

/**
 * A work that a source stopped listing.
 *
 * A TOMBSTONE IS NOT AN ABSENCE, and that distinction is the whole reason the
 * type exists. `docs/CATALOG_SOURCE.md` records the defect it closes: today a
 * work that vanishes from a source simply stops appearing, which is
 * indistinguishable from a fetch that failed. One of those means "remove this
 * from the catalog"; the other means "serve what you have and retry". A store
 * holding tombstones can tell them apart; a store holding only the present set
 * cannot.
 *
 * `ingest.ts` MINTS ONE ONLY FROM A COMPLETE PASS. See `reconcileTombstones`.
 */
export const workTombstoneSchema = z.object({
  contentId: normalizedContentIdSchema,
  sourceId: z.string().min(1),
  observedAt: z.string().datetime(),
  /**
   * `absent_from_complete_sync` -- the work was not in a pass that enumerated
   * the whole source successfully. `withdrawn_by_source` -- the source said so
   * explicitly, which only a provider with `reportsDeletions` can do.
   */
  reason: z.enum(["absent_from_complete_sync", "withdrawn_by_source"])
});
export type WorkTombstone = z.infer<typeof workTombstoneSchema>;
