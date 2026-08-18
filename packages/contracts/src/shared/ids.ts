import { z } from "zod";

/* -------------------------------------------------------------------------
 * Shared vocabulary: normalized ids
 *
 * A LEAF module. Shared because the id is precisely the thing several domains
 * must agree on: the catalog links to it, the title surface is addressed by it,
 * playback resolves against it and progress will be keyed by it. A per-domain
 * copy of the pattern is how two surfaces end up accepting two different
 * spellings of the same work.
 *
 * Written here rather than in `domains/title.ts`, where it was first declared,
 * for that reason alone -- the shape is unchanged.
 * ---------------------------------------------------------------------- */

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
