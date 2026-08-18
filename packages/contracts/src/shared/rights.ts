import { z } from "zod";

/* -------------------------------------------------------------------------
 * Shared vocabulary: content rights
 *
 * A LEAF module. It imports nothing from this package and must keep importing
 * nothing from this package: every domain contract that has to state a rights
 * basis reaches this file directly, so there is exactly one rights vocabulary
 * and no path by which a domain can pull a second one into existence.
 *
 * This is the module that used to live at the top of `index.ts`, which is why
 * `title.ts` had to read it back out of the barrel through `z.lazy` -- the
 * barrel re-exported `title.ts`, so the read happened before the barrel's own
 * bindings were initialised. Reaching it here is a plain, eager import, and the
 * cycle that forced the deferral does not exist.
 * ---------------------------------------------------------------------- */

export const contentRightsSchema = z.enum(["licensed", "owned", "public-domain"]);
export type ContentRights = z.infer<typeof contentRightsSchema>;

/**
 * Rights values the platform may surface to a user. Declared as an explicit
 * allowlist so any rights value added later is non-surfaceable until reviewed.
 *
 * NOTE: `@liberty/media-engine` currently declares an equivalent
 * `PLAYABLE_RIGHTS` for the playback path. Once PL-0201 is out of review those
 * should converge on this single definition — tracked as a follow-up rather
 * than edited here, because media-engine is frozen pending GPT review.
 *
 * Lives beside `contentRightsSchema` rather than in the catalog module (where it
 * was first written) because it is not a catalog fact: the provider SDK, the
 * title-detail surface and the catalog surface all gate on it, and a
 * surface-specific home for a cross-surface allowlist is how a second one gets
 * written.
 */
export const PLAYABLE_CONTENT_RIGHTS: readonly ContentRights[] = [
  "licensed",
  "owned",
  "public-domain"
];
