import { z } from "zod";
import { contentRightsSchema } from "./rights";

/* -------------------------------------------------------------------------
 * Shared vocabulary: artwork references (PW-0302)
 *
 * A LEAF module, on the rule `rights.ts` states about itself: it imports one
 * sibling leaf and nothing else from this package, and every domain that has to
 * name a piece of artwork reaches this file directly. That is what keeps a
 * second artwork vocabulary from coming into existence the way a second rights
 * vocabulary nearly did.
 *
 * NOTHING HERE CAN CARRY AN IMAGE ADDRESS. There is no url, uri, src, href or
 * origin field in this module, and `assetRef` is constrained so that one cannot
 * be spelled in it. A catalog or title payload says WHICH image a work has; it
 * has no field in which to say where to fetch it from. Deciding that is the job
 * of the artwork resolution boundary in `apps/web`, which is the only place in
 * the product where an artwork origin exists.
 *
 * THIS IS THE DEFINITION `@liberty/catalog-ingestion` ADOPTS. `artworkRefSchema`
 * in `packages/catalog-ingestion/src/record.ts` predates this module and had its
 * own spelling of the role enum and the opaque-reference pattern; it now imports
 * `artworkRoleSchema` and `artworkAssetRefSchema` from here. What it does NOT
 * adopt is `artworkReferenceSchema`, and the difference is deliberate -- see
 * that schema's note below for which field diverges and why.
 * ---------------------------------------------------------------------- */

/**
 * What one image is FOR.
 *
 * A closed enum rather than a free string, because the role is what a surface
 * selects on: a rail picks the poster, a hero picks the backdrop, an episode row
 * picks the still. A source that invents a fourth role would otherwise be able
 * to deliver artwork that every surface silently ignores -- an image that is
 * present, licensed, paid for and never rendered, with nothing anywhere
 * reporting that it was dropped.
 *
 * The three values and their spellings are exactly the ones
 * `@liberty/catalog-ingestion` has used since PL-0305. This is that enum moved
 * to the leaf, not a new one that happens to agree today.
 */
export const artworkRoleSchema = z.enum(["poster", "backdrop", "still"]);
export type ArtworkRole = z.infer<typeof artworkRoleSchema>;

/**
 * The shape an opaque artwork reference must have.
 *
 * Exported as a pattern, not only as a schema, because the resolution boundary
 * has to re-check a value that arrived as a URL path segment -- untrusted input
 * that never went through a parser on this side -- and a boundary that wrote its
 * own regex would be a second authority on what a reference is.
 *
 * WHAT THE PATTERN EXCLUDES IS THE POINT, and it is worth naming rather than
 * leaving to be read off the character class. There is no `:`, so no scheme. No
 * `/`, `\` or `.`, so no path, no traversal and no host. No `%`, so nothing that
 * decodes into any of those later. No uppercase, so two references cannot differ
 * only by case and resolve to one file on a case-insensitive filesystem. What is
 * left is a lower-case token, and the useful consequence is that
 * `join(storeDirectory, assetRef)` is CONFINED TO THAT DIRECTORY as a property of
 * the character class rather than as a check somebody performs.
 */
export const ARTWORK_ASSET_REF_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * An opaque internal identifier for one stored image. NEVER A URL.
 *
 * The same constraint and the same message `@liberty/catalog-ingestion` has
 * applied to ingested artwork since PL-0305, which is the whole reason this
 * module can be adopted there without changing what that package accepts.
 */
export const artworkAssetRefSchema = z
  .string()
  .regex(ARTWORK_ASSET_REF_PATTERN, "must be an opaque lower-case asset reference");
export type ArtworkAssetRef = z.infer<typeof artworkAssetRefSchema>;

/**
 * The intrinsic pixel size of the stored image.
 *
 * REQUIRED, not nullable, and that is the one place in this repository's
 * contracts where "required and explicitly nullable" is the wrong rule. Every
 * other unknown fact is carried as `null` because the honest answer is "no
 * source reported this". An image's own dimensions are not that kind of fact:
 * whoever put the file in the store can measure it, and a reference that cannot
 * state its size is a reference that forces every surface rendering it to reserve
 * no space, which is layout shift on every card on the page at the moment the
 * bytes arrive. So the dimensions are part of what makes a reference usable, and
 * a reference without them is not a reference.
 *
 * `1888` appears nowhere here: these are pixels, not years. The lower bound is
 * simply "positive", because a 1x1 is a legitimate tracking-free placeholder and
 * nothing downstream breaks on it.
 */
const pixels = z.number().int().positive();

/**
 * One image a work has, as a browse or detail payload states it.
 *
 * WHERE THIS DIVERGES FROM `artworkRefSchema` IN `@liberty/catalog-ingestion`,
 * AND WHY. The ingestion record composes the same role and the same opaque
 * reference with `ingestedRightsBasisSchema`, which is `{ category, reference }`
 * -- the category plus an opaque pointer into the OPERATOR'S OWN rights
 * register. This schema composes them with `contentRightsSchema` alone: the
 * category and nothing else.
 *
 * The register reference is an internal bookkeeping handle. `docs/CONTENT_RIGHTS.md`
 * already forbids a counterparty, a term date or a licence body from being
 * written into one, and the browse contract already carries only the category
 * for the WORK (`catalogItemBaseShape.rights` is a bare `contentRightsSchema`).
 * Carrying it for the IMAGE would put an operator-internal identifier on a public
 * payload for no surface that needs it, and would make the artwork field the one
 * place a client learns something about the rights register. So the divergence is
 * a deliberate narrowing on the way out, in the same direction `project.ts`
 * already narrows the work's own basis, and it is the reason this schema is
 * composed here rather than imported from the ingestion package.
 *
 * `rights` IS REQUIRED AND NOT NULLABLE, adopted unchanged from the ingestion
 * record along with its argument, which is asymmetric risk: a WORK whose basis
 * nobody declared is refused from browse and nothing is published, whereas an
 * IMAGE whose basis nobody declared, that reached a page, is a copy of somebody
 * else's file served from our origin. `titleRightsBasisSchema` is nullable
 * precisely because a detail surface must be able to say "we do not know" about
 * a work. There is no equivalent need for an image: the undeclared case is not
 * expressible, so an artwork entry either states a basis or is not one.
 */
export const artworkReferenceSchema = z.object({
  role: artworkRoleSchema,
  assetRef: artworkAssetRefSchema,
  width: pixels,
  height: pixels,
  rights: contentRightsSchema
});
export type ArtworkReference = z.infer<typeof artworkReferenceSchema>;

/**
 * The artwork a payload carries for one work.
 *
 * OPTIONAL, WHICH IS A DEPARTURE FROM THIS REPOSITORY'S "REQUIRED AND EXPLICITLY
 * NULLABLE" RULE, and the departure is in service of that rule rather than
 * against it.
 *
 * The rule exists so that "no source reported this" and "the source reported
 * this and it is empty" stay distinguishable, and it is worth its cost wherever a
 * producer can honestly tell the two apart. Ten modules in this repository
 * construct a `CatalogItem` today -- the demo fixtures, the Wikidata adapter, the
 * Stremio addon shape, the recommendation views, the ingestion projection and
 * five test suites -- and not one of them has an artwork concept. Making the key
 * required would hand every one of them the same non-choice: write
 * `artwork: null`, which asserts "this source looked and found none", or write
 * `artwork: []`, which asserts the same thing more strongly. Both are claims
 * those producers cannot support. A required key whose only honest value is a
 * fabrication is not the required-nullable rule; it is the defect that rule
 * exists to prevent, arriving through the front door.
 *
 * So the three states are real and each has a producer that means it:
 *
 *   - ABSENT -- this payload's producer states nothing about artwork. Every
 *     producer that predates PW-0302 is in this state and is correct to be.
 *   - `[]` -- the producer knows about artwork and this work has none.
 *   - non-empty -- the producer has references, each with its own rights basis.
 *
 * All three render the designed gradient or the image, so nothing user-facing
 * turns on the distinction. What turns on it is what a diagnostic may say: only
 * the second licenses "this source has no artwork for this title".
 */
export const artworkListSchema = z.array(artworkReferenceSchema).optional();
export type ArtworkList = z.infer<typeof artworkListSchema>;

/**
 * The first reference with a given role, or `null`.
 *
 * Lives here rather than in the component that needs it because both surfaces
 * that render artwork ask the same question, and the answer has one rule worth
 * stating once: FIRST WINS, and order is the producer's statement of preference.
 * A surface that sorted or scored would be making an editorial choice with
 * nothing to make it from -- the reference carries no language, no territory and
 * no quality signal -- so the only non-arbitrary reading of a list is the order
 * it arrived in.
 *
 * Takes `undefined` as well as a list so callers do not each write the same
 * absent-check; an absent list has no reference of any role, which is the same
 * answer an empty one gives.
 */
export function artworkForRole(
  artwork: ArtworkList,
  role: ArtworkRole
): ArtworkReference | null {
  if (artwork === undefined) return null;
  return artwork.find((reference) => reference.role === role) ?? null;
}
